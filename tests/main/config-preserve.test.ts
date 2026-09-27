/**
 * Issue #75, the one scenario `config.test.ts` cannot produce with a real filesystem failure:
 * a config directory that is fully writable for the write itself, but where the preserve-copy
 * specifically fails. Every other test for #75 uses a real failure (a directory in place of the
 * file, a file deleted out from under the service), matching `config.test.ts`'s own stated policy
 * of not stubbing `fs`. This one file is the deliberate exception - `fs.copyFile` is stubbed to
 * fail while `fs.mkdir`/`writeFile`/`rename` are left real, which is not producible by arranging
 * real filesystem state because both operations live in the same directory and share the same
 * failure modes (ENOTDIR, EACCES, ...).
 *
 * `config.ts` imports `node:fs/promises` as a default-exported namespace object and calls
 * `fs.copyFile(...)` off it at call time, so spying on that same module's `copyFile` property
 * intercepts the call made from inside `config.ts` without needing to touch its source.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigService } from '../../src/main/services/config.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textlens-config-preserve-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ConfigService: when the preserve-copy itself fails but the directory is otherwise writable (#75)', () => {
  it('does not write, keeps the change live for the session only, and reports why - instead of silently destroying the original', async () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'config.json');
    const original = JSON.stringify({ render: { fontSize: 999 } }); // fontSize max is 48: invalid.
    fs.writeFileSync(filePath, original, 'utf8');
    const originalBytes = fs.readFileSync(filePath);

    const service = await ConfigService.load({ filePath });
    expect(service.issues[0]?.kind).toBe('invalid');

    const copySpy = vi.spyOn(fsp, 'copyFile').mockRejectedValue(
      Object.assign(new Error('simulated: disk full while copying'), { code: 'ENOSPC' }),
    );

    const result = await service.set({ render: { opacity: 0.5 } });

    expect(copySpy).toHaveBeenCalledOnce();

    // Applied in memory for this session - `set()`'s own documented ordering (config.ts) - but
    // not written, because the copy that must happen first did not succeed.
    expect(result.applied).toBe(true);
    expect(result.persisted).toBe(false);
    expect(service.current.render.opacity).toBe(0.5);

    // The one assertion that discriminates this from the pre-fix code: the original file is
    // completely untouched, byte-for-byte. Pre-fix, `set()` would have reached `#write` and
    // replaced this file with `{"render":{"opacity":0.5}}`, losing it for good.
    expect(fs.readFileSync(filePath).equals(originalBytes)).toBe(true);

    // No temp file left behind either - the write attempt never started.
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
    // And no sibling copy exists (the copy failed), so nothing claims to be a backup that isn't.
    expect(fs.readdirSync(dir).some((name) => name.includes('rejected'))).toBe(false);

    expect(
      service.issues.some(
        (issue) => issue.kind === 'not-persisted' && issue.message.includes('backed up'),
      ),
    ).toBe(true);
  });

  it('retries the preserve-copy on the next set() rather than giving up for the rest of the session', async () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'config.json');
    fs.writeFileSync(filePath, JSON.stringify({ render: { fontSize: 999 } }), 'utf8');

    const service = await ConfigService.load({ filePath });

    const copySpy = vi
      .spyOn(fsp, 'copyFile')
      .mockRejectedValueOnce(Object.assign(new Error('simulated'), { code: 'ENOSPC' }));

    const first = await service.set({ render: { opacity: 0.5 } });
    expect(first.persisted).toBe(false);

    // The mock above only rejects once; the second call goes through to the real fs.copyFile.
    const second = await service.set({ render: { opacity: 0.75 } });
    expect(second.persisted).toBe(true);
    expect(copySpy).toHaveBeenCalledTimes(2);

    const siblings = fs.readdirSync(dir).filter((name) => /^config\.rejected-.*\.json$/.test(name));
    expect(siblings).toHaveLength(1);
  });
});
