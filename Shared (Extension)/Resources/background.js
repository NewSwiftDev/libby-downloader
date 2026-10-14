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

function sendNativeMessage(application, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(response);
    };
    let result;
    try {
      result = ext.runtime.sendNativeMessage(application, message, (response) => {
        const runtimeError = ext.runtime.lastError;
        if (runtimeError) finish(new Error(runtimeError.message));
        else finish(null, response);
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error('native-channel'));
      return;
    }
    if (result && typeof result.then === 'function') {
      result.then(
        (response) => finish(null, response),
        (error) => finish(error instanceof Error ? error : new Error('native-channel'))
      );
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

async function requestFallback(tabId, book, startIndex, reason) {
  state.strategy = 'blob-fallback';
  state.detail = reason;
  await notify(tabId, {
    type: MessageTypes.DOWNLOAD_FALLBACK,
    data: book,
    startIndex,
    reason,
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
      await requestFallback(tabId, book, 0, ping.error.message);
      return { success: true, strategy: 'blob-fallback', fallback: true };
    }

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
      await requestFallback(tabId, book, result.completed, reason);
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

  await requestFallback(tabId, book, 0, 'no-download-api');
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
