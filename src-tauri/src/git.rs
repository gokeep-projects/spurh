use git2::{
    build::CheckoutBuilder, BranchType, Cred, Diff, DiffDelta, DiffOptions, FetchOptions,
    MergeAnalysis, Patch, PushOptions, RemoteCallbacks, Repository, ResetType, Signature,
};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct GitRepoInfo {
    pub is_repo: bool,
    pub root: String,
    pub current_branch: String,
    pub upstream: Option<String>,
    pub remote_url: Option<String>,
    pub head_sha: Option<String>,
    pub head_message: Option<String>,
    pub is_clean: bool,
    pub branch_count: usize,
}

#[derive(Serialize, Clone)]
pub struct GitStatusEntry {
    pub path: String,
    pub state: String,
    pub staged: bool,
}

#[derive(Serialize)]
pub struct GitBranchInfo {
    pub name: String,
    pub current: bool,
    pub remote: bool,
    pub upstream: Option<String>,
}

#[derive(Serialize)]
pub struct GitCommitInfo {
    pub sha: String,
    pub short: String,
    pub message: String,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub refs: Vec<String>,
}

#[derive(Serialize)]
pub struct GitDiffLine {
    pub kind: String,
    pub text: String,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
}

#[derive(Serialize)]
pub struct GitHunk {
    pub header: String,
    pub lines: Vec<GitDiffLine>,
}

#[derive(Serialize)]
pub struct GitDiffFile {
    pub old_path: String,
    pub new_path: String,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    pub hunks: Vec<GitHunk>,
}

fn open_repo(path: &str) -> Result<Repository, String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("路径不存在: {path}"));
    }
    Repository::open(p).map_err(|e| format!("不是 Git 仓库或无法打开: {e}"))
}

fn status_label(st: git2::Status) -> String {
    let mut parts = Vec::new();
    if st.intersects(git2::Status::INDEX_NEW) {
        parts.push("新增(已暂存)");
    }
    if st.intersects(git2::Status::INDEX_MODIFIED) {
        parts.push("修改(已暂存)");
    }
    if st.intersects(git2::Status::INDEX_DELETED) {
        parts.push("删除(已暂存)");
    }
    if st.intersects(git2::Status::INDEX_RENAMED) {
        parts.push("重命名(已暂存)");
    }
    if st.intersects(git2::Status::WT_NEW) {
        parts.push("未跟踪");
    }
    if st.intersects(git2::Status::WT_MODIFIED) {
        parts.push("修改");
    }
    if st.intersects(git2::Status::WT_DELETED) {
        parts.push("删除");
    }
    if st.intersects(git2::Status::WT_RENAMED) {
        parts.push("重命名");
    }
    if st.intersects(git2::Status::CONFLICTED) {
        parts.push("冲突");
    }
    if parts.is_empty() {
        "未知".to_string()
    } else {
        parts.join(" / ")
    }
}

fn remote_url_of(repo: &Repository, branch: &str) -> Option<String> {
    if let Ok(buf) = repo.branch_upstream_remote(branch) {
        let name = buf.as_str().ok()?;
        if let Ok(remote) = repo.find_remote(name) {
            if let Ok(url) = remote.url() {
                return Some(url.to_string());
            }
        }
    }
    if let Ok(remote) = repo.find_remote("origin") {
        if let Ok(url) = remote.url() {
            return Some(url.to_string());
        }
    }
    if let Ok(remotes) = repo.remotes() {
        for name in remotes.iter().flatten() {
            if let Some(name) = name {
                if let Ok(remote) = repo.find_remote(name) {
                    if let Ok(url) = remote.url() {
                        return Some(url.to_string());
                    }
                }
            }
        }
    }
    None
}

