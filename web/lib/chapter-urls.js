/**
 * Chapter URLs must be the media URLs the Libby player actually requested.
 *
 * On 2026-10-29 OverDrive changed audiobook delivery. The init value
 * `-odread-cmpt-params` is no longer the query the audio host accepts, so
 * `origin + path + ?` + that value returns HTTP 500 for every part (LibbyRip
 * issue 82). pdugan20/libby-downloader still builds the old URL. The player
 * itself requests a working signed URL; record those from performance
 * entries (audio/media only). Do not patch HTMLMediaElement — OverDrive
 * treats that as tampering.
 *
 * Copyright (c) 2026 libby-downloader contributors.
 */

import { isAllowedChapterURL } from './urls.js';

/**
 * Last path segment, decoded, so `{uuid}Fmt425-Part24.mp3` matches a
 * percent-encoded player URL.
 * @param {unknown} pathOrUrl
 * @returns {string}
 */
export function partFileKey(pathOrUrl) {
  if (typeof pathOrUrl !== 'string' || !pathOrUrl) return '';
  const withoutQuery = pathOrUrl.split('?')[0].split('#')[0];
  const last = withoutQuery.split('/').filter(Boolean).pop() || '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * A signed media URL has an allowed host and a query assignment. `?undefined`
 * and a bare path are the broken cmpt reconstruction, not a player URL.
 * @param {unknown} urlString
 * @returns {boolean}
 */
export function isSignedMediaUrl(urlString) {
  if (typeof urlString !== 'string' || !isAllowedChapterURL(urlString)) return false;
  try {
    return new URL(urlString).search.includes('=');
  } catch {
    return false;
  }
}

/**
 * Keep the latest audio/media entry for each part. fetch entries are ignored
 * so a previous failed chapter download cannot overwrite the player URL.
 * @param {Map<string, string>} map
 * @param {unknown} entries
 * @returns {Map<string, string>}
 */
export function mergePerformanceMediaUrls(map, entries) {
  if (!Array.isArray(entries)) return map;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = /** @type {{ name?: unknown, initiatorType?: unknown }} */ (entry);
    if (record.initiatorType !== 'audio' && record.initiatorType !== 'media') continue;
    if (typeof record.name !== 'string' || !isSignedMediaUrl(record.name)) continue;
    const key = partFileKey(record.name);
    if (!key.toLowerCase().includes('.mp3')) continue;
    map.set(key, record.name);
  }
  return map;
}

/**
 * @param {Map<string, string>} map
 * @param {unknown} path
 * @returns {string}
 */
export function capturedUrlForPart(map, path) {
  const key = partFileKey(path);
  if (!key) return '';
  const url = map.get(key);
  return typeof url === 'string' ? url : '';
}

/**
 * @param {Array<{ index?: number, path?: string }>} missing
 * @param {number} total
 * @returns {string}
 */
export function missingPlayerUrlMessage(missing, total) {
  const names = missing
    .slice(0, 3)
    .map((part) => partFileKey(part.path) || `chapter ${(part.index ?? 0) + 1}`);
  const extra = missing.length > names.length ? `, +${missing.length - names.length} more` : '';
  return (
    `Could not read the player URL for ${missing.length} of ${total} chapters ` +
    `(${names.join(', ')}${extra}). Libby rejects the older cmpt link with HTTP 500. ` +
    'Play the audiobook for a few seconds, then try again.'
  );
}

/**
 * @param {number} index Zero-based chapter index.
 * @param {unknown} error
 * @param {string} [url]
 * @returns {string}
 */
export function formatChapterFailure(index, error, url = '') {
  const number = Number.isInteger(index) ? index + 1 : '?';
  const file = partFileKey(url);
  const fileSuffix = file ? ` (${file})` : '';
  const record =
    error && typeof error === 'object' ? /** @type {{ status?: unknown, message?: unknown }} */ (error) : null;
  const status = record && typeof record.status === 'number' ? record.status : 0;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : record && typeof record.message === 'string'
          ? record.message
          : 'download failed';
  if (status > 0) {
    const host = /from\s+(\S+)/.exec(message)?.[1] || '';
    const where = host ? ` from ${host}` : '';
    return `Chapter ${number}: HTTP ${status}${where}${fileSuffix}`;
  }
  const cleaned = message.replace(/^http-\d+:\s*/, '');
  return `Chapter ${number}: ${cleaned}${fileSuffix}`;
}

/**
 * The text shown when native save fails. This is the chapter error only.
 * The save-strategy sentence ("runtime.sendNativeMessage is a function")
 * describes why native was selected, not why the chapter failed.
 * @param {unknown} failure
 * @returns {string}
 */
export function pageFallbackReason(failure) {
  const text = typeof failure === 'string' ? failure.trim() : '';
  return text || 'The chapter download failed';
}

/**
 * Read player media URLs, seeking the player through any part it has not
 * requested yet. Never invents a cmpt URL.
 * @param {{
 *   parts: Array<{ index: number, spinePosition?: number, path: string }>,
 *   readEntries: () => unknown,
 *   seekToPart?: (part: { index: number, spinePosition?: number, path: string }, total: number) => boolean | Promise<boolean>,
 *   sleep?: (ms: number) => Promise<void>,
 *   waitPerPartMs?: number,
 *   gapMs?: number,
 *   onProgress?: (event: { position: number, total: number, index: number }) => void,
 * }} input
 */
export async function collectPlayerChapterUrls({
  parts,
  readEntries,
  seekToPart,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  waitPerPartMs = 2000,
  gapMs = 400,
  onProgress,
}) {
  const playerUrls = new Map();
  const absorb = () => mergePerformanceMediaUrls(playerUrls, readEntries());
  absorb();

  const stillMissing = () => parts.filter((part) => !capturedUrlForPart(playerUrls, part.path));
  let seekable = typeof seekToPart === 'function';
  const initialMissing = stillMissing();
  const polls = Math.max(1, Math.ceil(waitPerPartMs / 100));

  for (let i = 0; i < initialMissing.length; i++) {
    const part = initialMissing[i];
    if (capturedUrlForPart(playerUrls, part.path)) continue;
    if (!seekable) break;
    const position = parts.findIndex((item) => item.index === part.index);
    onProgress?.({
      position: (position < 0 ? part.index : position) + 1,
      total: parts.length,
      index: part.index,
    });
    const moved = await seekToPart(part, parts.length);
    if (moved === false) {
      seekable = false;
      break;
    }
    for (let poll = 0; poll < polls; poll++) {
      absorb();
      if (capturedUrlForPart(playerUrls, part.path)) break;
      await sleep(100);
    }
    if (gapMs > 0 && i < initialMissing.length - 1) await sleep(gapMs);
  }
  absorb();

  return parts.map((part) => {
    const url = capturedUrlForPart(playerUrls, part.path);
    if (url) return { ...part, url, source: /** @type {'player'} */ ('player') };
    return { ...part, url: '', source: /** @type {'missing'} */ ('missing') };
  });
}
