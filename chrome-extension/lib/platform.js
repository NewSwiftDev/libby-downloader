/**
 * Choose how a book is saved.
 * Safari does not implement chrome.downloads, so the containing app writes
 * the files. If that channel is missing, the player frame saves flat files.
 * Copyright (c) 2026 libby-downloader contributors.
 */

import { APP_GROUP_ID, DOWNLOADS_SUBDIRECTORY } from './paths.js';

export const MAIN_WORLD_SAFARI_VERSION = 18;

/**
 * Safari's user agent does not include Chrome's token. Chrome's does.
 * @param {string} [userAgent]
 * @returns {'safari' | 'chrome' | 'unknown'}
 */
export function detectBrowserName(userAgent = '') {
  if (/Chrome\/|Chromium\/|Edg\//.test(userAgent)) return 'chrome';
  // Extension background pages on Safari are WebKit and sometimes omit the Safari token.
  if (/Safari\/|AppleWebKit\//.test(userAgent)) return 'safari';
  return 'unknown';
}

/**
 * Chrome saves with downloads.download. Safari must use the containing app
 * even if a downloads.download function is also present.
 * @param {{ downloadsDownload?: unknown, sendNativeMessage?: unknown, browserName?: string }} [capabilities]
 * @returns {{ strategy: 'chrome-downloads' | 'native' | 'blob-fallback', reason: string }}
 */
export function describeSaveStrategy({ downloadsDownload, sendNativeMessage, browserName } = {}) {
  const downloadType = typeof downloadsDownload;
  const nativeType = typeof sendNativeMessage;
  if (browserName === 'safari') {
    if (nativeType === 'function') {
      return {
        strategy: 'native',
        reason:
          downloadType === 'function'
            ? 'Safari uses runtime.sendNativeMessage; downloads.download is ignored'
            : 'runtime.sendNativeMessage is a function',
      };
    }
    return {
      strategy: 'blob-fallback',
      reason: `Safari has no native messaging (runtime.sendNativeMessage is ${nativeType}; downloads.download is ${downloadType})`,
    };
  }
  if (downloadType === 'function') {
    return { strategy: 'chrome-downloads', reason: 'downloads.download is a function' };
  }
  if (nativeType === 'function') {
    return { strategy: 'native', reason: 'runtime.sendNativeMessage is a function' };
  }
  return {
    strategy: 'blob-fallback',
    reason: `downloads.download is ${downloadType}; runtime.sendNativeMessage is ${nativeType}`,
  };
}

/**
 * @param {{ downloadsDownload?: unknown, sendNativeMessage?: unknown, browserName?: string }} [capabilities]
 * @returns {'chrome-downloads' | 'native' | 'blob-fallback'}
 */
export function selectSaveStrategy(capabilities) {
  return describeSaveStrategy(capabilities).strategy;
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
