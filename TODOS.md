# TODOs

Improvements identified from a read of the source and one `analyze --dry-run`. The test suite was not run as part of this review.

Suggested order for the remaining work: items 2 and 3 together, then 1.

## Fix first: unknown-command visibility and typo reporting (completed)

Previously, commands missing from the allowlist in `src/privacy/dictionary.ts` reached the model as `<cmd#N>` without local guidance. Commands within edit distance 1–2 of a listed command could also be reported as typos even when installed. The original dry-run with a history of `jj status`, `jj log`, `git status` repeated four times produced:

```
"typos":[{"typed":"jj","meant":"jq","n":8}]
"topCommands":[{"c":"<cmd>","n":8},{"c":"git","n":4}]
```

- [x] **Typo check:** skip the typo when `Bun.which(typed)` resolves (`src/profile/build.ts`, `recordTypo`).
- [x] **Allowlist prompt:** show the top unknown commands in the `--dry-run` stats and `ghop doctor`, with a one-step add to `privacy.allowWords` via `ghop config allow <words...>`.
- [x] **Dictionary gaps:** add `psql`, `mysql`, `sqlite3`, `redis-cli`, `ffmpeg`, `gpg`, `pandoc`, `adb`, `bazel`, `rclone`, `yt-dlp`, `nmap` and `mongosh`.

## Deeper signal

### 1. Capture per-command telemetry in the hook

Record exit code, duration, timestamp and a hashed working directory.

Today duration comes only from zsh extended history, and PowerShell entries never have timestamps. So `slow` is empty outside zsh, trends fall back to `ingestion-days`, and the 600-second sequence-contiguity guard is skipped.

- [ ] Record exit code, duration, timestamp and hashed working directory from the Bash, Zsh and PowerShell hooks.
- [ ] Use the new data for fail-then-retry patterns, exact typos (exit 127), per-project workflows and slow-command detection on every shell.
- [ ] Read Atuin's SQLite database as a history source for users who already have it.

### 2. Measure adoption

`ghop done` only flips a status, and `applied.aliasNames` is used only by undo.

- [ ] Join the per-alias `used` and `fullFormUsed` counts the profile already computes to implemented recommendations ("`gs` used 3 times, full form typed 41 times").
- [ ] Send that outcome in `memory`, which today carries only category, status, evidence and tool.
- [ ] Add a closed-enum discard reason; the free-text `discardReason` is never sent to the model.

### 3. Nudge in the moment

Contact is currently one daily banner.

- [ ] Write a lookup table into the managed shell file so the prompt hook prints a one-line reminder when the long form of an accepted alias is typed, with no process spawn.

## Trust and independence

### 4. Local rule tier and `ghop stats`

The 21 signals, 16 red flags, typos and sequences are deterministic but only reachable through the model, consent and `omp`.

- [ ] Add rule-based recommendations for the unambiguous signals (`uselessCat`, `cdThenLs`, `force-push`) that work offline with zero egress.
- [ ] Add `ghop stats` to show the locally computed profile.

### 5. Enforce grounding

`postprocess` in `src/llm/analyze.ts` stores recommendations even when no evidence reference survives validation. `renderCard` shows the model's own counts and never shows the stored evidence.

- [ ] Require at least one valid evidence reference per recommendation.
- [ ] Render counts from the stored profile instead of the model's rationale text.
- [ ] Log why each item was dropped in `postprocess`, as a quality metric for comparing prompts and models against saved `analyses.profile` rows.

### 6. Support any OpenAI-compatible endpoint

The gateway already speaks `/v1/chat/completions`.

- [ ] Add an `llm.baseUrl` option so Ollama, LM Studio or any OpenAI-compatible server can be used. A fully local model is the strongest version of the privacy pitch.

## Reach

### 7. Widen automatic actions

Installs cover winget, npm and brew, while 12 package managers are probed, so Linux without brew has no auto-install path.

- [ ] Add cargo, pipx/uv and scoop installs (sudo-free, public registries), with registry verification alongside the existing checks in `src/recs/verify-tool.ts`.
- [ ] Add typed actions for git aliases and `~/.ssh/config` host entries; `profile.hosts` already has the data.

### 8. Distribute it

The package is `private`, installs by `bun link`, and has no CI.

- [ ] Ship `bun build --compile` binaries to remove the Bun prerequisite.
- [ ] Add CI running `bun run typecheck` and `bun test`.
- [ ] Add Fish support.
