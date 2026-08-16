/**
 * What the status banner shows, decided without a DOM (issue M10-02 / #41).
 *
 * Split out of `overlay.ts` for the same reason every other decision in this directory is: these
 * tests run in plain Node (`vitest.config.ts` is `environment: 'node'` and stays that way), so the
 * rules about *what the user reads* are checkable in a unit test and only the element-poking is
 * left to a real Chromium.
 *
 * ## Two budgets, not one
 *
 * The banner sits over the top of whatever the user is actually looking at, and #41's criterion is
 * that it must not cover the reading area. The stylesheet gives cause and remedy a line each, so
 * they do not compete for the same space and a single combined budget would be wrong in both
 * directions - it clipped a short cause's remedy on a real run, losing the only sentence the user
 * could act on while the line it shared was half empty.
 *
 * Each is therefore capped on its own, against the narrowest display this app is meant to run on:
 * the banner is 70% of the window, so on 1280 CSS px that is ~900px, which fits roughly 120
 * characters of the 15px cause and roughly 140 of the 13px remedy over two lines each. Past that
 * the banner starts growing down the screen, which is the thing being avoided.
 */

import type { OverlayAlertSeverity, OverlayStatusMessage } from './contract.js';

export const MAX_CAUSE_CHARS = 120;
export const MAX_REMEDY_CHARS = 140;

export interface BannerView {
  readonly visible: boolean;
  readonly severity: OverlayAlertSeverity | null;
  readonly cause: string;
  readonly remedy: string;
}

const HIDDEN: BannerView = { visible: false, severity: null, cause: '', remedy: '' };

/**
 * Turn a status message into what the banner should display.
 *
 * `null`, and an alert-less message, both mean hidden. They are distinct on the wire - one is "no
 * message has arrived yet", the other is "the main process says everything is fine" - and they
 * look the same here on purpose: an overlay that has not heard anything has nothing to warn about
 * either.
 */
export function toBannerView(message: OverlayStatusMessage | null): BannerView {
  const alert = message?.alert ?? null;
  if (alert === null) return HIDDEN;

  const cause = alert.cause.trim();
  if (cause === '') return HIDDEN;

  return {
    visible: true,
    severity: alert.severity,
    cause: truncate(cause, MAX_CAUSE_CHARS),
    remedy: truncate(alert.remedy.trim(), MAX_REMEDY_CHARS),
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
