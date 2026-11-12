import { COMMON_LONG_FLAGS, SAFE_ENV_NAMES, SAFE_LITERALS, SAFE_LITERAL_RES, TOOL_PROBES, PACKAGE_MANAGER_PROBES, isKnownWord } from "./dictionary.ts";

// Closed wire vocabulary: additions here require a corresponding schema field or public enum.
export const SCHEMA_WORDS = new Set(`schema environment shell shellVersion platform keymap frameworks packageManagers installedTools history entries timestamps sizeLimit fileLimit ignoreSpace ignoreDups appendIncremental shared options window kept dropped spanDays topCommands topSubcommands c n templates t len aliasCandidates savedChars coveredBy sequences seq repeats runs maxRun paths p depth viaCd hosts h via aliases a expands used fullFormUsed functions f typos typed meant slow avgSec signals redFlags kind trends available reason basis recentDays baselineDays rising falling new recent baseline memory category status evidence tool
windows windows-gitbash macos linux wsl powershell bash zsh emacs vi unknown oh-my-zsh starship powerlevel10k autocd cdspell globstar histappend correct autopushd extendedglob ghop-profile/1 collecting ingestion-days
workflow alias tip red-flag tool shortcut accepted implemented discarded low medium high
path url host cmd fn arg ref pkg script var str num val glob flag subshell heredoc
historyGrep retypedWithSudo lastArgReuse cdUp cdUpChains cdThenLs mkdirThenCd clearScreen exitCommand uselessCat grepRecursive findByName psGrep manLookups helpLookups consecutiveRepeats longPipelines cdHome gitStatus gitAddAll dirStack
inline-secret possible-password-typed secret-file-view curl-pipe-shell chmod-777 rm-rf-risky force-push no-verify reset-hard git-clean-force tls-disabled sudo-npm-global docker-privileged eval-remote history-truncated leading-space-recorded`.split(/\s+/));
for (const word of [...TOOL_PROBES, ...PACKAGE_MANAGER_PROBES]) SCHEMA_WORDS.add(word);
const operators: Record<string, true> = Object.fromEntries("| || && ; & |& > >> < << <<< 2> 2>> &> &>> 2>&1 >&2 ( ) ;;".split(" ").map(s => [s, true]));
const placeholder = /^<(path|url|host|cmd|alias|fn|arg|ref|pkg|script|var|str|num|val|glob|flag|subshell|heredoc)(#\d{1,3})?>$/;
export function isSafeToken(tok: string): boolean {
  if (!tok) return false;
  if (isKnownWord(tok) || SCHEMA_WORDS.has(tok) || SAFE_LITERALS.has(tok) || SAFE_LITERAL_RES.some(re => re.test(tok)) || Object.hasOwn(operators, tok)) return true;
  if (/^\d+(\.\d+){0,2}$/.test(tok) || /^-[A-Za-z]{1,4}$/.test(tok) || COMMON_LONG_FLAGS.has(tok) || placeholder.test(tok)) return true;
  if (/^(?:[1-6*]>>?|[1-6*]>&[1-6])$/.test(tok)) return true;
  const equals = tok.indexOf("=");
  if (equals > 0 && tok.slice(equals + 1) === "<val>") {
    const name = tok.slice(0, equals);
    return COMMON_LONG_FLAGS.has(name) || SAFE_ENV_NAMES.has(name) || /^<var(#\d{1,3})?>$/.test(name);
  }
  return false;
}
export function isSafeString(text: string): boolean { return text.length > 0 && text.split(" ").every(isSafeToken); }
