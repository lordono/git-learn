import { COMMAND_DOCS } from '../engine/docs';
import { currentBranch, headId, short } from '../engine/repo';
import type { Line, World } from '../engine/types';
import { esc } from './panels';

export function promptParts(w: World): { dir: string; branch: string } {
  const r = w.repo;
  if (!r) return { dir: 'project', branch: '' };
  const br = currentBranch(w);
  let label = br ?? (headId(w) ? short(headId(w)!) : '?');
  const op = r.op;
  if (op?.kind === 'rebase') label = `${op.branch ?? label}|REBASING`;
  else if (op?.kind === 'merge') label += '|MERGING';
  else if (op?.kind === 'cherry-pick') label += '|CHERRY-PICKING';
  else if (op?.kind === 'revert') label += '|REVERTING';
  return { dir: 'project', branch: label };
}

export function lineHtml(l: Line): string {
  return `<div class="term-line k-${l.kind}">${esc(l.text)}</div>`;
}

export function cmdHtml(cmd: string, w: World): string {
  const { dir, branch } = promptParts(w);
  return `<div class="term-line k-cmd"><span class="p">you@laptop ${dir}</span>${branch ? ` <span class="b">(${esc(branch)})</span>` : ''} % ${esc(cmd)}</div>`;
}

const SHELL_CMDS = ['git', 'ls', 'cat', 'echo', 'nano', 'touch', 'rm', 'mv', 'clear', 'hint', 'help'];
const GIT_FLAGS: Record<string, string[]> = {
  reset: ['--soft', '--mixed', '--hard'],
  rebase: ['--continue', '--abort', '--skip'],
  merge: ['--abort', '--continue', '--no-ff', '--ff-only'],
  pull: ['--rebase', '--no-rebase', '--ff-only'],
  push: ['--force-with-lease', '--force', '--set-upstream', '--delete'],
  commit: ['--amend', '--no-edit'],
  restore: ['--staged', '--source='],
  log: ['--oneline', '--all', '--graph'],
  stash: ['pop', 'list', 'apply', 'drop', 'push', 'show'],
  'cherry-pick': ['--continue', '--abort'],
  revert: ['--continue', '--abort'],
  config: ['--global', 'user.name', 'user.email', 'pull.rebase', '--list'],
  branch: ['-d', '-D', '-vv', '-a', '-m'],
  switch: ['-c'],
};

/** Tab completion: returns the completed line, or a list of options if ambiguous. */
export function complete(line: string, w: World): { line: string; options: string[] } {
  const parts = line.split(/\s+/);
  const last = parts[parts.length - 1];
  let cands: string[];
  if (parts.length === 1) cands = SHELL_CMDS;
  else if (parts[0] === 'git' && parts.length === 2) cands = Object.keys(COMMAND_DOCS);
  else {
    const r = w.repo;
    cands = [
      ...Object.keys(w.files),
      ...(r ? [...Object.keys(r.branches), ...Object.keys(r.remoteBranches), 'HEAD', 'origin'] : []),
      ...(parts[0] === 'git' ? (GIT_FLAGS[parts[1]] ?? []) : []),
    ];
  }
  const hits = [...new Set(cands)].filter((c) => c.startsWith(last)).sort();
  if (hits.length === 1) return { line: [...parts.slice(0, -1), hits[0]].join(' ') + (hits[0].endsWith('=') ? '' : ' '), options: [] };
  if (hits.length > 1) {
    let pre = hits[0];
    for (const h of hits) while (!h.startsWith(pre)) pre = pre.slice(0, -1);
    return { line: [...parts.slice(0, -1), pre].join(' '), options: pre === last ? hits : [] };
  }
  return { line, options: [] };
}
