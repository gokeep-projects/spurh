import type { PluginResult, SpurhPlugin } from '../types';

function matchesField(value: number, field: string): boolean {
  if (field === '*' || field === '?') return true;
  return field.split(',').some((part) => {
    const step = part.match(/^\*\/(\d+)$/);
    if (step) return value % Number(step[1]) === 0;
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) return value >= Number(range[1]) && value <= Number(range[2]);
    return String(value) === part;
  });
}

function nextRuns(expr: string, count = 10): Date[] {
  const f = expr.trim().split(/\s+/);
  if (f.length === 6) f.shift();
  if (f.length !== 5) throw new Error('需要5段Cron');
  const out: Date[] = [];
  const cur = new Date();
  cur.setSeconds(0, 0); cur.setMinutes(cur.getMinutes() + 1);
  for (let n = 0; n < 525600 && out.length < count; n++) {
    if (matchesField(cur.getMinutes(),f[0]) && matchesField(cur.getHours(),f[1])
      && matchesField(cur.getDate(),f[2]) && matchesField(cur.getMonth()+1,f[3])
      && matchesField(cur.getDay(),f[4])) out.push(new Date(cur));
    cur.setMinutes(cur.getMinutes() + 1);
  }
  return out;
}

function explainCron(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length === 6) f.shift();
  if (f.length !== 5) throw new Error('需要5段Cron');
  const [m, h, d, mo, w] = f;
  if (m === '0' && h === '*' && d === '*' && mo === '*' && w === '*') return '每小时整点';
  if (/^\*\/\d+$/.test(h) && d === '*' && mo === '*' && w === '*') return `每${h.slice(2)}小时`;
  if (/^\*\/\d+$/.test(m) && h === '*' && d === '*' && mo === '*' && w === '*') return `每${m.slice(2)}分钟`;
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && d === '*' && mo === '*' && w === '*') return `每天${h.padStart(2,'0')}:${m.padStart(2,'0')}`;
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && d === '*' && mo === '*' && w === '1-5') return `工作日${h.padStart(2,'0')}:${m.padStart(2,'0')}`;
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && /^\d+$/.test(d) && mo === '*' && w === '*') return `每月${d}号${h.padStart(2,'0')}:${m.padStart(2,'0')}`;
  return `分:${m} 时:${h} 日:${d} 月:${mo} 周:${w}`;
}

const H = Array.from({length:24},(_,i)=>String(i).padStart(2,'0'));
const M = Array.from({length:60},(_,i)=>String(i).padStart(2,'0'));
const D = Array.from({length:31},(_,i)=>String(i+1));

export const cronPlugin: SpurhPlugin = {
  id: 'spurh.cron', name: 'Cron 表达式', description: '下拉选择条件生成 Cron，查看执行时间', icon: '⌁', version:'0.1.0', category:'开发', priority:80,
  actions: [
    { id: 'generate', label: '生成', description: '选择条件生成Cron' },
    { id: 'explain', label: '解析', description: '解读已有Cron' },
    { id: 'next', label: '执行时间', description: '未来10次' },
  ],
  options: [
    { id: 'type', label: '频率', type:'select', defaultValue:'daily', actions:['generate'], choices:[
      {value:'minutes',label:'每N分钟'},{value:'hourly',label:'每小时'},{value:'daily',label:'每天'},
      {value:'workdays',label:'工作日'},{value:'weekly',label:'每周'},{value:'monthly',label:'每月'},
    ]},
    { id: 'interval', label: '间隔', type:'select', defaultValue:'5', actions:['generate'], showWhen:{optionId:'type',values:['minutes']},
      choices: Array.from({length:59},(_,i)=>({value:String(i+1),label: `${i+1} 分钟`})) },
    { id: 'hour', label: '时', type:'select', defaultValue:'09', actions:['generate'], showWhen:{optionId:'type',values:['daily','workdays','weekly','monthly']},
      choices: H.map(v=>({value:v,label:`${v} 时`})) },
    { id: 'minute', label: '分', type:'select', defaultValue:'00', actions:['generate'], showWhen:{optionId:'type',values:['daily','workdays','weekly','monthly']},
      choices: M.map(v=>({value:v,label:`${v} 分`})) },
    { id: 'weekday', label: '星期', type:'select', defaultValue:'1', actions:['generate'], showWhen:{optionId:'type',values:['weekly']},
      choices: [{v:'0',l:'周日'},{v:'1',l:'周一'},{v:'2',l:'周二'},{v:'3',l:'周三'},{v:'4',l:'周四'},{v:'5',l:'周五'},{v:'6',l:'周六'}].map(x=>({value:x.v,label:x.l})) },
    { id: 'monthDay', label: '日期', type:'select', defaultValue:'1', actions:['generate'], showWhen:{optionId:'type',values:['monthly']},
      choices: D.map(v=>({value:v,label:`${v} 号`})) },
  ],
  detect(input) {
    const v = input.trim();
    const f = v.split(/\s+/);
    if ((f.length===5||f.length===6) && f.every(x=>/^[\d*/?,\-]+$/.test(x))) return { confidence:.96, reason:'Cron表达式' };
    return null;
  },
  execute(actionId, input, options = {}): PluginResult {
    let expr = input.trim();
    if (actionId === 'generate') {
      const t = options.type || 'daily';
      const h = options.hour || '09';
      const m = options.minute || '00';
      if (t === 'minutes') expr = `*/${options.interval||'5'} * * * *`;
      else if (t === 'hourly') expr = '0 * * * *';
      else if (t === 'daily') expr = `${Number(m)} ${Number(h)} * * *`;
      else if (t === 'workdays') expr = `${Number(m)} ${Number(h)} * * 1-5`;
      else if (t === 'weekly') expr = `${Number(m)} ${Number(h)} * * ${options.weekday||'1'}`;
      else if (t === 'monthly') expr = `${Number(m)} ${Number(h)} ${options.monthDay||'1'} * *`;
      const runs = nextRuns(expr, 5);
      return { output: `${expr}\n\n${explainCron(expr)}\n\n未来5次:\n${runs.map((d,i)=>`${i+1}. ${d.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}`).join('\n')}`, language:'text', summary:expr, meta:{表达式:expr, 说明:explainCron(expr)} };
    }
    if (actionId === 'next') {
      const runs = nextRuns(expr, 10);
      if (!runs.length) throw new Error('一年内无匹配');
      return { output: `${explainCron(expr)}\n\n未来10次:\n${runs.map((d,i)=>`${i+1}. ${d.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}`).join('\n')}`, language:'text', summary:`${runs.length}次`, meta:{表达式:expr} };
    }
    return { output: explainCron(expr), language:'text', summary:'Cron解析', meta:{表达式:expr} };
  },
};
