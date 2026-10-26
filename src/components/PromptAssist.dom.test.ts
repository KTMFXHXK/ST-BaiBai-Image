import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PromptAssist 的真实挂载测试(自建宿主渲染器,见 testing/hostDom.ts)。
 *
 * 守的是交互链路,而不是纯函数:
 * - default-open 一挂载就查词(上一轮真实页面在这里出过「首屏全是暂无释义」的 bug);
 * - 输入变化/清空后,迟到的搜索结果不许再上屏;
 * - 只有点「插入」才 emit,并且 payload 保真(不动原文);
 * - AI 请求在确认前一次都不发,确认后才发,且只发标签;
 * - 取消后到迟的响应既不显示、也不写缓存;文本变了旧任务彻底作废;
 * - 一个组件实例一份状态,多角色之间互不串味。
 */

const h = vi.hoisted(() => ({
  requestCompletion: vi.fn(),
  requestViaMainApi: vi.fn(),
  getTagGenChannel: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  requestCompletion: h.requestCompletion,
  requestViaMainApi: h.requestViaMainApi,
}));

vi.mock('@/state/settings', () => ({
  getTagGenChannel: h.getTagGenChannel,
}));

import {
  clearTagTranslationCache,
  getTagTranslationCacheSize,
} from '@/i18n/aiTranslate';
import { appendTagToken } from '@/i18n/promptTokens';
import { clearDictionaryCache } from '@/i18n/tagDictionary';
import { installBrowserStubs } from '@/testing/browserStubs';
import {
  byClass,
  firstByClass,
  mountComponent,
  querySelectorAll,
  settle,
  textOf,
  trigger,
  typeInto,
  type FakeNode,
  type Mounted,
} from '@/testing/hostDom';
import type { ChatMsg } from '@/api/client';

import PromptAssist from './PromptAssist.vue';

const SHARDS: Record<string, unknown> = {
  'ha.json': [['hatsune_miku', '初音未来（VOCALOID）', 4, 148075, 0]],
  'bl.json': [['blue_archive', '碧蓝档案', 3, 98000, 0]],
  '001d.json': [['hatsune_miku', '初音未来（VOCALOID）', 4, 148075, 0]],
};

/** fetch 桩:延迟可控,用来构造「迟到的搜索结果」 */
let fetchDelay = 0;

function installDictionary(): void {
  const manifest = {
    version: 7,
    generatedAt: 'gen-1',
    count: 2,
    categoryCounts: { general: 1, character: 1 },
    categories: { '3': 'copyright', '4': 'character' },
    shards: { ha: 'ha.json', bl: 'bl.json' },
    chineseShards: { '1d': '001d.json' },
    popular: {},
    sources: {},
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (fetchDelay) await new Promise(resolve => setTimeout(resolve, fetchDelay));
      const path = new URL(String(input), 'http://localhost/').pathname;
      const file = path.split('/').pop() ?? '';
      if (file === 'manifest.json') return new Response(JSON.stringify(manifest), { status: 200 });
      if (file in SHARDS) return new Response(JSON.stringify(SHARDS[file]), { status: 200 });
      return new Response('[]', { status: 200 });
    }),
  );
}

function installLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
}

/** 收集 emit 的 payload */
function collect(mounted: Mounted, event: 'insert'): string[] {
  void mounted;
  return inserts.splice(0);
}

const inserts: string[] = [];
const insertHandler = (payload: string) => void inserts.push(payload);

async function mountAssist(props: Record<string, unknown>): Promise<Mounted> {
  const mounted = await mountComponent(PromptAssist, { onInsert: insertHandler, ...props });
  await settle();
  return mounted;
}

/** 找到某个组合里的按钮(按可见文字) */
function buttonByText(root: FakeNode, text: string) {
  return querySelectorAll(root, 'button').find(node => textOf(node).includes(text)) ?? null;
}

