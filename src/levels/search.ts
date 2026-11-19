/** Keyword search over levels: titles, stories, lessons, hints and the commands each level teaches. */
import type { Level } from './types';

export interface LevelEntry {
  level: Level;
  index: number;
  /** one-line description for cards */
  blurb: string;
  /** commands the solution uses, e.g. "git rebase -i", "git push --force-with-lease" */
  teaches: string[];
  /** lowercased text everything is matched against */
  text: string;
}

const stripHtml = (html: string) =>
  html
    .replace(/<\/?(p|li|ol|ul|br|tr|td|table|pre|div|h\d)\b[^>]*>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** "git push --force-with-lease origin v2.0" → "git push --force-with-lease" */
function commandOf(line: string): string | null {
  // ignore quoted arguments (messages, alias bodies): their words aren't flags of this command
  const words = line.trim().replace(/"[^"]*"|'[^']*'/g, '""').split(/\s+/);
  if (words[0] !== 'git' || !words[1]) return null;
  const flags = words.slice(2).filter((w) => /^--?[a-z][\w-]*$/.test(w) && !['-m', '--no-edit', '-q'].includes(w));
  return ['git', words[1], ...flags.slice(0, 2)].join(' ');
}

/** words people search for that a level might not literally contain */
const SYNONYMS: Record<string, string[]> = {
  undo: ['reset --hard', 'revert', 'reflog', '--abort', 'orig_head'],
  recover: ['reflog', 'rescue', 'lost', 'restore'],
  conflict: ['ours', 'theirs', 'resolve', 'conflicts'],
  squash: ['fixup', 'rebase -i'],
  rename: ['reword', 'branch -m', 'amend'],
  delete: ['drop', 'branch -d', 'clean', 'rm'],
  force: ['--force', 'force-with-lease'],
  team: ['teammate', 'alex', 'sam', 'push', 'pull'],
  secret: ['.env', 'key', 'password'],
  history: ['log', 'rebase', 'reflog', 'blame'],
  bug: ['bisect', 'blame', 'revert'],
  release: ['tag', 'hotfix', 'cherry-pick'],
  copy: ['cherry-pick'],
  sync: ['fetch', 'pull', 'push'],
  shelve: ['stash'],
  ignore: ['.gitignore'],
};

export function buildIndex(levels: Level[]): LevelEntry[] {
  return levels.map((level, index) => {
    const story = stripHtml(level.story);
    const teaches = [...new Set(level.solution.map(commandOf).filter((c): c is string => !!c))];
    if (level.chapter === 'lazygit') teaches.unshift('lazygit');
    const firstSentence = story.replace(/^This level runs in lazygit mode.*?Command log\. ?/, '').split(/(?<=[.!?])\s/)[0] ?? '';
    const blurb = firstSentence.length > 140 ? firstSentence.slice(0, 137) + '…' : firstSentence;
    const text = [level.title, level.chapter, story, level.lesson, ...level.hints, ...level.solution, ...level.goals.map((g) => g.text), ...teaches].join(' \n ').toLowerCase();
    return { level, index, blurb, teaches, text };
  });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wholeWord = new Map<string, RegExp>();
const hasWord = (text: string, phrase: string) => {
  let re = wholeWord.get(phrase);
  if (!re) wholeWord.set(phrase, (re = new RegExp(`(^|[^\\w-])${escapeRe(phrase)}($|[^\\w-])`)));
  return re.test(text);
};

/** every search word must appear (as typed, so partial words work), or one of its synonyms as a whole word */
export function matches(entry: LevelEntry, query: string): boolean {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return words.every((w) => entry.text.includes(w) || (SYNONYMS[w] ?? []).some((x) => hasWord(entry.text, x)));
}

export function search(entries: LevelEntry[], query: string): LevelEntry[] {
  return query.trim() ? entries.filter((e) => matches(e, query)) : entries;
}
