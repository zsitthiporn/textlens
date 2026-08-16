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
   * @returns whether it reached the disk. False is reported, never thrown - the value is
   *          already live by the time this runs.
   */
  async #write(override: ConfigOverride): Promise<boolean> {
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
      // **Replaces** any previous `not-persisted` rather than appending to it. The old code
      // appended, so a read-only config directory grew this list by one entry per save for the
      // life of the process - every entry saying the same thing, and every one of them re-rendered
      // by the settings window that now reads it.
      this.#setIssues([
        ...this.#issues.filter((issue) => issue.kind !== 'not-persisted'),
        { kind: 'not-persisted', message, fields: [] },
      ]);
      // Best effort - a leftover temp file is untidy, not harmful, and the write already failed.
      await fs.rm(temp, { force: true }).catch(() => undefined);
      return false;
    }
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
