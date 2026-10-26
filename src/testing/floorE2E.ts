/**
 * 楼层「编辑提示词」的隔离验证入口（只给 _tmp 下的夹具页用，不参与 dist 打包）。
 *
 * 走的是真实链路：promptEditor.openPromptEditor → 真实 PromptEditor.vue 组件 →
 * 真实 serializeImageTag / applyMessageText 写回。宿主边界（SillyTavern.getContext、
 * toastr、chat 数组）由夹具页提供假实现，因此这里只负责「按真实调用方的方式开窗」。
 */

import { openPromptEditor } from '@/floor/promptEditor';
import {
  parseImageTagContent,
  parseImageTags,
  replaceImageTagAt,
  serializeImageTag,
} from '@/st/imageTagRegex';

export { parseImageTagContent, parseImageTags, replaceImageTagAt, serializeImageTag };

export interface FloorE2EOpenOptions {
  /** 楼层正文原文（含 <bbi_image> 壳）。 */
  mes: string;
  floor?: number;
  chatId?: string;
  swipeId?: number;
  seq?: number;
  historyCount?: number;
  configured?: boolean;
}

/** 与 Card.vue 的调用方式一致：先解析正文，再把解析结果交给 openPromptEditor。 */
export function openEditor(options: FloorE2EOpenOptions): { rawTag: string; seq: number } {
  const seq = options.seq ?? 0;
  const rawTag = parseImageTags(options.mes)[seq];
  if (rawTag === undefined) throw new Error(`正文里没有第 ${seq} 条 tag`);
  openPromptEditor({
    at: {
      chatId: options.chatId ?? 'e2e-chat',
      messageId: options.floor ?? 1,
      swipeId: options.swipeId ?? 0,
      seq,
      rawTag,
    },
    content: parseImageTagContent(rawTag),
    historyCount: options.historyCount ?? 1,
    configured: options.configured ?? true,
  });
  return { rawTag, seq };
}