fn repo_info(repo: &Repository, fallback_path: &str) -> Result<GitRepoInfo, String> {
    let head = repo.head().ok();
    let current_branch = head
        .as_ref()
        .and_then(|h| h.shorthand().ok().map(|s| s.to_string()))
        .unwrap_or_else(|| "(无提交)".to_string());
    let head_commit = head.as_ref().and_then(|h| h.peel_to_commit().ok());
    let head_sha = head_commit.as_ref().map(|c| c.id().to_string());
    let head_message = head_commit.as_ref().and_then(|c| {
        c.summary()
            .ok()
            .flatten()
            .map(|s| s.to_string())
            .unwrap_or_default()
            .into()
    });
    let upstream = if let Ok(branch) = repo.find_branch(&current_branch, BranchType::Local) {
        branch
            .upstream()
            .ok()
            .and_then(|u| u.name().ok().flatten().map(|s| s.to_string()))
    } else {
        None
    };
    let remote_url = remote_url_of(repo, &current_branch);
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| e.to_string())?;
    let is_clean = statuses.is_empty();
    let branch_count = repo
        .branches(Some(BranchType::Local))
        .map(|it| it.count())
        .unwrap_or(0);
    let root = repo
        .workdir()
        .map(|w| w.to_string_lossy().to_string())
        .unwrap_or_else(|| fallback_path.to_string());
    Ok(GitRepoInfo {
        is_repo: true,
        root,
        current_branch,
        upstream,
        remote_url,
        head_sha,
        head_message,
        is_clean,
        branch_count,
    })
}

#[tauri::command(async)]
pub fn git_open(path: String) -> Result<GitRepoInfo, String> {
    let repo = open_repo(&path)?;
    repo_info(&repo, &path)
}

