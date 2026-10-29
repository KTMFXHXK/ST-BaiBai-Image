import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ raw: '', beforeReply: () => {}, notes: [] as string[] }));
vi.mock('@/api/client', () => ({
  requestCompletion: vi.fn(),
  requestViaMainApi: vi.fn(async (_messages, options) => {
    fake.beforeReply();
    options.validate(fake.raw);
  }),
}));
vi.mock('@/autoTag/prompt', () => ({
  autoTagProfile: () => ({ nl: true, naiCharPrompts: false, lockedSize: null }),
  buildAutoTagMessages: vi.fn(async (_ctx, _floor, _options, _memory, _target, _anchors, note) => {
    fake.notes.push(note);
    return [];
  }),
}));

import { requestFloorTags, requestSlotTag } from '@/autoTag/runner';
import { settings } from '@/state/settings';
import { detachedImageTags, messageImageTags } from '@/st/imageSlots';
import { consumeAutoGenerate, clearAutoGenerateFlags } from '@/floor/autoGenerate';
import { requestViaMainApi } from '@/api/client';

let context: any;
beforeEach(() => {
  context = { chat: [{ name: 'Test', mes: '她推开旅馆的门。\n她走到窗边看着雨。', is_user: false, is_system: false, send_date: 'start', swipes: ['她推开旅馆的门。\n她走到窗边看着雨。'], swipe_id: 0 }], chatMetadata: {}, getCurrentChatId: () => 'placement-test', saveChat: vi.fn(async () => {}), eventSource: {}, eventTypes: {}, name1: 'User', name2: 'Test' };
  vi.stubGlobal('window', { SillyTavern: { getContext: () => context } });
  vi.stubGlobal('document', { querySelector: () => null });
  vi.stubGlobal('toastr', { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() });
  settings.enabled = true;
  settings.ui.imagePlacement = 'bottom';
  settings.autoTag.minImages = 1;
  settings.autoTag.maxImages = 3;
  settings.autoTag.retryCount = 0;
  settings.autoTag.autoGenerate = true;
  fake.raw = JSON.stringify({ images: [{ position: 'P2', tag: 'window scene' }, { position: 'P1', tag: 'door scene' }], changes: [] });
  fake.beforeReply = () => {};
  fake.notes = [];
  vi.mocked(requestViaMainApi).mockClear();
  clearAutoGenerateFlags();
});
afterEach(() => { vi.unstubAllGlobals(); clearAutoGenerateFlags(); });

describe('自动提示词真实写回链路（仅模型响应替身）', () => {
  it('底部方式保持正文原样，并按场景顺序写槽位及一次性生成标记', async () => {
    const original = context.chat[0].mes;
    await requestFloorTags(0);
    expect(context.saveChat).toHaveBeenCalledOnce();
    expect(context.chat[0].mes).toBe(original);
    expect(messageImageTags(context.chat[0])[0]).toContain('door scene');
    expect(messageImageTags(context.chat[0])[1]).toContain('window scene');
    expect(consumeAutoGenerate('placement-test', 0, 0, 0)).toBe('auto');
    expect(consumeAutoGenerate('placement-test', 0, 0, 0)).toBeNull();
    await requestFloorTags(0);
    expect(requestViaMainApi).toHaveBeenCalledOnce();
  });
  it('旧默认仍把标签插在相应场景后', async () => {
    settings.ui.imagePlacement = 'inline';
    await requestFloorTags(0);
    expect(detachedImageTags(context.chat[0])).toBeNull();
    expect(context.chat[0].mes).toContain('她推开旅馆的门。\n<bbi_image>door scene');
  });
  it('底部单槽 AI 重写使用原提示词，保留正文及兄弟槽位', async () => {
    await requestFloorTags(0);
    const original = context.chat[0].mes;
    const sibling = messageImageTags(context.chat[0])[1];
    // 新默认切回行内不会把已存底部的消息搬回正文。
    settings.ui.imagePlacement = 'inline';
    fake.raw = JSON.stringify({ images: [{ position: 'P2', tag: 'improved door scene' }], changes: [] });
    await requestSlotTag(0, 0);
    expect(context.chat[0].mes).toBe(original);
    expect(messageImageTags(context.chat[0])[0]).toContain('improved door scene');
    expect(messageImageTags(context.chat[0])[1]).toBe(sibling);
    expect(fake.notes.at(-1)).toContain('door scene');
    expect(consumeAutoGenerate('placement-test', 0, 0, 0)).toBe('force');
  });
  it('等待模型时用户改动正文，仍在当前正文上写回而非覆盖旧快照', async () => {
    const original = context.chat[0].mes;
    fake.beforeReply = () => { context.chat[0].mes += '\n新的状态栏'; };
    await requestFloorTags(0);
    expect(context.chat[0].mes).toBe(original + '\n新的状态栏');
    expect(messageImageTags(context.chat[0])).toHaveLength(2);
  });
  it('单槽请求期间槽位改变时放弃迟到写回', async () => {
    await requestFloorTags(0);
    context.saveChat.mockClear();
    fake.raw = JSON.stringify({ images: [{ position: 'P1', tag: 'late' }], changes: [] });
    fake.beforeReply = () => { context.chat[0].extra.bbiImageSlots.swipes['0'][0] = '<bbi_image>user edit</bbi_image>'; };
    await requestSlotTag(0, 0);
    expect(context.saveChat).not.toHaveBeenCalled();
    expect(messageImageTags(context.chat[0])[0]).toContain('user edit');
    expect(consumeAutoGenerate('placement-test', 0, 0, 0)).toBeNull();
  });
});
