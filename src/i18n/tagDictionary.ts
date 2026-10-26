import { PLUGIN_VERSION } from '@/version';

/**
 * danbooru / NovelAI 标签的中英词典(只用于「看」和「查」,绝不改动提示词本身)。
 *
 * 【数据从哪来、怎么部署】
 * 数据是随插件一起部署的静态文件 `tag-data/`,与 `dist/index.js` 同级上一级目录:
 *   tag-data/manifest.json   清单(条目总数、分片文件名索引、单字母热门索引)
 *   tag-data/shards/*.json   英文分片(按查询前两个字符路由)
 *   tag-data/zh-shards/*.json 中文分片(按查询首字 codePoint % 256 路由)
 * 来源、条目数、体积、许可见插件根目录的 `TAG-DICT.md`。
 * 之所以按分片而不是整库:整库约 33 MB,首屏塞进来会拖慢编辑器,这里只在真正查某个
 * 前缀时下载那一小片(通常 5~20 KB),并按文件长期缓存。
 *
 * 【归一化只用于查询】
 * `normalizeTagQuery` 只作用于**副本**:把下划线换成空格、折叠空白、转小写。
 * 提示词原文、权重、大小写、下划线、重复词一律不碰 —— 见 `promptTokens.ts` 的注释。
 *
 * 【查词只做前缀】
 * 英文按名字前缀、中文按释义前缀,不承诺包含匹配(原因见 `searchTags`)。
 */

export type TagDictionaryEntry = [
  name: string,
  chinese: string,
  category: number,
  postCount: number,
  source: number,
];

interface TagDictionaryManifest {
  version: number;
  generatedAt: string;
  count: number;
  categoryCounts: Record<string, number>;
  categories: Record<string, string>;
  shards: Record<string, string>;
  chineseShards: Record<string, string>;
  popular: Record<string, TagDictionaryEntry[]>;
  sourceDownloadUrl?: string;
  sources?: Record<string, string>;
}

/** 词条分类:数字是数据文件里的原值,标签是给人看的中文。 */
const CATEGORY_LABELS: Record<number, string> = {
  0: '普通',
  1: '画师',
  3: '作品',
  4: '角色',
  5: '元数据',
  6: 'NAI V4.5',
};

export interface TagSuggestion {
  /** 英文原名(数据里的写法,可能带下划线) */
  name: string;
  /** 中文释义;数据里可能为空字符串 */
  chinese: string;
  category: number;
  categoryLabel: string;
  postCount: number;
  /** NovelAI 专有标签(如 `artist:` 规则相关词) */
  isNovelAI: boolean;
}

export interface TagDictionaryMeta {
  count: number;
  generatedAt: string;
  sourceUrl: string;
}

/** 词典数据根目录。`import.meta.url` 是 dist/index.js(带 ?ver= 查询串),故上一级即插件根。 */
const DATA_ROOT = new URL('../tag-data/', import.meta.url);

/** 查询用的归一化:**只用于比较**,返回值是新字符串,调用方不得拿它覆盖提示词。 */
export const normalizeTagQuery = (value: string) =>
  value.replaceAll('_', ' ').replace(/\s+/g, ' ').trim().toLowerCase();

let manifestPromise: Promise<TagDictionaryManifest> | null = null;
const shardPromises = new Map<string, Promise<TagDictionaryEntry[]>>();
/** 代际计数:清缓存后,在途的旧请求落地时作废,不把旧数据写进新缓存。 */
let generation = 0;

export class DictionaryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DictionaryUnavailableError';
  }
}

function dataUrl(path: string, version: string): string {
  const url = new URL(path, DATA_ROOT);
  url.searchParams.set('v', version);
  return url.href;
}

