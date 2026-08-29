import { describe, expect, it } from 'vitest';
import {
  countByType,
  countFailures,
  flowHost,
  statusClass,
  stepFailed,
  worstLevel,
  worstStatus,
} from '../src/core/flow/index.js';
import type { ConsoleEntry, NetworkCall, Step } from '../src/shared/types.js';

const call = (over: Partial<NetworkCall> = {}): NetworkCall => ({
  method: 'GET',
  url: 'https://example.com/api',
  requestHeaders: {},
  requestBody: null,
  status: 200,
  responseHeaders: {},
  responseBody: null,
  durationMs: 12,
  timestamp: 0,
  ...over,
});

const log = (level: ConsoleEntry['level']): ConsoleEntry => ({
  level,
  args: ['something'],
  timestamp: 0,
});

const step = (over: Partial<Step> = {}): Step =>
  ({
    type: 'click',
    url: 'https://example.com/',
    timestamp: 0,
    action: 'Clicked "Save"',
    element: { tag: 'button', cssSelector: 'button', xpath: '/button', boundingBox: null },
    ...over,
  }) as Step;

describe('statusClass', () => {
  it('bands a status', () => {
    expect(statusClass(204)).toBe('2xx');
    expect(statusClass(301)).toBe('3xx');
    expect(statusClass(404)).toBe('4xx');
    expect(statusClass(503)).toBe('5xx');
  });

  it('treats a request that never got a response as a server failure', () => {
    // The alternative is a call with no number to colour, which reads as fine.
    expect(statusClass(null)).toBe('5xx');
  });
});

describe('worstStatus', () => {
  it('reports the most severe call, not the last one', () => {
    expect(worstStatus([call({ status: 500 }), call({ status: 200 })])).toBe('5xx');
    expect(worstStatus([call({ status: 200 }), call({ status: 404 })])).toBe('4xx');
  });

  it('is null when the step made no requests at all', () => {
    // Distinct from "all fine": the disclosure is not shown for a step with no
    // network activity.
    expect(worstStatus([])).toBeNull();
    expect(worstStatus(undefined)).toBeNull();
  });
});

describe('worstLevel', () => {
  it('ranks by severity rather than by order', () => {
    expect(worstLevel([log('error'), log('log')])).toBe('error');
    expect(worstLevel([log('log'), log('warn')])).toBe('warn');
    expect(worstLevel([log('debug'), log('info')])).toBe('info');
  });

  it('is null when nothing was logged', () => {
    expect(worstLevel(undefined)).toBeNull();
  });
});

describe('stepFailed', () => {
  it('counts a 4xx, a 5xx and a dead request', () => {
    expect(stepFailed(step({ networkCalls: [call({ status: 404 })] }))).toBe(true);
    expect(stepFailed(step({ networkCalls: [call({ status: 500 })] }))).toBe(true);
    expect(stepFailed(step({ networkCalls: [call({ status: null })] }))).toBe(true);
  });

  it('counts a console error, but not a warning', () => {
    // Warnings are noisy on a normal page; treating them as failures would put
    // a red mark on most of the rail and mean nothing.
    expect(stepFailed(step({ consoleLogs: [log('error')] }))).toBe(true);
    expect(stepFailed(step({ consoleLogs: [log('warn')] }))).toBe(false);
  });

  it('leaves a healthy step alone', () => {
    expect(stepFailed(step())).toBe(false);
    expect(
      stepFailed(step({ networkCalls: [call({ status: 200 }), call({ status: 302 })] })),
    ).toBe(false);
  });
});

describe('countByType and countFailures', () => {
  it('tallies what is in a flow, for the library row', () => {
    const steps = [
      step({ type: 'navigate' }),
      step({ type: 'click' }),
      step({ type: 'click' }),
      step({ type: 'input', value: 'x' }),
    ];

    expect(countByType(steps)).toEqual({ navigate: 1, click: 2, input: 1 });
    expect(countFailures(steps)).toBe(0);
    expect(countFailures([...steps, step({ consoleLogs: [log('error')] })])).toBe(1);
  });
});

describe('flowHost', () => {
  it('skips a URL it cannot parse rather than giving up', () => {
    expect(flowHost([step({ url: 'not a url' }), step({ url: 'https://b.example.com/x' })])).toBe(
      'b.example.com',
    );
    expect(flowHost([])).toBe('');
  });
});
