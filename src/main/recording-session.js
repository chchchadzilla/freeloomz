// Crash-safe recording storage.
//
// While recording, encoded chunks are appended to a raw file on disk about
// once a second, so memory use stays flat no matter how long you record and
// a crash or power cut loses at most the last second. A small journal file
// next to it remembers the name, markers and elapsed time, which lets the
// app recover an unfinished recording on the next launch.
//
// When recording stops, `finalizeRecording` turns the raw stream into a
// finished, seekable MP4.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { recordingBaseName, rawExtensionFor, uniquePath } from '../shared/naming.js';
import { ffmetadata, normalizeMarkers } from '../shared/time.js';
import { finalizeArgs } from '../shared/ffargs.js';
import { probe, runFfmpeg } from './ffmpeg.js';
import { readJson, retryWhileBusy, writeJsonAtomic } from './settings-store.js';

export const TMP_DIR_NAME = '.freeloomz-tmp';

/** @param {string} recordingsDir */
export const tmpDirFor = (recordingsDir) => path.join(recordingsDir, TMP_DIR_NAME);

/**
 * @typedef {object} Journal
 * @property {string} id
 * @property {string} baseName   file name (no extension) the finished recording should get
 * @property {string} rawFile    file name of the raw stream inside the tmp dir
 * @property {string} mime
 * @property {number} startedAt  epoch ms
 * @property {number} durationMs recorded time so far (pauses excluded)
 * @property {{ timeMs: number, label?: string }[]} markers
 * @property {boolean} closed    true once the raw file was closed cleanly
 */

