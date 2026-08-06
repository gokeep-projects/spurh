// @vitest-environment jsdom
import { render } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import ResultView from './ResultView.svelte';
import type { PluginResult } from '../plugins';

describe('ResultView 结果渲染（DOM 可见性）', () => {
  it('json 格式化结果（view=code）渲染出 JSON 树内容', () => {
    const result: PluginResult = {
      output: '{\n  "name": "spurh",\n  "native": true,\n  "version": "0.1.0"\n}',
      language: 'json',
      view: 'code',
      summary: '已格式化 JSON',
      meta: { 格式: 'JSON' },
    };
    const { container } = render(ResultView, { props: { result } });
    const text = container.textContent ?? '';
    expect(text).toContain('spurh');
    expect(text).toContain('name');
    expect(text).toContain('version');
  });

  it('纯文本结果（view=text）渲染出原文', () => {
    const result: PluginResult = {
      output: 'hello world 你好 Spurh',
      language: 'text',
      view: 'text',
      summary: '文本结果',
    };
    const { container } = render(ResultView, { props: { result } });
    expect(container.textContent).toContain('hello world 你好 Spurh');
  });

  it('列表结果（view=list）渲染出条目', () => {
    const result: PluginResult = {
      output: 'a\nb',
      language: 'text',
      view: 'list',
      summary: '2 项',
      data: ['a', 'b'],
    };
    const { container } = render(ResultView, { props: { result } });
    const text = container.textContent ?? '';
    expect(text).toContain('a');
    expect(text).toContain('b');
  });

  it('统计结果（view=stats）渲染出键值', () => {
    const result: PluginResult = {
      output: '字符数: 3',
      language: 'text',
      view: 'stats',
      summary: '统计',
      data: { 字符数: 3, 单词数: 1 },
    };
    const { container } = render(ResultView, { props: { result } });
    const text = container.textContent ?? '';
    expect(text).toContain('字符数');
    expect(text).toContain('单词数');
  });

  it('时间戳结果（view=timestamp）渲染出时间值', () => {
    const result: PluginResult = {
      output: '1700000000',
      language: 'text',
      view: 'timestamp',
      summary: '时间转换',
      data: { local: '2023-11-15 02:13:20', utc: '2023-11-14T18:13:20Z', unixSeconds: '1700000000', unixMilliseconds: '1700000000000', timezone: '本地' },
    };
    const { container } = render(ResultView, { props: { result } });
    const text = container.textContent ?? '';
    expect(text).toContain('2023-11-15');
    expect(text).toContain('1700000000');
  });
});
