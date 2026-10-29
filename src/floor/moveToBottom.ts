import { getContext, type STMessage } from '@/st/context';
import { applyImageMessage, detachedImageTags } from '@/st/imageSlots';
import { hasImageTagTrace, parseImageTags } from '@/st/imageTagRegex';

/** 用户显式转换一条回复；原正文随同槽位保存，失败由事务整体回滚。 */
export async function moveToBottom(floor: number, expectedText: string, chatId: string, swipeId: number | null, expectedMessage?: STMessage) {
  const context = getContext();
  const message = context?.chat[floor];
  if (!message) return 'unavailable' as const;
  return applyImageMessage(floor, (text, current) => {
    if (text !== expectedText || detachedImageTags(current) !== null) return null;
    const tags = parseImageTags(text);
    const rest = text.replace(/<bbi_image>[\s\S]+?<\/bbi_image>/gi, '');
    // 残缺标签或嵌套标签不猜测转换，避免吞掉美化结构。
    if (!tags.length || hasImageTagTrace(rest) || tags.some(tag => parseImageTags(tag).length !== 1 || /<bbi_image>/gi.test(tag.slice(11)))) return null;
    const key = 'bbiImageInlineBackup';
    const previous = current.extra?.[key];
    if (previous !== undefined && (!previous || typeof previous !== 'object' || Array.isArray(previous))) return null;
    return {
      text: rest,
      tags,
      extra: [{ key, value: { ...previous as Record<string, unknown>, [String(current.swipe_id ?? 0)]: text } }],
    };
  }, chatId, swipeId, expectedMessage ?? message);
}
