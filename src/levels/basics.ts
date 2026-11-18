import { cfg, headId, treeOf } from '../engine/repo';
import { Scenario, TEAMMATES, branchTip, firstParentChain, hasMessage, isLinear, remoteHas } from './scenario';
import type { Level } from './types';

const { sam } = TEAMMATES;
const chapter = 'Basics';

export const BASICS: Level[] = [
  {
    id: 'who-are-you',
    chapter,
    title: 'Who are you?',
    story: `<p>You just ran <code>git init</code> in a fresh project. There's a <code>README.md</code> waiting.</p>
<p>Save it as your first commit: <code>git add README.md</code> then <code>git commit -m "first commit"</code>.</p>
<p>Git will complain. Read the error carefully: it tells you exactly what to do.</p>`,
    setup: () => new Scenario({ identity: false }).run('git init').write({ 'README.md': '# My Project\n' }).w,
    goals: [
      { text: 'Set user.name', check: (w) => !!cfg(w, 'user.name') },
      { text: 'Set user.email', check: (w) => !!cfg(w, 'user.email') },
      { text: 'Make your first commit', check: (w) => !!headId(w) },
    ],
    hints: [
      'Run git add README.md, then git commit -m "first commit" and read what git says.',
      'git config --global user.name "Your Name"',
      'git config --global user.email "you@example.com", then commit again.',
    ],
    solution: ['git add README.md', 'git commit -m "first commit"', 'git config --global user.name "Ada"', 'git config --global user.email ada@example.com', 'git commit -m "first commit"'],
    lesson: 'Every commit is stamped with a name and email. --global saves them in ~/.gitconfig for every repo; without --global they apply to this repo only (handy for a work vs personal email).',
  },
  {
    id: 'staging',
    chapter,
    title: 'Staging is a choice',
    story: `<p>You fixed a bug in <code>app.js</code>. While you were at it you also scribbled a rant in <code>notes.txt</code>.</p>
<p>Commit <b>only the bug fix</b>. The rant stays on your machine, uncommitted.</p>
<p>Start with <code>git status</code> and <code>git diff</code>.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'app.js': 'function add(a, b) {\n  return a - b;\n}\n', 'notes.txt': 'TODO\n' }, 'Initial commit')
        .write({ 'app.js': 'function add(a, b) {\n  return a + b;\n}\n', 'notes.txt': 'TODO\n- why did a - b ever pass review?!\n' }).w,
    goals: [
      { text: 'The latest commit contains the app.js fix', check: (w) => !!treeOf(w, headId(w))['app.js']?.includes('a + b') },
      { text: 'The latest commit does NOT include the notes.txt rant', check: (w) => treeOf(w, headId(w))['notes.txt'] === 'TODO\n' },
      { text: 'notes.txt still has your rant on disk', check: (w) => !!w.files['notes.txt']?.includes('review') },
    ],
    hints: ['git add takes file names. You do not have to add everything.', 'git add app.js', 'git commit -m "Fix add()"'],
    solution: ['git status', 'git add app.js', 'git commit -m "Fix add()"'],
    lesson: 'The staging area lets you build a commit piece by piece. git add <file> picks what goes in; git add . grabs everything, which is how rants (and secrets) sneak into history.',
  },
  {
    id: 'fast-forward',
    chapter,
    title: 'Fast-forward or merge commit?',
    story: `<p>Two finished branches are waiting: <code>header</code> and <code>footer</code>. Both started from <code>main</code>.</p>
<p>Merge <b><code>header</code> first</b>, then <code>footer</code>. Watch the graph after each one: the two merges come out looking completely different. Why?</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'index.html': '<h1>Shop</h1>\n' }, 'Initial commit')
        .run('git switch -c header')
        .commit({ 'header.html': '<header>Shop</header>\n' }, 'Add header')
        .commit({ 'header.html': '<header>Shop · Sale!</header>\n' }, 'Announce sale in header')
        .run('git switch main', 'git switch -c footer')
        .commit({ 'footer.html': '<footer>© Shop</footer>\n' }, 'Add footer')
        .run('git switch main').w,
    goals: [
      { text: 'header was merged as a fast-forward (its commits are on main\'s main line)', check: (w) => firstParentChain(w, branchTip(w, 'main')).some((id) => w.objects[id].message === 'Announce sale in header') },
      { text: 'footer is merged too', check: (w) => hasMessage(w, branchTip(w, 'main'), 'Add footer') },
      { text: 'main ends on a merge commit (two parents)', check: (w) => { const t = branchTip(w, 'main'); return !!t && w.objects[t].parents.length === 2; } },
    ],
    hints: ['Make sure you are on main (git branch), then git merge header.', 'main had no new commits since header split off, so git can just slide main forward. Then git merge footer.', 'footer started from the OLD main, so now both sides have new commits: git has to create a merge commit.'],
    solution: ['git merge header', 'git merge footer'],
    lesson: 'Fast-forward = the target simply moves its label forward (no new commit). A merge commit is only needed when both sides have new commits. git merge --no-ff forces a merge commit; --ff-only refuses to make one.',
  },
  {
    id: 'first-push',
    chapter,
    title: 'Share a new branch',
    story: `<p>You built search on a new local branch, <code>search</code>. Time to put it on the server so a teammate can review it.</p>
<p>Try a plain <code>git push</code> first and read what git suggests.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'index.html': '<h1>Shop</h1>\n' }, 'Initial commit')
        .withRemote()
        .run('git switch -c search')
        .commit({ 'search.js': 'export const search = (items, q) => items.filter((i) => i.name.includes(q));\n' }, 'Add search').w,
    goals: [
      { text: 'origin has a search branch with your commit', check: (w) => remoteHas(w, 'search', 'Add search') },
      { text: 'Your local search branch tracks origin/search', check: (w) => w.repo?.upstream.search === 'origin/search' },
    ],
    hints: ['A new branch has no "upstream" yet, so git does not know where plain git push should go.', 'git push -u origin search (-u is short for --set-upstream)'],
    solution: ['git push', 'git push -u origin search'],
    lesson: '-u links your local branch to origin/<branch>, so later a plain git push / git pull just work. Tired of typing it? git config --global push.autoSetupRemote true.',
  },
  {
    id: 'pull-by-hand',
    chapter,
    title: 'What does git pull actually do?',
    story: `<p>Sam says they pushed two commits. But <code>git status</code> says "Your branch is up to date". Is git lying?</p>
<p>Instead of <code>git pull</code>, do it in slow motion: <b>fetch</b>, look at what came in, then <b>merge</b> it yourself.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'README.md': '# Shop\n' }, 'Initial commit')
        .withRemote()
        .teammatePush(sam, 'main', { 'README.md': '# Shop\n\n## Install\nnpm install\n' }, 'Add install steps')
        .teammatePush(sam, 'main', { LICENSE: 'MIT\n' }, 'Add license').w,
    goals: [
      { text: 'Your origin/main label knows about Sam\'s commits (fetched)', check: (w) => !!w.repo && w.repo.remoteBranches['origin/main'] === w.remote?.branches.main },
      { text: 'Your main has Sam\'s commits', check: (w) => hasMessage(w, branchTip(w, 'main'), 'Add license') },
      { text: 'History stays a straight line (fast-forward, no merge commit)', check: (w) => isLinear(w, branchTip(w, 'main')) },
    ],
    hints: ['git status only compares with what you knew at your LAST fetch. Run git fetch.', 'git status again, then git log --oneline main..origin/main shows exactly what came in.', 'git merge origin/main'],
    solution: ['git status', 'git fetch', 'git status', 'git log --oneline main..origin/main', 'git merge origin/main'],
    lesson: 'git pull = git fetch (download, move origin/* labels) + git merge origin/<branch> (or rebase). Fetching is always safe; it never touches your branches or files.',
  },
];
