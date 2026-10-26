/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 极简宿主渲染器:在 node 环境里真实挂载 Vue 组件(项目没有 jsdom,也不许装)。
 *
 * 【为什么不是「假的组件」】
 * 这些测试必须走真实组件的模板、真实事件处理、真实 watch/代际逻辑 —— 只有 DOM 层是假的。
 * 所以这里实现的是 Vue `createRenderer` 要求的 host 接口(建节点/插节点/改属性/读文本),
 * 组件照样被 mount、被 patch、被 unmount,只是节点活在一个纯 JS 的树里。
 *
 * 【支持范围】够用即可:元素/文本/注释节点、class 与属性、事件处理、按 class/tag 查询。
 * 不实现布局与 CSS:scrollHeight 是常量,getComputedStyle 返回固定边框与行高。
 */
import { createRenderer, defineComponent, h, nextTick, reactive, type Component } from 'vue';

export class FakeNode {
  tag: string;
  parent: FakeNode | null = null;
  children: FakeNode[] = [];
  props: Record<string, any> = {};
  style: Record<string, string> = {};
  text = '';
  scrollHeight = 48;
  clientHeight = 48;
  scrollWidth = 320;
  readonly nodeType = 1;

  constructor(tag: string) {
    this.tag = tag;
  }

  /** <Transition> 会直接调 classList.add/remove,这里给个真的集合 */
  transitionClasses = new Set<string>();

  classList = {
    add: (name: string) => void this.transitionClasses.add(name),
    remove: (name: string) => void this.transitionClasses.delete(name),
    contains: (name: string) => this.transitionClasses.has(name),
  };

  /** Vue 的 class 绑定可能是字符串、数组或对象,这里统一成空格分隔的串 */
  get className(): string {
    const value = this.props.class;
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(item => new FakeNode('x').mergeClass(item)).join(' ');
    return Object.entries(value)
      .filter(([, on]) => Boolean(on))
      .map(([name]) => name)
      .join(' ');
  }

