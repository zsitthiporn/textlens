/**
 * The crosshair region picker (issue M6-02 / #29, feature R1).
 *
 * The reference project advertises this feature and does not have it - it captures the whole
 * screen every time. Spike S1 measured a cropped region as four times faster *and* more
 * accurate than a full-screen capture, so this window is the main advantage this project has
 * over the thing it was modelled on.
 *
 * ## What this file is not allowed to do
 *
 * **No coordinate conversion.** It reports the rectangle in CSS px relative to its own window
 * and stops there. Turning that into the sidecar's physical-px, monitor-relative region is
 * `coordinates.ts`'s job in the main process, because invariant 3 says scale arithmetic has one
 * owner - and because this renderer cannot know the window origin it would need. `scaleFactor`
 * is used here for exactly one thing: printing a size the user can recognise.
 */

import type { PickerInit, PickerRect } from './contract.js';
import { clampToWindow, normalizeDrag, physicalSize, type DragPoint } from './drag.js';

const shadeTop = document.querySelector<HTMLElement>('#shade-top');
const shadeBottom = document.querySelector<HTMLElement>('#shade-bottom');
const shadeLeft = document.querySelector<HTMLElement>('#shade-left');
const shadeRight = document.querySelector<HTMLElement>('#shade-right');
const selectionBox = document.querySelector<HTMLElement>('#selection');
const readout = document.querySelector<HTMLElement>('#readout');
const hint = document.querySelector<HTMLElement>('#hint');
const hintMonitor = document.querySelector<HTMLElement>('#hint-monitor');

let init: PickerInit | null = null;
let anchor: DragPoint | null = null;
let current: PickerRect | null = null;
/** Set the moment an answer is sent, so a stray Esc after a confirm cannot send a second one. */
let settled = false;

window.textlensRegionPicker.onInit((message) => {
  init = message;
  if (hintMonitor !== null) {
    const [width, height] = message.monitorSize;
    hintMonitor.textContent = `${message.monitorLabel} - ${width}x${height}`;
  }
  if (message.current !== null) {
    current = message.current;
    paint(message.current);
  } else {
    // No previous region: dim the whole screen by making the "top" panel cover everything, so
    // the window reads as an active modal rather than as a transparent pane over the desktop.
    paint(null);
  }
});

function paint(rect: PickerRect | null): void {
  const width = window.innerWidth;
  const height = window.innerHeight;

  if (rect === null) {
    setBox(shadeTop, 0, 0, width, height);
    setBox(shadeBottom, 0, 0, 0, 0);
    setBox(shadeLeft, 0, 0, 0, 0);
    setBox(shadeRight, 0, 0, 0, 0);
    if (selectionBox !== null) selectionBox.hidden = true;
    if (readout !== null) readout.hidden = true;
    return;
  }

  // Four panels around the hole. Left and right span only the selection's own rows so the
  // corners are covered exactly once - overlapping them would double the dimming there and
  // draw a visible cross on screen.
  setBox(shadeTop, 0, 0, width, rect.y);
  setBox(shadeBottom, 0, rect.y + rect.height, width, height - (rect.y + rect.height));
  setBox(shadeLeft, 0, rect.y, rect.x, rect.height);
  setBox(shadeRight, rect.x + rect.width, rect.y, width - (rect.x + rect.width), rect.height);

  if (selectionBox !== null) {
    selectionBox.hidden = false;
    selectionBox.style.left = `${rect.x}px`;
    selectionBox.style.top = `${rect.y}px`;
    selectionBox.style.width = `${rect.width}px`;
    selectionBox.style.height = `${rect.height}px`;
    selectionBox.classList.toggle('too-small', isTooSmall(rect));
  }

  paintReadout(rect);
}

function setBox(element: HTMLElement | null, x: number, y: number, width: number, height: number): void {
  if (element === null) return;
  element.style.left = `${x}px`;
  element.style.top = `${y}px`;
  element.style.width = `${Math.max(0, width)}px`;
  element.style.height = `${Math.max(0, height)}px`;
}

function isTooSmall(rect: PickerRect): boolean {
  if (init === null) return false;
  const [width, height] = physicalSize(rect, init.scaleFactor);
  return width < init.minimumPx || height < init.minimumPx;
}

function paintReadout(rect: PickerRect): void {
  if (readout === null || init === null) return;
  const [width, height] = physicalSize(rect, init.scaleFactor);
  const small = isTooSmall(rect);

  readout.hidden = false;
  readout.textContent = small
    ? `${width} x ${height} px - too small, minimum ${init.minimumPx}`
    : `${width} x ${height} px`;
  readout.classList.toggle('too-small', small);

  // Below the selection normally, above it when there is no room - a read-out that runs off
  // the bottom of the screen is exactly where a subtitle region will put it.
  const preferredTop = rect.y + rect.height + 8;
  const top = preferredTop + 24 > window.innerHeight ? rect.y - 28 : preferredTop;
  readout.style.left = `${Math.min(rect.x, window.innerWidth - 160)}px`;
  readout.style.top = `${Math.max(0, top)}px`;
}

window.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || settled) return;
  anchor = clampToWindow({ x: event.clientX, y: event.clientY }, window.innerWidth, window.innerHeight);
  current = normalizeDrag(anchor, anchor);
  hint?.classList.add('dragging');
  paint(current);
});

window.addEventListener('mousemove', (event) => {
  if (anchor === null) return;
  const cursor = clampToWindow({ x: event.clientX, y: event.clientY }, window.innerWidth, window.innerHeight);
  current = normalizeDrag(anchor, cursor);
  paint(current);
});

window.addEventListener('mouseup', (event) => {
  if (anchor === null || event.button !== 0) return;
  const cursor = clampToWindow({ x: event.clientX, y: event.clientY }, window.innerWidth, window.innerHeight);
  const rect = normalizeDrag(anchor, cursor);
  anchor = null;
  current = rect;
  hint?.classList.remove('dragging');

  // An undersized selection is not sent. The main process would refuse it anyway, but bouncing
  // it here means the user keeps the picker and can simply drag again, rather than having the
  // window vanish and a warning appear somewhere they are not looking.
  if (isTooSmall(rect)) {
    paint(rect);
    return;
  }
  submit({ rect });
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    submit(null);
    return;
  }
  // Enter confirms whatever is currently drawn, per #29's "Enter/ปล่อยเมาส์ = ยืนยัน".
  if (event.key === 'Enter' && current !== null && !isTooSmall(current)) {
    event.preventDefault();
    submit({ rect: current });
  }
});

/** Losing focus means something else took over the screen; treat it as a cancel. */
window.addEventListener('blur', () => {
  submit(null);
});

function submit(result: { rect: PickerRect } | null): void {
  if (settled) return;
  settled = true;
  window.textlensRegionPicker.submit(result);
}