beforeEach(() => {
  inserts.length = 0;
  fetchDelay = 0;
  h.requestCompletion.mockReset();
  h.requestViaMainApi.mockReset();
  h.getTagGenChannel.mockReset();
  h.getTagGenChannel.mockReturnValue(null); // 默认:跟随主 API(未指派副 API)
  clearDictionaryCache();
  clearTagTranslationCache();
  vi.unstubAllGlobals();
  installBrowserStubs();
  installLocalStorage();
  installDictionary();
});

describe('default-open 与本地查词', () => {
  it('一挂载就查词:不点开也能看到中文(首屏不能全是「暂无释义」)', async () => {
    const mounted = await mountAssist({ text: 'hatsune_miku', kind: 'tag', label: '画面 tag', defaultOpen: true });
    const text = textOf(mounted.root);
    expect(text).toContain('初音未来（VOCALOID）');
    expect(text).toContain('词典');
    expect(text).not.toContain('暂无释义');
    mounted.unmount();
  });

  it('词典查不到时显示「暂无释义」,不拿前缀结果冒充释义', async () => {
    const mounted = await mountAssist({ text: 'nnmbpx', kind: 'tag', defaultOpen: true });
    expect(textOf(mounted.root)).toContain('暂无释义');
    mounted.unmount();
  });
});

describe('查词与插入', () => {
  it('中文前缀能查出英文原文 + 中文含义,点「插入」才 emit', async () => {
    const mounted = await mountAssist({ text: '1girl', kind: 'tag', defaultOpen: true });
    const input = firstByClass(mounted.root, '.bbi-assist-input');
    expect(input).not.toBeNull();
    typeInto(input!, '初音');
    await settle();
    const rows = byClass(mounted.root, '.bbi-assist-result');
    expect(rows.length).toBeGreaterThan(0);
    expect(textOf(rows[0])).toContain('hatsune_miku');
    expect(textOf(rows[0])).toContain('初音未来（VOCALOID）');
    // 只是查出来,还没插入
    expect(inserts).toEqual([]);
    trigger(firstByClass(rows[0], '.bbi-assist-insert')!, 'click');
    expect(inserts).toEqual([appendTagToken('1girl', 'hatsune_miku')]);
    mounted.unmount();
  });

  it('清空输入立刻作废旧结果,迟到的搜索响应不会上屏', async () => {
    const mounted = await mountAssist({ text: '1girl', kind: 'tag', defaultOpen: true });
    const input = firstByClass(mounted.root, '.bbi-assist-input')!;
    fetchDelay = 120;
    typeInto(input, 'hatsune');
    // 防抖还没到就清空:不应该有任何结果,也不该有「查询中」
    typeInto(input, '');
    expect(byClass(mounted.root, '.bbi-assist-result')).toHaveLength(0);
    expect(textOf(mounted.root)).not.toContain('查询中');
    await settle(200);
    expect(byClass(mounted.root, '.bbi-assist-result')).toHaveLength(0);
    mounted.unmount();
  });

  it('只读字段不提供插入(按钮不出现,并且说清楚原因)', async () => {
    const mounted = await mountAssist({
      text: '1girl',
      kind: 'tag',
      defaultOpen: true,
      canInsert: false,
    });
    const input = firstByClass(mounted.root, '.bbi-assist-input')!;
    typeInto(input, 'hatsune');
    await settle();
    expect(byClass(mounted.root, '.bbi-assist-result').length).toBeGreaterThan(0);
    expect(byClass(mounted.root, '.bbi-assist-insert')).toHaveLength(0);
    expect(textOf(mounted.root)).toContain('只读');
    mounted.unmount();
  });
});

