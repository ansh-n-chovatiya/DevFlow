/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { findProvenance } from '../src/injected/provenance.js';

describe('Provenance Engine', () => {
  it('finds value in memoizedProps', () => {
    const fiber = {
      type: function TestComponent() {},
      memoizedProps: { title: 'Hello World' },
      return: null,
    };
    
    const node = {
      __reactFiber$123: fiber,
    };
    
    const trace = findProvenance(node as any, 'Hello');
    expect(trace).toHaveLength(1);
    expect(trace[0]).toEqual({
      component: 'TestComponent',
      source: 'props',
      keys: ['title']
    });
  });

  it('finds value in memoizedState', () => {
    const fiber = {
      type: function StateComponent() {},
      memoizedProps: {},
      memoizedState: {
        nested: {
           value: 'TargetValue123'
        }
      },
      return: null,
    };
    
    const node = {
      __reactFiber$123: fiber,
    };
    
    const trace = findProvenance(node as any, 'TargetValue');
    expect(trace).toHaveLength(1);
    expect(trace[0]).toEqual({
      component: 'StateComponent',
      source: 'state',
      keys: ['nested.value']
    });
  });

  it('handles unknown components and climbs the tree', () => {
    const parentFiber = {
      type: function Parent() {},
      memoizedProps: { text: 'DeepTarget' },
      return: null
    };
    
    const childFiber = {
      type: 'div',
      memoizedProps: {},
      return: parentFiber
    };
    
    const node = {
      __reactFiber$123: childFiber,
    };
    
    const trace = findProvenance(node as any, 'DeepTarget');
    expect(trace).toHaveLength(1);
    expect(trace[0]).toEqual({
      component: 'Parent',
      source: 'props',
      keys: ['text']
    });
  });
});
