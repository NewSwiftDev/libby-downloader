/**
 * What the loan page should say when the start-download reply is empty.
 * Safari drops a runtime.sendMessage reply that stays open for the whole
 * book. The promise resolves with no payload, and the old alert was the
 * bare string "Download failed".
 * Copyright (c) 2026 libby-downloader contributors.
 */

/**
 * @param {unknown} response
 * @returns {string} Empty when the download was accepted or finished.
 */
export function explainDownloadStartFailure(response) {
  if (response == null || typeof response !== 'object') {
    return (
      'Download failed: Safari closed the extension message before the save finished ' +
      'and returned no error. Chapters already reported as saved are on disk; the rest were interrupted.'
    );
  }
  if (/** @type {{ success?: unknown }} */ (response).success) return '';
  const reason = /** @type {{ error?: unknown }} */ (response).error;
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  return 'Download failed: the extension reported failure without a reason.';
}
