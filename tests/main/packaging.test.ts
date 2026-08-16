/**
 * The packaging config and the path resolvers are one contract written in two files, and
 * nothing at build time notices when they disagree (issue #45).
 *
 * The failure this guards is quiet in a way that matters: if `electron-builder.yml` puts the
 * sidecar anywhere other than where `resolveSidecarPath` looks, the installer still builds,
 * still installs, still launches, and the app still comes up - it simply has no capture, and
 * the only symptom is a "capture unavailable" surface that looks a lot like a machine without
 * the OCR pack. Same for the tray icons: a wrong `to:` yields a blank tray, not a crash.
 *
 * Deliberately string-matching rather than parsing YAML: the whole point is to fail when
 * someone edits that file, and adding a YAML dependency to read four lines is not worth it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SIDECAR_EXECUTABLE, resolveSidecarPath } from '../../src/main/services/sidecar-client.js';
import { resolveTrayIconDir } from '../../src/main/services/tray-service.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const config = fs.readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8');

/** What electron-builder lays down under `resources/`, as `to:` values. */
const destinations = [...config.matchAll(/^\s*to:\s*(\S+)\s*$/gm)].map((m) => m[1]);

/** `process.resourcesPath` in a packaged Windows build. */
const RESOURCES = 'C:\\app\\resources';

describe('electron-builder.yml agrees with the packaged path resolvers', () => {
  it('lands the sidecar exactly where resolveSidecarPath looks for it', () => {
    const { exePath, source } = resolveSidecarPath({
      env: {},
      isPackaged: true,
      resourcesPath: RESOURCES,
      appPath: 'C:\\app\\resources\\app.asar',
    });
    expect(source).toBe('packaged');

    const relative = path.relative(RESOURCES, exePath).split(path.sep).join('/');
    expect(destinations).toContain(relative);
    expect(relative.endsWith(SIDECAR_EXECUTABLE)).toBe(true);
  });

  it('lands the tray icons exactly where resolveTrayIconDir looks for them', () => {
    const iconDir = resolveTrayIconDir({
      isPackaged: true,
      resourcesPath: RESOURCES,
      appPath: 'C:\\app\\resources\\app.asar',
    });

    const relative = path.relative(RESOURCES, iconDir).split(path.sep).join('/');
    expect(destinations).toContain(relative);
  });

  it('copies the source directory of the icons, not the directory above it', () => {
    // `from: build/icons` + `to: icons` is right; `from: build` + `to: icons` would nest them
    // one level deeper and read as equally plausible in review.
    expect(config).toMatch(/from:\s*build\/icons\b/);
  });

  it('ships the font licence, because nothing else in the build would', () => {
    // The .ttf rides along as a Vite asset; OFL 1.1 obliges the licence to travel with it,
    // and no pipeline carries a bare .txt out of src/renderer.
    expect(config).toMatch(/from:\s*src\/renderer\/overlay\/fonts\/OFL\.txt/);
    expect(fs.existsSync(path.join(repoRoot, 'src/renderer/overlay/fonts/OFL.txt'))).toBe(true);
  });

  it('does not write installers into dist/, which is the compiled app', () => {
    expect(config).toMatch(/output:\s*release\b/);
  });

  it('reads the sidecar from a Release publish for the framework the csproj targets', () => {
    const csproj = fs.readFileSync(
      path.join(repoRoot, 'sidecar/Textlens.Capture/Textlens.Capture.csproj'),
      'utf8',
    );
    const tfm = /<TargetFramework>([^<]+)<\/TargetFramework>/.exec(csproj)?.[1];
    expect(tfm).toBeDefined();
    // A TFM bump in the csproj silently orphans the `from:` path here: electron-builder would
    // copy the previous publish if one is lying around, and fail the build if not - and the
    // first of those two is the bad one.
    expect(config).toContain(`bin/Release/${tfm ?? ''}/win-x64/publish/${SIDECAR_EXECUTABLE}`);
  });
});
