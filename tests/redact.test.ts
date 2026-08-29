import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/core/redact/index.js';

describe('redactUrl', () => {
  it('masks an OAuth authorization code but keeps the callback readable', () => {
    expect(redactUrl('https://app.example.com/callback?code=4/0AY0e-g7&state=xyz')).toBe(
      'https://app.example.com/callback?code=[redacted]&state=xyz',
    );
  });

  it('masks an implicit-flow token in the fragment', () => {
    expect(redactUrl('https://app.example.com/#access_token=ya29.a0&token_type=bearer')).toBe(
      'https://app.example.com/#access_token=[redacted]&token_type=bearer',
    );
  });

  it('leaves a single-page app route in the fragment alone', () => {
    const url = 'https://app.example.com/dashboard#/orders/42';
    expect(redactUrl(url)).toBe(url);
  });

  it('keeps state and nonce, which are what someone is usually debugging', () => {
    const url = 'https://app.example.com/cb?state=abc&nonce=def';
    expect(redactUrl(url)).toBe(url);
  });

  it('catches the suffix forms too', () => {
    expect(redactUrl('https://x/y?client_secret=s&x_api_key=k')).toBe(
      'https://x/y?client_secret=[redacted]&x_api_key=[redacted]',
    );
  });

  it('is case-insensitive about the parameter name', () => {
    expect(redactUrl('https://x/y?Access_Token=abc')).toBe('https://x/y?Access_Token=[redacted]');
  });

  it('returns an ordinary URL byte for byte, without re-encoding it', () => {
    const url = 'https://x/search?q=a%20b&sort=desc#top';
    expect(redactUrl(url)).toBe(url);
  });

  it('leaves alone what it cannot parse, rather than mangling it', () => {
    expect(redactUrl('not a url at all')).toBe('not a url at all');
    expect(redactUrl('')).toBe('');
  });

  it('does not mask a parameter that merely contains a secret-ish word', () => {
    const url = 'https://x/y?keyboard=qwerty&tokenizer=bpe';
    expect(redactUrl(url)).toBe(url);
  });
});
