/**
 * Neutral generated English sentences for the load run (spike S3).
 *
 * Deliberately synthetic and impersonal: the load harness fires ~1000 real requests at a public
 * endpoint, and none of them may carry anything from the user's screen or machine. Every sentence
 * is assembled from the fixed vocabulary below plus the request sequence number, which also makes
 * every string unique - a repeated string could be served from an edge cache somewhere and would
 * quietly turn a latency measurement into a measurement of somebody's CDN.
 */

const SUBJECTS = [
  'the courier', 'the engineer', 'the survey team', 'the night shift', 'the archivist',
  'the second crew', 'the relay station', 'the field office', 'the supply convoy', 'the analyst',
];

const VERBS = [
  'reported', 'confirmed', 'delayed', 'requested', 'reviewed',
  'scheduled', 'cancelled', 'approved', 'forwarded', 'logged',
];

const OBJECTS = [
  'the shipment manifest', 'the weather advisory', 'the maintenance window', 'the inventory count',
  'the transit schedule', 'the calibration report', 'the storage allocation', 'the access request',
  'the quarterly summary', 'the equipment transfer',
];

const TAILS = [
  'before the deadline', 'without further comment', 'for the following week', 'under the new policy',
  'at the eastern depot', 'pending confirmation', 'in the morning briefing', 'across all districts',
];

/** A unique, neutral sentence. `n` is the global string counter, so no two are ever identical. */
export function sentence(n) {
  const s = SUBJECTS[n % SUBJECTS.length];
  const v = VERBS[Math.floor(n / 3) % VERBS.length];
  const o = OBJECTS[Math.floor(n / 7) % OBJECTS.length];
  const t = TAILS[Math.floor(n / 11) % TAILS.length];
  return `${s} ${v} ${o} ${t}, item ${String(n)}.`;
}

/** Thai script range. Used to prove a 200 really carried a translation. */
export const THAI = /[฀-๿]/u;
