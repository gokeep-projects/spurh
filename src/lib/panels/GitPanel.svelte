<script lang="ts">
  import { isTauri, safeInvoke } from '../env';
  import { TOOL_ICONS, UI_ICONS, iconHtml } from '../icons';
  import { takePendingRepo, getRecentRepos, rememberRepo, forgetRepo, clearRecentRepos } from './gitStore';

  type RepoInfo = {
    isRepo: boolean; root: string; currentBranch: string; upstream?: string | null;
    remoteUrl?: string | null; headSha?: string | null; headMessage?: string | null;
    isClean: boolean; branchCount: number;
  };
  type StatusEntry = { path: string; state: string; staged: boolean };
  type BranchInfo = { name: string; current: boolean; remote: boolean; upstream?: string | null };
  type CommitInfo = { sha: string; short: string; message: string; author: string; email: string; time: number; refs: string[] };
  type DiffLine = { kind: string; text: string; oldLine?: number | null; newLine?: number | null };
  type Hunk = { header: string; lines: DiffLine[] };
  type DiffFile = { oldPath: string; newPath: string; status: string; additions: number; deletions: number; hunks: Hunk[] };
  type GitTab = 'changes' | 'branches' | 'history';

  const fmtTime = (sec: number): string =>
    new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false });
  const shortSha = (sha: string): string => sha.slice(0, 8);

  let repoPath = $state('');
  let info = $state<RepoInfo | null>(null);
  let statuses = $state<StatusEntry[]>([]);
  let branches = $state<BranchInfo[]>([]);
  let commits = $state<CommitInfo[]>([]);
  let selectedFile = $state<string | null>(null);
  let workdirDiff = $state<DiffFile[]>([]);
  let selectedCommit = $state<string | null>(null);
  let commitDiff = $state<DiffFile[]>([]);
  let tab = $state<GitTab>('changes');
  let busy = $state(false);
  let error = $state('');
  let notice = $state('');
  let token = $state('');
  let commitMsg = $state('');
  let branchName = $state('');
  let showToken = $state(false);
  let browserMode = $state(!isTauri);
  let recentRepos = $state<string[]>(getRecentRepos());

  function flash(msg: string): void {
    notice = msg;
    setTimeout(() => { if (notice === msg) notice = ''; }, 3500);
  }

  async function openRepo(p?: string): Promise<void> {
    error = '';
    let target = p ?? repoPath.trim();
    if (!target) {
      try {
        target = (await safeInvoke<string>('pick_folder')) ?? '';
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        return;
      }
      if (!target) return;
    }
    repoPath = target;
    const ok = await refreshAll();
    if (ok && info?.isRepo) recentRepos = rememberRepo(info.root || target);
  }

  async function refreshAll(): Promise<boolean> {
    if (!repoPath.trim()) return false;
    busy = true;
    error = '';
    try {
      const [repo, st, br, lg] = await Promise.all([
        safeInvoke<RepoInfo>('git_open', { path: repoPath }),
        safeInvoke<StatusEntry[]>('git_status', { path: repoPath }),
        safeInvoke<BranchInfo[]>('git_branches', { path: repoPath }),
        safeInvoke<CommitInfo[]>('git_log', { path: repoPath, count: 60 }),
      ]);
      info = repo;
      statuses = st;
      branches = br;
      commits = lg;
      selectedFile = null;
      workdirDiff = [];
      selectedCommit = null;
      commitDiff = [];
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      return false;
    } finally {
      busy = false;
    }
    return Boolean(info?.isRepo);
  }

  async function selectFile(path: string): Promise<void> {
    selectedFile = path;
    commitDiff = [];
    selectedCommit = null;
    try {
      workdirDiff = await safeInvoke<DiffFile[]>('git_diff_workdir', { path: repoPath });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function stage(files: string[]): Promise<void> {
    if (!files.length) return;
    try {
      await safeInvoke('git_stage', { path: repoPath, files });
      const [st, diffs] = await Promise.all([
        safeInvoke<StatusEntry[]>('git_status', { path: repoPath }),
        selectedFile ? safeInvoke<DiffFile[]>('git_diff_workdir', { path: repoPath }) : Promise.resolve([]),
      ]);
      statuses = st;
      if (selectedFile) workdirDiff = diffs;
      flash(`已暂存 ${files.length} 个文件`);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function unstage(files: string[]): Promise<void> {
    if (!files.length) return;
    try {
      await safeInvoke('git_unstage', { path: repoPath, files });
      const [st, diffs] = await Promise.all([
        safeInvoke<StatusEntry[]>('git_status', { path: repoPath }),
        selectedFile ? safeInvoke<DiffFile[]>('git_diff_workdir', { path: repoPath }) : Promise.resolve([]),
      ]);
      statuses = st;
      if (selectedFile) workdirDiff = diffs;
      flash(`已取消暂存 ${files.length} 个文件`);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function discard(files: string[]): Promise<void> {
    if (!files.length) return;
    const ok = confirm(`确定丢弃 ${files.length} 个文件的改动吗？此操作不可恢复。`);
    if (!ok) return;
    try {
      await safeInvoke('git_discard', { path: repoPath, files });
      await refreshAll();
      flash('已丢弃改动');
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function doPull(): Promise<void> {
    try {
      const msg = await safeInvoke<string>('git_pull', { path: repoPath, token: token.trim() || null });
      flash(msg);
      await refreshAll();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function doPush(): Promise<void> {
    try {
      const msg = await safeInvoke<string>('git_push', { path: repoPath, token: token.trim() || null });
      flash(msg);
      await refreshAll();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function doCommit(): Promise<void> {
    if (!commitMsg.trim()) { error = '请填写提交信息'; return; }
    try {
      const sha = await safeInvoke<string>('git_commit', { path: repoPath, message: commitMsg, name: null, email: null });
      commitMsg = '';
      flash(`已提交 ${shortSha(sha)}`);
      await refreshAll();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function doCreateBranch(): Promise<void> {
    const name = branchName.trim();
    if (!name) { error = '请填写分支名'; return; }
    try {
      await safeInvoke('git_create_branch', { path: repoPath, name });
      branchName = '';
      flash(`已创建并切换到 ${name}`);
      await refreshAll();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function checkoutBranch(branch: BranchInfo): Promise<void> {
    try {
      await safeInvoke('git_checkout', { path: repoPath, branch: branch.name, remote: branch.remote });
      flash(`已切换到 ${branch.name}`);
      await refreshAll();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function showCommit(sha: string): Promise<void> {
    selectedCommit = sha;
    workdirDiff = [];
    selectedFile = null;
    try {
      commitDiff = await safeInvoke<DiffFile[]>('git_diff_commit', { path: repoPath, sha });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  const changedCount = $derived(statuses.length);
  const stagedCount = $derived(statuses.filter((s) => s.staged).length);
  const selectedDiff = $derived(
    selectedFile ? workdirDiff.find((d) => d.newPath === selectedFile || d.oldPath === selectedFile) : null,
  );
  const clean = $derived(Boolean(info?.isClean));

  // 外部识别到仓库（拖放 / 右键菜单）→ 自动打开；否则恢复上次打开的仓库
  let initialized = false;
  $effect(() => {
    if (initialized) return;
    initialized = true;
    const pending = takePendingRepo();
    if (pending) {
      openRepo(pending);
      return;
    }
    if (!browserMode && recentRepos.length) openRepo(recentRepos[0]);
  });
</script>

<div class="git-panel">
  <header class="git-bar">
    <div class="git-bar-id">
      <span class="git-bar-ico">{@html iconHtml(TOOL_ICONS['spurh.git'])}</span>
      <span class="git-bar-title">Git 仓库</span>
    </div>
    <div class="git-bar-path">
      <span class="git-path-ico">{@html iconHtml(UI_ICONS.search)}</span>
      <input
        type="text"
        placeholder="输入或粘贴仓库路径，回车打开"
        bind:value={repoPath}
        onkeydown={(e) => { if (e.key === 'Enter') openRepo(); }}
      />
      <button class="git-btn ghost" onclick={() => openRepo()} title="浏览本地文件夹" disabled={busy}>浏览…</button>
      <button class="git-btn ghost" onclick={refreshAll} title="刷新" disabled={busy || !repoPath.trim()}>刷新</button>
    </div>
  </header>

  {#if browserMode}
    <div class="git-empty">
      <p>浏览器预览模式无法调用本机 Git 能力。</p>
      <p>请运行 <code>npm run tauri dev</code> 以使用 Git 仓库工作台。</p>
    </div>
  {:else if !info}
    <div class="git-empty">
      <button class="git-btn primary big" onclick={() => openRepo()}>打开 Git 仓库</button>
      <p class="git-empty-hint">选择本地任意 Git 项目文件夹，即可查看分支、文件变更、提交历史并执行拉取 / 推送 / 提交。</p>
      {#if recentRepos.length}
        <div class="git-recent">
          <div class="git-recent-head">
            <span>最近打开</span>
            <button class="git-btn xs" onclick={() => (recentRepos = clearRecentRepos())}>清空记录</button>
          </div>
          {#each recentRepos as r (r)}
            <button class="git-recent-row" title={r} onclick={() => openRepo(r)}>
              <span class="git-branch-ico">{@html iconHtml(TOOL_ICONS['spurh.git'])}</span>
              <span class="git-recent-path">{r}</span>
              <span class="git-recent-x" role="button" tabindex="-1"
                onclick={(e) => { e.stopPropagation(); recentRepos = forgetRepo(r); }}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); recentRepos = forgetRepo(r); } }}>×</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <div class="git-repo">
      <div class="git-repo-info">
        <span class="git-chip" class:ok={clean} title="工作区状态">
          <i class="git-dot"></i>{clean ? '干净' : `${changedCount} 处变更`}
        </span>
        <span class="git-chip" title="当前分支"><b class="git-chip-key">分支</b> {info.currentBranch}</span>
        {#if info.upstream}
          <span class="git-chip" title="上游分支"><b class="git-chip-key">上游</b> {info.upstream}</span>
        {/if}
        {#if info.remoteUrl}
          <span class="git-chip" title="远程仓库"><b class="git-chip-key">远程</b> {info.remoteUrl}</span>
        {/if}
        {#if info.headSha}
          <span class="git-chip" title={info.headMessage ?? ''}><b class="git-chip-key">HEAD</b> {shortSha(info.headSha)} {info.headMessage}</span>
        {/if}
        <span class="git-chip"><b class="git-chip-key">本地分支</b> {info.branchCount}</span>
      </div>

      <div class="git-actions">
        <div class="git-commit-box">
          <input
            type="text"
            placeholder="提交信息（Ctrl+Enter 提交）"
            bind:value={commitMsg}
            onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doCommit(); }}
          />
          <button class="git-btn primary" onclick={doCommit} disabled={!commitMsg.trim()}>提交</button>
        </div>
        <div class="git-token-box" title="HTTPS 需要令牌时填写（SSH 免填）">
          <input
            type={showToken ? 'text' : 'password'}
            placeholder="访问令牌（HTTPS 推送/拉取用，可选）"
            bind:value={token}
          />
          <button class="git-btn ghost" onclick={() => (showToken = !showToken)} title="显示 / 隐藏令牌">
            {showToken ? '隐藏' : '显示'}
          </button>
        </div>
        <div class="git-remote-actions">
          <button class="git-btn ghost" onclick={doPull} disabled={busy || !info.remoteUrl}>拉取</button>
          <button class="git-btn primary" onclick={doPush} disabled={busy || !info.remoteUrl}>推送</button>
          <div class="git-branch-create">
            <input type="text" placeholder="新分支名" bind:value={branchName}
              onkeydown={(e) => { if (e.key === 'Enter') doCreateBranch(); }} />
            <button class="git-btn ghost" onclick={doCreateBranch} disabled={!branchName.trim()}>新建分支</button>
          </div>
        </div>
      </div>
    </div>
  {/if}

  {#if error}
    <div class="git-error"><span class="git-error-ico">⚠</span>{error}</div>
  {/if}
  {#if notice}
    <div class="git-notice">✓ {notice}</div>
  {/if}

  {#if info}
    <nav class="git-tabs">
      <button class:active={tab === 'changes'} onclick={() => (tab = 'changes')}>
        文件变更 {changedCount > 0 ? `(${changedCount})` : ''}
      </button>
      <button class:active={tab === 'branches'} onclick={() => (tab = 'branches')}>分支</button>
      <button class:active={tab === 'history'} onclick={() => (tab = 'history')}>提交历史</button>
    </nav>

    {#if tab === 'changes'}
      <div class="git-split">
        <aside class="git-files">
          <div class="git-files-head">
            <span>变更文件</span>
            <span class="git-files-count">{stagedCount} 已暂存 / {changedCount} 总数</span>
          </div>
          <div class="git-files-ops">
            <button class="git-btn xs" onclick={() => stage(statuses.map((s) => s.path))} disabled={!changedCount}>全部暂存</button>
            <button class="git-btn xs" onclick={() => unstage(statuses.filter((s) => s.staged).map((s) => s.path))} disabled={!stagedCount}>取消暂存</button>
            <button class="git-btn xs danger" onclick={() => discard(statuses.map((s) => s.path))} disabled={!changedCount}>全部丢弃</button>
          </div>
          <div class="git-files-list">
            {#if !statuses.length}
              <div class="git-files-empty">工作区干净，没有未提交的变更 🎉</div>
            {:else}
              {#each statuses as s (s.path)}
                <div class="git-file-row" class:selected={selectedFile === s.path}>
                  <button type="button" class="git-file-main" onclick={() => selectFile(s.path)}>
                    <span class="git-file-mark" class:staged={s.staged}>{s.staged ? '●' : '○'}</span>
                    <span class="git-file-path" title={s.path}>{s.path}</span>
                    <span class="git-file-state">{s.state}</span>
                  </button>
                  <span class="git-file-ops">
                    {#if !s.staged}
                      <button class="git-btn xs" onclick={() => stage([s.path])} title="暂存">+</button>
                    {:else}
                      <button class="git-btn xs" onclick={() => unstage([s.path])} title="取消暂存">−</button>
                    {/if}
                    <button class="git-btn xs danger" onclick={() => discard([s.path])} title="丢弃改动">×</button>
                  </span>
                </div>
              {/each}
            {/if}
          </div>
        </aside>
        <section class="git-diff">
          {#if selectedDiff}
            <div class="git-diff-head">
              <span class="git-diff-file">{selectedDiff.newPath || selectedDiff.oldPath}</span>
              <span class="git-diff-status">{selectedDiff.status}</span>
              <span class="git-diff-stats">
                <i class="add">+{selectedDiff.additions}</i>
                <i class="del">−{selectedDiff.deletions}</i>
              </span>
            </div>
            <div class="git-diff-body">
              {#each selectedDiff.hunks as hunk, hi (hi)}
                <div class="git-hunk-header">{hunk.header}</div>
                {#each hunk.lines as line, li (hi + '-' + li)}
                  <div class="git-line" class:add={line.kind === '+'} class:del={line.kind === '-'}>
                    <span class="git-line-no">{line.oldLine ?? ''}</span>
                    <span class="git-line-no">{line.newLine ?? ''}</span>
                    <span class="git-line-text">{line.text || ' '}</span>
                  </div>
                {/each}
              {/each}
            </div>
          {:else if selectedFile}
            <div class="git-diff-empty">该文件无差异内容（可能是纯二进制或重命名）。</div>
          {:else}
            <div class="git-diff-empty">← 选择一个变更文件查看差异</div>
          {/if}
        </section>
      </div>
    {:else if tab === 'branches'}
      <div class="git-branch-list">
        {#each branches as b (b.name)}
          <button class="git-branch-row" class:current={b.current} onclick={() => checkoutBranch(b)} title="点击切换">
            <span class="git-branch-ico">{@html iconHtml(b.remote ? UI_ICONS.grid : TOOL_ICONS['spurh.git'])}</span>
            <span class="git-branch-name">{b.name}</span>
            {#if b.current}<span class="git-branch-tag">当前</span>{/if}
            {#if b.upstream}<span class="git-branch-up">{b.upstream}</span>{/if}
          </button>
        {/each}
      </div>
    {:else}
      <div class="git-commit-list">
        {#each commits as c (c.sha)}
          <button class="git-commit-row" class:selected={selectedCommit === c.sha} onclick={() => showCommit(c.sha)}>
            <span class="git-commit-sha">{c.short}</span>
            <span class="git-commit-msg">{c.message}</span>
            <span class="git-commit-meta">
              {#if c.refs.length}<span class="git-refs">{c.refs.join(' ')}</span>{/if}
              <span class="git-commit-author">{c.author}</span>
              <span class="git-commit-time">{fmtTime(c.time)}</span>
            </span>
          </button>
        {/each}
        {#if !commits.length}
          <div class="git-files-empty">仓库还没有提交记录。</div>
        {/if}
      </div>
      {#if commitDiff.length}
        <div class="git-commit-diff">
          <div class="git-diff-head">
            <span class="git-diff-file">提交 {selectedCommit ? shortSha(selectedCommit) : ''} 的变更（{commitDiff.length} 个文件）</span>
          </div>
          <div class="git-diff-body">
            {#each commitDiff as f, fi (f.newPath || f.oldPath)}
              <div class="git-commit-file">
                <div class="git-diff-head">
                  <span class="git-diff-file">{f.newPath || f.oldPath}</span>
                  <span class="git-diff-status">{f.status}</span>
                  <span class="git-diff-stats"><i class="add">+{f.additions}</i><i class="del">−{f.deletions}</i></span>
                </div>
                {#each f.hunks as hunk, hi (fi + '-' + hi)}
                  <div class="git-hunk-header">{hunk.header}</div>
                  {#each hunk.lines as line, li (fi + '-' + hi + '-' + li)}
                    <div class="git-line" class:add={line.kind === '+'} class:del={line.kind === '-'}>
                      <span class="git-line-no">{line.oldLine ?? ''}</span>
                      <span class="git-line-no">{line.newLine ?? ''}</span>
                      <span class="git-line-text">{line.text || ' '}</span>
                    </div>
                  {/each}
                {/each}
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .git-panel { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; font-size: var(--fs-sm); }
  .git-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .git-bar-id { display: flex; align-items: center; gap: 7px; font-weight: 700; font-size: var(--fs-xs); }
  .git-bar-ico { color: var(--c-cyan); display: inline-flex; }
  .git-bar-ico :global(svg) { width: 17px; height: 17px; }
  .git-bar-path { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 260px; }
  .git-path-ico { color: var(--muted-2); display: inline-flex; }
  .git-path-ico :global(svg) { width: 13px; height: 13px; }
  .git-bar-path input {
    flex: 1; min-width: 120px; background: var(--bg2);
    border: 1px solid var(--line); border-radius: 8px;
    color: var(--text); padding: 7px 10px; font-size: var(--fs-xs); outline: none;
  }
  .git-bar-path input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(62,207,142,.15); }
  .git-btn {
    background: var(--bg2); color: var(--text);
    border: 1px solid var(--line); border-radius: 8px;
    padding: 7px 12px; font-size: var(--fs-xs); cursor: pointer; transition: all .15s;
  }
  .git-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .git-btn:disabled { opacity: .45; cursor: not-allowed; }
  .git-btn.primary {
    background: linear-gradient(135deg, var(--accent), var(--c-blue));
    color: #fff; border: none; font-weight: 600;
  }
  .git-btn.primary:hover:not(:disabled) { filter: brightness(1.1); color: #fff; }
  .git-btn.ghost { background: transparent; }
  .git-btn.xs { padding: 2px 7px; font-size: var(--fs-xs); border-radius: 6px; }
  .git-btn.danger:hover:not(:disabled) { border-color: var(--danger); color: var(--danger); }
  .git-btn.big { padding: 12px 22px; font-size: var(--fs-sm); }
  .git-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 60px 20px; color: var(--muted-2); text-align: center; }
  .git-empty-hint { font-size: var(--fs-xs); max-width: 420px; line-height: 1.7; }
  .git-empty code { background: var(--bg2); padding: 2px 6px; border-radius: 5px; }
  .git-repo { display: flex; flex-direction: column; gap: 8px; }
  .git-repo-info { display: flex; flex-wrap: wrap; gap: 6px; }
  .git-chip {
    display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px;
    background: var(--bg2); border: 1px solid var(--line);
    border-radius: 999px; font-size: var(--fs-xs); color: var(--text); max-width: 340px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .git-chip-key { color: var(--muted-2); font-weight: 500; }
  .git-chip.ok { border-color: rgba(62,207,142,.4); color: var(--c-green); }
  .git-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); display: inline-block; }
  .git-chip.ok .git-dot { background: var(--c-green); }
  .git-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .git-commit-box { display: flex; gap: 6px; flex: 1; min-width: 280px; }
  .git-commit-box input, .git-token-box input, .git-branch-create input {
    flex: 1; background: var(--bg2);
    border: 1px solid var(--line); border-radius: 8px;
    color: var(--text); padding: 7px 10px; font-size: var(--fs-xs); outline: none; min-width: 120px;
  }
  .git-token-box, .git-branch-create { display: flex; gap: 6px; align-items: center; }
  .git-token-box { min-width: 240px; flex: 1.2; }
  .git-remote-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .git-branch-create input { width: 130px; }
  .git-error {
    display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 9px;
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    color: var(--danger); font-size: var(--fs-xs);
  }
  .git-notice {
    padding: 8px 12px; border-radius: 9px; font-size: var(--fs-xs);
    background: color-mix(in srgb, var(--c-green) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--c-green) 40%, transparent);
    color: var(--c-green);
  }
  .git-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
  .git-tabs button {
    background: transparent; border: none; color: var(--muted-2); font-size: var(--fs-sm);
    padding: 6px 12px; border-radius: 8px; cursor: pointer;
  }
  .git-tabs button:hover { color: var(--text); background: var(--bg2); }
  .git-tabs button.active { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); font-weight: 600; }
  .git-split { display: grid; grid-template-columns: minmax(240px, 34%) 1fr; gap: 10px; min-height: 320px; height: 100%; }
  .git-files {
    display: flex; flex-direction: column; border: 1px solid var(--line);
    border-radius: 12px; overflow: hidden; background: var(--bg2); min-height: 0;
  }
  .git-files-head {
    display: flex; justify-content: space-between; align-items: center;
    padding: 9px 12px; font-size: var(--fs-xs); font-weight: 650;
    border-bottom: 1px solid var(--line);
  }
  .git-files-count { font-weight: 400; color: var(--muted-2); font-size: var(--fs-xs); }
  .git-files-ops { display: flex; gap: 5px; padding: 7px 10px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .git-files-list { overflow-y: auto; flex: 1; min-height: 0; }
  .git-file-row {
    display: flex; align-items: center; gap: 7px; padding: 7px 10px; cursor: pointer;
    border-bottom: 1px solid var(--line);
  }
  .git-file-main { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; padding: 0;
    background: none; border: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .git-file-main:hover .git-file-path { color: var(--c-cyan); }
  .git-file-row:hover { background: var(--bg2); }
  .git-file-row.selected { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .git-file-mark { color: var(--muted-2); font-size: var(--fs-xs); }
  .git-file-mark.staged { color: var(--c-green); }
  .git-file-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-xs); }
  .git-file-state { color: var(--muted-2); font-size: var(--fs-xs); white-space: nowrap; }
  .git-file-ops { display: flex; gap: 3px; opacity: 0; transition: opacity .12s; }
  .git-file-row:hover .git-file-ops { opacity: 1; }
  .git-files-empty { padding: 24px 12px; text-align: center; color: var(--muted-2); font-size: var(--fs-xs); }
  .git-diff {
    border: 1px solid var(--line); border-radius: 12px;
    overflow: hidden; display: flex; flex-direction: column; min-height: 0; background: var(--bg2);
  }
  .git-diff-head {
    display: flex; align-items: center; gap: 8px; padding: 9px 12px;
    border-bottom: 1px solid var(--line); font-size: var(--fs-xs);
  }
  .git-diff-file { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .git-diff-status { color: var(--muted-2); font-size: var(--fs-xs); border: 1px solid var(--line); border-radius: 5px; padding: 1px 6px; }
  .git-diff-stats { margin-left: auto; display: flex; gap: 7px; font-size: var(--fs-xs); }
  .git-diff-stats .add { color: var(--c-green); }
  .git-diff-stats .del { color: var(--danger); }
  .git-diff-body { overflow: auto; flex: 1; font-family: 'Cascadia Code', Consolas, 'JetBrains Mono', monospace; font-size: var(--fs-sm); line-height: 1.55; }
  .git-hunk-header { padding: 4px 12px; color: var(--c-blue); background: color-mix(in srgb, var(--c-blue) 8%, transparent); font-size: var(--fs-xs); }
  .git-line { display: flex; padding: 0 12px; min-height: 19px; }
  .git-line.add { background: color-mix(in srgb, var(--c-green) 13%, transparent); }
  .git-line.del { background: color-mix(in srgb, var(--danger) 12%, transparent); }
  .git-line-no { width: 38px; flex-shrink: 0; color: var(--muted-2); user-select: none; text-align: right; padding-right: 9px; }
  .git-line-text { white-space: pre-wrap; word-break: break-all; }
  .git-diff-empty { display: flex; align-items: center; justify-content: center; flex: 1; color: var(--muted-2); padding: 40px; font-size: var(--fs-xs); }
  .git-branch-list, .git-commit-list { display: flex; flex-direction: column; gap: 4px; overflow-y: auto; }
  .git-branch-row {
    display: flex; align-items: center; gap: 9px; padding: 9px 12px; text-align: left;
    background: var(--bg2); border: 1px solid var(--line);
    border-radius: 10px; cursor: pointer; color: var(--text); font-size: var(--fs-sm);
  }
  .git-branch-row:hover { border-color: var(--accent); }
  .git-branch-row.current { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .git-branch-ico { color: var(--c-cyan); display: inline-flex; }
  .git-branch-ico :global(svg) { width: 15px; height: 15px; }
  .git-branch-name { font-weight: 600; }
  .git-branch-tag { font-size: var(--fs-xs); color: var(--accent); border: 1px solid var(--accent); border-radius: 999px; padding: 0 7px; }
  .git-branch-up { color: var(--muted-2); font-size: var(--fs-xs); margin-left: auto; }
  .git-commit-row {
    display: flex; align-items: center; gap: 10px; padding: 9px 12px; text-align: left;
    background: var(--bg2); border: 1px solid var(--line);
    border-radius: 10px; cursor: pointer; color: var(--text); font-size: var(--fs-sm);
  }
  .git-commit-row:hover { border-color: var(--accent); }
  .git-commit-row.selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .git-commit-sha { color: var(--c-amber); font-family: 'Cascadia Code', Consolas, monospace; font-size: var(--fs-xs); }
  .git-commit-msg { font-weight: 550; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .git-commit-meta { display: flex; gap: 8px; align-items: center; color: var(--muted-2); font-size: var(--fs-xs); white-space: nowrap; }
  .git-refs { color: var(--c-cyan); font-size: var(--fs-xs); }
  .git-commit-diff { margin-top: 8px; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .git-commit-file { border-bottom: 1px solid var(--line); }

  .git-recent { margin-top: 18px; width: min(560px, 92%); text-align: left; }
  .git-recent-head { display: flex; align-items: center; justify-content: space-between;
    font-size: var(--fs-xs); font-weight: 700; color: var(--muted); letter-spacing: .4px;
    text-transform: uppercase; margin-bottom: 8px; }
  .git-recent-row { display: flex; align-items: center; gap: 10px; width: 100%;
    padding: 9px 12px; margin-bottom: 6px; border: 1px solid var(--line); border-radius: 11px;
    background: var(--w-025); color: var(--text); font-size: var(--fs-sm); text-align: left;
    transition: border-color var(--transition), background var(--transition); }
  .git-recent-row:hover { border-color: var(--line-strong); background: var(--w-05); }
  .git-recent-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; font-family: ui-monospace, Consolas, monospace; font-size: var(--fs-xs);
    color: var(--muted); }
  .git-recent-x { flex: 0 0 auto; width: 20px; height: 20px; display: grid; place-items: center;
    border-radius: 6px; color: var(--muted); font-size: var(--fs-xs); cursor: pointer; }
  .git-recent-x:hover { color: var(--c-red); background: var(--w-07); }
</style>
