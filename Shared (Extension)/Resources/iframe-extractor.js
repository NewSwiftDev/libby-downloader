(() => {
  if (globalThis["__libbyDownloaderExtractor"]) return;
  globalThis["__libbyDownloaderExtractor"] = true;
/**
 * Player-frame extractor. Runs in the page MAIN world so it can read
 * window.BIF and the media URLs the player requests. Safari needs version
 * 18 or newer for MAIN-world content scripts.
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


console.log('[Libby Downloader] Iframe extractor loaded');

const originalParse = JSON.parse;
window.__odreadCmptParams = window.__odreadCmptParams || null;

JSON.parse = function (text, reviver) {
  const result = originalParse.apply(this, [text, reviver]);
  extractCryptoParams(result, 'JSON.parse');
  return result;
};

const originalResponseJson = Response.prototype.json;
Response.prototype.json = async function () {
  const result = await originalResponseJson.call(this);
  extractCryptoParams(result, 'Response.json');
  return result;
};

const seenPartUrls = new Map();

function noteSeen(url, partPath) {
  if (!isSignedMediaUrl(url)) return;
  const key = partFileKey(partPath) || partFileKey(url);
  if (key) seenPartUrls.set(key, url);
}

function knownFor(part) {
  mergePerformanceMediaUrls(seenPartUrls, readPlayerResourceEntries());
  const src = readAudioSrc();
  if (mediaUrlForPart(src, part.path)) noteSeen(src, part.path);
  return findPlayerUrl(seenPartUrls, part.path);
}

function deliverPartResult(index, result) {
  if (result && result.url) noteSeen(result.url, result.url);
  const payload = { type: MessageTypes.REFRESH_CHAPTER_URL_RESULT, index, ...result };
  const file = result && result.url ? partFileKey(result.url) : '';
  const line = file
    ? `Sent player URL for chapter ${index + 1} to parent (${file})`
    : `Chapter ${index + 1}: sent failure to parent (${(result && result.error) || 'no URL'})`;
  console.log('[Libby Downloader]', line);
  const channels = fanOutPlayerResult(payload, {
    parent(message) {
      window.parent.postMessage(message, '*');
    },
    frame(message) {
      window.postMessage(message, '*');
    },
  });
  if (!channels.sent.length) {
    console.error(
      '[Libby Downloader]',
      `Chapter ${index + 1}: could not post the player URL (${channels.errors.join(', ') || 'no channel'})`
    );
  }
}

window.addEventListener('message', async (event) => {
  const type = event.data?.type;
  if (type === MessageTypes.REFRESH_CHAPTER_URL) {
    const index = event.data.index;
    try {
      const attempt = Number.isInteger(event.data.attempt) ? event.data.attempt : 0;
    const result = await refreshPart(index, attempt);
      deliverPartResult(index, result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Could not read the player URL';
      console.error('[Libby Downloader]', errorMessage);
      deliverPartResult(index, { ok: false, error: errorMessage });
    }
    return;
  }
  if (type !== MessageTypes.EXTRACT_LIBBY_BOOK) return;

  try {
    const bookData = await extractBookData();
    console.log(
      `[Libby Downloader] Extraction complete: "${bookData.metadata.title}" (${bookData.chapters.length} chapters)`
    );
    window.parent.postMessage(
      { type: MessageTypes.EXTRACTION_SUCCESS, data: bookData },
      '*'
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Libby Downloader] Extraction failed:', error);
    window.parent.postMessage(
      { type: MessageTypes.EXTRACTION_ERROR, error: errorMessage },
      '*'
    );
  }
});

async function extractBookData() {
  const BIF = await getBIF();
  if (!BIF) {
    throw new Error('BIF object not found. The audiobook player may not have loaded properly.');
  }

  const components = BIF.objects?.spool?.components;
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error('The audiobook has no audio parts.');
  }

  const creators = BIF.map.creator ?? [];
  const authors = resolveAuthors(creators);
  const narrators = creators
    .filter((creator) => creator.role?.toLowerCase() === 'narrator')
    .map((creator) => creator.name);
  const totalDuration = BIF.map.spine.reduce(
    (sum, spine) => sum + (spine['audio-duration'] || 0),
    0
  );

  let coverUrl = '';
  try {
    const imageElem = BIF.root?.querySelector('image');
    if (imageElem) coverUrl = imageElem.getAttribute('href') || '';
  } catch (error) {
    console.warn('[Libby Downloader] Could not extract cover URL:', error);
  }

  const parts = components.map((spine, index) => partFromSpine(spine, index));
  // Already-buffered media URLs are hints only. Each file is signed again
  // immediately before it is saved, because a 109-part seek finishes long
  // before the later downloads.
  prepareResourceTiming(typeof performance !== 'undefined' ? performance : null, parts.length * 5 + 250);
  const gathered = urlsFromCurrentEntries(parts, readPlayerResourceEntries());

  const chapters = [];
  let cumulativeTime = 0;
  for (const part of gathered) {
    const duration = part.duration || 0;
    const position = part.spinePosition ?? part.index;
    chapters.push({
      index: position,
      title: `Part ${position + 1}`,
      url: part.url,
      duration,
      startTime: cumulativeTime,
    });
    cumulativeTime += duration;
  }

  if (BIF.map.nav?.toc) {
    const spineToIndex = BIF.map.spine.map((item) => item['-odread-original-path']);
    for (const tocChapter of BIF.map.nav.toc) {
      const spinePath = tocChapter.path.split('#')[0];
      const spineIndex = spineToIndex.indexOf(spinePath);
      if (spineIndex !== -1 && chapters[spineIndex]) {
        chapters[spineIndex].title = tocChapter.title;
      }
    }
  }

  return {
    metadata: {
      title: BIF.map.title.main,
      authors,
      narrators,
      duration: Math.round(totalDuration / 60),
      coverUrl,
      description: BIF.map.description,
    },
    chapters,
  };
}

async function getBIF() {
  let BIF = window.BIF;
  if (!BIF && typeof window.getBIF === 'function') {
    BIF = await window.getBIF();
  }
  if (!BIF) {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (window.BIF) {
        BIF = window.BIF;
        break;
      }
      await sleep(500);
    }
  }
  return BIF || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractCryptoParams(result, source) {
  if (!result || typeof result !== 'object') return;
  const params = result.b?.['-odread-cmpt-params'];
  if (!params) return;
  window.__odreadCmptParams = Array.from(params);
  console.log(
    `[Libby Downloader] Saw init crypto parameters via ${source}; chapter URLs come from the player`
  );
}

function partFromSpine(spine, index) {
  return {
    index,
    spinePosition: spine.meta?.['-odread-spine-position'] ?? spine.spinePosition ?? index,
    path: spine.meta?.path || '',
    duration: spine.meta?.['audio-duration'] || spine.meta?.duration || spine.duration || 0,
  };
}

function readPlayerResourceEntries() {
  try {
    return performance.getEntriesByType('resource');
  } catch {
    return [];
  }
}

function readAudioSrc() {
  const media = document.querySelector('audio, video');
  if (!media) return '';
  return media.currentSrc || media.src || '';
}

function seekPlayer(bif, floc) {
  const compass = bif?.objects?.compass;
  if (!compass || typeof compass.at !== 'function') return false;
  try {
    const place = compass.at({ floc });
    if (place && typeof place.seek === 'function') {
      place.seek();
      return true;
    }
  } catch (error) {
    console.warn('[Libby Downloader] Could not seek the player', error);
  }
  return false;
}

function clearResourceTimings() {
  try {
    if (typeof performance.clearResourceTimings === 'function') performance.clearResourceTimings();
  } catch {
    /* The next poll still checks the audio element src. */
  }
}

