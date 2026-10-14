import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMetadataGate } from '../lib/metadata-gate.js';
import { buildMetadataDocument } from '../lib/metadata.js';
import {
  NATIVE_APPLICATION,
  buildPingMessage,
  buildMoveFlatMessage,
  buildSaveFromUrlMessage,
  buildSaveTextMessage,
  interpretNativeResponse,
  isSafeFlatDownloadName,
  nativeResponseIsOk,
} from '../lib/native-protocol.js';
import {
  APP_GROUP_ID,
  DOWNLOADS_SUBDIRECTORY,
  chapterBasename,
  chapterRelativePath,
  chromeDownloadFilename,
  containedRelativePath,
  flatDownloadFilename,
  flatMetadataFilename,
  metadataRelativePath,
  sanitizeFilename,
} from '../lib/paths.js';
import {
  describeSaveStrategy,
  detectBrowserName,
  selectSaveStrategy,
  storagePlan,
  supportsMainWorldCapture,
} from '../lib/platform.js';
import { chapterFetchCredentials, formatCookieHeader, isAllowedChapterHost, isAllowedChapterURL } from '../lib/urls.js';
import { validateBookData, validateOrigin } from '../lib/validators.js';

const chapterURL = 'https://dewey-abc.listen.libbyapp.com/spine/0.mp3?cmpt=1';

describe('paths', () => {
  it('sanitizes book titles the way the Chrome extension does', () => {
    assert.equal(sanitizeFilename('Book/With:Invalid*Chars'), 'Book-With-Invalid-Chars');
  });

  it('folds parent segments so a title cannot escape the download folder', () => {
    const cleaned = sanitizeFilename('../../etc/passwd');
    assert.equal(cleaned.includes('/'), false);
    assert.equal(cleaned.includes('..'), false);
    assert.match(cleaned, /etc-passwd/);
    assert.equal(containedRelativePath('../secret/chapter-001.mp3'), null);
    assert.equal(containedRelativePath('/tmp/chapter-001.mp3'), null);
    assert.equal(containedRelativePath('~/Downloads/chapter-001.mp3'), null);
  });

  it('numbers chapters from 1 and keeps them inside the book folder', () => {
    assert.equal(chapterBasename(0), 'chapter-001.mp3');
    assert.equal(chapterBasename(99), 'chapter-100.mp3');
    assert.equal(chapterRelativePath('Test Book', 0), 'Test Book/chapter-001.mp3');
    assert.equal(metadataRelativePath('Test Book'), 'Test Book/metadata.json');
  });

  it('prefixes Chrome download filenames with libby-downloads and leaves native paths relative', () => {
    const relative = chapterRelativePath('Test Book', 0);
    assert.equal(relative.startsWith(`${DOWNLOADS_SUBDIRECTORY}/`), false);
    assert.equal(
      chromeDownloadFilename(relative),
      'libby-downloads/Test Book/chapter-001.mp3'
    );
    assert.equal(
      chromeDownloadFilename(metadataRelativePath('Test Book')),
      'libby-downloads/Test Book/metadata.json'
    );
  });

  it('uses flat names when Safari saves through its download manager', () => {
    assert.equal(flatDownloadFilename('Test Book', 1), 'Test Book - chapter-002.mp3');
    assert.equal(flatMetadataFilename('Test Book'), 'Test Book - metadata.json');
  });

  it('uses the shared app group id', () => {
    assert.equal(APP_GROUP_ID, 'group.com.libbydownloader.safari');
  });
});

