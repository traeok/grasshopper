import type { HistoryEntry } from "../history/parse.ts";
import { splitCommands, tokenize } from "../history/tokenize.ts";
import type { DropCategory } from "../privacy/classify.ts";
import { WRAPPERS } from "../privacy/dictionary.ts";
import type { Profile } from "./types.ts";

export type RedFlagKind = "inline-secret" | "possible-password-typed" | "secret-file-view" | "curl-pipe-shell" | "chmod-777" | "rm-rf-risky" | "force-push" | "no-verify" | "reset-hard" | "git-clean-force" | "tls-disabled" | "sudo-npm-global" | "docker-privileged" | "eval-remote" | "history-truncated" | "leading-space-recorded";

export function detectRedFlags(entries: HistoryEntry[], classifications: { drop: DropCategory | null; secretRule?: string }[], environment: Profile["environment"]): Profile["redFlags"] {
  const counts = new Map<RedFlagKind, number>();
  for (let index = 0; index < entries.length; index++) {
    const text = entries[index]!.text;
    const hits = new Set<RedFlagKind>();
    const drop = classifications[index]?.drop;
    if (drop === "secret") hits.add("inline-secret");
    if (drop === "possible-password") hits.add("possible-password-typed");
    if (drop === "leading-space" && environment.history.ignoreSpace !== true) hits.add("leading-space-recorded");
    if (/(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i.test(text) || /\|\s*(?:iex|Invoke-Expression)\b/i.test(text)) hits.add("curl-pipe-shell");
    if (/\beval\s+"?\$\((?:curl|wget)/.test(text)) hits.add("eval-remote");
    if (/\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0\b|\bstrict-ssl\s+false\b|\bhttp\.sslVerify(?:=|\s+)false\b|\bGIT_SSL_NO_VERIFY\s*=|(?:^|\s)--trusted-host(?:\s|=|$)|\bPYTHONHTTPSVERIFY\s*=\s*["']?0\b/i.test(text)) hits.add("tls-disabled");
    for (const command of splitCommands(tokenize(text, environment.shell))) {
      const words = command.words.map(word => word.value);
      let effective = 0;
      let sudo = false;
      while (effective < words.length && WRAPPERS.has(words[effective]!.replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase())) {
        if (words[effective]!.toLowerCase() === "sudo") sudo = true;
        effective++;
        while (words[effective]?.startsWith("-")) effective++;
        while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[effective] ?? "")) effective++;
      }
      const name = words[effective]?.replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
      const args = words.slice(effective + 1);
      const flags = args.filter(arg => arg.startsWith("-"));
      const short = flags.filter(arg => /^-[A-Za-z]+$/.test(arg)).map(arg => arg.slice(1)).join("");
      if (/^(?:cat|gc|get-content|less|more|bat|head|tail|type|code|vim|nano|notepad)$/.test(name ?? "") && /(?:\.env(?:\.\w+)?|id_rsa|id_ed25519|id_ecdsa|\.pem|\.key|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|credentials(?:\.json)?|\.kube[\\/]config|\.docker[\\/]config\.json)(?:\s|$)/.test(args.join(" "))) hits.add("secret-file-view");
      if (name === "chmod" && (/^(?:-\w+\s+)*0?777\b/.test(args.join(" ")) || args.some(arg => arg.includes("a+rwx")))) hits.add("chmod-777");
      if (name === "rm" && (/[rR]/.test(short) || flags.includes("--recursive")) && (short.includes("f") || flags.includes("--force")) && args.some(arg => /^(?:\/|\/\*|~|~\/|~\/\*|\*|\.|\.\.)$/.test(arg) || arg.startsWith("$"))) hits.add("rm-rf-risky");
      if (name === "git") {
        const sub = args.find(arg => !arg.startsWith("-"));
        if (sub === "push" && (short.includes("f") || flags.includes("--force")) && !flags.includes("--force-with-lease") && !flags.includes("--force-if-includes")) hits.add("force-push");
        if ((sub === "commit" || sub === "push" || sub === "merge" || sub === "rebase") && (flags.includes("--no-verify") || sub === "commit" && short.includes("n"))) hits.add("no-verify");
        if (sub === "reset" && flags.includes("--hard")) hits.add("reset-hard");
        if (sub === "clean" && short.includes("f") && /[dx]/.test(short)) hits.add("git-clean-force");
      }
      if (name === "curl" && (short.includes("k") || flags.includes("--insecure")) || name === "wget" && flags.includes("--no-check-certificate")) hits.add("tls-disabled");
      if (sudo && name === "npm" && (args[0] === "i" || args[0] === "install") && (short.includes("g") || flags.includes("--global"))) hits.add("sudo-npm-global");
      if (name === "docker" && args[0] === "run" && flags.includes("--privileged")) hits.add("docker-privileged");
    }
    for (const kind of hits) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const limit = environment.history.fileLimit;
  if (limit !== null && limit <= 2000 && entries.length >= 0.98 * limit || environment.shell === "bash" && limit === null && entries.length === 500) counts.set("history-truncated", 1);
  return [...counts].map(([kind, n]) => ({ kind, n }));
}
