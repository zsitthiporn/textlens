/**
 * Spike S2 — does Windows Graphics Capture respect `setContentProtection` on the overlay?
 *
 * Throwaway harness, not product code. CommonJS on purpose: Electron's ESM main entry
 * stalls on top-level `await` because the message loop does not start until the entry
 * module finishes evaluating (CLAUDE.md, toolchain traps).
 *
 * ---------------------------------------------------------------------------
 * The experiment
 * ---------------------------------------------------------------------------
 * An overlay that is *absent* from a capture proves nothing on its own: it is equally
 * consistent with "content protection worked", "the overlay was not painted yet", "the
 * frame predates it", "we cropped the wrong rectangle" and "WGC starved and handed us a
 * stale frame". So the region under test is a sandwich, and every layer is a value we
 * painted ourselves:
 *
 *      overlay patch   #CB1159   the production overlay window, screen-saver topmost
 *      underlay        #1FC77A   an ordinary window at the same place, floating topmost
 *      probe rect                inset inside both, so no window edge is sampled
 *
 * With protection OFF the sidecar must see CB1159. With protection ON it must see
 * 1FC77A — not merely "not CB1159". That second colour is what converts an absence into
 * evidence: it proves the crop was in the right place, at the right time, on a live
 * frame, and that the only thing that changed was the overlay's visibility.
 *
 * Arms run OFF -> ON -> OFF in one process, so the toggle is the only variable, and the
 * return trip rules out "something drifted while we waited".
 *
 * A third window, the beacon, sits outside the probe rect and repaints continuously.
 * WGC only delivers frames when the display's content changes; without it a static
 * desktop starves the capture and every arm reports whatever was on screen first.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, screen } = require('electron');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const SIDECAR = path.join(
  ROOT,
  'sidecar',
  'Textlens.Capture',
  'bin',
  'Debug',
  'net10.0-windows10.0.19041.0',
  'Textlens.Capture.exe',
);

/** Values chosen to be improbable on a desktop and far apart in every channel. */
const OVERLAY_RGB = 'CB1159';
const UNDER_RGB = '1FC77A';
const BLACK_RGB = '000000';

/** All display-relative, physical px. Every machine here is scaleFactor 1.0. */
const UNDERLAY = { x: 150, y: 150, width: 900, height: 500 };
const PATCH = { x: 200, y: 200, width: 800, height: 400 };
const PROBE = { x: 240, y: 240, width: 720, height: 320 };
const BEACON = { x: 150, y: 800, width: 220, height: 120 };

const FRAMES = 20;
const SETTLE_MS = 900;

// Colour management on the way to the panel would shift an exact RGB and make every arm
// look like a miss. sRGB everywhere keeps "the value we painted" and "the value WGC
// reports" the same number.
app.commandLine.appendSwitch('force-color-profile', 'srgb');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'textlens-s2-'));

function writeScratch(name, content) {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

const UNDERLAY_HTML = writeScratch(
  'underlay.html',
  `<!doctype html><meta charset="utf-8"><title>s2 underlay</title>
   <body style="margin:0;background:#${UNDER_RGB}"></body>`,
);

// setInterval, not requestAnimationFrame: an occluded window can have its rAF throttled
// to nothing, which would look exactly like WGC refusing to deliver frames.
const BEACON_HTML = writeScratch(
  'beacon.html',
  `<!doctype html><meta charset="utf-8"><title>s2 beacon</title>
   <body style="margin:0;background:#000"><div id="b" style="width:100vw;height:100vh"></div>
   <script>let i=0;setInterval(function(){i=(i+7)%360;
   document.getElementById('b').style.background='hsl('+i+',100%,50%)';},16);</script>`,
);

const AFFINITY_PS1 = writeScratch(
  'affinity.ps1',
  `param([long]$Hwnd)
Add-Type -Namespace S2 -Name Win -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true)]
public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint dwAffinity);
'@
$a = 0
$ok = [S2.Win]::GetWindowDisplayAffinity([IntPtr]$Hwnd, [ref]$a)
Write-Output ("getWindowDisplayAffinity ok=" + $ok + " value=0x" + $a.ToString("X"))
`,
);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(exe, args, timeout = 90_000) {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    });
  });
}

