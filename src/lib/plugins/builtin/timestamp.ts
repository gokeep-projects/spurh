import { TOOL_ICONS as ICONS } from '../../icons';
import type { PluginResult, SpurhPlugin } from '../types';

export function localDatetimeValue(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

function parseTimestamp(input: string, unit: string): Date {
  const number = Number(input.trim());
  if (!Number.isFinite(number)) throw new Error('请输入有效数字');
  const ms = unit === 'seconds' ? number * 1000
    : unit === 'milliseconds' ? number
    : Math.abs(number) < 100_000_000_000 ? number * 1000 : number;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new Error('时间戳超出范围');
  return d;
}

function fmt(date: Date): string {
  const p = new Intl.DateTimeFormat('zh-CN', { year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false }).formatToParts(date);
  const m = Object.fromEntries(p.map(x => [x.type, x.value]));
  return `${m.year}-${m.month}-${m.day} ${m.hour}:${m.minute}:${m.second}`;
}

function toResult(date: Date, actionId: string): PluginResult {
  const r = { local: fmt(date), utc: date.toISOString(), unixSeconds: Math.floor(date.getTime()/1000), unixMilliseconds: date.getTime(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  return { output: JSON.stringify(r,null,2), language:'json', view:'timestamp', data:r, summary: actionId==='now'?'当前时间':actionId==='to-unix'?'日期→时间戳':'时间戳→日期', meta:{ 时区:r.timezone, Unix秒:r.unixSeconds, 毫秒:r.unixMilliseconds } };
}

export const timestampPlugin: SpurhPlugin = {
  id: 'spurh.timestamp', name: '时间戳转换', description: 'Unix 时间戳 ↔ 日期时间 双向转换', icon: ICONS['spurh.timestamp'], version:'0.1.0', category:'开发', priority:92,
  actions: [
    { id: 'now', label: '当前时间', description: '显示此刻的时间和对应时间戳' },
    { id: 'to-date', label: '时间戳→日期', description: '输入秒/毫秒时间戳转为日期' },
    { id: 'to-unix', label: '日期→时间戳', description: '选择日期时间转为 Unix 时间戳' },
  ],
  options: [
    { id: 'unit', label: '单位', type:'select', defaultValue:'auto', actions:['to-date'], choices:[{value:'auto',label:'自动'},{value:'seconds',label:'秒'},{value:'milliseconds',label:'毫秒'}] },
    { id: 'pickDateTime', label: '日期时间', type:'datetime', defaultValue: localDatetimeValue(), actions:['to-unix'], placeholder:'选择时间（默认当前时间）' },
  ],
  detect(input) {
    const v = input.trim();
    if (/^\d{10}$/.test(v)) return { confidence:.93, reason:'10位秒时间戳' };
    if (/^\d{13}$/.test(v)) return { confidence:.96, reason:'13位毫秒时间戳' };
    if (/^\d{4}-\d{1,2}-\d{1,2}/.test(v)) return { confidence:.84, reason:'日期时间' };
    return null;
  },
  execute(actionId, input, options = {}): PluginResult {
    if (actionId === 'now') return toResult(new Date(), actionId);
    if (actionId === 'to-unix') {
      const raw = (options.pickDateTime ?? '').trim();
      const dateStr = raw ? raw.replace('T', ' ') : (input.trim() || localDatetimeValue().replace('T', ' '));
      const date = new Date(dateStr);
      if (Number.isNaN(date.getTime())) throw new Error(`无法解析日期 "${dateStr}"，请用 YYYY-MM-DD HH:mm 格式`);
      return toResult(date, actionId);
    }
    return toResult(parseTimestamp(input, options.unit || 'auto'), actionId);
  },
};