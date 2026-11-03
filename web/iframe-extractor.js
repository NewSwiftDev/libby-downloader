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
