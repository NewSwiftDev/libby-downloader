/**
 * Choose how a book is saved.
 * Safari does not implement chrome.downloads, so the containing app writes
 * the files. If that channel is missing, the player frame saves flat files.
 * Copyright (c) 2026 libby-downloader contributors.
 */

import { APP_GROUP_ID, DOWNLOADS_SUBDIRECTORY } from './paths.js';

export const MAIN_WORLD_SAFARI_VERSION = 18;

/**
 * @param {{ downloadsDownload?: unknown, sendNativeMessage?: unknown }} [capabilities]
 * @returns {'chrome-downloads' | 'native' | 'blob-fallback'}
 */
export function selectSaveStrategy({ downloadsDownload, sendNativeMessage } = {}) {
  if (typeof downloadsDownload === 'function') return 'chrome-downloads';
  if (typeof sendNativeMessage === 'function') return 'native';
  return 'blob-fallback';
}

/**
 * MAIN-world content scripts (needed to read window.BIF and hook JSON.parse)
 * require Safari 18 or newer. Chrome has had them since Manifest V3.
 * @param {string} browserName
 * @param {string | number} version
 */
export function supportsMainWorldCapture(browserName, version) {
  const major = Number.parseInt(String(version), 10);
  if (!Number.isFinite(major)) return false;
  if (browserName === 'chrome' || browserName === 'chromium' || browserName === 'edge') {
    return major >= 111;
  }
  if (browserName === 'safari') return major >= MAIN_WORLD_SAFARI_VERSION;
  return false;
}

/**
 * @param {'macos' | 'ios' | string} platform
 */
export function storagePlan(platform) {
  if (platform === 'ios') {
    return {
      kind: 'app-group',
      appGroupId: APP_GROUP_ID,
      subdirectory: DOWNLOADS_SUBDIRECTORY,
    };
  }
  return {
    kind: 'downloads',
    subdirectory: DOWNLOADS_SUBDIRECTORY,
  };
}
