/**
 * Sequential chapter downloads with a short delay between files.
 * The saver is injected so Chrome, Safari, and tests share one loop.
 * Ported from pdugan20/libby-downloader (MIT).
 * Copyright (c) 2026 libby-downloader contributors.
 */

/**
 * @param {number} ms
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {{
 *   chapters: Array<{ url: string, title?: string }>,
 *   title: string,
 *   saveChapter: (chapter: { url: string }, title: string, index: number) => Promise<{ downloadId: number, filepath?: string }>,
 *   delayMs?: number,
 *   onProgress?: (completed: number, total: number) => void,
 * }} input
 */
export async function downloadAllChapters({ chapters, title, saveChapter, delayMs = 500, onProgress }) {
  const results = {
    completed: 0,
    failed: 0,
    total: chapters.length,
    downloadIds: /** @type {number[]} */ ([]),
    paths: /** @type {string[]} */ ([]),
    errors: /** @type {Array<{ chapterIndex: number, error: string }>} */ ([]),
    fallback: false,
  };

  for (let i = 0; i < chapters.length; i++) {
    try {
      const saved = await saveChapter(chapters[i], title, i);
      results.downloadIds.push(saved.downloadId);
      if (saved.filepath) results.paths.push(saved.filepath);
      results.completed++;
      if (onProgress) onProgress(results.completed, results.total);
      if (delayMs > 0 && i < chapters.length - 1) await sleep(delayMs);
    } catch (error) {
      results.failed++;
      results.errors.push({
        chapterIndex: i,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      if (error && /** @type {{ fallback?: boolean }} */ (error).fallback) {
        results.fallback = true;
        break;
      }
    }
  }

  return results;
}