async function refreshPart(index, attempt = 0) {
  const BIF = await getBIF();
  if (!BIF) {
    return { ok: false, error: 'BIF object not found. The audiobook player may not have loaded properly.' };
  }
  const components = BIF.objects?.spool?.components;
  if (!Array.isArray(components) || !components[index]) {
    return { ok: false, error: `Chapter ${index + 1}: that part is not in the player` };
  }
  const part = partFromSpine(components[index], index);
  const total = components.length;
  prepareResourceTiming(performance, total * 5 + 250);
  const already = knownFor(part);
  const report = (line) => {
    console.log('[Libby Downloader]', line);
    window.parent.postMessage(
      {
        type: MessageTypes.EXTRACTION_PROGRESS,
        data: { completed: index, total, message: line },
      },
      '*'
    );
  };
  if (!shouldSeekForUrl(already, attempt)) {
    const ready = describeReadyChapter(index + 1, { url: already, source: 'cached' });
    report(ready.line);
    return { ok: true, url: already };
  }
  report(`Chapter ${index + 1}: no stored URL for ${partFileKey(part.path) || 'this part'}; seeking`);
  clearResourceTimings();
  const target = (part.spinePosition ?? index) + (index === total - 1 ? 0.25 : 0.5);
  const away = index === 0 ? (total > 1 ? 1.5 : target) : Math.max(0, (part.spinePosition ?? index) - 1 + 0.5);
  const found = await waitForPartUrl({
    part,
    knownUrl: already,
    readEntries: readPlayerResourceEntries,
    readAudioSrc,
    sleep,
    waitMs: 2500,
    seek() {
      return seekPlayer(BIF, target);
    },
    seekAway() {
      return seekPlayer(BIF, away);
    },
  });
  const ready = describeReadyChapter(index + 1, found);
  if (!ready.ready) {
    console.error('[Libby Downloader]', ready.line);
    return { ok: false, error: ready.line };
  }
  report(ready.line);
  return { ok: true, url: found.url };
}

function resolveAuthors(creators) {
  const authorRoles = new Set(['author', 'aut', 'wrt', 'writer']);
  const byRole = creators
    .filter((creator) => authorRoles.has(creator.role?.toLowerCase() ?? ''))
    .map((creator) => creator.name);
  if (byRole.length > 0) return byRole;

  const nonNarrators = creators
    .filter((creator) => (creator.role?.toLowerCase() ?? '') !== 'narrator')
    .map((creator) => creator.name);
  if (nonNarrators.length > 0) return nonNarrators;

  if (creators.length > 0) return [creators[0].name];
  return ['Unknown'];
}

console.log('[Libby Downloader] Ready to extract');
})();
