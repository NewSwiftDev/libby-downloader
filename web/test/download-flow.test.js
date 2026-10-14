import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createChromeSaver, waitForDownload } from '../lib/chrome-downloads.js';
import { downloadAllChapters } from '../lib/download-orchestrator.js';
import { createNativeSaver } from '../lib/native-saver.js';
import { runPageFallback } from '../lib/page-fallback.js';

const chapters = [
  { index: 0, title: 'Chapter 1', url: 'https://listen.libbyapp.com/0.mp3?cmpt=1', duration: 10 },
  { index: 1, title: 'Chapter 2', url: 'https://listen.libbyapp.com/1.mp3?cmpt=2', duration: 10 },
  { index: 2, title: 'Chapter 3', url: 'https://listen.libbyapp.com/2.mp3?cmpt=3', duration: 10 },
];

function errorWithFallback(message) {
  const error = new Error(message);
  error.fallback = true;
  return error;
}

describe('downloadAllChapters', () => {
  it('saves every chapter and reports progress', async () => {
    const seen = [];
    const result = await downloadAllChapters({
      chapters,
      title: 'Test Book',
      delayMs: 0,
      saveChapter: async (_chapter, _title, index) => {
        seen.push(index);
        return { downloadId: index + 1, filepath: `chapter-${index}.mp3` };
      },
      onProgress: (completed, total) => seen.push(`${completed}/${total}`),
    });
    assert.equal(result.completed, 3);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.downloadIds, [1, 2, 3]);
    assert.deepEqual(seen, [0, '1/3', 1, '2/3', 2, '3/3']);
  });

  it('continues after a normal chapter failure', async () => {
    const result = await downloadAllChapters({
      chapters: chapters.slice(0, 2),
      title: 'Test Book',
      delayMs: 0,
      saveChapter: async (_chapter, _title, index) => {
        if (index === 0) throw new Error('Network error');
        return { downloadId: 2, filepath: '/tmp/chapter-002.mp3' };
      },
    });
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.fallback, false);
    assert.equal(result.errors[0].chapterIndex, 0);
  });

  it('stops and asks for the blob fallback when the native channel fails', async () => {
    let calls = 0;
    const result = await downloadAllChapters({
      chapters,
      title: 'Test Book',
      delayMs: 0,
      saveChapter: async (_chapter, _title, index) => {
        calls += 1;
        if (index === 1) throw errorWithFallback('http-401');
        return { downloadId: index + 1, filepath: '/tmp/a.mp3' };
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.completed, 1);
    assert.equal(result.fallback, true);
    assert.equal(result.errors[0].error, 'http-401');
  });
});

describe('page fallback loop', () => {
  it('saves later chapters when an earlier fetch times out', async () => {
    const events = [];
    const result = await runPageFallback({
      chapters: [{ url: 'https://listen.libbyapp.com/0.mp3' }, { url: 'https://audioclips.cdn.overdrive.com/1.mp3' }],
      timeoutMs: 30,
      delayMs: 0,
      fetchChapter(_chapter, index) {
        if (index === 0) return new Promise(() => {});
        return Promise.resolve('saved');
      },
      onChapter(event) {
        events.push(event.phase === 'error' ? `${event.phase}:${event.index}:${event.message}` : `${event.phase}:${event.index}`);
      },
    });
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.total, 2);
    assert.match(result.errors[0].message, /Chapter 1 timed out after 30ms/);
    assert.deepEqual(events, [
      'start:0',
      'error:0:Chapter 1 timed out after 30ms',
      'start:1',
      'saved:1',
    ]);
  });

  it('records a chapter error and continues', async () => {
    const result = await runPageFallback({
      chapters: [{ url: 'https://listen.libbyapp.com/a.mp3' }, { url: 'https://listen.libbyapp.com/b.mp3' }],
      timeoutMs: 1000,
      delayMs: 0,
      fetchChapter(_chapter, index) {
        if (index === 0) throw new Error('HTTP 403');
        return Promise.resolve('saved');
      },
    });
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.errors[0].message, 'HTTP 403');
  });
});

