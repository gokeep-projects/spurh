import { describe, expect, it } from 'vitest';
import { trimImageHistory, type ClipItem } from './clipHistory';

const textItem = (id: string): ClipItem => ({ id, text: 'hello', ts: 1 });
const imageItem = (id: string, approxBytes: number): ClipItem => {
  // base64 字符数 = ceil(bytes/3)*4，按 0.75 换算回近似原始字节数
  const b64 = 'A'.repeat(Math.ceil(approxBytes / 3) * 4);
  return { id, text: '', ts: 1, kind: 'image', image: 'data:image/png;base64,' + b64 };
};

describe('trimImageHistory', () => {
  it('保留预算内的图片', () => {
    const items = [imageItem('a', 400), imageItem('b', 400)];
    expect(trimImageHistory(items, 1000).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('超出预算时从最旧开始丢弃图片', () => {
    const items = [imageItem('a', 600), imageItem('b', 600), imageItem('c', 600)];
    expect(trimImageHistory(items, 1000).map((i) => i.id)).toEqual(['a']);
  });

  it('单张超大图片直接丢弃', () => {
    expect(trimImageHistory([imageItem('huge', 2000)], 1000)).toEqual([]);
  });

  it('刚好等于预算的图片保留', () => {
    expect(trimImageHistory([imageItem('edge', 950)], 1000).map((i) => i.id)).toEqual(['edge']);
  });

  it('文本条目不受图片预算限制', () => {
    const items: ClipItem[] = [];
    for (let i = 0; i < 300; i++) items.push(textItem('t' + i));
    expect(trimImageHistory(items, 100).length).toBe(300);
  });

  it('混合列表：图片超预算被丢、文本保留', () => {
    const items = [imageItem('a', 900), textItem('t1'), imageItem('b', 900)];
    expect(trimImageHistory(items, 1000).map((i) => i.id)).toEqual(['a', 't1']);
  });
});
