import { describe, expect, it } from 'vitest';
import { healthUrl } from '../src/features/mcp/health.js';

/**
 * The setting points at the endpoint flows are POSTed to; the health check lives
 * at the root of the same origin. Getting this wrong means "Test connection"
 * reports a working server as unreachable.
 */
describe('healthUrl', () => {
  it('replaces the path, keeping the origin', () => {
    expect(healthUrl('http://127.0.0.1:7734/flows')).toBe('http://127.0.0.1:7734/health');
  });

  it('discards a deeper path rather than appending to it', () => {
    expect(healthUrl('https://flows.example.com/api/v2/flows')).toBe(
      'https://flows.example.com/health',
    );
  });

  it('keeps a non-default port', () => {
    expect(healthUrl('http://localhost:9000/flows')).toBe('http://localhost:9000/health');
  });

  it('returns null for something that is not a URL, rather than throwing', () => {
    expect(healthUrl('127.0.0.1:7734')).toBeNull();
    expect(healthUrl('')).toBeNull();
  });
});
