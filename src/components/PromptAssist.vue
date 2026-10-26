<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import {
  describeCancelEffect,
  describeTagTranslatePlan,
  describeTranslateTarget,
  getCachedTagTranslation,
  isAbortError,
  translateErrorText,
  translateNaturalText,
  translateTags,
  type TagTranslatePlan,
  type TranslateTarget,
} from '@/i18n/aiTranslate';
import { appendTagToken, parsePromptTokens, type PromptTagToken } from '@/i18n/promptTokens';
import { lookupTags, searchTags, type TagSuggestion } from '@/i18n/tagDictionary';

/**
 * 提示词编辑辅助面板(中英词典 + 按需 AI 翻译),给所有「贴英文提示词」的输入框复用。
 *
 * 【职责边界,三句话】
 * 1. 只读提示词:解析出的标签只用来对齐中文释义,面板不提供任何改写/去重/纠错的入口;
 *    唯一会写字的动作是用户点「插入」把查到的英文标签追加到字段末尾。
 * 2. 中文只是辅助显示:不进保存内容、不进 NovelAI 请求 —— 面板拿到的 `text` 是只读快照,
 *    翻译结果只存在本组件的状态里,连 emit 都没有对应事件。
 * 3. 自动查词只查本地词典(零成本);任何 AI 请求都必须先点按钮、再在预览里确认。
 *
 * 【为什么每个字段一个实例】
 * 全局 tag、负面词、每个角色的 tag/自然语言互相独立:各自的展开态、查询词、翻译结果
 * 都不共享,快速切换字段/删行时用代际计数作废旧请求,避免把上一个字段的译文显示到这里。
 *
 * 【取消与过期结果】
 * 每次任务都领一个自增 `taskId`;取消/收起/卸载/文本变化都会 abort 并领新号,旧任务的
 * success/error/finally 因为 taskId 不匹配而全部丢弃(既不写缓存,也不上屏)。
 * 取消只作用于本组件自己的 AbortController,绝不调用酒馆的全局停止(会影响别的生成)。
 */
const props = withDefaults(
  defineProps<{
    /** 当前输入框里的原文(只读;组件绝不回写) */
    text: string;
    /** tag:分词比对释义 + 查词插入;nl:整段自然语言翻译 */
    kind?: 'tag' | 'nl';
    /** 面板标题里的字段名(如「画面 tag」) */
    label?: string;
    /** 默认展开(tag 字段给 true,nl 与角色行给 false,避免弹窗一屏全是面板) */
    defaultOpen?: boolean;
    /** 紧凑模式:角色行里用,字号更小 */
    compact?: boolean;
    /** 字段是否可编辑;false 时隐藏「插入」按钮(只读字段不该给一个按了没反应的按钮) */
    canInsert?: boolean;
  }>(),
  { kind: 'tag', label: '', defaultOpen: false, compact: false, canInsert: true },
);

const emit = defineEmits<{ (e: 'insert', payload: string): void }>();

const open = ref(props.defaultOpen);

/** 只读分词结果:nl 字段不需要 */
const tokens = computed<PromptTagToken[]>(() =>
  props.kind === 'tag' ? parsePromptTokens(props.text) : [],
);

/** 去重后的查词键(同一标签在同一段里可能出现多次) */
const tokenKeys = computed(() => [...new Set(tokens.value.map(token => token.lookupTag).filter(Boolean))]);

/* ============ 词典释义 ============ */

const definitions = ref<Map<string, TagSuggestion>>(new Map());
/**
 * AI 译文也用 Map 存:普通对象从 Object.prototype 继承属性,`obj[key]` 在 key 为
 * constructor / toString / __proto__ 时会返回原型成员,于是「缓存空、零请求」也能
 * 显示成「AI 翻译」并带出 function Object() { [native code] }。
 * Map 只命中自己 set 过的键;取值统一走 aiTranslationOf() 再做一次类型校验。
 */
const aiDefinitions = ref<Map<string, string>>(new Map());

