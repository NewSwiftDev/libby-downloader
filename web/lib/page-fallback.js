/**
 * In-page chapter fetch used when the containing app cannot write files.
 * Each chapter has a timeout so a hung CDN request cannot stall the book.
 * Copyright (c) 2026 libby-downloader contributors.
 */

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
