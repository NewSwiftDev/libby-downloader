/**
 * Content script for Libby loan pages. Routes the player iframe, this page,
 * and the background worker.
 * Ported from pdugan20/libby-downloader (MIT).
 * Copyright (c) 2026 libby-downloader contributors.
 */

/*__INCLUDE web/lib/messages.js__*/
/*__INCLUDE web/lib/validators.js__*/
/*__INCLUDE web/lib/urls.js__*/
/*__INCLUDE web/lib/chapter-urls.js__*/
/*__INCLUDE web/lib/download-ack.js__*/

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
          console.log('[Libby Downloader]', receivedPlayerUrlLine(index, result.url));
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
    console.log('[Libby Downloader]', `Asked the player for chapter ${index + 1}`);
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