/** 只有「自己写入的非空字符串」才算一条可用译文 */
function isUsableTranslation(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** 读取某标签的 AI 译文,拿不到或不合法都返回空串(界面据此显示「暂无释义」) */
function aiTranslationOf(key: string): string {
  const found = aiDefinitions.value.get(key);
  return isUsableTranslation(found) ? found : '';
}
const dictionaryState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');
const dictionaryError = ref('');
/** 代际:文本变了/重新查了,旧的异步结果直接丢 */
let lookupGeneration = 0;

function seedAiCache(): void {
  const next = new Map(aiDefinitions.value);
  for (const key of tokenKeys.value) {
    if (isUsableTranslation(next.get(key))) continue;
    const cached = getCachedTagTranslation(key);
    if (isUsableTranslation(cached)) next.set(key, cached.trim());
  }
  aiDefinitions.value = next;
}

async function refreshDefinitions(): Promise<void> {
  if (!open.value || props.kind !== 'tag' || !tokenKeys.value.length) return;
  seedAiCache();
  const generation = ++lookupGeneration;
  dictionaryState.value = 'loading';
  dictionaryError.value = '';
  try {
    const found = await lookupTags(tokenKeys.value);
    if (generation !== lookupGeneration) return;
    definitions.value = found;
    dictionaryState.value = 'ready';
  } catch (error) {
    if (generation !== lookupGeneration) return;
    dictionaryState.value = 'error';
    dictionaryError.value = translateErrorText(error);
  }
}

/** 每个标签最终显示什么:词典优先,其次 AI,再没有就是「暂无释义」 */
const rows = computed(() =>
  tokens.value.map(token => {
    const dictionary = definitions.value.get(token.lookupTag);
    const ai = aiTranslationOf(token.lookupTag);
    return {
      token,
      chinese: dictionary?.chinese || ai || '',
      source: dictionary?.chinese ? ('dictionary' as const) : ai ? ('ai' as const) : ('missing' as const),
      categoryLabel: dictionary?.categoryLabel ?? '',
    };
  }),
);

const missingTokens = computed(() => {
  const seen = new Set<string>();
  return tokens.value.filter(token => {
    if (seen.has(token.lookupTag)) return false;
    seen.add(token.lookupTag);
    const dictionary = definitions.value.get(token.lookupTag);
    return !dictionary?.chinese && !aiTranslationOf(token.lookupTag);
  });
});

const dictionaryCount = computed(() => new Set(rows.value.filter(row => row.source === 'dictionary').map(row => row.token.lookupTag)).size);

/* ============ 查词(中文或英文,前缀匹配) ============ */

const query = ref('');
const results = ref<TagSuggestion[]>([]);
const searching = ref(false);
const searched = ref(false);
const searchError = ref('');
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchGeneration = 0;

/** 任何会让旧结果失效的时机都调它:清空输入、收起面板、卸载、重新查询。 */
function invalidateSearch(): void {
  searchGeneration += 1;
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  searching.value = false;
  results.value = [];
  searched.value = false;
  searchError.value = '';
}

async function runSearch(): Promise<void> {
  const text = query.value.trim();
  if (!text) {
    invalidateSearch();
    return;
  }
  const generation = ++searchGeneration;
  searching.value = true;
  searchError.value = '';
  try {
    const found = await searchTags(text, 10);
    if (generation !== searchGeneration) return;
    results.value = found;
    searched.value = true;
  } catch (error) {
    if (generation !== searchGeneration) return;
    results.value = [];
    searchError.value = translateErrorText(error);
  } finally {
    if (generation === searchGeneration) searching.value = false;
  }
}

// 输入一变:旧结果立刻消失(不等防抖),再做 250ms 防抖查询
watch(query, () => {
  invalidateSearch();
  searchTimer = setTimeout(() => void runSearch(), 250);
});

/** 用户主动点「插入」才写字段:追加到末尾并补逗号分隔,已有一律不动。 */
function insert(suggestion: TagSuggestion): void {
  if (!props.canInsert) return;
  emit('insert', appendTagToken(props.text, suggestion.name));
}

/* ============ AI 翻译 ============ */

const aiScope = ref<'none' | 'tags' | 'nl'>('none');
const aiBusy = ref(false);
const aiError = ref('');
const aiNotice = ref('');
const aiBatchTotal = ref(0);

const previewOpen = ref(false);
/** 预览时定下的通道与待发送内容:确认后原样执行,执行中不会换道 */
const previewTarget = ref<TranslateTarget | null>(null);
const previewPlan = ref<TagTranslatePlan | null>(null);
const previewText = ref('');

const nlResult = ref('');
let aiTask = 0;
let aiController: AbortController | null = null;
/** 正在执行的那次通道(取消后据此决定「真的停了」还是「可能仍在服务端跑」) */
let runningTarget: TranslateTarget | null = null;

const channelText = computed(() => {
  const target = previewTarget.value;
  if (!target) return describeTranslateTarget().label;
  return `${target.label}${target.model ? `，模型 ${target.model}` : ''}`;
});

/** 每次打开预览都重新读通道,避免显示与实际执行不一致。 */
function openPreview(): void {
  aiError.value = '';
  aiNotice.value = '';
  const target = describeTranslateTarget();
  previewTarget.value = target;
  previewText.value = props.kind === 'nl' ? props.text : '';
  previewPlan.value =
    props.kind === 'tag' ? describeTagTranslatePlan(missingTokens.value.map(token => token.displayTag)) : null;
  previewOpen.value = true;
}

/** 取消/收起/卸载/文本变化都用它:作废旧任务并放开 UI,迟到的响应按 taskId 丢弃。 */
function abortAi(options: { notify: boolean } = { notify: false }): void {
  const wasBusy = aiBusy.value;
  const target = runningTarget;
  aiTask += 1;
  aiController?.abort();
  aiController = null;
  runningTarget = null;
  aiBusy.value = false;
  aiScope.value = 'none';
  aiBatchTotal.value = 0;
  if (options.notify && wasBusy) {
    aiNotice.value = target ? describeCancelEffect(target) : '已取消本次翻译。';
  }
}

function cancelAi(): void {
  abortAi({ notify: true });
}

async function runAiTags(): Promise<void> {
  const plan = previewPlan.value;
  const target = previewTarget.value;
  if (!plan || !target || !plan.pending || aiBusy.value) return;
  abortAi();
  const controller = new AbortController();
  const task = ++aiTask;
  aiController = controller;
  runningTarget = target;
  previewOpen.value = false;
  aiBusy.value = true;
  aiScope.value = 'tags';
  aiBatchTotal.value = plan.batches;
  aiError.value = '';
  aiNotice.value = '';
  try {
    const result = await translateTags(plan.pendingTags, { signal: controller.signal, target });
    if (task !== aiTask || controller.signal.aborted) return;
    const next = new Map(aiDefinitions.value);
    for (const [key, chinese] of result.translated) {
      if (isUsableTranslation(chinese)) next.set(key, chinese.trim());
    }
    aiDefinitions.value = next;
    if (result.failed.length) {
      aiError.value = `有 ${result.failed.length} 个标签这次没有拿到中文释义（专名通常不翻译），仍然是「暂无释义」，可以稍后重试。`;
    }
  } catch (error) {
    if (task !== aiTask || controller.signal.aborted || isAbortError(error)) return;
    aiError.value = translateErrorText(error);
  } finally {
    if (task === aiTask) {
      aiController = null;
      runningTarget = null;
      aiBusy.value = false;
      aiScope.value = 'none';
      aiBatchTotal.value = 0;
    }
  }
}

async function runAiNl(): Promise<void> {
  const source = previewText.value.trim();
  const target = previewTarget.value;
  if (!source || !target || aiBusy.value) return;
  abortAi();
  const controller = new AbortController();
  const task = ++aiTask;
  aiController = controller;
  runningTarget = target;
  previewOpen.value = false;
  aiBusy.value = true;
  aiScope.value = 'nl';
  aiBatchTotal.value = 1;
  aiError.value = '';
  aiNotice.value = '';
  nlResult.value = '';
  try {
    const translated = await translateNaturalText(source, { signal: controller.signal, target });
    if (task !== aiTask || controller.signal.aborted) return;
    nlResult.value = translated;
  } catch (error) {
    if (task !== aiTask || controller.signal.aborted || isAbortError(error)) return;
    aiError.value = translateErrorText(error);
  } finally {
    if (task === aiTask) {
      aiController = null;
      runningTarget = null;
      aiBusy.value = false;
      aiScope.value = 'none';
      aiBatchTotal.value = 0;
    }
  }
}

function confirmAi(): void {
  if (props.kind === 'nl') void runAiNl();
  else void runAiTags();
}

/* ============ 展开/收起与文本变化 ============ */

function toggle(): void {
  const next = !open.value;
  open.value = next;
  if (next) {
    void refreshDefinitions();
    return;
  }
  // 收起元素 = 用户离开这个字段:正在跑的翻译一并取消,不留下后台任务
  previewOpen.value = false;
  invalidateSearch();
  abortAi({ notify: true });
}

// 文本变了:旧释义/旧译文立即作废(避免把上一个角色、上一版文本的中文显示到这里)
watch(
  () => props.text,
  () => {
    lookupGeneration += 1;
    definitions.value = new Map();
    aiDefinitions.value = new Map();
    dictionaryState.value = 'idle';
    dictionaryError.value = '';
    nlResult.value = '';
    aiError.value = '';
    aiNotice.value = '';
    previewOpen.value = false;
    previewPlan.value = null;
    previewTarget.value = null;
    abortAi();
    if (open.value) void refreshDefinitions();
  },
);

// default-open 的字段(画面 tag、画师串、词表弹窗)一挂载就是展开态,
// 不会触发下面的 watch,必须在这里主动查一次,否则首屏全是「暂无释义」。
onMounted(() => {
  if (open.value) void refreshDefinitions();
});

onBeforeUnmount(() => {
  invalidateSearch();
  abortAi();
});

const summary = computed(() => {
  if (props.kind === 'nl') return '翻译为中文';
  if (!props.text.trim()) return '中文对照';
  const total = tokenKeys.value.length;
  const known = dictionaryCount.value + aiDefinitions.value.size;
  return `中文对照 · ${total} 个标签${dictionaryState.value === 'ready' ? `，${Math.min(known, total)} 个有释义` : ''}`;
});
</script>

<template>
  <div class="bbi-assist" :class="{ 'is-compact': compact }">
    <div class="bbi-assist-head">
      <button
        class="bbi-assist-toggle"
        type="button"
        :aria-expanded="open"
        :title="open ? '收起中文辅助' : '展开中文辅助（只读，不会改动提示词）'"
        @click="toggle"
      >
        <span class="bbi-assist-caret" :class="{ 'is-open': open }">›</span>
        {{ summary }}
      </button>
      <span v-if="kind === 'nl' && text.trim()" class="bbi-assist-hint">只显示中文，不替换原提示词</span>
      <span v-else-if="open && dictionaryState === 'loading'" class="bbi-assist-hint">正在读取本地词典…</span>
    </div>

    <div v-if="open" class="bbi-assist-body">
      <p v-if="kind === 'tag'" class="bbi-assist-note">
        下面的中文只用于辅助查看：不会改动这段提示词，也不会进入 NovelAI 请求。
      </p>

      <!-- 当前字段的逐个标签对照 -->
      <template v-if="kind === 'tag'">
        <p v-if="!text.trim()" class="bbi-assist-empty">这段还没有内容。查词后点「插入」就能填进来。</p>
        <ul v-else class="bbi-assist-list">
          <li v-for="row in rows" :key="row.token.id" class="bbi-assist-row">
            <code class="bbi-assist-tag">{{ row.token.displayTag }}</code>
            <span
              class="bbi-assist-badge"
              :class="{
                'is-dict': row.source === 'dictionary',
                'is-ai': row.source === 'ai',
                'is-missing': row.source === 'missing',
              }"
              >{{ row.source === 'dictionary' ? '词典' : row.source === 'ai' ? 'AI 翻译' : '暂无释义' }}</span
            >
            <span v-if="row.chinese" class="bbi-assist-zh">{{ row.chinese }}</span>
            <span v-else class="bbi-assist-zh is-muted">—</span>
            <span v-if="row.categoryLabel" class="bbi-assist-cat">{{ row.categoryLabel }}</span>
          </li>
        </ul>

        <p v-if="dictionaryState === 'error'" class="bbi-assist-error">
          {{ dictionaryError }}
          <button class="bbi-assist-link" type="button" @click="refreshDefinitions">重试</button>
        </p>

        <!-- 查词:中文或英文都能查,结果显示英文原文 + 中文含义;只做前缀匹配 -->
        <div class="bbi-assist-search">
          <input
            v-model="query"
            class="bbi-input bbi-assist-input"
            type="text"
            placeholder="查词（按前缀）：中文「初音」或英文「hatsune」"
            aria-label="词典查词"
          />
          <span v-if="searching" class="bbi-assist-hint">查询中…</span>
        </div>
        <p v-if="searchError" class="bbi-assist-error">{{ searchError }}</p>
        <ul v-if="results.length" class="bbi-assist-results">
          <li v-for="item in results" :key="`${item.name}:${item.category}`" class="bbi-assist-result">
            <code class="bbi-assist-tag">{{ item.name }}</code>
            <span class="bbi-assist-badge is-dict">词典</span>
            <span class="bbi-assist-zh">{{ item.chinese || '（无中文释义）' }}</span>
            <span class="bbi-assist-cat">{{ item.categoryLabel }}<template v-if="item.postCount"> · {{ item.postCount }} 次</template></span>
            <button
              v-if="canInsert"
              class="bbi-btn bbi-btn-sm bbi-assist-insert"
              type="button"
              @click="insert(item)"
            >
              插入
            </button>
          </li>
        </ul>
        <p v-else-if="searched && !searching && !searchError" class="bbi-assist-empty">
          词典里没有查到「{{ query.trim() }}」。查词只按前缀匹配（查「初音」能找到「初音未来」，查「未来」不会），
          可以换个开头或用英文名再试。
        </p>
        <p v-if="!canInsert" class="bbi-assist-hint">这个字段是只读的，所以不提供插入。</p>

        <!-- AI 翻译:词典没有释义的标签,点了才发请求 -->
        <div v-if="missingTokens.length && !aiBusy" class="bbi-assist-ai">
          <button class="bbi-btn bbi-btn-sm" type="button" @click="openPreview">
            AI 翻译缺失的 {{ missingTokens.length }} 个标签
          </button>
          <span class="bbi-assist-hint">点开先看会发什么，不会自动花钱</span>
        </div>

        <div v-if="aiBusy && aiScope === 'tags'" class="bbi-assist-running">
          <span class="bbi-assist-hint">
            正在翻译…（共 {{ aiBatchTotal }} 批，每批最多 40 个标签）
          </span>
          <button class="bbi-btn bbi-btn-sm" type="button" @click="cancelAi">取消翻译</button>
        </div>

        <div v-if="previewOpen && previewPlan" class="bbi-assist-confirm">
          <p class="bbi-assist-note">
            将发送 {{ previewPlan.pending }} 个标签的英文原文（去重后
            {{ previewPlan.unique }} 个，其中 {{ previewPlan.cached }} 个已有中文、不再发送）：
            <code>{{ previewPlan.pendingTags.join('、') }}</code>
          </p>
          <p class="bbi-assist-note">
            通道：{{ channelText }}；预计分 {{ previewPlan.batches }} 次请求（每次最多 40 个标签），
            会产生真实文字 API 调用（可能计费）。只发送上面的标签，不带聊天正文、角色卡或密钥。
          </p>
          <div class="bbi-assist-actions">
            <button class="bbi-btn bbi-btn-sm" type="button" @click="previewOpen = false">取消</button>
            <button class="bbi-btn bbi-btn-sm bbi-btn-primary" type="button" @click="confirmAi">确认翻译</button>
          </div>
        </div>
      </template>

      <!-- 自然语言:整段送、整段回 -->
      <template v-else>
        <div v-if="!text.trim()" class="bbi-assist-empty">这段还没有内容，写点什么再翻译。</div>
        <template v-else>
          <button
            v-if="!previewOpen && !nlResult && !(aiBusy && aiScope === 'nl')"
            class="bbi-btn bbi-btn-sm"
            type="button"
            @click="openPreview"
          >
            翻译为中文
          </button>

          <div v-if="aiBusy && aiScope === 'nl'" class="bbi-assist-running">
            <span class="bbi-assist-hint">翻译中…（整段发送，共 1 次请求）</span>
            <button class="bbi-btn bbi-btn-sm" type="button" @click="cancelAi">取消翻译</button>
          </div>

          <div v-if="previewOpen" class="bbi-assist-confirm">
            <p class="bbi-assist-note">
              将发送这一整段原文（{{ [...previewText.trim()].length }} 个字符），整段发送、不拆分，不改动输入框。
            </p>
            <pre class="bbi-assist-preview">{{ previewText }}</pre>
            <p class="bbi-assist-note">
              通道：{{ channelText }}；预计 1 次请求，会产生真实文字 API 调用（可能计费）。
              不带聊天正文、角色卡或密钥。
            </p>
            <div class="bbi-assist-actions">
              <button class="bbi-btn bbi-btn-sm" type="button" @click="previewOpen = false">取消</button>
              <button class="bbi-btn bbi-btn-sm bbi-btn-primary" type="button" @click="confirmAi">确认翻译</button>
            </div>
          </div>

          <div v-if="nlResult" class="bbi-assist-result-block">
            <div class="bbi-assist-result-head">
              <span class="bbi-assist-badge is-ai">AI 翻译</span>
              <span class="bbi-assist-hint">仅辅助显示，不会替换上面的英文</span>
              <button class="bbi-assist-link" type="button" @click="nlResult = ''">清空</button>
            </div>
            <p class="bbi-assist-zh-block">{{ nlResult }}</p>
          </div>
        </template>
      </template>

      <p v-if="aiNotice" class="bbi-assist-notice">{{ aiNotice }}</p>
      <p v-if="aiError" class="bbi-assist-error">{{ aiError }}</p>
    </div>
  </div>
