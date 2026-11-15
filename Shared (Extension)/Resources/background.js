/**
 * Background entry for Chrome (service worker) and Safari (module background).
 * Chrome writes with chrome.downloads. Safari asks the containing app to write
 * ~/Downloads/libby-downloads/<title>/chapter-NNN.mp3, or the iOS app group.
 * Ported from pdugan20/libby-downloader (MIT).
 * Copyright (c) 2026 libby-downloader contributors.
 */

import { createChromeSaver } from './lib/chrome-downloads.js';
import { downloadChaptersRefreshingUrls } from './lib/download-session.js';
import { MessageTypes } from './lib/messages.js';
import { createMetadataGate } from './lib/metadata-gate.js';
import { createNativeSaver } from './lib/native-saver.js';
import { withTimeout } from './lib/page-fallback.js';
import { describeSaveStrategy, detectBrowserName } from './lib/platform.js';
import { pageFallbackReason } from './lib/chapter-urls.js';
import { isAllowedChapterURL } from './lib/urls.js';
import { validateBookData } from './lib/validators.js';

const ext = globalThis.browser ?? globalThis.chrome;
const metadataGate = createMetadataGate();

const state = {
  phase: 'idle',
  title: '',
  completed: 0,
  failed: 0,
  total: 0,
  strategy: '',
  detail: '',
};

function log(...args) {
  console.log('[Libby Downloader]', ...args);
}

function requireBook(data) {
  if (!validateBookData(data)) {
    throw new Error('Invalid book data');
  }
  const bad = data.chapters.find((chapter) => chapter.url && !isAllowedChapterURL(chapter.url));
  if (bad) {
    throw new Error('Refusing chapter URL outside Libby');
  }
  return data;
}

async function notify(tabId, message) {
  if (tabId == null || !ext.tabs?.sendMessage) {
    log('Cannot message the tab', message?.type, 'tabs.sendMessage missing');
    return;
  }
  try {
    await ext.tabs.sendMessage(tabId, message);
  } catch (error) {
    console.error(
      '[Libby Downloader] Tab message failed:',
      message?.type,
      error instanceof Error ? error.message : error
    );
  }
}

function collectCapabilities() {
  const apis = [
    ['browser', globalThis.browser],
    ['chrome', globalThis.chrome],
  ];
  let nativeRuntime;
  let sendNativeFrom = 'missing';
  let downloadsDownload;
  let downloadsFrom = 'missing';
  for (const [name, api] of apis) {
    if (!api) continue;
    if (!nativeRuntime && typeof api.runtime?.sendNativeMessage === 'function') {
      nativeRuntime = api.runtime;
      sendNativeFrom = name;
    }
    if (!downloadsDownload && typeof api.downloads?.download === 'function') {
      downloadsDownload = api.downloads.download.bind(api.downloads);
      downloadsFrom = name;
    }
  }
  const browserName = detectBrowserName(globalThis.navigator?.userAgent || '');
  const decision = describeSaveStrategy({
    downloadsDownload,
    sendNativeMessage: nativeRuntime?.sendNativeMessage,
    browserName,
  });
  return {
    ...decision,
    nativeRuntime,
    downloadsDownload,
    sendNativeFrom,
    downloadsFrom,
    browserName,
  };
}

function nativeErrorText(error, runtime) {
  const runtimeMessage = runtime?.lastError?.message;
  const thrown = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const parts = [runtimeMessage, thrown].filter((part) => part && part.length > 0);
  return [...new Set(parts)].join(': ') || 'native-channel';
}

function invokeNative(runtime, application, message) {
  if (typeof runtime?.sendNativeMessage !== 'function') {
    return Promise.reject(new Error('sendNativeMessage is not available'));
  }

  // Safari invokes both the returned promise and the optional callback.
  // A rejection or an empty callback used to win the race and the chapter
  // loop treated that as a dead native channel. Accept the first real
  // dictionary from either path, and fail only when both have failed.
  return new Promise((resolve, reject) => {
    let settled = false;
    let callbackDone = false;
    let promiseDone = false;
    let callbackError = null;
    let promiseError = null;

    const succeed = (response) => {
      if (settled || response == null) return;
      settled = true;
      resolve(response);
    };
    const failIfExhausted = () => {
      if (settled || !callbackDone || !promiseDone) return;
      settled = true;
      reject(promiseError || callbackError || new Error('native-channel'));
    };

    let result;
    try {
      result = runtime.sendNativeMessage(application, message, (response) => {
        callbackDone = true;
        if (response != null) {
          succeed(response);
          return;
        }
        const runtimeMessage = runtime.lastError?.message;
        callbackError = new Error(runtimeMessage || 'Empty native response');
        failIfExhausted();
      });
    } catch (error) {
      try {
        result = runtime.sendNativeMessage(application, message);
        callbackDone = true;
      } catch (second) {
        reject(new Error(nativeErrorText(second || error, runtime)));
        return;
      }
    }

    if (result && typeof result.then === 'function') {
      result.then(
        (response) => {
          promiseDone = true;
          if (response != null) succeed(response);
          else {
            promiseError = new Error(runtime.lastError?.message || 'Empty native response');
            failIfExhausted();
          }
        },
        (error) => {
          promiseDone = true;
          promiseError = new Error(nativeErrorText(error, runtime));
          failIfExhausted();
        }
      );
    } else {
      promiseDone = true;
      failIfExhausted();
    }
  });
}