/** Sidecar monitor ids and their physical bounds, so Electron display ids can be mapped. */
async function listSidecarMonitors() {
  const { stderr } = await run(SIDECAR, ['--list-monitors']);
  const monitors = [];
  for (const line of stderr.split(/\r?\n/)) {
    const match = /^(\S+)\s+bounds=\[(-?\d+),(-?\d+),(\d+),(\d+)]/.exec(line.trim());
    if (match !== null) {
      monitors.push({
        id: match[1],
        x: Number(match[2]),
        y: Number(match[3]),
        width: Number(match[4]),
        height: Number(match[5]),
      });
    }
  }
  return monitors;
}

function openPlainWindow(bounds, file) {
  const window = new BrowserWindow({
    ...bounds,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // An occluded renderer that stops painting is indistinguishable from a capture
      // failure, and both of the windows below spend the whole run occluded.
      backgroundThrottling: false,
    },
  });
  // Above ordinary windows, below the overlay's screen-saver band, so the z-order under
  // test is unambiguous.
  window.setAlwaysOnTop(true, 'floating');
  void window.loadFile(file);
  window.showInactive();
  window.setBounds(bounds);
  return window;
}

async function waitUntilPainted(window, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!window.isDestroyed() && window.isVisible() && !window.webContents.isLoading()) return true;
    await delay(100);
  }
  return false;
}

async function probe(monitorId, rect, frames = FRAMES) {
  const { stderr, error } = await run(SIDECAR, [
    '--probe-colors',
    '--monitor', monitorId,
    '--region', `${rect.x},${rect.y},${rect.width},${rect.height}`,
    '--frames', String(frames),
    '--colors', `${OVERLAY_RGB},${UNDER_RGB},${BLACK_RGB}`,
    '--tolerance', '4',
  ]);
  if (error) console.error(`  probe exited badly: ${error.message}`);
  return stderr.trim();
}

async function arm(label, overlay, monitorId, protect) {
  overlay.setContentProtection(protect);
  await delay(SETTLE_MS);

  const hwnd = overlay.getNativeWindowHandle().readBigUInt64LE(0).toString();
  const affinity = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', AFFINITY_PS1, '-Hwnd', hwnd,
  ], 30_000);

  console.error(`\n--- arm ${label}: setContentProtection(${protect}) on ${monitorId}`);
  console.error(`  ${affinity.stdout.trim() || affinity.stderr.trim()}`);
  console.error((await probe(monitorId, {
    x: PROBE.x, y: PROBE.y, width: PROBE.width, height: PROBE.height,
  })).split('\n').map((line) => `  ${line}`).join('\n'));
}

async function testDisplay(WindowManager, display, monitorId) {
  console.error(`\n================ display ${monitorId} `
    + `(electron id ${display.id}, bounds ${display.bounds.x},${display.bounds.y},`
    + `${display.bounds.width},${display.bounds.height}, scale ${display.scaleFactor})`);

  const manager = new WindowManager({ distDir: DIST });
  const global = (rect) => ({
    x: display.bounds.x + rect.x,
    y: display.bounds.y + rect.y,
    width: rect.width,
    height: rect.height,
  });

  const underlay = openPlainWindow(global(UNDERLAY), UNDERLAY_HTML);
  const beacon = openPlainWindow(global(BEACON), BEACON_HTML);

  // The production overlay, created by the production WindowManager, so the window under
  // test has the flags the product actually ships.
  const overlay = manager.openOverlay(display.id);
  if (!(await waitUntilPainted(overlay))) throw new Error('overlay never became visible');
  await waitUntilPainted(underlay);
  await waitUntilPainted(beacon);

  // Replace the M1-05 test chrome rather than draw over it: one flat, known rectangle in
  // a known place is the whole point, and the existing decorations overlap it on 1920x1080.
  const painted = await overlay.webContents.executeJavaScript(`(() => {
    document.body.replaceChildren();
    const patch = document.createElement('div');
    patch.style.position = 'fixed';
    patch.style.left = '${PATCH.x}px';
    patch.style.top = '${PATCH.y}px';
    patch.style.width = '${PATCH.width}px';
    patch.style.height = '${PATCH.height}px';
    patch.style.background = '#${OVERLAY_RGB}';
    patch.style.zIndex = '2147483647';
    document.body.appendChild(patch);
    const r = patch.getBoundingClientRect();
    return { viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
             patch: [r.left, r.top, r.width, r.height] };
  })()`);

  console.error(`  overlay bounds=${JSON.stringify(overlay.getBounds())}`);
  console.error(`  renderer viewport=${JSON.stringify(painted.viewport)} dpr=${painted.dpr} `
    + `patchCssRect=${JSON.stringify(painted.patch)}`);
  console.error(`  underlay bounds=${JSON.stringify(underlay.getBounds())}`);
  await delay(SETTLE_MS);

  await arm('A (control, protection OFF)', overlay, monitorId, false);
  await arm('B (test,    protection ON )', overlay, monitorId, true);
  await arm('C (control, protection OFF)', overlay, monitorId, false);

  manager.closeAll();
  for (const window of [underlay, beacon]) if (!window.isDestroyed()) window.destroy();
  await delay(400);
}

