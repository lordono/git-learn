/** Chapter 5: detective work. Find who changed what, and which commit broke it. */
import { isAncestor, treeOf } from '../engine/repo';
import { runLine } from '../engine/shell';
import { runTests } from '../engine/tests';
import type { FileMap, World } from '../engine/types';
import { Scenario, TEAMMATES, YOU, branchTip, hasMessage, isClean, remoteHas, shaOf } from './scenario';
import type { Level } from './types';

const { alex, sam } = TEAMMATES;
const chapter = 'Detective work';

/** does the project's test suite pass on this snapshot? */
const testsPass = (w: World, tree: FileMap) => runTests({ ...w, files: tree }).ok;
const onMain = (w: World) => w.repo?.head.kind === 'branch' && w.repo.head.name === 'main' && !w.repo.bisect;

/**
 * Play a manual bisect the way a careful learner would: after each checkout,
 * run the tests and answer good/bad. Returns the commands typed.
 */
function manualBisect(w: World, start: string[]): string[] {
  const typed = [...start];
  for (const l of start) w = runLine(w, l).world;
  for (let i = 0; i < 20 && w.repo?.bisect && !w.repo.bisect.found; i++) {
    const step = runTests(w).ok ? 'git bisect good' : 'git bisect bad';
    typed.push('npm test', step);
    w = runLine(w, step).world;
  }
  return typed;
}

// ───── level 1: blame ─────

const SHIPPING_V1 = 'export const FREE_OVER = 50;\nexport const STANDARD = 4.99;\n\nexport function shipping(total) {\n  return total >= FREE_OVER ? 0 : STANDARD;\n}\n';
const blameSetup = () => {
  const s = new Scenario()
    .as(alex)
    .run('git init')
    .commit({ 'shipping.js': SHIPPING_V1, 'cart.js': 'export const cart = [];\n' }, 'Add shipping rules');
  s.withRemote();
  s.as(sam).commit({ 'shipping.js': SHIPPING_V1.replace('FREE_OVER = 50', 'FREE_OVER = 500') }, 'Black Friday load test: raise free-shipping threshold');
  s.as(YOU).commit({ 'cart.js': 'export const cart = [];\nexport const add = (x) => cart.push(x);\n' }, 'Add to cart');
  const v2 = SHIPPING_V1.replace('FREE_OVER = 50', 'FREE_OVER = 500').replace('STANDARD = 4.99;', 'STANDARD = 4.99;\nexport const EXPRESS = 12.99;');
  s.as(alex).commit({ 'shipping.js': v2 }, 'Add express shipping');
  s.as(sam).commit({ 'README.md': '# Shop\n\nShipping rules live in shipping.js.\n' }, 'Document shipping');
  s.as(YOU).run('git push');
  return s.w;
};
const BAD_SHIPPING = 'Black Friday load test: raise free-shipping threshold';

// ───── level 2: manual bisect ─────

const CART_GOOD = 'export const TAX = 0.08;\n\nexport function total(items) {\n  const sum = items.reduce((s, i) => s + i.price, 0);\n  return sum * (1 + TAX);\n}\n';
const CART_TEST = { name: 'cart total includes tax', file: 'cart.js', includes: 'sum * (1 + TAX)' };
const bisectSetup = () => {
  const s = new Scenario().run('git init');
  s.as(alex).commit({ 'cart.js': CART_GOOD, 'app.js': 'import "./cart";\n' }, 'Cart with tax').run('git tag v1.0');
  const authors = [alex, sam, YOU];
  const work: Array<[string, Record<string, string>]> = [
    ['Add product page', { 'product.js': 'export const product = {};\n' }],
    ['Style product page', { 'product.css': '.product { padding: 8px; }\n' }],
    ['Add search box', { 'search.js': 'export const search = () => [];\n' }],
    ['Refactor cart helpers', { 'cart.js': CART_GOOD.replace('sum * (1 + TAX)', 'sum * TAX') }],
    ['Add footer', { 'footer.html': '<footer>Shop</footer>\n' }],
    ['Bump dependencies', { 'package.json': '{ "name": "shop" }\n' }],
    ['Add wishlist', { 'wishlist.js': 'export const wishlist = [];\n' }],
    ['Fix typo in footer', { 'footer.html': '<footer>Shop Inc.</footer>\n' }],
    ['Add reviews', { 'reviews.js': 'export const reviews = [];\n' }],
    ['Lazy-load images', { 'app.js': 'import "./cart";\nimport "./lazy";\n' }],
    ['Add sitemap', { 'sitemap.xml': '<urlset/>\n' }],
  ];
  work.forEach(([msg, files], i) => s.as(authors[i % 3]).commit(files, msg));
  s.as(YOU);
  s.w.tests = [CART_TEST, { name: 'app loads the cart', file: 'app.js', includes: 'import "./cart"' }];
  return s.w;
};
const BAD_CART = 'Refactor cart helpers';

