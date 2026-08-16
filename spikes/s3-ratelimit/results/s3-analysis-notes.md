# S3 rate-limit spike — analysis notes (issue #44)

Written by the performance-analysis pass on 2026-08-16. No network calls were made to produce
anything below — every number here comes from `load.ndjson` (already on disk, committed in
`2604264`), `stream.json` (already on disk), and reading source. Reproduce with the commands
inline; PowerShell, Node 22.22.3.

## 0. Harness read — what actually ran

`load.mjs` fired ticks on an **absolute schedule** (`start + n*2000ms`), not sleep-after-response,
and did **not await** the previous request before firing the next (`void fire(...)`) — so the
2.000s cadence is real regardless of response time, confirmed by `analyse.mjs`'s own cadence line
(`1050 requests over 34.97 min = one every 2.000s`). Every string is unique
(`corpus.mjs`), so no response in `load` phase can be a cache hit anywhere between here and Google.
Batch size cycles `1,2,3,1,2,3,...` (`tick % 3 + 1`) — confirmed in the data: exactly 350 of each.

The run was killed for the reboot **during `coldPhase()`**, after `loadPhase()` had already run to
completion (all 1050 ticks fired, none hit `BLOCK_THRESHOLD=10`, no `blocked` meta event) and 5 of
its 8 idle-gap probes had landed (`gaps: [30,60,120,30,60,120,180,30]`, only the first 5 ran).
There is no `event:"done"` record. `load.ndjson` phase counts: `meta=37, load=1050, cold=5`.

