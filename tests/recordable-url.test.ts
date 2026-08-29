import { describe, expect, it } from 'vitest';
import { isRecordableUrl } from '../src/chrome/tabs.js';

describe('isRecordableUrl', () => {
  it('accepts ordinary web pages', () => {
    expect(isRecordableUrl('https://app.example.com/orders?id=1')).toBe(true);
    expect(isRecordableUrl('http://localhost:3000/')).toBe(true);
  });

  it('accepts local files, which are a legitimate thing to record', () => {
    expect(isRecordableUrl('file:///Users/me/report.html')).toBe(true);
  });

  it("rejects Chrome's own pages, where extensions cannot run", () => {
    expect(isRecordableUrl('chrome://extensions')).toBe(false);
    expect(isRecordableUrl('chrome://newtab/')).toBe(false);
    expect(isRecordableUrl('chrome-extension://abcdef/popup.html')).toBe(false);
    expect(isRecordableUrl('chrome-untrusted://media-app')).toBe(false);
    expect(isRecordableUrl('devtools://devtools/bundled/inspector.html')).toBe(false);
    expect(isRecordableUrl('about:blank')).toBe(false);
    expect(isRecordableUrl('view-source:https://example.com')).toBe(false);
  });

  it('rejects the Web Store, which is https but still off-limits', () => {
    expect(isRecordableUrl('https://chromewebstore.google.com/detail/abc')).toBe(false);
    expect(isRecordableUrl('https://chrome.google.com/webstore')).toBe(false);
  });

  it('rejects other schemes rather than assuming they work', () => {
    expect(isRecordableUrl('ftp://files.example.com/')).toBe(false);
    expect(isRecordableUrl('data:text/html,hello')).toBe(false);
  });

  it('rejects a missing or unparseable URL', () => {
    expect(isRecordableUrl(undefined)).toBe(false);
    expect(isRecordableUrl('')).toBe(false);
    expect(isRecordableUrl('not a url')).toBe(false);
  });
});