describe('chrome downloads', () => {
  it('waits until the downloads API reports completion', async () => {
    let polls = 0;
    const filepath = await waitForDownload(
      {
        search: async () => {
          polls += 1;
          if (polls < 2) return [{ state: 'in_progress' }];
          return [{ state: 'complete', filename: '/Users/me/Downloads/libby-downloads/Test Book/chapter-001.mp3' }];
        },
      },
      4,
      1
    );
    assert.match(filepath, /chapter-001\.mp3$/);
  });

  it('rejects interrupted downloads', async () => {
    await assert.rejects(
      waitForDownload(
        {
          search: async () => [{ state: 'interrupted', error: 'SERVER_FAILED' }],
        },
        1,
        1
      ),
      /SERVER_FAILED/
    );
  });

  it('saves chapter-001.mp3 under libby-downloads with saveAs off', async () => {
    const calls = [];
    const saver = createChromeSaver(
      {
        download: async (options) => {
          calls.push(options);
          return 7;
        },
        search: async () => [{ state: 'complete', filename: '/path/to/file.mp3' }],
      },
      { intervalMs: 1 }
    );
    const saved = await saver.saveChapter(chapters[0], 'Book/With:Invalid*Chars', 0);
    assert.equal(saved.downloadId, 7);
    assert.deepEqual(calls[0], {
      url: chapters[0].url,
      filename: 'libby-downloads/Book-With-Invalid-Chars/chapter-001.mp3',
      saveAs: false,
    });
    await saver.saveMetadata({ title: 'Test Book', authors: [] }, chapters, 'Test Book');
    assert.equal(calls[1].filename, 'libby-downloads/Test Book/metadata.json');
    assert.match(calls[1].url, /^data:application\/json/);
  });
});

describe('native saver', () => {
  it('pings the containing app and forwards the chapter URL plus cookies', async () => {
    const sent = [];
    const saver = createNativeSaver(
      async (application, message) => {
        sent.push({ application, message });
        if (message.action === 'ping') return { ok: true, platform: 'macos' };
        return { ok: true, path: `/Users/me/Downloads/libby-downloads/${message.relativePath}` };
      },
      {
        cookiesForUrl: async () => [{ name: 'session', value: 'abc' }],
      }
    );
    const ping = await saver.ping();
    assert.equal(ping.ok, true);
    const saved = await saver.saveChapter(chapters[0], 'Test Book', 0);
    assert.equal(saved.filepath, '/Users/me/Downloads/libby-downloads/Test Book/chapter-001.mp3');
    assert.equal(sent[1].application, 'application.id');
    assert.equal(sent[1].message.cookie, 'session=abc');
    assert.equal(sent[1].message.action, 'saveFromUrl');
  });

  it('marks a dead native channel as a fallback and keeps the runtime error', async () => {
    const saver = createNativeSaver(async () => {
      throw new Error('The native application is not running');
    });
    const ping = await saver.ping();
    assert.equal(ping.ok, false);
    if (!ping.ok) assert.equal(ping.error.message, 'The native application is not running');
    await assert.rejects(saver.saveChapter(chapters[0], 'Test Book', 0), (error) => {
      assert.equal(error.fallback, true);
      assert.equal(error.message, 'The native application is not running');
      return true;
    });
  });

  it('forwards a CDN chapter URL to the containing app', async () => {
    const cdnChapter = {
      url: 'https://audioclips.cdn.overdrive.com/clip.mp3?cmpt=signed',
    };
    let sent;
    const saver = createNativeSaver(async (_application, message) => {
      sent = message;
      return { ok: true, path: '/Users/me/Downloads/libby-downloads/Test Book/chapter-001.mp3' };
    });
    await saver.saveChapter(cdnChapter, 'Test Book', 0);
    assert.equal(sent.url, cdnChapter.url);
    assert.equal(sent.action, 'saveFromUrl');
  });
});
