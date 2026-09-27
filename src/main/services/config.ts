/**
 * Two-layer configuration (issue M9-01 / #38, features ST1-ST3).
 *
 * Layer 1 is `DEFAULT_CONFIG`, compiled into the app. Layer 2 is a JSON file in `userData`
 * holding **only what the user changed**. The effective config is layer 2 deep-merged over
 * layer 1, validated as a whole before it is allowed to become current.
 *
 * ## Why the file stores the override and not the merged result
 *
 * Writing the whole merged object would freeze every default at the moment the user first
 * changed anything unrelated. Ship a better `diffThreshold` in the next version and any user
 * who once edited an interval never receives it - their file already answers for every field.
 * Storing the diff means a default stays a default until it is deliberately overridden.
 *
 * ## Nothing here can stop the app starting
 *
 * A missing file, an unreadable one, malformed JSON and a value that fails the schema are four
 * different problems and all four resolve the same way: keep the last-known-good config, record
 * a {@link ConfigIssue}, and carry on. That is the issue's headline requirement - "config พัง
 * ต้องไม่ทำให้แอปเปิดไม่ขึ้น" - and CLAUDE.md invariant 4 supplies the other half: the app
 * carries on, but it never carries on *silently*. Every fallback leaves an entry in
 * {@link ConfigService.issues} for the settings window to show (#39).
 *
 * ## Not here
 *
 * No `fs.watch`. ST3's "hot reload" is defined by this issue's acceptance criteria as
 * subscribers being told when a value changes, which {@link ConfigService.set} does;
 * re-reading the file behind the user's back is a separate behaviour with its own failure
 * modes (editors write via rename, half-written files parse as truncated JSON) and no issue
 * asking for it. {@link ConfigService.reload} exists for a caller that wants it explicitly.
 *
 * ## Never overwrite what we could not load (#75)
 *
 * `#override` stays `{}` when a load fails (the paragraph above), which means the very next
 * `set()` writes an override containing only that one change - atomically renamed over whatever
 * was on disk, no matter how it got there. A file with one bad field, or a BOM plus a trailing
 * comma, was one unrelated settings change away from silent, total loss: the old content was
 * never read into `#override`, so nothing held it once the rename completed. `#write` now copies
 * the file it is about to replace to a timestamped sibling, once per failed load, before it
 * writes anything at all - and if that copy cannot be made, it does not write, because writing
 * without a copy first is exactly the data-loss window this closes.
 *
 * This module imports no Electron: it is handed a path, so it stays importable from a plain
 * Node test process like every other file in `services/`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_CONFIG,
  configOverrideSchema,
  configSchema,
  toFieldErrors,
  type Config,
  type ConfigFieldError,
  type ConfigOverride,
} from '../../shared/config-schema.js';
import { nullLogger, type Logger } from './logger.js';

/**
 * Why the config on disk was not fully applied.
 *
 * `missing` is deliberately absent: no file is the normal first-run state, not a problem.
 */
export type ConfigIssueKind =
  /** The file exists but could not be read (permissions, it is a directory, a bad path). */
  | 'unreadable'
  /** The file was read but is not JSON, or is not a JSON object. */
  | 'malformed'
  /** The file parsed but one or more fields failed the schema. */
  | 'invalid'
  /** A change was applied in memory but could not be written back, so it will not be remembered. */
  | 'not-persisted';

/** A problem worth showing the user (design doc section 7: "แจ้งใน settings ว่า field ไหนไม่ผ่าน"). */
export interface ConfigIssue {
  readonly kind: ConfigIssueKind;
  readonly message: string;
  /** Per-field detail. Populated for `invalid`; empty otherwise. */
  readonly fields: readonly ConfigFieldError[];
}

export type ConfigListener = (current: Config, previous: Config) => void;

/**
 * Told whenever {@link ConfigService.issues} changes, with the new list.
 *
 * Separate from {@link ConfigListener} because the two fire on opposite events: a config listener
 * runs when a *value* changed, and the case this exists for is a value that changed successfully
 * in memory and then failed to reach the disk - same `current`, new issue.
 *
 * ## The decision this settles (#39)
 *
 * `not-persisted` was unreachable. `index.ts` read `config.issues` exactly once, at boot, so a
 * failed write later in the session - the region picker's, or the settings window's - reached the
 * log and stopped there. A previous worker left it deliberately, because closing it needs a
 * decision about *when* `issues` is re-read, and re-reading on a timer or on every `current` access
 * would both be guesses.
 *
 * The decision: the service announces its own issues, the same way it announces its own values.
 * Nothing polls, nothing re-reads, and every route that can add an issue - a reload, a failed write
 * from any caller - publishes through one place. That is what makes "เขียนดิสก์ไม่ได้ → ค่ายังมีผล
 * + แจ้งผู้ใช้ว่าจะไม่ถูกจำ" true of a running app rather than only of a launch.
 */