// ───── level 3: bisect run ─────

const PRICE_GOOD = 'export const price = (cents) => "$" + (cents / 100).toFixed(2);\n';
const runSetup = () => {
  const s = new Scenario().run('git init');
  s.as(sam).commit({ 'price.js': PRICE_GOOD, 'CHANGELOG.md': '# Changelog\n' }, 'Format prices').run('git tag v2.0');
  s.withRemote({ protect: ['main'] });
  const people = [alex, sam, YOU, alex];
  let log = '# Changelog\n';
  for (let i = 1; i <= 30; i++) {
    if (i !== 19) log += `- change ${i}\n`;
    const files: Record<string, string> =
      i === 19
        ? { 'price.js': 'export const price = (cents) => "$" + Math.round(cents / 100);\n', [`feature-${i}.js`]: `export const f${i} = true;\n` }
        : { 'CHANGELOG.md': log, [`feature-${i}.js`]: `export const f${i} = true;\n` };
    s.as(people[i % 4]).commit(files, i === 19 ? 'Tidy up number formatting' : `Feature ${i}`);
  }
  s.as(YOU).run('git push');
  s.w.tests = [{ name: 'prices show cents', file: 'price.js', includes: 'toFixed(2)' }];
  return s.w;
};
const BAD_PRICE = 'Tidy up number formatting';

