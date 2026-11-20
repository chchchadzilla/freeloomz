// The recordings library: the video files in the recordings folder, plus a
// small index (durations, chapter markers, thumbnails) kept in the app's
// data folder. Files are the source of truth — the index is only a cache,
// so moving or deleting files in the file manager never breaks anything.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { sanitizeFileName, uniquePath } from '../shared/naming.js';
import { probe, runFfmpeg } from './ffmpeg.js';
import { readJson, retryWhileBusy, writeJsonAtomic } from './settings-store.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov']);
const LISTED_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, '.gif']);

/**
 * @typedef {object} IndexEntry
 * @property {number} [durationMs]
 * @property {number} [width]
 * @property {number} [height]
 * @property {{ timeMs: number, label: string }[]} [markers]
 * @property {number} [sizeBytes]  size when the entry was written (staleness check)
 * @property {boolean} [inspected] probe + thumbnail were attempted for this size
 */

/**
 * @typedef {object} LibraryItem
 * @property {string} path
 * @property {string} name        file name without extension
 * @property {string} ext
 * @property {number} sizeBytes
 * @property {number} modifiedMs
 * @property {number | null} durationMs
 * @property {number} width
 * @property {number} height
 * @property {{ timeMs: number, label: string }[]} markers
 * @property {string | null} thumbnail absolute path of a JPEG, if one exists
 */

/** Emits 'updated' when background inspection has filled in new details. */
export class Library extends EventEmitter {
  /**
   * @param {{ indexFile: string, thumbsDir: string }} o
   */
  constructor({ indexFile, thumbsDir }) {
    super();
    this._backfilling = false;
    this.indexFile = indexFile;
    this.thumbsDir = thumbsDir;
    /** @type {Record<string, IndexEntry>} */
    this.index = readJson(indexFile, {}) ?? {};
    this._saveTimer = /** @type {NodeJS.Timeout | null} */ (null);
  }

  /** @param {string} file */
  thumbPathFor(file) {
    const hash = crypto.createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 20);
    return path.join(this.thumbsDir, `${hash}.jpg`);
  }

  /** @param {string} file @param {IndexEntry} entry */
  remember(file, entry) {
    this.index[path.resolve(file)] = { ...this.index[path.resolve(file)], ...entry };
    this._scheduleSave();
  }

  /** @param {string} file */
  forget(file) {
    delete this.index[path.resolve(file)];
    fsp.rm(this.thumbPathFor(file), { force: true }).catch(() => {});
    this._scheduleSave();
  }

  /**
   * Lists recordings, newest first. Missing durations and thumbnails are
   * filled in in the background; 'updated' fires when there is more to show.
   * @param {string} dir
   * @returns {Promise<LibraryItem[]>}
   */
  async list(dir) {
    const names = await fsp.readdir(dir).catch(() => /** @type {string[]} */ ([]));
    /** @type {LibraryItem[]} */
    const items = [];
    const needWork = [];
    for (const name of names) {
      const ext = path.extname(name).toLowerCase();
      if (!LISTED_EXTENSIONS.has(ext) || name.startsWith('.')) continue;
      const file = path.join(dir, name);
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat || !stat.isFile() || stat.size === 0) continue;
      const entry = this.index[path.resolve(file)] ?? {};
      const fresh = entry.sizeBytes === stat.size;
      const thumb = this.thumbPathFor(file);
      const hasThumb = fresh && fs.existsSync(thumb);
      items.push({
        path: file,
        name: path.basename(name, path.extname(name)),
        ext,
        sizeBytes: stat.size,
        modifiedMs: stat.mtimeMs,
        durationMs: fresh ? (entry.durationMs ?? null) : null,
        width: fresh ? (entry.width ?? 0) : 0,
        height: fresh ? (entry.height ?? 0) : 0,
        markers: fresh ? (entry.markers ?? []) : [],
        thumbnail: hasThumb ? thumb : null,
      });
      if (!fresh || !entry.inspected) needWork.push({ file, size: stat.size });
    }
    items.sort((a, b) => b.modifiedMs - a.modifiedMs);
    if (needWork.length > 0) this._backfill(needWork);
    return items;
  }

  /**
   * Probes files and makes thumbnails one at a time (cheap, but no need to
   * spawn twenty ffmpegs at once on first launch). Every file is attempted
   * once per size, so a file ffmpeg cannot read is not retried forever.
   * @param {{ file: string, size: number }[]} work
   */
  async _backfill(work) {
    // A list() during a run is not lost: 'updated' makes the UI list again,
    // which queues whatever is still missing.
    if (this._backfilling) return;
    this._backfilling = true;
    try {
      for (const { file, size } of work) {
        try {
          const info = await probe(file);
          this.remember(file, {
            durationMs: info.durationSec ? Math.round(info.durationSec * 1000) : 0,
            width: info.video?.width ?? 0,
            height: info.video?.height ?? 0,
            sizeBytes: size,
            inspected: true,
          });
          await this.makeThumbnail(file, info.durationSec ?? 0);
        } catch (err) {
          this.remember(file, { durationMs: 0, sizeBytes: size, inspected: true });
          console.warn('[library] could not inspect', file, err);
        }
      }
    } finally {
      this._backfilling = false;
    }
    this.emit('updated');
  }

  /**
   * Grabs a frame a little way in (the very first frame is often a
   * half-drawn screen).
   * @param {string} file
   * @param {number} durationSec
   */
  async makeThumbnail(file, durationSec) {
    await fsp.mkdir(this.thumbsDir, { recursive: true });
    const out = this.thumbPathFor(file);
    const at = Math.max(0, Math.min(3, durationSec / 4));
    await runFfmpeg([
      '-hide_banner', '-nostdin', '-y',
      '-ss', at.toFixed(2), '-i', file,
      '-frames:v', '1', '-vf', "scale='min(480,iw)':-2", '-q:v', '4', out,
    ]).catch(() => {});
    return fs.existsSync(out) ? out : null;
  }

  /**
   * Renames a recording, keeping its extension, index entry and thumbnail.
   * @param {string} file
   * @param {string} newName name without extension, as typed by the user
   * @returns {Promise<string>} the new path
   */
  async rename(file, newName) {
    const clean = sanitizeFileName(newName);
    if (!clean) throw new Error('That name has no usable characters.');
    const dir = path.dirname(file);
    const ext = path.extname(file);
    if (clean === path.basename(file, ext)) return file;
    const wanted = path.join(dir, `${clean}${ext}`);
    // Only the capitalisation changed: on macOS and Windows the "existing"
    // file with that name is this very file, not a clash.
    const sameFile = wanted.toLowerCase() === file.toLowerCase();
    const target = sameFile ? wanted : uniquePath(dir, clean, ext, (p) => fs.existsSync(p), path.join);
    await retryWhileBusy(() => fsp.rename(file, target));
    const entry = this.index[path.resolve(file)];
    const oldThumb = this.thumbPathFor(file);
    delete this.index[path.resolve(file)];
    if (entry) this.index[path.resolve(target)] = entry;
    await fsp.rename(oldThumb, this.thumbPathFor(target)).catch(() => {});
    this._scheduleSave();
    return target;
  }

  /** @param {string} file */
  isVideo(file) {
    return VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase());
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = null;
    try {
      writeJsonAtomic(this.indexFile, this.index);
    } catch (err) {
      console.error('[library] could not save index:', err);
    }
  }
}

/**
 * True when `file` sits directly inside `dir`. Used to make sure requests
 * coming from a window can only touch files in the recordings folder.
 * @param {string} file
 * @param {string} dir
 */
export function isInside(file, dir) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
}