export type ConfigIssueListener = (issues: readonly ConfigIssue[]) => void;

export interface ConfigServiceOptions {
  /** Absolute path to the user override file, e.g. `<userData>/config.json`. */
  readonly filePath: string;
  readonly logger?: Logger;
}

/** What {@link ConfigService.set} did. Applying and persisting can succeed independently. */
export interface ConfigSetResult {
  /** False when the change failed validation, in which case nothing changed at all. */
  readonly applied: boolean;
  /** False when the change is live for this session but could not be written to disk. */
  readonly persisted: boolean;
  /** Populated when `applied` is false. */
  readonly errors: readonly ConfigFieldError[];
}

export class ConfigService {
  readonly #filePath: string;
  readonly #log: Logger;
  readonly #listeners = new Set<ConfigListener>();
  readonly #issueListeners = new Set<ConfigIssueListener>();

  #current: Config = DEFAULT_CONFIG;
  /** The user layer as last validated. What gets written back, and what `set` merges into. */
  #override: ConfigOverride = {};
  #issues: ConfigIssue[] = [];
  /**
   * True whenever the most recent {@link reload} could not use the file on disk - `invalid`,
   * `malformed`, or `unreadable` - and no write has preserved a copy of it yet (#75).
   *
   * This is what makes `#write` stop and copy the original before it replaces it. It clears the
   * moment that copy succeeds, not the moment the following write succeeds, so a write that then
   * fails for an unrelated reason (disk full) does not trigger a second, needless copy attempt
   * next time. And it is set again by a *later* failed reload even if an earlier one already
   * cleared it - the rule is "the most recent load failed", not "any load ever failed", which is
   * why a good load resets it (rule 5) and a first run with no file at all never sets it (there
   * is nothing to protect from being overwritten).
   */
  #preservePending = false;

  private constructor(options: ConfigServiceOptions) {
    this.#filePath = options.filePath;
    this.#log = (options.logger ?? nullLogger()).child('config');
  }

  /** Construct and perform the first read. Never rejects on a bad config - see the module doc. */
  static async load(options: ConfigServiceOptions): Promise<ConfigService> {
    const service = new ConfigService(options);
    await service.reload();
    return service;
  }

  /** The effective config: layer 2 over layer 1. Frozen by the schema's `.readonly()`. */
  get current(): Config {
    return this.#current;
  }

  /** Only the fields the user has overridden. */
  get override(): ConfigOverride {
    return this.#override;
  }

  get filePath(): string {
    return this.#filePath;
  }

  /** Everything that went wrong on the last load or write. Empty is the healthy state. */
  get issues(): readonly ConfigIssue[] {
    return this.#issues;
  }

