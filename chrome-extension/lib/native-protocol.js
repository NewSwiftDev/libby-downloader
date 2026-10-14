/**
 * Native messages exchanged with SafariWebExtensionHandler.
 * Safari ignores the application argument and delivers these to the
 * containing app when the name is "application.id".
 * Copyright (c) 2026 libby-downloader contributors.
 */

import {
  chapterRelativePath,
  containedRelativePath,
  flatDownloadFilename,
  metadataRelativePath,
} from './paths.js';
import { isAllowedChapterURL } from './urls.js';

export const NATIVE_APPLICATION = 'application.id';

export const NativeAction = {
  PING: 'ping',
  SAVE_FROM_URL: 'saveFromUrl',
  SAVE_TEXT: 'saveText',
  MOVE_FLAT: 'moveFlat',
};

export function buildPingMessage() {
  return { action: NativeAction.PING };
}

/**
 * @param {{ title: string, index: number, url: string, cookieHeader?: string }} input
 */
export function buildSaveFromUrlMessage({ title, index, url, cookieHeader = '' }) {
  const relativePath = chapterRelativePath(title, index);
  if (!containedRelativePath(relativePath) || !relativePath.endsWith('.mp3')) {
    throw new Error('Unsafe chapter path');
  }
  if (!isAllowedChapterURL(url)) {
    throw new Error('Refusing chapter URL outside Libby');
  }
  /** @type {{ action: string, relativePath: string, url: string, cookie?: string }} */
  const message = {
    action: NativeAction.SAVE_FROM_URL,
    relativePath,
    url,
  };
  if (cookieHeader) message.cookie = cookieHeader;
  return message;
}

/**
 * Safari's download manager saves a flat name in ~/Downloads. The app moves
 * that file into libby-downloads/<title>/chapter-NNN.mp3.
 * @param {{ title: string, index: number }} input
 */
export function buildMoveFlatMessage({ title, index }) {
  const relativePath = chapterRelativePath(title, index);
  const flatName = flatDownloadFilename(title, index);
  if (!containedRelativePath(relativePath) || !relativePath.endsWith('.mp3')) {
    throw new Error('Unsafe chapter path');
  }
  if (!isSafeFlatDownloadName(flatName)) {
    throw new Error('Unsafe flat download name');
  }
  return {
    action: NativeAction.MOVE_FLAT,
    flatName,
    relativePath,
  };
}

/**
 * A download-attribute filename is one path segment. Slashes would let it
 * escape ~/Downloads, and Safari ignores them anyway.
 * @param {unknown} name
 */
export function isSafeFlatDownloadName(name) {
  if (typeof name !== 'string' || !name || name.length > 240) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  if (name.startsWith('.') || /[\r\n\u0000]/.test(name)) return false;
  return name.endsWith('.mp3');
}

export function buildSaveTextMessage({ title, text }) {
  const relativePath = metadataRelativePath(title);
  if (!containedRelativePath(relativePath) || !relativePath.endsWith('/metadata.json')) {
    throw new Error('Unsafe metadata path');
  }
  if (typeof text !== 'string') throw new Error('Metadata text must be a string');
  return {
    action: NativeAction.SAVE_TEXT,
    relativePath,
    text,
  };
}

/**
 * Safari sometimes delivers plist booleans as 1.
 * @param {unknown} value
 */
export function nativeResponseIsOk(value) {
  return value === true || value === 1 || value === 'true';
}

/**
 * @param {unknown} response
 * @returns {{ ok: true, path: string, platform?: string } | { ok: false, error: Error & { fallback?: boolean, status?: number, code?: string } }}
 */
export function interpretNativeResponse(response) {
  const record =
    response && typeof response === 'object' ? /** @type {Record<string, unknown>} */ (response) : null;
  if (!record || !nativeResponseIsOk(record.ok)) {
    const code = record && typeof record.error === 'string' ? record.error : 'native-save-failed';
    const detail = record && typeof record.detail === 'string' ? record.detail : '';
    const error = /** @type {Error & { fallback?: boolean, status?: number, code?: string }} */ (
      new Error(detail ? `${code}: ${detail}` : code)
    );
    error.code = code;
    error.fallback = !code.startsWith('invalid-');
    if (typeof record?.status === 'number') error.status = record.status;
    return { ok: false, error };
  }
  return {
    ok: true,
    path: typeof record.path === 'string' ? record.path : '',
    platform: typeof record.platform === 'string' ? record.platform : undefined,
  };
}
