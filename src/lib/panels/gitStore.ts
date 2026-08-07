// Git 面板的跨组件共享状态（无 runes 依赖的轻量模块）：
// 外部（App 拖放 / 右键菜单）识别到仓库后通过 setPendingRepo 通知面板自动打开；
// 最近打开列表持久化在 localStorage，由面板自行管理展示状态。
const RECENT_KEY = 'spurh.git.recent';
const MAX_RECENT = 8;

let pending: string | null = null;

export function setPendingRepo(path: string | null): void {
  pending = path;
}

/** 面板挂载时取走待打开仓库并清空 */
export function takePendingRepo(): string | null {
  const value = pending;
  pending = null;
  return value;
}

export function getRecentRepos(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function rememberRepo(path: string): string[] {
  const trimmed = path.trim();
  const next = trimmed ? [trimmed, ...getRecentRepos().filter((r) => r !== trimmed)].slice(0, MAX_RECENT) : getRecentRepos();
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

export function forgetRepo(path: string): string[] {
  const next = getRecentRepos().filter((r) => r !== path);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

export function clearRecentRepos(): string[] {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    /* ignore */
  }
  return [];
}
