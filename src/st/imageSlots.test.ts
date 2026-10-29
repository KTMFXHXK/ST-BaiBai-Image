import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { STMessage } from '@/st/context';
import { applyImageMessage, detachedImageTags, imageSlotsUpdate, messageImageTags } from '@/st/imageSlots';
import { moveToBottom } from '@/floor/moveToBottom';
import { historyEntries, promptHash } from '@/floor/storage';

const first = '<bbi_image>scene one<size>portrait</size></bbi_image>';
const second = '<bbi_image>scene two<size>landscape</size></bbi_image>';
let message: STMessage;
let context: any;

beforeEach(() => {
  message = { name: 'Char', is_user: false, is_system: false, mes: '<div>正文</div>', swipes: ['<div>正文</div>'], swipe_id: 0, send_date: 'original' };
  context = { chat: [message], getCurrentChatId: () => 'chat', saveChat: vi.fn(async () => {}), eventSource: {}, eventTypes: {} };
  vi.stubGlobal('window', { SillyTavern: { getContext: () => context } });
  vi.stubGlobal('document', { querySelector: () => null });
});
afterEach(() => vi.unstubAllGlobals());

describe('底部插图数据与正文隔离', () => {
  it('行内回退保持原文、重复提示词的槽位和顺序', () => {
    message.mes += first + first + second;
    expect(messageImageTags(message)).toEqual([first, first, second]);
    expect(detachedImageTags(message)).toBeNull();
  });
  it('底部写入不改 HTML 正文或 swipe，保留已有 extra', async () => {
    message.extra = { unrelated: 42 };
    const text = message.mes;
    expect(await applyImageMessage(0, text => ({ text, tags: [first, second] }), 'chat', 0, message)).toBe('saved');
    expect(message.mes).toBe(text);
    expect(message.swipes?.[0]).toBe(text);
    expect(message.extra?.unrelated).toBe(42);
    expect(messageImageTags(message)).toEqual([first, second]);
    const clone = JSON.parse(JSON.stringify(message));
    expect(messageImageTags(clone)).toEqual([first, second]);
    const tags = messageImageTags(message);
    tags[0] = second;
    expect(messageImageTags(message)[0]).toBe(first);
  });
  it('不同 swipe 隔离，保留其他 swipe 的底部数据', async () => {
    await applyImageMessage(0, text => ({ text, tags: [first] }), 'chat', 0);
    message.swipe_id = 1;
    message.swipes?.push(message.mes);
    expect(detachedImageTags(message)).toBeNull();
    await applyImageMessage(0, text => ({ text, tags: [second] }), 'chat', 1);
    expect(messageImageTags(message)).toEqual([second]);
    message.swipe_id = 0;
    expect(messageImageTags(message)).toEqual([first]);
  });
  it('单槽修改不改正文或兄弟槽位', async () => {
    await applyImageMessage(0, text => ({ text, tags: [first, second] }), 'chat', 0);
    const text = message.mes;
    await applyImageMessage(0, (text, current) => {
      const tags = messageImageTags(current);
      tags[0] = second;
      return { text, tags };
    }, 'chat', 0);
    expect(message.mes).toBe(text);
    expect(messageImageTags(message)).toEqual([second, second]);
  });
  it('保存失败同时回滚正文、swipe 与多个 extra 字段', async () => {
    const before = JSON.stringify(message);
    context.saveChat.mockRejectedValue(new Error('save failed'));
    await expect(applyImageMessage(0, () => ({ text: '改过', tags: [first], extra: [{ key: 'chars', value: 1 }] }), 'chat', 0)).rejects.toThrow('save failed');
    expect(JSON.stringify(message)).toBe(before);
  });
  it.each(['chat', 'swipe', 'floor'])('身份 %s 变化时不写入', async kind => {
    const expected = { ...message };
    if (kind === 'chat') context.getCurrentChatId = () => 'other';
    if (kind === 'swipe') message.swipe_id = 1;
    if (kind === 'floor') context.chat = [{ ...message, send_date: 'replacement' }];
    expect(await applyImageMessage(0, text => ({ text, tags: [first] }), 'chat', 0, expected)).not.toBe('saved');
    expect(context.saveChat).not.toHaveBeenCalled();
  });
  it('保留未知版本，拒绝静默覆盖', () => {
    message.extra = { bbiImageSlots: { v: 9, swipes: {} } };
    expect(() => imageSlotsUpdate(message, [first])).toThrow('版本');
  });
});

describe('旧回复单条转换', () => {
  it('仅移除完整标签，保留美化字节、历史/hash/槽位和可恢复原文', async () => {
    const original = '```html\r\n<div>正文' + first + '</div>\r\n```\r\n' + second;
    message.mes = original;
    message.swipes = [original];
    const entry = { generationId: 'old', path: '/old.png', prompt: first, seed: 1, status: 'ready' as const, createdAt: 1, slotSeq: 0 };
    message.extra = { bbiImage: { 0: { [promptHash(first)]: [entry] } } };
    expect(await moveToBottom(0, original, 'chat', 0)).toBe('saved');
    expect(message.mes).toBe('```html\r\n<div>正文</div>\r\n```\r\n');
    expect(messageImageTags(message)).toEqual([first, second]);
    expect(message.extra?.bbiImageInlineBackup).toEqual({ 0: original });
    expect(historyEntries(message.extra?.bbiImage as any, 0, promptHash(first), 0)).toEqual([entry]);
  });
  it.each(['<bbi_image>broken', first + '</bbi_image>', '<bbi_image>nested' + first + '</bbi_image>'])('残缺或嵌套结构不修改：%s', async text => {
    message.mes = text;
    expect(await moveToBottom(0, text, 'chat', 0)).toBe('build-failed');
    expect(message.mes).toBe(text);
    expect(context.saveChat).not.toHaveBeenCalled();
  });
  it('确认期间正文改变则放弃转换', async () => {
    message.mes += first;
    expect(await moveToBottom(0, '旧内容', 'chat', 0)).toBe('build-failed');
    expect(context.saveChat).not.toHaveBeenCalled();
  });
});