export const DETECTIVE: Level[] = [
  {
    id: 'blame-fee',
    chapter,
    title: 'Who changed the shipping fee?',
    story: `<p>Support says free shipping now only kicks in at $500. It used to be $50. Nobody remembers changing it, and <code>shipping.js</code> has been edited several times since.</p>
<p>Find the commit that changed <code>FREE_OVER</code>, read why it was made, and undo <b>only that commit</b>. Keep everything after it (like express shipping), and push.</p>`,
    setup: blameSetup,
    goals: [
      { text: 'origin/main has FREE_OVER = 50 again', check: (w) => !!treeOf(w, w.remote?.branches.main)['shipping.js']?.includes('FREE_OVER = 50;') },
      { text: 'Express shipping (added later) is still there', check: (w) => !!treeOf(w, w.remote?.branches.main)['shipping.js']?.includes('EXPRESS') },
      { text: 'Undone with a new commit, not by rewriting history', check: (w) => remoteHas(w, 'main', BAD_SHIPPING) && remoteHas(w, 'main', `Revert "${BAD_SHIPPING}"\n\nThis reverts commit ${Object.values(w.objects).find((c) => c.message === BAD_SHIPPING)!.id}.`) },
    ],
    hints: [
      'git blame shipping.js shows, for every line, the commit that last changed it.',
      'Look at the FREE_OVER line, then read that commit: git show <sha>',
      'git revert <sha> undoes just that commit. Then git push.',
    ],
    solution: ['git blame shipping.js', `git show ${shaOf(blameSetup(), BAD_SHIPPING)}`, `git revert ${shaOf(blameSetup(), BAD_SHIPPING)}`, 'git push'],
    lesson: 'git blame answers "who last changed this line, and in which commit?". git show <sha> answers "why?". git log -S "FREE_OVER" finds every commit that added or removed that text, even ones blame can\'t see anymore.',
  },
  {
    id: 'bisect-manual',
    chapter,
    title: 'Which commit broke the tests?',
    story: `<p><code>npm test</code> fails on <code>main</code>: the cart total forgot the tax. It worked at the <code>v1.0</code> tag, 11 commits ago, and none of the commit messages look suspicious.</p>
<p>Use <code>git bisect</code> to find the first bad commit, go back to <code>main</code>, and revert that commit so the tests pass again.</p>`,
    setup: bisectSetup,
    goals: [
      { text: 'Bisect is finished: you are back on main', check: onMain },
      { text: 'main has a revert of the commit that broke the tax', check: (w) => hasMessage(w, branchTip(w, 'main'), `Revert "${BAD_CART}"\n\nThis reverts commit ${Object.values(w.objects).find((c) => c.message === BAD_CART)!.id}.`) },
      { text: 'npm test passes on main', check: (w) => testsPass(w, treeOf(w, branchTip(w, 'main'))) && isClean(w) },
    ],
    hints: [
      'git bisect start, then git bisect bad (main is broken), then git bisect good v1.0 (that tag worked).',
      'Git checks out a commit in the middle. Run npm test, then tell git: git bisect good or git bisect bad. Repeat.',
      'When git prints "<sha> is the first bad commit", run git bisect reset, then git revert <sha>.',
    ],
    solution: [...manualBisect(bisectSetup(), ['npm test', 'git bisect start', 'git bisect bad', 'git bisect good v1.0']), 'git bisect reset', `git revert ${shaOf(bisectSetup(), BAD_CART)} --no-edit`, 'npm test'],
    lesson: 'Bisect is a binary search over history: each answer halves the suspects, so 11 commits take about 4 tests, and 1000 commits only 10. Only "good" and "bad" matter, so the commit messages don\'t have to give anything away.',
  },
  {
    id: 'bisect-run',
    chapter,
    title: 'Let git find it: bisect run',
    story: `<p>Prices show <code>$13</code> instead of <code>$12.99</code>. It was right at <code>v2.0</code>, 30 commits ago. Testing 5 commits by hand is boring.</p>
<p><code>git bisect run npm test</code> lets git run the tests at every step by itself. Find the culprit, then fix <code>main</code> on origin. <code>main</code> is protected: no force pushes.</p>`,
    setup: runSetup,
    goals: [
      { text: 'Bisect is finished: you are back on main', check: onMain },
      { text: 'origin/main has a revert of the culprit', check: (w) => remoteHas(w, 'main', `Revert "${BAD_PRICE}"\n\nThis reverts commit ${Object.values(w.objects).find((c) => c.message === BAD_PRICE)!.id}.`) },
      { text: 'npm test passes on origin/main', check: (w) => testsPass(w, treeOf(w, w.remote?.branches.main)) },
      { text: 'Nothing else was lost (all 30 features still there)', check: (w) => !!w.remote && !!w.repo && isAncestor(w, w.repo.remoteBranches['origin/main'] ?? '', w.remote.branches.main) && 'feature-30.js' in treeOf(w, w.remote.branches.main) },
    ],
    hints: [
      'You can name bad and good straight away: git bisect start HEAD v2.0',
      'git bisect run npm test: a passing test means good, a failing one means bad.',
      'git bisect reset, then git revert <sha> and git push.',
    ],
    solution: ['git bisect start HEAD v2.0', 'git bisect run npm test', 'git bisect reset', `git revert ${shaOf(runSetup(), BAD_PRICE)} --no-edit`, 'git push'],
    lesson: 'git bisect run <command> automates the search: exit code 0 = good, anything else = bad (125 = skip). Any script that can tell "works" from "broken" turns hours of hunting into one command.',
  },
];
