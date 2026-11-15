import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  downloadChaptersRefreshingUrls,
  isNativeChannelFailure,
  shouldRefreshAgain,
} from '../lib/download-session.js';

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.fallback = true;
  return error;
}

describe('per-chapter fresh URLs', () => {
  it('saves each chapter with the URL fetched just before that save', async () => {
    const saved = [];
    const chapters = [
      { url: 'https://listen.libbyapp.com/old-0.mp3?cmpt=stale' },
      { url: '' },
      { url: '' },
    ];
    const result = await downloadChaptersRefreshingUrls({
      chapters,
      title: 'Long Book',
      delayMs: 0,
      refreshUrl: async (_chapter, index) => `https://listen.libbyapp.com/part-${index}.mp3?cmpt=fresh-${index}`,
      saveChapter: async (chapter, _title, index) => {
        saved.push({ index, url: chapter.url });
      },
    });
    assert.equal(result.completed, 3);
    assert.equal(result.failed, 0);
    assert.deepEqual(
      saved.map((item) => item.url),
      [
        'https://listen.libbyapp.com/part-0.mp3?cmpt=fresh-0',
        'https://listen.libbyapp.com/part-1.mp3?cmpt=fresh-1',
        'https://listen.libbyapp.com/part-2.mp3?cmpt=fresh-2',
      ]
    );
  });

  it('keeps saving after chapter 28 and reports that chapter’s HTTP status', async () => {
    const errors = [];
    const saved = [];
    const chapters = [{ url: '' }, { url: '' }, { url: '' }];
    const result = await downloadChaptersRefreshingUrls({
      chapters,
      title: 'Long Book',
      delayMs: 0,
      attempts: 2,
      sleep: async () => {},
      refreshUrl: async (_chapter, index, attempt) => {
        if (index === 1 && attempt === 0) return 'https://listen.libbyapp.com/1.mp3?cmpt=expired';
        return `https://listen.libbyapp.com/${index}.mp3?cmpt=fresh-${attempt}`;
      },
      saveChapter: async (chapter, _title, index) => {
        if (chapter.url.includes('expired')) throw httpError(500, 'Chapter 2: HTTP 500 from dewey.listen.libbyapp.com');
        saved.push(index);
      },
      onChapterError(event) {
        errors.push(event.message);
      },
    });
    assert.deepEqual(saved, [0, 1, 2]);
    assert.equal(result.completed, 3);
    assert.equal(result.failed, 0);
    assert.equal(result.fallback, false);
    assert.deepEqual(errors, []);
    assert.equal(shouldRefreshAgain(httpError(500, 'HTTP 500'), 0, 3), true);
    assert.equal(shouldRefreshAgain(httpError(403, 'HTTP 403'), 0, 3), true);
    assert.equal(shouldRefreshAgain(httpError(400, 'HTTP 400'), 0, 3), false);
  });

  it('records a chapter that still fails and continues with the next one', async () => {
    const errors = [];
    const chapters = [{ url: '' }, { url: '' }];
    const result = await downloadChaptersRefreshingUrls({
      chapters,
      title: 'Long Book',
      delayMs: 0,
      attempts: 2,
      sleep: async () => {},
      refreshUrl: async (_chapter, index) => `https://listen.libbyapp.com/${index}.mp3?cmpt=1`,
      saveChapter: async (_chapter, _title, index) => {
        if (index === 0) throw httpError(500, 'Chapter 1: HTTP 500 from dewey.listen.libbyapp.com (a.mp3)');
      },
      onChapterError(event) {
        errors.push(event.message);
      },
    });
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.fallback, false);
    assert.equal(errors[0], 'Chapter 1: HTTP 500 from dewey.listen.libbyapp.com (a.mp3)');
  });

  it('stops for a dead native channel and names the chapter that was in progress', async () => {
    const channel = new Error('Native chapter 28 timed out after 180000ms');
    channel.fallback = true;
    const chapters = [{ url: 'https://listen.libbyapp.com/0.mp3?cmpt=1' }, { url: '' }, { url: '' }];
    const result = await downloadChaptersRefreshingUrls({
      chapters,
      title: 'Long Book',
      delayMs: 0,
      refreshUrl: async (_chapter, index) => `https://listen.libbyapp.com/${index}.mp3?cmpt=fresh`,
      saveChapter: async (_chapter, _title, index) => {
        if (index === 1) throw channel;
      },
    });
    assert.equal(result.completed, 1);
    assert.equal(result.fallback, true);
    assert.equal(result.startIndex, 1);
    assert.match(result.errors[0].error, /Native chapter 28 timed out/);
    assert.equal(isNativeChannelFailure(channel), true);
    assert.equal(isNativeChannelFailure(httpError(500, 'HTTP 500')), false);
  });
});
