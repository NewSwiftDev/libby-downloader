import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { explainDownloadStartFailure } from '../lib/download-ack.js';
import {
  collectPlayerChapterUrls,
  isSignedMediaUrl,
  mediaUrlForPart,
  missingPlayerUrlMessage,
  pageFallbackReason,
  partFileKey,
  waitForPartUrl,
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

  it('reads the audio element when the resource buffer does not contain the new part', async () => {
    const stale = `https://${host}/${encodeURIComponent(partFile)}?cmpt=old`;
    let entries = [{ initiatorType: 'audio', name: stale }];
    let src = '';
    const found = await waitForPartUrl({
      part: part(27, partFile),
      readEntries: () => entries,
      readAudioSrc: () => src,
      sleep: async () => {},
      waitMs: 200,
      beforeSeek() {
        entries = [];
      },
      seek() {
        src = playerUrl;
        return true;
      },
    });
    assert.equal(found.url, playerUrl);
    assert.equal(mediaUrlForPart(stale, 'other.mp3'), '');
  });

  it('keeps chapter 1 when a seek to the current part does not request audio again', async () => {
    const current = `https://${host}/Fmt425-Part01.mp3?cmpt=already-playing`;
    let seeks = 0;
    const found = await waitForPartUrl({
      part: part(0, 'Fmt425-Part01.mp3'),
      knownUrl: current,
      readEntries: () => [],
      readAudioSrc: () => '',
      sleep: async () => {},
      waitMs: 200,
      seek() {
        seeks += 1;
        return true;
      },
      seekAway() {
        seeks += 1;
        return true;
      },
    });
    assert.equal(found.url, current);
    assert.equal(found.source, 'cached');
    assert.match(found.reason, /Chapter 1:/);
    assert.match(found.reason, /already on this part/);
    assert.match(found.reason, /Fmt425-Part01\.mp3/);
    assert.ok(seeks >= 1);
  });

  it('returns the prefetched URL when seek never settles, instead of hanging', async () => {
    const prefetched = `https://${host}/Fmt425-Part12.mp3?cmpt=prefetched`;
    let sleeps = 0;
    const found = await waitForPartUrl({
      part: part(11, 'Fmt425-Part12.mp3'),
      knownUrl: prefetched,
      readEntries: () => [],
      readAudioSrc: () => '',
      sleep: async () => {
        sleeps += 1;
      },
      waitMs: 2500,
      seek() {
        return new Promise(() => {});
      },
    });
    assert.equal(found.url, prefetched);
    assert.equal(found.source, 'cached');
    assert.match(found.reason, /Chapter 12:/);
    assert.match(found.reason, /seek timed out/);
    assert.match(found.reason, /Fmt425-Part12\.mp3/);
    assert.ok(sleeps >= 1);
  });

  it('reports a bounded timeout when seek hangs and no URL was captured', async () => {
    const found = await waitForPartUrl({
      part: part(11, 'Fmt425-Part12.mp3'),
      readEntries: () => [],
      readAudioSrc: () => '',
      sleep: async () => {},
      waitMs: 100,
      seek() {
        return new Promise(() => {});
      },
    });
    assert.equal(found.url, '');
    assert.match(found.reason, /Chapter 12:/);
    assert.match(found.reason, /seek timed out/);
    assert.match(found.reason, /no URL/);
  });

  it('says when the player never requests that part', async () => {
    const found = await waitForPartUrl({
      part: part(27, partFile),
      readEntries: () => [],
      readAudioSrc: () => '',
      sleep: async () => {},
      waitMs: 100,
      seek() {
        return true;
      },
    });
    assert.equal(found.url, '');
    assert.match(found.reason, /Chapter 28/);
    assert.match(found.reason, /Fmt425-Part24\.mp3/);
    assert.match(found.reason, /did not request/);
  });

  it('explains an empty start-download reply instead of a bare Download failed', () => {
    const text = explainDownloadStartFailure(undefined);
    assert.match(text, /Safari closed the extension message/);
    assert.notEqual(text, 'Download failed');
    assert.equal(explainDownloadStartFailure({ success: true, accepted: true }), '');
    assert.equal(
      explainDownloadStartFailure({ success: false, error: 'Chapter 28: HTTP 500 from dewey.listen.libbyapp.com' }),
      'Chapter 28: HTTP 500 from dewey.listen.libbyapp.com'
    );
    assert.match(explainDownloadStartFailure({ success: false }), /without a reason/);
    const content = readFileSync(resolve(root, 'web/content.js'), 'utf8');
    assert.match(content, /console\.error\('\[Libby Downloader\]', text\)/);
    const background = readFileSync(resolve(root, 'web/background.js'), 'utf8');
    assert.match(background, /accepted: true/);
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
    assert.match(extractor, /waitForPartUrl/);
    assert.match(extractor, /clearResourceTimings/);
    assert.match(extractor, /getEntriesByType\('resource'\)/);
    assert.equal(extractor.includes('HTMLMediaElement'), false);
    assert.equal(extractor.includes('odreadCmptParams[spine.spinePosition]'), false);
    const swift = readFileSync(resolve(root, 'Shared (Extension)/DownloadStore.swift'), 'utf8');
    assert.match(swift, /maxChapterAttempts = 2/);
    assert.match(swift, /429, 500, 502, 503/);
  });
});
