/**
 * The settings window (issue M9-02 / #39, feature ST4 + PR1).
 *
 * Plain DOM, no framework, hand-written - the same as the overlay and the region picker. Three
 * panels' worth of controls does not pay for a runtime, and the two documents this window sits
 * beside are already built this way.
 *
 * ## What is here because it was promised
 *
 * Four gaps were each accepted earlier on the explicit promise that this window would close them,
 * and each is a control below rather than a line in a log:
 *
 *   - **Config schema errors.** `ConfigService` has always named the offending field by path; it
 *     reached the log and a getter. The issue list renders those paths, and a rejected write puts
 *     its message underneath the control that caused it.
 *   - **Hotkey conflicts.** `Control+Alt+R` does not register on this machine. Each row captures a
 *     real keystroke - see {@link beginCapture} - because a typed accelerator is a trap: Electron
 *     silently drops a misspelled modifier and binds what is left, so `Foo+Bar+A` takes the bare
 *     `A` key process-wide while reporting success.
 *   - **No monitor list.** The Capture panel's first control.
 *   - **`not-persisted`.** The main process now republishes config issues after every write, so a
 *     change that could not reach the disk says so here while the app keeps running on it.
 *
 * ## Everything is written through the main process
 *
 * No validation is duplicated in this window. `setConfig` returns the field errors zod produced,
 * which is one validator rather than two that can disagree - and it is also why the schema module
 * is imported `import type` only: it has a value-level `zod` import, and the types alone keep zod
 * out of this bundle.
 */

import type { ConfigOverride } from '../../shared/config-schema.js';
import { acceleratorFromKeyStroke } from '../../shared/accelerator.js';
import { describeMode, MODE_NAMES, type UserMode } from '../../shared/mode-presentation.js';

import './settings.css';
import type {
  SettingsBridge,
  SettingsCommand,
  SettingsFieldError,
  SettingsHotkey,
  SettingsState,
} from './contract.js';

declare global {
  interface Window {
    /** Exposed by `src/preload/index.cts`. Absent in any window that is not the settings window. */
    readonly textlensSettings?: SettingsBridge;
    /**
     * Diagnostics seam, mirroring the overlay's `__textlensOverlay` (#35, #41).
     *
     * This window has no visible-pixel problem the way the overlay does, but it has the opposite
     * one: it is driven entirely by IPC, so a headless check has no way to put a state in front of
     * it or to read back what a control did. Present in every build for the same reason the
     * overlay's is - a seam that only exists in a debug build is a seam that is never exercised by
     * the thing that ships.
     */
    __textlensSettings?: {
      readonly render: (state: SettingsState) => void;
      readonly state: () => SettingsState | null;
      /** Feed a keystroke to whichever hotkey row is capturing. Returns the row's label text. */
      readonly key: (stroke: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }) => string;
      readonly capturing: () => string | null;
    };
  }
}

// ---------------------------------------------------------------------------
// Field descriptions - the numeric controls, declared once rather than built by hand
// ---------------------------------------------------------------------------

interface NumberField {
  /** Dotted config path. Doubles as the control's id and as the key a field error is matched on. */
  readonly path: string;
  readonly label: string;
  readonly hint: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: string;
  readonly read: (state: SettingsState) => number;
  readonly write: (value: number) => ConfigOverride;
}

const APPEARANCE_FIELDS: readonly NumberField[] = [
  {
    path: 'render.fontSize',
    label: 'Text size',
    hint: 'Applies to the next frame. Thai stacks up to three marks on a line, so very small sizes lose tone marks.',
    min: 10,
    max: 48,
    step: 1,
    unit: 'px',
    read: (state) => state.config.render.fontSize,
    write: (value) => ({ render: { fontSize: value } }),
  },
  {
    path: 'render.opacity',
    label: 'Box opacity',
    hint: 'The plate behind the text, not the text itself — the crossfade owns the box’s own opacity.',
    min: 0.2,
    max: 1,
    step: 0.02,
    unit: '',
    read: (state) => state.config.render.opacity,
    write: (value) => ({ render: { opacity: value } }),
  },
  {
    path: 'render.minDisplayMs',
    label: 'Minimum display time',
    hint: 'How long a box is guaranteed to stay before different text may replace it.',
    min: 0,
    max: 3000,
    step: 50,
    unit: 'ms',
    read: (state) => state.config.render.minDisplayMs,
    write: (value) => ({ render: { minDisplayMs: value } }),
  },
  {
    path: 'render.fadeMs',
    label: 'Crossfade',
    hint: '0 swaps text instantly instead of dissolving it.',
    min: 0,
    max: 1000,
    step: 10,
    unit: 'ms',
    read: (state) => state.config.render.fadeMs,
    write: (value) => ({ render: { fadeMs: value } }),
  },
];

