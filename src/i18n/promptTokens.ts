import { normalizeTagQuery } from './tagDictionary';

/**
 * 把一段提示词切成「可查词」的标签标记,**纯只读解析**:返回的位置信息只用于把中文释义
 * 对齐到原文,不提供任何改写/删除/加权的接口——本插件的编辑辅助绝不改提示词。
 *
 * 移植自本地参考工程 NovelAI创作工坊 的 services/tagTranslations.ts(仅解析部分),
 * 保留它对权重语法的全部兼容,并额外支持 `artist:` / `artists:` 前缀:
 *   `{tag}` `[tag]` `1.2::tag::` `(tag:1.2)` `(tag)` `artist:xxx` `artists:xxx`
 * 归一化(去权重、去括号、去前缀、下划线转空格、小写)只写进 `lookupTag`,原文不动。
 */

export type PromptTagGroupKind = 'numeric' | 'brace' | 'bracket';

export interface PromptTagToken {
  /** 稳定 id:序号 + 查词键 */
  id: string;
  /** 展示用:剥掉权重/括号/artist: 前缀后的英文标签(仍保留原始大小写与下划线) */
  displayTag: string;
  /** 查词用:大小写/下划线已归一,只用于比对 */
  lookupTag: string;
  start: number;
  end: number;
  groupId?: string;
  groupStart?: number;
  groupEnd?: number;
  groupWeight?: string;
  groupKind?: PromptTagGroupKind;
  groupLevel?: number;
}

/** 去掉一层层的权重/括号包装与 artist: 前缀,只留下标签本体。 */
function unwrapToken(raw: string, start = 0, group?: Omit<Partial<PromptTagToken>, 'id'>) {
  const leading = raw.search(/\S/);
  const trimmed = raw.trim();
  const tokenStart = leading >= 0 ? start + leading : start;
  const tokenEnd = leading >= 0 ? tokenStart + trimmed.length : start + raw.length;
  let value = trimmed;
  value = value.replace(/^[{[\s]+/, '').replace(/[}\]\s]+$/, '').trim();
  value = value.replace(/^\{+([\s\S]*?)\}+$/, '$1').replace(/^\[+([\s\S]*?)\]+$/, '$1').trim();
  value = value.replace(/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)::\s*/, '').replace(/\s*::$/, '').trim();
  value = value.replace(/^\(([\s\S]*?)(?::\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+))\)$/, '$1').trim();
  value = value.replace(/^\(([\s\S]*)\)$/, '$1').trim();
  if (/^artists?\s*:/i.test(value)) value = value.replace(/^artists?\s*:\s*/i, '').trim();
  return {
    displayTag: value,
    lookupTag: normalizeTagQuery(value),
    start: tokenStart,
    end: tokenEnd,
    ...(group ?? {}),
  };
}

const parseSegment = (
  prompt: string,
  rawStart: number,
  rawEnd: number,
  group?: Omit<Partial<PromptTagToken>, 'id'>,
): Array<Omit<PromptTagToken, 'id'>> =>
  [...prompt.slice(rawStart, rawEnd).matchAll(/[^,，\n|]+/g)].flatMap(match => {
    const token = unwrapToken(match[0], rawStart + match.index, group);
    return token.lookupTag && /[\p{L}\p{N}]/u.test(token.lookupTag) ? [token] : [];
  });

