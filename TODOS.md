# TODOs

Improvements identified from a read of the source and one `analyze --dry-run`. The test suite was not run as part of this review.

Suggested next work: item 3.

## Fix first: unknown-command visibility and typo reporting (completed)

Previously, commands missing from the allowlist in `src/privacy/dictionary.ts` reached the model as `<cmd#N>` without local guidance. Commands within edit distance 1–2 of a listed command could also be reported as typos even when installed. The original dry-run with a history of `jj status`, `jj log`, `git status` repeated four times produced:

```
"typos":[{"typed":"jj","meant":"jq","n":8}]
"topCommands":[{"c":"<cmd>","n":8},{"c":"git","n":4}]
```

- [x] **Typo check:** without recorded command-not-found evidence, skip the typo when `Bun.which(typed)` resolves (`src/profile/build.ts`, `recordTypo`).
- [x] **Allowlist prompt:** show the top unknown commands in the `--dry-run` stats and `ghop doctor`, with a one-step add to `privacy.allowWords` via `ghop config allow <words...>`.
- [x] **Dictionary gaps:** add `psql`, `mysql`, `sqlite3`, `redis-cli`, `ffmpeg`, `gpg`, `pandoc`, `adb`, `bazel`, `rclone`, `yt-dlp`, `nmap` and `mongosh`.

## Deeper signal

### 1. Capture per-command telemetry in the hook (completed)

The Bash, Zsh and PowerShell hooks now record metadata-only command fingerprints, exit status, measured duration, timestamps, session identity and salted working-directory hashes. Matching metadata enriches saved shell history without persisting raw commands or directory paths. Atuin's SQLite history is also available as a read-only source.

- [x] Record exit code, duration, timestamp and hashed working directory from the Bash, Zsh and PowerShell hooks.
- [x] Use the new data for fail-then-retry patterns, exact typos (exit 127), per-project workflows and slow-command detection on every shell.
- [x] Read Atuin's SQLite database as a history source for users who already have it.

### 2. Measure adoption (completed)

Implemented recommendations now carry observed per-alias adoption in analysis memory. Counts cover the analyzed history window, not necessarily only commands since implementation; missing observations are not treated as zero usage.

- [x] Join the per-alias `used` and `fullFormUsed` counts the profile already computes to implemented recommendations ("`gs` used 3 times, full form typed 41 times").
- [x] Send that outcome in `memory`, with alias names pseudonymized against the current profile.
- [x] Add closed-enum discard reasons to the CLI, storage and model memory; migrate legacy free text to `other`.

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
