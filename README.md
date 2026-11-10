# Proof

Proof is a [Herdr](https://herdr.dev) side panel. For each space it shows the branch and the latest check recorded in `.proof/`. **Verified** means only this: the command you configured passed on this exact commit, and the worktree was clean. It does not mean the change is correct.

The panel reads git and `.proof`. It does not use the network. A repository cannot choose the Run command, and it cannot earn Verified by writing a timestamp or a script path.

## Install

Copy `mods/proof/` to `~/.config/herdr-app/mods/proof/`. Proof needs Herdr 0.1.14 or newer (`mod.json` records that, and the panel says so instead of running when the app is older). Then check it:

```sh
herdr-app check ~/.config/herdr-app/mods/proof
```

Herdr 0.1.14 does not insert a new mod into a shipped layout (`main`, `terminals`, `win98`), and cloning one did not place this panel by itself. Clone a layout and add the block to the root row. `command` here is the check Run will execute. The repository cannot replace it.

```sh
herdr-app do layout.clone --name main --as work
```

```json
{
  "id": "proof",
  "type": "block",
  "size": { "px": 320 },
  "min": 260,
  "content": { "mod": "proof", "props": { "command": "npm test" } }
}
```

`mod.json` asks for the right edge at 320px for a Herdr that docks personal layouts on its own.

The mod runs `git` in each space's worktree. Run executes the command from the layout props or from shared `proof.command`, via `sh -c` (`cmd /c` on Windows). Shot runs `herdr-app shot`, which captures the whole Herdr window, including every space on screen, and writes that picture into the worktree. Open uses `xdg-open` (macOS `open`, Windows `cmd /c start`) only for a png, jpg, jpeg, gif, webp, log, or txt file. Anything else opens the `.proof` folder. On another machine it writes `.proof` through `python3`.

## What the panel shows

One card per space:

- Branch, or `No git`, `detached` plus seven hex digits, `Git unavailable`, or `No folder`.
- `↑n` / `↓n` when the branch is ahead of or behind its upstream. Zeros are omitted. No upstream shows neither.
- `dirty` when the worktree has tracked or untracked changes, or the recorded run says it was dirty.
- The most urgent agent in the space, when there is one.
- The last check: command, pass or fail, when, duration.
- The log or screenshot path, and the picture when the shot is a png, jpg, webp, or gif and not a symlink.

The footer shows the full command Run will execute, wrapping rather than cutting it off. That command comes from the layout's `props.command`, or else shared `proof.command`. A `.proof/config.json` in the repo is ignored.

| Verdict | Meaning |
| --- | --- |
| Verified | Your configured command passed, `commit` matches HEAD, and both the recorded run and the worktree are clean. |
| Failing | `commit` matches HEAD and the recorded run failed. |
| Stale | `commit` names a different commit. The line under the branch still says pass or fail. |
| Unverified | No evidence, no `commit` inside a git repo, a dirty tree, a command other than the one you configured, a pass with no git commit to pin, or git could not be read. |

A missing `commit` inside a repository is Unverified, not Stale. `at` is not a substitute for `commit`. A timestamp later than now plus two minutes is ignored. A detached HEAD is judged by its sha like any other commit. With no git repository a failure is still Failing, and a pass is Unverified, because there is no commit.

## The `.proof` convention

Add `.proof/` to the repository's `.gitignore`. A committed `.proof` travels with a clone and is how a repo would try to ship a fake badge or a path for Open to launch. The panel still reads a gitignored `.proof`. On Linux a gitignored directory may not be watchable; the panel rereads it every 10 seconds.

Agents write this at the git toplevel (the folder itself, when it is not a repository). One file is enough.

`.proof/latest.json`:

```json
{
  "v": 1,
  "ok": true,
  "command": "npm test",
  "at": "2026-11-10T03:05:00.000Z",
  "duration_ms": 4200,
  "commit": "abcdef0123456789abcdef0123456789abcdef01",
  "dirty": false,
  "log": "last.log",
  "shot": "shots/window.png",
  "note": "42 passed"
}
```

- `v`: `1`. Missing is accepted. Any other value is rejected.
- `ok`: `true` / `false`, or an integer exit code (`0` passes).
- `command`: what ran. Verified requires this to equal the command you configured.
- `at`: ISO-8601 time the run finished. Times more than two minutes ahead are ignored.
- `duration_ms`: how long it took.
- `commit`: `git rev-parse HEAD` for the tree you checked. Required for Verified. Prefer the full sha.
- `dirty`: `true` when the tree was dirty at the run. Verified requires `false` or absent, and a clean tree now. Run always writes this.
- `log` and `shot`: paths relative to `.proof/`. No absolute paths, no `..`. Open will launch only png, jpg, jpeg, gif, webp, log, and txt. Anything else opens the folder.
- `note`: one short line. Control characters and bidi marks are stripped.

Unknown fields are ignored. A bad field is dropped. A file that is not a JSON object, is larger than 64 KiB, or has a `v` other than 1 is an error on the card and is not evidence.

Optional history, used only when `latest.json` is absent: `.proof/runs/<id>.json` with the same shape. The newest `at` wins.

Run writes `latest.json` and `last.log` for the command you configured, including `dirty`, and keeps an existing `shot`. Shot writes `shots/<time>.png` and sets `shot` without changing `ok`, `at`, or `commit`. Shot captures the whole Herdr window.

## Config

Run needs a shell command you set yourself:

1. The layout block's `props.command`
2. The shared value `proof.command`

Optional `props.timeout_ms` or shared `proof.timeout_ms` (default 120000, clamped between 1000 and 600000). A command longer than 240 characters is refused rather than cut down and run. The footer shows the whole command.

## Develop

```sh
node --test
```

The tests cover manifest parsing, verdicts, staleness, a dirty tree, a future timestamp, and a hostile `.proof` fixture. They use `node:test` and do not need a network or Herdr. GitHub Actions runs the same command.

## Publishing

The gallery reads a public repo with the topic `herdr-mod`, plus `RECIPE.md` and `preview.png` at the root. This repo is left private, with no topic, until the owner publishes it.
