/**
 * Overlay renderer, M1-05.
 *
 * Deliberately tiny. The real overlay - translated text boxes, anchoring, crossfade -
 * is M5. This script only makes the window's own geometry observable, because "does the
 * overlay actually cover the display" cannot be answered by looking at the main process
 * code that asked for it.
 *
 * The click counter is the honest part: the window sets `setIgnoreMouseEvents`, so if
 * that is working this number can never leave zero no matter where the user clicks. A
 * counter that moves is the bug report.
 */

function text(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element !== null) element.textContent = value;
}

function report(): void {
  text('viewport', `${String(window.innerWidth)} x ${String(window.innerHeight)} CSS px`);
  text('dpr', window.devicePixelRatio.toFixed(2));
}

report();

// `display-metrics-changed` resizes the window from the main process; this is how the
// renderer notices, and how a manual test can see the new size without restarting.
window.addEventListener('resize', report);

let clicks = 0;
window.addEventListener('click', () => {
  clicks += 1;
  text('clicks', `${String(clicks)} — CLICK-THROUGH IS BROKEN`);
});
