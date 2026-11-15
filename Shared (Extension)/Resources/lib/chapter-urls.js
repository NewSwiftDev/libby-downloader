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
 * Signed media URL for this part only. A different part's src does not count.
 * @param {unknown} src
 * @param {unknown} partPath
 * @returns {string}
 */
export function mediaUrlForPart(src, partPath) {
  if (typeof src !== 'string' || !isSignedMediaUrl(src)) return '';
  if (partFileKey(src) !== partFileKey(partPath)) return '';
  return src;
}

/**
 * Safari's resource-timing buffer stops recording once it fills, so a long
 * seek sweep would go blind. Raise it before watching for the next part.
 * @param {{ setResourceTimingBufferSize?: (size: number) => void } | null | undefined} perf
 * @param {number} minimum
 */
export function prepareResourceTiming(perf, minimum) {
  if (!perf || typeof perf.setResourceTimingBufferSize !== 'function') return;
  try {
    perf.setResourceTimingBufferSize(Math.max(250, minimum));
  } catch {
    /* Some WebKit builds reject an unsupported size. Capture still polls. */
  }
}

/**
 * @param {'seek-unavailable' | 'not-requested'} kind
 * @param {number} index
 * @param {unknown} path
 * @returns {string}
 */
export function partUrlMissReason(kind, index, path) {
  const number = index + 1;
  const file = partFileKey(path) || `chapter ${number}`;
  if (kind === 'seek-unavailable') {
    return `Chapter ${number}: the player has no seek control, so there is no fresh URL for ${file}`;
  }
  return `Chapter ${number}: the player did not request ${file} after seek`;
}

/**
 * URLs already sitting in the resource buffer. Does not seek.
 * @param {Array<{ index: number, path: string }>} parts
 * @param {unknown} entries
 */
export function urlsFromCurrentEntries(parts, entries) {
  const map = mergePerformanceMediaUrls(new Map(), entries);
  return parts.map((part) => {
    const url = capturedUrlForPart(map, part.path);
    if (url) return { ...part, url, source: /** @type {'player'} */ ('player') };
    return { ...part, url: '', source: /** @type {'missing'} */ ('missing') };
  });
}

/**
 * @param {'already-playing' | 'seek-timeout' | 'no-new-request'} kind
 * @param {number} index
 * @param {unknown} path
 * @returns {string}
 */
export function partUrlFallbackReason(kind, index, path) {
  const number = index + 1;
  const file = partFileKey(path) || `chapter ${number}`;
  if (kind === 'already-playing') {
    return `Chapter ${number}: the player was already on this part and did not request it again; using the URL already captured (${file})`;
  }
  if (kind === 'seek-timeout') {
    return `Chapter ${number}: seek timed out with no new audio request; using the URL already captured (${file})`;
  }
  return `Chapter ${number}: no new audio request after seek; using the URL already captured (${file})`;
}

/**
 * Bound a seek that may never settle when the part is already buffered.
 * @param {() => unknown} work
 * @param {number} timeoutMs
 * @param {(ms: number) => Promise<void>} sleep
 * @returns {Promise<{ timedOut: boolean, value: unknown }>}
 */
export function withDeadline(work, timeoutMs, sleep) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    Promise.resolve()
      .then(work)
      .then(
        (value) => finish({ timedOut: false, value }),
        () => finish({ timedOut: false, value: undefined })
      );
    Promise.resolve()
      .then(() => sleep(timeoutMs))
      .then(() => finish({ timedOut: true, value: undefined }));
  });
}

/**
 * Seek one part and wait for the URL the player actually requests.
 * A seek to the part already playing, or to a part the player has
 * prefetched, often produces no new audio request. knownUrl is that
 * earlier capture and is used when the wait ends without a new one.
 * The seek itself is bounded so a promise that never settles cannot stall.
 * @param {{
 *   part: { index: number, path: string },
 *   readEntries: () => unknown,
 *   readAudioSrc?: () => string,
 *   seek: (part: { index: number, path: string }) => unknown,
 *   seekAway?: (part: { index: number, path: string }) => unknown,
 *   knownUrl?: string,
 *   beforeSeek?: () => void | Promise<void>,
 *   sleep?: (ms: number) => Promise<void>,
 *   waitMs?: number,
 * }} input
 */
export async function waitForPartUrl({
  part,
  readEntries,
  readAudioSrc,
  seek,
  seekAway,
  knownUrl = '',
  beforeSeek,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  waitMs = 2500,
}) {
  const mapBefore = mergePerformanceMediaUrls(new Map(), readEntries());
  const remembered =
    (typeof knownUrl === 'string' && isSignedMediaUrl(knownUrl) ? knownUrl : '') ||
    capturedUrlForPart(mapBefore, part.path) ||
    (readAudioSrc ? mediaUrlForPart(readAudioSrc(), part.path) : '');
  if (beforeSeek) await beforeSeek();

  const readNow = () => {
    const map = mergePerformanceMediaUrls(new Map(), readEntries());
    return capturedUrlForPart(map, part.path) || (readAudioSrc ? mediaUrlForPart(readAudioSrc(), part.path) : '');
  };
  const poll = async (budgetMs) => {
    const polls = Math.max(1, Math.ceil(budgetMs / 100));
    for (let attempt = 0; attempt < polls; attempt++) {
      const url = readNow();
      if (url) return url;
      if (attempt < polls - 1) await sleep(100);
    }
    return '';
  };

  const seekResult = await withDeadline(() => seek(part), waitMs, sleep);
  if (!seekResult.timedOut && seekResult.value !== false) {
    const fresh = await poll(Math.min(600, waitMs));
    if (fresh) return { url: fresh, source: 'player', reason: '' };
    if (seekAway) {
      await withDeadline(() => seekAway(part), waitMs, sleep);
      await sleep(Math.min(200, waitMs));
      await withDeadline(() => seek(part), waitMs, sleep);
      const nudged = await poll(waitMs);
      if (nudged) return { url: nudged, source: 'player', reason: '' };
    }
  }

  if (remembered) {
    const kind = seekResult.timedOut ? 'seek-timeout' : 'already-playing';
    return {
      url: remembered,
      source: 'cached',
      reason: partUrlFallbackReason(kind, part.index, part.path),
    };
  }
  if (seekResult.timedOut) {
    const file = partFileKey(part.path) || `chapter ${part.index + 1}`;
    return {
      url: '',
      source: 'missing',
      reason: `Chapter ${part.index + 1}: seek timed out and the player has no URL for ${file}`,
    };
  }
  if (seekResult.value === false) {
    return { url: '', source: 'missing', reason: partUrlMissReason('seek-unavailable', part.index, part.path) };
  }
  return { url: '', source: 'missing', reason: partUrlMissReason('not-requested', part.index, part.path) };
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
