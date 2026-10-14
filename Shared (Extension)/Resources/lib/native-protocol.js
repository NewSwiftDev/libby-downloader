/**
 * Native messages exchanged with SafariWebExtensionHandler.
 * Safari ignores the application argument and delivers these to the
 * containing app when the name is "application.id".
 * Copyright (c) 2026 libby-downloader contributors.
 */

import { chapterRelativePath, containedRelativePath, metadataRelativePath } from './paths.js';
import { isAllowedChapterURL } from './urls.js';

export const NATIVE_APPLICATION = 'application.id';

export const NativeAction = {
  PING: 'ping',
  SAVE_FROM_URL: 'saveFromUrl',
  SAVE_TEXT: 'saveText',
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
 * @param {{ title: string, text: string }} input
 */
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
 * @param {unknown} response
 * @returns {{ ok: true, path: string, platform?: string } | { ok: false, error: Error & { fallback?: boolean, status?: number } }}
 */
export function interpretNativeResponse(response) {
  const record =
    response && typeof response === 'object' ? /** @type {Record<string, unknown>} */ (response) : null;
  if (!record || record.ok !== true) {
    const code = record && typeof record.error === 'string' ? record.error : 'native-save-failed';
    const error = /** @type {Error & { fallback?: boolean, status?: number }} */ (new Error(code));
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
