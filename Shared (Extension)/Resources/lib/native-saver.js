/**
 * Safari download backend. The containing app fetches each chapter URL
 * and writes it under the platform download root.
 * Copyright (c) 2026 libby-downloader contributors.
 */

import { buildMetadataDocument } from './metadata.js';
import {
  NATIVE_APPLICATION,
  buildPingMessage,
  buildSaveFromUrlMessage,
  buildSaveTextMessage,
  interpretNativeResponse,
} from './native-protocol.js';
import { formatCookieHeader } from './urls.js';

/**
 * @param {(application: string, message: Record<string, unknown>) => Promise<unknown>} sendNative
 * @param {{ cookiesForUrl?: (url: string) => Promise<Array<{ name: string, value: string }>> }} [options]
 */
export function createNativeSaver(sendNative, { cookiesForUrl } = {}) {
  return {
    application: NATIVE_APPLICATION,

    async ping() {
      try {
        const response = await sendNative(NATIVE_APPLICATION, buildPingMessage());
        return interpretNativeResponse(response);
      } catch (error) {
        return { ok: false, error: nativeChannelError(error) };
      }
    },

    /**
     * @param {{ url: string }} chapter
     * @param {string} title
     * @param {number} index
     */
    async saveChapter(chapter, title, index) {
      let cookieHeader = '';
      if (cookiesForUrl) {
        try {
          cookieHeader = formatCookieHeader(await cookiesForUrl(chapter.url));
        } catch {
          cookieHeader = '';
        }
      }
      const message = buildSaveFromUrlMessage({
        title,
        index,
        url: chapter.url,
        cookieHeader,
      });
      let response;
      try {
        response = await sendNative(NATIVE_APPLICATION, message);
      } catch (error) {
        throw nativeChannelError(error);
      }
      const parsed = interpretNativeResponse(response);
      if (!parsed.ok) throw parsed.error;
      return { downloadId: index + 1, filepath: parsed.path, chapterIndex: index };
    },

    /**
     * @param {unknown} metadata
     * @param {unknown} chapters
     * @param {string} title
     */
    async saveMetadata(metadata, chapters, title) {
      const message = buildSaveTextMessage({
        title,
        text: buildMetadataDocument(metadata, chapters),
      });
      let response;
      try {
        response = await sendNative(NATIVE_APPLICATION, message);
      } catch (error) {
        throw nativeChannelError(error);
      }
      const parsed = interpretNativeResponse(response);
      if (!parsed.ok) throw parsed.error;
      return parsed.path;
    },
  };
}

/**
 * @param {unknown} error
 */
function nativeChannelError(error) {
  const message = error instanceof Error && error.message ? error.message : 'native-channel';
  const wrapped = /** @type {Error & { fallback?: boolean }} */ (new Error(message));
  wrapped.fallback = true;
  return wrapped;
}
