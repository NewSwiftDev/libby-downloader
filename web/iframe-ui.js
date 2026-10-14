/**
 * Player-frame UI. Isolated world: injects the download button and, when
 * the containing app cannot write files, fetches chapters with the page
 * cookies and hands blobs to Safari's download manager as flat files.
 * Ported from pdugan20/libby-downloader (MIT).
 * Copyright (c) 2026 libby-downloader contributors.
 */

/*__INCLUDE web/lib/messages.js__*/
/*__INCLUDE web/lib/paths.js__*/
/*__INCLUDE web/lib/urls.js__*/
/*__INCLUDE web/lib/page-fallback.js__*/

const ext = globalThis.browser ?? globalThis.chrome;

console.log('[Libby Downloader] Iframe UI loaded');

let progressOverlay = null;

function findAlbumArtContainer() {
  const selectors = [
    '.backdrop-cover-button',
    '.slingshot',
    '.title-tile-cover',
    '.title-tile',
    '.player-art',
    '.album-art',
  ];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element) return element;
  }
  return null;
}

function createProgressOverlay() {
  if (progressOverlay) return;
  if (!findAlbumArtContainer()) {
    console.warn('[Libby Downloader] Album art not found');
  }
  const overlay = document.createElement('div');
  overlay.className = 'libby-download-progress-overlay';
  const progressContainer = document.createElement('div');
  progressContainer.className = 'libby-progress-container';
  const progressBar = document.createElement('div');
  progressBar.className = 'libby-progress-bar';
  const progressFill = document.createElement('div');
  progressFill.className = 'libby-progress-fill';
  progressBar.appendChild(progressFill);
  const progressText = document.createElement('div');
  progressText.className = 'libby-progress-text';
  progressText.textContent = 'Preparing download...';
  progressContainer.appendChild(progressBar);
  progressContainer.appendChild(progressText);
  overlay.appendChild(progressContainer);
  document.body.appendChild(overlay);
  progressOverlay = overlay;
}

function updateProgressOverlay(completed, total, message) {
  if (!progressOverlay) createProgressOverlay();
  if (!progressOverlay) return;
  const progressFill = progressOverlay.querySelector('.libby-progress-fill');
  const progressText = progressOverlay.querySelector('.libby-progress-text');
  if (progressFill) {
    const percentage = total > 0 ? (completed / total) * 100 : 0;
    progressFill.style.width = `${percentage}%`;
  }
  if (progressText) progressText.textContent = message;
}

function showCompletionMessage(failedChapters, detail) {
  if (!progressOverlay) return;
  const progressText = progressOverlay.querySelector('.libby-progress-text');
  if (!progressText) return;
  progressText.classList.add('libby-completion-message');
  if (failedChapters === 0) {
    progressText.textContent = 'Download complete!';
    return;
  }
  const suffix = detail ? ` Last: ${detail}` : '';
  progressText.textContent = `Download failed: ${failedChapters} errors.${suffix}`.slice(0, 180);
}