async function fetchJson<T>(url: string, what: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'same-origin' });
  } catch (error) {
    throw new DictionaryUnavailableError(
      `词典数据无法读取(${what})：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new DictionaryUnavailableError(`词典数据无法读取(${what})：HTTP ${response.status}`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new DictionaryUnavailableError(`词典数据格式异常(${what})`);
  }
}

function loadManifest(retried = false): Promise<TagDictionaryManifest> {
  const current = generation;
  if (!manifestPromise) {
    manifestPromise = fetchJson<TagDictionaryManifest>(
      dataUrl('manifest.json', PLUGIN_VERSION),
      'manifest.json',
    ).catch(error => {
      // 失败不缓存,下次输入还能重试
      manifestPromise = null;
      throw error;
    });
  }
  const pending = manifestPromise;
  return pending.then(async manifest => {
    if (current === generation || retried) return manifest;
    manifestPromise = null;
    return loadManifest(true);
  });
}

async function loadShard(
  manifest: TagDictionaryManifest,
  key: string,
  language: 'english' | 'chinese',
  retried = false,
): Promise<TagDictionaryEntry[]> {
  const current = generation;
  const file = language === 'chinese' ? manifest.chineseShards[key] : manifest.shards[key];
  if (!file) return [];
  const cacheKey = `${language}:${key}`;
  let pending = shardPromises.get(cacheKey);
  if (!pending) {
    const directory = language === 'chinese' ? 'zh-shards' : 'shards';
    pending = fetchJson<TagDictionaryEntry[]>(
      dataUrl(`${directory}/${file}`, manifest.generatedAt || PLUGIN_VERSION),
      `${directory}/${file}`,
    ).catch(error => {
      shardPromises.delete(cacheKey);
      throw error;
    });
    shardPromises.set(cacheKey, pending);
  }
  const entries = await pending;
  if (current === generation || retried) return entries;
  shardPromises.delete(cacheKey);
  return loadShard(await loadManifest(), key, language, true);
}

const isChineseQuery = (query: string) => /[\u3400-\u9fff]/.test(Array.from(query)[0] ?? '');

async function loadQueryEntries(
  manifest: TagDictionaryManifest,
  query: string,
): Promise<{ entries: TagDictionaryEntry[]; chinese: boolean }> {
  const chinese = isChineseQuery(query);
  if (chinese) {
    const first = Array.from(query)[0] ?? '';
    const key = (first.codePointAt(0) ?? 0).toString(16).padStart(2, '0').slice(-2);
    return { entries: await loadShard(manifest, key, 'chinese'), chinese };
  }
  if (query.length === 1) return { entries: manifest.popular[query] ?? [], chinese };
  return { entries: await loadShard(manifest, query.slice(0, 2).padEnd(2, ' '), 'english'), chinese };
}

function toSuggestion(entry: TagDictionaryEntry): TagSuggestion {
  return {
    name: entry[0],
    chinese: entry[1],
    category: entry[2],
    categoryLabel: CATEGORY_LABELS[entry[2]] ?? 'Tag',
    postCount: entry[3],
    isNovelAI: entry[4] === 1,
  };
}

/**
 * 前缀查词(中文按中文释义查,英文按英文名查)。
 *
 * 【只承诺前缀匹配,不做包含匹配】
 * 中文分片按「释义首字」路由,查 `未来` 只会读 U+672A 对应的那一片,不可能扫到
 * `初音未来`(首字是 `初`)。要做包含匹配就得把 256 片(约 15.8 MB)全下载一遍,
 * 与「按需分片、不塞首屏」的设计冲突,所以这里**明确只做前缀**:
 * 查 `初音` 能查到 `初音未来`,查 `未来` 则查不到 —— 界面文案与 TAG-DICT.md 都按此说明。
 *
 * 结果是**建议**,不是释义:想拿某条当「释义」必须再确认英文名归一后完全相等
 * (见 `lookupExactTranslations`)——否则查 `hatsu` 时 `hatsune_miku`
 * 会被当成 `hatsu` 的翻译显示出来,那是错的。
 */
export async function searchTags(rawQuery: string, limit = 10): Promise<TagSuggestion[]> {
  const query = normalizeTagQuery(rawQuery);
  if (!query) return [];
  const manifest = await loadManifest();
  const { entries, chinese } = await loadQueryEntries(manifest, query);
  const pick = (entry: TagDictionaryEntry) => (chinese ? entry[1] : entry[0]);
  const ranked = entries.filter(entry => normalizeTagQuery(pick(entry)).startsWith(query));
  return ranked
    .sort((a, b) => {
      const aName = normalizeTagQuery(pick(a));
      const bName = normalizeTagQuery(pick(b));
      const exact = Number(bName === query) - Number(aName === query);
      return exact || b[4] - a[4] || b[3] - a[3] || a[0].localeCompare(b[0]);
    })
    .slice(0, limit)
    .map(toSuggestion);
}

/**
 * 严格释义:只接受英文名归一后**完全相等**且中文非空的词条。
 * 返回 Map 的键是归一化后的查询词,值是词条本身(带原始英文名)。
 */
export async function lookupExactTranslations(
  rawTags: string[],
  concurrencyHint = 6,
): Promise<Map<string, TagSuggestion>> {
  const unique = [...new Set(rawTags.map(normalizeTagQuery).filter(Boolean))];
  const found = new Map<string, TagSuggestion>();
  // 串行度受控:每个词一次前缀查词,命中缓存的很快;给个小的并发窗口避免长列表排队。
  const queue = [...unique];
  const workers = Array.from({ length: Math.min(concurrencyHint, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const suggestions = await searchTags(next, 8);
      const exact = suggestions.find(
        item => normalizeTagQuery(item.name) === next && item.chinese.trim(),
      );
      if (exact) found.set(next, exact);
    }
  });
  await Promise.all(workers);
  return found;
}

/** 词典清单(条目数 / 生成时间 / 数据来源),供界面「数据来源」一行使用。 */
export async function getDictionaryMeta(): Promise<TagDictionaryMeta> {
  const manifest = await loadManifest();
  return {
    count: manifest.count,
    generatedAt: manifest.generatedAt,
    sourceUrl:
      manifest.sources?.translations ??
      manifest.sources?.translationDatabase ??
      manifest.sourceDownloadUrl ??
      '',
  };
}

/** 分词结果里的所有标签一次性查释义(便携入口:组件只关心「这几个词的中文」)。 */
export async function lookupTags(rawTags: string[]): Promise<Map<string, TagSuggestion>> {
  return lookupExactTranslations(rawTags);
}

/** 清缓存(测试与「重新加载词典」用):在途旧请求的结果会被代际计数丢弃。 */
export function clearDictionaryCache(): void {
  generation += 1;
  manifestPromise = null;
  shardPromises.clear();
}