  /**
   * Subscribe to changes. Returns an unsubscribe function, matching `SidecarClient.on`.
   *
   * Not called on subscribe: a caller already has {@link current}, and an immediate
   * synthetic notification would make "the config changed" indistinguishable from "I have
   * just started", which is exactly the distinction a subscriber that reconfigures the
   * sidecar needs to make.
   */
  subscribe(listener: ConfigListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Subscribe to {@link issues} changing. Returns an unsubscribe, like {@link subscribe}.
   *
   * Not called on subscribe, for the same reason {@link subscribe} is not: a caller already has
   * the getter, and the one caller that matters (`index.ts`) publishes the boot issues explicitly
   * before subscribing, so a synthetic first notification would only duplicate it.
   */
  subscribeIssues(listener: ConfigIssueListener): () => void {
    this.#issueListeners.add(listener);
    return () => {
      this.#issueListeners.delete(listener);
    };
  }

  /**
   * Re-read the file and apply it. Safe to call repeatedly.
   *
   * On any failure the current config is left exactly as it was, which on first load means
   * the defaults and on a later call means the last good config - "ไม่ apply ทั้งก้อน".
   */
  async reload(): Promise<void> {
    const issues: ConfigIssue[] = [];
    const raw = await this.#read(issues);

    if (raw !== undefined) {
      const parsed = configOverrideSchema.safeParse(raw);
      if (parsed.success) {
        const merged = configSchema.safeParse(mergeDeep(DEFAULT_CONFIG, parsed.data));
        if (merged.success) {
          this.#override = parsed.data;
          this.#preservePending = false;
          this.#setIssues(issues);
          this.#commit(merged.data);
          return;
        }
        // Defaults are valid and every override field was just validated, so reaching here
        // means the two disagree about something a single field cannot express. Reported
        // rather than assumed impossible.
        issues.push(this.#invalidIssue(merged.error, 'merged config failed validation'));
      } else {
        issues.push(this.#invalidIssue(parsed.error, 'config file has invalid values'));
      }
    }

    // Every branch above that did not already return pushed an issue, except "no file at all"
    // (`raw` is `undefined` with nothing pushed) - the one non-problem (module doc, "missing is
    // deliberately absent"). Only a genuine failure arms the preserve-before-write guard; a first
    // run must not try to copy a file that was never there.
    this.#preservePending = issues.length > 0;
    this.#setIssues(issues);
  }

  /**
   * Apply a change, then try to remember it.
   *
   * In that order, and the order is the requirement: a change that cannot be written to disk
   * still takes effect for this session and the user is told it will not be remembered
   * ("เขียนดิสก์ไม่ได้ → ค่ายังมีผลใน session + แจ้งผู้ใช้ว่าจะไม่ถูกจำ"). Refusing the change
   * because the disk is read-only would be the app choosing the less useful failure.
   */
  async set(change: ConfigOverride): Promise<ConfigSetResult> {
    const candidateOverride = configOverrideSchema.safeParse(mergeDeep(this.#override, change));
    if (!candidateOverride.success) {
      const errors = toFieldErrors(candidateOverride.error);
      this.#log.warn('rejected a config change', { fields: errors });
      return { applied: false, persisted: false, errors };
    }

    const merged = configSchema.safeParse(mergeDeep(DEFAULT_CONFIG, candidateOverride.data));
    if (!merged.success) {
      const errors = toFieldErrors(merged.error);
      this.#log.warn('rejected a config change', { fields: errors });
      return { applied: false, persisted: false, errors };
    }

    this.#override = candidateOverride.data;
    this.#commit(merged.data);

    const persisted = await this.#write(candidateOverride.data);
    return { applied: true, persisted, errors: [] };
  }

  // -------------------------------------------------------------------------

  /**
   * Read and JSON-parse the override file.
   *
   * Returns `undefined` for "there is nothing usable here", having pushed an issue unless the
   * file simply does not exist - which is the ordinary first run and not a problem to report.
   */
  async #read(issues: ConfigIssue[]): Promise<unknown> {
    let text: string;
    try {
      text = await fs.readFile(this.#filePath, 'utf8');
    } catch (error) {
      if (isNotFound(error)) {
        this.#log.info('no user config; using defaults', { filePath: this.#filePath });
        return undefined;
      }
      const message = describeError(error);
      this.#log.error('could not read the config file; using defaults', { filePath: this.#filePath, message });
      issues.push({ kind: 'unreadable', message, fields: [] });
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripBom(text)) as unknown;
    } catch (error) {
      const message = describeError(error);
      this.#log.error('config file is not valid JSON; using defaults', { filePath: this.#filePath, message });
      issues.push({ kind: 'malformed', message, fields: [] });
      return undefined;
    }

    // `null` and `[1,2]` are both valid JSON and neither is a config. Caught here so the
    // schema layer only ever sees something object-shaped and its errors stay about fields.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      const message = 'config file must contain a JSON object';
      this.#log.error('config file is not a JSON object; using defaults', { filePath: this.#filePath });
      issues.push({ kind: 'malformed', message, fields: [] });
      return undefined;
    }

    return parsed;
  }

  /**
   * Write the override file atomically: a temp file in the same directory, then a rename.
   *
   * A plain write that is interrupted leaves a truncated file, which comes back on the next
   * launch as "malformed JSON" and loses every setting the user had. `rename` within one
   * filesystem is atomic, so the file is either the old one or the new one.
   *
   * If the last {@link reload} could not use this file, the first call here since then copies it
   * to a sibling before touching it at all (#75) - see `#preservePending` above. A copy that fails
   * cancels the write outright, on the theory that a file we could not load and
   * could not back up is not safe to erase on a guess.
   *
   * @returns whether it reached the disk. False is reported, never thrown - the value is
   *          already live by the time this runs.
   */
  async #write(override: ConfigOverride): Promise<boolean> {
    if (this.#preservePending) {
      const preserved = await this.#preserveOriginal();
      if (preserved.outcome === 'failed') {
        this.#log.error('could not preserve the config file that failed to load; refusing to overwrite it', {
          filePath: this.#filePath,
          message: preserved.message,
        });
        this.#recordNotPersisted(
          `your previous settings file could not be safely backed up (${preserved.message}), `
            + 'so this change was kept for this session only and not saved',
        );
        return false;
      }

      this.#preservePending = false;
      if (preserved.outcome === 'preserved') {
        this.#log.warn('preserved a config file that failed to load before overwriting it', {
          filePath: this.#filePath,
          preservedPath: preserved.path,
        });
        this.#notePreserved(preserved.path);
      }
      // preserved.outcome === 'nothing-to-preserve': the file the last reload failed on is
      // already gone by the time we got here (the user deleted it, or an editor's rename-based
      // save replaced it). There is nothing left to copy, and refusing to write from here on
      // would trap a user who followed the tray's own remedy ("delete the file to start from
      // defaults", error-reporter.ts) into a permanent, unexplained "not saved".
    }

    const temp = `${this.#filePath}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.#filePath), { recursive: true });
      await fs.writeFile(temp, `${JSON.stringify(override, null, 2)}\n`, 'utf8');
      await fs.rename(temp, this.#filePath);
      // A write that succeeded is the only evidence that a previous one's failure is over, so it
      // is what clears the report. Without this, a user who fixed the permissions and saved again
      // would be told for the rest of the session that their settings are not being remembered -
      // while they were being remembered.
      this.#setIssues(this.#issues.filter((issue) => issue.kind !== 'not-persisted'));
      return true;
    } catch (error) {
      const message = describeError(error);
      this.#log.error('config change applied but could not be saved; it will be lost on restart', {
        filePath: this.#filePath,
        message,
      });
      this.#recordNotPersisted(message);
      // Best effort - a leftover temp file is untidy, not harmful, and the write already failed.
      await fs.rm(temp, { force: true }).catch(() => undefined);
      return false;
    }
  }

  /**
   * Copy the file the last {@link reload} could not use, byte-for-byte, to a timestamped sibling
   * - before the write that is about to replace it (#75).
   *
   * `fs.copyFile` rather than read-then-write: the goal is a faithful copy of whatever bytes are
   * actually on disk right now - BOM, trailing comma, wrong encoding and all - not a copy of
   * whatever this process last parsed, which can differ if the file changed between the failed
   * `reload` and this `set`. `COPYFILE_EXCL` is what makes "a later rejection never clobbers an
   * earlier copy" true rather than merely likely.
   *
   * ENOENT is reported as `nothing-to-preserve`, not `failed`: see the caller for why a missing
   * source must not block the write.
   */
  async #preserveOriginal(): Promise<
    | { readonly outcome: 'preserved'; readonly path: string }
    | { readonly outcome: 'nothing-to-preserve' }
    | { readonly outcome: 'failed'; readonly message: string }
  > {
    const { dir, name } = path.parse(this.#filePath);
    // Filesystem-safe and still readable: `:` is illegal in a Windows filename, so the default
    // ISO string (`...T12:34:56.789Z`) cannot be used as-is.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // A `.json` extension regardless of the original's, so the copy opens in an editor the same
    // way the file it came from did.
    const copyPath = path.join(dir, `${name}.rejected-${stamp}.json`);

    try {
      await fs.copyFile(this.#filePath, copyPath, fs.constants.COPYFILE_EXCL);
      return { outcome: 'preserved', path: copyPath };
    } catch (error) {
      if (isNotFound(error)) {
        this.#log.info('the config file that failed to load is gone; nothing to preserve', {
          filePath: this.#filePath,
        });
        return { outcome: 'nothing-to-preserve' };
      }
      return { outcome: 'failed', message: describeError(error) };
    }
  }

  /**
   * Add the sibling copy's path to the message of whatever issue the last failed reload left
   * behind, so a user reading the settings window's issue list can find where their original file
   * went.
   *
   * This is the only route available: the tray/overlay alert built by
   * `error-reporter.ts#describeConfigIssues` constructs its text from `kind` and `fields` alone
   * and never reads `message`, so it cannot be extended from here without editing that file.
   * `fields` is left untouched on purpose - it is joined into "capture.diffThreshold is not
   * valid" there, and a filesystem path spliced into that list would read as an invalid setting
   * name rather than a location.
   */
  #notePreserved(copyPath: string): void {
    const note = `Textlens saved your previous file to ${copyPath} before writing this change.`;
    this.#setIssues(
      this.#issues.map((issue) => (issue.kind === 'not-persisted' ? issue : { ...issue, message: `${issue.message}. ${note}` })),
    );
  }

  /**
   * Replace any previous `not-persisted` entry with one carrying `message`, rather than appending
   * to it. The old code appended, so a read-only config directory grew this list by one entry per
   * save for the life of the process - every entry saying the same thing, and every one of them
   * re-rendered by the settings window that reads it.
   */
  #recordNotPersisted(message: string): void {
    this.#setIssues([
      ...this.#issues.filter((issue) => issue.kind !== 'not-persisted'),
      { kind: 'not-persisted', message, fields: [] },
    ]);
  }

  /**
   * Adopt a new issue list and tell subscribers, but only if it actually differs.
   *
   * The same guard {@link #commit} uses, and for a sharper reason: this is called on every
   * successful write, which for a healthy app means "no issues" replacing "no issues" several
   * times a second while a user drags a slider. Notifying on that would rewrite the tray tooltip
   * and re-render the settings window on each one.
   */
  #setIssues(next: readonly ConfigIssue[]): void {
    const previous = this.#issues;
    this.#issues = [...next];
    if (JSON.stringify(previous) === JSON.stringify(this.#issues)) return;

    for (const listener of [...this.#issueListeners]) {
      try {
        listener(this.#issues);
      } catch (error) {
        // One bad subscriber must not stop the others, exactly as in `#commit`.
        this.#log.error('a config issue listener threw', { message: describeError(error) });
      }
    }
  }

  #invalidIssue(error: Parameters<typeof toFieldErrors>[0], message: string): ConfigIssue {
    const fields = toFieldErrors(error);
    this.#log.error(message, { filePath: this.#filePath, fields });
    return { kind: 'invalid', message, fields };
  }

  /**
   * Adopt a new config and tell subscribers, but only if it actually differs.
   *
   * Notifying on an identical value would make a subscriber that pushes `configure` to the
   * sidecar do so on every save, restarting the capture loop for a change that was not one.
   */
  #commit(next: Config): void {
    const previous = this.#current;
    if (JSON.stringify(previous) === JSON.stringify(next)) return;

    this.#current = next;
    for (const listener of [...this.#listeners]) {
      try {
        listener(next, previous);
      } catch (error) {
        // One bad subscriber must not stop the others, exactly as in `SidecarClient.#emit`.
        this.#log.error('a config listener threw', { message: describeError(error) });
      }
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Deep-merge `patch` over `base`, returning a new object.
 *
 * Plain objects merge key by key; **everything else replaces wholesale**. That exception is
 * the important half: `region` is a `[x, y, w, h]` tuple, and merging it element-wise would
 * let a 4-element override of a 4-element default produce a rectangle that is half of each.
 * An explicit `undefined` is treated as "not set" so that `{ region: undefined }` cannot erase
 * a value the user never mentioned.
 */
function mergeDeep(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    result[key] = key in base ? mergeDeep(base[key], value) : value;
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Drop a leading UTF-8 byte order mark.
 *
 * `fs.readFile(..., 'utf8')` decodes the BOM into a real `U+FEFF` character and `JSON.parse`
 * rejects it, so without this the file is reported as malformed with a message about an
 * unexpected token that renders as nothing. That is not a hypothetical: this is a
 * Windows-only app by design (CLAUDE.md invariant 5), and on Windows a BOM is what Notepad
 * and PowerShell's `Out-File -Encoding utf8` write by default. Rejecting the output of the
 * two editors a user is most likely to reach for would make hand-editing config a trap that
 * blames the user's JSON for the tooling's default.
 *
 * Found by hitting it: a config written with `Out-File -Encoding utf8` came back "not valid
 * JSON" while looking perfectly correct in every editor.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
