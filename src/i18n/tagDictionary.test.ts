import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearDictionaryCache,
  DictionaryUnavailableError,
  getDictionaryMeta,
  lookupExactTranslations,
  normalizeTagQuery,
  searchTags,
} from './tagDictionary';

/**
 * 词典是静态分片数据,这里用一份假 manifest + 假分片验证三件事:
 * 1) 分片路由(英文前两字符 / 中文首字 codePoint % 256)正确,且按需加载后会缓存;
 * 2) 前缀命中不等于释义 —— 只有英文名归一后完全相等才算;
 * 3) 数据缺失/损坏时给出明确错误,而不是静默返回空。
 */

const manifest = {
  version: 7,
  generatedAt: 'test-gen-1',
  count: 5,
  categoryCounts: { general: 4, artist: 1 },
  categories: { '0': 'general', '1': 'artist' },
  shards: { ha: 'ha.json', bl: 'bl.json', da: 'da.json' },
  // 真实路由:取查询首字的 codePoint % 256,补成两位 hex。
  // '初' = U+521D = 21021 → 21021 % 256 = 29 = 0x1d;'未' = U+672A = 26410 → 42 = 0x2a。
  // 两个首字必须落在不同分片,否则测不出「跨首字是否被搜到」。
  chineseShards: { '1d': '001d.json', '2a': '002a.json' },
  popular: { a: [['a', '啊', 0, 10, 0]] },
  sources: { translations: 'https://example.com/tag-table' },
};

const entries = [
  ['hatsune_miku', '初音未来（VOCALOID）', 4, 148075, 0],
  ['hatsu', '初（词的写法）', 0, 5, 0],
  ['blue_archive', '碧蓝档案', 3, 98000, 0],
  ['dairi', 'dairi', 1, 18859, 0],
  ['mirai', '未来（另一个词条）', 0, 42, 0],
];

const shardFiles: Record<string, unknown> = {
  'ha.json': [entries[0], entries[1]],
  'bl.json': [entries[2]],
  'da.json': [entries[3]],
  '001d.json': [entries[0], entries[1]],
  '002a.json': [entries[4]],
};

const calls: string[] = [];

function installFetch(options: { failManifest?: boolean; failShard?: boolean } = {}) {
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const path = new URL(url, 'http://localhost/').pathname;
    if (path.endsWith('/manifest.json')) {
      if (options.failManifest) return new Response('nope', { status: 404 });
      return new Response(JSON.stringify(manifest), { status: 200 });
    }
    const file = path.split('/').pop() ?? '';
    if (options.failShard) return new Response('nope', { status: 500 });
    if (file in shardFiles) return new Response(JSON.stringify(shardFiles[file]), { status: 200 });
    return new Response('[]', { status: 200 });
  });
  vi.stubGlobal('fetch', stub);
  return stub;
}

beforeEach(() => {
  calls.length = 0;
  clearDictionaryCache();
  vi.unstubAllGlobals();
});

describe('normalizeTagQuery', () => {
  it('下划线转空格、折叠空白、小写(只用于查词)', () => {
    expect(normalizeTagQuery('  Hatsune___Miku  ')).toBe('hatsune miku');
    expect(normalizeTagQuery('初音未来')).toBe('初音未来');
  });
});

