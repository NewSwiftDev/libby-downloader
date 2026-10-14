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
  alert(`Libby Downloader: ${message}`);
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
  extractionTimeout = window.setTimeout(() => {
    showError('Extraction timed out. Play the audiobook for a few seconds, then try again.');
  }, 10000);
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

  updateState('downloading', { completed: 0, total: bookData.chapters.length });
  try {
    const response = await ext.runtime.sendMessage({
      type: MessageTypes.START_DOWNLOAD,
      data: bookData,
    });
    if (!response?.success) {
      throw new Error(response?.error || 'Download failed');
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
    showError(error instanceof Error ? error.message : 'Download failed');
  }
}

function handleExtractionError(error) {
  if (extractionTimeout !== null) clearTimeout(extractionTimeout);
  showError(`Extraction failed: ${error}`);
}

function handleWindowMessage(event) {
  if (!validateOrigin(event.origin)) return;
  const { type, data, error, progress, result } = event.data || {};

  if (type === MessageTypes.LIBBY_DOWNLOADER_BUTTON_CLICKED) {
    handleButtonClick();
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
    log('Progress', message.progress?.completed ?? 0, 'of', message.progress?.total ?? 0);
    updateState('downloading', message.progress);
    return;
  }
  if (message.type === MessageTypes.DOWNLOAD_FALLBACK && message.data) {
    log('Background asked for page fallback:', message.reason || 'no reason provided');
    postFallbackToPlayer(
      message.data,
      Number.isInteger(message.startIndex) ? message.startIndex : 0,
      message.reason
    );
    return;
  }
  if (message.type === MessageTypes.DOWNLOAD_COMPLETE) {
    updateState('success', {
      completedChapters: message.result?.completed ?? 0,
      failedChapters: message.result?.failed ?? 0,
      totalChapters: message.result?.total ?? 0,
    });
    resetAfterDelay();
  }
}

if (!window.location.pathname.includes('/open/loan/')) {
  log('Not an audiobook loan page');
} else {
  window.addEventListener('message', handleWindowMessage);
  ext.runtime.onMessage.addListener((message) => {
    handleBackgroundMessage(message);
  });
  log('Ready');
}
})();
