/** Short, friendly docs shown for `git <cmd> -h` and `git help`. */
export const COMMAND_DOCS: Record<string, { summary: string; usage: string[] }> = {
  init: { summary: 'Create a new repository (a hidden .git folder) in this directory.', usage: ['git init'] },
  config: {
    summary: 'Read or write settings. --global = every repo (~/.gitconfig), default = this repo (.git/config).',
    usage: [
      'git config --global user.name "Your Name"',
      'git config --global user.email you@example.com',
      'git config pull.rebase true        # make plain `git pull` rebase',
      'git config alias.st status         # then `git st` works',
      'git config --list',
    ],
  },
  status: { summary: 'Show what is staged, what is modified but unstaged, and what is untracked.', usage: ['git status'] },
  add: {
    summary: 'Copy file contents from your working directory into the staging area (the next commit).',
    usage: ['git add <file>', 'git add .            # everything here', 'git add -A           # including deletions'],
  },
  rm: { summary: 'Remove a file from the working directory and the staging area.', usage: ['git rm <file>', 'git rm --cached <file>   # stop tracking but keep the file'] },
  commit: {
    summary: 'Save the staging area as a new snapshot and move your branch forward to it.',
    usage: ['git commit -m "message"', 'git commit -am "message"   # stage tracked changes + commit', 'git commit --amend -m "better message"', 'git commit --amend --no-edit', 'git commit --amend --no-edit --reset-author   # use your current name/email'],
  },
  log: { summary: 'Show commit history.', usage: ['git log', 'git log --oneline', 'git log --oneline --all', 'git log main..origin/main   # commits on origin/main not on main', 'git log -- <file>           # only commits that touched <file>', 'git log -S "text"          # commits that added or removed "text"'] },
  reflog: {
    summary: 'Your local diary of everywhere HEAD has been. The #1 recovery tool.',
    usage: ['git reflog', 'git reset --hard HEAD@{1}   # go back to where you were one step ago', 'git branch rescue HEAD@{3}  # save an old position as a branch'],
  },
  branch: {
    summary: 'List, create, rename or delete branches. A branch is just a movable label on a commit.',
    usage: ['git branch', 'git branch -vv          # with upstream info', 'git branch <name> [<start>]', 'git branch -d <name>     # -D to force', 'git branch -m <new-name>', 'git branch -f <name> <commit>', 'git branch -u origin/<name>'],
  },
  switch: { summary: 'Move to another branch.', usage: ['git switch <branch>', 'git switch -c <new-branch>', 'git switch -', 'git switch --detach <commit>'] },
  checkout: {
    summary: 'The older do-everything command: switch branches, detach HEAD, or restore files.',
    usage: ['git checkout <branch>', 'git checkout -b <new-branch>', 'git checkout <commit>      # detached HEAD', 'git checkout -- <file>     # discard changes (like git restore)', 'git checkout --ours <file>   # in a conflict: take your side', 'git checkout --theirs <file> # in a conflict: take their side'],
  },
  restore: {
    summary: 'Restore files: discard working changes, or unstage.',
    usage: ['git restore <file>            # discard unstaged changes ⚠️', 'git restore --staged <file>   # unstage, keep changes', 'git restore --source=HEAD~1 <file>', 'git restore --ours <file>     # conflict: take one side', 'git restore --theirs <file>'],
  },
  reset: {
    summary: 'Move the current branch to another commit. The mode decides what else gets reset.',
    usage: [
      'git reset --soft HEAD~1    # undo commit, keep changes staged',
      'git reset HEAD~1           # (--mixed) undo commit, keep changes unstaged',
      'git reset --hard HEAD~1    # undo commit AND throw away changes ⚠️',
      'git reset <file>           # unstage a file',
      'git reset --hard HEAD@{1}  # undo the last reset',
    ],
  },
  merge: {
    summary: 'Join another branch into the current one (fast-forward if possible, else a merge commit).',
    usage: ['git merge <branch>', 'git merge --no-ff <branch>', 'git merge --ff-only <branch>', 'git merge --abort', 'git merge --continue'],
  },
  rebase: {
    summary: 'Replay your commits on top of another commit, producing new commits and a linear history.',
    usage: ['git rebase <branch>', 'git rebase -i HEAD~3    # edit the last 3 commits: squash, reword, reorder, drop', 'git rebase -i main      # everything since main', 'git rebase --continue   # after fixing a conflict + git add', 'git rebase --skip', 'git rebase --edit-todo  # change the rest of the plan', 'git rebase --abort      # put everything back'],
  },
  'cherry-pick': { summary: 'Copy one commit onto the current branch.', usage: ['git cherry-pick <commit>', 'git cherry-pick --continue', 'git cherry-pick --abort'] },
  revert: {
    summary: 'Create a new commit that undoes an earlier one. Safe for shared branches: no history rewrite.',
    usage: ['git revert <commit>', 'git revert HEAD', 'git revert -m 1 <merge-commit>   # undo a whole merge', 'git revert --continue', 'git revert --abort'],
  },
  stash: {
    summary: 'Shelve uncommitted changes so you get a clean working tree, then bring them back later.',
    usage: ['git stash', 'git stash -u        # include untracked files', 'git stash -m "msg"', 'git stash list', 'git stash pop', 'git stash apply', 'git stash drop', 'git stash apply <sha>   # bring back a dropped stash'],
  },
  tag: {
    summary: 'Name a commit permanently (e.g. a release). Unlike branches, tags never move by themselves.',
    usage: ['git tag', 'git tag v1.0            # tag HEAD', 'git tag v1.0 <commit>', 'git tag -d v1.0', 'git tag -f v1.0 <commit>  # move it', 'git push origin v1.0    # tags are not pushed by default', 'git push origin --delete v1.0'],
  },
  clean: {
    summary: 'Delete untracked files. There is no undo, so always dry-run first.',
    usage: ['git clean -n      # dry run: list what would go', 'git clean -nd     # including untracked folders', 'git clean -fd     # really delete files + folders ⚠️', 'git clean -fdx    # also ignored files ⚠️'],
  },
  blame: {
    summary: 'Show, for every line of a file, the last commit that changed it and who made it.',
    usage: ['git blame <file>', 'git blame -L 10,20 <file>   # only lines 10-20', 'git blame <commit> <file>   # as of an older commit'],
  },
  bisect: {
    summary: 'Binary-search history for the commit that broke something. Git checks out commits, you say good or bad.',
    usage: ['git bisect start', 'git bisect bad              # the current commit is broken', 'git bisect good <commit>    # this one worked', 'git bisect good / bad       # after testing each commit git checks out', 'git bisect run npm test     # let git test every step for you', 'git bisect reset            # back to where you started'],
  },
  fsck: { summary: 'Check the object database. With --lost-found it lists dangling commits (e.g. dropped stashes).', usage: ['git fsck --lost-found'] },
  fetch: { summary: "Download new commits from the remote and update origin/* labels. Doesn't touch your branches or files.", usage: ['git fetch', 'git fetch --prune'] },
  pull: {
    summary: 'fetch + merge (or + rebase). Brings origin changes into your current branch.',
    usage: ['git pull', 'git pull --rebase   # same as -r', 'git pull --no-rebase', 'git pull --ff-only'],
  },
  push: {
    summary: 'Upload your commits and move the branch on the remote.',
    usage: ['git push', 'git push -u origin <branch>    # first push of a new branch', 'git push --force-with-lease    # safer force push', 'git push --force               # dangerous ⚠️', 'git push origin --delete <branch>', 'git push origin <tag>', 'git push --tags'],
  },
  remote: { summary: 'Manage remote nicknames (origin is just a name for a URL).', usage: ['git remote -v', 'git remote add origin <url>', 'git remote remove origin'] },
  diff: { summary: 'Show line changes.', usage: ['git diff               # working dir vs staging', 'git diff --staged      # staging vs last commit', 'git diff main feature'] },
  show: { summary: 'Show a commit and its changes.', usage: ['git show', 'git show <commit>'] },
};
