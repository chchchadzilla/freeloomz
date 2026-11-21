#!/usr/bin/env node
// The `freeloomz` command: what `npm install -g` puts on your PATH.
//
// Freeloomz runs on Electron. Rather than shipping a 180 MB installer, this
// launcher fetches the official Electron runtime once (through npm, so
// proxies, mirrors and caching all just work), keeps it in your user
// profile, and starts the app with it.
//
//   freeloomz              start the app
//   freeloomz --version    print the version
//   freeloomz --where      print where the app and its runtime live
//   freeloomz --foreground start the app and keep its log in this terminal

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const appDir = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
/** The exact Electron version the app is built and tested against. */
const electronVersion = String(pkg.devDependencies?.electron ?? '').replace(/^[^\d]*/, '');
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const passThrough = process.argv.slice(2).filter((a) => !['--version', '--where', '--foreground'].includes(a));

function fail(message) {
  console.error(`\nFreeloomz: ${message}\n`);
  process.exit(1);
}

if (flags.has('--version')) {
  console.log(pkg.version);
  process.exit(0);
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  fail(
    `Node.js 22.12 or newer is needed (this is ${process.versions.node}).\n` +
      (process.platform === 'win32'
        ? 'Update it with:  winget install OpenJS.NodeJS.LTS   (then open a new terminal)'
        : 'Update it from https://nodejs.org'),
  );
}

/** A per-user folder for the runtime: the global npm folder may be read-only. */
function runtimeDir() {
  const home = os.homedir();
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(base, 'Freeloomz', 'runtime', `electron-${electronVersion}`);
}

/**
 * Path of the Electron executable installed under `dir`, or null. Requiring
 * the `electron` package returns that path (and downloads the binary the
 * first time).
 * @param {string} dir
 */
function electronIn(dir) {
  try {
    const require = createRequire(path.join(dir, 'package.json'));
    const manifest = JSON.parse(fs.readFileSync(require.resolve('electron/package.json'), 'utf8'));
    if (manifest.version !== electronVersion) return null;
    const executable = require('electron');
    return typeof executable === 'string' && fs.existsSync(executable) ? executable : null;
  } catch {
    return null;
  }
}

function installRuntime(dir) {
  console.log(`Setting up Freeloomz (one time): downloading the Electron ${electronVersion} runtime, about 110 MB…`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'freeloomz-runtime', private: true }));
  const windows = process.platform === 'win32';
  // On Windows npm is a .cmd file, which can only be started through a shell.
  // Every argument is a plain token, so no quoting is involved.
  const result = spawnSync(
    windows ? 'npm.cmd' : 'npm',
    ['install', `electron@${electronVersion}`, '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: dir, stdio: 'inherit', shell: windows },
  );
  if (result.status !== 0) {
    fail('the runtime could not be downloaded. Check your internet connection and run "freeloomz" again.');
  }
}

// A source checkout already has Electron next to the app; a global install
// keeps it in the per-user runtime folder.
let electron = electronIn(appDir);
let runtime = null;
if (!electron) {
  runtime = runtimeDir();
  electron = electronIn(runtime);
  if (!electron) {
    installRuntime(runtime);
    electron = electronIn(runtime);
  }
}
if (!electron) fail('the Electron runtime is missing or incomplete. Delete the folder below and try again:\n  ' + runtimeDir());

if (flags.has('--where')) {
  console.log(JSON.stringify({ app: appDir, electron, runtime, version: pkg.version }, null, 2));
  process.exit(0);
}

const env = { ...process.env, FREELOOMZ_LAUNCHER: '1' };
delete env.ELECTRON_RUN_AS_NODE; // would make Electron behave like plain Node

if (flags.has('--foreground')) {
  const child = spawn(electron, [appDir, ...passThrough], { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  // Detached, so this terminal is free again straight away.
  const child = spawn(electron, [appDir, ...passThrough], { detached: true, stdio: 'ignore', env });
  child.on('error', (err) => fail(`could not start: ${err.message}`));
  child.unref();
  console.log('Freeloomz is starting.');
}
