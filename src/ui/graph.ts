import { ancestors, currentBranch, firstLine, headId, reachable, short } from '../engine/repo';
import type { World } from '../engine/types';

const COL = 58;
const PAD_X = 30;
const NODE_R = 9;
const LANE_COLORS = ['#5b5bd6', '#1f9d55', '#c2410c', '#0e7490', '#a21caf', '#b45309'];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

type Label = { text: string; kind: 'head' | 'branch' | 'remote' | 'tag' | 'lost' | 'stash' };

/** Draw the local commit graph as SVG: time flows left → right, one lane per branch. */
export function renderGraph(w: World): string {
  const r = w.repo;
  if (!r) return `<div class="graph-empty">No repository here. ${Object.keys(w.files).length ? 'Run <code>git init</code>.' : ''}</div>`;
  const live = reachable(w);
  // commits only the reflog remembers: draw them faded so "lost" work is visible
  const dangling = new Set<string>();
  for (const e of r.reflog) if (!live.has(e.id)) for (const id of ancestors(w, e.id)) if (!live.has(id)) dangling.add(id);
  const shown = [...live, ...dangling].map((id) => w.objects[id]).sort((a, b) => a.seq - b.seq);
  if (!shown.length) return `<div class="graph-empty">No commits yet. History will appear here.</div>`;

  const col = new Map(shown.map((c, i) => [c.id, i]));
  const cur = currentBranch(w);
  const head = headId(w);

  // lane assignment: walk first-parent chains from each tip, most important first
  const tips: string[] = [];
  if (cur && r.branches[cur]) tips.push(r.branches[cur]);
  if (head) tips.push(head);
  for (const b of Object.keys(r.branches).sort()) tips.push(r.branches[b]);
  for (const b of Object.keys(r.remoteBranches).sort()) tips.push(r.remoteBranches[b]);
  for (const s of r.stash) tips.push(s.base);
  for (const t of Object.keys(r.tags ?? {}).sort()) tips.push(r.tags[t]);
  [...dangling].map((id) => w.objects[id]).sort((a, b) => b.seq - a.seq).forEach((c) => tips.push(c.id));
  const lane = new Map<string, number>();
  let lanes = 0;
  for (const t of tips) {
    let id: string | undefined = t;
    let used = false;
    while (id && !lane.has(id) && col.has(id)) {
      lane.set(id, lanes);
      used = true;
      id = w.objects[id].parents[0];
    }
    if (used) lanes++;
  }
  for (const c of shown) if (!lane.has(c.id)) lane.set(c.id, lanes++);

  // labels
  const labels = new Map<string, Label[]>();
  const add = (id: string, l: Label) => labels.set(id, [...(labels.get(id) ?? []), l]);
  if (head && !cur) add(head, { text: 'HEAD (detached)', kind: 'head' });
  for (const [b, id] of Object.entries(r.branches)) add(id, { text: b === cur ? `HEAD → ${b}` : b, kind: b === cur ? 'head' : 'branch' });
  for (const [b, id] of Object.entries(r.remoteBranches)) add(id, { text: b, kind: 'remote' });
  for (const [t, id] of Object.entries(r.tags ?? {})) add(id, { text: `🏷 ${t}`, kind: 'tag' });
  r.stash.forEach((s, i) => add(s.base, { text: `stash@{${i}} base`, kind: 'stash' }));
  for (const id of dangling) {
    const tipOfDangling = !shown.some((c) => dangling.has(c.id) && c.parents.includes(id));
    if (tipOfDangling) add(id, { text: 'only in reflog', kind: 'lost' });
  }
  for (const [id, ls] of labels) labels.set(id, ls.sort((a, b) => order(a.kind) - order(b.kind)));

  // lane heights depend on the number of stacked labels
  const laneLabelMax = new Array<number>(lanes).fill(0);
  for (const [id, ls] of labels) laneLabelMax[lane.get(id)!] = Math.max(laneLabelMax[lane.get(id)!], ls.length);
  const laneY: number[] = [];
  let y = 24;
  for (let i = 0; i < lanes; i++) {
    laneY.push(y);
    y += 40 + laneLabelMax[i] * 17;
  }
  const height = y - 10;
  // column x positions: wide labels push neighbours apart
  const labelW = (id: string) => Math.max(0, ...(labels.get(id) ?? []).map((l) => l.text.length * 6.3 + 12));
  const xs: number[] = [];
  shown.forEach((c, i) => {
    xs.push(i === 0 ? Math.max(PAD_X, labelW(c.id) / 2 + 6) : xs[i - 1] + Math.max(COL, (labelW(shown[i - 1].id) + labelW(c.id)) / 2 + 8));
  });
  const width = xs[xs.length - 1] + Math.max(PAD_X, labelW(shown[shown.length - 1].id) / 2 + 6);
  const pos = (id: string) => ({ x: xs[col.get(id)!], y: laneY[lane.get(id)!] });

  let edges = '';
  let nodes = '';
  for (const c of shown) {
    const p = pos(c.id);
    const faded = dangling.has(c.id);
    for (const parent of c.parents) {
      if (!col.has(parent)) continue;
      const q = pos(parent);
      const color = LANE_COLORS[lane.get(c.id)! % LANE_COLORS.length];
      const d = q.y === p.y ? `M${q.x},${q.y} L${p.x},${p.y}` : `M${q.x},${q.y} C${q.x + COL * 0.6},${q.y} ${p.x - COL * 0.6},${p.y} ${p.x},${p.y}`;
      edges += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" ${faded ? 'stroke-dasharray="4 4" opacity="0.45"' : ''}/>`;
    }
    const color = LANE_COLORS[lane.get(c.id)! % LANE_COLORS.length];
    const isHead = c.id === head;
    const title = `${short(c.id)} ${c.author}: ${firstLine(c.message)}${faded ? ' (not on any branch: only reflog remembers it)' : ''}`;
    nodes += `<g ${faded ? 'opacity="0.45"' : ''}><title>${esc(title)}</title>`;
    if (isHead) nodes += `<circle cx="${p.x}" cy="${p.y}" r="${NODE_R + 5}" fill="none" stroke="${color}" stroke-width="2" opacity="0.5"/>`;
    nodes += `<circle cx="${p.x}" cy="${p.y}" r="${NODE_R}" fill="${c.parents.length > 1 ? 'var(--panel)' : color}" stroke="${color}" stroke-width="3"/>`;
    nodes += `<text x="${p.x}" y="${p.y - NODE_R - 5}" text-anchor="middle" font-size="10" font-family="var(--mono)" fill="var(--muted)">${short(c.id)}</text>`;
    (labels.get(c.id) ?? []).forEach((l, i) => {
      const ly = p.y + NODE_R + 8 + i * 17;
      const tw = l.text.length * 6.3 + 12;
      const { bg, fg } = pill(l.kind);
      nodes += `<rect x="${p.x - tw / 2}" y="${ly}" width="${tw}" height="15" rx="7.5" fill="${bg}"/>`;
      nodes += `<text x="${p.x}" y="${ly + 11}" text-anchor="middle" font-size="10.5" font-weight="600" font-family="var(--mono)" fill="${fg}">${esc(l.text)}</text>`;
    });
    nodes += `</g>`;
  }
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Commit graph">${edges}${nodes}</svg>`;
}

const order = (k: Label['kind']) => ({ head: 0, branch: 1, remote: 2, tag: 3, stash: 4, lost: 5 })[k];

function pill(kind: Label['kind']) {
  switch (kind) {
    case 'head':
      return { bg: 'var(--accent)', fg: '#fff' };
    case 'branch':
      return { bg: 'var(--accent-soft)', fg: 'var(--accent)' };
    case 'remote':
      return { bg: 'var(--warn-soft)', fg: 'var(--remote)' };
    case 'tag':
      return { bg: 'var(--ok-soft)', fg: 'var(--ok)' };
    case 'stash':
      return { bg: 'var(--panel-2)', fg: 'var(--muted)' };
    case 'lost':
      return { bg: 'var(--bad-soft)', fg: 'var(--bad)' };
  }
}
