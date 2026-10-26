import { requestCompletion, requestViaMainApi, type ChatMsg } from '@/api/client';
import { getTagGenChannel, type ApiChannel } from '@/state/settings';

import { normalizeTagQuery } from './tagDictionary';

/**
 * 按需 AI 翻译:**只在用户点了按钮并确认之后**发请求,自动查词永远不会走到这里。
 *
 * 通道规则与自动 tag 完全一致(`getTagGenChannel()` 有值走副 API,没有则跟随主 API),
 * 所以不新增任何凭据、不新增模型配置。翻译结果只用于界面展示:
 * 不进提示词、不进保存内容、不进 NovelAI 请求(由调用方保证,本模块也不提供写回接口)。
 *
 * 【取消语义】
 * 副 API 走 `fetch`,signal 能真正中止连接;主 API 走 `ctx.generateRaw`,酒馆没有暴露
 * 单次请求的中止手段,所以**主 API 上取消只能停掉后续批次**,已发出的那一次仍可能在
 * 服务端跑完并计费 —— 界面必须如实说明(`describeCancelEffect`)。
 * 无论哪条通道,取消后都不会再发下一批、不会把迟到响应写进缓存、也不会让它上屏:
 * 每批请求前、请求返回后、写缓存前都检查 signal。
 */

const CACHE_KEY = 'bbi.tagTranslate.v1';
const CACHE_LIMIT = 4000;
/** 一次请求最多送多少条标签,避免长列表把模型输出撑爆 */
const TAG_BATCH = 40;
/** 中文译文判定:至少含一个中日韩统一表意文字 */
const CJK = /[\u3400-\u9fff]/;

type TagCache = Map<string, string>;

/** 只接受「非空字符串 + 含中文 + 不是把英文抄回来」的旧缓存值,非法项直接丢弃。 */
function isValidCachedTranslation(value: unknown): value is string {
  return typeof value === 'string' && CJK.test(value) && value.trim().length > 0;
}

function readCache(): TagCache {
  const cache: TagCache = new Map();
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_KEY);
    if (!raw) return cache;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return cache;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const normalized = normalizeTagQuery(key);
      if (!normalized || !isValidCachedTranslation(value)) continue;
      // Map 存键:__proto__ / constructor / toString 这类标签名不会被原型属性误命中
      cache.set(normalized, value.trim());
    }
    // 旧值可能比上限还多(限制被调小过):内存与持久化都只保留最近的 CACHE_LIMIT 条
    if (cache.size > CACHE_LIMIT) {
      const excess = cache.size - CACHE_LIMIT;
      let dropped = 0;
      for (const key of cache.keys()) {
        if (dropped >= excess) break;
        cache.delete(key);
        dropped += 1;
      }
    }
  } catch {
    // 存储不可用(隐私模式)或旧值损坏:当作空缓存,不影响本次翻译
  }
  return cache;
}

let cache: TagCache | null = null;

function cacheStore(): TagCache {
  if (!cache) cache = readCache();
  return cache;
}

/** 写入并维持上限(超出时丢最久没写的),保证内存与持久化都不会无限膨胀。 */
function writeCache(key: string, chinese: string): void {
  const store = cacheStore();
  store.delete(key);
  store.set(key, chinese);
  while (store.size > CACHE_LIMIT) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

function persist(): void {
  try {
    const plain: Record<string, string> = Object.create(null);
    for (const [key, value] of cacheStore()) plain[key] = value;
    globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(plain));
  } catch {
    // 存不下(隐私模式/配额满)不影响本次翻译结果,内存缓存仍然有效
  }
}

/** 读已缓存的标签翻译(同步,供首屏直接显示上次翻过的词)。 */
export function getCachedTagTranslation(rawTag: string): string | undefined {
  return cacheStore().get(normalizeTagQuery(rawTag));
}

export function getTagTranslationCacheSize(): number {
  return cacheStore().size;
}

export function clearTagTranslationCache(): void {
  try {
    globalThis.localStorage?.removeItem(CACHE_KEY);
  } catch {
    /* 忽略:清不掉也不影响内存态 */
  }
  // 置空而不是留一个空 Map:下次访问重新按「过滤 + 上限」从存储载入,
  // 避免清空后仍然拿着旧的内存快照
  cache = null;
}

