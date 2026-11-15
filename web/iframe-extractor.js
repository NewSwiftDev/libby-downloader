/**
 * Player-frame extractor. Runs in the page MAIN world so it can read
 * window.BIF and the media URLs the player requests. Safari needs version
 * 18 or newer for MAIN-world content scripts.
 * Ported from pdugan20/libby-downloader (MIT).
 * Copyright (c) 2026 libby-downloader contributors.
 */

/*__INCLUDE web/lib/messages.js__*/
/*__INCLUDE web/lib/urls.js__*/
/*__INCLUDE web/lib/chapter-urls.js__*/

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

function replyTo(event, payload) {
  const target = event.source;
  if (target && typeof target.postMessage === 'function') {
    target.postMessage(payload, '*');
    return;
  }
  window.parent.postMessage(payload, '*');
}

window.addEventListener('message', async (event) => {
  const type = event.data?.type;
  if (type === MessageTypes.REFRESH_CHAPTER_URL) {
    const index = event.data.index;
    try {
      const attempt = Number.isInteger(event.data.attempt) ? event.data.attempt : 0;
    const result = await refreshPart(index, attempt);
      replyTo(event, { type: MessageTypes.REFRESH_CHAPTER_URL_RESULT, index, ...result });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Could not read the player URL';
      console.error('[Libby Downloader]', errorMessage);
      replyTo(event, {
        type: MessageTypes.REFRESH_CHAPTER_URL_RESULT,
        index,
        ok: false,
        error: errorMessage,
      });
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
  const already =
    mediaUrlForPart(readAudioSrc(), part.path) ||
    capturedUrlForPart(mergePerformanceMediaUrls(new Map(), readPlayerResourceEntries()), part.path);
  console.log('[Libby Downloader] Reading player URL for chapter', index + 1, 'of', total);
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
  report(`Reading player URL for chapter ${index + 1} of ${total}`);
  // A part the player already requested must not be seeked again on the
  // first try. place.seek() can stay "underway" (for example SEEK to 405.09)
  // after we have already decided the URL, and that stalls the save.
  if (!shouldSeekForUrl(already, attempt)) {
    const found = {
      url: already,
      source: 'cached',
      reason: partUrlFallbackReason('already-playing', index, part.path),
    };
    const ready = describeReadyChapter(index + 1, found);
    report(found.reason);
    report(ready.line);
    return { ok: true, url: already };
  }
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
  if (found.reason) report(found.reason);
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