export class RecordingSession {
  /**
   * @param {{ recordingsDir: string, mime: string, now?: Date }} o
   */
  constructor({ recordingsDir, mime, now = new Date() }) {
    this.recordingsDir = recordingsDir;
    this.tmpDir = tmpDirFor(recordingsDir);
    const id = `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    /** @type {Journal} */
    this.journal = {
      id,
      baseName: recordingBaseName(now),
      rawFile: `${id}${rawExtensionFor(mime)}`,
      mime,
      startedAt: now.getTime(),
      durationMs: 0,
      markers: [],
      closed: false,
    };
    this.rawPath = path.join(this.tmpDir, this.journal.rawFile);
    this.journalPath = path.join(this.tmpDir, `${id}.json`);
    this.bytesWritten = 0;
    this.chunks = 0;
    this._stream = /** @type {fs.WriteStream | null} */ (null);
    this._error = /** @type {Error | null} */ (null);
  }

  async open() {
    await fsp.mkdir(this.tmpDir, { recursive: true });
    this._saveJournal();
    this._stream = fs.createWriteStream(this.rawPath, { flags: 'w' });
    this._stream.on('error', (err) => {
      this._error = err;
    });
    await new Promise((resolve, reject) => {
      this._stream.once('open', resolve);
      this._stream.once('error', reject);
    });
  }

  /**
   * Appends one encoded chunk. Resolves once it has been handed to the OS.
   * @param {Uint8Array} chunk
   */
  write(chunk) {
    if (this._error) return Promise.reject(this._error);
    if (!this._stream) return Promise.reject(new Error('Recording file is not open'));
    return new Promise((resolve, reject) => {
      this._stream.write(chunk, (err) => {
        if (err) {
          this._error = err;
          reject(err);
        } else {
          this.bytesWritten += chunk.byteLength;
          this.chunks += 1;
          resolve(undefined);
        }
      });
    });
  }

  /** @param {number} timeMs @param {string} [label] */
  addMarker(timeMs, label) {
    this.journal.markers.push({ timeMs: Math.max(0, Math.round(timeMs)), ...(label ? { label } : {}) });
    this._saveJournal();
  }

  /** Called periodically so a recovered recording knows roughly how long it is. */
  noteElapsed(durationMs) {
    this.journal.durationMs = Math.max(0, Math.round(durationMs));
    this._saveJournal();
  }

  /** @param {number} durationMs */
  async close(durationMs) {
    if (this._stream) {
      const stream = this._stream;
      this._stream = null;
      await new Promise((resolve) => stream.end(resolve));
    }
    this.journal.durationMs = Math.max(0, Math.round(durationMs));
    this.journal.closed = true;
    this._saveJournal();
  }

  async discard() {
    if (this._stream) {
      const stream = this._stream;
      this._stream = null;
      await new Promise((resolve) => stream.end(resolve));
    }
    await removeQuietly(this.rawPath, this.journalPath);
  }

  _saveJournal() {
    try {
      writeJsonAtomic(this.journalPath, this.journal);
    } catch (err) {
      console.error('[session] could not write journal:', err);
    }
  }
}

/** @param {...string} files */
async function removeQuietly(...files) {
  await Promise.all(files.map((f) => fsp.rm(f, { force: true }).catch(() => {})));
}

/**
 * Turns a raw recording into a finished MP4 in the recordings folder.
 * On failure the raw file is moved next to the user's other recordings
 * instead of being deleted — a recording is never thrown away.
 *
 * @param {{ recordingsDir: string, journal: Journal, onProgress?: (fraction: number) => void }} o
 * @returns {Promise<{ path: string, durationMs: number, sizeBytes: number, width: number, height: number, markers: { timeMs: number, label: string }[], hasAudio: boolean }>}
 */
export async function finalizeRecording({ recordingsDir, journal, onProgress }) {
  const tmpDir = tmpDirFor(recordingsDir);
  const rawPath = path.join(tmpDir, journal.rawFile);
  const journalPath = path.join(tmpDir, `${journal.id}.json`);
  const metaPath = path.join(tmpDir, `${journal.id}.chapters.txt`);
  const stagedPath = path.join(tmpDir, `${journal.id}.final.mp4`);
  const exists = (p) => fs.existsSync(p);

  const stat = await fsp.stat(rawPath).catch(() => null);
  if (!stat || stat.size === 0) {
    await removeQuietly(rawPath, journalPath);
    throw new Error('Nothing was recorded.');
  }

  try {
    const info = await probe(rawPath);
    if (!info.video) throw new Error('The recording contains no video.');

    const markers = normalizeMarkers(journal.markers, journal.durationMs);
    let metadataFile;
    if (markers.length > 0 && journal.durationMs > 0) {
      await fsp.writeFile(metaPath, ffmetadata(journal.markers, journal.durationMs, journal.baseName));
      metadataFile = metaPath;
    }

    await runFfmpeg(
      finalizeArgs({
        input: rawPath,
        output: stagedPath,
        videoCodec: info.video.codec,
        hasAudio: Boolean(info.audio),
        metadataFile,
      }),
      { totalSec: journal.durationMs > 0 ? journal.durationMs / 1000 : null, onProgress },
    );

    const finished = await probe(stagedPath);
    if (!finished.video || !(finished.durationSec > 0)) throw new Error('The finished file failed verification.');

    const finalPath = uniquePath(recordingsDir, journal.baseName, '.mp4', exists, path.join);
    await retryWhileBusy(() => fsp.rename(stagedPath, finalPath));
    await removeQuietly(rawPath, journalPath, metaPath);
    const size = (await fsp.stat(finalPath)).size;
    return {
      path: finalPath,
      durationMs: Math.round(finished.durationSec * 1000),
      sizeBytes: size,
      width: finished.video.width,
      height: finished.video.height,
      markers,
      hasAudio: Boolean(finished.audio),
    };
  } catch (err) {
    await removeQuietly(stagedPath, metaPath);
    const rescued = uniquePath(recordingsDir, `${journal.baseName} (unprocessed)`, path.extname(rawPath), exists, path.join);
    const moved = await fsp.rename(rawPath, rescued).then(
      () => true,
      () => false,
    );
    if (!moved) throw err; // raw file and journal stay put; recovery will offer it again
    await removeQuietly(journalPath);
    const reason = err instanceof Error ? err.message : String(err);
    const error = new Error(
      `${reason}\n\nYour recording is safe — the unprocessed file was saved as "${path.basename(rescued)}". It plays in VLC.`,
    );
    /** @type {any} */ (error).rescuedPath = rescued;
    throw error;
  }
}

/**
 * Finds recordings that were never finished (the app crashed, the computer
 * lost power…). `activeId` is skipped so the recording in progress is not
 * reported.
 * @param {string} recordingsDir
 * @param {string | null} [activeId]
 * @returns {Promise<{ journal: Journal, sizeBytes: number }[]>}
 */
export async function findOrphans(recordingsDir, activeId = null) {
  const tmpDir = tmpDirFor(recordingsDir);
  const names = await fsp.readdir(tmpDir).catch(() => /** @type {string[]} */ ([]));
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    /** @type {Journal | null} */
    const journal = readJson(path.join(tmpDir, name));
    if (!journal || typeof journal.id !== 'string' || typeof journal.rawFile !== 'string') continue;
    if (journal.id === activeId) continue;
    // Never trust a path from a file on disk: keep it inside the tmp dir.
    if (path.basename(journal.rawFile) !== journal.rawFile) continue;
    const stat = await fsp.stat(path.join(tmpDir, journal.rawFile)).catch(() => null);
    if (!stat || stat.size === 0) {
      await removeQuietly(path.join(tmpDir, name), path.join(tmpDir, journal.rawFile));
      continue;
    }
    out.push({ journal, sizeBytes: stat.size });
  }
  return out.sort((a, b) => b.journal.startedAt - a.journal.startedAt);
}

/** @param {string} recordingsDir @param {Journal} journal */
export async function discardOrphan(recordingsDir, journal) {
  const tmpDir = tmpDirFor(recordingsDir);
  await removeQuietly(path.join(tmpDir, path.basename(journal.rawFile)), path.join(tmpDir, `${journal.id}.json`));
}