/**
 * The condition that decides whether the production ordering is safe: is the overlay
 * protected from the *first* frame it is painted in, or is there a window between
 * "visible" and "protected" during which the sidecar can still see it?
 *
 * The probe is started first and runs for the whole of the overlay's appearance, so any
 * frame in which the overlay was visible-but-unprotected lands inside the series. The
 * control arm clears the flag before the window is shown and must catch the patch -
 * without that, "never seen" would only mean the probe finished too early.
 */
async function testFirstPaint(WindowManager, display, monitorId, protect) {
  const manager = new WindowManager({ distDir: DIST });
  const global = (rect) => ({
    x: display.bounds.x + rect.x, y: display.bounds.y + rect.y,
    width: rect.width, height: rect.height,
  });

  const underlay = openPlainWindow(global(UNDERLAY), UNDERLAY_HTML);
  const beacon = openPlainWindow(global(BEACON), BEACON_HTML);
  await waitUntilPainted(underlay);
  await waitUntilPainted(beacon);
  await delay(SETTLE_MS);

  const running = probe(monitorId, PROBE, 300);
  // The probe process needs ~1s to start, create its D3D device and open the WGC
  // session. Without this head start its first frame already contains the overlay, and a
  // series that never saw the screen *without* the overlay cannot show the appearance.
  await delay(1600);

  const overlay = manager.openOverlay(display.id);
  // openOverlay sets protection before the window is shown; the control undoes it in the
  // same synchronous window, so both arms differ only in the flag, never in the ordering.
  if (!protect) overlay.setContentProtection(false);

  await waitUntilPainted(overlay);
  await overlay.webContents.executeJavaScript(`(() => {
    document.body.replaceChildren();
    const patch = document.createElement('div');
    patch.style.cssText = 'position:fixed;left:${PATCH.x}px;top:${PATCH.y}px;'
      + 'width:${PATCH.width}px;height:${PATCH.height}px;background:#${OVERLAY_RGB};z-index:2147483647';
    document.body.appendChild(patch);
  })()`);

  const report = await running;
  console.error(`\n--- first-paint, protection ${protect ? 'ON (production ordering)' : 'OFF (control)'} on ${monitorId}`);
  console.error(report.split('\n').map((line) => `  ${line}`).join('\n'));

  manager.closeAll();
  for (const window of [underlay, beacon]) if (!window.isDestroyed()) window.destroy();
  await delay(400);
}

/**
 * Second-order question the S2 result raises: an excluded overlay is not *in* the frames,
 * but does it still cause frames to be *delivered*? WGC only produces a frame when the
 * display changes (ground truth), so if our own crossfades keep waking the capture path
 * at 60Hz over an otherwise static screen, the overlay pays for capture+diff work that
 * can never find anything. No beacon here on purpose - the animating overlay is the only
 * thing moving.
 */
