(() => {
  if (globalThis["__libbyDownloaderContent"]) return;
  globalThis["__libbyDownloaderContent"] = true;
/**
 * Content script for Libby loan pages. Routes the player iframe, this page,
 * and the background worker.
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
 * Shared validators for Libby Downloader.
 * Ported from pdugan20/libby-downloader (MIT).
 * Copyright (c) 2026 libby-downloader contributors.
 */

const VALID_ORIGIN_PATTERNS = [
  /^https:\/\/([a-z0-9-]+\.)?listen\.libbyapp\.com$/,
  /^https:\/\/([a-z0-9-]+\.)?thunder\.libbyapp\.com$/,
  /^https:\/\/([a-z0-9-]+\.)?libbyapp\.com$/,
];

/**
 * @param {string} origin
 * @returns {boolean}
 */
function validateOrigin(origin) {
  if (typeof window !== 'undefined' && origin === window.location.origin) {
    return true;
  }
  return VALID_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

/**
 * @param {unknown} bookData
 * @returns {bookData is { metadata: { title: string, authors: unknown[] }, chapters: Array<{ index: number, title: string, url: string, duration: number }> }}
 */
function validateBookData(bookData) {
  if (!bookData || typeof bookData !== 'object') return false;

  const data = /** @type {Record<string, unknown>} */ (bookData);
  if (!data.metadata || typeof data.metadata !== 'object') return false;

  const metadata = /** @type {Record<string, unknown>} */ (data.metadata);
  const chapters = data.chapters;

  if (!metadata.title || typeof metadata.title !== 'string') return false;
  if (!Array.isArray(metadata.authors)) return false;
  if (!Array.isArray(chapters) || chapters.length === 0) return false;

  const firstChapter = /** @type {Record<string, unknown>} */ (chapters[0]);
  if (
    typeof firstChapter.index !== 'number' ||
    typeof firstChapter.title !== 'string' ||
    typeof firstChapter.url !== 'string' ||
    typeof firstChapter.duration !== 'number'
  ) {
    return false;
  }

  return true;
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
 * True when a wait has run long enough. Callers check this from
 * animation frames, because Safari may not run setTimeout while a
 * message or a player seek is outstanding.
 * @param {number} startedAt
 * @param {number} now
 * @param {number} limitMs
 * @returns {boolean}
 */
function refreshTimedOut(startedAt, now, limitMs) {
  return typeof startedAt === 'number' && typeof now === 'number' && now - startedAt >= limitMs;
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
 * What the loan page should say when the start-download reply is empty.
 * Safari drops a runtime.sendMessage reply that stays open for the whole
 * book. The promise resolves with no payload, and the old alert was the
 * bare string "Download failed".
 * Copyright (c) 2026 libby-downloader contributors.
 */

/**
 * @param {unknown} response
 * @returns {string} Empty when the download was accepted or finished.
 */
function explainDownloadStartFailure(response) {
  if (response == null || typeof response !== 'object') {
    return (
      'Download failed: Safari closed the extension message before the save finished ' +
      'and returned no error. Chapters already reported as saved are on disk; the rest were interrupted.'
    );
  }
  if (/** @type {{ success?: unknown }} */ (response).success) return '';
  const reason = /** @type {{ error?: unknown }} */ (response).error;
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  return 'Download failed: the extension reported failure without a reason.';
}


const ext = globalThis.browser ?? globalThis.chrome;

const ui = {
  iframe: /** @type {HTMLIFrameElement | null} */ (null),
};

function log(...args) {
  console.log('[Libby Downloader]', ...args);
}

function setIframe(iframe) {
  ui.iframe = iframe;
}

function iframeOrigin(iframe) {
  try {
    return new URL(iframe.src).origin;
  } catch {
    return 'https://listen.libbyapp.com';
  }
}

function sendIframeMessage(type, state, data) {
  if (!ui.iframe?.contentWindow) {
    log('Cannot update the player yet');
    return;
  }
  ui.iframe.contentWindow.postMessage({ type, state, data }, iframeOrigin(ui.iframe));
}

function updateState(state, data) {
  if (state === 'extracting') {
    sendIframeMessage(MessageTypes.UPDATE_PROGRESS_UI, 'extracting');
    return;
  }
  if (state === 'downloading') {
    const completed = data?.completed ?? 0;
    const total = data?.total ?? 0;
    sendIframeMessage(MessageTypes.UPDATE_PROGRESS_UI, 'downloading', {
      completed,
      total,
      message: data?.message || `Downloading ${completed} of ${total} chapters`,
    });
    return;
  }
  if (state === 'success') {
    sendIframeMessage(MessageTypes.UPDATE_PROGRESS_UI, 'success', {
      failedChapters: data?.failedChapters ?? 0,
      detail: data?.detail || '',
    });
    return;
  }
  sendIframeMessage(MessageTypes.RESET_UI);
}

function showError(message) {
  const text = message || 'Download failed: no reason was provided';
  console.error('[Libby Downloader]', text);
  alert(`Libby Downloader: ${text}`);
  updateState('error');
}

function resetAfterDelay() {
  setTimeout(() => updateState('ready'), 3000);
}

let extractionTimeout = /** @type {number | null} */ (null);
let fallbackPosted = false;

function findPlayerFrame() {
  for (const iframe of Array.from(document.getElementsByTagName('iframe'))) {
    if (iframe.src && iframe.src.includes('listen.libbyapp.com')) return iframe;
  }
  return null;
}

function requestExtraction(iframe) {
  updateState('extracting');
  if (iframe.contentWindow) {
    iframe.contentWindow.postMessage({ type: MessageTypes.EXTRACT_LIBBY_BOOK }, iframeOrigin(iframe));
  }
  // Seeking the player through every unread part can take longer than the
  // old metadata-only extract. 31 parts at a short gap still fit in 3 minutes.
  extractionTimeout = window.setTimeout(() => {
    showError('Could not read the book from the player. Play the audiobook for a few seconds, then try again.');
  }, 20000);
}

function postFallbackToPlayer(book, startIndex, reason) {
  if (fallbackPosted) {
    log('Page fallback already sent to the player');
    return;
  }
  fallbackPosted = true;
  const text = `Page fallback: ${reason || 'no reason provided'}`;
  log(text);
  updateState('downloading', {
    completed: startIndex,
    total: Array.isArray(book?.chapters) ? book.chapters.length : 0,
    message: text.slice(0, 180),
  });
  sendIframeMessage(MessageTypes.DOWNLOAD_FALLBACK, null, {
    book,
    startIndex,
    reason: reason || 'no reason provided',
  });
}

function handleButtonClick() {
  try {
    fallbackPosted = false;
    log('Download button clicked');
    const iframe = findPlayerFrame();
    if (!iframe) throw new Error('Could not find the audiobook player on this page.');
    setIframe(iframe);
    requestExtraction(iframe);
  } catch (error) {
    showError(error instanceof Error ? error.message : 'Could not find the audiobook player.');
  }
}

async function handleExtractionSuccess(bookData) {
  if (extractionTimeout !== null) clearTimeout(extractionTimeout);
  if (!validateBookData(bookData)) {
    showError('The player returned incomplete book data.');
    return;
  }

  updateState('downloading', {
    completed: 0,
    total: bookData.chapters.length,
    message: `Starting download of ${bookData.chapters.length} chapters`,
  });
  try {
    // The reply only means the save was accepted. Waiting here for every
    // chapter kept the message channel open until Safari dropped it and the
    // alert became "Download failed" with no reason.
    const response = await ext.runtime.sendMessage({
      type: MessageTypes.START_DOWNLOAD,
      data: bookData,
    });
    const failure = explainDownloadStartFailure(response);
    if (failure) {
      showError(failure);
      return;
    }
    if (response.accepted) {
      log('Download accepted. Each chapter asks the player for a fresh URL, then saves.');
      return;
    }
    log(
      `Save decision: ${response.selected || '?'} → ${response.strategy || '?'}. ${response.reason || 'no reason provided'}`
    );
    if (response.fallback) {
      postFallbackToPlayer(
        bookData,
        Number.isInteger(response.startIndex) ? response.startIndex : 0,
        response.reason
      );
    }
  } catch (error) {
    showError(error instanceof Error ? error.message : 'Download failed: the extension message was rejected');
  }
}

function handleExtractionError(error) {
  if (extractionTimeout !== null) clearTimeout(extractionTimeout);
  showError(`Extraction failed: ${error}`);
}

const pendingRefresh = new Map();

function requestPlayerUrl(index, attempt = 0) {
  const iframe = ui.iframe || findPlayerFrame();
  if (iframe) setIframe(iframe);
  if (!ui.iframe?.contentWindow) {
    return Promise.resolve({
      ok: false,
      error: `Chapter ${index + 1}: the audiobook player is not open`,
    });
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const pending = {
      settled: false,
      timer: 0,
      frame: 0,
      finish(result) {
        if (pending.settled) return;
        pending.settled = true;
        clearTimeout(pending.timer);
        if (pending.frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pending.frame);
        pendingRefresh.delete(index);
        if (result?.ok && result.url) {
          console.log(
            '[Libby Downloader]',
            `Received player URL for chapter ${index + 1} (${partFileKey(result.url)})`
          );
        } else {
          console.error(
            '[Libby Downloader]',
            result?.error || `Chapter ${index + 1}: player URL was empty`
          );
        }
        resolve(result);
      },
    };
    const giveUp = () => {
      pending.finish({
        ok: false,
        error: `Chapter ${index + 1}: timed out after 12000ms waiting for the player URL`,
      });
    };
    const tick = () => {
      if (!pendingRefresh.get(index) || pending.settled) return;
      if (refreshTimedOut(started, Date.now(), 12000)) {
        giveUp();
        return;
      }
      if (typeof requestAnimationFrame === 'function') pending.frame = requestAnimationFrame(tick);
    };
    pendingRefresh.set(index, pending);
    pending.timer = setTimeout(giveUp, 12000);
    if (typeof requestAnimationFrame === 'function') pending.frame = requestAnimationFrame(tick);
    ui.iframe.contentWindow.postMessage(
      { type: MessageTypes.REFRESH_CHAPTER_URL, index, attempt },
      iframeOrigin(ui.iframe)
    );
  });
}

function handleWindowMessage(event) {
  if (!validateOrigin(event.origin)) return;
  const { type, data, error, progress, result, index } = event.data || {};
  if (type === MessageTypes.REFRESH_CHAPTER_URL_RESULT) {
    const pending = pendingRefresh.get(index);
    if (!pending) return;
    pending.finish({
      ok: event.data.ok === true && isAllowedChapterURL(event.data.url),
      url: event.data.url,
      error: event.data.error || (event.data.url ? '' : `Chapter ${index + 1}: player URL is empty`),
    });
    return;
  }

  if (type === MessageTypes.LIBBY_DOWNLOADER_BUTTON_CLICKED) {
    handleButtonClick();
    return;
  }
  if (type === MessageTypes.EXTRACTION_PROGRESS) {
    log('Player', data?.message || '');
    updateState('downloading', {
      completed: data?.completed || 0,
      total: data?.total || 0,
      message: data?.message || 'Reading player chapter URLs...',
    });
    return;
  }
  if (type === MessageTypes.EXTRACTION_SUCCESS && data) {
    handleExtractionSuccess(data);
    return;
  }
  if (type === MessageTypes.EXTRACTION_ERROR && error) {
    handleExtractionError(error);
    return;
  }
  if (type === MessageTypes.FALLBACK_PROGRESS && progress) {
    updateState('downloading', progress);
    return;
  }
  if (type === MessageTypes.FALLBACK_DONE && result) {
    updateState('success', {
      failedChapters: result.failed,
      completedChapters: result.completed,
      totalChapters: result.total,
      detail: result.detail,
    });
    resetAfterDelay();
    return;
  }
  if (type === MessageTypes.FALLBACK_ERROR && error) {
    showError(error);
  }
}

function handleBackgroundMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === MessageTypes.DOWNLOAD_PROGRESS) {
    log(
      'Progress',
      message.progress?.completed ?? 0,
      'of',
      message.progress?.total ?? 0,
      message.progress?.message || ''
    );
    updateState('downloading', message.progress);
    return;
  }
  if (message.type === MessageTypes.CHAPTER_FAILED) {
    const text = message.error || 'Chapter download failed';
    console.error('[Libby Downloader]', text);
    updateState('downloading', {
      completed: message.progress?.completed ?? 0,
      total: message.progress?.total ?? 0,
      message: text,
    });
    return;
  }
  if (message.type === MessageTypes.DOWNLOAD_FAILED) {
    showError(message.error || 'Download failed: no reason was provided');
    return;
  }
  if (message.type === MessageTypes.DOWNLOAD_FALLBACK && message.data) {
    console.error('[Libby Downloader] Page fallback:', message.reason || 'no reason provided');
    postFallbackToPlayer(
      message.data,
      Number.isInteger(message.startIndex) ? message.startIndex : 0,
      message.reason
    );
    return;
  }
  if (message.type === MessageTypes.DOWNLOAD_COMPLETE) {
    const failed = message.result?.failed ?? 0;
    const detail = message.result?.detail || '';
    if (failed > 0) {
      const text = detail || `${failed} chapters failed`;
      console.error('[Libby Downloader]', text);
      alert(`Libby Downloader: ${failed} of ${message.result?.total ?? '?'} chapters failed. ${text}`);
    }
    updateState('success', {
      completedChapters: message.result?.completed ?? 0,
      failedChapters: failed,
      totalChapters: message.result?.total ?? 0,
      detail,
    });
    resetAfterDelay();
  }
}

if (!window.location.pathname.includes('/open/loan/')) {
  log('Not an audiobook loan page');
} else {
  window.addEventListener('message', handleWindowMessage);
  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MessageTypes.REFRESH_CHAPTER_URL) {
      requestPlayerUrl(message.index, message.attempt)
        .then((result) => sendResponse(result))
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'Could not read the player URL',
          });
        });
      return true;
    }
    handleBackgroundMessage(message);
    return false;
  });
  log('Ready');
}
})();
