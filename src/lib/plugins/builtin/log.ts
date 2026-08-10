import { TOOL_ICONS as ICONS } from '../../icons';
import type { PluginResult, SpurhPlugin } from '../types';

export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | '';
export type LogEntry = {
  line: number;
  time?: string;
  level: LogLevel;
  message: string;
  source?: string;
  stack?: string[];
  raw: string;
};
export type LogAnalysis = {
  format: 'json' | 'common' | 'stack' | 'mixed' | 'unknown';
  entries: LogEntry[];
  counts: Partial<Record<LogLevel, number>>;
  topSources: Array<{ source: string; count: number }>;
  rootCause: string | null;
};

const LEVELS: LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
const LEVEL_ALIASES: Record<string, LogLevel> = {
  TRACE: 'TRACE', DEBUG: 'DEBUG', INFO: 'INFO', NOTICE: 'INFO',
  WARN: 'WARN', WARNING: 'WARN', ERROR: 'ERROR', ERR: 'ERROR',
  FATAL: 'FATAL', CRITICAL: 'FATAL', SEVERE: 'ERROR', ALERT: 'FATAL', EMERG: 'FATAL',
};

const TIME_RE = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?|\d{4}-\d{2}-\d{2})/;
const LEVEL_RE = /\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|ERR|FATAL|CRITICAL|SEVERE|NOTICE)\b/i;

function detectLevel(text: string): LogLevel {
  const match = text.match(LEVEL_RE);
  if (!match) return '';
  return LEVEL_ALIASES[match[1].toUpperCase()] ?? '';
}

function parseTime(text: string): string | undefined {
  const match = text.match(TIME_RE);
  return match ? match[1] : undefined;
}

function jsonEntry(raw: string, line: number, value: unknown): LogEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const hasLevel = 'level' in record || 'severity' in record || 'lvl' in record;
  const hasMessage = 'msg' in record || 'message' in record || 'messageText' in record;
  const hasTime = 'time' in record || 'ts' in record || 'timestamp' in record || '@timestamp' in record;
  if (!hasLevel && !(hasMessage && hasTime)) return null;
  const levelText = String(record.level ?? record.severity ?? record.lvl ?? '');
  const level = LEVEL_ALIASES[levelText.toUpperCase()] ?? '';
  const timeValue = record.time ?? record.ts ?? record.timestamp ?? record['@timestamp'];
  const time = timeValue ? formatIsoTime(timeValue) : undefined;
  const message = String(record.msg ?? record.message ?? record.messageText ?? record.error ?? record.exception ?? '');
  const source = typeof record.logger === 'string' ? record.logger : typeof record.source === 'string' ? record.source : undefined;
  return { line, time, level, message, source, raw };
}

function formatIsoTime(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  // 秒级数字时间戳（10 位）与毫秒（13 位）均支持
  const numeric = typeof value === 'number' ? (Math.abs(value) < 1e12 ? value * 1000 : value) : NaN;
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace('T', ' ').slice(0, 23);
}

const STACK_LINE_RE = /^\s*(at |in |from |Caused by:|File ".+", line \d+|\w+(?:Error|Exception):|Traceback \(most recent call last\):|\.\.\. \d+ more)/;

function commonEntry(raw: string, line: number): LogEntry | null {
  const time = parseTime(raw);
  const level = detectLevel(raw);
  const rest = raw.replace(TIME_RE, '').trim();
  let source: string | undefined;
  let message = rest.replace(LEVEL_RE, '').trim();
  const bracket = message.match(/^\[([^\]\s][^\]]*)\]/);
  if (bracket) {
    source = bracket[1];
    message = message.slice(bracket[0].length).trim();
  } else {
    const logger = message.match(/^([A-Za-z_][\w.:-]*)\s*/);
    if (logger && (level || time)) {
      source = logger[1];
      message = message.slice(logger[0].length).trim();
    }
  }
  if (!time && !level && !source && !STACK_LINE_RE.test(raw)) return null;
  return { line, time, level, message: message || (time || level ? '' : raw.trim()), source, raw };
}

