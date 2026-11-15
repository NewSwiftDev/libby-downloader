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
/**
 * Match a spine path to a player filename. Libby often requests
 * `{uuid}Fmt425-Part22.mp3` while the spine path is only the tail.
 * @param {Map<string, string>} map
 * @param {unknown} partPath
 * @returns {string}
 */
export function findPlayerUrl(map, partPath) {
  const file = partFileKey(partPath);
  if (!file || !map || typeof map.get !== 'function') return '';
  const exact = map.get(file);
  if (typeof exact === 'string' && isSignedMediaUrl(exact)) return exact;
  for (const [key, url] of map) {
    if (typeof key !== 'string' || typeof url !== 'string' || !isSignedMediaUrl(url)) continue;
    if (key.endsWith(file) || file.endsWith(key)) return url;
  }
  return '';
}

/**
 * Post a result on every channel. One throw must not skip the others.
 * @param {unknown} payload
 * @param {Record<string, (payload: unknown) => void>} targets
 * @returns {{ sent: string[], errors: string[] }}
 */
export function fanOutPlayerResult(payload, targets) {
  const sent = [];
  const errors = [];
  if (!targets || typeof targets !== 'object') return { sent, errors };
  for (const [name, post] of Object.entries(targets)) {
    if (typeof post !== 'function') continue;
    try {
      post(payload);
      sent.push(name);
    } catch {
      errors.push(name);
    }
  }
  return { sent, errors };
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
    const url = findPlayerUrl(map, part.path);
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
/**
 * A captured signature is enough on the first try. Seeking the part again
 * only happens when that signature was rejected or never seen. Libby's seek
 * can stay "underway" and block the save if we start one we do not need.
 * @param {unknown} knownUrl
 * @param {number} [attempt]
 * @returns {boolean}
 */
export function shouldSeekForUrl(knownUrl, attempt = 0) {
  if (typeof attempt === 'number' && attempt > 0) return true;
  return !isSignedMediaUrl(knownUrl);
}

/**
 * Ready means a signed player URL. An empty string is not ready.
 * @param {number} chapterNumber 1-based
 * @param {{ url?: string, source?: string, reason?: string }} found
 * @returns {{ ready: boolean, line: string }}
 */
export function describeReadyChapter(chapterNumber, found) {
  const url = found && typeof found.url === 'string' ? found.url : '';
  if (!isSignedMediaUrl(url)) {
    const line =
      found && typeof found.reason === 'string' && found.reason
        ? found.reason
        : `Chapter ${chapterNumber}: player URL is empty`;
    return { ready: false, line };
  }
  const how = found.source === 'cached' ? 'already requested' : 'fresh request';
  return {
    ready: true,
    line: `Player URL ready for chapter ${chapterNumber} (${how}, ${partFileKey(url)})`,
  };
}

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
 * One deadline for a single task. Seek, native save, and chapter fetch all use this.
 * @param {(signal: AbortSignal) => Promise<unknown> | unknown} work
 * @param {number} timeoutMs
 * @param {string} label
 */
export function withTimeout(work, timeoutMs, label) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const task = Promise.resolve()
    .then(() => work(controller.signal))
    .finally(() => clearTimeout(timer));
  return Promise.race([task, timeout]);
}

/**
 * @param {() => unknown} work
 * @param {number} timeoutMs
 */
async function bounded(work, timeoutMs) {
  try {
    return { timedOut: false, value: await withTimeout(work, timeoutMs, 'seek') };
  } catch (error) {
    if (error instanceof Error && /timed out/i.test(error.message)) {
      return { timedOut: true, value: undefined };
    }
    throw error;
  }
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
    findPlayerUrl(mapBefore, part.path) ||
    (readAudioSrc ? mediaUrlForPart(readAudioSrc(), part.path) : '');
  if (beforeSeek) await beforeSeek();

  const readNow = () => {
    const map = mergePerformanceMediaUrls(new Map(), readEntries());
    return findPlayerUrl(map, part.path) || (readAudioSrc ? mediaUrlForPart(readAudioSrc(), part.path) : '');
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

  const seekResult = await bounded(() => seek(part), waitMs);
  if (!seekResult.timedOut && seekResult.value !== false) {
    const fresh = await poll(Math.min(600, waitMs));
    // The audio element can still show the URL we already had while a new
    // seek is underway. That is not a new request.
    if (fresh && fresh !== remembered) return { url: fresh, source: 'player', reason: '' };
    if (seekAway && !remembered) {
      await bounded(() => seekAway(part), waitMs);
      await sleep(Math.min(200, waitMs));
      await bounded(() => seek(part), waitMs);
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
