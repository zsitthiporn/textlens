/**
 * Pair the sidecar's monitors to Electron's displays (issue M6-01 / #28, feature R6).
 *
 * Two processes enumerate the same hardware and agree about nothing that could be used as a
 * key. The sidecar reports Win32 device names (`\\.\DISPLAY1`) and physical rectangles;
 * Electron reports opaque numeric ids, friendly names from EDID, and rectangles in Chromium's
 * DIP space. Until this module existed `src/main/index.ts` paired every frame to
 * `screen.getPrimaryDisplay()` regardless of which monitor it came from, so capturing a
 * secondary display placed every translation box on the wrong screen.
 *
 * ## What cannot be used as a key, and why
 *
 * - **`Display.label`.** Measured on this machine: `Dell AW3423DW`, `DELL S2721HN`, `S24R35x`.
 *   Friendly EDID names, not device names - there is nothing to match `\\.\DISPLAY1` against.
 * - **`Display.nativeOrigin`.** Its name promises exactly the physical origin this needs, and
 *   on this machine it even equals it. Electron's own type declaration says "Only available on
 *   windowing systems like X11 that position displays in pixel coordinates" - so on Windows it
 *   is not a contract, it is a coincidence that holds at scaleFactor 1.0. Rejected after
 *   reading the declaration, not after trusting the probe.
 * - **Origin equality.** `display.bounds` is DIP and `monitor.bounds` is physical, and design
 *   doc section 3 is explicit that a logical origin cannot be derived from a physical one once
 *   displays differ in DPI: Chromium lays displays out adjacent in DIP space rather than
 *   dividing each physical rect by its own scale. Matching origins passes every test that can
 *   be run on this hardware - where all three displays are 1.0 and the two spaces are
 *   numerically identical - and is wrong on the machines the feature exists for.
 *
 * ## What is used instead
 *
 * Only **per-display** properties, which are genuinely cross-derivable, plus one exact anchor:
 *
 *   1. **The primary.** Win32 defines the primary monitor as the one at physical `(0,0)`, and
 *      that is the same monitor Electron reports as primary. No arithmetic, no DPI exposure.
 *   2. **Scale and physical size.** A display's physical size *is* its DIP size times its own
 *      scale factor - a property of one display, not of the layout - so `size x scaleFactor`
 *      is comparable to the sidecar's `bounds[2..3]` at any DPI. Windows rounds DIP sizes, so
 *      the comparison carries a tolerance; 2560x1440 at 150% is 1706.67 DIP wide and exact
 *      equality would fail on real hardware.
 *   3. **Same-axis ordering**, and only for what the first two leave ambiguous - two identical
 *      monitors. Physical layout and DIP layout preserve each other's ordering along an axis
 *      even when they disagree about coordinates.
 *
 * A monitor that none of these resolves is left **unpaired**, loudly. The tempting fallback -
 * use the primary display - is the bug this module was written to remove, and it fails in the
 * way invariant 4 forbids: boxes are drawn confidently, on the wrong screen, with no error.
 *
 * ## No `electron` import
 *
 * {@link pairMonitors} is a pure function over two lists, and {@link MonitorService} takes its
 * screen access as {@link ScreenSource}. Same technique as `ShortcutRegistrar` and
 * `TrayPlatform`, and the same reason: these tests run in plain Node, and the mixed-DPI
 * fixtures they need describe hardware that is not attached to any machine here.
 */

import type { MonitorInfo } from '../../shared/protocol.js';
import type { DisplayGeometry } from '../utils/coordinates.js';
import { nullLogger, type Logger } from './logger.js';

/**
 * The part of an Electron `Display` pairing needs.
 *
 * Structural, so an `Electron.Display` satisfies it as-is and a test can fabricate a 4K
 * display at 200% that no attached monitor could provide. It extends {@link DisplayGeometry}
 * because the paired display is handed straight to the coordinate converter.
 */
export interface PairableDisplay extends DisplayGeometry {
  readonly id: number;
  /** Friendly name from the platform, e.g. `Dell AW3423DW`. For the picker UI, never for matching. */
  readonly label: string;
  /** Logical px (DIP), absolute on the virtual desktop. */
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Logical px (DIP). Physical size is this times {@link DisplayGeometry.scaleFactor}. */
  readonly size: { readonly width: number; readonly height: number };
}

