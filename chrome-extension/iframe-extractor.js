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
function capturedUrlForPart(map, path) {
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
function missingPlayerUrlMessage(missing, total) {
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
async function collectPlayerChapterUrls({
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

window.addEventListener('message', async (event) => {
  if (!event.data || event.data.type !== MessageTypes.EXTRACT_LIBBY_BOOK) return;

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

  const parts = components.map((spine, index) => ({
    index,
    spinePosition: spine.meta?.['-odread-spine-position'] ?? spine.spinePosition ?? index,
    path: spine.meta?.path || '',
    duration: spine.meta?.['audio-duration'] || spine.meta?.duration || spine.duration || 0,
  }));
  const gathered = await gatherPlayerUrls(BIF, parts);
  const missing = gathered.filter((part) => part.source !== 'player');
  if (missing.length > 0) {
    throw new Error(missingPlayerUrlMessage(missing, gathered.length));
  }

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

function readPlayerResourceEntries() {
  try {
    return performance.getEntriesByType('resource');
  } catch {
    return [];
  }
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

async function gatherPlayerUrls(bif, parts) {
  const origFloc = bif.objects?.spool?.focus?.floc ?? 0;
  let didSeek = false;
  try {
    return await collectPlayerChapterUrls({
      parts,
      readEntries: readPlayerResourceEntries,
      sleep,
      onProgress(event) {
        console.log(
          '[Libby Downloader] Reading player URL for chapter',
          event.position,
          'of',
          event.total
        );
        window.parent.postMessage(
          {
            type: MessageTypes.EXTRACTION_PROGRESS,
            data: {
              completed: Math.max(0, event.position - 1),
              total: event.total,
              message: `Reading player URL for chapter ${event.position} of ${event.total}`,
            },
          },
          '*'
        );
      },
      seekToPart(part, total) {
        const ordinal = parts.findIndex((item) => item.index === part.index);
        const fraction = ordinal === total - 1 ? 0.25 : 0.5;
        const floc = (part.spinePosition ?? part.index) + fraction;
        const moved = seekPlayer(bif, floc);
        if (moved) didSeek = true;
        return moved;
      },
    });
  } finally {
    if (didSeek) seekPlayer(bif, origFloc);
  }
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
