/**
 * Chapter URLs are only fetched from Libby and the OverDrive CDN Libby
 * redirects to. audioclips.cdn.overdrive.com answers with
 * Access-Control-Allow-Origin: *, so a credentialed page fetch is rejected.
 * Keep this host list in sync with DownloadStore.isAllowedFetchHost.
 * Copyright (c) 2026 libby-downloader contributors.
 */

const CHAPTER_HOST_SUFFIXES = ['libbyapp.com', 'cdn.overdrive.com'];

/**
 * @param {unknown} hostname
 * @returns {boolean}
 */
export function isAllowedChapterHost(hostname) {
  if (typeof hostname !== 'string' || !hostname) return false;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return CHAPTER_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * @param {unknown} urlString
 * @returns {boolean}
 */
export function isAllowedChapterURL(urlString) {
  if (typeof urlString !== 'string' || !urlString) return false;
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return isAllowedChapterHost(url.hostname);
}

/**
 * Page fetches must omit cookies. The signed listen.libbyapp.com URL
 * redirects to the OverDrive CDN, and a credentialed request cannot use
 * that host's wildcard CORS header.
 * @returns {'omit'}
 */
export function chapterFetchCredentials() {
  return 'omit';
}

/**
 * Build a Cookie header from extension cookies.getAll results.
 * Drops values that could inject headers. An oversized header is omitted
 * so the native app can still try the URL, and the page-cookie fallback
 * remains available.
 * @param {unknown} cookies
 * @returns {string}
 */
export function formatCookieHeader(cookies) {
  if (!Array.isArray(cookies)) return '';
  const parts = [];
  for (const cookie of cookies) {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') continue;
    if (!cookie.name || /[\r\n;]/.test(cookie.name) || /[\r\n]/.test(cookie.value)) continue;
    parts.push(`${cookie.name}=${cookie.value}`);
  }
  const header = parts.join('; ');
  if (header.length > 16384) return '';
  return header;
}
