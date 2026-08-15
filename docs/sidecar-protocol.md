# Sidecar protocol — driving `Textlens.Capture` by hand

JSON lines over stdio, one message per line. Node writes **commands** to the sidecar's
stdin; the sidecar writes **events** to its stdout. `stderr` carries diagnostics only and
is never part of the protocol.

The design doc ([§3](superpowers/specs/2026-08-15-textlens-design.md)) chose stdio over a
named pipe precisely so you can run the sidecar alone and type at it. This page is the
copy-pasteable version of that.

```powershell
dotnet build sidecar/Textlens.sln
.\sidecar\Textlens.Capture\bin\Debug\net10.0-windows10.0.19041.0\Textlens.Capture.exe
```

Paste the lines below one at a time and press enter. Blank lines are ignored.

---

## 1. The shortest useful session

The sidecar speaks first:

```jsonc
{"ev":"ready","version":"0.1.0","ocrLanguages":["en-US"]}
```

Find out what you can capture:

```json
{"cmd":"listMonitors"}
```

```jsonc
{"ev":"ack","cmd":"listMonitors","state":"idle","monitors":[{"id":"\\\\.\\DISPLAY1","scale":1,"bounds":[0,0,3440,1440]},{"id":"\\\\.\\DISPLAY2","scale":1,"bounds":[-1080,6,1080,1920]}]}
```

Point it at a region — **note the quadrupled backslashes**, which is what `\\.\DISPLAY1`
looks like once JSON-escaped:

```json
{"cmd":"configure","region":[0,0,600,200],"monitorId":"\\\\.\\DISPLAY1","intervalActive":800,"intervalIdle":2000,"diffThreshold":0.02,"ocrLanguage":"en-US","debugFrameEnabled":false}
```

```jsonc
{"ev":"ack","cmd":"configure","state":"configured"}
```

Start it:

```json
{"cmd":"start"}
```

```jsonc
{"ev":"ack","cmd":"start","state":"running"}
{"ev":"frame","seq":1,"timings":{"captureUs":4092,"diffUs":754,"ocrUs":25031},"monitor":{"id":"\\\\.\\DISPLAY1","scale":1,"bounds":[0,0,3440,1440]},"region":[0,0,600,200],"lines":[{"text":"You must find the key","bbox":[120,80,540,32]}]}
{"ev":"nochange","seq":2}
{"ev":"nochange","seq":3}
```

Stop it:

```json
{"cmd":"stop"}
```

```jsonc
{"ev":"ack","cmd":"stop","state":"stopped"}
```

Closing stdin (Ctrl+Z then enter on Windows) exits with code 0.

---

## 2. Commands

| `cmd` | payload | reply |
|---|---|---|
| `listMonitors` | — | `ack` with `monitors` |
| `configure` | see below | `ack` |
| `start` | — | `ack` |
| `stop` | — | `ack` |
| `snapshot` | — | one `frame`, ignoring change detection |
| `debugFrame` | — | one `frame` with `imagePng`, **only if enabled** |

### `configure`

Every field is required. A partial update would leave Node and the sidecar disagreeing
about the current settings, and the two that matter most — `region` and `monitorId` — are
exactly the ones a silent merge would get wrong.

| field | meaning |
|---|---|
| `region` | `[x, y, w, h]` in **physical px, relative to the monitor's top-left** |
| `monitorId` | device name from `listMonitors`, e.g. `\\.\DISPLAY1` |
| `intervalActive` | poll interval in ms while text is changing |
| `intervalIdle` | poll interval in ms once the region looks idle |
| `diffThreshold` | fraction of sampled pixels (0..1) above which a frame counts as changed |
| `ocrLanguage` | BCP-47 tag of the recognizer, e.g. `en-US` |
| `debugFrameEnabled` | whether `debugFrame` may return pixels — see §5 |

`configure` is accepted at any time, including while running, and takes effect without a
restart. The capture session and the recognizer are rebuilt only if `monitorId` or
`ocrLanguage` actually changed, so dragging a region around is cheap.

---

## 3. Events

| `ev` | when |
|---|---|
| `ready` | once, first line on the stream |
| `frame` | the region changed and was recognized |
| `nochange` | the region did not change; no OCR ran |
| `ack` | reply to `listMonitors` / `configure` / `start` / `stop` |
| `error` | something failed — the process keeps running |

`frame` and `nochange` share one `seq` counter, so a gap in the sequence means an event
was lost. The counter is **monotonic for the life of the process** — a `configure` that
changes `monitorId` or `ocrLanguage` rebuilds the capture pipeline internally, but the
counter carries across, because restarting it at 1 would be a false report of exactly the
loss it exists to detect.

### `ack`

```jsonc
{"ev":"ack","cmd":"start","state":"running"}
```

`state` is the state **after** the command was applied, which makes the state machine
readable straight off a transcript. `monitors` appears only on the `listMonitors` reply.

> **There is no correlation id.** Replies correlate by `cmd`, which is unambiguous only
> while at most one command of a given kind is outstanding. That holds for this state
> machine — Node sends a command and waits — but **anyone adding pipelined or concurrent
> commands has to add an id first**.

### `timings` — microseconds, not milliseconds

```jsonc
"timings":{"captureUs":4092,"diffUs":754,"ocrUs":25031}
```

The unit is in the field names because it changed. These were integer milliseconds, and
capture measures p50 **0.574ms** — which rounds to `0` on every frame, forever. A metric
that cannot express its own typical value measures nothing, and design doc §4 asks for
these numbers so that "we are over budget" can be answered with "here is which stage".