/** How a pair was established. Recorded because the three differ a great deal in confidence. */
export type PairingMethod =
  /** Physical `(0,0)` matched Electron's primary. Exact, and DPI-independent. */
  | 'primary'
  /** Exactly one display had a matching scale and physical size. */
  | 'unique-metrics'
  /** Metrics were ambiguous - identical monitors - and same-axis ordering broke the tie. */
  | 'ordering';

export interface MonitorPair {
  readonly monitor: MonitorInfo;
  readonly display: PairableDisplay;
  readonly primary: boolean;
  readonly method: PairingMethod;
  /**
   * Win32 and Chromium disagree about this display's scale factor.
   *
   * `coordinates.ts` takes the scale from Chromium because the target space *is* Chromium's DIP
   * layout, and its module comment defers asserting that the two agree to this file. A mismatch
   * does not invalidate the pair - the conversion is still right - but it means one of the two
   * views of the desktop is stale, which is worth a line in the log.
   */
  readonly scaleMismatch: boolean;
}

export interface MonitorPairing {
  readonly pairs: readonly MonitorPair[];
  /** Monitors the sidecar can capture that nothing here can place boxes on. */
  readonly unpairedMonitors: readonly MonitorInfo[];
  /** Displays with no sidecar monitor. Ordinary when a display was added mid-session. */
  readonly unpairedDisplays: readonly PairableDisplay[];
}

/** Chromium and Win32 both report scale as a float; they should agree to well inside this. */
const SCALE_TOLERANCE = 0.01;

/**
 * Physical px of slack when comparing `size x scaleFactor` against Win32's rectangle.
 *
 * Windows computes DIP sizes by dividing and rounding, so the round trip does not always come
 * back exact - 2560 at 150% is 1706.67, and 1707 x 1.5 is 2560.5. Two pixels absorbs that
 * without being wide enough to confuse two real monitors, whose sizes differ by hundreds.
 */
const SIZE_TOLERANCE_PX = 2;

function scaleAgrees(monitor: MonitorInfo, display: PairableDisplay): boolean {
  return Math.abs(monitor.scale - display.scaleFactor) <= SCALE_TOLERANCE;
}

/**
 * Does this display's physical size match the monitor's?
 *
 * The only DPI arithmetic in this module, and it is legitimate where deriving an origin is not:
 * size is a property of one display, so multiplying its DIP size by its own scale factor
 * genuinely yields its physical size. An origin is a property of the *layout*, which is where
 * the two spaces stop corresponding.
 */
function sizeAgrees(monitor: MonitorInfo, display: PairableDisplay): boolean {
  const width = display.size.width * display.scaleFactor;
  const height = display.size.height * display.scaleFactor;
  return (
    Math.abs(monitor.bounds[2] - width) <= SIZE_TOLERANCE_PX
    && Math.abs(monitor.bounds[3] - height) <= SIZE_TOLERANCE_PX
  );
}

function metricsAgree(monitor: MonitorInfo, display: PairableDisplay): boolean {
  return scaleAgrees(monitor, display) && sizeAgrees(monitor, display);
}

/**
 * Pair each sidecar monitor with the Electron display showing the same hardware.
 *
 * Pure, total, and never throws: an empty list, a machine whose primary the sidecar did not
 * report, and two identical monitors are all ordinary inputs with defined outputs.
 *
 * @param primaryDisplayId `screen.getPrimaryDisplay().id`. Passed rather than looked up so the
 *                         function stays pure and a test can describe a machine whose primary
 *                         is not the first display in the list.
 */