```
node spikes/s3-ratelimit/analyse.mjs
```
reproduces every number below (own values, then cross-checked against the lead's hand-parsed row
in the issue #44 comment):

| | analyse.mjs | lead's hand-parsed | match |
|---|---|---|---|
| p50 | 596 | 595.94 | yes (rounding only) |
| p95 | 1108 | 1108.02 | yes |
| min | 42 | 42.38 | yes |
| max | 2177 | 2176.83 | yes |

**No disagreement.** The two independent readings of the same file agree to rounding. `analyse.mjs`
had never been run before this pass; it now has, and it confirms the number that gated this spike.

## 1. Cold vs warm — is it bimodal?

Not bimodal. Histogram of the 1050 `ok` load-phase latencies in 100ms bins is a single peak at
500-700ms with a continuous, decaying right tail out to 2177ms — no second cluster:

```
  0- 99ms:    2   300-399ms:  88   700-799ms: 121   1100-1199ms: 25   1600-1699ms: 4
100-199ms:   17   400-499ms: 188   800-899ms:  62   1200-1299ms: 14   1700-1799ms: 1
200-299ms:   24   500-599ms: 219   900-999ms:  43   1300-1399ms:  9   2100-2199ms: 3
                  600-699ms: 206  1000-1099ms: 22   1400-1499ms:  2
```

The dedicated `cold` phase (idle gap → single request, 5 samples, gaps 30/60/120/30/60s) landed at
744/401/679/1000/689ms — **inside the same distribution as the "warm" load phase** (p50 596,
p95 1108), not a distinct slow population. A deliberately-cold request is not measurably slower
than the steady-state jitter already present at 2s cadence.

The 47 requests above `mean + 2·sd` (630.8 ± 250.2ms → threshold 1131ms) are mildly concentrated in
the first ~60s (seq 3, 4, 11, 13, 17 — 5 of the first 20 requests) but continue scattered evenly
across the entire 35-minute run through to seq 1040 (98.6% of the way through). Correlation between
latency and time/seq is **r = 0.0105** — essentially zero. OLS slope of latency vs elapsed minutes:
**+0.26 ms/min**, i.e. ~9ms of predicted drift across the whole 35-minute run against a per-request
standard deviation of 250ms — noise, not a trend.

**This is the more damaging answer.** The p50/p95 miss against the 300-500ms budget is not a
cold-start artifact that a warm connection pool would fix — it is the endpoint's actual steady-state
latency under sustained real traffic.

## 2. Batch composition

```
load batch=1  n=350  p50=593  p95=1110  p99=1371  min=42   max=1742   mean=629.8ms
load batch=2  n=350  p50=600  p95=1132  p99=1388  min=156  max=2140   mean=639.1ms
load batch=3  n=350  p50=590  p95=1104  p99=1429  min=106  max=2177   mean=623.5ms
```

Flat across batch size — a single string costs essentially the same latency as three. Differences
between batch means (623-639ms) are ~15ms, far inside the noise (sd≈250ms per request). **Batch
size does not explain the elevated p50.** The cost is dominated by fixed per-request overhead
(network RTT + endpoint processing), not by payload size. Practical implication: batching more
strings per request is close to free in latency terms — it does not trade away speed for fewer
requests.

## 3. Drift over the run (the decisive cut)

Per-5-minute buckets (from `analyse.mjs`):

```
min  0- 5: n=150  p50=603  p95=1309  min= 42
min  5-10: n=150  p50=554  p95=1087  min=138
min 10-15: n=150  p50=575  p95=1105  min=122
min 15-20: n=150  p50=565  p95=1083  min=106
min 20-25: n=150  p50=588  p95=1002  min=110
min 25-30: n=150  p50=622  p95=1108  min= 94
min 30-35: n=150  p50=611  p95=1107  min=123
```

No step, no monotonic climb. p50 stays in a 554-622ms band the entire run; p95 is *highest in the
first bucket* (1309) and never returns to that level, if anything drifting slightly down. First-10%
vs last-10% of the run: p50 603→611 (flat), p95 1353→1039 (down). OLS slope +0.26 ms/min (~9ms total
over 35 min) confirms: **no soft throttling by latency escalation.** A rate limiter that punishes
sustained traffic with creeping latency would show up here as a rising staircase; it is not present.

Combined with zero 429s / zero failures across all 1050+5 requests, there is no evidence of any kind
of throttling — soft or hard — at 30 requests/minute sustained for 35 minutes. The elevated p50/p95
against budget is the endpoint's baseline behavior at this volume, not a degradation caused by the
volume.

**Reconciling with issue #19's 139-176ms warm measurement (n=6):** only 16 of 1050 (1.5%) of this
run's samples are ≤176ms, and only 8 (0.76%) fall inside the 139-176ms band itself. Six independent
draws landing entirely inside a ~1.5%-probability band is not plausible as a random sample of the
same distribution measured here — issue #19's number was an artifact of a very small sample (n=6),
not a real "cold vs warm" or "before vs after" state of the endpoint. **I disagree with treating
139-176ms as the endpoint's warm baseline** — this dataset's own 1050-sample warm population puts
that band in the fast 1.5% tail, not the center.

## 4. Effective request rate after cache (production estimate)

Real code, not reimplemented: `Deduplicator` (`src/main/services/dedup.ts`, 3000ms window,
non-refreshing) and `normalizeForComparison` (`src/main/services/recent-outputs.ts` — same function
`src/main/services/cache.ts` hashes for the real SQLite cache key:
`sha256(normalizeForComparison(text))|src|tgt|engine`). Verified the compiled copies under
`build-pipe/` are byte-identical to current `src/` before trusting them (matching `DEFAULT_WINDOW_MS
= 3000` and the identical `normalizeForComparison` body).

Stream: 1622 real subtitle cards from Oscar Wilde's *The Importance of Being Earnest* (public
domain, Gutenberg #844), 84-char cards, dwell = length/17cps clamped 1.2-6.0s, continuous
back-to-back with no silent gaps (worst case for a rate limiter) — 94.3 minutes, mean dwell 3488ms.

```
node spikes/s3-ratelimit/simulate.mjs
```

```
regime  tick  wobble  blocks  postDedup  cHit  cMiss  req   dedupDrop  cacheHit  req/min  s/req
moving   800  0        7072    2539       954  1585  1585    64.1%      37.6%     16.8     3.6
moving   800  0.01     7072    2588       738  1850  1850    63.4%      28.5%     19.6     3.1
moving   800  0.05     7072    2861       264  2597  2597    59.5%       9.2%     27.5     2.2
static   800  0        1622    1618        33  1585  1585     0.2%       2.0%     16.8     3.6
static   800  0.01     1622    1618        32  1586  1586     0.2%       2.0%     16.8     3.6
static   800  0.05     1622    1618        30  1588  1588     0.2%       1.9%     16.8     3.6
moving  2000  0.01     2829    1819       247  1572  1572    35.7%      13.6%     16.7     3.6
moving   300  0.01    18857    2740       778  1962  1962    85.5%      28.4%     20.8     2.9
```

**Assumptions stated explicitly:** continuous dialogue with zero silent gaps (pessimistic — real
subtitle tracks have pauses); "moving" regime assumes the sidecar's pixel diff fires on *every*
tick because something behind the text moves (the stated worst case in the file's own docstring);
OCR wobble rates (0%, 1%, 5%) are S1's own measured error classes applied per character, not
invented; capture tick rate tried at 300/800/2000ms to show the answer is not an artifact of one
choice of interval.

**Result: 16.7-27.5 requests/minute reach the network across every regime and tick rate tried**,
including the deliberately worst case (moving background, every tick triggers OCR, 5% character
wobble). The number is strikingly stable regardless of capture tick rate (300ms vs 2000ms) because
dedup (3s window) and cache both scale with *how often the visible text actually changes*, not with
how often the capture loop polls.

This is close to — not dramatically less than — the load harness's synthetic 30 req/min (unique
strings, no caching possible by design). That is a **different conclusion than the "may be much less
severe than it looks" framing in the ground truth invites**: caching thins the request volume
somewhat (30 → ~17-28/min) but does not change the order of magnitude, and it does nothing at all
for the latency question — a cache *miss* (a genuinely new line) still pays the full ~596ms median /
1108ms p95, unchanged by how rarely it happens. Cache hit rate matters for *quota/volume* risk, which
this run already shows is not the binding constraint (zero 429s at 30/min); it does not touch the
*budget-miss* risk, which is about the latency of each individual translation, not how many happen
per minute.

One number worth carrying forward: mean subtitle dwell in this stream is 3488ms and the dwell floor
is 1200ms. The load run's p95 (1108ms) fits under the 1200ms floor by only 92ms — for the shortest
subtitle cards, a p95-latency translation risks arriving after the line has already changed, even
though the endpoint never fails or throttles. The max observed (2177ms) exceeds every dwell time in
this stream outright.

## 5. `analyse.mjs`

Ran clean (`node spikes/s3-ratelimit/analyse.mjs`), confirmed by reading it first: it only calls
`readFileSync` on the local NDJSON path, no network import, no `fetch`. Output reproduced in
sections 1-3 above and matches the lead's hand-parsed numbers (section 0 table) to rounding.
`preflight.mjs` and `network-floor.mjs` were read but **not run** — both call out to
`translate.googleapis.com` (`fetch`), which is exactly what this pass was told not to do.

## Not run / not available

- No network floor measurement (transport-only vs full-translate split) exists for this pass —
  `network-floor.mjs` requires live network access, which was out of bounds. Cannot separate
  "this machine's distance from Google" from "the endpoint's own processing time" without it.
- No block/429 event ever occurred, so `RECOVERY_PROBE_MS` / recovery timing has **zero empirical
  support** from this dataset in either direction. `recoveryPhase()` in `load.mjs` never ran.
- `coldPhase()`'s remaining 3 gaps (120s, 180s, 30s) never ran (killed for reboot at 5/8).