/** 解析出所有标签标记(顺序与原文一致,只读)。 */
export function parsePromptTokens(prompt: string): PromptTagToken[] {
  const tokens: Array<Omit<PromptTagToken, 'id'>> = [];
  let segmentStart = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let numericStart = -1;

  const flush = (end: number, contentStart = segmentStart, contentEnd = end) => {
    if (end <= segmentStart || contentEnd <= contentStart) return;
    // leading 必须取自未 trim 的切片:trimmed.search(/\S/) 恒为 0,会让 raw 首部多算空白、
    // 尾部少截同样长度,导致 `", 1.2::tag::"` 之类的后续权重组因 raw 不以 :: 结尾而丢掉分组。
    const segment = prompt.slice(segmentStart, end);
    const trimmed = segment.trim();
    const leading = segment.search(/\S/);
    const groupStart = leading < 0 ? segmentStart : segmentStart + leading;
    const groupEnd = groupStart + trimmed.length;
    const raw = prompt.slice(groupStart, groupEnd);
    let start = contentStart;
    let finalEnd = contentEnd;
    let groupKind: PromptTagGroupKind | undefined;
    let groupWeight: string | undefined;
    let groupLevel: number | undefined;

    if (numericStart >= 0 && raw.endsWith('::')) {
      groupKind = 'numeric';
      groupWeight = prompt.slice(groupStart, numericStart).trim();
      start = numericStart + 2;
      finalEnd = groupEnd - 2;
    } else if (raw[0] === '{' || raw[0] === '[') {
      // 只计算确实包住整段的层级,不能把首尾两个不同子组的括号算成共同权重。
      const open = raw[0];
      const close = open === '{' ? '}' : ']';
      let level = 0;
      while (raw[level] === open && raw[raw.length - level - 1] === close) {
        let depth = 0;
        let complete = true;
        for (let index = level; index < raw.length - level; index += 1) {
          if (raw[index] === open) depth += 1;
          if (raw[index] === close) depth -= 1;
          if (depth === 0 && index < raw.length - level - 1) {
            complete = false;
            break;
          }
        }
        if (!complete || depth !== 0) break;
        level += 1;
      }
      if (level) {
        groupKind = open === '{' ? 'brace' : 'bracket';
        groupLevel = level;
        start = groupStart + level;
        finalEnd = groupEnd - level;
      }
    }

    const group =
      groupKind === undefined
        ? undefined
        : { groupId: `${groupStart}:${groupEnd}`, groupStart, groupEnd, groupWeight, groupKind, groupLevel };
    tokens.push(...parseSegment(prompt, start, finalEnd, group));
  };

  for (let i = 0; i < prompt.length; i += 1) {
    const char = prompt[i];
    if (char === ':' && prompt[i + 1] === ':' && numericStart >= 0) {
      flush(i + 2, numericStart + 2, i);
      segmentStart = i + 2;
      numericStart = -1;
      i += 1;
    } else if (char === ':' && prompt[i + 1] === ':' && numericStart < 0) {
      const prefix = prompt.slice(segmentStart, i).trim();
      if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(prefix)) numericStart = i;
      i += 1;
    } else if (char === '{') braceDepth += 1;
    else if (char === '}' && braceDepth) braceDepth -= 1;
    else if (char === '[') bracketDepth += 1;
    else if (char === ']' && bracketDepth) bracketDepth -= 1;
    if (
      (char === ',' || char === '，' || char === '\n' || char === '|') &&
      !braceDepth &&
      !bracketDepth &&
      numericStart < 0
    ) {
      flush(i);
      segmentStart = i + 1;
      numericStart = -1;
    }
  }
  flush(prompt.length);

  return tokens.map((item, index) => ({ ...item, id: `${index}:${item.lookupTag}` }));
}

/**
 * 把一个英文标签追加进提示词字段(用户主动点「插入」才走这里)。
 *
 * 保真规则:已有内容的**每一个字符都留在原位**,只在其后追加分隔符与英文标签,
 * 不重排、不去重、不改权重、不折叠/删除任何白空与换行。
 * - 空串 → 直接就是标签;
 * - 纯空白(如几个空格、一个换行)→ 原样保留,后接标签(前面没有别的标签需要分隔);
 * - 末尾已有逗号(可带空白,含中文逗号)→ 直接接上,不再补分隔符;
 * - 其余情况(含末尾空格/换行)→ 保留全部已有字符,只补 `, ` 再接标签。
 */
export function appendTagToken(current: string, token: string): string {
  const name = token.trim();
  if (!name) return current;
  if (!current) return name;
  if (!current.trim()) return `${current}${name}`;
  if (/[,，]\s*$/.test(current)) return `${current}${name}`;
  return `${current}, ${name}`;
}
