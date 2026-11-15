(() => {
  if (globalThis["__libbyDownloaderUi"]) return;
  globalThis["__libbyDownloaderUi"] = true;
/**
 * Player-frame UI. Isolated world: injects the download button and, when
 * the containing app cannot write files, fetches chapters with the page
 * cookies and hands blobs to Safari's download manager as flat files.
 * Ported from pdugan20/libby-downloader (MIT).
 * Copyright (c) 2026 libby-downloader contributors.
 */

/**
 * Message names shared by the background worker, content script, and player frame.
 * Ported from pdugan20/libby-downloader (MIT).
 * Copyright (c) 2026 libby-downloader contributors.
 */

const MessageTypes = {
  EXTRACT_LIBBY_BOOK: 'EXTRACT_LIBBY_BOOK',
  EXTRACTION_PROGRESS: 'EXTRACTION_PROGRESS',
  EXTRACTION_SUCCESS: 'EXTRACTION_SUCCESS',
  EXTRACTION_ERROR: 'EXTRACTION_ERROR',
  START_DOWNLOAD: 'START_DOWNLOAD',
  DOWNLOAD_PROGRESS: 'DOWNLOAD_PROGRESS',
  DOWNLOAD_COMPLETE: 'DOWNLOAD_COMPLETE',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  CHAPTER_FAILED: 'CHAPTER_FAILED',
  REFRESH_CHAPTER_URL: 'REFRESH_CHAPTER_URL',
  REFRESH_CHAPTER_URL_RESULT: 'REFRESH_CHAPTER_URL_RESULT',
  PLAYER_URL_READY: 'PLAYER_URL_READY',
  DOWNLOAD_FALLBACK: 'DOWNLOAD_FALLBACK',
  GET_DOWNLOAD_STATUS: 'GET_DOWNLOAD_STATUS',
  GET_STATE: 'GET_STATE',
  LIBBY_DOWNLOADER_BUTTON_CLICKED: 'LIBBY_DOWNLOADER_BUTTON_CLICKED',
  UPDATE_PROGRESS_UI: 'UPDATE_PROGRESS_UI',
  RESET_UI: 'RESET_UI',
  FALLBACK_PROGRESS: 'FALLBACK_PROGRESS',
  FALLBACK_DONE: 'FALLBACK_DONE',
  FALLBACK_ERROR: 'FALLBACK_ERROR',
  ORGANIZE_CHAPTER: 'ORGANIZE_CHAPTER',
  ORGANIZE_METADATA: 'ORGANIZE_METADATA',
};

/**
 * Download paths shared by the Chrome extension and the Safari port.
 * Ported from pdugan20/libby-downloader (MIT).
 * Copyright (c) 2026 libby-downloader contributors.
 */

const DOWNLOADS_SUBDIRECTORY = 'libby-downloads';
const APP_GROUP_ID = 'group.com.libbydownloader.safari';

/**
 * Make a single path segment safe for macOS, iOS, and Windows.
 * Slashes are turned into dashes before ".." is folded, so the result
 * cannot escape the book folder.
 * @param {unknown} filename
 * @returns {string}
 */
function sanitizeFilename(filename) {
  const cleaned = String(filename ?? '')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\.\./g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .substring(0, 200)
    .trim();
  return cleaned || 'Untitled';
}

/**
 * @param {number} index Zero-based chapter index.
 * @returns {string} chapter-001.mp3
 */
function chapterBasename(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('Chapter index must be a non-negative integer');
  }
  return `chapter-${String(index + 1).padStart(3, '0')}.mp3`;
}

/** Path relative to the libby-downloads root. */
function chapterRelativePath(title, index) {
  return `${sanitizeFilename(title)}/${chapterBasename(index)}`;
}

/** Path relative to the libby-downloads root. */
function metadataRelativePath(title) {
  return `${sanitizeFilename(title)}/metadata.json`;
}

/**
 * chrome.downloads filenames are relative to ~/Downloads, so they include
 * the libby-downloads directory. Native messages are relative to that root.
 * @param {string} relativePath
 */
function chromeDownloadFilename(relativePath) {
  const contained = containedRelativePath(relativePath);
  if (!contained) {
    throw new Error('Unsafe download path');
  }
  return `${DOWNLOADS_SUBDIRECTORY}/${contained}`;
}

/** Safari's download manager cannot create folders, so fallback names are flat. */
function flatDownloadFilename(title, index) {
  return `${sanitizeFilename(title)} - ${chapterBasename(index)}`;
}

function flatMetadataFilename(title) {
  return `${sanitizeFilename(title)} - metadata.json`;
}

/**
 * Accept only a relative path with no parent segments.
 * @param {unknown} relativePath
 * @returns {string | null}
 */
function containedRelativePath(relativePath) {
  if (typeof relativePath !== 'string') return null;
  const trimmed = relativePath.trim();
  if (!trimmed || trimmed.includes('\\') || trimmed.startsWith('/') || trimmed.startsWith('~')) {
    return null;
  }
  const parts = trimmed.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  if (parts.some((part) => part.startsWith('.') || /[\u0000-\u001f]/.test(part))) return null;
  return parts.join('/');
}

/**
 * Chapter URLs are only fetched from Libby and the OverDrive CDN Libby
 * redirects to. audioclips.cdn.overdrive.com answers with
 * Access-Control-Allow-Origin: *, so a credentialed page fetch is rejected.
 * Keep this host list in sync with DownloadStore.isAllowedFetchHost.
 * Copyright (c) 2026 libby-downloader contributors.
 */

const CHAPTER_HOST_SUFFIXES = ['libbyapp.com', 'cdn.overdrive.com'];

/**
 * @param {unknown} hostname
 * @returns {boolean}
 */
function isAllowedChapterHost(hostname) {
  if (typeof hostname !== 'string' || !hostname) return false;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return CHAPTER_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * @param {unknown} urlString
 * @returns {boolean}
 */
function isAllowedChapterURL(urlString) {
  if (typeof urlString !== 'string' || !urlString) return false;
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return isAllowedChapterHost(url.hostname);
}

/**
 * Page fetches must omit cookies. The signed listen.libbyapp.com URL
 * redirects to the OverDrive CDN, and a credentialed request cannot use
 * that host's wildcard CORS header.
 * @returns {'omit'}
 */
function chapterFetchCredentials() {
  return 'omit';
}

/**
 * Build a Cookie header from extension cookies.getAll results.
 * Drops values that could inject headers. An oversized header is omitted
 * so the native app can still try the URL, and the page-cookie fallback
 * remains available.
 * @param {unknown} cookies
 * @returns {string}
 */
function formatCookieHeader(cookies) {
  if (!Array.isArray(cookies)) return '';
  const parts = [];
  for (const cookie of cookies) {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') continue;
    if (!cookie.name || /[\r\n;]/.test(cookie.name) || /[\r\n]/.test(cookie.value)) continue;
    parts.push(`${cookie.name}=${cookie.value}`);
  }
  const header = parts.join('; ');
  if (header.length > 16384) return '';
  return header;
}

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


/**
 * Last path segment, decoded, so `{uuid}Fmt425-Part24.mp3` matches a
 * percent-encoded player URL.
 * @param {unknown} pathOrUrl
 * @returns {string}
 */
function partFileKey(pathOrUrl) {
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
function isSignedMediaUrl(urlString) {
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
function mergePerformanceMediaUrls(map, entries) {
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
function findPlayerUrl(map, partPath) {
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
function fanOutPlayerResult(payload, targets) {
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
function mediaUrlForPart(src, partPath) {
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
function prepareResourceTiming(perf, minimum) {
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
function partUrlMissReason(kind, index, path) {
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
function urlsFromCurrentEntries(parts, entries) {
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
function shouldSeekForUrl(knownUrl, attempt = 0) {
  if (typeof attempt === 'number' && attempt > 0) return true;
  return !isSignedMediaUrl(knownUrl);
}

/**
 * Ready means a signed player URL. An empty string is not ready.
 * @param {number} chapterNumber 1-based
 * @param {{ url?: string, source?: string, reason?: string }} found
 * @returns {{ ready: boolean, line: string }}
 */
function describeReadyChapter(chapterNumber, found) {
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

function partUrlFallbackReason(kind, index, path) {
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
function withTimeout(work, timeoutMs, label) {
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
async function waitForPartUrl({
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
function formatChapterFailure(index, error, url = '') {
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
function pageFallbackReason(failure) {
  const text = typeof failure === 'string' ? failure.trim() : '';
  return text || 'The chapter download failed';
}

/**
 * In-page chapter fetch used when the containing app cannot write files.
 * Each chapter has a timeout so a hung CDN request cannot stall the book.
 * Retry counts match DownloadStore.maxChapterAttempts.
 * Copyright (c) 2026 libby-downloader contributors.
 */


{ withTimeout };

/** One retry. Keep in sync with DownloadStore.maxChapterAttempts. */
const CHAPTER_FETCH_ATTEMPTS = 2;

const RETRYABLE_CHAPTER_STATUSES = new Set([429, 500, 502, 503]);

/**
 * @param {unknown} status
 * @returns {boolean}
 */
function isRetryableChapterStatus(status) {
  return typeof status === 'number' && RETRYABLE_CHAPTER_STATUSES.has(status);
}

/**
 * @param {number} attempt Zero-based attempt that just failed.
 * @returns {number}
 */
function chapterRetryDelayMs(attempt) {
  return 1000 * (attempt + 1);
}

/**
 * @template T
 * @param {(attempt: number) => Promise<T>} run
 * @param {{ attempts?: number, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<T>}
 */
async function withChapterRetries(run, { attempts = CHAPTER_FETCH_ATTEMPTS, sleep } = {}) {
  const pause = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await run(attempt);
    } catch (error) {
      lastError = error;
      const status = error && typeof error === 'object' ? /** @type {{ status?: unknown }} */ (error).status : undefined;
      if (attempt >= attempts - 1 || !isRetryableChapterStatus(status)) throw error;
      await pause(chapterRetryDelayMs(attempt));
    }
  }
  throw lastError;
}

/**
 * Fetch one chapter URL. credentials and redirect are the caller's choice.
 * A retryable HTTP status is tried once more; other statuses fail immediately.
 * @param {{
 *   url: string,
 *   index: number,
 *   fetchImpl: (url: string, options: { signal?: AbortSignal }) => Promise<{ ok?: boolean, status?: number }>,
 *   signal?: AbortSignal,
 *   attempts?: number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} input
 */
async function fetchChapterResponse({ url, index, fetchImpl, signal, attempts, sleep }) {
  let host = 'invalid-url';
  try {
    host = new URL(url).host;
  } catch {
    host = 'invalid-url';
  }
  return withChapterRetries(
    async () => {
      const response = await fetchImpl(url, { signal });
      if (!response || response.ok !== true) {
        const status = response && typeof response.status === 'number' ? response.status : 0;
        const error = /** @type {Error & { status?: number }} */ (
          new Error(formatChapterFailure(index, { status, message: `HTTP ${status} from ${host}` }, url))
        );
        error.status = status;
        throw error;
      }
      return response;
    },
    { attempts, sleep }
  );
}

/**
 * @param {{
 *   chapters: Array<{ url?: string }>,
 *   startIndex?: number,
 *   fetchChapter: (chapter: { url?: string }, index: number, signal: AbortSignal) => Promise<unknown>,
 *   timeoutMs?: number,
 *   delayMs?: number,
 *   onChapter?: (event: {
 *     phase: 'start' | 'saved' | 'error',
 *     index: number,
 *     total: number,
 *     completed?: number,
 *     message?: string,
 *     url?: string,
 *   }) => void,
 * }} input
 */
async function runPageFallback({
  chapters,
  startIndex = 0,
  fetchChapter,
  timeoutMs = 120000,
  delayMs = 500,
  onChapter,
}) {
  const total = Array.isArray(chapters) ? chapters.length : 0;
  const errors = [];
  let saved = 0;
  let failed = 0;
  const begin = Number.isInteger(startIndex) && startIndex > 0 ? startIndex : 0;

  for (let index = begin; index < total; index++) {
    const chapter = chapters[index] || {};
    onChapter?.({ phase: 'start', index, total, url: chapter.url });
    try {
      await withTimeout(
        (signal) => fetchChapter(chapter, index, signal),
        timeoutMs,
        `Chapter ${index + 1}`
      );
      saved += 1;
      onChapter?.({ phase: 'saved', index, total, completed: begin + saved });
      if (delayMs > 0 && index < total - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error && error.message ? error.message : 'Unknown error';
      errors.push({ index, message });
      onChapter?.({ phase: 'error', index, total, message });
    }
  }

  return { completed: saved, failed, total, errors };
}


const ext = globalThis.browser ?? globalThis.chrome;

console.log('[Libby Downloader] Iframe UI loaded');

let progressOverlay = null;

function findAlbumArtContainer() {
  const selectors = [
    '.backdrop-cover-button',
    '.slingshot',
    '.title-tile-cover',
    '.title-tile',
    '.player-art',
    '.album-art',
  ];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element) return element;
  }
  return null;
}

function createProgressOverlay() {
  if (progressOverlay) return;
  if (!findAlbumArtContainer()) {
    console.warn('[Libby Downloader] Album art not found');
  }
  const overlay = document.createElement('div');
  overlay.className = 'libby-download-progress-overlay';
  const progressContainer = document.createElement('div');
  progressContainer.className = 'libby-progress-container';
  const progressBar = document.createElement('div');
  progressBar.className = 'libby-progress-bar';
  const progressFill = document.createElement('div');
  progressFill.className = 'libby-progress-fill';
  progressBar.appendChild(progressFill);
  const progressText = document.createElement('div');
  progressText.className = 'libby-progress-text';
  progressText.textContent = 'Preparing download...';
  progressContainer.appendChild(progressBar);
  progressContainer.appendChild(progressText);
  overlay.appendChild(progressContainer);
  document.body.appendChild(overlay);
  progressOverlay = overlay;
}

function updateProgressOverlay(completed, total, message) {
  if (!progressOverlay) createProgressOverlay();
  if (!progressOverlay) return;
  const progressFill = progressOverlay.querySelector('.libby-progress-fill');
  const progressText = progressOverlay.querySelector('.libby-progress-text');
  if (progressFill) {
    const percentage = total > 0 ? (completed / total) * 100 : 0;
    progressFill.style.width = `${percentage}%`;
  }
  if (progressText) progressText.textContent = message;
}

function showCompletionMessage(failedChapters, detail) {
  if (!progressOverlay) return;
  const progressText = progressOverlay.querySelector('.libby-progress-text');
  if (!progressText) return;
  progressText.classList.add('libby-completion-message');
  if (failedChapters === 0) {
    progressText.textContent = 'Download complete!';
    return;
  }
  const suffix = detail ? ` ${detail}` : '';
  progressText.textContent = `Download failed: ${failedChapters} errors.${suffix}`.slice(0, 240);
}

function removeProgressOverlay() {
  if (progressOverlay) progressOverlay.remove();
  progressOverlay = null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function chapterHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

let fallbackRun = null;

function playerFrameOwnsDownload() {
  return document.getElementById('libby-downloader-button') != null;
}

function startPageFallback(book, startIndex, reason) {
  if (!playerFrameOwnsDownload()) {
    console.log('[Libby Downloader] Ignoring fallback outside the player frame');
    return;
  }
  if (fallbackRun) {
    console.log('[Libby Downloader] Page fallback already running');
    return;
  }
  fallbackRun = runBlobFallback(book, startIndex, reason).finally(() => {
    fallbackRun = null;
  });
}

async function runBlobFallback(book, startIndex, reason) {
  const chapters = Array.isArray(book?.chapters) ? book.chapters : [];
  const title = book?.metadata?.title || 'Untitled';
  const begin = Number.isInteger(startIndex) ? startIndex : 0;
  console.error('[Libby Downloader] Page download fallback:', reason || 'no reason provided');
  createProgressOverlay();
  const summary = reason ? `Page fallback: ${reason}` : 'Saving through Safari downloads...';
  updateProgressOverlay(begin, chapters.length, summary.slice(0, 180));

  const result = await runPageFallback({
    chapters,
    startIndex: begin,
    timeoutMs: 120000,
    async fetchChapter(chapter, index, signal) {
      if (!isAllowedChapterURL(chapter?.url)) {
        throw new Error('Refusing chapter URL outside Libby');
      }
      // credentials must stay 'omit'. listen.libbyapp.com redirects to
      // audioclips.cdn.overdrive.com, which replies with ACAO: *.
      const response = await fetchChapterResponse({
        url: chapter.url,
        index,
        signal,
        sleep,
        fetchImpl: (nextUrl, options) =>
          fetch(nextUrl, {
            credentials: chapterFetchCredentials(),
            redirect: 'follow',
            signal: options.signal,
          }),
      });
      const flatName = flatDownloadFilename(title, index);
      triggerBlobDownload(await response.blob(), flatName);
      const organized = await ext.runtime.sendMessage({
        type: MessageTypes.ORGANIZE_CHAPTER,
        title,
        index,
      });
      if (!organized?.ok) {
        throw new Error(organized?.error || `Could not move ${flatName} into the book folder`);
      }
    },
    onChapter(event) {
      if (event.phase === 'start') {
        console.log(
          '[Libby Downloader] Fallback chapter',
          event.index + 1,
          'of',
          event.total,
          chapterHost(event.url)
        );
        updateProgressOverlay(
          event.index,
          event.total,
          `Fetching chapter ${event.index + 1} of ${event.total}`
        );
        return;
      }
      if (event.phase === 'saved') {
        updateProgressOverlay(
          event.completed,
          event.total,
          `Saving ${event.completed} of ${event.total} (Safari downloads)`
        );
        window.parent.postMessage(
          {
            type: MessageTypes.FALLBACK_PROGRESS,
            progress: { completed: event.completed, total: event.total },
          },
          '*'
        );
        return;
      }
      console.error(
        '[Libby Downloader] Fallback chapter',
        event.index + 1,
        'failed:',
        event.message
      );
      updateProgressOverlay(event.index, event.total, event.message.slice(0, 240));
    },
  });

  let metadataError = '';
  try {
    const organized = await ext.runtime.sendMessage({
      type: MessageTypes.ORGANIZE_METADATA,
      data: book,
    });
    if (organized?.skipped) {
      console.log('[Libby Downloader] Metadata already written');
    } else if (!organized?.ok) {
      metadataError = organized?.error || 'Could not write metadata.json';
      console.error('[Libby Downloader] Fallback metadata failed:', metadataError);
    } else {
      console.log('[Libby Downloader] Wrote metadata.json once');
    }
  } catch (error) {
    metadataError = error instanceof Error ? error.message : 'metadata failed';
    console.error('[Libby Downloader] Fallback metadata failed', error);
  }

  const lastError = result.errors[result.errors.length - 1]?.message || metadataError;
  showCompletionMessage(result.failed, lastError);
  window.parent.postMessage(
    {
      type: MessageTypes.FALLBACK_DONE,
      result: {
        completed: result.completed,
        failed: result.failed,
        total: result.total,
        detail: lastError,
      },
    },
    '*'
  );
}

window.addEventListener('message', (event) => {
  if (!event.data || typeof event.data !== 'object' || !event.data.type) return;
  const { type, state, data } = event.data;
  if (type === MessageTypes.REFRESH_CHAPTER_URL_RESULT || type === MessageTypes.PLAYER_URL_READY) {
    const index = Number.isInteger(event.data.index) ? event.data.index : 0;
    const file = partFileKey(event.data.url || '');
    console.log(
      '[Libby Downloader]',
      `Forwarded player URL for chapter ${index + 1} to the extension (${file || event.data.error || 'empty'})`
    );
    if (ext?.runtime?.sendMessage) {
      ext.runtime
        .sendMessage({
          type: MessageTypes.PLAYER_URL_READY,
          index,
          ok: event.data.ok === true,
          url: event.data.url,
          error: event.data.error,
        })
        .catch((error) => {
          console.error(
            '[Libby Downloader]',
            `Chapter ${index + 1}: could not tell the extension (${error instanceof Error ? error.message : 'send failed'})`
          );
        });
    }
    return;
  }
  if (type === MessageTypes.UPDATE_PROGRESS_UI) {
    if (state === 'extracting') {
      createProgressOverlay();
      updateProgressOverlay(0, 1, 'Extracting metadata...');
    } else if (state === 'downloading' && data) {
      updateProgressOverlay(data.completed || 0, data.total || 1, data.message || 'Downloading...');
    } else if (state === 'success') {
      showCompletionMessage(data?.failedChapters || 0, data?.detail);
    }
    return;
  }
  if (type === MessageTypes.DOWNLOAD_FALLBACK && data?.book) {
    startPageFallback(data.book, data.startIndex, data.reason);
    return;
  }
  if (type === MessageTypes.RESET_UI) removeProgressOverlay();
});

if (ext?.runtime?.onMessage) {
  ext.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== MessageTypes.DOWNLOAD_FALLBACK || !message.data) return;
    const startIndex = Number.isInteger(message.startIndex) ? message.startIndex : 0;
    console.error(
      '[Libby Downloader] Chapter download failed:',
      message.reason || 'unknown reason'
    );
    startPageFallback(message.data, startIndex, message.reason);
  });
}

function injectDownloadButton() {
  const navBar = document.querySelector('.nav-action-bar-right');
  if (!navBar) {
    setTimeout(injectDownloadButton, 100);
    return;
  }
  if (document.getElementById('libby-downloader-button')) return;

  const container = document.createElement('div');
  container.className = 'nav-action-item';
  container.id = 'libby-downloader-button-container';

  const button = document.createElement('button');
  button.id = 'libby-downloader-button';
  button.className = 'nav-action-item-button halo';
  button.type = 'button';
  button.setAttribute('aria-label', 'Download Audiobook');
  button.setAttribute('touch-action', 'none');

  const iconContainer = document.createElement('div');
  iconContainer.className = 'nav-action-item-icon';
  iconContainer.style.transform = 'scale(0.7)';
  iconContainer.innerHTML =
    '<svg viewBox="0 0 90 66" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path fill="currentColor" d="M45 0C51.9 0 58.8 2.6 64.1 7.9C68.2 12 70.6 17.1 71.5 22.4C82 24.1 90 33.1 90 44C90 56.1 80.1 66 68 66H19C8.5 66 0 57.5 0 47C0 36.8 8.1 28.5 18.2 28.1C17.9 20.8 20.4 13.4 25.9 7.9C31.2 2.6 38.1 0 45 0ZM45 4C39.1 4 33.3 6.2 28.8 10.7C23.5 15.9 21.4 23 22.2 29.8C22.2 30 22.2 30.3 22.1 30.6C22 30.9 21.9 31.1 21.7 31.3C21.5 31.5 21.3 31.7 21 31.8C20.8 31.9 20.5 32 20.2 32H19C10.7 32 4 38.7 4 47C4 55.3 10.7 62 19 62H68C78 62 86 54 86 44C86 34.6 78.8 26.9 69.7 26.1C69.2 26 68.8 25.8 68.4 25.5C68.1 25.2 67.9 24.8 67.8 24.3C67.3 19.3 65.1 14.5 61.3 10.7C56.8 6.2 50.9 4 45 4ZM45 24C46.1 24 47 24.9 47 26V47.5L54.7 40.5C55.4 39.8 56.8 39.9 57.5 40.7C58.2 41.4 58.2 42.8 57.3 43.5L46.3 53.5C46.1 53.8 45.5 54 45 54C44.5 54 44.1 53.9 43.7 53.5L32.7 43.5C31.9 42.8 31.7 41.4 32.5 40.7C33.2 39.9 34.6 39.8 35.3 40.5L43 47.5V26C43 24.9 43.9 24 45 24Z"></path>' +
    '</svg>';

  button.appendChild(iconContainer);
  container.appendChild(button);

  const existingItems = navBar.querySelectorAll('.nav-action-item');
  if (existingItems.length > 0) {
    navBar.insertBefore(container, existingItems[existingItems.length - 1]);
  } else {
    navBar.appendChild(container);
  }

  button.addEventListener('click', () => {
    console.log('[Libby Downloader] Download button clicked');
    window.parent.postMessage({ type: MessageTypes.LIBBY_DOWNLOADER_BUTTON_CLICKED }, '*');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectDownloadButton);
} else {
  injectDownloadButton();
}
})();
