import type { FileMap } from './types';

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const joinLines = (lines: string[]) => (lines.length ? lines.join('\n') + '\n' : '');

/** Longest-common-subsequence matches between two line arrays. */
export function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

const eq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Classic diff3 line merge. */
export function merge3(
  base: string,
  ours: string,
  theirs: string,
  oursLabel: string,
  theirsLabel: string,
): { text: string; conflict: boolean } {
  const B = splitLines(base);
  const O = splitLines(ours);
  const T = splitLines(theirs);
  const mo = new Map(lcsPairs(B, O));
  const mt = new Map(lcsPairs(B, T));
  const out: string[] = [];
  let conflict = false;
  let ib = 0;
  let io = 0;
  let it = 0;
  const flush = (bEnd: number, oEnd: number, tEnd: number) => {
    const b = B.slice(ib, bEnd);
    const o = O.slice(io, oEnd);
    const t = T.slice(it, tEnd);
    if (eq(o, b)) out.push(...t);
    else if (eq(t, b)) out.push(...o);
    else if (eq(o, t)) out.push(...o);
    else {
      conflict = true;
      out.push(`<<<<<<< ${oursLabel}`, ...o, '=======', ...t, `>>>>>>> ${theirsLabel}`);
    }
  };
  for (let i = 0; i < B.length; i++) {
    const oi = mo.get(i);
    const ti = mt.get(i);
    if (oi !== undefined && ti !== undefined && oi >= io && ti >= it) {
      flush(i, oi, ti);
      out.push(B[i]);
      ib = i + 1;
      io = oi + 1;
      it = ti + 1;
    }
  }
  flush(B.length, O.length, T.length);
  return { text: joinLines(out), conflict };
}

export function mergeTrees(
  base: FileMap,
  ours: FileMap,
  theirs: FileMap,
  oursLabel: string,
  theirsLabel: string,
): { tree: FileMap; conflicts: string[] } {
  const tree: FileMap = {};
  const conflicts: string[] = [];
  const paths = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
  for (const p of [...paths].sort()) {
    const b = base[p];
    const o = ours[p];
    const t = theirs[p];
    if (o === t) {
      if (o !== undefined) tree[p] = o;
    } else if (b === o) {
      if (t !== undefined) tree[p] = t;
    } else if (b === t) {
      if (o !== undefined) tree[p] = o;
    } else if (o === undefined || t === undefined) {
      // modify/delete conflict: keep the modified side so nothing is lost
      tree[p] = (o ?? t) as string;
      conflicts.push(p);
    } else {
      const r = merge3(b ?? '', o, t, oursLabel, theirsLabel);
      tree[p] = r.text;
      if (r.conflict) conflicts.push(p);
    }
  }
  return { tree, conflicts };
}

export type DiffLine = { t: ' ' | '-' | '+'; line: string };

export function diffLines(a: string, b: string): DiffLine[] {
  const A = splitLines(a);
  const B = splitLines(b);
  const pairs = lcsPairs(A, B);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [A.length, B.length] as [number, number]]) {
    while (i < pi) out.push({ t: '-', line: A[i++] });
    while (j < pj) out.push({ t: '+', line: B[j++] });
    if (pi < A.length) out.push({ t: ' ', line: A[pi] });
    i = pi + 1;
    j = pj + 1;
  }
  return out;
}

export const hasConflictMarkers = (text: string | undefined) =>
  !!text && /^(<{7}|={7}|>{7})( |$)/m.test(text);