export function pairMonitors(
  monitors: readonly MonitorInfo[],
  displays: readonly PairableDisplay[],
  primaryDisplayId: number,
): MonitorPairing {
  const pairs: MonitorPair[] = [];
  const remainingMonitors = [...monitors];
  const remainingDisplays = [...displays];

  const take = (monitor: MonitorInfo, display: PairableDisplay, method: PairingMethod): void => {
    pairs.push({
      monitor,
      display,
      primary: display.id === primaryDisplayId,
      method,
      scaleMismatch: !scaleAgrees(monitor, display),
    });
    remainingMonitors.splice(remainingMonitors.indexOf(monitor), 1);
    remainingDisplays.splice(remainingDisplays.indexOf(display), 1);
  };

  // 1. The anchor. Win32 puts the primary monitor at physical (0,0) by definition, and that is
  //    the same physical monitor Electron calls primary - so this pair needs no arithmetic and
  //    is unaffected by DPI. Taken first so it can never be consumed by a metrics match, which
  //    matters on a machine with two identical displays where one of them is primary.
  const primaryMonitor = remainingMonitors.find((entry) => entry.bounds[0] === 0 && entry.bounds[1] === 0);
  const primaryDisplay = remainingDisplays.find((entry) => entry.id === primaryDisplayId);
  if (primaryMonitor !== undefined && primaryDisplay !== undefined) {
    take(primaryMonitor, primaryDisplay, 'primary');
  }

  // 2. Unambiguous metrics, to a fixed point. A single pass would leave pairs on the table:
  //    resolving A can turn B's two candidates into one, so this repeats until a pass finds
  //    nothing. Bounded by the monitor count, since every pass that continues removes one.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const monitor of [...remainingMonitors]) {
      const candidates = remainingDisplays.filter((display) => metricsAgree(monitor, display));
      const only = candidates.length === 1 ? candidates[0] : undefined;
      if (only === undefined) continue;
      take(monitor, only, 'unique-metrics');
      progressed = true;
    }
  }

  // 3. Whatever is left is genuinely ambiguous - identical monitors - and ordering is the only
  //    thing left to separate them. Physical layout and DIP layout disagree about coordinates
  //    once DPI differs, but they preserve each other's *ordering* along an axis, so the nth
  //    remaining monitor from the left is the nth remaining display from the left.
  //
  //    Metrics are still required. Ordering is a tiebreak between equals, not a way to pair a
  //    1080p monitor with a 4K display because they happened to be the last two left.
  const monitorsByPosition = [...remainingMonitors].sort(
    (a, b) => a.bounds[0] - b.bounds[0] || a.bounds[1] - b.bounds[1],
  );
  const displaysByPosition = [...remainingDisplays].sort(
    (a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y,
  );
  for (let i = 0; i < monitorsByPosition.length; i += 1) {
    const monitor = monitorsByPosition[i];
    const display = displaysByPosition[i];
    if (monitor === undefined || display === undefined) break;
    if (!metricsAgree(monitor, display)) continue;
    take(monitor, display, 'ordering');
  }

  return { pairs, unpairedMonitors: [...remainingMonitors], unpairedDisplays: [...remainingDisplays] };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** The part of Electron's `screen` this service reads. */
export interface ScreenSource {
  getAllDisplays(): readonly PairableDisplay[];
  getPrimaryDisplay(): PairableDisplay;
}

/** One row of the monitor picker (#28: "แสดงจอครบทุกตัวพร้อม resolution และ scale"). */
export interface MonitorChoice {
  /** Windows device name - the value that goes in `configure.monitorId` and in config. */
  readonly id: string;
  /** Friendly name for a human to recognise the monitor by, e.g. `Dell AW3423DW`. */
  readonly label: string;
  /** Physical px. What the user thinks of as the monitor's resolution. */
  readonly width: number;
  readonly height: number;
  readonly scaleFactor: number;
  readonly primary: boolean;
}

export interface MonitorServiceOptions {
  readonly screen: ScreenSource;
  readonly logger?: Logger;
}

/**
 * Holds the current pairing and answers `which display is this frame from?`.
 *
 * **It does not send `listMonitors` itself**, and that is a correctness requirement rather than
 * a layering preference: `AckEvent` has no correlation id, replies are matched by `cmd` alone,
 * and two outstanding `listMonitors` would be genuinely ambiguous. The orchestrator already
 * makes that call as part of configuring the sidecar, so it pushes the result here via
 * {@link setMonitors} and there is only ever one asker.
 */
export class MonitorService {
  readonly #screen: ScreenSource;
  readonly #log: Logger;

  #monitors: readonly MonitorInfo[] = [];
  #pairing: MonitorPairing = { pairs: [], unpairedMonitors: [], unpairedDisplays: [] };

  constructor(options: MonitorServiceOptions) {
    this.#screen = options.screen;
    this.#log = (options.logger ?? nullLogger()).child('monitors');
  }

  get monitors(): readonly MonitorInfo[] {
    return this.#monitors;
  }

  get pairs(): readonly MonitorPair[] {
    return this.#pairing.pairs;
  }

  get pairing(): MonitorPairing {
    return this.#pairing;
  }

  /** Adopt a fresh `listMonitors` reply and re-pair. */
  setMonitors(monitors: readonly MonitorInfo[]): void {
    this.#monitors = [...monitors];
    this.#repair('listMonitors');
  }

  /**
   * Re-pair against the displays as they are now.
   *
   * Called when Electron reports a display added, removed or reconfigured. The monitor list is
   * left alone: only the sidecar can refresh that, and a stale monitor paired against fresh
   * displays simply comes back unpaired, which is reported rather than guessed at.
   */
  refreshDisplays(reason: string): void {
    this.#repair(reason);
  }

  /**
   * The display a frame from `monitorId` should be placed against.
   *
   * `undefined` means the pairing failed, and callers must **not** substitute the primary
   * display: that is precisely the bug #28 exists to fix, and it draws boxes confidently onto
   * the wrong screen with nothing in the log.
   */
  displayFor(monitorId: string): PairableDisplay | undefined {
    return this.#pairing.pairs.find((pair) => pair.monitor.id === monitorId)?.display;
  }

  /** The monitor whose Electron display has this id, if any. Used to map a picker choice back. */
  monitorForDisplay(displayId: number): MonitorInfo | undefined {
    return this.#pairing.pairs.find((pair) => pair.display.id === displayId)?.monitor;
  }

  /**
   * Rows for the picker UI, in left-to-right physical order.
   *
   * Only paired monitors appear. A monitor this process cannot place boxes on is not a monitor
   * the user can usefully choose, and offering it would promise something the app then fails to
   * deliver silently.
   */
  get choices(): readonly MonitorChoice[] {
    return [...this.#pairing.pairs]
      .sort((a, b) => a.monitor.bounds[0] - b.monitor.bounds[0] || a.monitor.bounds[1] - b.monitor.bounds[1])
      .map((pair) => ({
        id: pair.monitor.id,
        label: pair.display.label,
        width: pair.monitor.bounds[2],
        height: pair.monitor.bounds[3],
        scaleFactor: pair.display.scaleFactor,
        primary: pair.primary,
      }));
  }

  // -------------------------------------------------------------------------

  #repair(reason: string): void {
    const displays = this.#screen.getAllDisplays();
    const primaryId = this.#screen.getPrimaryDisplay().id;
    this.#pairing = pairMonitors(this.#monitors, displays, primaryId);

    this.#log.info('paired monitors to displays', {
      reason,
      monitors: this.#monitors.length,
      displays: displays.length,
      paired: this.#pairing.pairs.length,
      methods: this.#pairing.pairs.map((pair) => `${pair.monitor.id}=${pair.method}`),
    });

    // Invariant 4. Each of these means some part of the desktop the app cannot serve correctly,
    // and none of them stops it running - so the log is the only place they can surface.
    for (const monitor of this.#pairing.unpairedMonitors) {
      this.#log.warn(
        'could not match a monitor to any display; boxes cannot be placed on it, and it is '
          + 'deliberately not being paired to the primary display as a fallback',
        { monitorId: monitor.id, bounds: monitor.bounds, scale: monitor.scale },
      );
    }
    for (const pair of this.#pairing.pairs) {
      if (!pair.scaleMismatch) continue;
      this.#log.warn('Win32 and Chromium disagree about this display scale; one view is stale', {
        monitorId: pair.monitor.id,
        win32Scale: pair.monitor.scale,
        chromiumScaleFactor: pair.display.scaleFactor,
      });
    }
  }
}
