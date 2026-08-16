/**
 * M6-01 (#28). Like `coordinates.test.ts`, this suite is written against hardware that is not
 * attached to the machine it runs on, and for the same reason: all three displays here are
 * scaleFactor 1.0, so DIP and physical coordinates are numerically identical and *every*
 * pairing rule anyone could write passes every observation that can be made locally.
 *
 * The load-bearing test is `mixed DPI` - a 4K display at 200% followed by a 1080p at 100%,
 * where the second display's DIP origin (1920) is not its physical origin (3840). Pairing by
 * origin equality passes on this machine and fails there, which is exactly the class of bug the
 * design doc says the reference project shipped.
 *
 * The `\\\\.\\DISPLAY1` literals are doubled twice over: once for JS string escaping and once
 * because the Windows device name itself contains backslashes.
 */

import { describe, expect, it, vi } from 'vitest';

import { MonitorService, pairMonitors, type PairableDisplay } from '../../src/main/services/monitor-service.js';
import type { MonitorInfo } from '../../src/shared/protocol.js';

function monitor(id: string, x: number, y: number, width: number, height: number, scale: number): MonitorInfo {
  return { id, scale, bounds: [x, y, width, height] };
}

/** `bounds` and `size` are DIP; `width`/`height` here are the DIP size, not the physical one. */
function display(
  id: number,
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
  scaleFactor: number,
): PairableDisplay {
  return {
    id,
    label,
    bounds: { x, y, width, height },
    size: { width, height },
    scaleFactor,
  };
}