They are integers rather than floats because all the protocol fixtures are re-encoded and
compared byte for byte by both the C# and the TypeScript suite, and the two languages do
not format decimals identically (`0.5` against `0.50`). Microseconds keep the resolution
*and* keep the values integral. The budget table in §4 stays in milliseconds — it is what
humans read — so consumers convert at the point of use.

### `lines[].conf` is optional and this sidecar never sends it

```jsonc
"lines":[{"text":"You must find the key","bbox":[120,80,540,32]}]
```

`Windows.Media.Ocr` **reports no confidence value at all**: `OcrResult` exposes
`Lines`/`Text`/`TextAngle`, `OcrLine` exposes `Text`/`Words`, and `OcrWord` exposes
`Text`/`BoundingRect`. There is nothing else in the namespace.

The field is therefore omitted rather than filled with a constant. A constant would be
worse than an absence: every consumer would read `1.0` as "the recognizer is certain" when
the truth is that it never said. Consumers that rank or filter on confidence — features
**O4** (noise filter) and **U4** (screen area budget) — must handle its absence rather than
defaulting it. A future engine that does report confidence (PaddleOCR does) will populate
the field without a contract change.

---

## 4. Coordinate contract

Every rectangle on the wire is **physical px**. The sidecar performs no scale arithmetic
anywhere (architecture invariants 1 and 3).

| field | units and origin |
|---|---|
| `lines[].bbox` | physical px, relative to the **region's** top-left |
| `region` | physical px, relative to the **monitor's** top-left |
| `monitor.bounds` | physical px, absolute on the virtual desktop, **raw from Win32** |

`monitor.bounds` is carried for identification and diagnostics. Node takes each display's
*logical* origin from Electron, not from this field — when displays differ in DPI a logical
origin cannot be derived from a physical one, because Chromium lays displays out adjacent
in DIP space rather than dividing each physical rect by its own scale. See design doc §3.

---

## 5. `debugFrame` — pixels crossing IPC

This is the single sanctioned exception to "pixels never cross IPC" (invariant 1), and it
is **off unless you turn it on**:

```json
{"cmd":"configure","region":[0,0,600,200],"monitorId":"\\\\.\\DISPLAY1","intervalActive":800,"intervalIdle":2000,"diffThreshold":0.02,"ocrLanguage":"en-US","debugFrameEnabled":true}
{"cmd":"debugFrame"}
```

Asking with it disabled is an error, never a silent frame without an image:

```jsonc
{"ev":"error","code":"DEBUG_FRAME_DISABLED","message":"debugFrame is disabled. Set debugFrameEnabled to true in configure to enable it."}
```

`imagePng` is a base64 PNG of the captured region. It is a picture of the user's screen —
do not paste one into an issue, a log, or a report.

---

## 6. Errors

`code` is an open string, deliberately: a closed enum would make a sidecar that learns a
new failure mode unparseable by an older Node build.

| `code` | meaning |
|---|---|
| `OCR_LANGUAGE_MISSING` | no recognizer for the source language (feature O8) |
| `UNKNOWN_COMMAND` | unparseable line, or a command this build does not know |
| `NOT_CONFIGURED` | `start`/`snapshot`/`debugFrame` before any `configure` |
| `CONFIGURE_FAILED` | the configuration could not be applied (bad monitor, missing recognizer) |
| `CAPTURE_FAILED` | the capture or the diff threw |
| `OCR_FAILED` | recognition threw |
| `NO_FRAME_YET` | `snapshot` before anything had ever been captured |
| `DEBUG_FRAME_DISABLED` | `debugFrame` without `debugFrameEnabled` |

**No failure is silent and no failure is fatal** (invariant 4). Every error path emits an
`error` and the process keeps reading commands:

```json
{"cmd":"recalibrate","passes":3}
```

```jsonc
{"ev":"error","code":"UNKNOWN_COMMAND","message":"UnknownKind: unknown command \"recalibrate\""}
```

---

## 7. Why `nochange` exists

A static screen emits `nochange` rather than nothing at all, so Node's watchdog
(design doc §7) can tell a quiet sidecar from a hung one.

This matters more than it looks. Spike
[S2](spikes/2026-08-16-s2-content-protection.md) measured that Windows Graphics Capture
delivers **3 frames in 13 seconds** on an idle display — but **120 frames in 2.6 seconds**
when our own overlay animates, every one of them byte-identical. So:

- the capture loop is **interval-driven, never frame-driven**. A frame-driven loop would
  be woken at ~60fps by the overlay's own crossfades and would find nothing every time —
  a busy loop, not a feedback loop;
- a tick **never blocks waiting for a frame**. On a genuinely static display none arrives;
  the tick takes "nothing queued" for an answer and emits `nochange`.

Measured: at a 15ms interval a running sidecar produced 124 events and 219ms of CPU over
two seconds; stopped, it produced 0 events and 15.6ms — one scheduler quantum, i.e. the
noise floor.

---

## 8. Poking it from PowerShell

Typing by hand is the intended workflow, but a scripted run is useful for a quick check:

```powershell
$exe = ".\sidecar\Textlens.Capture\bin\Debug\net10.0-windows10.0.19041.0\Textlens.Capture.exe"
$commands = @'
{"cmd":"listMonitors"}
{"cmd":"configure","region":[0,0,600,200],"monitorId":"\\\\.\\DISPLAY1","intervalActive":300,"intervalIdle":1000,"diffThreshold":0.02,"ocrLanguage":"en-US","debugFrameEnabled":false}
{"cmd":"start"}
'@
$commands | & $exe
```

That leaves the sidecar running until you close the pipe. Reap it if you background it:

```powershell
Get-Process Textlens.Capture -ErrorAction SilentlyContinue | Stop-Process
```
