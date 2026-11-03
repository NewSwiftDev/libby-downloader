/**
 * In-page chapter fetch used when the containing app cannot write files.
 * Each chapter has a timeout so a hung CDN request cannot stall the book.
 * Retry counts match DownloadStore.maxChapterAttempts.
 * Copyright (c) 2026 libby-downloader contributors.
 */

import { formatChapterFailure } from './chapter-urls.js';

/** One retry. Keep in sync with DownloadStore.maxChapterAttempts. */
export const CHAPTER_FETCH_ATTEMPTS = 2;

export const RETRYABLE_CHAPTER_STATUSES = new Set([429, 500, 502, 503]);

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isRetryableChapterStatus(status) {
  return typeof status === 'number' && RETRYABLE_CHAPTER_STATUSES.has(status);
}

/**
 * @param {number} attempt Zero-based attempt that just failed.
 * @returns {number}
 */
export function chapterRetryDelayMs(attempt) {
  return 1000 * (attempt + 1);
}

/**
 * @template T
 * @param {(attempt: number) => Promise<T>} run
 * @param {{ attempts?: number, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<T>}
 */
export async function withChapterRetries(run, { attempts = CHAPTER_FETCH_ATTEMPTS, sleep } = {}) {
  const pause = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await run(attempt);
    } catch (error) {
      lastError = error;
      const status = error && typeof error === 'object' ? /** @type {{ status?: unknown }} */ (error).status : undefined;
      if (attempt >= attempts - 1 || !isRetryableChapterStatus(status)) throw error;
      await pause(chapterRetryDelayMs(attempt));
    }
  }
  throw lastError;
}

/**
 * Fetch one chapter URL. credentials and redirect are the caller's choice.
 * A retryable HTTP status is tried once more; other statuses fail immediately.
 * @param {{
 *   url: string,
 *   index: number,
 *   fetchImpl: (url: string, options: { signal?: AbortSignal }) => Promise<{ ok?: boolean, status?: number }>,
 *   signal?: AbortSignal,
 *   attempts?: number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} input
 */
export async function fetchChapterResponse({ url, index, fetchImpl, signal, attempts, sleep }) {
  let host = 'invalid-url';
  try {
    host = new URL(url).host;
  } catch {
    host = 'invalid-url';
  }
  return withChapterRetries(
    async () => {
      const response = await fetchImpl(url, { signal });
      if (!response || response.ok !== true) {
        const status = response && typeof response.status === 'number' ? response.status : 0;
        const error = /** @type {Error & { status?: number }} */ (
          new Error(formatChapterFailure(index, { status, message: `HTTP ${status} from ${host}` }, url))
        );
        error.status = status;
        throw error;
      }
      return response;
    },
    { attempts, sleep }
  );
}

/**
 * @param {(signal: AbortSignal) => Promise<unknown>} work
 * @param {number} timeoutMs
 * @param {string} label
 */
export function withTimeout(work, timeoutMs, label) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const task = Promise.resolve()
    .then(() => work(controller.signal))
    .finally(() => clearTimeout(timer));
  return Promise.race([task, timeout]);
}

/**
 * @param {{
 *   chapters: Array<{ url?: string }>,
 *   startIndex?: number,
 *   fetchChapter: (chapter: { url?: string }, index: number, signal: AbortSignal) => Promise<unknown>,
 *   timeoutMs?: number,
 *   delayMs?: number,
 *   onChapter?: (event: {
 *     phase: 'start' | 'saved' | 'error',
 *     index: number,
 *     total: number,
 *     completed?: number,
 *     message?: string,
 *     url?: string,
 *   }) => void,
 * }} input
 */
export async function runPageFallback({
  chapters,
  startIndex = 0,
  fetchChapter,
  timeoutMs = 120000,
  delayMs = 500,
  onChapter,
}) {
  const total = Array.isArray(chapters) ? chapters.length : 0;
  const errors = [];
  let saved = 0;
  let failed = 0;
  const begin = Number.isInteger(startIndex) && startIndex > 0 ? startIndex : 0;

  for (let index = begin; index < total; index++) {
    const chapter = chapters[index] || {};
    onChapter?.({ phase: 'start', index, total, url: chapter.url });
    try {
      await withTimeout(
        (signal) => fetchChapter(chapter, index, signal),
        timeoutMs,
        `Chapter ${index + 1}`
      );
      saved += 1;
      onChapter?.({ phase: 'saved', index, total, completed: begin + saved });
      if (delayMs > 0 && index < total - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error && error.message ? error.message : 'Unknown error';
      errors.push({ index, message });
      onChapter?.({ phase: 'error', index, total, message });
    }
  }

  return { completed: saved, failed, total, errors };
}
