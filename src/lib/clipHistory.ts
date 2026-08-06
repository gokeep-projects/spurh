/** 剪贴板历史条目 */
export type ClipItem = { id: string; text: string; ts: number; kind?: 'image'; image?: string };

/** 剪贴板图片历史总内存预算：base64 数据按 4/3 换算回字节，超出时从最旧开始丢弃 */
export const IMAGE_HISTORY_BUDGET_BYTES = 24 * 1024 * 1024;

export function trimImageHistory(items: ClipItem[], budgetBytes: number = IMAGE_HISTORY_BUDGET_BYTES): ClipItem[] {
  let total = 0;
  const kept: ClipItem[] = [];
  for (const item of items) {
    if (item.kind === 'image' && item.image) {
      const bytes = Math.ceil(item.image.length * 0.75);
      if (total + bytes > budgetBytes) continue;
      total += bytes;
    }
    kept.push(item);
  }
  return kept;
}