describe('pairMonitors', () => {
  it('pairs the single display on a one-monitor machine', () => {
    const result = pairMonitors(
      [monitor('\\\\.\\DISPLAY1', 0, 0, 1920, 1080, 1)],
      [display(11, 'Acme 24', 0, 0, 1920, 1080, 1)],
      11,
    );

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]?.monitor.id).toBe('\\\\.\\DISPLAY1');
    expect(result.pairs[0]?.display.id).toBe(11);
    expect(result.pairs[0]?.primary).toBe(true);
    expect(result.pairs[0]?.method).toBe('primary');
    expect(result.unpairedMonitors).toEqual([]);
    expect(result.unpairedDisplays).toEqual([]);
  });

  /**
   * The test this file exists for.
   *
   * Display A: 3840x2160 at 200%, physical (0,0)  -> DIP (0,0),    DIP size 1920x1080
   * Display B: 1920x1080 at 100%, physical (3840,0) -> DIP (1920,0), DIP size 1920x1080
   *
   * Note what the two displays have in common in DIP space: *identical* bounds width and
   * height. Anything that pairs on DIP size alone cannot tell them apart, and anything that
   * pairs on origin sends B's frames to A. Only scale plus physical size separates them.
   */
  it('pairs across mixed DPI, where a DIP origin is not the physical origin over the scale', () => {
    const monitors = [
      monitor('\\\\.\\DISPLAY1', 0, 0, 3840, 2160, 2),
      monitor('\\\\.\\DISPLAY2', 3840, 0, 1920, 1080, 1),
    ];
    const displays = [
      display(11, '4K panel', 0, 0, 1920, 1080, 2),
      display(22, '1080p panel', 1920, 0, 1920, 1080, 1),
    ];

    const result = pairMonitors(monitors, displays, 11);

    const byMonitor = new Map(result.pairs.map((pair) => [pair.monitor.id, pair.display.id]));
    expect(byMonitor.get('\\\\.\\DISPLAY1')).toBe(11);
    expect(byMonitor.get('\\\\.\\DISPLAY2')).toBe(22);
    expect(result.unpairedMonitors).toEqual([]);

    // The number that makes origin-matching wrong, asserted directly so the fixture cannot
    // drift into one where physical/scale happens to equal the DIP origin.
    expect(displays[1]?.bounds.x).toBe(1920);
    expect(monitors[1]?.bounds[0]).toBe(3840);
  });

  it('pairs a display to the left of primary, whose DIP origin is negative', () => {
    const result = pairMonitors(
      [monitor('\\\\.\\DISPLAY1', 0, 0, 3440, 1440, 1), monitor('\\\\.\\DISPLAY2', -1080, 6, 1080, 1920, 1)],
      [display(11, 'ultrawide', 0, 0, 3440, 1440, 1), display(22, 'portrait', -1080, 6, 1080, 1920, 1)],
      11,
    );

    const byMonitor = new Map(result.pairs.map((pair) => [pair.monitor.id, pair.display.id]));
    expect(byMonitor.get('\\\\.\\DISPLAY2')).toBe(22);
    expect(result.unpairedMonitors).toEqual([]);
  });

  it('tolerates the rounding Windows does when it derives a DIP size', () => {
    // 2560 / 1.5 = 1706.67, which Windows reports as 1707; 1707 * 1.5 = 2560.5. Exact
    // equality rejects this pair, and a real 1440p display at 150% is not exotic hardware.
    //
    // Primary is a display neither list mentions, so the anchor cannot resolve this and the
    // size arithmetic is the only thing that can. Without that, the pair is the anchor's and
    // the tolerance is never exercised at all - which is what an earlier version of this test
    // did, and a mutation run caught.
    const result = pairMonitors(
      [monitor('\\\\.\\DISPLAY2', 1920, 0, 2560, 1440, 1.5)],
      [display(11, '1440p at 150%', 1920, 0, 1707, 960, 1.5)],
      99,
    );

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]?.method).toBe('unique-metrics');
    expect(result.unpairedMonitors).toEqual([]);
  });

  /**
   * The same mixed-DPI machine as above, but with the primary anchor deliberately removed from
   * play: the primary display is a third monitor the sidecar did not enumerate, so neither
   * pair can be made by position and the scale-aware size comparison has to carry both.
   *
   * This is the test that fails when `size x scaleFactor` loses its scale factor. The anchored
   * version passes that mutation, because pairing the primary by position quietly resolves the
   * only remaining ambiguity for free.
   */
  it('pairs across mixed DPI with no primary anchor available, on metrics alone', () => {
    const result = pairMonitors(
      [
        monitor('\\\\.\\DISPLAY2', 1920, 0, 3840, 2160, 2),
        monitor('\\\\.\\DISPLAY3', 5760, 0, 1920, 1080, 1),
      ],
      [
        display(22, '4K at 200%', 1920, 0, 1920, 1080, 2),
        display(33, '1080p at 100%', 3840, 0, 1920, 1080, 1),
      ],
      99,
    );

    const byMonitor = new Map(result.pairs.map((pair) => [pair.monitor.id, pair.display.id]));
    expect(byMonitor.get('\\\\.\\DISPLAY2')).toBe(22);
    expect(byMonitor.get('\\\\.\\DISPLAY3')).toBe(33);
    expect(result.pairs.every((pair) => pair.method === 'unique-metrics')).toBe(true);
    expect(result.unpairedMonitors).toEqual([]);
  });

  it('separates two displays of the same size by their scale factor', () => {
    const result = pairMonitors(
      [monitor('\\\\.\\DISPLAY1', 0, 0, 1920, 1080, 1), monitor('\\\\.\\DISPLAY2', 1920, 0, 3840, 2160, 2)],
      [display(11, 'hidpi', 1920, 0, 1920, 1080, 2), display(22, 'lodpi', 0, 0, 1920, 1080, 1)],
      22,
    );

    const byMonitor = new Map(result.pairs.map((pair) => [pair.monitor.id, pair.display.id]));
    expect(byMonitor.get('\\\\.\\DISPLAY1')).toBe(22);
    expect(byMonitor.get('\\\\.\\DISPLAY2')).toBe(11);
  });

  it('breaks a tie between two identical monitors by their position on the same axis', () => {
    const result = pairMonitors(
      [monitor('\\\\.\\DISPLAY2', 1920, 0, 1920, 1080, 1), monitor('\\\\.\\DISPLAY3', 3840, 0, 1920, 1080, 1)],
      [display(33, 'right twin', 3840, 0, 1920, 1080, 1), display(22, 'left twin', 1920, 0, 1920, 1080, 1)],
      // Primary is neither of them - it is a third display the sidecar did not report, which
      // keeps the anchor out of this test entirely.
      99,
    );

    const byMonitor = new Map(result.pairs.map((pair) => [pair.monitor.id, pair.display.id]));
    expect(byMonitor.get('\\\\.\\DISPLAY2')).toBe(22);
    expect(byMonitor.get('\\\\.\\DISPLAY3')).toBe(33);
    expect(result.pairs.every((pair) => pair.method === 'ordering')).toBe(true);
  });

  it('anchors the primary before metrics, so an identical twin cannot steal it', () => {
    // Two identical 1920x1080 monitors. Metrics alone cannot tell them apart, and the wrong
    // assignment here is invisible on screen until the user picks the other one.
    const result = pairMonitors(
      [monitor('\\\\.\\DISPLAY2', -1920, 0, 1920, 1080, 1), monitor('\\\\.\\DISPLAY1', 0, 0, 1920, 1080, 1)],
      [display(11, 'primary twin', 0, 0, 1920, 1080, 1), display(22, 'left twin', -1920, 0, 1920, 1080, 1)],
      11,
    );

    const primaryPair = result.pairs.find((pair) => pair.primary);
    expect(primaryPair?.monitor.id).toBe('\\\\.\\DISPLAY1');
    expect(primaryPair?.method).toBe('primary');
    expect(result.pairs.find((pair) => pair.monitor.id === '\\\\.\\DISPLAY2')?.display.id).toBe(22);
  });

  it('leaves a monitor unpaired rather than falling back to the primary display', () => {
    // The display was unplugged from Chromium's point of view but the sidecar's list is stale.
    // Pairing it to the primary would draw that monitor's boxes on the wrong screen - the exact
    // behaviour #28 exists to remove - so it must come back unpaired.
    const result = pairMonitors(
      [monitor('\\\\.\\DISPLAY1', 0, 0, 1920, 1080, 1), monitor('\\\\.\\DISPLAY2', 1920, 0, 2560, 1440, 1)],
      [display(11, 'primary', 0, 0, 1920, 1080, 1)],
      11,
    );

    expect(result.pairs).toHaveLength(1);
    expect(result.unpairedMonitors.map((entry) => entry.id)).toEqual(['\\\\.\\DISPLAY2']);
    expect(result.pairs.every((pair) => pair.display.id === 11)).toBe(true);
  });

  it('reports a display the sidecar has not enumerated as unpaired', () => {
    const result = pairMonitors(
      [monitor('\\\\.\\DISPLAY1', 0, 0, 1920, 1080, 1)],
      [display(11, 'primary', 0, 0, 1920, 1080, 1), display(22, 'new arrival', 1920, 0, 2560, 1440, 1)],
      11,
    );

    expect(result.unpairedDisplays.map((entry) => entry.id)).toEqual([22]);
    expect(result.unpairedMonitors).toEqual([]);
  });

  it('flags a scale disagreement between Win32 and Chromium without refusing the pair', () => {
    // Only the primary anchor can produce this: it matches on position, not on metrics, so it
    // survives a disagreement that would have prevented a metrics pair from forming at all.
    const result = pairMonitors(
      [monitor('\\\\.\\DISPLAY1', 0, 0, 3840, 2160, 1.5)],
      [display(11, 'reconfigured', 0, 0, 1920, 1080, 2)],
      11,
    );

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]?.scaleMismatch).toBe(true);
  });

  it('returns empty results for an empty machine rather than throwing', () => {
    expect(pairMonitors([], [], 0)).toEqual({ pairs: [], unpairedMonitors: [], unpairedDisplays: [] });
  });
});