  private mergeClass(value: unknown): string {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(item => this.mergeClass(item)).join(' ');
    if (typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>)
        .filter(([, on]) => Boolean(on))
        .map(([name]) => name)
        .join(' ');
    }
    return '';
  }

  get textContent(): string {
    if (this.tag === '#text') return this.text;
    return this.children.map(child => child.textContent).join('');
  }

  /** 输入框的当前值:组件的 onInput/v-model 读的是 element.value */
  get value(): string {
    return String(this.props.value ?? '');
  }

  set value(next: string) {
    this.props.value = next;
  }

  /**
   * 原生监听器:Vue 的 v-model 走的是运行时指令 vModelText,
   * 它用 addEventListener('input') 挂监听(不是 props.onInput),所以这里必须真存。
   */
  listeners: Record<string, Array<(event: unknown) => void>> = {};

  addEventListener(name: string, handler: (event: unknown) => void): void {
    (this.listeners[name] ??= []).push(handler);
  }

  removeEventListener(name: string, handler: (event: unknown) => void): void {
    const list = this.listeners[name];
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  setAttribute(name: string, value: unknown): void {
    this.props[name] = value;
  }

  getAttribute(name: string): any {
    return this.props[name];
  }

  focus(): void {
    this.props['data-focused'] = true;
  }

  blur(): void {
    /* noop */
  }

  querySelector(selector: string): FakeNode | null {
    return querySelectorAll(this, selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeNode[] {
    return querySelectorAll(this, selector);
  }
}

/** 只支持 `tag` / `.class` / `tag.class1.class2` 这几种组合,测试够用 */
export function querySelectorAll(root: FakeNode, selector: string): FakeNode[] {
  const parts = selector.trim().split(/(?=[.#])/);
  const tag = parts[0] && !parts[0].startsWith('.') && !parts[0].startsWith('#') ? parts[0] : '';
  const classes = parts
    .filter(part => part.startsWith('.'))
    .map(part => part.slice(1))
    .filter(Boolean);
  const ids = parts.filter(part => part.startsWith('#')).map(part => part.slice(1));
  const found: FakeNode[] = [];
  const walk = (node: FakeNode) => {
    for (const child of node.children) {
      walk(child);
      if (child.tag === '#text' || child.tag === '#comment') continue;
      if (tag && child.tag !== tag) continue;
      const classList = child.className.split(/\s+/).filter(Boolean);
      if (classes.some(name => !classList.includes(name))) continue;
      if (ids.some(id => child.props.id !== id)) continue;
      found.push(child);
    }
  };
  walk(root);
  return found;
}

/** 触发元素上的 Vue 事件处理(支持单个函数或函数数组) */
export function trigger(el: FakeNode, event: string, payload: Record<string, unknown> = {}): void {
  const handler = el.props[`on${event[0].toUpperCase()}${event.slice(1)}`];
  const eventObject = {
    type: event,
    target: el,
    currentTarget: el,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
    ...payload,
  };
  if (typeof handler === 'function') handler(eventObject);
  else if (Array.isArray(handler)) handler.forEach(item => typeof item === 'function' && item(eventObject));
  // 原生监听器(v-model 等指令挂在这条路径上)
  const listeners = el.listeners[event] ?? [];
  listeners.slice().forEach(listener => listener(eventObject));
}

/** 给输入框填值并触发 input(走组件真实的 v-model / IME 分支) */
export function typeInto(el: FakeNode, value: string, event = 'input'): void {
  el.props.value = value;
  trigger(el, event, { target: el });
}

export interface Mounted {
  root: FakeNode;
  /** 重新渲染同一个组件(用来改 props,验证 props 变化后的代际与状态清理) */
  update: (props: Record<string, unknown>) => Promise<void>;
  unmount: () => void;
  flush: () => Promise<void>;
}

const renderer = createRenderer<FakeNode, FakeNode>({
  patchProp(el, key, _prev, next) {
    el.props[key] = next;
  },
  insert(el, parent, anchor) {
    el.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index >= 0) parent.children.splice(index, 0, el);
    else parent.children.push(el);
  },
  remove(el) {
    const parent = el.parent;
    if (!parent) return;
    const index = parent.children.indexOf(el);
    if (index >= 0) parent.children.splice(index, 1);
    el.parent = null;
  },
  createElement: tag => new FakeNode(tag),
  createText: text => {
    const node = new FakeNode('#text');
    node.text = text;
    return node;
  },
  createComment: text => {
    const node = new FakeNode('#comment');
    node.text = text;
    return node;
  },
  setText(node, text) {
    node.text = text;
  },
  setElementText(node, text) {
    node.children = [];
    if (text) {
      const child = new FakeNode('#text');
      child.text = text;
      child.parent = node;
      node.children.push(child);
    }
  },
  parentNode: node => node.parent,
  nextSibling(node) {
    const parent = node.parent;
    if (!parent) return null;
    const index = parent.children.indexOf(node);
    return parent.children[index + 1] ?? null;
  },
  querySelector: selector => documentRoot.querySelector(selector),
  setScopeId(el, id) {
    el.props[`data-scope-${id}`] = '';
  },
});

const documentRoot = new FakeNode('#document');

/** 挂载一个组件到假宿主的干净根节点上,返回查询/操作入口 */
export async function mountComponent(
  component: Component,
  props: Record<string, unknown> = {},
): Promise<Mounted> {
  const root = new FakeNode('#root');
  documentRoot.children.push(root);
  root.parent = documentRoot;
  // 必须走 createApp:组件 setup 里的 inject/useSSRContext 都依赖 appContext,
  // 直接 renderer.render() 会因为没有 appContext 在 setup 阶段就炸掉。
  const state = reactive<{ props: Record<string, unknown> }>({ props });
  const Host = defineComponent({
    name: 'HostRoot',
    setup() {
      return () => h(component, state.props);
    },
  });
  const app = renderer.createApp(Host);
  try {
    app.mount(root);
  } catch (error) {
    // vitest 的源码映射会把 setup 内的帧折叠成 .vue 尾部行号,这里补一份原始堆栈
    console.error('[hostDom] mount failed:', error instanceof Error ? error.stack : error);
    throw error;
  }
  await nextTick();
  await nextTick();
  return {
    root,
    update: async nextProps => {
      state.props = nextProps;
      await nextTick();
      await nextTick();
    },
    unmount: () => {
      app.unmount();
      const index = documentRoot.children.indexOf(root);
      if (index >= 0) documentRoot.children.splice(index, 1);
    },
    flush: async () => {
      await nextTick();
      await nextTick();
    },
  };
}

/** 等异步链路(防抖 250ms + fetch)走完;不用假定时器,免得和真实 Promise 交错 */
export async function settle(ms = 320): Promise<void> {
  await nextTick();
  await new Promise(resolve => setTimeout(resolve, ms));
  await nextTick();
  await nextTick();
}

export function textOf(node: FakeNode | null | undefined): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function byClass(root: FakeNode, selector: string): FakeNode[] {
  return querySelectorAll(root, selector);
}

export function firstByClass(root: FakeNode, selector: string): FakeNode | null {
  return querySelectorAll(root, selector)[0] ?? null;
}

export function byText(root: FakeNode, selector: string, text: string): FakeNode[] {
  return querySelectorAll(root, selector).filter(node => textOf(node).includes(text));
}