describe('searchTags', () => {
  it('英文查询走前两字符分片,大小写/下划线不影响命中', async () => {
    installFetch();
    const results = await searchTags('HATSUNE_miku');
    expect(results.map(item => item.name)).toContain('hatsune_miku');
    expect(results[0].name).toBe('hatsune_miku');
    expect(calls.some(url => url.includes('shards/ha.json'))).toBe(true);
  });

  it('中文查询按首字 codePoint % 256 路由到中文分片', async () => {
    installFetch();
    const results = await searchTags('初音');
    expect(results.map(item => item.name)).toContain('hatsune_miku');
    expect(calls.some(url => url.includes('zh-shards/001d.json'))).toBe(true);
  });

  it('中文只保证前缀:同一首字分片内命中「初音」→「初音未来」', async () => {
    installFetch();
    const results = await searchTags('初音');
    expect(results.map(item => item.name)).toContain('hatsune_miku');
    expect(calls.some(url => url.includes('zh-shards/001d.json'))).toBe(true);
  });

  it('中文不做包含匹配:换一个首字(未来 → 0x2a)只读 002a 分片,不会翻到 hatsune_miku', async () => {
    installFetch();
    const results = await searchTags('未来');
    // 这是真实路由的必然结果:分片按首字切,包含匹配在当前数据布局下不可靠,
    // 所以产品上只承诺前缀,测试也不许用「两个首字指向同一分片」的假夹具伪造通过。
    expect(results.map(item => item.name)).not.toContain('hatsune_miku');
    expect(results.map(item => item.name)).toContain('mirai');
    expect(calls.some(url => url.includes('zh-shards/002a.json'))).toBe(true);
    expect(calls.some(url => url.includes('zh-shards/001d.json'))).toBe(false);
  });

  it('单字符英文查 manifest 自带的热门索引,不额外下载分片', async () => {
    installFetch();
    const results = await searchTags('a');
    expect(results.map(item => item.name)).toEqual(['a']);
    expect(calls.filter(url => url.includes('/shards/'))).toEqual([]);
  });

  it('空查询不发请求', async () => {
    const stub = installFetch();
    expect(await searchTags('   ')).toEqual([]);
    expect(stub).not.toHaveBeenCalled();
  });

  it('同一次会话内同一分片只下载一次', async () => {
    installFetch();
    await searchTags('hatsune');
    await searchTags('hatsu');
    expect(calls.filter(url => url.includes('ha.json'))).toHaveLength(1);
  });

  it('清缓存后重新下载(代际计数使旧结果作废)', async () => {
    installFetch();
    await searchTags('hatsune');
    clearDictionaryCache();
    await searchTags('hatsune');
    expect(calls.filter(url => url.includes('ha.json'))).toHaveLength(2);
  });
});

describe('lookupExactTranslations', () => {
  it('只认英文名归一后完全相等的词条', async () => {
    installFetch();
    const found = await lookupExactTranslations(['hatsune_miku', 'HATSU']);
    expect(found.get('hatsune miku')?.chinese).toBe('初音未来（VOCALOID）');
    expect(found.get('hatsu')?.chinese).toBe('初（词的写法）');
  });

  it('前缀命中不算释义:查 hatsu 不会把 hatsune_miku 当成它的翻译', async () => {
    installFetch();
    const suggestions = await searchTags('hatsu');
    // 前缀搜索确实会带出更长的那条,这正是「搜索建议」与「释义」必须分开的原因
    expect(suggestions.map(item => item.name)).toContain('hatsune_miku');
    const exact = await lookupExactTranslations(['hatsu']);
    expect(exact.get('hatsu')?.name).toBe('hatsu');
  });

  it('查不到的词不进结果(而不是塞一条前缀匹配)', async () => {
    installFetch();
    const found = await lookupExactTranslations(['hat']);
    expect(found.size).toBe(0);
  });

  it('重复词只查一次', async () => {
    installFetch();
    const found = await lookupExactTranslations(['dairi', 'DAIRI', 'dairi_']);
    expect(found.size).toBe(1);
    expect(found.get('dairi')?.categoryLabel).toBe('画师');
  });
});

describe('错误与元信息', () => {
  it('manifest 缺失时报明确错误', async () => {
    installFetch({ failManifest: true });
    await expect(searchTags('hatsune')).rejects.toBeInstanceOf(DictionaryUnavailableError);
    await expect(searchTags('hatsune')).rejects.toThrow(/HTTP 404/);
  });

  it('分片缺失时报明确错误', async () => {
    installFetch({ failShard: true });
    await expect(searchTags('hatsune')).rejects.toThrow(/HTTP 500/);
  });

  it('元信息带条目数与数据来源', async () => {
    installFetch();
    const meta = await getDictionaryMeta();
    expect(meta.count).toBe(5);
    expect(meta.sourceUrl).toBe('https://example.com/tag-table');
  });
});