describe('urls and platform', () => {
  it('allows Libby chapter URLs and the OverDrive CDN they redirect to', () => {
    assert.equal(isAllowedChapterURL(chapterURL), true);
    assert.equal(isAllowedChapterURL('https://libbyapp.com/a.mp3'), true);
    assert.equal(
      isAllowedChapterURL('https://audioclips.cdn.overdrive.com/x.mp3?cmpt=signed'),
      true
    );
    assert.equal(isAllowedChapterHost('cdn.overdrive.com'), true);
    assert.equal(isAllowedChapterHost('notcdn.overdrive.com'), false);
    assert.equal(isAllowedChapterURL('http://listen.libbyapp.com/a.mp3'), false);
    assert.equal(isAllowedChapterURL('https://evil.com/a.mp3'), false);
    assert.equal(isAllowedChapterURL('https://libbyapp.com.evil.com/a.mp3'), false);
    assert.equal(isAllowedChapterURL('https://evil.cdn.overdrive.com.evil.com/a.mp3'), false);
    assert.equal(isAllowedChapterURL('not a url'), false);
    assert.equal(chapterFetchCredentials(), 'omit');
  });

  it('builds a cookie header and drops injected or huge values', () => {
    assert.equal(
      formatCookieHeader([
        { name: 'session', value: 'abc' },
        { name: 'bad\nname', value: 'x' },
        { name: 'ok', value: 'line\nbreak' },
      ]),
      'session=abc'
    );
    assert.equal(formatCookieHeader([{ name: 'a', value: 'b'.repeat(20000) }]), '');
  });

  it('prefers chrome.downloads, then native messaging, then blob fallback', () => {
    assert.equal(
      selectSaveStrategy({ downloadsDownload() {}, sendNativeMessage() {} }),
      'chrome-downloads'
    );
    assert.equal(selectSaveStrategy({ sendNativeMessage() {} }), 'native');
    assert.equal(selectSaveStrategy({}), 'blob-fallback');
  });

  it('logs why Safari skips downloads.download and why native messaging is missing', () => {
    assert.equal(detectBrowserName('Mozilla/5.0 Version/18.6 Safari/605.1.15'), 'safari');
    assert.equal(
      detectBrowserName('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko)'),
      'safari'
    );
    assert.equal(
      detectBrowserName('Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36'),
      'chrome'
    );
    const safariNative = describeSaveStrategy({
      browserName: 'safari',
      downloadsDownload() {},
      sendNativeMessage() {},
    });
    assert.equal(safariNative.strategy, 'native');
    assert.match(safariNative.reason, /sendNativeMessage/);
    assert.match(safariNative.reason, /ignored/);
    const missing = describeSaveStrategy({ browserName: 'safari' });
    assert.equal(missing.strategy, 'blob-fallback');
    assert.match(missing.reason, /runtime\.sendNativeMessage is undefined/);
    assert.match(missing.reason, /downloads\.download is undefined/);
    const chromeOnly = describeSaveStrategy({ downloadsDownload() {} });
    assert.equal(chromeOnly.strategy, 'chrome-downloads');
    assert.match(chromeOnly.reason, /downloads\.download is a function/);
  });

  it('requires Safari 18 for MAIN-world BIF capture', () => {
    assert.equal(supportsMainWorldCapture('safari', 17), false);
    assert.equal(supportsMainWorldCapture('safari', '18.2'), true);
    assert.equal(supportsMainWorldCapture('chrome', 120), true);
    assert.equal(supportsMainWorldCapture('chrome', 100), false);
  });

  it('stores macOS files in Downloads and iOS files in the app group', () => {
    assert.deepEqual(storagePlan('macos'), {
      kind: 'downloads',
      subdirectory: 'libby-downloads',
    });
    assert.deepEqual(storagePlan('ios'), {
      kind: 'app-group',
      appGroupId: 'group.com.libbydownloader.safari',
      subdirectory: 'libby-downloads',
    });
  });
});

