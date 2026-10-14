/**
 * Shared validators for Libby Downloader.
 * Ported from pdugan20/libby-downloader (MIT).
 * Copyright (c) 2026 libby-downloader contributors.
 */

const VALID_ORIGIN_PATTERNS = [
  /^https:\/\/([a-z0-9-]+\.)?listen\.libbyapp\.com$/,
  /^https:\/\/([a-z0-9-]+\.)?thunder\.libbyapp\.com$/,
  /^https:\/\/([a-z0-9-]+\.)?libbyapp\.com$/,
];

/**
 * @param {string} origin
 * @returns {boolean}
 */
export function validateOrigin(origin) {
  if (typeof window !== 'undefined' && origin === window.location.origin) {
    return true;
  }
  return VALID_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

/**
 * @param {unknown} bookData
 * @returns {bookData is { metadata: { title: string, authors: unknown[] }, chapters: Array<{ index: number, title: string, url: string, duration: number }> }}
 */
export function validateBookData(bookData) {
  if (!bookData || typeof bookData !== 'object') return false;

  const data = /** @type {Record<string, unknown>} */ (bookData);
  if (!data.metadata || typeof data.metadata !== 'object') return false;

  const metadata = /** @type {Record<string, unknown>} */ (data.metadata);
  const chapters = data.chapters;

  if (!metadata.title || typeof metadata.title !== 'string') return false;
  if (!Array.isArray(metadata.authors)) return false;
  if (!Array.isArray(chapters) || chapters.length === 0) return false;

  const firstChapter = /** @type {Record<string, unknown>} */ (chapters[0]);
  if (
    typeof firstChapter.index !== 'number' ||
    typeof firstChapter.title !== 'string' ||
    typeof firstChapter.url !== 'string' ||
    typeof firstChapter.duration !== 'number'
  ) {
    return false;
  }

  return true;
}