/// 自动识别：给定任意文件或目录，向上查找最近的 Git 仓库根目录。
/// 非仓库路径返回 None（不报错），便于前端做「加载即识别」。
#[tauri::command(async)]
pub fn git_detect(path: String) -> Result<Option<GitRepoInfo>, String> {
    let p = Path::new(&path);
    let target = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
    match Repository::discover(target) {
        Ok(repo) => {
            let root = repo
                .workdir()
                .map(|w| w.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            repo_info(&repo, &root).map(Some)
        }
        Err(_) => Ok(None),
    }
}

#[tauri::command(async)]
pub fn git_status(path: String) -> Result<Vec<GitStatusEntry>, String> {
    let repo = open_repo(&path)?;
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in statuses.iter() {
        let st = entry.status();
        let path = entry.path().unwrap_or_default().to_string();
        let staged = st.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED,
        );
        out.push(GitStatusEntry {
            path: path.clone(),
            state: status_label(st),
            staged,
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[tauri::command(async)]
pub fn git_branches(path: String) -> Result<Vec<GitBranchInfo>, String> {
    let repo = open_repo(&path)?;
    let mut out = Vec::new();
    if let Ok(iter) = repo.branches(Some(BranchType::Local)) {
        for b in iter.flatten() {
            let (branch, _) = b;
            let name = branch.name().ok().flatten().unwrap_or_default().to_string();
            let current = branch.is_head();
            let up = branch
                .upstream()
                .ok()
                .and_then(|u| u.name().ok().flatten().map(|s| s.to_string()));
            out.push(GitBranchInfo {
                name,
                current,
                remote: false,
                upstream: up,
            });
        }
    }
    if let Ok(iter) = repo.branches(Some(BranchType::Remote)) {
        for b in iter.flatten() {
            let (branch, _) = b;
            let name = branch.name().ok().flatten().unwrap_or_default().to_string();
            if name == "origin/HEAD" {
                continue;
            }
            out.push(GitBranchInfo {
                name,
                current: false,
                remote: true,
                upstream: None,
            });
        }
    }
    out.sort_by(|a, b| (a.remote as u8, &a.name).cmp(&(b.remote as u8, &b.name)));
    Ok(out)
}

fn describe_refs(repo: &Repository, oid: git2::Oid) -> Vec<String> {
    let mut refs = Vec::new();
    if let Ok(iter) = repo.references() {
        for r in iter.flatten() {
            if let Ok(resolved) = r.resolve() {
                if let Ok(commit) = resolved.peel_to_commit() {
                    if commit.id() == oid {
                        if let Ok(name) = resolved.shorthand() {
                            refs.push(name.to_string());
                        }
                    }
                }
            }
        }
    }
    refs.sort();
    refs
}

#[tauri::command(async)]
pub fn git_log(path: String, count: Option<usize>) -> Result<Vec<GitCommitInfo>, String> {
    let repo = open_repo(&path)?;
    let count = count.unwrap_or(50).clamp(1, 500);
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return Ok(Vec::new()),
    };
    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk
        .set_sorting(git2::Sort::TIME | git2::Sort::TOPOLOGICAL)
        .map_err(|e| e.to_string())?;
    revwalk
        .push(head.target().ok_or("无提交")?)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for oid in revwalk.take(count) {
        let oid = oid.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        let author = commit.author();
        let short = commit.id().to_string();
        let short = &short[..short.len().min(8)];
        out.push(GitCommitInfo {
            sha: commit.id().to_string(),
            short: short.to_string(),
            message: commit
                .summary()
                .ok()
                .flatten()
                .unwrap_or_default()
                .to_string(),
            author: author.name().unwrap_or_default().to_string(),
            email: author.email().unwrap_or_default().to_string(),
            time: author.when().seconds(),
            refs: describe_refs(&repo, commit.id()),
        });
    }
    Ok(out)
}

fn collect_diff(repo: &Repository, diff: Diff) -> Result<Vec<GitDiffFile>, String> {
    let _ = repo;
    let mut files = Vec::new();
    let delta_count = diff.deltas().len();
    for idx in 0..delta_count {
        let patch = match Patch::from_diff(&diff, idx).map_err(|e| e.to_string())? {
            Some(p) => p,
            None => continue,
        };
        let delta = patch.delta();
        let mut hunks = Vec::new();
        for h in 0..patch.num_hunks() {
            let hunk = patch.hunk(h).map_err(|e| e.to_string())?.0;
            let mut lines = Vec::new();
            let line_count = patch
                .num_lines_in_hunk(h)
                .map_err(|e| e.to_string())?;
            for l in 0..line_count {
                let line = patch.line_in_hunk(h, l).map_err(|e| e.to_string())?;
                let kind = match line.origin() {
                    '+' => "+",
                    '-' => "-",
                    _ => " ",
                };
                let text = String::from_utf8_lossy(line.content()).to_string();
                lines.push(GitDiffLine {
                    kind: kind.to_string(),
                    text: text.trim_end_matches('\n').to_string(),
                    old_line: line.old_lineno(),
                    new_line: line.new_lineno(),
                });
            }
            hunks.push(GitHunk {
                header: String::from_utf8_lossy(hunk.header()).to_string(),
                lines,
            });
        }
        let (old_path, new_path) = file_paths(&delta);
        let line_stats = patch.line_stats().map_err(|e| e.to_string())?;
        let additions = line_stats.1;
        let deletions = line_stats.2;
        files.push(GitDiffFile {
            old_path,
            new_path,
            status: delta_status(&delta),
            additions,
            deletions,
            hunks,
        });
    }
    Ok(files)
}

fn file_paths(delta: &DiffDelta) -> (String, String) {
    let old_path = delta
        .old_file()
        .path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let new_path = delta
        .new_file()
        .path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    (old_path, new_path)
}

fn delta_status(delta: &DiffDelta) -> String {
    match delta.status() {
        git2::Delta::Added => "新增",
        git2::Delta::Deleted => "删除",
        git2::Delta::Modified => "修改",
        git2::Delta::Renamed => "重命名",
        git2::Delta::Copied => "复制",
        _ => "变更",
    }
    .to_string()
}

fn diff_opts() -> DiffOptions {
    let mut opts = DiffOptions::new();
    opts.context_lines(3);
    opts
}

#[tauri::command(async)]
pub fn git_diff_workdir(path: String) -> Result<Vec<GitDiffFile>, String> {
    let repo = open_repo(&path)?;
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return Ok(Vec::new()),
    };
    let tree = head.peel_to_tree().map_err(|e| e.to_string())?;
    let mut opts = diff_opts();
    let diff = repo
        .diff_tree_to_workdir_with_index(Some(&tree), Some(&mut opts))
        .map_err(|e| e.to_string())?;
    collect_diff(&repo, diff)
}

#[tauri::command(async)]
pub fn git_diff_commit(path: String, sha: String) -> Result<Vec<GitDiffFile>, String> {
    let repo = open_repo(&path)?;
    let commit = repo
        .find_commit(git2::Oid::from_str(&sha).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(
            commit
                .parent(0)
                .map_err(|e| e.to_string())?
                .tree()
                .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };
    let mut opts = diff_opts();
    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&commit.tree().map_err(|e| e.to_string())?), Some(&mut opts))
        .map_err(|e| e.to_string())?;
    collect_diff(&repo, diff)
}

#[tauri::command(async)]
pub fn git_stage(path: String, files: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&path)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let targets: Vec<String> = if files.is_empty() {
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(true);
        let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
        statuses
            .iter()
            .filter_map(|e| e.path().ok().map(|p| p.to_string()))
            .collect()
    } else {
        files.clone()
    };
    for f in &targets {
        let exists = repo
            .workdir()
            .map(|w| w.join(f).exists())
            .unwrap_or(false);
        if exists {
            index
                .add_path(Path::new(f))
                .map_err(|e| format!("暂存 {f} 失败: {e}"))?;
        } else {
            index
                .remove_path(Path::new(f))
                .map_err(|e| format!("暂存删除 {f} 失败: {e}"))?;
        }
    }
    index.write().map_err(|e| e.to_string())?;
    Ok(())
}

