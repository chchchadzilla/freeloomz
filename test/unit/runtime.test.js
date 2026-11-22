// install.ps1 downloads the runtime by the versions and checksums pinned in
// runtime.json. These checks stop that file drifting away from the versions
// the app is developed and tested against.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.join(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const runtime = readJson('runtime.json');
const pkg = readJson('package.json');

test('runtime.json pins the Electron version the app is built against', () => {
  assert.equal(runtime.electron.version, pkg.devDependencies.electron);
});

test('runtime.json pins the ffmpeg release that ffmpeg-static ships', () => {
  const ffmpegStatic = require('ffmpeg-static/package.json');
  assert.equal(runtime.ffmpeg.release, ffmpegStatic['ffmpeg-static']['binary-release-tag']);
});

test('every pinned checksum is a SHA-256, and Windows is covered', () => {
  for (const part of [runtime.electron, runtime.ffmpeg]) {
    assert.ok(part.sha256['win32-x64'], 'win32-x64 is pinned');
    for (const sum of Object.values(part.sha256)) assert.match(sum, /^[0-9a-f]{64}$/);
  }
});

test('install.ps1 stays plain ASCII, so Windows PowerShell 5.1 reads it the same way everywhere', () => {
  const script = fs.readFileSync(path.join(root, 'install.ps1'), 'utf8');
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(script, /[^\x00-\x7f]/);
  assert.doesNotMatch(script, /\r/);
});