async function testFrameDrive(WindowManager, display, monitorId, protect, animate) {
  const manager = new WindowManager({ distDir: DIST });
  const underlay = openPlainWindow({
    x: display.bounds.x + UNDERLAY.x, y: display.bounds.y + UNDERLAY.y,
    width: UNDERLAY.width, height: UNDERLAY.height,
  }, UNDERLAY_HTML);
  await waitUntilPainted(underlay);

  const overlay = manager.openOverlay(display.id);
  if (!protect) overlay.setContentProtection(false);
  await waitUntilPainted(overlay);
  await overlay.webContents.executeJavaScript(`(() => {
    document.body.replaceChildren();
    const patch = document.createElement('div');
    patch.style.cssText = 'position:fixed;left:${PATCH.x}px;top:${PATCH.y}px;'
      + 'width:${PATCH.width}px;height:${PATCH.height}px;z-index:2147483647';
    document.body.appendChild(patch);
    patch.style.background = '#${OVERLAY_RGB}';
    if (${animate}) {
      let i = 0;
      setInterval(() => { i = (i + 11) % 360; patch.style.background = 'hsl(' + i + ',100%,50%)'; }, 16);
    }
  })()`);
  await delay(SETTLE_MS);

  const started = Date.now();
  const report = await probe(monitorId, PROBE, 120);
  console.error(`\n--- frame-drive, protection ${protect ? 'ON ' : 'OFF'} overlay ${animate ? 'ANIMATING' : 'STATIC   '} `
    + `on ${monitorId} (no beacon) wall=${Date.now() - started}ms`);
  console.error(report.split('\n').map((line) => `  ${line}`).join('\n'));

  manager.closeAll();
  if (!underlay.isDestroyed()) underlay.destroy();
  await delay(400);
}

async function main() {
  const wanted = (process.argv.find((a) => a.startsWith('--displays=')) ?? '--displays=1,3,2')
    .split('=')[1]
    .split(',')
    .map((n) => `\\\\.\\DISPLAY${n.trim()}`);

  const { WindowManager } = await import(
    pathToFileURL(path.join(DIST, 'main', 'services', 'window-manager.js')).href
  );

  const monitors = await listSidecarMonitors();
  console.error(`sidecar monitors: ${monitors.map((m) => `${m.id}[${m.x},${m.y},${m.width},${m.height}]`).join(' ')}`);

  for (const monitorId of wanted) {
    const monitor = monitors.find((m) => m.id === monitorId);
    if (monitor === undefined) {
      console.error(`skipping ${monitorId}: the sidecar does not report it`);
      continue;
    }
    // Matched on bounds, not id: Electron display ids and sidecar monitor ids are
    // different namespaces that happen to describe the same rectangles.
    const display = screen.getAllDisplays().find(
      (d) => d.bounds.x === monitor.x && d.bounds.y === monitor.y
        && d.bounds.width === monitor.width && d.bounds.height === monitor.height,
    );
    if (display === undefined) {
      console.error(`skipping ${monitorId}: no Electron display has those bounds`);
      continue;
    }
    if (process.argv.includes('--frame-drive')) {
      // The static arm is the control: if it starves, then the frames the animating arm
      // received can only have come from the excluded overlay repainting.
      await testFrameDrive(WindowManager, display, monitorId, true, false);
      await testFrameDrive(WindowManager, display, monitorId, true, true);
    } else if (process.argv.includes('--first-paint')) {
      await testFirstPaint(WindowManager, display, monitorId, false);
      await testFirstPaint(WindowManager, display, monitorId, true);
    } else {
      await testDisplay(WindowManager, display, monitorId);
    }
  }
}

// Nothing in this harness may outlive it. A leaked always-on-top window is somebody
// else's afternoon.
const bail = setTimeout(() => {
  console.error('TIMEOUT — harness exceeded its budget, exiting');
  app.exit(9);
}, 8 * 60_000);

app.whenReady()
  .then(main)
  .then(() => { clearTimeout(bail); console.error('\ndone'); app.exit(0); })
  .catch((error) => { clearTimeout(bail); console.error(`FAILED: ${error?.stack ?? error}`); app.exit(1); });

app.on('window-all-closed', () => { /* arms close windows between displays; do not quit */ });
