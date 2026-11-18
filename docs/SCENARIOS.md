# Scenario catalog

Levels already playable are marked ✅. The rest are ideas. **Engine** says whether the simulator can already run the scenario (🟢 ready, just write the level) or needs a new feature (🟡, named in the cell).

Each level = a `setup()` that builds the world with real commands, an optional `prelude` (commands "you already typed", replayed in the terminal so the learner sees how the mess happened), optional `events` (teammates pushing mid-level), plus `goals` (checks on the final state), `hints`, `solution` and a one-paragraph `lesson`. Levels live in `src/levels/basics.ts`, `undo.ts`, `team.ts`, `pack2.ts` (the levels that use tags, `clean`, `--ours/--theirs`, `revert -m` and friends) and `history.ts` (interactive rebase). A solution step that starts with `✎ ` is text saved in the editor git opened (rebase todo or commit message), not a terminal command. Every level's solution is run by `npm test`.

---

## 1. Basics

| # | Scenario | What the learner does | Engine |
|---|---|---|---|
| ✅ | **Who are you?** First commit fails with "Author identity unknown" | `git config --global user.name/email` | 🟢 |
| ✅ | **Staging is a choice**: commit only part of your changes | `git add <file>` vs `git add .` | 🟢 |
| ✅ | **Work vs personal email**: this repo needs your work email | `git config user.email` (no `--global`), then `commit --amend --reset-author` | 🟢 |
| ✅ | **Aliases**: make `git st` / `git lg` | `git config alias.*` | 🟢 |
| ✅ | **Fast-forward vs merge commit**: same merge, two shapes | `merge`, `merge --no-ff`, `merge --ff-only` | 🟢 |
| ✅ | **What does `git pull` actually do?** | `fetch` → look at `main..origin/main` → `merge` by hand | 🟢 |
| | **Detached HEAD tour**: look at an old commit, then come back | `checkout <sha>`, `switch -` | 🟢 |

## 2. Undo & rescue (solo mistakes)

