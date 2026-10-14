import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '../..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

describe('assembled extension packages', () => {
  const chromeRoot = join(root, 'chrome-extension');
  const safariRoot = join(root, 'Shared (Extension)/Resources');

  it('keeps the Chrome and Safari script payloads aligned', () => {
    for (const file of ['background.js', 'content.js', 'iframe-extractor.js', 'iframe-ui.js', 'popup.js']) {
      assert.equal(readFileSync(join(chromeRoot, file), 'utf8'), readFileSync(join(safariRoot, file), 'utf8'));
    }
  });

  it('parses as JavaScript', () => {
    const files = [...walk(chromeRoot), ...walk(safariRoot)].filter((file) => file.endsWith('.js'));
    for (const file of files) {
      const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      assert.equal(checked.status, 0, `${file}\n${checked.stderr}`);
    }
  });

  it('gives Chrome the downloads API and Safari native messaging plus MAIN-world capture', () => {
    const chrome = JSON.parse(read('chrome-extension/manifest.json'));
    const safari = JSON.parse(read('Shared (Extension)/Resources/manifest.json'));

    assert.equal(chrome.manifest_version, 3);
    assert.equal(chrome.version, '1.2.0');
    assert.equal(chrome.background.service_worker, 'background.js');
    assert.equal(chrome.background.type, 'module');
    assert.ok(chrome.permissions.includes('downloads'));
    assert.equal(
      chrome.content_scripts.find((script) => script.js.includes('iframe-extractor.js')).world,
      'MAIN'
    );

    assert.equal(safari.version, '1.2.0');
    assert.deepEqual(safari.background.scripts, ['background.js']);
    assert.equal(safari.background.type, 'module');
    assert.equal(safari.permissions.includes('downloads'), false);
    assert.ok(safari.permissions.includes('cookies'));
    assert.ok(safari.permissions.includes('nativeMessaging'));
    assert.equal(chrome.permissions.includes('nativeMessaging'), false);
    const extractor = safari.content_scripts.find((script) => script.js.includes('iframe-extractor.js'));
    assert.equal(extractor.world, 'MAIN');
    assert.equal(extractor.all_frames, true);
    assert.match(read('Shared (Extension)/Resources/background.js'), /createNativeSaver/);
    assert.match(read('Shared (Extension)/Resources/background.js'), /createChromeSaver/);
    assert.match(read('Shared (Extension)/Resources/iframe-ui.js'), /function isAllowedChapterURL/);
    assert.match(read('Shared (Extension)/Resources/iframe-ui.js'), /chapterFetchCredentials\(\)/);
    assert.doesNotMatch(read('Shared (Extension)/Resources/iframe-ui.js'), /credentials:\s*'include'/);
    assert.ok(safari.host_permissions.some((pattern) => pattern.includes('cdn.overdrive.com')));
    assert.match(read('web/background.js'), /Native save failed; falling back/);
    assert.match(read('web/background.js'), /Save decision:/);
    assert.match(read('web/iframe-ui.js'), /ORGANIZE_METADATA/);
    assert.match(read('web/iframe-ui.js'), /libby-downloader-button/);
    assert.doesNotMatch(read('web/iframe-ui.js'), /flatMetadataFilename/);
    assert.match(read('Shared (Extension)/Resources/content.js'), /Save decision:/);
    assert.match(read('Shared (Extension)/Resources/content.js'), /Page fallback:/);
    assert.match(read('Shared (Extension)/Resources/iframe-ui.js'), /function runPageFallback/);
    assert.match(read('Shared (Extension)/Resources/iframe-ui.js'), /Fallback chapter/);
    assert.doesNotMatch(read('Shared (Extension)/Resources/content.js'), /^\s*export\s+/m);
    assert.ok(existsSync(join(chromeRoot, 'icons/icon128.png')));
    assert.ok(existsSync(join(safariRoot, 'icons/icon48.png')));
  });
});

describe('Xcode project', () => {
  const project = read('libby-downloader.xcodeproj/project.pbxproj');

  it('has macOS and iOS app and extension targets', () => {
    for (const name of [
      'libby-downloader (iOS)',
      'libby-downloader (macOS)',
      'libby-downloader Extension (iOS)',
      'libby-downloader Extension (macOS)',
    ]) {
      assert.match(project, new RegExp(name.replace(/[()]/g, '\\$&')));
    }
    assert.ok(existsSync(join(root, 'libby-downloader.xcodeproj/xcshareddata/xcschemes/libby-downloader (macOS).xcscheme')));
    assert.ok(existsSync(join(root, 'libby-downloader.xcodeproj/xcshareddata/xcschemes/libby-downloader (iOS).xcscheme')));
  });

  it('signs every target and shares the Libby app group', () => {
    assert.equal(project.match(/CODE_SIGN_ENTITLEMENTS = /g).length, 8);
    const entitlements = [
      'macOS (App)/LibbyDownloader.entitlements',
      'macOS (Extension)/LibbyDownloaderExtension.entitlements',
      'iOS (App)/LibbyDownloader.entitlements',
      'iOS (Extension)/LibbyDownloaderExtension.entitlements',
    ];
    for (const file of entitlements) {
      assert.match(read(file), /group\.com\.libbydownloader\.safari/);
    }
    const macExtension = read('macOS (Extension)/LibbyDownloaderExtension.entitlements');
    assert.match(macExtension, /com\.apple\.security\.files\.downloads\.read-write/);
    assert.match(macExtension, /com\.apple\.security\.network\.client/);
    assert.match(macExtension, /com\.apple\.security\.app-sandbox/);
  });

  it('compiles the download store into both extension targets', () => {
    assert.equal(project.match(/DownloadStore\.swift/g).length, 2);
    assert.equal(project.match(/DownloadLibrary\.swift/g).length, 2);
    assert.match(project, /Resources\/lib/);
    assert.match(project, /Resources\/iframe-extractor\.js/);
    const store = read('Shared (Extension)/DownloadStore.swift');
    assert.match(store, /group\.com\.libbydownloader\.safari/);
    assert.match(store, /libby-downloads/);
    assert.match(store, /libbyapp\.com/);
    assert.match(store, /cdn\.overdrive\.com/);
    assert.match(store, /willPerformHTTPRedirection/);
    assert.match(store, /moveFlat/);
    assert.match(store, /isSafeFlatName/);
    assert.match(store, /\.\./);
    assert.match(store, /metadata\.json/);
    const handler = read('Shared (Extension)/SafariWebExtensionHandler.swift');
    assert.match(handler, /SFExtensionMessageKey/);
    assert.doesNotMatch(handler, /group\.wait/);
    assert.match(handler, /native result error=/);
    assert.match(read('LICENSE'), /MIT License/);
    assert.match(read('LICENSE'), /libby-downloader contributors/);
  });
});
