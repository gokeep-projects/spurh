import type { PluginResult, SpurhPlugin } from '../types';

const FIELD_NAMES = ['分钟', '小时', '日期', '月份', '星期'];

function describeField(value: string, unit: string): string {
  if (value === '*') return `每${unit}`;
  if (value.includes(',')) return `${unit}为 ${value.replaceAll(',', '、')}`;
  const step = value.match(/^\*\/(\d+)$/);
  if (step) return `每 ${step[1]} ${unit}`;
  const range = value.match(/^(\d+)-(\d+)$/);
  if (range) return `${unit}从 ${range[1]} 到 ${range[2]}`;
  return `${unit}为 ${value}`;
}

function explainCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('当前支持标准的 5 段 Cron 表达式');
  if (fields.some((field) => !/^[\d*/?,\-]+$/.test(field))) throw new Error('Cron 中包含不支持的字符');

  const [minute, hour, day, month, weekday] = fields;
  if (minute === '0' && hour === '*' && day === '*' && month === '*' && weekday === '*') return '每小时整点执行';
  if (minute === '0' && /^\*\/\d+$/.test(hour) && day === '*' && month === '*' && weekday === '*') return `每 ${hour.slice(2)} 小时执行一次（整点）`;
  if (/^\*\/\d+$/.test(minute) && hour === '*' && day === '*' && month === '*' && weekday === '*') return `每 ${minute.slice(2)} 分钟执行一次`;
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && day === '*' && month === '*' && weekday === '*') return `每天 ${hour.padStart(2, '0')}:${minute.padStart(2, '0')} 执行`;
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && weekday === '1-5') return `每个工作日 ${hour.padStart(2, '0')}:${minute.padStart(2, '0')} 执行`;
  return fields.map((field, index) => describeField(field, FIELD_NAMES[index])).join('；');
}

function matchesField(value: number, field: string): boolean {
  if (field === '*') return true;
  return field.split(',').some((part) => {
    const step = part.match(/^\*\/(\d+)$/);
    if (step) return value % Number(step[1]) === 0;
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) return value >= Number(range[1]) && value <= Number(range[2]);
    return value === Number(part);
  });
}

