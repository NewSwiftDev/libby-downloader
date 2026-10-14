import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '../..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function pngSize(file) {
  const buf = readFileSync(file);
  assert.equal(buf[0], 0x89);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
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
    for (const size of [16, 32, 48, 96, 128]) {
      assert.deepEqual(pngSize(join(chromeRoot, `icons/icon${size}.png`)), { width: size, height: size });
      assert.deepEqual(pngSize(join(safariRoot, `icons/icon${size}.png`)), { width: size, height: size });
      assert.equal(chrome.icons[String(size)], `icons/icon${size}.png`);
      assert.equal(safari.icons[String(size)], `icons/icon${size}.png`);
    }
    assert.equal(chrome.action.default_icon['32'], 'icons/icon32.png');
    assert.equal(safari.action.default_icon, 'images/toolbar-icon.svg');
    assert.match(readFileSync(join(safariRoot, 'images/toolbar-icon.svg'), 'utf8'), /fill="#000"/);
    assert.match(readFileSync(join(chromeRoot, 'images/toolbar-icon.svg'), 'utf8'), /fill="#000"/);
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

  it('compiles the shared AppIcon catalog into both apps', () => {
    assert.equal(project.match(/ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;/g).length, 4);
    assert.match(project, /Assets\.xcassets/);
    const catalog = JSON.parse(read('Shared (App)/Assets.xcassets/AppIcon.appiconset/Contents.json'));
    const iconset = join(root, 'Shared (App)/Assets.xcassets/AppIcon.appiconset');
    assert.ok(existsSync(join(root, 'design/AppIcon.svg')));
    const seen = new Set();
    for (const image of catalog.images) {
      assert.ok(image.filename, JSON.stringify(image));
      const [width, height] = image.size.split('x').map(Number);
      const scale = image.scale === '2x' ? 2 : 1;
      assert.deepEqual(pngSize(join(iconset, image.filename)), {
        width: width * scale,
        height: height * scale,
      });
      seen.add(`${image.idiom || image.platform}:${image.size}:${image.scale || '1x'}:${image.appearances?.[0]?.value || 'any'}`);
    }
    for (const slot of ['16x16:1x', '16x16:2x', '32x32:1x', '32x32:2x', '128x128:1x', '128x128:2x', '256x256:1x', '256x256:2x', '512x512:1x', '512x512:2x']) {
      assert.ok(seen.has(`mac:${slot}:any`), slot);
    }
    assert.ok(seen.has('universal:1024x1024:1x:any'));
    assert.ok(seen.has('universal:1024x1024:1x:dark'));
    assert.ok(seen.has('universal:1024x1024:1x:tinted'));
  });
});