fn restore_index_from_head(repo: &Repository, index: &mut git2::Index, file: &str) -> Result<(), String> {
    let head = repo.head().map_err(|e| e.to_string())?;
    let tree = head.peel_to_tree().map_err(|e| e.to_string())?;
    match tree.get_path(Path::new(file)) {
        Ok(entry) => {
            let blob = repo.find_blob(entry.id()).map_err(|e| e.to_string())?;
            let ie = git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: entry.filemode() as u32,
                uid: 0,
                gid: 0,
                file_size: 0,
                id: entry.id(),
                flags: 0,
                flags_extended: 0,
                path: file.as_bytes().to_vec(),
            };
            index
                .add_frombuffer(&ie, blob.content())
                .map_err(|e| format!("恢复 {file} 失败: {e}"))?;
        }
        Err(_) => {
            index
                .remove_path(Path::new(file))
                .map_err(|e| format!("移除 {file} 失败: {e}"))?;
        }
    }
    Ok(())
}

#[tauri::command(async)]
pub fn git_unstage(path: String, files: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&path)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let targets: Vec<String> = if files.is_empty() {
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(true);
        let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
        statuses
            .iter()
            .filter_map(|e| e.path().ok().map(|p| p.to_string()))
            .collect()
    } else {
        files.clone()
    };
    for f in targets {
        restore_index_from_head(&repo, &mut index, &f)?;
    }
    index.write().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn git_discard(path: String, files: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&path)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let targets: Vec<String> = if files.is_empty() {
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(true);
        let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
        statuses
            .iter()
            .filter_map(|e| e.path().ok().map(|p| p.to_string()))
            .collect()
    } else {
        files.clone()
    };
    for f in &targets {
        let _ = restore_index_from_head(&repo, &mut index, f);
    }
    index.write().map_err(|e| e.to_string())?;
    let mut opts = CheckoutBuilder::new();
    opts.force();
    for f in &targets {
        opts.path(f);
    }
    repo.checkout_head(Some(&mut opts))
        .map_err(|e| format!("还原工作区失败: {e}"))?;
    Ok(())
}

#[tauri::command(async)]
pub fn git_commit(
    path: String,
    message: String,
    name: Option<String>,
    email: Option<String>,
) -> Result<String, String> {
    let repo = open_repo(&path)?;
    if message.trim().is_empty() {
        return Err("提交信息不能为空".to_string());
    }
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
    let sig = if let (Some(n), Some(e)) = (name, email) {
        Signature::now(&n, &e).map_err(|e| e.to_string())?
    } else {
        repo.signature().map_err(|e| format!("无法获取提交者身份: {e}"))?
    };
    let parents: Vec<git2::Commit> = match repo.head() {
        Ok(h) => h.peel_to_commit().ok().into_iter().collect(),
        Err(_) => Vec::new(),
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, message.trim(), &tree, &parent_refs)
        .map_err(|e| e.to_string())?;
    Ok(oid.to_string())
}

