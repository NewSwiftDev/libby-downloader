import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { explainDownloadStartFailure } from '../lib/download-ack.js';
import {
  describeReadyChapter,
  fanOutPlayerResult,
  findPlayerUrl,
  isSignedMediaUrl,
  mediaUrlForPart,
  pageFallbackReason,
  partFileKey,
  shouldSeekForUrl,
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
    const found = await waitForPartUrl({
      part: part(23, partFile),
      readEntries: () => [
        { initiatorType: 'fetch', name: staleFetchUrl },
        { initiatorType: 'audio', name: playerUrl },
      ],
      sleep: async () => {},
      waitMs: 50,
      seek() {
        return true;
      },
    });
    assert.equal(found.url, playerUrl);
    assert.equal(found.url.includes('init-token'), false);
  });

  it('keeps the newest audio URL when the player requests the part again', async () => {
    const refreshed = `https://${host}/${encodeURIComponent(partFile)}?cmpt=refreshed&expires=2`;
    const found = await waitForPartUrl({
      part: part(23, partFile),
      readEntries: () => [
        { initiatorType: 'audio', name: playerUrl },
        { initiatorType: 'media', name: refreshed },
      ],
      sleep: async () => {},
      waitMs: 50,
      seek() {
        return true;
      },
    });
    assert.equal(found.url, refreshed);
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
    const found = await waitForPartUrl({
      part: part(11, 'Fmt425-Part12.mp3'),
      knownUrl: prefetched,
      readEntries: () => [],
      readAudioSrc: () => '',
      sleep: async () => {},
      waitMs: 30,
      seek() {
        return new Promise(() => {});
      },
    });
    assert.equal(found.url, prefetched);
    assert.equal(found.source, 'cached');
    assert.match(found.reason, /Chapter 12:/);
    assert.match(found.reason, /seek timed out/);
    assert.match(found.reason, /Fmt425-Part12\.mp3/);
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

  it('does not call a prefetched chapter ready when the only URL is the one already captured', async () => {
    const prefetched = `https://${host}/Fmt425-Part22.mp3?cmpt=already`;
    let seeks = 0;
    const found = await waitForPartUrl({
      part: part(21, 'Fmt425-Part22.mp3'),
      knownUrl: prefetched,
      readEntries: () => [],
      readAudioSrc: () => prefetched,
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
    assert.equal(found.url, prefetched);
    assert.equal(found.source, 'cached');
    assert.match(found.reason, /Chapter 22:/);
    assert.match(found.reason, /Fmt425-Part22\.mp3/);
    const ready = describeReadyChapter(22, found);
    assert.equal(ready.ready, true);
    assert.match(ready.line, /already requested, Fmt425-Part22\.mp3/);
    assert.equal(ready.line.includes('""'), false);
    assert.equal(shouldSeekForUrl(prefetched, 0), false);
    assert.equal(shouldSeekForUrl(prefetched, 1), true);
    assert.equal(shouldSeekForUrl('', 0), true);
    assert.equal(seeks >= 1, true);
  });

  it('matches a UUID player filename to a shorter spine path and survives a cleared buffer', () => {
    const full = '{39CCD9C4-811C-472E-A5B8-BDCD69C95CA2}Fmt425-Part22.mp3';
    const url = `https://${host}/${encodeURIComponent(full)}?cmpt=fresh`;
    const map = new Map([[full, url]]);
    assert.equal(findPlayerUrl(map, 'Fmt425-Part22.mp3'), url);
    assert.equal(findPlayerUrl(map, full), url);
    assert.equal(findPlayerUrl(map, 'Fmt425-Part99.mp3'), '');
  });

  it('posts the player URL to the parent even when event.source throws', () => {
    const posts = [];
    const result = fanOutPlayerResult({ ok: true, url: playerUrl }, {
      source() {
        throw new Error('Safari event.source');
      },
      parent(payload) {
        posts.push(payload);
      },
    });
    assert.deepEqual(result.errors, ['source']);
    assert.deepEqual(result.sent, ['parent']);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, playerUrl);
  });

  it('refuses an empty player URL instead of logging ready', () => {
    const ready = describeReadyChapter(22, { url: '', source: 'player', reason: '' });
    assert.equal(ready.ready, false);
    assert.match(ready.line, /Chapter 22: player URL is empty/);
    assert.equal(ready.line.trim().endsWith('""'), false);
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