</template>

<style scoped>
.bbi-assist {
  margin-top: 6px;
  flex-shrink: 0;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  font-size: 12px;
  line-height: 1.65;
}
.bbi-assist.is-compact {
  font-size: 11.5px;
}

.bbi-assist-head {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 8px;
  flex-wrap: wrap;
}

.bbi-assist-toggle {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--bbi-ink-soft);
  font-size: inherit;
  line-height: inherit;
  cursor: pointer;
}
.bbi-assist-toggle:hover {
  color: var(--bbi-accent);
}

.bbi-assist-caret {
  display: inline-block;
  transition: transform 0.15s ease;
}
.bbi-assist-caret.is-open {
  transform: rotate(90deg);
}

.bbi-assist-hint {
  color: var(--bbi-ink-muted);
  font-size: 11.5px;
}

.bbi-assist-body {
  padding: 2px 8px 8px;
  border-top: 1px dashed var(--bbi-line-strong);
  /* 对照内容独立滚动，标签再多也不占满弹窗或挤压原文编辑区。 */
  max-height: min(32vh, 320px);
  max-height: min(32dvh, 320px);
  overflow-y: auto;
  overscroll-behavior-y: contain;
  scrollbar-width: thin;
}

.bbi-assist-body::-webkit-scrollbar {
  display: block;
  width: 6px;
}

