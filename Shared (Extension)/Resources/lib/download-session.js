/**
 * Save each chapter immediately after asking the player for a fresh URL.
 * A 109-part capture used to finish minutes before the later files were
 * fetched, and one runtime.sendMessage stayed open for the whole run.
 * Copyright (c) 2026 libby-downloader contributors.
 */

import { chapterRetryDelayMs, isRetryableChapterStatus, withTimeout } from './page-fallback.js';

export const FRESH_URL_ATTEMPTS = 3;

/** Player-URL round trip, then the native save. Either one must end. */
export const PLAYER_URL_DEADLINE_MS = 20000;
export const SAVE_DEADLINE_MS = 50000;

/**
 * First successful reply wins. A rejection from one channel (the page
 * message that never returns) does not cancel the other. If every channel
 * fails, or the deadline passes, the wait ends with a timeout error.
 * @param {Array<Promise<unknown>>} promises
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
export function settleFirst(promises, timeoutMs) {
  return withTimeout(
    () =>
      new Promise((resolve, reject) => {
        let pending = promises.length;
        if (!pending) {
          reject(new Error(`timed out after ${timeoutMs}ms`));
          return;
        }
        for (const promise of promises) {
          Promise.resolve(promise).then(
            (value) => resolve(value),
            () => {
              pending -= 1;
              if (!pending) reject(new Error(`timed out after ${timeoutMs}ms`));
            }
          );
        }
      }),
    timeoutMs,
    'wait'
  );
}

/**
 * 403 and 410 are treated as an expired signature: refresh the player URL
 * instead of repeating the same request.
 * @param {Error & { status?: number }} error
 * @param {number} attempt
 * @param {number} attempts
 */
export function shouldRefreshAgain(error, attempt, attempts) {
  if (attempt + 1 >= attempts) return false;
  const status = error?.status;
  return isRetryableChapterStatus(status) || status === 403 || status === 410;
}

/**
 * A dead native channel has no HTTP status. An HTTP error does, and the
 * next chapter should still be tried after a refresh.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isNativeChannelFailure(error) {
  if (!error || typeof error !== 'object') return false;
  if (!/** @type {{ fallback?: unknown }} */ (error).fallback) return false;
  const status = /** @type {{ status?: unknown }} */ (error).status;
  return !(typeof status === 'number' && status > 0);
}

/**
 * @param {{
 *   chapters: Array<{ url?: string }>,
 *   title: string,
 *   refreshUrl: (chapter: { url?: string }, index: number, attempt: number) => Promise<string>,
 *   saveChapter: (chapter: { url?: string }, title: string, index: number) => Promise<unknown>,
 *   onProgress?: (completed: number, total: number) => void | Promise<void>,
 *   onBeforeChapter?: (index: number, total: number) => void | Promise<void>,
 *   onChapterError?: (event: { index: number, message: string }) => void | Promise<void>,
 *   sleep?: (ms: number) => Promise<void>,
 *   delayMs?: number,
 *   attempts?: number,
 *   playerUrlDeadlineMs?: number,
 *   saveDeadlineMs?: number,
 * }} input
 */
export async function downloadChaptersRefreshingUrls({
  chapters,
  title,
  refreshUrl,
  saveChapter,
  onProgress,
  onBeforeChapter,
  onChapterError,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delayMs = 0,
  attempts = FRESH_URL_ATTEMPTS,
  playerUrlDeadlineMs = PLAYER_URL_DEADLINE_MS,
  saveDeadlineMs = SAVE_DEADLINE_MS,
}) {
  const errors = [];
  let completed = 0;
  const total = chapters.length;

  for (let index = 0; index < total; index++) {
    try {
    if (onBeforeChapter) await onBeforeChapter(index, total);
    let saved = false;
    /** @type {Error & { status?: number, fallback?: boolean }} */
    let lastError = new Error(`Chapter ${index + 1}: download failed`);

    for (let attempt = 0; attempt < attempts; attempt++) {
      let url = typeof chapters[index]?.url === 'string' ? chapters[index].url : '';
      try {
        const fresh = await withTimeout(
          () => refreshUrl(chapters[index] || {}, index, attempt),
          playerUrlDeadlineMs,
          `Chapter ${index + 1} player URL`
        );
        if (typeof fresh === 'string' && fresh) {
          url = fresh;
          if (chapters[index]) chapters[index].url = fresh;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt + 1 < attempts) {
          await sleep(chapterRetryDelayMs(attempt));
          continue;
        }
        break;
      }
      if (!url) {
        lastError = new Error(`Chapter ${index + 1}: no signed player URL`);
        if (attempt + 1 < attempts) {
          await sleep(chapterRetryDelayMs(attempt));
          continue;
        }
        break;
      }
      try {
        await withTimeout(
          () => saveChapter({ ...chapters[index], url }, title, index),
          saveDeadlineMs,
          `Chapter ${index + 1} save`
        );
        saved = true;
        break;
      } catch (error) {
        lastError = /** @type {Error & { status?: number, fallback?: boolean }} */ (
          error instanceof Error ? error : new Error('download failed')
        );
        if (isNativeChannelFailure(lastError)) {
          errors.push({ chapterIndex: index, error: lastError.message });
          return {
            completed,
            failed: errors.length,
            total,
            errors,
            fallback: true,
            startIndex: index,
          };
        }
        if (shouldRefreshAgain(lastError, attempt, attempts)) {
          await sleep(chapterRetryDelayMs(attempt));
          continue;
        }
        break;
      }
    }

    if (saved) {
      completed += 1;
      if (onProgress) await onProgress(completed, total);
      if (delayMs > 0 && index < total - 1) await sleep(delayMs);
    } else {
      const message = lastError.message || `Chapter ${index + 1}: download failed`;
      errors.push({ chapterIndex: index, error: message });
      if (onChapterError) await onChapterError({ index, message });
    }
    } catch (error) {
      const message = error instanceof Error ? error.message : `Chapter ${index + 1}: download failed`;
      errors.push({ chapterIndex: index, error: message });
      if (onChapterError) await onChapterError({ index, message });
    }
  }

  return {
    completed,
    failed: errors.length,
    total,
    errors,
    fallback: false,
    startIndex: completed,
  };
}
