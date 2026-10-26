import { describe, expect, it } from 'vitest';

import { appendTagToken, parsePromptTokens } from './promptTokens';

/**
 * 这些用例守的是「查词不改原文」的底线:解析只读,归一化只写进 lookupTag。
 * 原文(权重、下划线、大小写、重复、中文标点)必须逐字符保持。
 */

const lookup = (prompt: string) => parsePromptTokens(prompt).map(token => token.lookupTag);

describe('parsePromptTokens', () => {
  it('普通逗号分隔标签', () => {
    expect(lookup('1girl, long hair, school uniform')).toEqual(['1girl', 'long hair', 'school uniform']);
  });

  it('权重包装被剥掉,但原文不变', () => {
    const prompt = '1.2::long hair::, {smile}, [hat], (gloves:1.3), (skirt)';
    const tokens = parsePromptTokens(prompt);
    expect(tokens.map(token => token.displayTag)).toEqual(['long hair', 'smile', 'hat', 'gloves', 'skirt']);
    expect(tokens.map(token => token.lookupTag)).toEqual(['long hair', 'smile', 'hat', 'gloves', 'skirt']);
    // 解析是纯函数:输入字符串一个字符都没变
    expect(prompt).toBe('1.2::long hair::, {smile}, [hat], (gloves:1.3), (skirt)');
  });

  it('嵌套括号只剥掉真正包住整段的层级', () => {
    const tokens = parsePromptTokens('{{very long hair}}');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].displayTag).toBe('very long hair');
    expect(tokens[0].groupKind).toBe('brace');
    expect(tokens[0].groupLevel).toBe(2);
  });

  it('artist: / artists: 前缀用于查词,原文保留', () => {
    const prompt = 'artist:wlop, artists:  dairi , blue_archive';
    const tokens = parsePromptTokens(prompt);
    expect(tokens.map(token => token.displayTag)).toEqual(['wlop', 'dairi', 'blue_archive']);
    expect(prompt).toContain('artist:wlop');
    expect(prompt).toContain('artists:  dairi');
  });

  it('下划线转空格只发生在查词键上', () => {
    const [token] = parsePromptTokens('long_hair');
    expect(token.displayTag).toBe('long_hair');
    expect(token.lookupTag).toBe('long hair');
  });

  it('大小写归一只发生在查词键上', () => {
    const [token] = parsePromptTokens('Hatsune_Miku');
    expect(token.displayTag).toBe('Hatsune_Miku');
    expect(token.lookupTag).toBe('hatsune miku');
  });

  it('中文标点与竖线、换行都算分隔符', () => {
    expect(lookup('1girl，long hair|smile\nblue eyes')).toEqual(['1girl', 'long hair', 'smile', 'blue eyes']);
  });

  it('重复标签各自成词,不被去重', () => {
    const tokens = parsePromptTokens('smile, smile, smile');
    expect(tokens).toHaveLength(3);
    expect(new Set(tokens.map(token => token.id)).size).toBe(3);
    expect(tokens.every(token => token.lookupTag === 'smile')).toBe(true);
  });

  it('空串、纯分隔符、纯权重符号不产生词条', () => {
    expect(parsePromptTokens('')).toEqual([]);
    expect(parsePromptTokens(' , ， | \n ')).toEqual([]);
    expect(lookup('1.2:: ::')).toEqual([]);
  });

  it('位置信息指向原文里的标签本体(可用来对齐释义,不用于改写)', () => {
    const prompt = '1girl, {long hair}';
    const [, second] = parsePromptTokens(prompt);
    expect(prompt.slice(second.start, second.end)).toBe('long hair');
  });
});

describe('appendTagToken', () => {
  it('空字段直接填', () => {
    expect(appendTagToken('', 'hatsune miku')).toBe('hatsune miku');
  });

  it('纯空白字段保留原有空白,只在后面接标签', () => {
    // 空白是用户敲出来的原文,插入不许顺手 trim 掉
    expect(appendTagToken('   ', 'hatsune miku')).toBe('   hatsune miku');
    expect(appendTagToken('\n', 'smile')).toBe('\nsmile');
  });

  it('非空字段补逗号分隔,已有内容一个字符不动', () => {
    expect(appendTagToken('1girl, long hair', 'smile')).toBe('1girl, long hair, smile');
    // 尾部空白不删:只在它后面补「, 」
    expect(appendTagToken('1girl  ', 'smile')).toBe('1girl  , smile');
    expect(appendTagToken('1girl\n', 'smile')).toBe('1girl\n, smile');
    expect(appendTagToken('0.8::artist:yalmyu::', 'smile')).toBe('0.8::artist:yalmyu::, smile');
  });

  it('末尾已有逗号时不重复补,空白原样保留', () => {
    expect(appendTagToken('1girl,', 'smile')).toBe('1girl,smile');
    expect(appendTagToken('1girl，', 'smile')).toBe('1girl，smile');
    expect(appendTagToken('1girl,  ', 'smile')).toBe('1girl,  smile');
    expect(appendTagToken('1girl， ', 'smile')).toBe('1girl， smile');
  });

  it('不重排、不去重:同一个标签插两次就是两条', () => {
    const once = appendTagToken('1girl, smile', 'smile');
    expect(once).toBe('1girl, smile, smile');
    expect(appendTagToken('b, a', 'c')).toBe('b, a, c');
  });

  it('空标签不写入', () => {
    expect(appendTagToken('1girl', '   ')).toBe('1girl');
    expect(appendTagToken('', '   ')).toBe('');
  });

  it('插入结果能被重新解析出同一个标签(用结果喂回解析器不掉词)', () => {
    const merged = appendTagToken('1girl, {long hair}', 'blue_archive');
    expect(parsePromptTokens(merged).map(token => token.lookupTag)).toEqual(['1girl', 'long hair', 'blue archive']);
  });
});
