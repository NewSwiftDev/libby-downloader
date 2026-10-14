/**
 * Download paths shared by the Chrome extension and the Safari port.
 * Ported from pdugan20/libby-downloader (MIT).
 * Copyright (c) 2026 libby-downloader contributors.
 */

export const DOWNLOADS_SUBDIRECTORY = 'libby-downloads';
export const APP_GROUP_ID = 'group.com.libbydownloader.safari';

/**
 * Make a single path segment safe for macOS, iOS, and Windows.
 * Slashes are turned into dashes before ".." is folded, so the result
 * cannot escape the book folder.
 * @param {unknown} filename
 * @returns {string}
 */
export function sanitizeFilename(filename) {
  const cleaned = String(filename ?? '')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\.\./g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .substring(0, 200)
    .trim();
  return cleaned || 'Untitled';
}

/**
 * @param {number} index Zero-based chapter index.
 * @returns {string} chapter-001.mp3
 */
export function chapterBasename(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('Chapter index must be a non-negative integer');
  }
  return `chapter-${String(index + 1).padStart(3, '0')}.mp3`;
}

/** Path relative to the libby-downloads root. */
export function chapterRelativePath(title, index) {
  return `${sanitizeFilename(title)}/${chapterBasename(index)}`;
}

/** Path relative to the libby-downloads root. */
export function metadataRelativePath(title) {
  return `${sanitizeFilename(title)}/metadata.json`;
}

/**
 * chrome.downloads filenames are relative to ~/Downloads, so they include
 * the libby-downloads directory. Native messages are relative to that root.
 * @param {string} relativePath
 */
export function chromeDownloadFilename(relativePath) {
  const contained = containedRelativePath(relativePath);
  if (!contained) {
    throw new Error('Unsafe download path');
  }
  return `${DOWNLOADS_SUBDIRECTORY}/${contained}`;
}

/** Safari's download manager cannot create folders, so fallback names are flat. */
export function flatDownloadFilename(title, index) {
  return `${sanitizeFilename(title)} - ${chapterBasename(index)}`;
}

export function flatMetadataFilename(title) {
  return `${sanitizeFilename(title)} - metadata.json`;
}

/**
 * Accept only a relative path with no parent segments.
 * @param {unknown} relativePath
 * @returns {string | null}
 */
export function containedRelativePath(relativePath) {
  if (typeof relativePath !== 'string') return null;
  const trimmed = relativePath.trim();
  if (!trimmed || trimmed.includes('\\') || trimmed.startsWith('/') || trimmed.startsWith('~')) {
    return null;
  }
  const parts = trimmed.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  if (parts.some((part) => part.startsWith('.') || /[\u0000-\u001f]/.test(part))) return null;
  return parts.join('/');
}