#[tauri::command(async)]
pub fn git_checkout(path: String, branch: String, remote: bool) -> Result<(), String> {
    let repo = open_repo(&path)?;
    let name = if remote {
        branch.strip_prefix("origin/").unwrap_or(&branch).to_string()
    } else {
        branch.clone()
    };
    let b = repo
        .find_branch(&branch, if remote { BranchType::Remote } else { BranchType::Local })
        .map_err(|e| format!("分支 {branch} 不存在: {e}"))?;
    let mut opts = CheckoutBuilder::new();
    if remote {
        let commit = b.get().peel_to_commit().map_err(|e| e.to_string())?;
        let mut local = repo
            .branch(&name, &commit, false)
            .map_err(|e| format!("创建本地分支失败: {e}"))?;
        let _ = local.set_upstream(Some(&format!("origin/{name}")));
        repo.set_head(&format!("refs/heads/{name}"))
            .map_err(|e| e.to_string())?;
    } else {
        repo.set_head(b.get().name().map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    repo.checkout_head(Some(&mut opts)).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn git_create_branch(path: String, name: String) -> Result<(), String> {
    let repo = open_repo(&path)?;
    if name.trim().is_empty() {
        return Err("分支名不能为空".to_string());
    }
    let head_commit = repo
        .head()
        .map_err(|e| e.to_string())?
        .peel_to_commit()
        .map_err(|e| e.to_string())?;
    repo.branch(&name, &head_commit, false)
        .map_err(|e| format!("创建分支失败: {e}"))?;
    let mut opts = CheckoutBuilder::new();
    repo.set_head(&format!("refs/heads/{name}"))
        .map_err(|e| e.to_string())?;
    repo.checkout_head(Some(&mut opts)).map_err(|e| e.to_string())?;
    Ok(())
}

fn remote_callbacks(token: Option<String>) -> RemoteCallbacks<'static> {
    let mut cb = RemoteCallbacks::new();
    cb.credentials(move |_url, username, allowed| {
        if allowed.contains(git2::CredentialType::SSH_KEY) {
            if let Some(user) = username {
                return Cred::ssh_key_from_agent(user);
            }
        }
        if allowed.contains(git2::CredentialType::USER_PASS_PLAINTEXT) {
            if let Some(t) = token.as_deref() {
                return Cred::userpass_plaintext(username.unwrap_or("git"), t);
            }
            if let Some(user) = username {
                return Cred::userpass_plaintext(user, "x-oauth-basic");
            }
        }
        if allowed.contains(git2::CredentialType::USERNAME) {
            if let Some(user) = username {
                return Cred::username(user);
            }
        }
        Cred::default()
    });
    cb
}

#[tauri::command(async)]
pub fn git_pull(path: String, token: Option<String>) -> Result<String, String> {
    let repo = open_repo(&path)?;
    let head = repo.head().map_err(|e| e.to_string())?;
    let branch_name = head
        .shorthand()
        .map_err(|e| e.to_string())?
        .to_string();
    let mut remote = repo
        .find_remote("origin")
        .map_err(|e| format!("未找到 origin 远程: {e}"))?;
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(remote_callbacks(token));
    remote
        .fetch(&[&format!("refs/heads/{branch_name}:refs/remotes/origin/{branch_name}")], Some(&mut fo), None)
        .map_err(|e| format!("拉取失败: {e}"))?;
    let remote_branch = repo
        .find_branch(&format!("origin/{branch_name}"), BranchType::Remote)
        .map_err(|e| format!("远程分支 origin/{branch_name} 不存在: {e}"))?
        .get()
        .peel_to_commit()
        .map_err(|e| e.to_string())?;
    let head_commit = repo
        .head()
        .map_err(|e| e.to_string())?
        .peel_to_commit()
        .map_err(|e| e.to_string())?;
    if remote_branch.id() == head_commit.id() {
        return Ok("已是最新".to_string());
    }
    let annotated = repo
        .find_annotated_commit(remote_branch.id())
        .map_err(|e| e.to_string())?;
    let (analysis, _pref) = repo
        .merge_analysis(&[&annotated])
        .map_err(|e| e.to_string())?;
    if analysis.contains(MergeAnalysis::ANALYSIS_FASTFORWARD) || analysis.is_empty() {
        let obj = repo
            .find_object(remote_branch.id(), Some(git2::ObjectType::Commit))
            .map_err(|e| e.to_string())?;
        repo.reset(&obj, ResetType::Hard, None)
            .map_err(|e| e.to_string())?;
        Ok(format!("已快进更新 {branch_name} @ {}", &remote_branch.id().to_string()[..8]))
    } else if analysis.contains(MergeAnalysis::ANALYSIS_NORMAL) {
        let mut mo = git2::MergeOptions::new();
        repo.merge(&[&annotated], Some(&mut mo), None)
            .map_err(|e| format!("合并失败: {e}"))?;
        Ok("已拉取并合并，可能存在冲突".to_string())
    } else {
        Ok("已是最新".to_string())
    }
}

#[tauri::command(async)]
pub fn git_push(path: String, token: Option<String>) -> Result<String, String> {
    let repo = open_repo(&path)?;
    let head = repo.head().map_err(|e| e.to_string())?;
    let branch_name = head
        .shorthand()
        .map_err(|e| e.to_string())?
        .to_string();
    let mut remote = repo
        .find_remote("origin")
        .map_err(|e| format!("未找到 origin 远程: {e}"))?;
    let mut po = PushOptions::new();
    po.remote_callbacks(remote_callbacks(token));
    let refspec = format!("refs/heads/{branch_name}:refs/heads/{branch_name}");
    remote
        .push(&[refspec.as_str()], Some(&mut po))
        .map_err(|e| format!("推送失败: {e}"))?;
    if let Ok(mut branch) = repo.find_branch(&branch_name, BranchType::Local) {
        let _ = branch.set_upstream(Some(&format!("origin/{branch_name}")));
    }
    Ok(format!("已推送到 origin/{branch_name}"))
}

#[tauri::command(async)]
pub async fn pick_folder() -> Option<String> {
    // 同步 rfd 对话框会阻塞 Tauri 主线程,导致资源协议/窗口消息全部停摆(表现为页面资源加载挂起)
    tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("选择 Git 仓库目录")
            .pick_folder()
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::RepositoryInitOptions;

    fn temp_repo() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let mut opts = RepositoryInitOptions::new();
        opts.initial_head("master");
        let repo = Repository::init_opts(&root, &mut opts).unwrap();
        // 首次提交，保证 HEAD 存在
        std::fs::write(Path::new(&root).join("readme.md"), "# test").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("readme.md")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = git2::Signature::now("Spurh Test", "test@spurh.local").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        (dir, root)
    }

    #[test]
    fn git_detect_finds_repo_from_subdir() {
        let (_dir, root) = temp_repo();
        let sub = Path::new(&root).join("src");
        std::fs::create_dir_all(&sub).unwrap();
        let found = git_detect(sub.to_string_lossy().to_string()).unwrap();
        let info = found.expect("应从子目录识别到仓库");
        assert!(info.is_repo);
        let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_string();
        assert_eq!(norm(&info.root), norm(&root));
    }

    #[test]
    fn git_detect_finds_repo_from_file() {
        let (_dir, root) = temp_repo();
        let file = Path::new(&root).join("a.txt");
        std::fs::write(&file, "hi").unwrap();
        let found = git_detect(file.to_string_lossy().to_string()).unwrap();
        assert!(found.is_some(), "文件位于仓库内应被识别");
    }

    #[test]
    fn git_detect_returns_none_outside_repo() {
        let dir = tempfile::tempdir().unwrap();
        let found = git_detect(dir.path().to_string_lossy().to_string()).unwrap();
        assert!(found.is_none(), "非仓库目录应返回 None");
    }

    #[test]
    fn git_open_reports_repo_info() {
        let (_dir, root) = temp_repo();
        let info = git_open(root.clone()).unwrap();
        assert!(info.is_repo);
        assert!(info.is_clean);
        assert_eq!(info.current_branch, "master");
        // 工作区新增文件后不再 clean
        let file = Path::new(&root).join("new.txt");
        std::fs::write(&file, "x").unwrap();
        let info2 = git_open(root).unwrap();
        assert!(!info2.is_clean);
    }
}