export function analyzeLogs(input: string): LogAnalysis {
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  const entries: LogEntry[] = [];
  let jsonCount = 0;
  let commonCount = 0;
  let stackCount = 0;

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed) continue;

    let entry: LogEntry | null = null;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        entry = jsonEntry(trimmed, index + 1, parsed);
        if (entry) jsonCount++;
      } catch { /* not JSON */ }
    }
    if (!entry && STACK_LINE_RE.test(trimmed)) {
      stackCount++;
      const previous = entries[entries.length - 1];
      if (previous && previous.level === 'ERROR' && !previous.stack) {
        previous.stack = [trimmed];
        continue;
      }
      if (previous && previous.stack) {
        previous.stack.push(trimmed);
        continue;
      }
      entry = { line: index + 1, level: 'ERROR', message: trimmed, raw };
    }
    if (!entry) {
      entry = commonEntry(raw, index + 1);
      if (entry) commonCount++;
    }
    if (entry) entries.push(entry);
  }

  // 把相邻的堆栈行合并到前一条 ERROR
  const merged: LogEntry[] = [];
  for (const entry of entries) {
    if (entry.stack && entry.level !== 'ERROR') {
      const previous = merged[merged.length - 1];
      if (previous && previous.level === 'ERROR' && !previous.stack) {
        previous.stack = entry.stack;
        continue;
      }
    }
    merged.push(entry);
  }

  const counts: Partial<Record<LogLevel, number>> = {};
  for (const level of LEVELS) counts[level] = 0;
  const sourceMap = new Map<string, number>();
  for (const entry of merged) {
    if (entry.level) counts[entry.level] = (counts[entry.level] ?? 0) + 1;
    if (entry.source) sourceMap.set(entry.source, (sourceMap.get(entry.source) ?? 0) + 1);
  }
  const topSources = [...sourceMap.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 5);

  let rootCause: string | null = null;
  for (const entry of merged) {
    const text = entry.message + (entry.stack ?? []).join('\n');
    const causedBy = [...text.matchAll(/Caused by:\s*(.+)/g)].pop();
    if (causedBy) {
      rootCause = causedBy[1].trim();
      continue;
    }
    const error = text.match(/^\s*([\w.$]*(?:Error|Exception|Fatal)[^:\n]*)[:：]\s*(.+)$/m);
    if (error) rootCause = `${error[1]}: ${error[2].trim()}`;
  }

  const format: LogAnalysis['format'] = jsonCount > 0 && jsonCount >= commonCount
    ? (stackCount > 0 ? 'mixed' : 'json')
    : stackCount > 0 && commonCount === 0 && jsonCount === 0 ? 'stack'
    : commonCount > 0 ? 'common' : 'unknown';

  return { format, entries: merged, counts, topSources, rootCause };
}

export const logPlugin: SpurhPlugin = {
  id: 'spurh.log',
  name: '日志分析',
  description: '识别时间/级别/字段，过滤与根因定位',
  icon: ICONS['spurh.log'],
  version: '0.1.0',
  category: '开发',
  priority: 60,
  actions: [{ id: 'analyze', label: '分析', description: '解析日志结构与错误根因' }],
  options: [
    {
      id: 'aiPrompt', label: 'AI 提示语', type: 'text', defaultValue: '分析这些日志：指出错误根因、受影响模块和修复建议，用中文简洁回答。',
      placeholder: '可自定义 AI 分析要求',
    },
  ],
  detect(input) {
    const lines = input.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length === 0 || lines.length > 2000) return null;
    let score = 0;
    let sampled = 0;
    let hasTime = false;
    for (const line of lines.slice(0, 40)) {
      sampled++;
      const trimmed = line.trim();
      if (LEVEL_RE.test(trimmed) && TIME_RE.test(trimmed)) { score += 1; hasTime = true; }
      else if (LEVEL_RE.test(trimmed)) score += 0.6;
      else if (STACK_LINE_RE.test(trimmed)) score += 0.8;
      else if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object' && ('level' in parsed || ('msg' in parsed && ('time' in parsed || 'ts' in parsed)))) score += 0.9;
        } catch { /* ignore */ }
      }
    }
    if (score === 0) return null;
    const ratio = score / sampled;
    const confidence = Math.min(0.9, 0.35 + ratio * 0.55);
    // 无时间戳的文本（如单句 "There is an error in your code"）最多 0.35 置信度，不触发自动路由
    return {
      confidence: hasTime ? confidence : Math.min(0.35, confidence),
      reason: `${lines.length} 行内容符合日志特征`,
    };
  },
  execute(actionId, input): PluginResult {
    if (actionId !== 'analyze') throw new Error('未知操作');
    const analysis = analyzeLogs(input);
    const total = analysis.entries.length;
    const errorCount = (analysis.counts.ERROR ?? 0) + (analysis.counts.FATAL ?? 0);
    const summary = `${total} 条记录${errorCount ? ` · ${errorCount} 条错误` : ''} · ${analysis.format.toUpperCase()} 格式`;
    return {
      output: analysis.rootCause ?? summary,
      language: 'text',
      view: 'log',
      data: { ...analysis, lines: input.split(/\r?\n/).length, parsed: analysis.entries.length },
      summary,
      meta: {
        格式: analysis.format.toUpperCase(),
        记录数: total,
        错误: errorCount || 0,
        ...(analysis.rootCause ? { 根因: analysis.rootCause.slice(0, 80) } : {}),
      },
    };
  },
};
