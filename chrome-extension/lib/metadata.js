/**
 * metadata.json document written beside chapter MP3s.
 * The upstream CLI reads this shape when tagging files.
 * Copyright (c) 2026 libby-downloader contributors.
 */

/**
 * @param {unknown} metadata
 * @param {unknown} chapters
 * @returns {string}
 */
export function buildMetadataDocument(metadata, chapters) {
  return JSON.stringify({ metadata, chapters }, null, 2);
}
