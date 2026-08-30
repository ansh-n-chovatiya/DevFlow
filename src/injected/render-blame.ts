/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unused-vars */

import { AGENT_MESSAGE_SOURCE } from '../shared/constants.js';

export function installRenderBlameInterceptor() {
  const globalHook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!globalHook) return;

  const originalOnCommitFiberRoot = globalHook.onCommitFiberRoot;

  globalHook.onCommitFiberRoot = function(...args: any[]) {
    const [_, root] = args;
    if (root && root.current) {
      try {
        walkTreeForBlame(root.current);
      } catch (err) {
        // Ignore parsing errors
      }
    }
    
    if (originalOnCommitFiberRoot) {
      return originalOnCommitFiberRoot.apply(this, args);
    }
  };
}

function walkTreeForBlame(fiber: any) {
  if (fiber.alternate) {
    const isRendered = fiber.alternate.memoizedProps !== fiber.memoizedProps || fiber.alternate.memoizedState !== fiber.memoizedState;
    if (isRendered) {
      const typeName = typeof fiber.type === 'function' ? fiber.type.name : (typeof fiber.type === 'string' ? fiber.type : 'Unknown');
      if (typeName !== 'Unknown' && typeof fiber.type === 'function') {
        const propsChanged = fiber.alternate.memoizedProps !== fiber.memoizedProps;
        const stateChanged = fiber.alternate.memoizedState !== fiber.memoizedState;
        
        emitRenderBlame({
          component: typeName,
          propsChanged,
          stateChanged,
          timestamp: Date.now()
        });
      }
    }
  }

  let child = fiber.child;
  while (child) {
    walkTreeForBlame(child);
    child = child.sibling;
  }
}

function emitRenderBlame(detail: Record<string, unknown>) {
  window.postMessage({
    __devflow_source__: AGENT_MESSAGE_SOURCE,
    kind: 'render-blame',
    ...detail
  }, '*');
}
