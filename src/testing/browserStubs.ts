/**
 * 组件测试用的浏览器最小桩:只补 Vue 组件真正会碰到的那些 API。
 *
 * 项目没有 jsdom(也不许装),但 `PromptEditor` / `BbiTextarea` 会用到
 * `document.addEventListener('keydown')`、`window.getComputedStyle`、`ResizeObserver`、
 * `requestAnimationFrame`。这些在 node 里没有,补成「无副作用、可观察」的替身,
 * 组件代码一行都不用为测试改。
 */
import { vi } from 'vitest';

import { FakeNode } from './hostDom';

export interface BrowserStubs {
  /** 记录 document 上的监听器(用于从测试里按 Esc) */
  documentHandlers: Map<string, Array<(event: unknown) => void>>;
  /** 模拟在 document 上按键 */
  pressDocumentKey: (key: string) => void;
  restore: () => void;
}

const STYLE = {
  borderTopWidth: '1px',
  borderBottomWidth: '1px',
  lineHeight: '21px',
};

export function installBrowserStubs(): BrowserStubs {
  const documentHandlers = new Map<string, Array<(event: unknown) => void>>();

  const documentStub = {
    addEventListener(type: string, handler: (event: unknown) => void) {
      const list = documentHandlers.get(type) ?? [];
      list.push(handler);
      documentHandlers.set(type, list);
    },
    removeEventListener(type: string, handler: (event: unknown) => void) {
      const list = documentHandlers.get(type) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    createElement: (tag: string) => new FakeNode(tag),
    querySelector: () => null,
    body: new FakeNode('body'),
    activeElement: null as FakeNode | null,
  };

  const windowStub = {
    document: documentStub,
    innerWidth: 1200,
    innerHeight: 900,
    getComputedStyle: () => STYLE,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
  };

  class ResizeObserverStub {
    observe(): void {
      /* 不触发:测试不验证高度自适应 */
    }
    unobserve(): void {
      /* noop */
    }
    disconnect(): void {
      /* noop */
    }
  }

  vi.stubGlobal('window', windowStub);
  vi.stubGlobal('document', documentStub);
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('requestAnimationFrame', windowStub.requestAnimationFrame);
  vi.stubGlobal('cancelAnimationFrame', windowStub.cancelAnimationFrame);
  vi.stubGlobal('getComputedStyle', windowStub.getComputedStyle);

  return {
    documentHandlers,
    pressDocumentKey(key: string) {
      for (const handler of documentHandlers.get('keydown') ?? []) {
        handler({
          key,
          stopPropagation: () => undefined,
          preventDefault: () => undefined,
        });
      }
    },
    restore() {
      vi.unstubAllGlobals();
      documentHandlers.clear();
    },
  };
}
