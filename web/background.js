/**
 * Background entry for Chrome (service worker) and Safari (module background).
 * Chrome writes with chrome.downloads. Safari asks the containing app to write
 * ~/Downloads/libby-downloads/<title>/chapter-NNN.mp3, or the iOS app group.
 * Ported from pdugan20/libby-downloader (MIT).
 * Copyright (c) 2026 libby-downloader contributors.
 */

import { createChromeSaver } from './lib/chrome-downloads.js';
import { downloadAllChapters } from './lib/download-orchestrator.js';
import { MessageTypes } from './lib/messages.js';
import { createNativeSaver } from './lib/native-saver.js';
import { selectSaveStrategy } from './lib/platform.js';
import { isAllowedChapterURL } from './lib/urls.js';
import { validateBookData } from './lib/validators.js';

const ext = globalThis.browser ?? globalThis.chrome;

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
  const bad = data.chapters.find((chapter) => !isAllowedChapterURL(chapter.url));
  if (bad) {
    throw new Error('Refusing chapter URL outside Libby');
  }
  return data;
}

async function notify(tabId, message) {
  if (tabId == null || !ext.tabs?.sendMessage) return;
  try {
    await ext.tabs.sendMessage(tabId, message);
  } catch {
    // The tab can close while chapters are still saving.
  }
}

function strategyForRuntime() {
  return selectSaveStrategy({
    downloadsDownload: ext.downloads?.download,
    sendNativeMessage: ext.runtime?.sendNativeMessage,
  });
}

function nativeErrorText(error) {
  const runtimeMessage = ext.runtime?.lastError?.message;
  const thrown = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const parts = [runtimeMessage, thrown].filter((part) => part && part.length > 0);
  return [...new Set(parts)].join(': ') || 'native-channel';
}

function sendNativeMessage(application, message) {
  const runtime = ext.runtime;
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
        reject(new Error(nativeErrorText(second || error)));
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
          promiseError = new Error(nativeErrorText(error));
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
  await notify(tabId, {
    type: MessageTypes.DOWNLOAD_COMPLETE,
    result: {
      completed: result.completed,
      failed: result.failed,
      total: result.total,
    },
  });
}

async function requestFallback(tabId, book, startIndex, reason, source) {
  const text = source ? `${source}: ${reason}` : reason;
  state.strategy = 'blob-fallback';
  state.detail = text;
  console.error('[Libby Downloader] Native save failed; falling back to page downloads:', text);
  await notify(tabId, {
    type: MessageTypes.DOWNLOAD_FALLBACK,
    data: book,
    startIndex,
    reason: text,
  });
}

async function handleStartDownload(bookData, tabId) {
  const book = requireBook(bookData);
  const strategy = strategyForRuntime();
  state.phase = 'downloading';
  state.title = book.metadata.title;
  state.completed = 0;
  state.failed = 0;
  state.total = book.chapters.length;
  state.strategy = strategy;
  state.detail = '';
  log('Download starting', strategy, `${book.chapters.length} chapters`);

  const onProgress = (completed, total) => {
    state.completed = completed;
    state.total = total;
    notify(tabId, {
      type: MessageTypes.DOWNLOAD_PROGRESS,
      progress: { completed, total },
    });
  };

  if (strategy === 'chrome-downloads') {
    const saver = createChromeSaver(ext.downloads);
    const result = await downloadAllChapters({
      chapters: book.chapters,
      title: book.metadata.title,
      saveChapter: (chapter, title, index) => saver.saveChapter(chapter, title, index),
      onProgress,
    });
    try {
      await saver.saveMetadata(book.metadata, book.chapters, book.metadata.title);
    } catch (error) {
      console.error('[Libby Downloader] Failed to save metadata file:', error);
    }
    await finish(tabId, result);
    return { success: true, strategy, result };
  }

  if (strategy === 'native') {
    const saver = createNativeSaver(sendNativeMessage, { cookiesForUrl: cookieList });
    const ping = await saver.ping();
    if (!ping.ok) {
      await requestFallback(tabId, book, 0, ping.error.message, 'ping');
      return { success: true, strategy: 'blob-fallback', fallback: true };
    }
    log('Native ping ok', ping.platform || '', ping.path || '');

    const result = await downloadAllChapters({
      chapters: book.chapters,
      title: book.metadata.title,
      saveChapter: (chapter, title, index) => saver.saveChapter(chapter, title, index),
      onProgress,
    });

    if (result.fallback) {
      if (result.completed > 0) {
        try {
          await saver.saveMetadata(book.metadata, book.chapters, book.metadata.title);
        } catch (error) {
          console.error('[Libby Downloader] Failed to save metadata file:', error);
        }
      }
      const reason = result.errors[result.errors.length - 1]?.error || 'native-save-failed';
      await requestFallback(tabId, book, result.completed, reason, 'chapter');
      return { success: true, strategy: 'blob-fallback', fallback: true, result };
    }

    try {
      await saver.saveMetadata(book.metadata, book.chapters, book.metadata.title);
    } catch (error) {
      console.error('[Libby Downloader] Failed to save metadata file:', error);
    }
    await finish(tabId, result);
    return { success: true, strategy, result };
  }

  await requestFallback(
    tabId,
    book,
    0,
    'sendNativeMessage is not a function and downloads.download is missing',
    'no-api'
  );
  return { success: true, strategy: 'blob-fallback', fallback: true };
}

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === MessageTypes.GET_STATE) {
    sendResponse({ ...state });
    return true;
  }

  if (message.type === MessageTypes.START_DOWNLOAD) {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ success: false, error: 'No tab ID available' });
      return true;
    }

    handleStartDownload(message.data, tabId)
      .then((result) => sendResponse(result))
      .catch((error) => {
        state.phase = 'error';
        state.detail = error instanceof Error ? error.message : 'Unknown error';
        sendResponse({ success: false, error: state.detail });
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

log('Background ready', strategyForRuntime());
