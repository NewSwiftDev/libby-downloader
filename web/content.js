/**
 * Content script for Libby loan pages. Routes the player iframe, this page,
 * and the background worker.
 * Ported from pdugan20/libby-downloader (MIT).
 * Copyright (c) 2026 libby-downloader contributors.
 */

/*__INCLUDE web/lib/messages.js__*/
/*__INCLUDE web/lib/validators.js__*/

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
      message: `Downloading ${completed} of ${total} chapters`,
    });
    return;
  }
  if (state === 'success') {
    sendIframeMessage(MessageTypes.UPDATE_PROGRESS_UI, 'success', {
      failedChapters: data?.failedChapters ?? 0,
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

function handleButtonClick() {
  try {
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
    log('Download started', response.strategy || '');
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
    updateState('downloading', message.progress);
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
