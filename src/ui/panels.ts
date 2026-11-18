import { firstLine, headTree, pathsOf, short } from '../engine/repo';
import { ignoreMatcher } from '../engine/worktree';
import type { World } from '../engine/types';

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function snippet(v: string | undefined) {
  if (v === undefined) return '—';
  const lines = v.replace(/\n$/, '').split('\n');
  const changed = lines.find((l) => /^(<{7}|={7}|>{7})/.test(l));
  const first = changed ?? lines[lines.length > 1 ? lines.length - 1 : 0] ?? '';
  return `${lines.length > 1 ? `${lines.length} lines · ` : ''}${first || '(empty)'}`;
}

/** Working directory | staging area | HEAD, side by side. Cells differing from the column to their right are highlighted. */
export function renderTrees(w: World): string {
  const r = w.repo;
  if (!r) {
    const files = Object.keys(w.files).sort();
    if (!files.length) return '<div class="empty">Empty folder.</div>';
    return `<table class="trees"><thead><tr><th>File</th><th>Working dir</th></tr></thead><tbody>${files
      .map((p) => `<tr><td class="path">${esc(p)}</td><td title="${esc(w.files[p])}">${esc(snippet(w.files[p]))}</td></tr>`)
      .join('')}</tbody></table>`;
  }
  const head = headTree(w);
  const ignored = ignoreMatcher(w);
  const paths = pathsOf(w.files, r.index, head);
  if (!paths.length) return '<div class="empty">No files yet. Try <code>echo "hi" &gt; hello.txt</code></div>';
  const rows = paths.map((p) => {
    const wv = w.files[p];
    const iv = r.index[p];
    const hv = head[p];
    const conflict = r.conflicts.includes(p);
    const isIgnored = !(p in r.index) && !(p in head) && ignored(p);
    let tag = '';
    if (conflict) tag = '<span class="tag bad">conflict</span>';
    else if (isIgnored) tag = '<span class="tag">ignored</span>';
    else if (!(p in r.index) && !(p in head)) tag = '<span class="tag warn">untracked</span>';
    else if (iv !== hv && wv !== iv) tag = '<span class="tag accent">staged</span><span class="tag warn">+ more</span>';
    else if (iv !== hv) tag = '<span class="tag accent">staged</span>';
    else if (wv !== iv) tag = '<span class="tag warn">modified</span>';
    const cell = (v: string | undefined, next: string | undefined, isWork: boolean) => {
      const cls = [v === undefined ? 'missing' : '', conflict && isWork ? 'conflict' : v !== next ? 'changed' : '', isIgnored && isWork ? 'ignored' : '']
        .filter(Boolean)
        .join(' ');
      return `<td class="${cls}" title="${esc(v ?? '(not here)')}">${esc(snippet(v))}</td>`;
    };
    return `<tr><td class="path" title="${esc(p)}">${esc(p)}${tag}</td>${cell(wv, iv, true)}${cell(iv, hv, false)}${cell(hv, hv, false)}</tr>`;
  });
  return `<table class="trees"><thead><tr>
    <th style="width:32%">File</th>
    <th>Working dir<small>your files on disk</small></th>
    <th>Staging area<small>next commit (git add)</small></th>
    <th>HEAD<small>last commit</small></th>
  </tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

export function renderRemote(w: World): string {
  const rem = w.remote;
  if (!rem) return '<div class="empty">No remote in this level.</div>';
  const r = w.repo;
  const connected = r && Object.values(r.remotes).includes(rem.url);
  const rows = Object.entries(rem.branches)
    .sort()
    .map(([b, id]) => {
      const known = r?.remoteBranches[`origin/${b}`];
      const stale = connected && known !== id;
      const c = w.objects[id];
      return `<div class="remote-row"><span class="name">${esc(b)}</span><span class="sha">${short(id)}</span><span>${esc(firstLine(c.message))}</span><span class="sha">by ${esc(c.author)}</span>${
        rem.prOnly?.includes(b) ? '<span class="tag">PRs only</span>' : rem.protectedBranches.includes(b) ? '<span class="tag">protected</span>' : ''
      }${stale ? `<span class="tag warn" title="Your origin/${esc(b)} label is out of date. git fetch to update it">${known ? 'newer than your origin/' + esc(b) : 'not fetched yet'}</span>` : ''}</div>`;
    });
  for (const [t, id] of Object.entries(rem.tags ?? {}).sort()) {
    const c = w.objects[id];
    rows.push(`<div class="remote-row"><span class="name">🏷 ${esc(t)}</span><span class="sha">${short(id)}</span><span>${esc(firstLine(c.message))}</span><span class="tag">tag</span></div>`);
  }
  return `<div class="remote-list"><div class="remote-url">${esc(rem.url)}${connected ? '' : ' · not added as a remote yet'}</div>${rows.join('') || '<div class="empty">No branches on the server yet.</div>'}</div>`;
}
