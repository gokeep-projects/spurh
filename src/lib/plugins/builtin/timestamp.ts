import type { PluginResult, SpurhPlugin } from '../types';

function parseTimestamp(input: string, unit: string): Date {
  const value = input.trim();
  if (!/^-?\d+(\.\d+)?$/.test(value)) throw new Error('请输入 Unix 时间戳数字');
  const number = Number(value);
  const milliseconds = unit === 'seconds'
    ? number * 1000
    : unit === 'milliseconds'
      ? number
      : Math.abs(number) < 100_000_000_000 ? number * 1000 : number;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) throw new Error('时间戳超出可转换范围');
  return date;
}

function parseDate(input: string): Date {
  const value = input.trim();
  if (!value) throw new Error('请输入日期时间，例如 2026-07-29 10:30:00');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('无法识别该日期时间，请使用 YYYY-MM-DD HH:mm:ss 或 ISO 8601');
  return date;
}

function localTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

export const timestampPlugin: SpurhPlugin = {
  id: 'spurh.timestamp',
  name: '时间戳转换',
  description: 'Unix 时间戳、日期与当前时间双向转换',
  icon: 'T',
  version: '0.1.0',
  category: '开发',
  priority: 92,
  actions: [
    { id: 'to-date', label: '时间戳 → 日期', description: '把秒或毫秒时间戳转换为日期' },
    { id: 'to-unix', label: '日期 → 时间戳', description: '把日期时间转换为 Unix 秒和毫秒' },
    { id: 'now', label: '当前时间', description: '生成当前时间信息' },
  ],
  options: [
    {
      id: 'unit', label: '输入单位', type: 'select', defaultValue: 'auto', actions: ['to-date'],
      choices: [
        { value: 'auto', label: '自动识别' },
        { value: 'seconds', label: '秒' },
        { value: 'milliseconds', label: '毫秒' },
      ],
    },
  ],
  detect(input) {
    const value = input.trim();
    if (/^\d{10}$/.test(value)) return { confidence: 0.93, reason: '检测到 10 位 Unix 秒时间戳' };
    if (/^\d{13}$/.test(value)) return { confidence: 0.96, reason: '检测到 13 位毫秒时间戳' };
    if (/^\d{4}-\d{1,2}-\d{1,2}[T\s]/.test(value)) return { confidence: 0.84, reason: '检测到日期时间' };
    return null;
  },
  execute(actionId, input, options = {}): PluginResult {
    const date = actionId === 'now'
      ? new Date()
      : actionId === 'to-unix'
        ? parseDate(input)
        : parseTimestamp(input, options.unit || 'auto');
    const result = {
      local: localTime(date),
      utc: date.toISOString(),
      unixSeconds: Math.floor(date.getTime() / 1000),
      unixMilliseconds: date.getTime(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    return {
      output: JSON.stringify(result, null, 2),
      language: 'json',
      view: 'timestamp',
      data: result,
      summary: actionId === 'now' ? '已生成当前时间' : actionId === 'to-unix' ? '日期已转换为时间戳' : '时间戳已转换为日期',
      meta: { 时区: result.timezone, Unix秒: result.unixSeconds },
    };
  },
};
