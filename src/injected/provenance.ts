/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ProvenanceTrace {
  component: string;
  source: 'props' | 'state';
  keys: string[];
}

export function findProvenance(element: Element | Node, targetValue: string): ProvenanceTrace[] {
  const fiber = getFiberFromNode(element);
  if (!fiber) return [];
  
  let current: unknown = fiber;
  const trace: ProvenanceTrace[] = [];
  const visited = new Set();
  
  while (current && !visited.has(current)) {
    visited.add(current);
    const typeName = typeof (current as any).type === 'function' ? (current as any).type.name : (typeof (current as any).type === 'string' ? (current as any).type : 'Unknown');
    
    if (typeName !== 'Unknown') {
      if ((current as any).memoizedProps) {
         const propKeys = findValueInObject((current as any).memoizedProps, targetValue);
         if (propKeys.length > 0) {
           trace.push({ component: typeName, source: 'props', keys: propKeys });
         }
      }
      
      if ((current as any).memoizedState) {
         const stateKeys = findValueInObject((current as any).memoizedState, targetValue);
         if (stateKeys.length > 0) {
           trace.push({ component: typeName, source: 'state', keys: stateKeys });
         }
      }
    }
    
    current = (current as any).return;
  }
  
  return trace;
}

function getFiberFromNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return null;
  const key = Object.keys(node).find(k => k.startsWith('__reactFiber$'));
  return key ? (node as any)[key] : null;
}

function findValueInObject(obj: unknown, target: string, path: string[] = [], depth = 0): string[] {
  if (depth > 5) return []; // Prevent too deep recursion
  if (!obj || typeof obj !== 'object') return [];
  
  const found: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string' && val.includes(target)) {
      found.push([...path, key].join('.'));
    } else if (typeof val === 'object' && val !== null) {
      // Avoid traversing React internals inside props
      if (key === 'children' || key.startsWith('__')) continue;
      found.push(...findValueInObject(val, target, [...path, key], depth + 1));
    }
  }
  return found;
}
