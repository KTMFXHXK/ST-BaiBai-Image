import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 「编辑提示词」弹窗的接线验证(真实挂载 PromptEditor,不是只测组件本身)。
 *
 * 为什么必须这么测:上一轮只验证了独立的 PromptAssist 面板,没有人证明
 * 「画面 tag / 负面词 / 每个角色的 tag 与自然语言」真的接上了正确的字段,
 * 也没有人证明「插入会改英文草稿,翻译不会改」「保存事件里不含中文辅助状态」。
 * 这里用同一个自建宿主渲染器把弹窗整体挂起来,只把文字 API 与词典数据换成夹具。
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

vi.mock('@/state/settings', async importOriginal => {
  const actual = await importOriginal<typeof import('@/state/settings')>();
  return { ...actual, getTagGenChannel: h.getTagGenChannel };
});

import type { ChatMsg } from '@/api/client';
import type { ImageTagContent } from '@/st/imageTagRegex';
import { appendTagToken } from '@/i18n/promptTokens';
import { clearDictionaryCache } from '@/i18n/tagDictionary';
import { clearTagTranslationCache } from '@/i18n/aiTranslate';
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

import PromptEditor from './PromptEditor.vue';

const SHARDS: Record<string, unknown> = {
  'ha.json': [['hatsune_miku', '初音未来（VOCALOID）', 4, 148075, 0]],
  'bl.json': [['blue_archive', '碧蓝档案', 3, 98000, 0]],
  'lo.json': [['lowres', '低分辨率', 5, 900000, 0]],
  'sm.json': [['smile', '微笑', 0, 500000, 0]],
  '001d.json': [['hatsune_miku', '初音未来（VOCALOID）', 4, 148075, 0]],
};