describe('AI 翻译:确认前零请求', () => {
  it('预览里说清条数、批次与通道,确认前一次请求都不发', async () => {
    const mounted = await mountAssist({ text: 'nnmbpx, yalmyu', kind: 'tag', defaultOpen: true });
    const button = buttonByText(mounted.root, 'AI 翻译缺失的 2 个标签')!;
    expect(button).not.toBeNull();
    trigger(button, 'click');
    await mounted.flush();
    const text = textOf(mounted.root);
    expect(text).toContain('预计分 1 次请求');
    expect(text).toContain('跟随主 API');
    expect(text).toContain('nnmbpx');
    expect(text).toContain('yalmyu');
    expect(h.requestViaMainApi).not.toHaveBeenCalled();
    expect(h.requestCompletion).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it('确认后只发送缺失的标签,结果标成「AI 翻译」,字段本身不被改动', async () => {
    h.requestViaMainApi.mockImplementation(async (messages: ChatMsg[], opts) => {
      const content = JSON.stringify({ tags: [{ tag: 'nnmbpx', chinese: '某画师专名' }] });
      opts?.validate?.(content);
      return content;
    });
    const mounted = await mountAssist({ text: 'nnmbpx, lowres', kind: 'tag', defaultOpen: true });
    trigger(buttonByText(mounted.root, 'AI 翻译缺失的 2 个标签')!, 'click');
    await mounted.flush();
    trigger(buttonByText(mounted.root, '确认翻译')!, 'click');
    await settle(60);
    const text = textOf(mounted.root);
    expect(text).toContain('某画师专名');
    expect(text).toContain('AI 翻译');
    const sent = (h.requestViaMainApi.mock.calls[0][0] as ChatMsg[]).map(message => message.content).join('\n');
    expect(sent).toContain('nnmbpx');
    expect(sent).toContain('lowres');
    // 只发标签,不带聊天正文/密钥等别的东西
    expect(sent).not.toMatch(/authorization|bearer|api[_ -]?key/i);
    // 翻译只做辅助显示:没有任何插入动作
    expect(inserts).toEqual([]);
    mounted.unmount();
  });
});

describe('取消与过期响应', () => {
  it('运行中有「取消翻译」;取消后迟到的响应不上屏也不写缓存', async () => {
    let finish: ((value: string) => void) | null = null;
    h.requestViaMainApi.mockImplementation(
      async (_messages: ChatMsg[], opts) =>
        await new Promise<string>(resolve => {
          finish = (value: string) => {
            opts?.validate?.(value);
            resolve(value);
          };
        }),
    );
    const mounted = await mountAssist({ text: 'nnmbpx', kind: 'tag', defaultOpen: true });
    trigger(buttonByText(mounted.root, 'AI 翻译缺失的 1 个标签')!, 'click');
    await mounted.flush();
    trigger(buttonByText(mounted.root, '确认翻译')!, 'click');
    await mounted.flush();
    expect(textOf(mounted.root)).toContain('取消翻译');
    trigger(buttonByText(mounted.root, '取消翻译')!, 'click');
    await mounted.flush();
    // 主 API 无法真正中断:如实说明「可能仍在服务端执行并计费」
    expect(textOf(mounted.root)).toContain('可能仍在服务端执行并计费');
    finish!(JSON.stringify({ tags: [{ tag: 'nnmbpx', chinese: '迟到的译文' }] }));
    await settle(60);
    expect(textOf(mounted.root)).not.toContain('迟到的译文');
    expect(getTagTranslationCacheSize()).toBe(0);
    mounted.unmount();
  });

  it('收起面板即取消:副 API 通道给出「已中止」的说法,迟到结果作废', async () => {
    h.getTagGenChannel.mockReturnValue({
      id: 'ch1',
      name: '测试渠道',
      url: 'https://api.example.com',
      key: 'k',
      model: 'm',
      temperature: 1,
      maxTokens: 1024,
      timeoutSec: 60,
      stream: false,
      excludeParams: [],
      reasoningEffort: '',
    });
    let finish: ((value: string) => void) | null = null;
    h.requestCompletion.mockImplementation(
      async (_channel, _messages, opts) =>
        await new Promise<string>(resolve => {
          finish = (value: string) => {
            opts?.validate?.(value);
            resolve(value);
          };
        }),
    );
    const mounted = await mountAssist({ text: 'nnmbpx', kind: 'tag', defaultOpen: true });
    trigger(buttonByText(mounted.root, 'AI 翻译缺失的 1 个标签')!, 'click');
    await mounted.flush();
    trigger(buttonByText(mounted.root, '确认翻译')!, 'click');
    await mounted.flush();
    // 收起 = 离开这个字段
    trigger(firstByClass(mounted.root, '.bbi-assist-toggle')!, 'click');
    await mounted.flush();
    expect(firstByClass(mounted.root, '.bbi-assist-body')).toBeNull();
    // 再展开能看到取消说明,且旧译文不在
    trigger(firstByClass(mounted.root, '.bbi-assist-toggle')!, 'click');
    await settle(60);
    expect(textOf(mounted.root)).toContain('已取消本次翻译');
    finish!(JSON.stringify({ tags: [{ tag: 'nnmbpx', chinese: '迟到译文' }] }));
    await settle(60);
    expect(textOf(mounted.root)).not.toContain('迟到译文');
    mounted.unmount();
  });

  it('文本变了:旧任务的迟到结果不串到新字段上', async () => {
    let finish: ((value: string) => void) | null = null;
    h.requestViaMainApi.mockImplementation(
      async (_messages: ChatMsg[], opts) =>
        await new Promise<string>(resolve => {
          finish = (value: string) => {
            opts?.validate?.(value);
            resolve(value);
          };
        }),
    );
    const mounted = await mountAssist({ text: 'nnmbpx', kind: 'tag', defaultOpen: true });
    trigger(buttonByText(mounted.root, 'AI 翻译缺失的 1 个标签')!, 'click');
    await mounted.flush();
    trigger(buttonByText(mounted.root, '确认翻译')!, 'click');
    await mounted.flush();
    // 换成另一个角色的文本
    await mounted.update({ text: 'yalmyu', kind: 'tag', defaultOpen: true, onInsert: insertHandler });
    await settle(60);
    finish!(JSON.stringify({ tags: [{ tag: 'nnmbpx', chinese: '旧字段的译文' }] }));
    await settle(60);
    expect(textOf(mounted.root)).not.toContain('旧字段的译文');
    expect(textOf(mounted.root)).toContain('yalmyu');
    mounted.unmount();
  });
});

describe('多实例隔离', () => {
  it('两个面板各查各的,释义互不串味', async () => {
    const first = await mountAssist({ text: 'hatsune_miku', kind: 'tag', defaultOpen: true });
    const second = await mountAssist({ text: 'blue_archive', kind: 'tag', defaultOpen: true });
    expect(textOf(first.root)).toContain('初音未来（VOCALOID）');
    expect(textOf(first.root)).not.toContain('碧蓝档案');
    expect(textOf(second.root)).toContain('碧蓝档案');
    expect(textOf(second.root)).not.toContain('初音未来（VOCALOID）');
    first.unmount();
    second.unmount();
    expect(collect(first, 'insert')).toEqual([]);
  });
});

/** 预置本地翻译缓存(模拟上一轮真的翻译过),用于验证缓存读取的合法性过滤 */
function seedTranslationCache(entries: Record<string, string>): void {
  const store = new Map<string, string>([['bbi.tagTranslate.v1', JSON.stringify(entries)]]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
}

/** 结果行上真正标成「AI 翻译」的徽章(入口按钮文案也含这几个字,不能只查整段文本) */
function aiBadges(root: FakeNode): string[] {
  return byClass(root, '.bbi-assist-badge')
    .map(node => textOf(node))
    .filter(label => label === 'AI 翻译');
}

describe('原型键不会被当成译文(AUDIT 复现)', () => {
  for (const key of ['constructor', 'toString', '__proto__']) {
    it(`输入 ${key} 时只有「暂无释义」,不出现伪译文`, async () => {
      const mounted = await mountAssist({ text: key, kind: 'tag', defaultOpen: true });
      const text = textOf(mounted.root);
      expect(text).toContain('暂无释义');
      expect(text).not.toContain('[native code]');
      expect(aiBadges(mounted.root)).toEqual([]);
      expect(text).toContain('0 个有释义');
      // 空缓存 + 零请求:只查了词典,没有触发任何文字 API
      expect(h.requestViaMainApi).not.toHaveBeenCalled();
      expect(h.requestCompletion).not.toHaveBeenCalled();
      mounted.unmount();
    });
  }

  it('同样的键仍然能进入正常补译流程,返回合法中文后正常显示', async () => {
    h.requestViaMainApi.mockImplementation(async (_messages: ChatMsg[], opts?: { validate?: (content: string) => void }) => {
      const content = JSON.stringify({ tags: [{ tag: 'constructor', chinese: '构造函数' }] });
      opts?.validate?.(content);
      return content;
    });
    const mounted = await mountAssist({ text: 'constructor', kind: 'tag', defaultOpen: true });
    expect(textOf(mounted.root)).toContain('暂无释义');

    trigger(buttonByText(mounted.root, 'AI 翻译缺失的 1 个标签')!, 'click');
    await mounted.flush();
    trigger(buttonByText(mounted.root, '确认翻译')!, 'click');
    await settle(60);

    const text = textOf(mounted.root);
    expect(text).toContain('构造函数');
    expect(text).toContain('AI 翻译');
    expect(text).not.toContain('暂无释义');
    expect(h.requestViaMainApi).toHaveBeenCalledTimes(1);
    mounted.unmount();
  });

  it('缓存里只有合法中文才显示,英文原样或空串被忽略', async () => {
    seedTranslationCache({ nnmbpx: '某画师名', yalmyu: 'yalmyu', smiley: '' });

    const good = await mountAssist({ text: 'nnmbpx', kind: 'tag', defaultOpen: true });
    expect(textOf(good.root)).toContain('某画师名');
    expect(textOf(good.root)).toContain('AI 翻译');
    good.unmount();

    // 英文原样不算译文:仍然显示「暂无释义」,也不会出现第二个 AI 翻译徽章
    const echo = await mountAssist({ text: 'yalmyu', kind: 'tag', defaultOpen: true });
    expect(textOf(echo.root)).toContain('暂无释义');
    expect(aiBadges(echo.root)).toEqual([]);
    echo.unmount();

    // 空串同理
    const blank = await mountAssist({ text: 'smiley', kind: 'tag', defaultOpen: true });
    expect(textOf(blank.root)).toContain('暂无释义');
    blank.unmount();
  });

  it('原型键上的取消与迟到响应仍然有效', async () => {
    let finish: ((content: string) => void) | null = null;
    h.requestViaMainApi.mockImplementation(
      () =>
        new Promise<string>(resolve => {
          finish = resolve;
        }),
    );
    const mounted = await mountAssist({ text: 'constructor', kind: 'tag', defaultOpen: true });
    trigger(buttonByText(mounted.root, 'AI 翻译缺失的 1 个标签')!, 'click');
    await mounted.flush();
    trigger(buttonByText(mounted.root, '确认翻译')!, 'click');
    await mounted.flush();

    trigger(buttonByText(mounted.root, '取消翻译')!, 'click');
    await mounted.flush();
    expect(textOf(mounted.root)).not.toContain('迟到的译文');

    finish!(JSON.stringify({ tags: [{ tag: 'constructor', chinese: '迟到的译文' }] }));
    await settle(60);
    expect(textOf(mounted.root)).not.toContain('迟到的译文');
    expect(textOf(mounted.root)).toContain('暂无释义');
    mounted.unmount();
  });

  it('原型键实例与普通实例互不串味', async () => {
    const proto = await mountAssist({ text: 'constructor', kind: 'tag', defaultOpen: true });
    const normal = await mountAssist({ text: 'hatsune_miku', kind: 'tag', defaultOpen: true });
    expect(textOf(proto.root)).toContain('暂无释义');
    expect(textOf(proto.root)).not.toContain('初音未来（VOCALOID）');
    expect(textOf(normal.root)).toContain('初音未来（VOCALOID）');
    expect(textOf(normal.root)).not.toContain('暂无释义');
    proto.unmount();
    normal.unmount();
  });
});
