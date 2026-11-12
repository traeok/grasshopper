<p align="center">
  <img src="assets/grasshopper.svg" alt="Grasshopper — a green grasshopper with leaf-shaped wings and folded jumping legs" width="256" height="192">
</p>

<h1 align="center">Grasshopper</h1>

<p align="center">
  A terminal mentor that learns from your shell history.<br>
  Small lessons. Better habits. Your next leap.
</p>

Grasshopper (`ghop`) turns patterns in your Bash, Zsh, or PowerShell history into practical recommendations: useful aliases, shorter workflows, safer habits, relevant tools, and keyboard shortcuts. Review the evidence, ask questions, and choose how to put each lesson into practice.

- **Grounded in your habits.** Recommendations cite patterns and counts from your shell usage.
- **Inspect before sending.** Preview the exact scrubbed model request with `--dry-run`.
- **Learn at your own pace.** Work through suggestions yourself, get guided help, or preview a supported automatic change.
- **Keep useful memory.** Accepted, implemented, and discarded topics stay remembered to avoid repeat suggestions.

## Get started

### Requirements

- [Bun](https://bun.sh/) **1.3.14 or newer**.
- **Bash, Zsh, or PowerShell** (PowerShell 7 or Windows PowerShell 5.1 with PSReadLine), including Git Bash on Windows. Fish integration is not supported.
- [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`) **18.4 or newer**, authenticated with a configured model. Grasshopper uses its `auth-gateway stdio` interface and defaults to the `@smol` model role.

If you do not have `omp` yet:

```sh
npm install -g @oh-my-pi/pi-coding-agent
omp login
```

Select a model for the `smol` role in `omp`, or set `llm.model` to a model available through your gateway.

### Install from source

From a local checkout of this repository:

```sh
bun install
bun link
ghop setup
```

`bun link` exposes both `ghop` and `grasshopper`. Setup previews the shell integration, offers to update your shell startup files, and lets you inspect the analysis payload before choosing whether to send it. Open a new terminal afterward, or use the activation command printed by setup (`source` for Bash/Zsh; dot-sourcing for PowerShell).

The first-run welcome and setup display a small, transparent version of the SVG logo in recent tty7, Kitty, Ghostty, WezTerm, Warp, and iTerm2 terminals, using the [Kitty graphics](https://sw.kovidgoyal.net/kitty/graphics-protocol/) or [iTerm2 inline image](https://iterm2.com/documentation-images.html) protocol. The image fits within 20 columns and 8 rows, preserving its aspect ratio. Windows Terminal, unknown terminals, tmux/screen, redirected output, and `NO_COLOR=1` retain the ASCII banner.

The Kitty-protocol logo is transient: Grasshopper explicitly deletes its own image when the command finishes, fails, or is cancelled, without clearing other applications' images. The welcome text remains. Images left behind by older versions were anonymous; reopen the affected terminal tab once to discard those.

To select the shell explicitly, use `ghop setup --shell bash`, `ghop setup --shell zsh`, or `ghop setup --shell powershell`. **`ghop setup --yes` installs integration without granting model-send consent.**

To try the payload preview before installing shell integration, run this from the checkout; it does not require `omp`:

```sh
bun run ghop analyze --dry-run --shell bash --histfile test/fixtures/history/realistic-bash.txt
```

### PowerShell

Run setup from the PowerShell engine you use:

```powershell
ghop setup --shell powershell
```

Setup installs into `$PROFILE.CurrentUserAllHosts`; PowerShell 7 and Windows PowerShell have separate profiles. Existing content is backed up before editing. Grasshopper does not change your execution policy; your policy must allow local profile scripts.

The hook preserves your prompt and captures the active PSReadLine history path and edit mode. Grasshopper reads PSReadLine's persistent history, including multiline commands—not the session-only `Get-History` list. Preview a custom history path directly with:

```powershell
ghop analyze --dry-run --shell powershell --histfile (Get-PSReadLineOption).HistorySavePath
```

PowerShell command shortcuts with fixed arguments are implemented as argument-forwarding functions. Automatic changes and undo reload into the active session when run through the `ghop` hook.

## Learn, review, apply

```sh
ghop analyze                       # Analyze your history; request consent if needed
ghop                               # Open the interactive recommendation review
ghop list                          # List recommendations without interactive review
ghop show <id>                     # Inspect a recommendation and its evidence
ghop chat <id>                     # Discuss the recommendation with the model
ghop accept <id> --mode self       # Take it on yourself
ghop done <id>                     # Mark your manual implementation complete
```

Replace `<id>` with a recommendation ID from `ghop list`. Acceptance supports three modes:

| Mode | Behavior |
| --- | --- |
| `self` | Show the steps for you to implement. |
| `guided` | Start a model conversation to walk through the change. |
| `auto` | Preview a supported shell change or tool install, then ask before applying it. |

Automatic changes are available only for supported, validated actions—not arbitrary model-generated commands. With `--mode auto`, `--yes` explicitly confirms the previewed change.

| Command | Purpose |
| --- | --- |
| `ghop discard <id>` | Dismiss a topic and remember not to suggest it again. |
| `ghop undo <id>` | Undo a Grasshopper-managed change; tool uninstalls require confirmation. |
| `ghop daily` | Show the daily selection and run eligible background analysis. |
| `ghop doctor` | Diagnose shell, history, and model-gateway setup. |
| `ghop --help` | See all commands; add `--help` to a command for its options. |

## Privacy and local data

Grasshopper builds a compressed profile rather than sending your history file as-is. History is classified, normalized against an allowlist, pseudonymized, and checked by an outbound guard before model requests. Placeholder mappings are kept locally so recommendations can display the relevant values on your machine.

**Model requests still leave your machine through the provider configured in `omp`.** Scrubbing reduces exposure; it is not a guarantee of anonymity. Inspect the payload before granting consent:

```sh
ghop analyze --dry-run --shell bash --histfile ~/.bash_history
```

Use `--shell zsh` with your Zsh history path, or `--shell powershell` with your PSReadLine history path, when appropriate. Dry runs print the request messages and filtering statistics without sending the request or saving analysis state. Background analysis requires consent and is gated by elapsed time and new history entries.

Dry-run statistics (on stderr) and `ghop doctor` list the ten most-used unknown command names and counts locally. These names remain pseudonymized in model requests until explicitly allowlisted. Commands found on `PATH` are not reported as command-name typos; finding an executable does not automatically allowlist it.

Configuration, recommendation state, analysis records, and placeholder mappings live under one local data directory:

| Platform | Default directory |
| --- | --- |
| Linux / macOS | `${XDG_DATA_HOME:-~/.local/share}/grasshopper` |
| Windows | `%LOCALAPPDATA%\grasshopper` (or `AppData\Local\grasshopper` under your home) |

The directory includes editable `config.json`, the SQLite database `ghop.db`, and generated shell files. Treat it as private: it contains local mappings and stored analysis data. Set `GRASSHOPPER_HOME` to use a different directory.

## Configuration

```sh
ghop config list
ghop config get llm.model
ghop config set analysis.auto false
ghop config set daily.enabled false
ghop config set automation.defaultMode guided
ghop config allow jj
```

`analysis.auto` disables background analysis; explicit `ghop analyze` remains available. `daily.enabled` controls the daily display. To skip shell integration entirely for a session, set `GHOP_DISABLE=1` before launching the shell (`$env:GHOP_DISABLE = '1'` in PowerShell).

Configuration is validated. Use `ghop config unset <key>` to restore a setting's default. Privacy controls include `privacy.extraSensitiveLiterals`, `privacy.extraDropPatterns`, and `privacy.allowWords`; inspect the current configuration before changing them.

`ghop config allow <words...>` adds public names to `privacy.allowWords`, preserving existing entries and removing duplicates. Dry-run and doctor output include a copyable command for the unknown names they find. Allow only names you are willing to send to the model; credential and secret filtering still applies.

## Development

```sh
bun install
bun run typecheck
bun test
```

Run the CLI directly with `bun run ghop --help`. Tests live in `test/`, with shell-history samples in `test/fixtures/history/`.

The terminal thumbnail is checked in as `assets/grasshopper.png`, so rendering needs no runtime image dependencies. After editing `assets/grasshopper.svg`, run `bun run art:generate` to regenerate the 160×120 transparent PNG.