function installDictionary(): void {
  const manifest = {
    version: 7,
    generatedAt: 'gen-1',
    count: 5,
    categoryCounts: {},
    categories: { '3': 'copyright', '4': 'character', '5': 'meta' },
    shards: { ha: 'ha.json', bl: 'bl.json', lo: 'lo.json', sm: 'sm.json' },
    chineseShards: { '1d': '001d.json' },
    popular: {},
    sources: {},
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const file = new URL(String(input), 'http://localhost/').pathname.split('/').pop() ?? '';
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

const applied: Array<{ content: ImageTagContent; regenerate: boolean }> = [];
let closed = 0;

function baseContent(): ImageTagContent {
  return {
    tag: '1girl, hatsune_miku',
    nl: 'A girl standing by the classroom window at sunset.',
    negative: 'lowres',
    characters: [
      { name: 'Alpha', tag: 'hatsune_miku', nl: 'first character stands by the door.' },
      { name: 'Beta', tag: 'blue_archive', nl: 'second character sits on a chair.' },
    ],
    size: 'portrait',
  };
}

async function mountEditor(content: ImageTagContent = baseContent()): Promise<Mounted> {
  const mounted = await mountComponent(PromptEditor, {
    content,
    historyCount: 1,
    configured: true,
    onApply: (value: ImageTagContent, regenerate: boolean) => void applied.push({ content: value, regenerate }),
    onClose: () => {
      closed += 1;
    },
  });
  // 弹窗靠 requestAnimationFrame 打开,再等词典与防抖
  await settle();
  return mounted;
}

function textareas(root: FakeNode) {
  return querySelectorAll(root, 'textarea');
}

function buttonByText(root: FakeNode, label: string) {
  return querySelectorAll(root, 'button').find(node => textOf(node).includes(label)) ?? null;
}

/** 折叠标题里也带「翻译为中文」,要精确匹配按钮文字,否则会点到折叠钮 */
function exactButton(root: FakeNode, label: string) {
  return querySelectorAll(root, 'button').find(node => textOf(node) === label) ?? null;
}

/** 展开一个面板(默认只有「画面 tag」是展开的) */
async function expandAssist(assist: FakeNode): Promise<void> {
  if (firstByClass(assist, '.bbi-assist-body')) return;
  trigger(firstByClass(assist, '.bbi-assist-toggle')!, 'click');
  await settle(80);
}

beforeEach(() => {
  applied.length = 0;
  closed = 0;
  h.requestCompletion.mockReset();
  h.requestViaMainApi.mockReset();
  h.getTagGenChannel.mockReset();
  h.getTagGenChannel.mockReturnValue(null);
  clearDictionaryCache();
  clearTagTranslationCache();
  vi.unstubAllGlobals();
  installBrowserStubs();
  installLocalStorage();
  installDictionary();
});

describe('字段接线', () => {
  it('画面 tag、负面词、每个角色的面板都各自挂在自己的字段上,default-open 就查词', async () => {
    const mounted = await mountEditor();
    const assists = byClass(mounted.root, '.bbi-assist');
    // 画面 tag / 自然语言 / 负面词 + 两个角色各 tag、nl = 7 个面板
    expect(assists).toHaveLength(7);
    // 只有「画面 tag」默认展开并已经查到中文
    expect(firstByClass(assists[0], '.bbi-assist-body')).not.toBeNull();
    expect(firstByClass(assists[2], '.bbi-assist-body')).toBeNull();
    expect(textOf(assists[0])).toContain('初音未来（VOCALOID）');
    // 负面词面板挂的是 negative 字段(lowres)
    await expandAssist(assists[2]);
    expect(textOf(assists[2])).toContain('低分辨率');
    // 角色的两个面板互不串味(Alpha=初音, Beta=碧蓝档案)
    await expandAssist(assists[3]);
    expect(textOf(assists[3])).toContain('初音未来（VOCALOID）');
    expect(textOf(assists[3])).not.toContain('碧蓝档案');
    await expandAssist(assists[5]);
    expect(textOf(assists[5])).toContain('碧蓝档案');
    expect(textOf(assists[5])).not.toContain('初音未来（VOCALOID）');
    // 自然语言面板是翻译入口,不是查词框
    await expandAssist(assists[1]);
    expect(textOf(assists[1])).toContain('翻译为中文');
    expect(firstByClass(assists[1], '.bbi-assist-input')).toBeNull();
    mounted.unmount();
  });
});

describe('插入改草稿、翻译不改', () => {
  it('只有点「插入」才改画面 tag,并把英文标签追加到末尾', async () => {
    const mounted = await mountEditor();
    const tagArea = textareas(mounted.root)[0];
    expect(tagArea.value).toBe('1girl, hatsune_miku');
    const assist = byClass(mounted.root, '.bbi-assist')[0];
    typeInto(firstByClass(assist, '.bbi-assist-input')!, 'smile');
    await settle();
    const rows = byClass(assist, '.bbi-assist-result');
    expect(rows.length).toBeGreaterThan(0);
    trigger(firstByClass(rows[0], '.bbi-assist-insert')!, 'click');
    await settle(20);
    expect(textareas(mounted.root)[0].value).toBe(appendTagToken('1girl, hatsune_miku', 'smile'));
    expect(applied).toHaveLength(0);
    mounted.unmount();
  });

  it('自然语言按整段发送、整段返回,只显示中文,草稿与保存内容都不变', async () => {
    h.requestViaMainApi.mockImplementation(async (messages: ChatMsg[], opts) => {
      const content = '一个女孩在日落时站在教室窗边。';
      opts?.validate?.(content);
      // 断言:整段发送,没有被逗号拆成多个标签
      const sent = messages.map(message => message.content).join('\n');
      expect(sent).toContain('A girl standing by the classroom window at sunset.');
      expect(messages).toHaveLength(2);
      return content;
    });
    const mounted = await mountEditor();
    const nlAssist = byClass(mounted.root, '.bbi-assist')[1];
    await expandAssist(nlAssist);
    trigger(exactButton(nlAssist, '翻译为中文')!, 'click');
    await mounted.flush();
    // 预览里展示的是整段原文本身(没有被逗号拆成标签,也没有截断)
    expect(textOf(nlAssist)).toContain('A girl standing by the classroom window at sunset.');
    trigger(exactButton(nlAssist, '确认翻译')!, 'click');
    await settle(60);
    expect(textOf(mounted.root)).toContain('一个女孩在日落时站在教室窗边。');
    expect(textOf(mounted.root)).toContain('不会替换上面的英文');
    // 输入框里的英文原封不动
    expect(textareas(mounted.root)[1].value).toBe('A girl standing by the classroom window at sunset.');
    // 翻译不算编辑:没有 emit apply
    expect(applied).toHaveLength(0);
    mounted.unmount();
  });

  it('「应用」发出的内容只含英文草稿,不含任何中文辅助状态', async () => {
    const mounted = await mountEditor();
    trigger(buttonByText(mounted.root, '应用并重新生成')!, 'click');
    await settle(20);
    expect(applied).toHaveLength(1);
    const payload = applied[0].content;
    expect(payload).toEqual(baseContent());
    expect(applied[0].regenerate).toBe(true);
    // 中文只活在面板里,不进保存内容
    expect(JSON.stringify(payload)).not.toMatch(/[\u3400-\u9fff]/);
    expect(Object.keys(payload).sort()).toEqual(['characters', 'negative', 'nl', 'size', 'tag']);
    mounted.unmount();
  });
});

describe('取消与失败', () => {
  it('点「取消」只关闭,不提交草稿', async () => {
    const mounted = await mountEditor();
    trigger(buttonByText(mounted.root, '取消')!, 'click');
    await settle(20);
    expect(closed).toBe(1);
    expect(applied).toHaveLength(0);
    mounted.unmount();
  });

  it('AI 返回格式不对时给出错误提示,不清空也不改动草稿', async () => {
    h.requestViaMainApi.mockImplementation(async (_messages: ChatMsg[], opts) => {
      const content = '{"tags":[{"tag":"smile","chinese":"smile"}]}';
      opts?.validate?.(content);
      return content;
    });
    const mounted = await mountEditor();
    const tagAssist = byClass(mounted.root, '.bbi-assist')[0];
    // 画面 tag 里 1girl / hatsune_miku 都有释义,先用查词插入制造一个缺失词
    typeInto(firstByClass(tagAssist, '.bbi-assist-input')!, 'smile');
    await settle();
    trigger(firstByClass(byClass(tagAssist, '.bbi-assist-result')[0], '.bbi-assist-insert')!, 'click');
    await settle(20);
    const missingButton = buttonByText(tagAssist, 'AI 翻译缺失的');
    expect(missingButton).not.toBeNull();
    trigger(missingButton!, 'click');
    await mounted.flush();
    trigger(buttonByText(tagAssist, '确认翻译')!, 'click');
    await settle(60);
    expect(textOf(tagAssist)).toContain('没有返回可用的中文译文');
    expect(textareas(mounted.root)[0].value).toContain('smile');
    expect(applied).toHaveLength(0);
    mounted.unmount();
  });

  it('运行中提供「取消翻译」,取消后迟到的译文不上屏', async () => {
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
    const mounted = await mountEditor({ ...baseContent(), tag: '1girl, nnmbpx' });
    const tagAssist = byClass(mounted.root, '.bbi-assist')[0];
    trigger(buttonByText(tagAssist, 'AI 翻译缺失的')!, 'click');
    await mounted.flush();
    trigger(buttonByText(tagAssist, '确认翻译')!, 'click');
    await mounted.flush();
    expect(textOf(tagAssist)).toContain('取消翻译');
    trigger(buttonByText(tagAssist, '取消翻译')!, 'click');
    await mounted.flush();
    expect(textOf(tagAssist)).toContain('可能仍在服务端执行并计费');
    finish!('{"tags":[{"tag":"nnmbpx","chinese":"迟到的译文"}]}');
    await settle(60);
    expect(textOf(mounted.root)).not.toContain('迟到的译文');
    expect(textareas(mounted.root)[0].value).toBe('1girl, nnmbpx');
    mounted.unmount();
  });
});