.bbi-assist-body::-webkit-scrollbar-thumb {
  border-radius: 3px;
  background: var(--bbi-line-strong);
}

.bbi-assist-note {
  margin: 6px 0;
  color: var(--bbi-ink-muted);
  font-size: 11.5px;
}

.bbi-assist-empty {
  margin: 6px 0;
  color: var(--bbi-ink-muted);
}

.bbi-assist-list,
.bbi-assist-results {
  margin: 6px 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.bbi-assist-row,
.bbi-assist-result {
  display: flex;
  gap: 6px;
  align-items: baseline;
  flex-wrap: wrap;
}

.bbi-assist-tag {
  font-family: var(--bbi-font-mono);
  font-size: 11.5px;
  color: var(--bbi-ink);
  overflow-wrap: anywhere;
}

.bbi-assist-badge {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 999px;
  border: 1px solid var(--bbi-line-strong);
  font-size: 10.5px;
  line-height: 16px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}
.bbi-assist-badge.is-dict {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
.bbi-assist-badge.is-ai {
  color: #b26a00;
  border-color: #b26a00;
}
.bbi-assist-badge.is-missing {
  color: var(--bbi-ink-muted);
}

.bbi-assist-zh {
  flex: 1 1 160px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.bbi-assist-zh.is-muted {
  color: var(--bbi-ink-muted);
}

.bbi-assist-cat {
  flex: 0 0 auto;
  color: var(--bbi-ink-muted);
  font-size: 11px;
}

.bbi-assist-search {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
}

.bbi-assist-input {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  padding: 5px 8px;
}

.bbi-assist-insert {
  margin-left: auto;
}

.bbi-assist-ai,
.bbi-assist-running {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 8px;
}

.bbi-assist-confirm {
  margin-top: 8px;
  padding: 6px 8px;
  border: 1px dashed var(--bbi-accent);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
}

.bbi-assist-preview {
  margin: 6px 0;
  padding: 6px 8px;
  max-height: 120px;
  overflow: auto;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  font-family: var(--bbi-font-mono);
  font-size: 11.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.bbi-assist-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 6px;
}

.bbi-assist-notice {
  margin: 6px 0 0;
  color: var(--bbi-ink-muted);
  font-size: 11.5px;
}

.bbi-assist-error {
  margin: 6px 0 0;
  color: var(--bbi-danger);
}

.bbi-assist-link {
  padding: 0 4px;
  border: 0;
  background: transparent;
  color: var(--bbi-accent);
  font-size: inherit;
  cursor: pointer;
  text-decoration: underline;
}

.bbi-assist-result-block {
  margin-top: 6px;
}

.bbi-assist-result-head {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.bbi-assist-zh-block {
  margin: 6px 0 0;
  padding: 6px 8px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink);
  overflow-wrap: anywhere;
}

@media (max-width: 560px) {
  .bbi-assist-cat {
    flex: 1 1 100%;
  }
  .bbi-assist-insert {
    margin-left: 0;
  }
}
</style>