const CAPTURE_FIELDS: readonly NumberField[] = [
  {
    path: 'capture.intervalActive',
    label: 'Poll interval (active)',
    hint: 'How often the screen is sampled while text is changing.',
    min: 100,
    max: 5000,
    step: 50,
    unit: 'ms',
    read: (state) => state.config.capture.intervalActive,
    write: (value) => ({ capture: { intervalActive: value } }),
  },
  {
    path: 'capture.intervalIdle',
    label: 'Poll interval (idle)',
    hint: 'The slower interval used once the region stops changing.',
    min: 200,
    max: 20000,
    step: 100,
    unit: 'ms',
    read: (state) => state.config.capture.intervalIdle,
    write: (value) => ({ capture: { intervalIdle: value } }),
  },
  {
    path: 'capture.regionPadding',
    label: 'Region padding',
    hint: 'Margin added around your region before it is cropped. A crop through a glyph breaks OCR outright.',
    min: 0,
    max: 64,
    step: 1,
    unit: 'px',
    read: (state) => state.config.capture.regionPadding,
    write: (value) => ({ capture: { regionPadding: value } }),
  },
];

/**
 * The shortcut rows' names, which are the mode names plus the two actions that are not modes.
 *
 * `snapshot` is the config key and cannot move - the schema is a `strictObject`, so renaming it
 * rejects the user's entire file rather than one field. The *label* comes from
 * `shared/mode-presentation.ts` so that this row, the header buttons and the tray all say the same
 * words; #60 exists because they did not.
 */
const HOTKEY_LABELS: Readonly<Record<string, string>> = {
  toggleAuto: `${MODE_NAMES.auto} on / off`,
  snapshot: MODE_NAMES.once,
  selectRegion: 'Choose a region',
  toggleOverlay: 'Show / hide the boxes',
};

// ---------------------------------------------------------------------------

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A titled panel. Returns the body to append controls to. */
function panel(parent: HTMLElement, title: string, note?: string): HTMLElement {
  const section = element('section', 'panel');
  section.append(element('h2', undefined, title));
  if (note !== undefined) section.append(element('p', 'panel-note', note));
  const body = element('div', 'panel-body');
  section.append(body);
  parent.append(section);
  return body;
}

