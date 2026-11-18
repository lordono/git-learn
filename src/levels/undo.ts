import { ancestors, headId, treeOf } from '../engine/repo';
import { Scenario, branchTip, hasMessage, isClean } from './scenario';
import type { Level } from './types';
import type { World } from '../engine/types';

const chapter = 'Undo & rescue';

const noCommitOnMainHas = (pred: (path: string) => boolean) => (w: World) => {
  const t = branchTip(w, 'main');
  return !!t && [...ancestors(w, t)].every((id) => !Object.keys(w.objects[id].tree).some(pred));
};

export const UNDO: Level[] = [
  {
    id: 'secret',
    chapter,
    title: 'Oops, I committed a secret',
    story: `<p>You ran <code>git add .</code> and committed <i>"Add login"</i>… and it swept up <code>secrets.env</code> with your API key. 😱</p>
<p>Good news: you haven't pushed. Rewrite that last commit so it has <code>login.js</code> but <b>not</b> <code>secrets.env</code>. Keep the file on disk (you need it locally), and stop it from ever being added again.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'README.md': '# Shop\n' }, 'Initial commit')
        .commit({ 'login.js': 'export function login(user) {\n  return api.post("/login", user);\n}\n', 'secrets.env': 'API_KEY=sk-test-not-a-real-key\n' }, 'Add login').w,
    goals: [
      { text: 'The latest commit has login.js', check: (w) => 'login.js' in treeOf(w, headId(w)) },
      { text: 'No commit on main contains secrets.env', check: noCommitOnMainHas((p) => p === 'secrets.env') },
      { text: 'secrets.env still exists on disk', check: (w) => 'secrets.env' in w.files },
      { text: '.gitignore lists secrets.env', check: (w) => !!w.files['.gitignore']?.split('\n').some((l) => l.trim() === 'secrets.env') },
    ],
    hints: [
      'Undo the commit but keep its changes: git reset --soft HEAD~1 (everything stays staged).',
      'Unstage just the secret: git restore --staged secrets.env',
      'echo "secrets.env" > .gitignore, then git add .gitignore and commit again.',
      'Alternative: git rm --cached secrets.env, then git commit --amend.',
    ],
    solution: ['git reset --soft HEAD~1', 'git restore --staged secrets.env', 'echo "secrets.env" > .gitignore', 'git add .gitignore login.js', 'git commit -m "Add login"'],
    lesson: 'Unpushed commits are yours to rewrite: reset --soft / --amend. If a secret was PUSHED, rewriting history is not enough: assume it leaked and rotate the key.',
  },
  {
    id: 'node-modules',
    chapter,
    title: 'Committed node_modules',
    story: `<p>You installed a package and committed with <code>git add .</code>. Now your commit contains the whole <code>node_modules/</code> folder (in real life: 40,000 files 🙃).</p>
<p>Fix the last commit so it only has your code, keep <code>node_modules</code> on disk (your app needs it), and make git ignore it from now on. Not pushed yet.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'package.json': '{ "name": "shop" }\n' }, 'Initial commit')
        .commit(
          {
            'package.json': '{ "name": "shop", "dependencies": { "left-pad": "1.3.0" } }\n',
            'index.js': "const leftPad = require('left-pad');\nconsole.log(leftPad('5', 3, '0'));\n",
            'node_modules/left-pad/index.js': 'module.exports = function leftPad(s, n, c) { /* … */ };\n',
            'node_modules/left-pad/package.json': '{ "name": "left-pad", "version": "1.3.0" }\n',
          },
          'Use left-pad',
        ).w,
    goals: [
      { text: 'The latest commit still has index.js and package.json', check: (w) => { const t = treeOf(w, headId(w)); return 'index.js' in t && !!t['package.json']?.includes('left-pad'); } },
      { text: 'No commit on main contains node_modules/', check: noCommitOnMainHas((p) => p.startsWith('node_modules/')) },
      { text: 'node_modules is still on disk', check: (w) => 'node_modules/left-pad/index.js' in w.files },
      { text: '.gitignore ignores node_modules', check: (w) => !!w.files['.gitignore']?.split('\n').some((l) => /^\/?node_modules\/?$/.test(l.trim())) },
    ],
    hints: [
      'First stop the folder being added again: echo "node_modules/" > .gitignore',
      'git rm -r --cached node_modules removes it from the staging area only (files stay on disk).',
      'git add .gitignore, then git commit --amend --no-edit rewrites the last commit.',
    ],
    solution: ['echo "node_modules/" > .gitignore', 'git rm -r --cached node_modules', 'git add .gitignore', 'git commit --amend --no-edit'],
    lesson: 'git rm --cached = "stop tracking, keep the file". .gitignore only affects untracked files: a file that is already committed stays tracked until you rm --cached it.',
  },
  {
    id: 'reflog-rescue',
    chapter,
    title: 'Rescue with reflog',
    story: `<p>You meant to unstage a file but your fingers typed <code>git reset --hard HEAD~2</code>. 💀 (Scroll up in the terminal to see it happen.)</p>
<p><code>git log</code> now only shows the homepage. The about and contact pages are gone from your folder too.</p>
<p>They are <b>not</b> gone. Bring both commits back.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'index.html': '<h1>Home</h1>\n' }, 'Add homepage')
        .commit({ 'about.html': '<h1>About us</h1>\n' }, 'Add about page')
        .commit({ 'contact.html': '<h1>Contact</h1>\n' }, 'Add contact page').w,
    prelude: ['git log --oneline', 'git reset --hard HEAD~2', 'git log --oneline'],
    goals: [
      { text: 'main contains "Add contact page" again', check: (w) => hasMessage(w, branchTip(w, 'main'), 'Add contact page') },
      { text: 'about.html and contact.html are back on disk', check: (w) => 'about.html' in w.files && 'contact.html' in w.files },
    ],
    hints: ["git log only shows commits main can reach. Try git reflog: it's a diary of everywhere HEAD has been.", 'The line just before "reset: moving to HEAD~2" is where you were. That is HEAD@{1}.', 'git reset --hard HEAD@{1}'],
    solution: ['git reflog', 'git reset --hard HEAD@{1}'],
    lesson: 'Committed work is almost impossible to lose: reflog remembers every position of HEAD (locally, for ~90 days). Uncommitted work is different: reset --hard really destroys it. Commit early, commit often.',
  },
  {
    id: 'deleted-branch',
    chapter,
    title: 'I deleted the wrong branch',
    story: `<p>Cleaning up old branches, you deleted <code>experiment</code>. Git even warned you it wasn't merged, and you forced it with <code>-D</code> anyway.</p>
<p>That branch had two days of GraphQL work on it. Get it back as a branch called <code>experiment</code>.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'api.js': 'export const get = (url) => fetch(url);\n' }, 'Initial commit')
        .run('git switch -c experiment')
        .commit({ 'graphql.js': 'export const query = (q) => post("/graphql", { q });\n' }, 'Try GraphQL client')
        .commit({ 'graphql.js': 'const cache = new Map();\nexport const query = (q) => cache.get(q) ?? post("/graphql", { q });\n' }, 'GraphQL: cache queries')
        .run('git switch main').w,
    prelude: ['git branch -d experiment', 'git branch -D experiment', 'git branch'],
    goals: [{ text: 'Branch experiment exists again with both GraphQL commits', check: (w) => hasMessage(w, branchTip(w, 'experiment'), 'GraphQL: cache queries') && hasMessage(w, branchTip(w, 'experiment'), 'Try GraphQL client') }],
    hints: ['Look at the -D output in the terminal: "(was 1a2b3c4)" is the commit the branch pointed to.', 'git branch experiment <that id>. Or find it in git reflog (the commit just before "checkout: moving from experiment to main").', 'git branch experiment HEAD@{1}'],
    solution: ['git reflog', 'git branch experiment HEAD@{1}'],
    lesson: 'Deleting a branch only deletes the label, not the commits. As long as you know the commit id (from the delete message or reflog), git branch <name> <id> recreates it.',
  },
  {
    id: 'detached-head',
    chapter,
    title: 'Commits to nowhere',
    story: `<p>You checked out an old commit to try a performance idea, made two commits… then switched back to <code>main</code>. Git printed a scary warning (scroll up).</p>
<p>Your two commits aren't on any branch. Save them on a new branch called <code>perf-experiment</code>.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'app.js': 'start();\n' }, 'Initial commit')
        .commit({ 'cart.js': 'export const cart = [];\n' }, 'Add cart')
        .commit({ 'checkout.js': 'export const checkout = () => {};\n' }, 'Add checkout').w,
    prelude: [
      'git checkout HEAD~2',
      'echo "lazyLoad(modules);" > perf.js',
      'git add perf.js',
      'git commit -m "Try lazy loading"',
      'echo "preload(critical);" >> perf.js',
      'git commit -am "Preload critical modules"',
      'git switch main',
    ],
    goals: [
      { text: 'Branch perf-experiment has both perf commits', check: (w) => hasMessage(w, branchTip(w, 'perf-experiment'), 'Preload critical modules') && hasMessage(w, branchTip(w, 'perf-experiment'), 'Try lazy loading') },
      { text: 'main is unchanged', check: (w) => { const t = branchTip(w, 'main'); return !!t && w.objects[t].message === 'Add checkout'; } },
    ],
    hints: ['The warning printed the id to use: git branch <new-branch-name> <id>.', 'Lost the id? git reflog. The entry right before "checkout: moving from … to main" is your last perf commit.', 'git branch perf-experiment HEAD@{1}'],
    solution: ['git reflog', 'git branch perf-experiment HEAD@{1}'],
    lesson: '"Detached HEAD" means HEAD points at a commit, not a branch. Commits made there are fine, they just need a label before you leave: git switch -c <name> while you are still there.',
  },
  {
    id: 'wrong-branch',
    chapter,
    title: 'Committed on the wrong branch',
    story: `<p>You built dark mode in two commits… directly on <code>main</code>. The team rule is: features go on their own branch.</p>
<p>Move both commits to a new branch <code>dark-mode</code> and put <code>main</code> back to where <code>origin/main</code> is. You haven't pushed yet.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'index.html': '<h1>Shop</h1>\n', 'theme.css': 'body { color: black; }\n' }, 'Initial commit')
        .withRemote()
        .commit({ 'theme.css': 'body { color: black; }\n.dark { color: white; }\n' }, 'Start dark mode')
        .commit({ 'theme.css': 'body { color: black; }\n.dark { color: white; background: #111; }\n' }, 'Finish dark mode').w,
    goals: [
      { text: 'Branch dark-mode has both dark mode commits', check: (w) => hasMessage(w, branchTip(w, 'dark-mode'), 'Finish dark mode') && hasMessage(w, branchTip(w, 'dark-mode'), 'Start dark mode') },
      { text: 'main is back at origin/main', check: (w) => !!w.repo && w.repo.branches.main === w.repo.remoteBranches['origin/main'] },
      { text: "You're on dark-mode with a clean working tree", check: (w) => w.repo?.head.kind === 'branch' && w.repo.head.name === 'dark-mode' && isClean(w) },
    ],
    hints: ['A branch is just a label. Make a new label where you are now: git branch dark-mode', 'Now move main back: git reset --hard origin/main (your commits are safe, dark-mode points to them)', 'git switch dark-mode'],
    solution: ['git branch dark-mode', 'git reset --hard origin/main', 'git switch dark-mode'],
    lesson: 'Branches are cheap labels on commits. "Moving commits" is really: put a new label on them, then move the old label back.',
  },
  {
    id: 'undo-merge',
    chapter,
    title: 'Undo a merge (before pushing)',
    story: `<p>You meant to type <code>git merge hotfix</code> but tab-completed <code>git merge experiment</code>. Now half-baked pricing code is on <code>main</code>.</p>
<p>You haven't pushed. Undo the merge so <code>main</code> is exactly as it was. Keep the <code>experiment</code> branch, though.</p>`,
    setup: () =>
      new Scenario()
        .run('git init')
        .commit({ 'price.js': 'export const price = (p) => p;\n' }, 'Initial commit')
        .run('git switch -c experiment')
        .commit({ 'pricing.js': 'export const surge = (p) => p * 3; // ???\n' }, 'Experimental surge pricing')
        .run('git switch main')
        .commit({ 'LICENSE': 'MIT\n' }, 'Add license')
        .withRemote().w,
    prelude: ['git merge experiment', 'git log --oneline'],
    goals: [
      { text: 'main no longer contains the experiment', check: (w) => !hasMessage(w, branchTip(w, 'main'), 'Experimental surge pricing') },
      { text: 'main is back exactly at origin/main', check: (w) => !!w.repo && w.repo.branches.main === w.repo.remoteBranches['origin/main'] && isClean(w) },
      { text: 'The experiment branch still exists', check: (w) => hasMessage(w, branchTip(w, 'experiment'), 'Experimental surge pricing') },
    ],
    hints: ['Merges, resets and rebases save where you were in ORIG_HEAD.', 'git reset --hard ORIG_HEAD (git reset --hard HEAD~1 also works here: a merge commit\'s first parent is where main was).'],
    solution: ['git reset --hard ORIG_HEAD'],
    lesson: 'Before pushing, an unwanted merge is just a commit you can reset away (ORIG_HEAD remembers the spot). After pushing, use git revert -m 1 <merge> instead.',
  },
];
