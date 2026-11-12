import { ToolRef } from "../llm/schema.ts";
import type { StoredRecommendation } from "./store.ts";

export type VerifiedTool = NonNullable<StoredRecommendation["tool"]>;
type CheckStatus = "verified" | "rejected" | "unknown";
type CheckName = "github" | "npm" | "winget" | "brew";
interface CheckResult { name: CheckName; status: CheckStatus; license?: string | null }

export interface VerificationSpawnOptions {
  stdin: "ignore";
  stdout: "pipe";
  stderr: "pipe";
  windowsHide: true;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeout: number;
}
export interface VerifyToolDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  spawn?: (argv: string[], options: VerificationSpawnOptions) => Pick<Bun.Subprocess<"ignore", "pipe", "pipe">, "stdout" | "stderr" | "exited">;
  platform?: NodeJS.Platform;
  which?: (name: string) => string | null;
}

const CHECK_TIMEOUT_MS = 8000;

/** Registry checks establish identity; no model-authored command is executed. */
export async function verifyTool(tool: ToolRef, deps: VerifyToolDeps = {}): Promise<VerifiedTool | null> {
  const parsed = ToolRef.parse(tool);
  const fetcher = deps.fetch ?? fetch;
  const spawn = deps.spawn ?? Bun.spawn;
  const platform = deps.platform ?? process.platform;
  const which = deps.which ?? Bun.which;
  const pending: Promise<CheckResult>[] = [];

  if (parsed.githubRepo !== undefined) {
    const repo = parsed.githubRepo;
    pending.push((async (): Promise<CheckResult> => {
      try {
        const response = await fetcher(`https://api.github.com/repos/${repo}`, {
          headers: { "User-Agent": "grasshopper-cli", Accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
        if (response.status === 404) return { name: "github", status: "rejected" };
        if (response.status !== 200) return { name: "github", status: "unknown" };
        const body: unknown = await response.json();
        if (typeof body !== "object" || body === null || !("license" in body)) return { name: "github", status: "unknown" };
        if (body.license === null) return { name: "github", status: "rejected" };
        const license = typeof body.license === "object" && "spdx_id" in body.license && typeof body.license.spdx_id === "string"
          ? body.license.spdx_id : null;
        return { name: "github", status: "verified", license };
      } catch {
        return { name: "github", status: "unknown" };
      }
    })());
  }

  if (parsed.npmPackage !== undefined) {
    const packageName = parsed.npmPackage;
    pending.push((async (): Promise<CheckResult> => {
      try {
        const response = await fetcher(`https://registry.npmjs.org/${packageName.replaceAll("/", "%2F")}`, {
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
        return { name: "npm", status: response.status === 200 ? "verified" : response.status === 404 ? "rejected" : "unknown" };
      } catch {
        return { name: "npm", status: "unknown" };
      }
    })());
  }

  if (parsed.wingetId !== undefined) {
    const id = parsed.wingetId;
    pending.push((async (): Promise<CheckResult> => {
      try {
        if (platform !== "win32" || !which("winget")) return { name: "winget", status: "unknown" };
        const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
        const child = spawn(["winget", "show", "--id", id, "--exact", "--source", "winget", "--accept-source-agreements", "--disable-interactivity"], {
          stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: process.env,
          signal, timeout: CHECK_TIMEOUT_MS,
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        const status = signal.aborted ? "unknown" : code === 0 ? "verified" : /No package found/i.test(`${stdout}\n${stderr}`) ? "rejected" : "unknown";
        return { name: "winget", status };
      } catch {
        return { name: "winget", status: "unknown" };
      }
    })());
  }

  if (parsed.brewFormula !== undefined) {
    const formula = parsed.brewFormula;
    pending.push((async (): Promise<CheckResult> => {
      const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
      const lookup = async (kind: "formula" | "cask"): Promise<number | null> => {
        try {
          return (await fetcher(`https://formulae.brew.sh/api/${kind}/${formula}.json`, { signal })).status;
        } catch {
          return null;
        }
      };
      const formulaStatus = await lookup("formula");
      if (formulaStatus === 200) return { name: "brew", status: "verified" };
      const caskStatus = await lookup("cask");
      return { name: "brew", status: caskStatus === 200 ? "verified" : formulaStatus === 404 && caskStatus === 404 ? "rejected" : "unknown" };
    })());
  }

  const results = await Promise.all(pending);
  if (results.every(result => result.status === "rejected")) return null;
  const checks: Record<string, CheckStatus> = {};
  for (const result of results) checks[result.name] = result.status;
  return {
    ...parsed,
    verification: {
      status: results.some(result => result.name !== "brew" && result.status === "verified") ? "verified" : "unverified",
      license: results.find(result => result.name === "github")?.license ?? null,
      checkedAt: new Date().toISOString(),
      checks,
    },
  };
}
