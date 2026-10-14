/**
 * Copy the extension into the Chrome package and the Safari resource folder.
 * Classic scripts cannot import modules, so marked includes are inlined.
 * Copyright (c) 2026 libby-downloader contributors.
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function stripModuleSyntax(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*import\s/.test(line))
    .map((line) => line.replace(/^(\s*)export\s+/, '$1'))
    .join('\n');
}

function resolveIncludes(filename, seen = new Set()) {
  const absolute = resolve(root, filename);
  if (seen.has(absolute)) {
    throw new Error(`Include cycle at ${filename}`);
  }
  seen.add(absolute);
  const source = readFileSync(absolute, 'utf8');
  return source.replace(/\/\*__INCLUDE ([^*]+)__\*\//g, (_match, includePath) => {
    return stripModuleSyntax(resolveIncludes(includePath.trim(), new Set(seen)));
  });
}

/**
 * Safari runs every content script for a frame in one JavaScript world.
 * A second top-level `const MessageTypes` (or `function sleep`) is a
 * SyntaxError and the later script never registers its listeners.
 * An IIFE keeps those bindings private. The guard skips a second injection
 * of the same file, which would otherwise stack the JSON.parse hook.
 */
function wrapClassicScript(source, guardName) {
  const body = source.endsWith('\n') ? source : `${source}\n`;
  return `(() => {
  if (globalThis[${JSON.stringify(guardName)}]) return;
  globalThis[${JSON.stringify(guardName)}] = true;
${body}})();\n`;
}

const classicGuards = {
  'content.js': '__libbyDownloaderContent',
  'iframe-extractor.js': '__libbyDownloaderExtractor',
  'iframe-ui.js': '__libbyDownloaderUi',
};

function writeProcessed(entry, destination) {
  const text = resolveIncludes(entry);
  if (text.includes('/*__INCLUDE') || /^\s*export\s+/m.test(text) || /^\s*import\s+/m.test(text)) {
    throw new Error(`Unresolved module syntax in ${destination}`);
  }
  const fileName = entry.split('/').pop();
  const guarded = wrapClassicScript(text, classicGuards[fileName]);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, guarded);
}

function copyFile(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

function assembleInto(destination, manifestName) {
  mkdirSync(destination, { recursive: true });
  for (const file of ['background.js', 'popup.html', 'popup.js', 'popup.css']) {
    copyFile(resolve(root, 'web', file), resolve(destination, file));
  }
  for (const file of ['content.js', 'iframe-extractor.js', 'iframe-ui.js']) {
    writeProcessed(`web/${file}`, resolve(destination, file));
  }
  copyFile(
    resolve(root, 'web/styles/content-styles.css'),
    resolve(destination, 'styles/content-styles.css')
  );
  copyFile(resolve(root, `web/manifest.${manifestName}.json`), resolve(destination, 'manifest.json'));
  cpSync(resolve(root, 'web/icons'), resolve(destination, 'icons'), { recursive: true });
  cpSync(resolve(root, 'web/_locales'), resolve(destination, '_locales'), { recursive: true });
  cpSync(resolve(root, 'web/lib'), resolve(destination, 'lib'), { recursive: true });
}

assembleInto(resolve(root, 'chrome-extension'), 'chrome');
assembleInto(resolve(root, 'Shared (Extension)/Resources'), 'safari');
console.log('Assembled chrome-extension/ and Shared (Extension)/Resources/');