function removeProgressOverlay() {
  if (progressOverlay) progressOverlay.remove();
  progressOverlay = null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function chapterHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

let fallbackRun = null;

function playerFrameOwnsDownload() {
  return document.getElementById('libby-downloader-button') != null;
}

function startPageFallback(book, startIndex, reason) {
  if (!playerFrameOwnsDownload()) {
    console.log('[Libby Downloader] Ignoring fallback outside the player frame');
    return;
  }
  if (fallbackRun) {
    console.log('[Libby Downloader] Page fallback already running');
    return;
  }
  fallbackRun = runBlobFallback(book, startIndex, reason).finally(() => {
    fallbackRun = null;
  });
}

async function runBlobFallback(book, startIndex, reason) {
  const chapters = Array.isArray(book?.chapters) ? book.chapters : [];
  const title = book?.metadata?.title || 'Untitled';
  const begin = Number.isInteger(startIndex) ? startIndex : 0;
  console.error('[Libby Downloader] Page download fallback:', reason || 'no reason provided');
  createProgressOverlay();
  const summary = reason ? `Page fallback: ${reason}` : 'Saving through Safari downloads...';
  updateProgressOverlay(begin, chapters.length, summary.slice(0, 180));

  const result = await runPageFallback({
    chapters,
    startIndex: begin,
    timeoutMs: 120000,
    async fetchChapter(chapter, index, signal) {
      if (!isAllowedChapterURL(chapter?.url)) {
        throw new Error('Refusing chapter URL outside Libby');
      }
      // credentials must stay 'omit'. listen.libbyapp.com redirects to
      // audioclips.cdn.overdrive.com, which replies with ACAO: *.
      const response = await fetch(chapter.url, {
        credentials: chapterFetchCredentials(),
        redirect: 'follow',
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const flatName = flatDownloadFilename(title, index);
      triggerBlobDownload(await response.blob(), flatName);
      const organized = await ext.runtime.sendMessage({
        type: MessageTypes.ORGANIZE_CHAPTER,
        title,
        index,
      });
      if (!organized?.ok) {
        throw new Error(organized?.error || `Could not move ${flatName} into the book folder`);
      }
    },
    onChapter(event) {
      if (event.phase === 'start') {
        console.log(
          '[Libby Downloader] Fallback chapter',
          event.index + 1,
          'of',
          event.total,
          chapterHost(event.url)
        );
        updateProgressOverlay(
          event.index,
          event.total,
          `Fetching chapter ${event.index + 1} of ${event.total}`
        );
        return;
      }
      if (event.phase === 'saved') {
        updateProgressOverlay(
          event.completed,
          event.total,
          `Saving ${event.completed} of ${event.total} (Safari downloads)`
        );
        window.parent.postMessage(
          {
            type: MessageTypes.FALLBACK_PROGRESS,
            progress: { completed: event.completed, total: event.total },
          },
          '*'
        );
        return;
      }
      console.error(
        '[Libby Downloader] Fallback chapter',
        event.index + 1,
        'failed:',
        event.message
      );
      updateProgressOverlay(
        event.index,
        event.total,
        `Chapter ${event.index + 1} failed: ${event.message}`.slice(0, 180)
      );
    },
  });

  let metadataError = '';
  try {
    const organized = await ext.runtime.sendMessage({
      type: MessageTypes.ORGANIZE_METADATA,
      data: book,
    });
    if (organized?.skipped) {
      console.log('[Libby Downloader] Metadata already written');
    } else if (!organized?.ok) {
      metadataError = organized?.error || 'Could not write metadata.json';
      console.error('[Libby Downloader] Fallback metadata failed:', metadataError);
    } else {
      console.log('[Libby Downloader] Wrote metadata.json once');
    }
  } catch (error) {
    metadataError = error instanceof Error ? error.message : 'metadata failed';
    console.error('[Libby Downloader] Fallback metadata failed', error);
  }

  const lastError = result.errors[result.errors.length - 1]?.message || metadataError;
  showCompletionMessage(result.failed, lastError);
  window.parent.postMessage(
    {
      type: MessageTypes.FALLBACK_DONE,
      result: {
        completed: result.completed,
        failed: result.failed,
        total: result.total,
        detail: lastError,
      },
    },
    '*'
  );
}

window.addEventListener('message', (event) => {
  if (!event.data || typeof event.data !== 'object' || !event.data.type) return;
  const { type, state, data } = event.data;
  if (type === MessageTypes.UPDATE_PROGRESS_UI) {
    if (state === 'extracting') {
      createProgressOverlay();
      updateProgressOverlay(0, 1, 'Extracting metadata...');
    } else if (state === 'downloading' && data) {
      updateProgressOverlay(data.completed || 0, data.total || 1, data.message || 'Downloading...');
    } else if (state === 'success') {
      showCompletionMessage(data?.failedChapters || 0, data?.detail);
    }
    return;
  }
  if (type === MessageTypes.DOWNLOAD_FALLBACK && data?.book) {
    startPageFallback(data.book, data.startIndex, data.reason);
    return;
  }
  if (type === MessageTypes.RESET_UI) removeProgressOverlay();
});

if (ext?.runtime?.onMessage) {
  ext.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== MessageTypes.DOWNLOAD_FALLBACK || !message.data) return;
    const startIndex = Number.isInteger(message.startIndex) ? message.startIndex : 0;
    console.error(
      '[Libby Downloader] Native save did not finish:',
      message.reason || 'unknown reason'
    );
    startPageFallback(message.data, startIndex, message.reason);
  });
}

