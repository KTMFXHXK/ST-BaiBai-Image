import type { STMessage } from '@/st/context';
import { hasImageTagTrace, parseImageTags } from '@/st/imageTagRegex';
import { applyMessageText, type MessageExtraUpdate } from '@/st/messageEdit';

/** 底部模式只将有序提示词存入 extra，不让美化插件从正文读到内部标签。 */
export const imageSlotsExtraKey = 'bbiImageSlots';
interface BottomSlots { v: 1; swipes: Record<string, string[]> }

export function detachedImageTags(message: STMessage): string[] | null {
  const store = message.extra?.[imageSlotsExtraKey] as BottomSlots | undefined;
  if (!store || store.v !== 1 || !store.swipes) return null;
  const tags = store.swipes[String(message.swipe_id ?? 0)];
  return Array.isArray(tags) && tags.every(tag => typeof tag === 'string' && parseImageTags(tag)[0] === tag)
    ? tags : null;
}

export function messageImageTags(message: STMessage, text = message.mes): string[] {
  return [...(detachedImageTags(message) ?? parseImageTags(text))];
}

export function hasMessageImageTags(message: STMessage, text = message.mes): boolean {
  return messageImageTags(message, text).length > 0 || hasImageTagTrace(text);
}

export function imageSlotsUpdate(message: STMessage, tags: string[] | null): MessageExtraUpdate {
  const raw = message.extra?.[imageSlotsExtraKey] as BottomSlots | undefined;
  // 未识别版本绝不静默覆盖。
  if (raw && (raw.v !== 1 || !raw.swipes)) throw new Error('无法识别底部插图数据版本，未修改消息');
  const swipes = { ...raw?.swipes };
  const key = String(message.swipe_id ?? 0);
  if (tags === null) delete swipes[key];
  else swipes[key] = [...tags];
  return { key: imageSlotsExtraKey, value: { v: 1, swipes } satisfies BottomSlots };
}

export interface ImageMessageChange {
  text: string;
  /** undefined 保持原样；null 清除此 swipe 的底部存储。 */
  tags?: string[] | null;
  extra?: MessageExtraUpdate[];
}

/** 所有槽位写入共用宿主身份检查、保存、失败回滚与渲染事件。 */
export function applyImageMessage(
  floor: number,
  build: (text: string, message: STMessage) => ImageMessageChange | null,
  chatId: string,
  swipeId: number | null,
  expected?: STMessage,
) {
  let change: ImageMessageChange | null = null;
  return applyMessageText(floor, (text, message) => {
    change = build(text, message);
    return change?.text ?? null;
  }, chatId, swipeId, expected, message => {
    if (!change) return null;
    return [...(change.extra ?? []), ...(change.tags !== undefined ? [imageSlotsUpdate(message, change.tags)] : [])];
  });
}
