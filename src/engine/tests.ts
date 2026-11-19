import type { Line, World } from './types';

/** The sandbox's `npm test`: each test checks a file in the working directory. */
export function runTests(w: World): { ok: boolean; lines: Line[]; hasTests: boolean } {
  const tests = w.tests ?? [];
  if (!tests.length) return { ok: false, hasTests: false, lines: [{ kind: 'err', text: 'npm error Missing script: "test"' }] };
  const lines: Line[] = [{ kind: 'out', text: '> shop@1.0.0 test\n> vitest run' }];
  let failed = 0;
  for (const t of tests) {
    const text = w.files[t.file];
    const problem =
      text === undefined
        ? `${t.file} does not exist`
        : t.includes !== undefined && !text.includes(t.includes)
          ? `expected ${t.file} to contain ${JSON.stringify(t.includes)}`
          : t.excludes !== undefined && text.includes(t.excludes)
            ? `expected ${t.file} not to contain ${JSON.stringify(t.excludes)}`
            : null;
    if (problem) {
      failed++;
      lines.push({ kind: 'diff-del', text: ` ✗ ${t.name}` }, { kind: 'err', text: `   → ${problem}` });
    } else lines.push({ kind: 'diff-add', text: ` ✓ ${t.name}` });
  }
  const passed = tests.length - failed;
  lines.push({ kind: failed ? 'err' : 'out', text: ` Tests  ${failed ? `${failed} failed | ` : ''}${passed} passed (${tests.length})` });
  return { ok: failed === 0, hasTests: true, lines };
}