describe('native protocol', () => {
  it('addresses the containing app and asks it to save a chapter URL', () => {
    assert.equal(NATIVE_APPLICATION, 'application.id');
    assert.deepEqual(buildPingMessage(), { action: 'ping' });
    assert.deepEqual(
      buildSaveFromUrlMessage({
        title: 'Test Book',
        index: 0,
        url: chapterURL,
        cookieHeader: 'session=abc',
      }),
      {
        action: 'saveFromUrl',
        relativePath: 'Test Book/chapter-001.mp3',
        url: chapterURL,
        cookie: 'session=abc',
      }
    );
  });

  it('refuses chapter messages that are not Libby URLs', () => {
    assert.throws(
      () =>
        buildSaveFromUrlMessage({
          title: 'Test Book',
          index: 0,
          url: 'https://evil.example/file.mp3',
        }),
      /outside Libby/
    );
  });

  it('moves a flat Safari download into the book folder', () => {
    assert.deepEqual(buildMoveFlatMessage({ title: 'The Runaway Jury', index: 0 }), {
      action: 'moveFlat',
      flatName: 'The Runaway Jury - chapter-001.mp3',
      relativePath: 'The Runaway Jury/chapter-001.mp3',
    });
    assert.equal(isSafeFlatDownloadName('The Runaway Jury - chapter-001.mp3'), true);
    assert.equal(isSafeFlatDownloadName('The Runaway Jury/chapter-001.mp3'), false);
    assert.equal(isSafeFlatDownloadName('../chapter-001.mp3'), false);
  });

  it('writes metadata.json once', () => {
    const gate = createMetadataGate();
    assert.equal(gate.claim(), true);
    assert.equal(gate.claim(), false);
    assert.equal(gate.written, true);
    gate.revoke();
    assert.equal(gate.claim(), true);
    gate.reset();
    assert.equal(gate.written, false);
  });

  it('saves metadata.json beside the chapters', () => {
    const text = buildMetadataDocument({ title: 'Test Book', authors: ['A'] }, []);
    const message = buildSaveTextMessage({ title: 'Test Book', text });
    assert.equal(message.relativePath, 'Test Book/metadata.json');
    assert.equal(JSON.parse(message.text).metadata.title, 'Test Book');
  });

  it('falls back when the app cannot write, but not for invalid paths', () => {
    const http = interpretNativeResponse({ ok: false, error: 'http-401', status: 401 });
    assert.equal(http.ok, false);
    if (!http.ok) {
      assert.equal(http.error.fallback, true);
      assert.equal(http.error.status, 401);
    }
    const invalid = interpretNativeResponse({ ok: false, error: 'invalid-url' });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.error.fallback, false);
    const saved = interpretNativeResponse({
      ok: true,
      path: '/Users/me/Downloads/libby-downloads/Test Book/chapter-001.mp3',
      platform: 'macos',
    });
    assert.equal(saved.ok, true);
    assert.equal(nativeResponseIsOk(1), true);
    const plist = interpretNativeResponse({ ok: 1, path: '/Downloads/libby-downloads/Book' });
    assert.equal(plist.ok, true);
    const detailed = interpretNativeResponse({
      ok: false,
      error: 'http-403',
      status: 403,
      detail: 'HTTP 403 from audioclips.cdn.overdrive.com',
    });
    assert.equal(detailed.ok, false);
    if (!detailed.ok) {
      assert.equal(detailed.error.code, 'http-403');
      assert.equal(detailed.error.fallback, true);
      assert.equal(detailed.error.message, 'http-403: HTTP 403 from audioclips.cdn.overdrive.com');
    }
  });
});

describe('validators', () => {
  it('accepts Libby player origins and complete book data', () => {
    assert.equal(validateOrigin('https://listen.libbyapp.com'), true);
    assert.equal(validateOrigin('https://dewey-abc.listen.libbyapp.com'), true);
    assert.equal(validateOrigin('https://libbyapp.com'), true);
    assert.equal(validateOrigin('https://evil.example'), false);
    assert.equal(
      validateBookData({
        metadata: { title: 'Test Book', authors: ['A'] },
        chapters: [{ index: 0, title: 'Chapter 1', url: chapterURL, duration: 10 }],
      }),
      true
    );
    assert.equal(validateBookData({ metadata: { title: 'Test Book' }, chapters: [] }), false);
  });
});
