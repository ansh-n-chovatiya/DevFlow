/**
 * State Store Interceptor
 * 
 * Auto-discovers Zustand, Redux DevTools extension instances, and other state stores
 * to track state mutations using lightweight proxies without importing external libraries.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unused-vars */

import { AGENT_MESSAGE_SOURCE } from '../shared/constants.js';

interface StateMutationEvent {
  kind: 'state-mutation';
  store: string;
  action: string;
  payload?: unknown;
  prevState?: unknown;
  nextState?: unknown;
  timestamp: number;
}

function emitStateMutation(detail: Omit<StateMutationEvent, 'kind' | 'timestamp'>) {
  window.postMessage({
    __devflow_source__: AGENT_MESSAGE_SOURCE,
    kind: 'state-mutation',
    timestamp: Date.now(),
    ...detail
  }, '*');
}

function safeStringify(obj: any): string | undefined {
  if (obj === undefined) return undefined;
  try {
    const str = typeof obj === 'object' && obj !== null ? JSON.stringify(obj) : String(obj);
    return str.length > 2000 ? str.slice(0, 2000) + '…' : str;
  } catch {
    return '[Unserializable]';
  }
}

/**
 * Patches the Redux DevTools Extension hook if it exists.
 * Zustand, Redux, and many others use this hook to report state changes.
 */
function patchReduxDevTools() {
  const windowObj = window as any;
  if (!windowObj.__REDUX_DEVTOOLS_EXTENSION__) {
    // Stub it out so stores connecting later will use our proxy
    windowObj.__REDUX_DEVTOOLS_EXTENSION__ = {
      connect: () => createDevToolsProxy('UnknownStore')
    };
    return;
  }

  const originalConnect = windowObj.__REDUX_DEVTOOLS_EXTENSION__.connect;
  windowObj.__REDUX_DEVTOOLS_EXTENSION__.connect = function connect(options: any) {
    const storeName = options?.name || 'UnknownStore';
    const connection = originalConnect.call(this, options);
    
    const originalSend = connection.send;
    if (originalSend) {
      connection.send = function send(action: any, state: any) {
        try {
          emitStateMutation({
            store: storeName,
            action: action?.type || 'UNKNOWN_ACTION',
            payload: safeStringify(action?.payload),
            nextState: safeStringify(state)
          });
        } catch (e) {
          // Ignore errors during interception
        }
        return originalSend.call(this, action, state);
      };
    }

    return connection;
  };
}

function createDevToolsProxy(storeName: string) {
  return {
    send: (action: any, state: any) => {
      try {
        emitStateMutation({
          store: storeName,
          action: action?.type || 'UNKNOWN_ACTION',
          payload: safeStringify(action?.payload),
          nextState: safeStringify(state)
        });
      } catch (e) {
        // Ignore
      }
    },
    init: () => {},
    subscribe: () => () => {},
    unsubscribe: () => {},
    error: () => {}
  };
}

export function installStateInterceptor() {
  try {
    patchReduxDevTools();
  } catch (err) {
    console.warn('[DevFlow] Failed to install state interceptor', err);
  }
}
