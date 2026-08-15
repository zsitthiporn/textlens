import { describe, expect, it } from 'vitest';

import {
  WINDOW_KINDS,
  isWindowKind,
  parseWindowKind,
  windowKindQuery,
  type WindowKind,
} from '../../src/shared/types.js';

describe('window kind round trip (main -> renderer)', () => {
  it('survives the trip through a query string for every kind we serve', () => {
    for (const kind of WINDOW_KINDS) {
      const search = `?${new URLSearchParams(windowKindQuery(kind)).toString()}`;
      expect(parseWindowKind(search)).toBe(kind);
    }
  });

  it('covers the full WindowKind union', () => {
    // If someone adds a kind to the type but forgets WINDOW_KINDS, this stops compiling.
    const exhaustive: Record<WindowKind, true> = {
      overlay: true,
      'region-picker': true,
      settings: true,
    };
    expect([...WINDOW_KINDS].sort()).toEqual(Object.keys(exhaustive).sort());
  });
});

describe('parseWindowKind', () => {
  it('returns null rather than guessing when the parameter is absent', () => {
    expect(parseWindowKind('')).toBeNull();
    expect(parseWindowKind('?')).toBeNull();
    expect(parseWindowKind('?other=overlay')).toBeNull();
  });

  it('rejects values that are not a kind we serve', () => {
    expect(parseWindowKind('?kind=Overlay')).toBeNull();
    expect(parseWindowKind('?kind=region_picker')).toBeNull();
    expect(parseWindowKind('?kind=__proto__')).toBeNull();
    expect(parseWindowKind('?kind=')).toBeNull();
  });

  it('decodes a percent-encoded kind', () => {
    expect(parseWindowKind('?kind=region%2Dpicker')).toBe('region-picker');
  });

  it('ignores unrelated parameters around it', () => {
    expect(parseWindowKind('?a=1&kind=settings&b=2')).toBe('settings');
  });
});

describe('isWindowKind', () => {
  it('accepts only the declared kinds', () => {
    expect(isWindowKind('overlay')).toBe(true);
    expect(isWindowKind('settings')).toBe(true);
  });

  it('rejects non-string input instead of coercing it', () => {
    expect(isWindowKind(undefined)).toBe(false);
    expect(isWindowKind(null)).toBe(false);
    expect(isWindowKind(0)).toBe(false);
    expect(isWindowKind(['overlay'])).toBe(false);
    expect(isWindowKind({ toString: () => 'overlay' })).toBe(false);
  });
});
