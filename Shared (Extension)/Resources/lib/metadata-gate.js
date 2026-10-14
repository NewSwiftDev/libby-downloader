/**
 * One metadata.json write per download, shared by the native save and the
 * page fallback so the two paths cannot each emit a copy.
 * Copyright (c) 2026 libby-downloader contributors.
 */

export function createMetadataGate() {
  let written = false;
  return {
    get written() {
      return written;
    },
    /**
     * @returns {boolean} true when this caller should write the file
     */
    claim() {
      if (written) return false;
      written = true;
      return true;
    },
    revoke() {
      written = false;
    },
    reset() {
      written = false;
    },
  };
}
