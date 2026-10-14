/**
 * Chrome download backend. Filenames are relative to ~/Downloads.
 * Ported from pdugan20/libby-downloader (MIT).
 * Copyright (c) 2026 libby-downloader contributors.
 */

import { buildMetadataDocument } from './metadata.js';
import { chapterRelativePath, chromeDownloadFilename, metadataRelativePath } from './paths.js';

/**
 * @param {{ search: (query: { id: number }) => Promise<Array<{ state?: string, filename?: string, error?: string }>> }} downloads
 * @param {number} downloadId
 * @param {number} [intervalMs]
 * @returns {Promise<string>}
 */
export function waitForDownload(downloads, downloadId, intervalMs = 500) {
  return new Promise((resolve, reject) => {
    const checkInterval = setInterval(async () => {
      try {
        const results = await downloads.search({ id: downloadId });
        if (!results || results.length === 0) {
          clearInterval(checkInterval);
          reject(new Error('Download not found'));
          return;
        }

        const download = results[0];
        if (download.state === 'complete') {
          clearInterval(checkInterval);
          if (download.filename) resolve(download.filename);
          else reject(new Error('Download completed but filename is undefined'));
          return;
        }

        if (download.state === 'interrupted' || download.error) {
          clearInterval(checkInterval);
          reject(new Error(download.error || 'Download interrupted'));
        }
      } catch (error) {
        clearInterval(checkInterval);
        reject(error instanceof Error ? error : new Error('Download status failed'));
      }
    }, intervalMs);
  });
}

/**
 * @param {{
 *   download: (options: { url: string, filename: string, saveAs: boolean }) => Promise<number>,
 *   search: (query: { id: number }) => Promise<Array<{ state?: string, filename?: string, error?: string }>>,
 * }} downloads
 * @param {{ intervalMs?: number }} [options]
 */
export function createChromeSaver(downloads, { intervalMs = 500 } = {}) {
  return {
    /**
     * @param {{ url: string }} chapter
     * @param {string} title
     * @param {number} index
     */
    async saveChapter(chapter, title, index) {
      const filename = chromeDownloadFilename(chapterRelativePath(title, index));
      const downloadId = await downloads.download({
        url: chapter.url,
        filename,
        saveAs: false,
      });
      const filepath = await waitForDownload(downloads, downloadId, intervalMs);
      return { downloadId, filepath, chapterIndex: index };
    },

    /**
     * @param {unknown} metadata
     * @param {unknown} chapters
     * @param {string} title
     */
    async saveMetadata(metadata, chapters, title) {
      const metadataContent = buildMetadataDocument(metadata, chapters);
      const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(metadataContent)}`;
      return downloads.download({
        url: dataUrl,
        filename: chromeDownloadFilename(metadataRelativePath(title)),
        saveAs: false,
      });
    },
  };
}
