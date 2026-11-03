import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  collectPlayerChapterUrls,
  isSignedMediaUrl,
  missingPlayerUrlMessage,
  pageFallbackReason,
  partFileKey,
} from '../lib/chapter-urls.js';

const root = resolve(import.meta.dirname, '../..');
const partFile = '{155E3E12-9DBB-40AE-8E57-04F5DD2494D9}Fmt425-Part24.mp3';
const host = 'dewey-798448a22291a2d039c2a861cf221e24.listen.libbyapp.com';
const playerUrl = `https://${host}/${encodeURIComponent(partFile)}?cmpt=player-token&expires=1`;
const staleFetchUrl = `https://${host}/${encodeURIComponent(partFile)}?cmpt=init-token`;

function part(index, path = `${index}.mp3`) {
  return { index, spinePosition: index, path };
}

describe('player chapter URLs', () => {
  it('matches a braced part filename to the player URL path', () => {
    assert.equal(partFileKey(partFile), partFile);
    assert.equal(partFileKey(playerUrl), partFile);
    assert.equal(partFileKey(`spine/${encodeURIComponent(partFile)}`), partFile);
  });

  it('rejects the old cmpt reconstruction and accepts the player media URL', () => {
    assert.equal(isSignedMediaUrl(`https://${host}/${partFile}?undefined`), false);
    assert.equal(isSignedMediaUrl(`https://${host}/${partFile}`), false);
    assert.equal(isSignedMediaUrl('https://evil.example/a.mp3?cmpt=1'), false);
    assert.equal(isSignedMediaUrl(playerUrl), true);
  });

  it('uses the player audio URL and ignores a fetch of the stale cmpt link', async () => {
    let seeks = 0;
    const result = await collectPlayerChapterUrls({
      parts: [part(23, partFile)],
      readEntries: () => [
        { initiatorType: 'fetch', name: staleFetchUrl },
        { initiatorType: 'audio', name: playerUrl },
      ],
      seekToPart() {
        seeks += 1;
        return true;
      },
      sleep: async () => {},
    });
    assert.equal(seeks, 0);
    assert.equal(result[0].source, 'player');
    assert.equal(result[0].url, playerUrl);
    assert.equal(result[0].url.includes('init-token'), false);
  });

  it('keeps the newest audio URL when the player requests the part again', async () => {
    const refreshed = `https://${host}/${encodeURIComponent(partFile)}?cmpt=refreshed&expires=2`;
    const result = await collectPlayerChapterUrls({
      parts: [part(23, partFile)],
      readEntries: () => [
        { initiatorType: 'audio', name: playerUrl },
        { initiatorType: 'media', name: refreshed },
      ],
      sleep: async () => {},
    });
    assert.equal(result[0].url, refreshed);
  });

  it('seeks only parts the player has not requested, then reports a missing one instead of inventing a cmpt URL', async () => {
    const sought = [];
    const first = `https://${host}/Fmt425-Part01.mp3?cmpt=one`;
    let entries = [{ initiatorType: 'audio', name: first }];
    const result = await collectPlayerChapterUrls({
      parts: [part(0, 'Fmt425-Part01.mp3'), part(1, 'Fmt425-Part02.mp3'), part(2, partFile)],
      readEntries: () => entries,
      waitPerPartMs: 100,
      gapMs: 0,
      sleep: async () => {},
      seekToPart(entry) {
        sought.push(entry.index);
        if (entry.index === 1) {
          entries = entries.concat([
            { initiatorType: 'audio', name: `https://${host}/Fmt425-Part02.mp3?cmpt=two` },
          ]);
          return true;
        }
        return false;
      },
    });
    assert.deepEqual(sought, [1, 2]);
    assert.equal(result[0].source, 'player');
    assert.equal(result[0].url, first);
    assert.equal(result[1].url, `https://${host}/Fmt425-Part02.mp3?cmpt=two`);
    assert.equal(result[2].source, 'missing');
    assert.equal(result[2].url, '');
    const message = missingPlayerUrlMessage([result[2]], 3);
    assert.match(message, /1 of 3/);
    assert.match(message, /Fmt425-Part24\.mp3/);
    assert.match(message, /HTTP 500/);
  });

  it('does not prefix a chapter failure with the native-messaging strategy sentence', () => {
    const reason = pageFallbackReason(
      'Chapter 24: HTTP 500 from dewey-798448a22291a2d039c2a861cf221e24.listen.libbyapp.com'
    );
    assert.equal(reason.includes('sendNativeMessage'), false);
    assert.match(reason, /^Chapter 24: HTTP 500 from dewey-/);
    const background = readFileSync(resolve(root, 'web/background.js'), 'utf8');
    assert.equal(background.includes('${decision.reason}; ${'), false);
    assert.equal(background.includes('Native save did not finish'), false);
    const ui = readFileSync(resolve(root, 'web/iframe-ui.js'), 'utf8');
    assert.equal(ui.includes('Native save did not finish'), false);
    const extractor = readFileSync(resolve(root, 'web/iframe-extractor.js'), 'utf8');
    assert.match(extractor, /collectPlayerChapterUrls/);
    assert.match(extractor, /getEntriesByType\('resource'\)/);
    assert.equal(extractor.includes('HTMLMediaElement'), false);
    assert.equal(extractor.includes('odreadCmptParams[spine.spinePosition]'), false);
    const swift = readFileSync(resolve(root, 'Shared (Extension)/DownloadStore.swift'), 'utf8');
    assert.match(swift, /maxChapterAttempts = 2/);
    assert.match(swift, /429, 500, 502, 503/);
  });
});