/* ============ 通道 ============ */

export interface TranslateTarget {
  via: 'sub' | 'main';
  /** 给用户看的通道说明(一句话) */
  label: string;
  model: string;
  /** 副 API 渠道对象;null 表示跟随主 API */
  channel: ApiChannel | null;
}

export interface TranslateChannelInfo {
  via: 'sub' | 'main';
  label: string;
  model: string;
}

/**
 * 界面在点「确认翻译」前就要显示:这份文本会走哪条通道、哪个模型。
 * 确认时必须把这个结果原样传回 `translateTags` / `translateNaturalText`,
 * 这样「预览显示的通道」与「实际执行的通道」是同一个对象,执行中不会悄悄换道。
 */
export function describeTranslateTarget(): TranslateTarget {
  const channel = getTagGenChannel();
  if (channel) {
    return {
      via: 'sub',
      label: `生成 tag 的副 API 渠道「${channel.name || '未命名渠道'}」`,
      model: channel.model || '',
      channel,
    };
  }
  return {
    via: 'main',
    label: '跟随主 API（未指派生成 tag 的副 API 渠道）',
    model: '',
    channel: null,
  };
}

export function describeTranslateChannel(): TranslateChannelInfo {
  const target = describeTranslateTarget();
  return { via: target.via, label: target.label, model: target.model };
}

/** 取消之后到底停住了什么:副 API 能真正断开,主 API 只能停后续批次。 */
export function describeCancelEffect(target: TranslateTarget): string {
  return target.via === 'sub'
    ? '已取消本次翻译：当前请求已中止，不会再继续发送。'
    : '已停止后续翻译，当前请求可能仍在服务端执行并计费。';
}

/* ============ 待发送计划(界面用) ============ */

export interface TagTranslatePlan {
  /** 归一化去重后的标签总数 */
  unique: number;
  /** 命中本地缓存、不需要发送的条数 */
  cached: number;
  /** 真正要发送的条数 */
  pending: number;
  /** 预计分几次请求(每次最多 TAG_BATCH 条) */
  batches: number;
  /** 要发送的标签原文(首次出现的写法),用于确认区展示 */
  pendingTags: string[];
}

/** 确认区显示「发什么、几条、分几次」:与 translateTags 的取数口径完全一致。 */
export function describeTagTranslatePlan(rawTags: string[]): TagTranslatePlan {
  const unique = new Map<string, string>();
  for (const raw of rawTags) {
    const key = normalizeTagQuery(raw);
    if (key && !unique.has(key)) unique.set(key, raw);
  }
  let cached = 0;
  const pendingTags: string[] = [];
  for (const [key, raw] of unique) {
    if (getCachedTagTranslation(key)) cached += 1;
    else pendingTags.push(raw);
  }
  return {
    unique: unique.size,
    cached,
    pending: pendingTags.length,
    batches: pendingTags.length ? Math.ceil(pendingTags.length / TAG_BATCH) : 0,
    pendingTags,
  };
}

/* ============ 取消 ============ */

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function abortError(): DOMException {
  return new DOMException('已取消翻译', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/* ============ 提示词构造 ============ */

const TAG_SYSTEM =
  '你是 danbooru / NovelAI 图像提示词的翻译助手。把每个英文标签翻译成简体中文，' +
  '逐条对应，不合并、不拆分、不增加、不删除、不改写标签本身。只输出 JSON，不要解释。';

function buildTagMessages(tags: string[]): ChatMsg[] {
  return [
    { role: 'system', content: TAG_SYSTEM },
    {
      role: 'user',
      content:
        '把下面每一行英文标签翻译成简体中文。\n' +
        '输出格式（严格按此结构，tags 条数与输入一致）：\n' +
        '{"tags":[{"tag":"原样的英文标签","chinese":"简体中文释义"}]}\n\n' +
        '标签列表：\n' +
        tags.join('\n'),
    },
  ];
}

const NL_SYSTEM =
  '你是翻译助手。把用户给的英文（可能是逗号分隔的提示词片段，也可能是整句自然语言）' +
  '翻译成简体中文，保持原意与所有细节，不增删内容，只输出译文本身，不要输出原文，不要解释。';

function buildNlMessages(text: string): ChatMsg[] {
  return [
    { role: 'system', content: NL_SYSTEM },
    { role: 'user', content: text },
  ];
}

/* ============ 返回校验 ============ */

export class TranslateFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslateFormatError';
  }
}