async function cookieList(url) {
  if (typeof ext.cookies?.getAll !== 'function') return [];
  try {
    return await ext.cookies.getAll({ url });
  } catch {
    return [];
  }
}

async function finish(tabId, result) {
  state.phase = 'complete';
  state.completed = result.completed;
  state.failed = result.failed;
  state.total = result.total;
  const detail = result.errors?.[result.errors.length - 1]?.error || result.detail || '';
  state.detail = detail;
  await notify(tabId, {
    type: MessageTypes.DOWNLOAD_COMPLETE,
    result: {
      completed: result.completed,
      failed: result.failed,
      total: result.total,
      detail,
    },
  });
}

async function requestFallback(tabId, book, startIndex, reason, source) {
  const text = pageFallbackReason(reason);
  state.strategy = 'blob-fallback';
  state.detail = text;
  console.error('[Libby Downloader] Native save failed; falling back to page downloads:', source || 'download', text);
  await notify(tabId, {
    type: MessageTypes.DOWNLOAD_FALLBACK,
    data: book,
    startIndex,
    reason: text,
  });
  return text;
}

async function refreshChapterUrl(tabId, index) {
  let response;
  try {
    response = await ext.tabs.sendMessage(tabId, {
      type: MessageTypes.REFRESH_CHAPTER_URL,
      index,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not reach the player';
    throw new Error(`Chapter ${index + 1}: ${message}`);
  }
  if (!response || response.ok !== true || !isAllowedChapterURL(response.url)) {
    throw new Error(response?.error || `Chapter ${index + 1}: the player did not provide a URL`);
  }
  return response.url;
}

async function nativeCall(work, timeoutMs, label) {
  try {
    return await withTimeout(work, timeoutMs, label);
  } catch (error) {
    const wrapped = /** @type {Error & { fallback?: boolean }} */ (
      new Error(error instanceof Error && error.message ? error.message : label)
    );
    wrapped.fallback = true;
    throw wrapped;
  }
}

function currentNativeSaver() {
  const capabilities = collectCapabilities();
  if (capabilities.strategy !== 'native' || !capabilities.nativeRuntime) return null;
  return createNativeSaver((application, message) => invokeNative(capabilities.nativeRuntime, application, message), {
    cookiesForUrl: cookieList,
  });
}

async function writeMetadataOnce(book, save) {
  if (!metadataGate.claim()) {
    log('Metadata already written; skipping a second copy');
    return { ok: true, skipped: true };
  }
  try {
    await save();
    return { ok: true, skipped: false };
  } catch (error) {
    metadataGate.revoke();
    const message = error instanceof Error ? error.message : 'metadata failed';
    console.error('[Libby Downloader] Failed to save metadata file:', message);
    return { ok: false, error: message };
  }
}

function decisionResult(selected, strategy, reason, extra = {}) {
  log(`Save decision: ${selected} → ${strategy}. ${reason}`);
  return { success: true, selected, strategy, reason, ...extra };
}

async function handleStartDownload(bookData, tabId) {
  const book = requireBook(bookData);
  const decision = collectCapabilities();
  state.phase = 'downloading';
  state.title = book.metadata.title;
  state.completed = 0;
  state.failed = 0;
  state.total = book.chapters.length;
  metadataGate.reset();
  state.strategy = decision.strategy;
  state.detail = decision.reason;
  log(
    `Save decision: ${decision.strategy}. ${decision.reason}`,
    `(browser=${decision.browserName}, native=${decision.sendNativeFrom}, downloads=${decision.downloadsFrom}, chapters=${book.chapters.length})`
  );

  const onProgress = (completed, total) => {
    state.completed = completed;
    state.total = total;
    const message = `Saving chapter ${completed} of ${total}`;
    log(`Progress ${completed} of ${total}`);
    notify(tabId, {
      type: MessageTypes.DOWNLOAD_PROGRESS,
      progress: { completed, total, message },
    });
  };

  const reportChapterError = async ({ message }) => {
    state.detail = message;
    state.failed += 1;
    console.error('[Libby Downloader]', message);
    await notify(tabId, {
      type: MessageTypes.CHAPTER_FAILED,
      error: message,
      progress: { completed: state.completed, total: state.total, message },
    });
  };

  const saving = {
    chapters: book.chapters,
    title: book.metadata.title,
    delayMs: 500,
    refreshUrl: (_chapter, index) => refreshChapterUrl(tabId, index),
    onBeforeChapter(index, total) {
      const message = `Reading player URL for chapter ${index + 1} of ${total}`;
      log(message);
      return notify(tabId, {
        type: MessageTypes.DOWNLOAD_PROGRESS,
        progress: { completed: state.completed, total, message },
      });
    },
    onProgress,
    onChapterError: reportChapterError,
  };

  if (decision.strategy === 'chrome-downloads') {
    const saver = createChromeSaver(ext.downloads);
    const result = await downloadChaptersRefreshingUrls({
      ...saving,
      saveChapter: (chapter, title, index) => saver.saveChapter(chapter, title, index),
    });
    await writeMetadataOnce(book, () => saver.saveMetadata(book.metadata, book.chapters, book.metadata.title));
    await finish(tabId, result);
    return decisionResult('chrome-downloads', 'chrome-downloads', decision.reason, { result });
  }

  if (decision.strategy === 'native') {
    const saver = createNativeSaver(
      (application, message) => invokeNative(decision.nativeRuntime, application, message),
      { cookiesForUrl: cookieList }
    );
    let ping;
    try {
      ping = await nativeCall(() => saver.ping(), 15000, 'Native ping');
    } catch (error) {
      const reason = await requestFallback(
        tabId,
        book,
        0,
        error instanceof Error ? error.message : 'Native ping failed',
        'ping'
      );
      return decisionResult('native', 'blob-fallback', reason, { fallback: true, startIndex: 0 });
    }
    if (!ping.ok) {
      const reason = await requestFallback(
        tabId,
        book,
        0,
        ping.error.message,
        'ping'
      );
      return decisionResult('native', 'blob-fallback', reason, { fallback: true, startIndex: 0 });
    }
    log('Native ping ok', ping.platform || '', ping.path || '');

    const result = await downloadChaptersRefreshingUrls({
      ...saving,
      saveChapter: (chapter, title, index) =>
        nativeCall(
          () => saver.saveChapter(chapter, title, index),
          180000,
          `Native chapter ${index + 1}`
        ),
    });

    if (result.fallback) {
      const chapterError = result.errors[result.errors.length - 1]?.error || 'native-save-failed';
      const resumeAt = Number.isInteger(result.startIndex) ? result.startIndex : result.completed;
      const reason = await requestFallback(tabId, book, resumeAt, chapterError, 'chapter');
      return decisionResult('native', 'blob-fallback', reason, {
        fallback: true,
        startIndex: resumeAt,
        result,
      });
    }

    await writeMetadataOnce(book, () => saver.saveMetadata(book.metadata, book.chapters, book.metadata.title));
    await finish(tabId, result);
    return decisionResult('native', 'native', `${decision.reason}; ping ok`, { result });
  }

  const reason = await requestFallback(tabId, book, 0, decision.reason, 'no-api');
  return decisionResult('blob-fallback', 'blob-fallback', reason, { fallback: true, startIndex: 0 });
}

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === MessageTypes.GET_STATE) {
    sendResponse({ ...state });
    return true;
  }

  if (message.type === MessageTypes.ORGANIZE_CHAPTER) {
    organizeFlatChapter(message.title, message.index)
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : 'move failed' });
      });
    return true;
  }

  if (message.type === MessageTypes.ORGANIZE_METADATA) {
    organizeMetadata(message.data)
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : 'metadata failed' });
      });
    return true;
  }

  if (message.type === MessageTypes.START_DOWNLOAD) {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ success: false, error: 'No tab ID available' });
      return true;
    }
    let book;
    try {
      book = requireBook(message.data);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Invalid book data';
      sendResponse({ success: false, error: detail });
      return true;
    }
    // Reply before any chapter is saved. Holding this channel open for a
    // 109-part book makes Safari resolve the loan page's sendMessage with
    // no payload, and the page used to alert "Download failed" with nothing
    // in the console. Completion and errors are pushed with tabs.sendMessage.
    sendResponse({ success: true, accepted: true });
    Promise.resolve()
      .then(() => handleStartDownload(book, tabId))
      .catch((error) => {
        const detail = error instanceof Error && error.message ? error.message : 'Download failed';
        state.phase = 'error';
        state.detail = detail;
        console.error('[Libby Downloader]', detail);
        notify(tabId, { type: MessageTypes.DOWNLOAD_FAILED, error: detail });
      });
    return true;
  }

  return false;
});

if (ext.downloads?.onChanged) {
  ext.downloads.onChanged.addListener((delta) => {
    if (delta.error) {
      console.error(`[Libby Downloader] Download ${delta.id} error:`, delta.error.current);
    }
  });
}

async function organizeFlatChapter(title, index) {
  const saver = currentNativeSaver();
  if (!saver) return { ok: false, error: 'native messaging unavailable' };
  const moved = await nativeCall(() => saver.moveFlat(title, index), 60000, `Move chapter ${index + 1}`);
  log('Moved chapter into book folder', moved.filepath || '');
  return { ok: true, path: moved.filepath };
}

async function organizeMetadata(book) {
  if (!validateBookData(book)) return { ok: false, error: 'missing book' };
  const saver = currentNativeSaver();
  if (!saver) return { ok: false, error: 'native messaging unavailable' };
  return writeMetadataOnce(book, () =>
    saver.saveMetadata(book.metadata, book.chapters, book.metadata.title)
  );
}

const ready = collectCapabilities();
log(
  'Background ready',
  ready.strategy,
  ready.reason,
  `(browser=${ready.browserName}, native=${ready.sendNativeFrom}, downloads=${ready.downloadsFrom})`
);