function injectDownloadButton() {
  const navBar = document.querySelector('.nav-action-bar-right');
  if (!navBar) {
    setTimeout(injectDownloadButton, 100);
    return;
  }
  if (document.getElementById('libby-downloader-button')) return;

  const container = document.createElement('div');
  container.className = 'nav-action-item';
  container.id = 'libby-downloader-button-container';

  const button = document.createElement('button');
  button.id = 'libby-downloader-button';
  button.className = 'nav-action-item-button halo';
  button.type = 'button';
  button.setAttribute('aria-label', 'Download Audiobook');
  button.setAttribute('touch-action', 'none');

  const iconContainer = document.createElement('div');
  iconContainer.className = 'nav-action-item-icon';
  iconContainer.style.transform = 'scale(0.7)';
  iconContainer.innerHTML =
    '<svg viewBox="0 0 90 66" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path fill="currentColor" d="M45 0C51.9 0 58.8 2.6 64.1 7.9C68.2 12 70.6 17.1 71.5 22.4C82 24.1 90 33.1 90 44C90 56.1 80.1 66 68 66H19C8.5 66 0 57.5 0 47C0 36.8 8.1 28.5 18.2 28.1C17.9 20.8 20.4 13.4 25.9 7.9C31.2 2.6 38.1 0 45 0ZM45 4C39.1 4 33.3 6.2 28.8 10.7C23.5 15.9 21.4 23 22.2 29.8C22.2 30 22.2 30.3 22.1 30.6C22 30.9 21.9 31.1 21.7 31.3C21.5 31.5 21.3 31.7 21 31.8C20.8 31.9 20.5 32 20.2 32H19C10.7 32 4 38.7 4 47C4 55.3 10.7 62 19 62H68C78 62 86 54 86 44C86 34.6 78.8 26.9 69.7 26.1C69.2 26 68.8 25.8 68.4 25.5C68.1 25.2 67.9 24.8 67.8 24.3C67.3 19.3 65.1 14.5 61.3 10.7C56.8 6.2 50.9 4 45 4ZM45 24C46.1 24 47 24.9 47 26V47.5L54.7 40.5C55.4 39.8 56.8 39.9 57.5 40.7C58.2 41.4 58.2 42.8 57.3 43.5L46.3 53.5C46.1 53.8 45.5 54 45 54C44.5 54 44.1 53.9 43.7 53.5L32.7 43.5C31.9 42.8 31.7 41.4 32.5 40.7C33.2 39.9 34.6 39.8 35.3 40.5L43 47.5V26C43 24.9 43.9 24 45 24Z"></path>' +
    '</svg>';

  button.appendChild(iconContainer);
  container.appendChild(button);

  const existingItems = navBar.querySelectorAll('.nav-action-item');
  if (existingItems.length > 0) {
    navBar.insertBefore(container, existingItems[existingItems.length - 1]);
  } else {
    navBar.appendChild(container);
  }

  button.addEventListener('click', () => {
    console.log('[Libby Downloader] Download button clicked');
    window.parent.postMessage({ type: MessageTypes.LIBBY_DOWNLOADER_BUTTON_CLICKED }, '*');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectDownloadButton);
} else {
  injectDownloadButton();
}
