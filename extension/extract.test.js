import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  extractArticle,
  extractTitle,
  extractAuthor,
  MIN_TRANSCRIPT_CHARS,
} from './extract.js';

/**
 * @param {string} html
 * @param {string} [url]
 */
function dom(html, url = 'https://example.com/post') {
  return new JSDOM(html, { url }).window.document;
}

describe('extractTitle', () => {
  it('prefers og:title over h1', () => {
    const doc = dom(`
      <html><head>
        <meta property="og:title" content="OG Title" />
        <title>Doc Title</title>
      </head><body><h1>H1 Title</h1></body></html>
    `);
    assert.equal(extractTitle(doc), 'OG Title');
  });
});

describe('extractAuthor', () => {
  it('reads author meta', () => {
    const doc = dom(`
      <html><head><meta name="author" content="Jane Doe" /></head>
      <body></body></html>
    `);
    assert.equal(extractAuthor(doc), 'Jane Doe');
  });
});

describe('extractArticle', () => {
  it('extracts paragraphs from article', () => {
    const doc = dom(`
      <html><head>
        <meta property="og:title" content="Hello World" />
        <meta name="author" content="Ada" />
        <meta property="og:image" content="https://cdn.example.com/x.jpg" />
      </head>
      <body>
        <nav>Skip me</nav>
        <article>
          <p>${'First paragraph with enough characters to keep. '.repeat(2)}</p>
          <p>${'Second paragraph also long enough for the filter. '.repeat(2)}</p>
        </article>
      </body></html>
    `);
    const out = extractArticle(doc, { pageUrl: 'https://example.com/post' });
    assert.equal(out.title, 'Hello World');
    assert.equal(out.author, 'Ada');
    assert.equal(out.sourceUrl, 'https://example.com/post');
    assert.equal(out.thumbnail, 'https://cdn.example.com/x.jpg');
    assert.equal(out.fromSelection, false);
    assert.ok(out.transcript.includes('First paragraph'));
    assert.ok(out.transcript.includes('Second paragraph'));
    assert.ok(!out.transcript.includes('Skip me'));
  });

  it('prefers a long selection over page body', () => {
    const doc = dom(`
      <html><body><article>
        <p>${'Body text that is long enough to extract on its own. '.repeat(3)}</p>
      </article></body></html>
    `);
    const selection = 'S'.repeat(MIN_TRANSCRIPT_CHARS + 5);
    const out = extractArticle(doc, {
      selection,
      pageUrl: 'https://example.com/paywall',
    });
    assert.equal(out.fromSelection, true);
    assert.equal(out.transcript, selection);
  });

  it('throws when page and selection are too short', () => {
    const doc = dom(`<html><body><p>Hi</p></body></html>`);
    assert.throws(
      () => extractArticle(doc, { pageUrl: 'https://example.com/x' }),
      /enough article text/i
    );
  });
});