| # | Scenario | What the learner does | Engine |
|---|---|---|---|
| ✅ | **Committed a secret** (unpushed) | `reset --soft HEAD~1` + `restore --staged`, `.gitignore` | 🟢 |
| ✅ | **`reset --hard` ate two commits** | `reflog` → `reset --hard HEAD@{1}` | 🟢 |
| ✅ | **Committed on the wrong branch** | `branch x` → `reset --hard origin/main` → `switch x` | 🟢 |
| | **Reset quiz**: the same undo three ways | `--soft` vs `--mixed` vs `--hard`, goals check index/working dir separately | 🟢 |
| ✅ | **Deleted a branch with `-D`** | read "Deleted branch x (was abc1234)" or reflog → `branch x abc1234` | 🟢 |
| ✅ | **Commits made on detached HEAD, then switched away** | spot the "leaving 1 commit behind" warning → `branch rescue <sha>` | 🟢 |
| | **`git restore .` wiped an afternoon of work** | *Can't* be recovered: the level is about learning WHY (uncommitted ≠ safe), then stash/commit WIP habits | 🟢 |
| ✅ | **Accidentally committed `node_modules/`** | `.gitignore` + `git rm -r --cached node_modules` + amend | 🟢 |
| ✅ | **Typo in the last commit + a forgotten file** | `add` + `commit --amend -m` (and why that's only OK before pushing) | 🟢 |
| ✅ | **Undo a merge you haven't pushed** | `reset --hard ORIG_HEAD` | 🟢 |
| ✅ | **Rebase "succeeded" but you resolved a conflict wrong** (`--ours` during a rebase is upstream!) | `reset --hard ORIG_HEAD`, redo with `--theirs` | 🟢 |
| ✅ | **Dropped a stash by mistake** | use the sha printed by `stash drop` (or `fsck --lost-found`) → `stash apply <sha>` | 🟢 |
| ✅ | **Throw away untracked junk** (but keep notes.md and .env) | `git clean -nd` (dry run!) then `-fd <paths>` | 🟢 |
| ✅ | **Squash 4 "wip" commits before opening a PR** | `reset --soft main` + one commit | 🟢 (a `rebase -i` version needs 🟡 interactive rebase UI) |
| | **Which commit broke it?** | `git bisect` with a fake test command | 🟡 `bisect` |

## 3. Team life (other people exist)

| # | Scenario | What the learner does | Engine |
|---|---|---|---|
| ✅ | **Push rejected (fetch first)**: teammate pushed before you | `pull --rebase` / `--no-rebase`, the "divergent branches" prompt | 🟢 |
| ✅ | **Pull blocked by local changes** | `stash` → `pull` → `stash pop` | 🟢 |
| ✅ | **Merge conflict** on the same line | resolve markers, `add`, `commit`, `push` | 🟢 |
| ✅ | **Rebase conflict → continue** | resolve, `add`, `rebase --continue` | 🟢 |
| ✅ | **Get me out of this rebase** | `rebase --abort` | 🟢 |
| ✅ | **Undo a pushed commit** on a protected `main` | `revert`, not `reset` + force | 🟢 |
| ✅ | **"Your branch is up to date"… but it isn't** | status only knows your last fetch → `git fetch` then status again | 🟢 |
| ✅ | **First push of a new branch** | `push` fails with "no upstream" → `push -u origin feat` (or `push.autoSetupRemote`) | 🟢 |
| | **`git pull` says "no tracking information"** | `branch -u origin/feat` | 🟢 |
| ✅ | **Review a teammate's branch** (and they push again while you look) | `fetch` → `switch their-branch` (auto-tracks) | 🟢 |
| | **Trap: `checkout origin/feat`** then commit there | detached HEAD on a remote-tracking ref → rescue to a real branch | 🟢 |
| ✅ | **Teammate deleted the remote branch you track** | `branch -vv` shows `[gone]` → `fetch --prune` → delete local | 🟢 |
| | **Your feature branch fell behind `main`** | choose: `merge main` (safe, shared branch) vs `rebase main` + `push --force-with-lease` (your own branch) | 🟢 |
| | **You amended an already-pushed commit** on your own branch | push rejected → `push --force-with-lease` | 🟢 |
| ✅ | **`--force-with-lease` saves you**: you amended, but a reviewer pushed a fix on top | lease rejects → `fetch` → `rebase origin/feat` → lease push | 🟢 |
| ✅ | **Teammate force-pushed and wiped YOUR commit** from origin | your local branch / reflog still has it → `cherry-pick` or re-push | 🟢 |
| | **You rebased a shared branch; teammate's pull is a mess** | play the teammate: `pull --rebase` drops already-applied patches | 🟢 |
| ✅ | **Pushed straight to `main`; repo requires pull requests** | rejected by server → `branch feat` → `reset --hard origin/main` → `push -u origin feat` | 🟢 |
| | **Every pull makes an ugly merge commit** | undo with `reset --hard ORIG_HEAD`, set `pull.rebase true` | 🟢 |
| ✅ | **Hotfix to the release branch** | `cherry-pick` a fix from `main` onto `release/1.2`; conflict → `--abort` or resolve | 🟢 |
| | **PR was squash-merged; `branch -d` says "not fully merged"** | understand squash merges, verify with `diff`, then `-D` | 🟢 (server squash via `teammatePush`) |
| ✅ | **A pushed merge broke production** | `revert -m 1 <merge>` | 🟢 |
| ✅ | **Re-land a feature whose merge was reverted** | revert the revert, then merge the fix | 🟢 |
| | **Pushed a secret** | rewrite is blocked/insufficient → rotate the key; lesson on why history rewriting doesn't un-leak | 🟢 (narrative) |
| ✅ | **Modify/delete conflict**: you edited a file Alex deleted | decide keep (`add`) or delete (`rm`) | 🟢 |
| ✅ | **Take theirs for a whole file** (a lockfile) in a conflict | `checkout --theirs` / `restore --theirs` | 🟢 |
| | **Default branch renamed `master` → `main` on the server** | `branch -m`, `fetch`, `branch -u origin/main` | 🟢 |
| | **Fork workflow**: sync your fork with `upstream` | second remote, `fetch upstream`, `rebase upstream/main` | 🟡 multiple remotes |
| ✅ | **Tagged the wrong commit for a release** | `tag -f`, `push --force origin <tag>` (or `--delete` + push) | 🟢 |
| ✅ | **Live teammate**: Alex pushes *while* you're resolving a conflict | `push` rejected again → second pull; teaches "integrate, then push quickly" | 🟢 (level `events`) |

## 4. Rewriting history (interactive rebase)

`git rebase -i` opens the todo list in the sandbox editor (with one-click pick / reword / edit / squash / fixup / drop buttons); reword and squash open a second editor for the message, and `edit` stops the rebase. Plain `git commit` without `-m` opens the editor too.

| # | Scenario | What the learner does | Engine |
|---|---|---|---|
| ✅ | **Clean up a pushed PR branch** | `rebase -i main` with `fixup`, then `push --force-with-lease` | 🟢 |
| ✅ | **Rename a commit from 2 commits ago** | `rebase -i HEAD~3`, `reword` | 🟢 |
| ✅ | **Drop a debug commit that dumps secrets** (before pushing) | `rebase -i main`, `drop` (vs `revert`, which keeps it in history) | 🟢 |
| ✅ | **Split one commit into two** | `edit` → `reset HEAD~1` → two commits → `rebase --continue` | 🟢 |
| | **Reorder commits so a fix lands before the feature that needs it** | move lines in the todo | 🟢 |
| | **Squash with a conflict in the middle** | resolve, `add`, `--continue`, then write the combined message | 🟢 |
| | **Oops, squashed the wrong commits** | `reset --hard ORIG_HEAD` (or reflog) and redo | 🟢 |
| | **`fixup!` commits + `--autosquash`** | `commit --fixup <sha>`, `rebase -i --autosquash` | 🟡 `--fixup`, `--autosquash` |

## 5. Boss levels (chain several skills)

- **Friday 5pm**: wrong branch + unpushed secret + teammate pushed meanwhile.
- **The rebase from hell**: a 4-commit rebase with 2 conflicts; abort, then redo it with `merge` instead.
- **Archaeology**: find who changed a line and why (`log`, `show`, `blame` 🟡), then revert just that commit.
- **`rm -rf .git`**: you deleted the repo. Re-clone 🟡 (`clone`) and recover unpushed work from… nowhere. The lesson: push your branches.

## Engine backlog (unlocks 🟡 levels)

Done: `rebase -i` (todo editor, reword/edit/squash/fixup/drop, `--edit-todo`), `git commit` without `-m` opens the editor, `revert -m`, `--ours/--theirs`, modify/delete conflicts, `tag`, `clean`, `fsck --lost-found`, `stash apply <sha>`, `commit --reset-author`, pull-request-only branches.

1. `blame`, `bisect`, `clone`, multiple remotes (`upstream` for forks)
2. `git diff` during a conflict (combined view)
3. `commit --fixup` + `rebase -i --autosquash`, `rebase --onto`

## Glossary of confusing flag pairs (good for a cheat-sheet page)

- `pull -r` = `pull --rebase` (there is no `push -r`)
- `push -f` (force: overwrite whatever is there) vs `--force-with-lease` (only overwrite what I last saw)
- `reset --soft / --mixed / --hard`: moves the branch / + resets staging / + resets your files
- `restore <f>` (discard working changes) vs `restore --staged <f>` (unstage)
- `merge --abort`, `rebase --abort`, `cherry-pick --abort`: the escape hatches
- `rebase --continue` (after `git add`) vs `rebase --skip` (drop this commit)
- `branch -d` (safe) vs `-D` (force)
- `--ours` / `--theirs`: in a merge ours = your branch; in a rebase they swap (ours = upstream)
- `revert -m 1`: undo a merge relative to its first parent (the branch merged into)
- `clean -n` (dry run) vs `-f` (really delete) vs `-x` (ignored files too)
