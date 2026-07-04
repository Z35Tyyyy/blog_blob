// Minimal GitHub REST client for committing published content.
// Uses the Git Data API so a publish is a single atomic commit.

const API = 'https://api.github.com';

async function gh(token, method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).message ?? '';
    } catch { /* ignore */ }
    const err = new Error(`GitHub ${method} ${url} → ${res.status}${detail ? `: ${detail}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

export async function checkRepoAccess({ token, owner, repo }) {
  const info = await gh(token, 'GET', `/repos/${owner}/${repo}`);
  return {
    fullName: info.full_name,
    defaultBranch: info.default_branch,
    canPush: info.permissions?.push ?? false,
    private: info.private,
  };
}

/** List all file paths currently on the branch (empty array for an empty repo). */
export async function listTree({ token, owner, repo, branch }) {
  try {
    const ref = await gh(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
    const commit = await gh(token, 'GET', `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
    const tree = await gh(
      token,
      'GET',
      `/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`
    );
    return tree.tree.filter((e) => e.type === 'blob').map((e) => e.path);
  } catch (err) {
    if (err.status === 404 || err.status === 409) return [];
    throw err;
  }
}

/**
 * Commit a set of file changes to a branch in one commit.
 * files: [{ path, content (utf8 string) | contentBase64, delete: bool }]
 * Returns the new commit sha.
 *
 * The Git Data API cannot write to a completely empty repository (it 409s);
 * in that case we bootstrap an initial commit via the Contents API and retry.
 */
export async function commitFiles(opts) {
  try {
    return await commitFilesInner(opts);
  } catch (err) {
    if (err.status === 409 && !opts._retried) {
      await gh(opts.token, 'PUT', `/repos/${opts.owner}/${opts.repo}/contents/.gitkeep`, {
        message: 'bootstrap repository',
        content: '', // base64 of an empty file
        branch: opts.branch,
      });
      return commitFilesInner({ ...opts, _retried: true });
    }
    throw err;
  }
}

async function commitFilesInner({ token, owner, repo, branch, message, files }) {
  const repoUrl = `/repos/${owner}/${repo}`;

  // Current branch tip (null when the repo/branch is empty)
  let baseCommitSha = null;
  let baseTreeSha = null;
  try {
    const ref = await gh(token, 'GET', `${repoUrl}/git/ref/heads/${branch}`);
    baseCommitSha = ref.object.sha;
    const commit = await gh(token, 'GET', `${repoUrl}/git/commits/${baseCommitSha}`);
    baseTreeSha = commit.tree.sha;
  } catch (err) {
    if (err.status !== 404 && err.status !== 409) throw err;
  }

  // Blobs → tree entries
  const tree = [];
  for (const f of files) {
    if (f.delete) {
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const blob = f.contentBase64
      ? await gh(token, 'POST', `${repoUrl}/git/blobs`, { content: f.contentBase64, encoding: 'base64' })
      : await gh(token, 'POST', `${repoUrl}/git/blobs`, { content: f.content, encoding: 'utf-8' });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await gh(token, 'POST', `${repoUrl}/git/trees`, {
    ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
    tree,
  });

  const newCommit = await gh(token, 'POST', `${repoUrl}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: baseCommitSha ? [baseCommitSha] : [],
  });

  if (baseCommitSha) {
    await gh(token, 'PATCH', `${repoUrl}/git/refs/heads/${branch}`, { sha: newCommit.sha });
  } else {
    await gh(token, 'POST', `${repoUrl}/git/refs`, { ref: `refs/heads/${branch}`, sha: newCommit.sha });
  }

  return newCommit.sha;
}
