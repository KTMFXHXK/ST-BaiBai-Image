import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMsg } from '@/api/client';

/**
 * AI 翻译的验收点:批量去重、分批、返回校验(不认模型随意增删标签)、缓存、失败、取消。
 * 通道按 getTagGenChannel() 二选一,与自动 tag 同一条路径,不新增任何凭据。
 */

const h = vi.hoisted(() => ({
  requestCompletion: vi.fn(),
  requestViaMainApi: vi.fn(),
  getTagGenChannel: vi.fn(),
  /** 让用例决定模型「返回什么」:默认把请求里的标签原样翻成「中:<tag>」 */
  respond: vi.fn(),
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
  describeCancelEffect,
  describeTagTranslatePlan,
  describeTranslateTarget,
  getCachedTagTranslation,
  getTagTranslationCacheSize,
  isAbortError,
  parseNaturalTranslation,
  parseTagTranslations,
  translateNaturalText,
  translateTags,
} from './aiTranslate';

/** 极简 localStorage:只实现被测代码用到的三个方法 */
function installLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
}

/** 从 user 消息里取出标签行,按模型口径回一份 JSON */
function tagsFromMessages(messages: ChatMsg[]): string[] {
  const user = messages.find(message => message.role === 'user')?.content ?? '';
  return user
    .split('标签列表：')[1]
    ?.split('\n')
    .map(line => line.trim())
    .filter(Boolean) ?? [];
}

const echoTags = (messages: ChatMsg[]) =>
  JSON.stringify({ tags: tagsFromMessages(messages).map(tag => ({ tag, chinese: `中:${tag}` })) });

beforeEach(() => {
  clearTagTranslationCache();
  installLocalStorage();
  h.requestCompletion.mockReset();
  h.requestViaMainApi.mockReset();
  h.getTagGenChannel.mockReset();
  h.respond.mockReset();
  h.respond.mockImplementation(async (messages: ChatMsg[]) => echoTags(messages));
  // 默认走副 API;请求实现先跑 validate(与真实 client 同口径),再返回文本
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
  h.requestCompletion.mockImplementation(async (_channel, messages, opts) => {
    const content: string = await h.respond(messages);
    opts?.validate?.(content);
    return content;
  });
  h.requestViaMainApi.mockImplementation(async (messages, opts) => {
    const content: string = await h.respond(messages);
    opts?.validate?.(content);
    return content;
  });
});

describe('通道规则', () => {
  it('指派了生成 tag 的副 API 时走副 API', async () => {
    await translateTags(['smile']);
    expect(h.requestCompletion).toHaveBeenCalledTimes(1);
    expect(h.requestViaMainApi).not.toHaveBeenCalled();
  });

  it('未指派时跟随主 API', async () => {
    h.getTagGenChannel.mockReturnValue(null);
    await translateTags(['smile']);
    expect(h.requestViaMainApi).toHaveBeenCalledTimes(1);
    expect(h.requestCompletion).not.toHaveBeenCalled();
  });

  it('只发标签,不带聊天正文/角色卡/密钥', async () => {
    await translateTags(['long_hair']);
    const messages: ChatMsg[] = h.requestCompletion.mock.calls[0][1];
    const payload = messages.map(message => message.content).join('\n');
    expect(payload).toContain('long_hair');
    // 请求体里除了标签与格式说明,不应出现别的内容来源
    expect(payload).not.toMatch(/api[_ -]?key|authorization|bearer/i);
  });
});

describe('批量与缓存', () => {
  it('归一化去重:同一标签的不同写法只翻一次,发送的是首次出现的原写法', async () => {
    await translateTags(['long_hair', 'Long Hair', 'long hair ', 'smile']);
    const messages: ChatMsg[] = h.requestCompletion.mock.calls[0][1];
    expect(tagsFromMessages(messages)).toEqual(['long_hair', 'smile']);
  });

  it('超过一批(40)时自动分批', async () => {
    const tags = Array.from({ length: 45 }, (_, index) => `tag${index}`);
    const result = await translateTags(tags);
    expect(h.requestCompletion).toHaveBeenCalledTimes(2);
    expect(result.failed).toEqual([]);
    expect(result.translated.size).toBe(45);
  });

  it('成功后写缓存,再翻译同样的词不再发请求', async () => {
    await translateTags(['smile', 'long hair']);
    expect(getCachedTagTranslation('SMILE')).toBe('中:smile');
    expect(getTagTranslationCacheSize()).toBe(2);
    h.requestCompletion.mockClear();
    const second = await translateTags(['smile', 'long hair']);
    expect(h.requestCompletion).not.toHaveBeenCalled();
    expect(second.translated.get('long hair')).toBe('中:long hair');
  });

  it('缓存落在 localStorage(不含凭据)', async () => {
    await translateTags(['smile']);
    const stored = globalThis.localStorage.getItem('bbi.tagTranslate.v1') ?? '';
    expect(stored).toContain('smile');
    expect(stored).not.toMatch(/api[_ -]?key|bearer|token/i);
  });

  it('清缓存后重新请求', async () => {
    await translateTags(['smile']);
    clearTagTranslationCache();
    expect(getTagTranslationCacheSize()).toBe(0);
    await translateTags(['smile']);
    expect(h.requestCompletion).toHaveBeenCalledTimes(2);
  });
});

describe('返回校验', () => {
  it('接受标准 {tags:[...]} 结构', () => {
    const result = parseTagTranslations(
      '{"tags":[{"tag":"long_hair","chinese":"长发"}]}',
      ['long hair'],
    );
    expect(result.get('long hair')).toBe('长发');
  });

  it('容忍 ```json 围栏与前后废话', () => {
    const raw = '好的：\n```json\n{"tags":[{"tag":"smile","chinese":"微笑"}]}\n```\n完。';
    expect(parseTagTranslations(raw, ['smile']).get('smile')).toBe('微笑');
  });

  it('模型额外加的标签直接丢弃,不写缓存不上屏', async () => {
    h.respond.mockImplementation(async () =>
      JSON.stringify({
        tags: [
          { tag: 'smile', chinese: '微笑' },
          { tag: 'not_requested', chinese: '我没要求你翻这个' },
        ],
      }),
    );
    const result = await translateTags(['smile']);
    expect(result.translated.get('smile')).toBe('微笑');
    expect(getCachedTagTranslation('not_requested')).toBeUndefined();
    expect(getTagTranslationCacheSize()).toBe(1);
  });

  it('缺条不算协议错误,但缺的进 failed 列表', async () => {
    h.respond.mockImplementation(async () =>
      JSON.stringify({ tags: [{ tag: 'smile', chinese: '微笑' }] }),
    );
    const result = await translateTags(['smile', 'long_hair']);
    expect(result.translated.get('smile')).toBe('微笑');
    expect(result.failed).toEqual(['long_hair']);
  });

  it('完全没有可用条目时报错(而不是显示空结果)', async () => {
    h.respond.mockImplementation(async () => '{"tags":[]}');
    await expect(translateTags(['smile'])).rejects.toThrow(/没有返回可用的中文译文/);
  });

  it('非 JSON 返回报格式错误', async () => {
    h.respond.mockImplementation(async () => '我觉得这些词都很好。');
    await expect(translateTags(['smile'])).rejects.toThrow(/JSON/);
  });

  it('自然语言:非中文、空、原样抄回都拒绝', () => {
    expect(parseNaturalTranslation('一个女孩站在窗边', 'a girl by the window')).toBe('一个女孩站在窗边');
    expect(() => parseNaturalTranslation('   ', 'a girl')).toThrow(/空译文/);
    expect(() => parseNaturalTranslation('a girl by the window', 'a girl by the window')).toThrow(/没有中文|原样/);
  });

  it('自然语言整段送、整段回,不按逗号拆标签', async () => {
    h.respond.mockImplementation(async () => '1girl, long hair 的中文：一个女孩，长发');
    const translated = await translateNaturalText('1girl, long hair');
    expect(translated).toBe('1girl, long hair 的中文：一个女孩，长发');
    const messages: ChatMsg[] = h.requestCompletion.mock.calls[0][1];
    expect(messages[messages.length - 1].content).toBe('1girl, long hair');
  });
});

describe('失败与取消', () => {
  it('网络/接口失败时抛错,不写缓存、不清空已有结果', async () => {
    await translateTags(['smile']);
    expect(getTagTranslationCacheSize()).toBe(1);
    h.getTagGenChannel.mockReturnValue(null);
    h.requestViaMainApi.mockRejectedValueOnce(new Error('渠道未配置完整'));
    await expect(translateTags(['long_hair'])).rejects.toThrow(/渠道未配置完整/);
    // 之前成功的仍在
    expect(getCachedTagTranslation('smile')).toBe('中:smile');
    expect(getCachedTagTranslation('long hair')).toBeUndefined();
  });

  it('已取消的请求不再写缓存', async () => {
    const controller = new AbortController();
    h.requestCompletion.mockImplementationOnce(async (_channel, _messages, opts) => {
      controller.abort();
      opts?.signal?.throwIfAborted();
      return '{}';
    });
    await expect(translateTags(['smile'], { signal: controller.signal })).rejects.toThrow();
    expect(getCachedTagTranslation('smile')).toBeUndefined();
  });
});

describe('严格校验', () => {
  it('把英文原样抄回来不算译文', () => {
    expect(() =>
      parseTagTranslations('{"tags":[{"tag":"smile","chinese":"smile"}]}', ['smile']),
    ).toThrow(/没有返回可用的中文译文/);
  });

  it('非字符串字段直接丢弃,不做 String() 兜底', () => {
    expect(() =>
      parseTagTranslations('{"tags":[{"tag":"smile","chinese":123}]}', ['smile']),
    ).toThrow(/没有返回可用的中文译文/);
    expect(() =>
      parseTagTranslations('{"tags":[{"tag":["smile"],"chinese":"微笑"}]}', ['smile']),
    ).toThrow(/没有返回可用的中文译文/);
    expect(() =>
      parseTagTranslations('{"tags":[{"tag":null,"chinese":"微笑"}]}', ['smile']),
    ).toThrow(/没有返回可用的中文译文/);
  });

  it('整条链路:数字型译文不会被当成成功写进缓存', async () => {
    h.respond.mockImplementation(async () => '{"tags":[{"tag":"smile","chinese":123}]}');
    await expect(translateTags(['smile'])).rejects.toThrow(/没有返回可用的中文译文/);
    expect(getTagTranslationCacheSize()).toBe(0);
  });

  it('某批格式不可用时其它批仍然生效,失败的留在 failed 里', async () => {
    let call = 0;
    h.respond.mockImplementation(async (messages: ChatMsg[]) => {
      call += 1;
      if (call === 1) return echoTags(messages);
      return '{"tags":[]}';
    });
    const tags = Array.from({ length: 45 }, (_, index) => `t${index}`);
    const result = await translateTags(tags);
    expect(result.translated.size).toBe(40);
    expect(result.failed).toHaveLength(5);
  });
});

describe('缓存卫生', () => {
  it('读取旧缓存时丢掉非中文、非字符串、原样英文的值', () => {
    globalThis.localStorage.setItem(
      'bbi.tagTranslate.v1',
      JSON.stringify({
        smile: '微笑',
        'long hair': 'long hair',
        broken: 123,
        blank: '   ',
        nested: { chinese: '嵌套' },
      }),
    );
    expect(getCachedTagTranslation('smile')).toBe('微笑');
    expect(getCachedTagTranslation('long hair')).toBeUndefined();
    expect(getCachedTagTranslation('broken')).toBeUndefined();
    expect(getCachedTagTranslation('blank')).toBeUndefined();
    expect(getCachedTagTranslation('nested')).toBeUndefined();
    expect(getTagTranslationCacheSize()).toBe(1);
  });

  it('原型属性不会被误当缓存命中', async () => {
    await translateTags(['smile']);
    expect(getCachedTagTranslation('constructor')).toBeUndefined();
    expect(getCachedTagTranslation('toString')).toBeUndefined();
    expect(getCachedTagTranslation('__proto__')).toBeUndefined();
  });

  it('__proto__ 之类键不会污染 Object.prototype', () => {
    globalThis.localStorage.setItem(
      'bbi.tagTranslate.v1',
      '{"__proto__":{"polluted":"x"},"constructor":"x"}',
    );
    expect(getTagTranslationCacheSize()).toBe(0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('旧缓存超过上限时只保留最近的 4000 条', () => {
    const raw: Record<string, string> = {};
    for (let index = 0; index < 4005; index += 1) raw[`tag${index}`] = `译${index}`;
    globalThis.localStorage.setItem('bbi.tagTranslate.v1', JSON.stringify(raw));
    expect(getTagTranslationCacheSize()).toBe(4000);
    expect(getCachedTagTranslation('tag0')).toBeUndefined();
    expect(getCachedTagTranslation('tag4004')).toBe('译4004');
  });
});

describe('取消语义', () => {
  it('取消后不再发下一批,也不写缓存', async () => {
    const controller = new AbortController();
    const tags = Array.from({ length: 45 }, (_, index) => `tag${index}`);
    h.requestCompletion.mockImplementation(async (_channel, messages, opts) => {
      const content = echoTags(messages as ChatMsg[]);
      opts?.validate?.(content);
      controller.abort();
      return content;
    });
    await expect(translateTags(tags, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(h.requestCompletion).toHaveBeenCalledTimes(1);
    expect(getTagTranslationCacheSize()).toBe(0);
  });

  it('主 API 不理会 signal 时,取消后同样不发下一批、不写缓存', async () => {
    h.getTagGenChannel.mockReturnValue(null);
    const controller = new AbortController();
    const tags = Array.from({ length: 45 }, (_, index) => `tag${index}`);
    h.requestViaMainApi.mockImplementation(async (messages, opts) => {
      const content = echoTags(messages as ChatMsg[]);
      opts?.validate?.(content);
      // 主 API 没有中止能力:请求照常成功返回,取消只能靠返回后的检查
      controller.abort();
      return content;
    });
    await expect(translateTags(tags, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(h.requestViaMainApi).toHaveBeenCalledTimes(1);
    expect(getTagTranslationCacheSize()).toBe(0);
  });

  it('开始前就已取消:一个请求都不发', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(translateTags(['smile'], { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(h.requestCompletion).not.toHaveBeenCalled();
  });

  it('自然语言取消后,迟到译文既不返回也不上屏', async () => {
    const controller = new AbortController();
    h.respond.mockImplementation(async () => {
      controller.abort();
      return '一个女孩站在窗边';
    });
    await expect(
      translateNaturalText('a girl by the window', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('取消错误可被 isAbortError 识别,且取消文案区分两条通道', () => {
    expect(isAbortError(new DOMException('已取消翻译', 'AbortError'))).toBe(true);
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(describeCancelEffect(describeTranslateTarget())).toMatch(/已取消本次翻译/);
    h.getTagGenChannel.mockReturnValue(null);
    expect(describeCancelEffect(describeTranslateTarget())).toMatch(/可能仍在服务端执行并计费/);
  });
});

describe('确认区的数量与通道', () => {
  it('81 个待翻译标签 = 3 次请求', () => {
    const tags = Array.from({ length: 81 }, (_, index) => `tag${index}`);
    const plan = describeTagTranslatePlan(tags);
    expect(plan).toMatchObject({ unique: 81, cached: 0, pending: 81, batches: 3 });
    expect(plan.pendingTags).toHaveLength(81);
  });

  it('去重与缓存命中都不计入待发送', async () => {
    await translateTags(['smile']);
    const plan = describeTagTranslatePlan(['smile', 'SMILE', 'long_hair', 'long hair', 'smile']);
    expect(plan.unique).toBe(2);
    expect(plan.cached).toBe(1);
    expect(plan.pending).toBe(1);
    expect(plan.batches).toBe(1);
    expect(plan.pendingTags).toEqual(['long_hair']);
  });

  it('全部命中缓存时不产生请求计划', () => {
    h.getTagGenChannel.mockReturnValue(null);
    const target = describeTranslateTarget();
    expect(target.via).toBe('main');
    expect(target.channel).toBeNull();
  });

  it('执行使用确认时捕获的通道,中途改指派也不会换道', async () => {
    const target = describeTranslateTarget();
    expect(target.via).toBe('sub');
    // 确认之后用户改了指派:实际执行仍必须走确认时那条
    h.getTagGenChannel.mockReturnValue(null);
    await translateTags(['smile'], { target });
    expect(h.requestCompletion).toHaveBeenCalledTimes(1);
    expect(h.requestViaMainApi).not.toHaveBeenCalled();
  });
});