export function mountSettings(root: HTMLElement): void {
  const bridge = window.textlensSettings;
  root.replaceChildren();

  let state: SettingsState | null = null;
  /** The hotkey row currently listening for a keystroke, if any. */
  let capturing: string | null = null;
  /** Per-control error text, keyed by config path. Cleared when the next write succeeds. */
  const fieldErrors = new Map<string, string>();

  // -- header -------------------------------------------------------------
  const header = element('header', 'header');
  const modeLabel = element('span', 'mode-pill', 'idle');
  const modeButtons = element('div', 'mode-buttons');
  const alertBox = element('div', 'alert');
  alertBox.hidden = true;
  const alertCause = element('div', 'alert-cause');
  const alertRemedy = element('div', 'alert-remedy');
  alertBox.append(alertCause, alertRemedy);

  header.append(element('h1', undefined, 'Textlens'), modeLabel, modeButtons);
  root.append(header, alertBox);

  const send = (command: SettingsCommand): void => {
    void bridge?.command(command);
  };

  // -- mode selector (#60) -------------------------------------------------
  //
  // Two buttons, not three. Auto and Translate once are the entire choice; pausing is Auto
  // switched off, so it is the same button clicked again rather than a peer of the other two -
  // which is what made this row and the tray menu read as unrelated scattered controls. The label
  // and the active flag both come from `shared/mode-presentation.ts`, so this window and the tray
  // cannot drift apart again.
  const modeChoiceButtons = new Map<UserMode, HTMLButtonElement>();
  for (const choice of describeMode('idle').choices) {
    const button = element('button', 'ghost mode-choice', choice.label);
    button.addEventListener('click', () => {
      send(choice.command);
    });
    modeChoiceButtons.set(choice.mode, button);
    modeButtons.append(button);
  }

  // Deliberately outside the pair above. Hiding the boxes is not a mode: capture, OCR and
  // translation all carry on (#34), so presenting it as a third choice would say the opposite.
  const overlayButton = element('button', 'ghost', 'Show / hide boxes');
  overlayButton.addEventListener('click', () => {
    send('toggleOverlay');
  });
  modeButtons.append(overlayButton);

  // -- first-run prompt (#51) ---------------------------------------------
  //
  // Its own band above every panel rather than a line inside Capture. With no region the app does
  // not start at all, so this is not one setting among several - it is the only thing to do, and a
  // user who has to find it inside a panel has already been left to guess.
  const firstRun = element('div', 'first-run');
  const firstRunText = element('div', 'first-run-text');
  firstRunText.append(
    element('strong', undefined, 'Choose what to translate'),
    element(
      'span',
      undefined,
      'Textlens has no capture region yet. Until you pick one the whole screen is the region, '
        + 'which means every clock tick and blinking cursor is treated as new text to read and '
        + 'translate. Drag a box around the subtitles or the text you care about.',
    ),
  );
  const firstRunButton = element('button', 'primary', 'Choose a region…');
  firstRunButton.addEventListener('click', () => {
    send('selectRegion');
  });
  firstRun.append(firstRunText, firstRunButton);
  root.append(firstRun);

  const columns = element('div', 'columns');
  root.append(columns);
  const left = element('div', 'column');
  const right = element('div', 'column');
  columns.append(left, right);

  // -- capture ------------------------------------------------------------
  const captureBody = panel(left, 'Capture');

  const monitorRow = element('div', 'row');
  monitorRow.append(element('label', 'row-label', 'Monitor'));
  const monitorSelect = element('select', 'control');
  monitorSelect.id = 'capture.monitorId';
  monitorRow.append(monitorSelect);
  const monitorHint = element('p', 'hint', 'The screen Textlens captures. Choosing a different one clears the saved region, because a rectangle drawn on one monitor means nothing on another.');
  captureBody.append(monitorRow, monitorHint, errorSlot('capture.monitorId'));

  monitorSelect.addEventListener('change', () => {
    const id = monitorSelect.value;
    // The region goes with it, deliberately. A saved region names the monitor it was drawn on, and
    // `AppOrchestrator` responds to one that names a different monitor by capturing the whole
    // screen - which is the #51 state arriving by the back door. Clearing it puts the app in its
    // honest first-run state instead, where the flow routes the user to the picker.
    void write({ capture: { monitorId: id === '' ? null : id, region: null } }, 'capture.monitorId');
  });

  const regionRow = element('div', 'row region-row');
  regionRow.append(element('label', 'row-label', 'Region'));
  const regionSummary = element('span', 'region-summary', 'none');
  const regionPick = element('button', 'ghost', 'Choose…');
  const regionClear = element('button', 'ghost', 'Clear');
  regionPick.addEventListener('click', () => {
    send('selectRegion');
  });
  regionClear.addEventListener('click', () => {
    send('clearRegion');
  });
  regionRow.append(regionSummary, regionPick, regionClear);
  captureBody.append(regionRow);

  const captureControls = numberControls(CAPTURE_FIELDS, captureBody);

  // -- appearance ---------------------------------------------------------
  const appearanceBody = panel(left, 'Appearance');
  const appearanceControls = numberControls(APPEARANCE_FIELDS, appearanceBody);

  const displayRow = element('div', 'row');
  displayRow.append(element('label', 'row-label', 'Display mode'));
  displayRow.append(element('span', 'fixed-value', 'Side-by-side (a box under each block)'));
  appearanceBody.append(displayRow);
  appearanceBody.append(
    element(
      'p',
      'hint',
      'The only mode that is built. Replace, hover-marker and panel modes are on the backlog, not hidden behind a setting.',
    ),
  );

  // -- hotkeys ------------------------------------------------------------
  const hotkeyBody = panel(
    right,
    'Shortcuts',
    'Click a shortcut and press the keys you want. They are captured, never typed — Windows accepts a '
      + 'misspelled modifier by dropping it, which turns a typo into a key taken from every program on the machine.',
  );
  const hotkeyRows = new Map<string, { button: HTMLButtonElement; status: HTMLElement }>();

  // -- translation + privacy (PR1) ---------------------------------------
  const translationBody = panel(right, 'Translation');
  const engineRow = element('div', 'row');
  engineRow.append(element('label', 'row-label', 'Engine'));
  const engineValue = element('span', 'fixed-value', '—');
  engineRow.append(engineValue);
  const langRow = element('div', 'row');
  langRow.append(element('label', 'row-label', 'Language'));
  const langValue = element('span', 'fixed-value', '—');
  langRow.append(langValue);
  translationBody.append(engineRow, langRow);
  translationBody.append(
    element(
      'p',
      'hint',
      'Both are fixed in this build. Google is the only engine registered — the local-model adapter that '
        + 'would be the second is not built yet — and Thai is what the overlay is designed around: the Thai '
        + 'script range is how Textlens recognises and discards its own output when it reads the screen back.',
    ),
  );

  // PR1 is บังคับ: the user has to know that using Google means screen text leaves the machine.
  const privacy = element('div', 'privacy');
  privacy.append(
    element('strong', undefined, 'Your screen text is sent to Google'),
    element(
      'span',
      undefined,
      'Translation uses Google Translate, so every line Textlens reads from your screen is sent over the '
        + 'internet to Google to be translated. Nothing else leaves this machine: captured pixels never do, '
        + 'and translations are cached locally so repeated text is not sent twice. If that is not acceptable '
        + 'for what is on your screen, do not use Textlens on it.',
    ),
  );
  translationBody.append(privacy);

  // -- config file + issues ------------------------------------------------
  const aboutBody = panel(right, 'Configuration');
  const sidecarRow = element('div', 'row');
  sidecarRow.append(element('label', 'row-label', 'Capture engine'));
  const sidecarDot = element('span', 'dot');
  const sidecarText = element('span', 'fixed-value', '—');
  const sidecarRestart = element('button', 'ghost', 'Restart');
  sidecarRestart.addEventListener('click', () => {
    send('restartSidecar');
  });
  sidecarRow.append(sidecarDot, sidecarText, sidecarRestart);
  aboutBody.append(sidecarRow);

  const pathRow = element('div', 'row');
  pathRow.append(element('label', 'row-label', 'Settings file'));
  const pathValue = element('code', 'path', '—');
  const reloadButton = element('button', 'ghost', 'Reload');
  reloadButton.addEventListener('click', () => {
    send('reloadConfig');
  });
  pathRow.append(pathValue, reloadButton);
  aboutBody.append(pathRow);

  const issueList = element('ul', 'issues');
  aboutBody.append(issueList);

  const versions = element('p', 'versions', '');
  aboutBody.append(versions);

  // -----------------------------------------------------------------------

  /** A slot under a control where its own validation message lands. */
  function errorSlot(path: string): HTMLElement {
    const node = element('p', 'field-error');
    node.dataset['path'] = path;
    node.hidden = true;
    return node;
  }

  function numberControls(
    fields: readonly NumberField[],
    parent: HTMLElement,
  ): Map<string, { range: HTMLInputElement; number: HTMLInputElement }> {
    const controls = new Map<string, { range: HTMLInputElement; number: HTMLInputElement }>();
    for (const field of fields) {
      const row = element('div', 'row');
      const label = element('label', 'row-label', field.label);
      label.htmlFor = field.path;

      const range = element('input', 'range');
      range.type = 'range';
      range.id = field.path;
      range.min = String(field.min);
      range.max = String(field.max);
      range.step = String(field.step);

      const number = element('input', 'number');
      number.type = 'number';
      number.min = String(field.min);
      number.max = String(field.max);
      number.step = String(field.step);

      const unit = element('span', 'unit', field.unit);
      row.append(label, range, number, unit);
      parent.append(row, element('p', 'hint', field.hint), errorSlot(field.path));
      controls.set(field.path, { range, number });

      // `input` for a live feel while dragging, debounced so a drag is one write rather than
      // sixty; `change` for the keyboard and for the release, undebounced so the last value always
      // lands even if the debounce was still pending.
      const apply = (raw: string, immediate: boolean): void => {
        const value = Number(raw);
        if (!Number.isFinite(value)) return;
        number.value = raw;
        range.value = raw;
        schedule(field, value, immediate);
      };
      range.addEventListener('input', () => {
        apply(range.value, false);
      });
      range.addEventListener('change', () => {
        apply(range.value, true);
      });
      number.addEventListener('change', () => {
        apply(number.value, true);
      });
    }
    return controls;
  }

  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  function schedule(field: NumberField, value: number, immediate: boolean): void {
    const existing = pending.get(field.path);
    if (existing !== undefined) clearTimeout(existing);
    if (immediate) {
      pending.delete(field.path);
      void write(field.write(value), field.path);
      return;
    }
    pending.set(
      field.path,
      setTimeout(() => {
        pending.delete(field.path);
        void write(field.write(value), field.path);
      }, 180),
    );
  }

  /**
   * Send one change and route whatever came back to the control that caused it.
   *
   * `path` is the control's own path, and it is used for the errors that name *no* field - a
   * rejected write with an empty error list would otherwise produce no visible message at all,
   * which is the silent failure this whole window exists to end.
   */
  async function write(change: ConfigOverride, path: string): Promise<void> {
    if (bridge === undefined) return;
    const result = await bridge.setConfig(change);
    fieldErrors.delete(path);
    if (!result.applied) {
      const message = describeErrors(result.errors, path);
      fieldErrors.set(path, message);
    }
    for (const error of result.errors) fieldErrors.set(error.path, error.message);
    renderErrors();
  }

  function describeErrors(errors: readonly SettingsFieldError[], path: string): string {
    const own = errors.find((error) => error.path === path);
    if (own !== undefined) return own.message;
    if (errors.length === 0) return 'this value was rejected';
    return errors.map((error) => `${error.path}: ${error.message}`).join('; ');
  }

  function renderErrors(): void {
    for (const slot of root.querySelectorAll<HTMLElement>('.field-error')) {
      const path = slot.dataset['path'] ?? '';
      const message = fieldErrors.get(path);
      slot.textContent = message ?? '';
      slot.hidden = message === undefined;
    }
  }

  // -- hotkey capture ------------------------------------------------------

  /**
   * Listen for one keystroke and turn it into a binding (#39, #32).
   *
   * `keydown` on `window` with `capture: true` and `preventDefault`, so the keystroke is consumed
   * here rather than reaching a control - otherwise capturing `Control+Alt+S` while the button has
   * focus would also activate the button.
   *
   * The string is built by `shared/accelerator.ts` from `KeyboardEvent.code`, never from `key` and
   * never from anything the user typed. That is the whole safety argument: every token it can emit
   * comes from a table, so the misspelled-modifier trap has no way in.
   */
  function beginCapture(action: string): void {
    if (capturing !== null) endCapture();
    capturing = action;
    const row = hotkeyRows.get(action);
    if (row !== undefined) {
      row.button.textContent = 'Press keys…';
      row.button.classList.add('capturing');
      row.status.textContent = 'Esc cancels. Hold Control, Alt, Shift or Win and press a key.';
      row.status.className = 'hotkey-status';
    }
    window.addEventListener('keydown', onCaptureKey, true);
  }

  function endCapture(): void {
    window.removeEventListener('keydown', onCaptureKey, true);
    const action = capturing;
    capturing = null;
    if (action !== null && state !== null) renderHotkeys(state);
  }

  function onCaptureKey(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
    void handleStroke({
      code: event.code,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
    });
  }

  async function handleStroke(stroke: {
    code: string;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
  }): Promise<string> {
    const action = capturing;
    if (action === null) return '';
    const row = hotkeyRows.get(action);
    const result = acceleratorFromKeyStroke(stroke);

    if (result.kind === 'pending') return 'pending';
    if (result.kind === 'cancel') {
      endCapture();
      return 'cancelled';
    }
    if (result.kind === 'rejected') {
      if (row !== undefined) {
        row.status.textContent = result.message;
        row.status.className = 'hotkey-status bad';
      }
      return result.message;
    }

    const outcome = await (bridge?.setHotkey({ action: action as never, accelerator: result.accelerator })
      ?? Promise.resolve({ ok: false, message: 'no bridge' }));
    if (!outcome.ok) {
      // Stay in capture so the user can simply press something else - the whole point of this
      // window is that a taken key has a way out that is not editing JSON.
      if (row !== undefined) {
        row.status.textContent = outcome.message ?? 'that shortcut could not be registered';
        row.status.className = 'hotkey-status bad';
        row.button.textContent = 'Press keys…';
      }
      return outcome.message ?? 'refused';
    }
    endCapture();
    return result.accelerator;
  }

  function renderHotkeys(next: SettingsState): void {
    for (const hotkey of next.hotkeys) {
      let row = hotkeyRows.get(hotkey.action);
      if (row === undefined) {
        const container = element('div', 'hotkey-row');
        const label = element('div', 'row-label', HOTKEY_LABELS[hotkey.action] ?? hotkey.action);
        const button = element('button', 'hotkey-button');
        const clear = element('button', 'ghost small', 'Unbind');
        const status = element('div', 'hotkey-status');
        button.addEventListener('click', () => {
          beginCapture(hotkey.action);
        });
        clear.addEventListener('click', () => {
          void bridge?.setHotkey({ action: hotkey.action, accelerator: null });
        });
        const controls = element('div', 'hotkey-controls');
        controls.append(button, clear);
        container.append(label, controls, status);
        hotkeyBody.append(container);
        row = { button, status };
        hotkeyRows.set(hotkey.action, row);
      }

      if (capturing === hotkey.action) continue;
      row.button.classList.remove('capturing');
      row.button.textContent = hotkey.accelerator ?? 'Not bound';
      row.status.textContent = describeHotkey(hotkey);
      row.status.className = hotkey.ok || hotkey.reason === 'disabled' ? 'hotkey-status' : 'hotkey-status bad';
    }
  }

  function describeHotkey(hotkey: SettingsHotkey): string {
    if (hotkey.ok) return 'working';
    switch (hotkey.reason) {
      case 'disabled':
        return 'turned off — click to bind a key';
      case 'conflict':
        return 'another program already owns this key — click and press a different one';
      case 'duplicate':
        return `also bound to another Textlens action${hotkey.detail === undefined ? '' : ` (${hotkey.detail})`}`;
      case 'invalid':
        return `Windows will not register this${hotkey.detail === undefined ? '' : `: ${hotkey.detail}`}`;
      default:
        return 'not registered';
    }
  }

  // -- render --------------------------------------------------------------

  function render(next: SettingsState): void {
    state = next;

    // The pill reads in the user's words; `data-mode` keeps the internal name, because the
    // stylesheet keys its colours on it and because that is the word a bug report should carry.
    const presentation = describeMode(next.mode);
    modeLabel.textContent = presentation.label;
    modeLabel.dataset['mode'] = next.mode;
    for (const choice of presentation.choices) {
      const button = modeChoiceButtons.get(choice.mode);
      if (button === undefined) continue;
      button.textContent = choice.label;
      button.dataset['active'] = String(choice.active);
      // For the same reason the tray uses a checkbox: "which one am I in" has to be readable, and
      // a screen reader gets it from here rather than from the colour.
      button.setAttribute('aria-pressed', String(choice.active));
    }

    if (next.alert === null) {
      alertBox.hidden = true;
    } else {
      alertBox.hidden = false;
      alertBox.dataset['severity'] = next.alert.severity;
      alertCause.textContent = next.alert.cause;
      alertRemedy.textContent = next.alert.remedy;
    }

    firstRun.hidden = next.hasRegion;

    // Monitors. Rebuilt only when the list actually differs, so re-rendering does not throw away a
    // selection the user is in the middle of making.
    const wanted = next.monitors.map((monitor) => monitor.id).join('\0');
    if (monitorSelect.dataset['ids'] !== wanted) {
      monitorSelect.dataset['ids'] = wanted;
      monitorSelect.replaceChildren();
      const auto = element('option', undefined, 'Primary monitor (automatic)');
      auto.value = '';
      monitorSelect.append(auto);
      for (const monitor of next.monitors) {
        const option = element(
          'option',
          undefined,
          `${monitor.label} — ${String(monitor.width)}×${String(monitor.height)} @ ${String(monitor.scaleFactor)}×${monitor.primary ? ' (primary)' : ''}`,
        );
        option.value = monitor.id;
        monitorSelect.append(option);
      }
      if (next.monitors.length === 0) {
        const none = element('option', undefined, 'no monitors reported yet');
        none.value = '';
        none.disabled = true;
        monitorSelect.append(none);
      }
    }
    monitorSelect.value = next.config.capture.monitorId ?? '';

    const region = next.config.capture.region;
    regionSummary.textContent =
      region === null
        ? 'whole screen — not chosen yet'
        : `${String(region.rect[2])}×${String(region.rect[3])} at ${String(region.rect[0])},${String(region.rect[1])} on ${region.monitorId}`;
    regionClear.disabled = region === null;

    for (const [fields, controls] of [
      [CAPTURE_FIELDS, captureControls],
      [APPEARANCE_FIELDS, appearanceControls],
    ] as const) {
      for (const field of fields) {
        const control = controls.get(field.path);
        if (control === undefined) continue;
        const value = String(field.read(next));
        // Never while the control has focus: overwriting what somebody is typing is how a number
        // field becomes unusable.
        if (document.activeElement !== control.range) control.range.value = value;
        if (document.activeElement !== control.number) control.number.value = value;
      }
    }

    renderHotkeys(next);

    engineValue.textContent = next.engines.length === 0 ? 'none configured' : next.engines.join(' → ');
    langValue.textContent = `${next.srcLang} → ${next.tgtLang}`;

    sidecarText.textContent = next.sidecar.detail === null ? next.sidecar.state : `${next.sidecar.state} (${next.sidecar.detail})`;
    sidecarDot.dataset['state'] = next.sidecar.state;

    pathValue.textContent = next.configPath;

    issueList.replaceChildren();
    for (const issue of next.issues) {
      const item = element('li', `issue issue-${issue.kind}`);
      item.append(element('strong', undefined, ISSUE_TITLES[issue.kind] ?? issue.kind));
      item.append(element('span', undefined, issue.message));
      if (issue.fields.length > 0) {
        item.append(
          element('span', 'issue-fields', issue.fields.map((field) => `${field.path}: ${field.message}`).join(' · ')),
        );
      }
      issueList.append(item);
    }

    versions.textContent = `Electron ${next.versions.electron} · Chromium ${next.versions.chrome} · Node ${next.versions.node}`;

    renderErrors();
  }

  window.__textlensSettings = {
    render,
    state: () => state,
    key: (stroke) => {
      void handleStroke(stroke);
      return capturing ?? '';
    },
    capturing: () => capturing,
  };

  if (bridge === undefined) {
    root.append(element('p', 'hint', 'the settings bridge is unavailable in this window'));
    return;
  }

  bridge.onState(render);
  void bridge.request().then(render);
}

const ISSUE_TITLES: Readonly<Record<string, string>> = {
  unreadable: 'Settings file could not be read',
  malformed: 'Settings file is not valid JSON',
  invalid: 'A setting did not pass validation',
  'not-persisted': 'A change could not be saved',
};