/** 从模型输出里抠出 JSON(容忍 ```json 围栏与前后废话)。 */
function extractJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
  const start = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  const from = start < 0 ? arrayStart : arrayStart < 0 ? start : Math.min(start, arrayStart);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (from < 0 || end <= from) throw new TranslateFormatError('AI 返回内容里没有找到 JSON');
  try {
    return JSON.parse(text.slice(from, end + 1));
  } catch {
    throw new TranslateFormatError('AI 返回的 JSON 无法解析');
  }
}

/**
 * 校验「标签 → 中文」的对应关系。
 *
 * 严格口径(不能放松,否则会把假翻译当成真释义缓存起来):
 * - `tag` 与 `chinese` 必须是字符串,数字/对象/null 一律丢弃,不做 `String()` 兜底;
 * - 只接受本次请求里的标签(模型多给的丢弃,不写缓存、不上屏);
 * - 译文必须含中文,且不能是把英文原样抄回来(专名宁可不翻译,也不能伪装成中文释义);
 * - 缺条不视为协议错误(允许部分成功),但一条可用都没有就报错,让调用方显示失败。
 */
export function parseTagTranslations(raw: string, requested: string[]): Map<string, string> {
  const wanted = new Set(requested.map(normalizeTagQuery).filter(Boolean));
  const payload = extractJson(raw);
  const list: unknown = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? ((payload as { tags?: unknown; items?: unknown }).tags ??
        (payload as { items?: unknown }).items)
      : null;
  if (!Array.isArray(list)) throw new TranslateFormatError('AI 返回里没有 tags 数组');

  const translated = new Map<string, string>();
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rawTag = (item as { tag?: unknown }).tag;
    const rawChinese = (item as { chinese?: unknown }).chinese;
    if (typeof rawTag !== 'string' || typeof rawChinese !== 'string') continue;
    const tag = normalizeTagQuery(rawTag);
    const chinese = rawChinese.trim();
    if (!tag || !wanted.has(tag)) continue;
    if (!CJK.test(chinese)) continue;
    if (normalizeTagQuery(chinese) === tag) continue;
    translated.set(tag, chinese);
  }
  if (!translated.size) throw new TranslateFormatError('AI 没有返回可用的中文译文');
  return translated;
}

/** 自然语言译文校验:必须是非空中文、不能只是把原文抄回来。 */
export function parseNaturalTranslation(raw: string, source: string): string {
  const text = raw
    .trim()
    .replace(/^```(?:\w+)?/i, '')
    .replace(/```$/, '')
    .trim();
  if (!text) throw new TranslateFormatError('AI 返回了空译文');
  if (!CJK.test(text)) throw new TranslateFormatError('AI 返回的内容里没有中文');
  if (normalizeTagQuery(text) === normalizeTagQuery(source)) {
    throw new TranslateFormatError('AI 原样返回了输入内容,没有翻译');
  }
  return text;
}

/* ============ 请求 ============ */

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface CompletionOptions {
  signal?: AbortSignal;
  source: string;
  validate?: (content: string) => void;
}

/**
 * 按确认时定下的通道发起一次请求。
 * `target.channel` 为 null 时走主 API —— 主 API 入口忽略 signal(见文件头注释),
 * 所以调用方在返回后必须自己再判一次取消。
 */
async function runCompletion(
  target: TranslateTarget,
  messages: ChatMsg[],
  opts: CompletionOptions,
): Promise<string> {
  if (target.channel) return requestCompletion(target.channel, messages, opts);
  return requestViaMainApi(messages, opts);
}

export interface TagTranslateResult {
  /** 归一化标签 → 中文(含本次成功与命中缓存的) */
  translated: Map<string, string>;
  /** 本次仍没有中文的标签(原始写法) */
  failed: string[];
}

