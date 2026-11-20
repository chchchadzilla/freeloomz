import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { sanitizeSettings, mergeSettings } from '../shared/defaults.js';

/**
 * Reads a JSON file, returning `fallback` when it is missing or corrupt.
 * @param {string} file
 * @param {any} fallback
 */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Writes JSON via a temp file + rename, so a crash mid-write can never leave
 * a half-written file behind.
 * @param {string} file
 * @param {any} value
 */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Runs a file operation, retrying for a few seconds when the file is
 * briefly locked by something else. On Windows a freshly written video is
 * routinely held for a moment by antivirus or by a player that is still
 * letting go of it; failing outright would be needlessly brittle.
 * @template T
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
export async function retryWhileBusy(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (attempt >= 6 || !['EBUSY', 'EPERM', 'EACCES'].includes(code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 60 * 2 ** attempt)); // 60ms … ~2s
    }
  }
}

/** Persistent, validated user settings. Emits 'change' with the new value. */
export class SettingsStore extends EventEmitter {
  /** @param {string} file */
  constructor(file) {
    super();
    this.file = file;
    this.value = sanitizeSettings(readJson(file));
    this._timer = /** @type {NodeJS.Timeout | null} */ (null);
  }

  get() {
    return this.value;
  }

  /** @param {any} patch */
  update(patch) {
    const next = mergeSettings(this.value, patch);
    if (JSON.stringify(next) === JSON.stringify(this.value)) return this.value;
    this.value = next;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 250);
    this.emit('change', next);
    return next;
  }

  flush() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    try {
      writeJsonAtomic(this.file, this.value);
    } catch (err) {
      console.error('[settings] could not save:', err);
    }
  }
}