function nextRuns(expression: string, count = 5): Date[] {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('当前支持标准的 5 段 Cron 表达式');
  const output: Date[] = [];
  const cursor = new Date();
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  for (let checked = 0; checked < 525_600 && output.length < count; checked++) {
    if (
      matchesField(cursor.getMinutes(), fields[0])
      && matchesField(cursor.getHours(), fields[1])
      && matchesField(cursor.getDate(), fields[2])
      && matchesField(cursor.getMonth() + 1, fields[3])
      && matchesField(cursor.getDay(), fields[4])
    ) output.push(new Date(cursor));
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return output;
}

function parseTime(value: string): [string, string] {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('时间请输入 HH:mm，例如 09:30');
  return [String(Number(match[2])), String(Number(match[1]))];
}

function generateCron(input: string, options: Record<string, string>): string {
  const type = options.scheduleType || 'natural';
  if (type === 'minutes') {
    const interval = Number(options.interval || 5);
    if (!Number.isInteger(interval) || interval < 1 || interval > 59) throw new Error('分钟间隔请输入 1 到 59');
    return `*/${interval} * * * *`;
  }
  if (type === 'hourly') return '0 * * * *';
  if (['daily', 'workdays', 'weekly', 'monthly'].includes(type)) {
    const [minute, hour] = parseTime(options.time || '09:00');
    if (type === 'daily') return `${minute} ${hour} * * *`;
    if (type === 'workdays') return `${minute} ${hour} * * 1-5`;
    if (type === 'weekly') return `${minute} ${hour} * * ${options.weekday || '1'}`;
    const day = Number(options.monthDay || 1);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('每月日期请输入 1 到 31');
    return `${minute} ${hour} ${day} * *`;
  }

  const value = input.trim();
  let match = value.match(/^每\s*(\d+)\s*分钟/);
  if (match) return `*/${match[1]} * * * *`;
  if (/每小时/.test(value)) return '0 * * * *';
  match = value.match(/^每天\s*(\d{1,2}):(\d{2})/);
  if (match) return `${Number(match[2])} ${Number(match[1])} * * *`;
  match = value.match(/^工作日\s*(\d{1,2}):(\d{2})/);
  if (match) return `${Number(match[2])} ${Number(match[1])} * * 1-5`;
  throw new Error('暂未识别这段调度描述，可选择生成预设，或使用 AI 处理自然语言');
}

export const cronPlugin: SpurhPlugin = {
  id: 'spurh.cron',
  name: 'Cron 表达式',
  description: 'Cron 与中文调度描述双向转换',
  icon: '⌁',
  version: '0.1.0',
  category: '开发',
  priority: 80,
  actions: [
    { id: 'explain', label: 'Cron → 中文', description: '生成中文执行说明' },
    { id: 'generate', label: '中文 → Cron', description: '通过自然语言或预设生成表达式' },
    { id: 'next', label: '后续时间', description: '计算接下来 5 次执行时间' },
  ],
  options: [
    {
      id: 'scheduleType', label: '生成方式', type: 'select', defaultValue: 'natural', actions: ['generate'],
      choices: [
        { value: 'natural', label: '识别输入描述' }, { value: 'minutes', label: '每 N 分钟' },
        { value: 'hourly', label: '每小时' }, { value: 'daily', label: '每天' },
        { value: 'workdays', label: '工作日' }, { value: 'weekly', label: '每周' }, { value: 'monthly', label: '每月' },
      ],
    },
    { id: 'interval', label: '间隔', type: 'text', defaultValue: '5', actions: ['generate'], showWhen: { optionId: 'scheduleType', values: ['minutes'] } },
    { id: 'time', label: '时间', type: 'text', defaultValue: '09:00', actions: ['generate'], showWhen: { optionId: 'scheduleType', values: ['daily', 'workdays', 'weekly', 'monthly'] } },
    {
      id: 'weekday', label: '星期', type: 'select', defaultValue: '1', actions: ['generate'], showWhen: { optionId: 'scheduleType', values: ['weekly'] },
      choices: [
        { value: '1', label: '周一' }, { value: '2', label: '周二' }, { value: '3', label: '周三' }, { value: '4', label: '周四' },
        { value: '5', label: '周五' }, { value: '6', label: '周六' }, { value: '0', label: '周日' },
      ],
    },
    { id: 'monthDay', label: '日期', type: 'text', defaultValue: '1', actions: ['generate'], showWhen: { optionId: 'scheduleType', values: ['monthly'] } },
  ],
  detect(input) {
    const fields = input.trim().split(/\s+/);
    if (fields.length === 5 && fields.every((field) => /^[\d*/?,\-]+$/.test(field))) return { confidence: 0.95, reason: '检测到标准 5 段 Cron 表达式' };
    if (/^(每|工作日)/.test(input.trim())) return { confidence: 0.68, reason: '检测到中文调度描述' };
    return null;
  },
  execute(actionId, input, options = {}): PluginResult {
    if (actionId === 'generate') {
      const expression = generateCron(input, options);
      return {
        output: expression, language: 'text', view: 'text', summary: '已生成 Cron 表达式',
        meta: { 表达式: expression, 说明: explainCron(expression) },
      };
    }
    if (actionId === 'next') {
      const runs = nextRuns(input);
      return {
        output: runs.map((date, index) => `${index + 1}. ${date.toLocaleString('zh-CN', { hour12: false })}`).join('\n'),
        language: 'text', summary: '已计算接下来 5 次执行时间', meta: { 次数: runs.length, 表达式: input.trim() },
        view: 'list', data: runs.map((date) => date.toLocaleString('zh-CN', { hour12: false })),
      };
    }
    const explanation = explainCron(input);
    return { output: explanation, language: 'text', view: 'text', summary: 'Cron 表达式有效', meta: { 表达式: input.trim(), 字段: 5 } };
  },
};
