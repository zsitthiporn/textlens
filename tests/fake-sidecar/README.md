# Fake sidecar (M3-06)

Design doc [§8](../../docs/superpowers/specs/2026-08-15-textlens-design.md): the Node
side needs to be testable without a screen, and a real bug needs to be reproducible from
a captured protocol session. This directory is that: a record hook on `SidecarClient`,
a script that replays what it recorded, and the fixtures produced from a real sidecar.

## Pieces

| File | What it is |
|---|---|
| `../../src/main/services/sidecar-client.ts` (`recordTo` option) | Appends every raw stdout line to a JSON-lines file, verbatim, before decoding it |
| `replay.mjs` | Reads a recorded file and writes the lines back to stdout on the same schedule |
| `stub-builder.ts` | Compiles the native launcher that lets a fixture satisfy `TEXTLENS_SIDECAR_PATH` (see "Why a compiled launcher" below) |
| `record.mjs` | CLI that drives the real sidecar with `recordTo` set, to produce a new fixture |
| `../fixtures/sessions/*.jsonl` | The committed fixtures: `error.jsonl`, `without-text.jsonl`, `with-text.jsonl` |

## Recording a new fixture

Build the app first - `record.mjs` is a plain `node` script, not something vitest
transforms, so it needs the compiled output:

```powershell
npm run build:node
```

**No screen content (the `error` scenario).** Sends `start` before any `configure`; the
real sidecar's `NOT_CONFIGURED` reply is what gets recorded. Safe to run anywhere:

```powershell
node tests/fake-sidecar/record.mjs error tests/fixtures/sessions/error.jsonl
```

**A capture scenario (`with-text` / `without-text` shape).** First find a monitor id and
its bounds:

```powershell
node tests/fake-sidecar/record.mjs monitors
```

Then configure a region and record for a few seconds:

```powershell
node tests/fake-sidecar/record.mjs capture out.jsonl `
  --region 50,60,900,350 --monitor "\\.\DISPLAY1" `
  --duration 2000 --interval-active 300 --interval-idle 800
```

`--region`/`--monitor` are physical px, monitor-relative, exactly the wire format
(`docs/sidecar-protocol.md` §4) - `record.mjs` does not convert anything.

### Picking what to point the region at

**Point it at something deliberate and harmless, and verify before committing.** The
sidecar reads real screen text; whatever is in the region is what ends up in the
fixture, permanently, in the repo.

- For `without-text.jsonl`: an empty area of desktop wallpaper worked well - no icons,
  no windows. `(New-Object -ComObject Shell.Application).MinimizeAll()` first.
- For `with-text.jsonl`: a plain-text editor with placeholder content (this repo's fixture
  used "The quick brown fox..." / "Lorem ipsum..." in Notepad) - never a real document.

**Overlays are a real hazard on a normal desktop, not a hypothetical one.** Recording
this repo's `with-text.jsonl` first picked up fragments of unrelated windows and
notification toasts even with every window minimized and the target app in the
foreground - always-on-top panels and OS toast notifications are compositor-level and
are not covered by "minimize everything else." What worked: make the target window
both fullscreen *and* topmost (`SetWindowPos` with `HWND_TOPMOST`) before recording, so
nothing else can render into the capture region during the window. If a capture picks up
anything unexpected, delete the file and retry with a smaller/repositioned region rather
than committing it - never paste recorded screen content anywhere outside verifying it
decodes correctly.

After recording, sanity-check the fixture decodes cleanly and contains only what you
intended, then run `npx vitest run tests/fake-sidecar/fixtures.test.ts` to confirm it
still passes the shape checks (or update that file if the new fixture has a different
shape than the three it currently expects).

### `.gitattributes`

`tests/fixtures/**` is pinned to LF. `record.mjs`'s underlying `recordTo` writer only
ever emits `\n`, so this should already hold; double-check with
`git diff --check` before committing a new fixture.

## Why a compiled launcher, not a plain script

`src/main/index.ts` resolves `TEXTLENS_SIDECAR_PATH` with `resolveSidecarPath` and spawns
it with `new SidecarClient({ exePath, logger })` - **no `args`, no shell** - and that call
is out of scope for M3-06 (see CLAUDE.md task scope; index.ts is not touched). Node
hardened `spawn`/`execFile` against CVE-2024-27980, so as of this repo's Node (22.22.3), a
`.cmd`/`.bat`/plain script at `exePath` throws `EINVAL` instead of silently going through
`cmd.exe` - verified directly against this checkout, not assumed from the advisory. Only a
genuine PE executable satisfies that call.

`stub-builder.ts` compiles one on the fly with `csc.exe` - part of the .NET Framework 4
runtime present by default on Windows 10/11 and on `windows-latest` GitHub Actions
runners, not a new project dependency. It runs `node replay.mjs <fixture>` and manually
pumps bytes between its own stdio and that child's, on background threads. That pumping
is required, not decorative: `Process.Start` with every `RedirectStandard*` left `false`
does not forward the launcher's inherited stdio handles to the grandchild once
`CreateNoWindow` is set (there is no console to inherit from and `STARTF_USESTDHANDLES`
never gets set) - a passthrough-only launcher produces a process whose `ready` line never
arrives and whose stdin never sees EOF. This was measured while building the tool, not
assumed: see `env-var.test.ts` for the working version and its own doc comment for what a
naive version does instead.

There is no cache for the compiled launcher - each test that needs one calls
`buildFakeSidecarStub` and gets a fresh compile (a few hundred ms). Simpler than
invalidation logic, and the cost has not been worth avoiding yet.

## Running

```powershell
npx vitest run tests/fake-sidecar
```

No display required - `fixtures.test.ts` only decodes committed files, and
`replay-timing.test.ts` / `env-var.test.ts` / `record-hook.test.ts` all spawn local
processes (the compiled launcher, or a small scripted stand-in), never the real
`Textlens.Capture.exe`.