/**
 * 批量翻译标签:归一化去重 → 去掉缓存已有的 → 分批请求 → 逐批校验 → 写缓存。
 *
 * 取消时抛 `AbortError`(调用方据此保持静默),并且:
 * 不会再发下一批;已经返回但取消之后的批次既不写缓存、也不计入结果。
 */
export async function translateTags(
  rawTags: string[],
  opts: { signal?: AbortSignal; target?: TranslateTarget } = {},
): Promise<TagTranslateResult> {
  const target = opts.target ?? describeTranslateTarget();
  const signal = opts.signal;

  const unique = new Map<string, string>();
  for (const raw of rawTags) {
    const key = normalizeTagQuery(raw);
    if (key && !unique.has(key)) unique.set(key, raw);
  }

  const translated = new Map<string, string>();
  const missing: Array<{ key: string; raw: string }> = [];
  for (const [key, raw] of unique) {
    const cached = getCachedTagTranslation(key);
    if (cached) translated.set(key, cached);
    else missing.push({ key, raw });
  }

  /** 最近一次「这一批返回格式不可用」的错误:用来在一条都没成功时给出明确失败 */
  let lastFormatError: TranslateFormatError | null = null;

  for (let offset = 0; offset < missing.length; offset += TAG_BATCH) {
    throwIfAborted(signal);
    const batch = missing.slice(offset, offset + TAG_BATCH);
    // 送原文写法(而不是归一化后的键):模型看到的是用户提示词里真实的标签样子;
    // 收回来的对应关系仍按归一化键比对,两边口径由 parseTagTranslations 统一。
    const batchText = batch.map(item => item.raw);
    const captured: { result: Map<string, string> | null } = { result: null };
    const validate = (content: string) => {
      captured.result = parseTagTranslations(content, batchText);
    };
    try {
      await runCompletion(target, buildTagMessages(batchText), {
        signal,
        source: 'AI 翻译(标签)',
        validate,
      });
    } catch (error) {
      // 网络/通道错误照旧抛出(调用方要提示重试);只有「这一批格式不可用」才容忍,
      // 让其它批次的中文仍然生效,这一批的标签留在 failed 里如实显示「暂无释义」。
      if (!(error instanceof TranslateFormatError)) throw error;
      lastFormatError = error;
      throwIfAborted(signal);
      continue;
    }
    // 主 API 忽略 signal:返回后立刻再判一次,取消后的迟到结果不落缓存、不上屏
    throwIfAborted(signal);
    const result = captured.result ?? new Map<string, string>();
    for (const [tag, chinese] of result) {
      translated.set(tag, chinese);
      writeCache(tag, chinese);
    }
    persist();
  }

  // 一条都没成功(且确实有待翻译内容)才认定为失败:交给调用方显示错误,而不是空结果
  if (!translated.size && missing.length && lastFormatError) {
    throw lastFormatError;
  }

  return {
    translated,
    failed: [...unique.keys()].filter(key => !translated.has(key)).map(key => unique.get(key) ?? key),
  };
}

/** 自然语言翻译:**整段送、整段回**,绝不按逗号拆成标签。 */
export async function translateNaturalText(
  text: string,
  opts: { signal?: AbortSignal; target?: TranslateTarget } = {},
): Promise<string> {
  const source = text.trim();
  if (!source) throw new TranslateFormatError('没有可翻译的内容');
  const signal = opts.signal;
  throwIfAborted(signal);
  const captured: { result: string | null } = { result: null };
  const validate = (content: string) => {
    captured.result = parseNaturalTranslation(content, source);
  };
  await runCompletion(opts.target ?? describeTranslateTarget(), buildNlMessages(source), {
    signal,
    source: 'AI 翻译(自然语言)',
    validate,
  });
  throwIfAborted(signal);
  if (!captured.result) throw new TranslateFormatError('AI 没有返回可用的译文');
  return captured.result;
}

/** 供界面提示「会发送哪些字」:只送标签/自然语言本身,不带聊天正文、角色卡、世界书、密钥。 */
export function describeTranslatePayload(kind: 'tag' | 'nl', text: string): string {
  return kind === 'tag' ? text : text;
}

export const translateErrorText = errorText;