describe('MonitorService', () => {
  function service(displays: readonly PairableDisplay[], primaryId: number) {
    const warn = vi.fn();
    const instance = new MonitorService({
      screen: {
        getAllDisplays: () => displays,
        getPrimaryDisplay: () => displays.find((entry) => entry.id === primaryId) ?? displays[0]!,
      },
      logger: {
        child: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: vi.fn() }),
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
      } as never,
    });
    return { instance, warn };
  }

  it('answers displayFor with the paired display, not the primary one', () => {
    const displays = [
      display(11, '4K panel', 0, 0, 1920, 1080, 2),
      display(22, '1080p panel', 1920, 0, 1920, 1080, 1),
    ];
    const { instance } = service(displays, 11);
    instance.setMonitors([
      monitor('\\\\.\\DISPLAY1', 0, 0, 3840, 2160, 2),
      monitor('\\\\.\\DISPLAY2', 3840, 0, 1920, 1080, 1),
    ]);

    expect(instance.displayFor('\\\\.\\DISPLAY2')?.id).toBe(22);
    expect(instance.displayFor('\\\\.\\DISPLAY1')?.id).toBe(11);
  });

  it('returns undefined for an unpaired monitor and says so in the log', () => {
    const { instance, warn } = service([display(11, 'primary', 0, 0, 1920, 1080, 1)], 11);
    instance.setMonitors([
      monitor('\\\\.\\DISPLAY1', 0, 0, 1920, 1080, 1),
      monitor('\\\\.\\DISPLAY2', 1920, 0, 2560, 1440, 1),
    ]);

    expect(instance.displayFor('\\\\.\\DISPLAY2')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('lists choices left to right with physical resolution and scale', () => {
    const displays = [
      display(11, 'ultrawide', 0, 0, 3440, 1440, 1),
      display(22, 'portrait', -1080, 6, 1080, 1920, 1),
    ];
    const { instance } = service(displays, 11);
    instance.setMonitors([
      monitor('\\\\.\\DISPLAY1', 0, 0, 3440, 1440, 1),
      monitor('\\\\.\\DISPLAY2', -1080, 6, 1080, 1920, 1),
    ]);

    expect(instance.choices).toEqual([
      { id: '\\\\.\\DISPLAY2', label: 'portrait', width: 1080, height: 1920, scaleFactor: 1, primary: false },
      { id: '\\\\.\\DISPLAY1', label: 'ultrawide', width: 3440, height: 1440, scaleFactor: 1, primary: true },
    ]);
  });

  it('reports physical resolution in choices, not the DIP size the display reports', () => {
    // At 200% these differ by a factor of two, and the DIP number is the one a user would read
    // as wrong: they bought a 4K monitor, not a 1920x1080 one.
    const { instance } = service([display(11, '4K panel', 0, 0, 1920, 1080, 2)], 11);
    instance.setMonitors([monitor('\\\\.\\DISPLAY1', 0, 0, 3840, 2160, 2)]);

    expect(instance.choices[0]?.width).toBe(3840);
    expect(instance.choices[0]?.height).toBe(2160);
    expect(instance.choices[0]?.scaleFactor).toBe(2);
  });

  it('re-pairs when a display is unplugged, dropping the stale pair', () => {
    let displays = [
      display(11, 'primary', 0, 0, 1920, 1080, 1),
      display(22, 'secondary', 1920, 0, 2560, 1440, 1),
    ];
    const warn = vi.fn();
    const instance = new MonitorService({
      screen: {
        getAllDisplays: () => displays,
        getPrimaryDisplay: () => displays[0]!,
      },
      logger: {
        child: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: vi.fn() }),
      } as never,
    });
    instance.setMonitors([
      monitor('\\\\.\\DISPLAY1', 0, 0, 1920, 1080, 1),
      monitor('\\\\.\\DISPLAY2', 1920, 0, 2560, 1440, 1),
    ]);
    expect(instance.displayFor('\\\\.\\DISPLAY2')?.id).toBe(22);

    displays = [display(11, 'primary', 0, 0, 1920, 1080, 1)];
    instance.refreshDisplays('display-removed');

    expect(instance.displayFor('\\\\.\\DISPLAY2')).toBeUndefined();
    expect(instance.choices.map((choice) => choice.id)).toEqual(['\\\\.\\DISPLAY1']);
  });
});
