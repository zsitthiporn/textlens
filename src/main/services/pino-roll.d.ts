/**
 * Minimal typings for `pino-roll`, which ships none of its own (v4.0.0).
 *
 * Only the options this app actually passes are declared. Adding a field here without
 * checking pino-roll's README would be a lie the compiler then enforces, so keep this
 * surface small on purpose.
 *
 * `logger.ts` pulls this in with a `/// <reference path>` rather than relying on the
 * tsconfig include lists: three separate configs compile that file (main build, test
 * type-check) and an ambient declaration is only visible to a program that contains it.
 */

declare module 'pino-roll' {
  import type { EventEmitter } from 'node:events';

  interface RollLimitOptions {
    /** How many rotated files to keep, oldest first out. */
    count?: number;
    removeOtherLogFiles?: boolean;
  }

  interface RollOptions {
    /** Base path. Rotated files get `.1`, `.2`, ... inserted before the extension. */
    file: string;
    /**
     * Roll once the active file passes this size.
     *
     * Beware: a bare number is **megabytes**, not bytes - pino-roll multiplies it by
     * 1024^2. Always pass a suffixed string; `"4096b"` is four kilobytes, `4096` is
     * four gigabytes and rotation will look broken.
     */
    size?: number | string;
    frequency?: 'daily' | 'hourly' | number;
    /** Appended after the roll number, e.g. `.log`. */
    extension?: string;
    limit?: RollLimitOptions;
    /** Create the directory if it is missing. */
    mkdir?: boolean;
    /** Keep a `current` symlink pointing at the active file. */
    symlink?: boolean;
  }

  /** A SonicBoom destination: buffered, asynchronous, and Writable-compatible. */
  interface RollStream extends EventEmitter {
    write(data: string): boolean;
    end(): void;
    flushSync(): void;
    destroy(): void;
    /**
     * Absolute path of the file currently being appended to; changes on each roll.
     * **Null until the stream emits `ready`** - the open is asynchronous.
     */
    readonly file: string | null;
  }

  function roll(options: RollOptions): Promise<RollStream>;

  export = roll;
}
