import { renderAlias } from "../apply/shells.ts";
import { spinner } from "@clack/prompts";
import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../core/config.ts";
import { tx } from "../core/db.ts";
import { EgressBlockedError, GhopError, OmpError } from "../core/errors.ts";
import type { Shell } from "../history/source.ts";
import { sanitizeAction } from "../llm/analyze.ts";
import { appendChat, buildChatMessages, extractActionProposal, loadAnalysis, loadChat } from "../llm/chat.ts";
import type { ChatMode } from "../llm/chat.ts";
import { OmpGateway } from "../llm/gateway.ts";
import { GUIDE_KICKOFF } from "../llm/prompts.ts";
import { actionKey } from "../llm/schema.ts";
import type { Action } from "../llm/schema.ts";
import { redactOutboundText } from "../privacy/egress.ts";
import { harvestSensitiveLiterals } from "../privacy/literals.ts";
import type { PseudonymMap } from "../privacy/pseudonyms.ts";
import { depseudonymizeForShell, loadPseudonyms, renderText, stripTerminalControls } from "../recs/pseudonyms.ts";
import { getRec, updateRec } from "../recs/store.ts";
import { PHRASES } from "../ui/art.ts";
import { confirm, requireTTY } from "../ui/prompts.ts";
import { renderMarkdownLite } from "../ui/render.ts";
import { danger, leaf, stem } from "../ui/style.ts";
import { performDiscard } from "./discard.ts";
import { performDone } from "./done.ts";
import { parseRecommendationId } from "./list.ts";
import { runAccept } from "./accept.ts";

/** Own readline only while asking; clack confirmations and spinners also own the TTY. */
async function readChatLine(): Promise<string | null> {
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const controller = new AbortController();
  const abort = () => controller.abort();
  const interrupt = () => input.close();
  input.once("close", abort);
  input.once("SIGINT", interrupt);
  try {
    return await input.question(leaf("you › "), { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && "code" in error && error.code === "ERR_USE_AFTER_CLOSE")) return null;
    throw error;
  } finally {
    input.removeListener("close", abort);
    input.removeListener("SIGINT", interrupt);
    input.close();
  }
}

function reportChatError(error: unknown): boolean {
  if (!(error instanceof OmpError) && !(error instanceof EgressBlockedError) && !(error instanceof GhopError)) return false;
  console.error(danger(stripTerminalControls(error.message)));
  return true;
}

function printProposal(action: Action, map: PseudonymMap, recId: number, shell: Shell): void {
  const resolve = (text: string) => stripTerminalControls(depseudonymizeForShell(text, map, shell));
  let lines: string[];
  if (action.type === "alias") {
    const command = resolve(action.command);
    lines = renderAlias(shell, action.name, command);
  } else if (action.type === "snippet") {
    lines = action.lines.map(resolve);
  } else {
    const argv = action.manager === "winget"
      ? ["winget", "install", "--id", action.id, "--exact", "--source", "winget"]
      : action.manager === "npm" ? ["npm", "install", "--global", action.id] : ["brew", "install", action.id];
    lines = [argv.join(" "), ...action.initLines.map(resolve)];
  }
  console.log("Proposed change:");
  for (const line of lines) console.log(`${stem("│ ")}${line}`);
  console.log(`Type /apply to update recommendation #${recId}.`);
}

export async function runChat(id: number, mode: ChatMode): Promise<void> {
  requireTTY();
  const recId = parseRecommendationId(id);
  let rec = getRec(recId);
  const config = loadConfig();
  const analysis = loadAnalysis(rec.analysisId);
  const pseudonyms = loadPseudonyms(rec.analysisId);
  const literals = await harvestSensitiveLiterals(config);
  const ctx = { literals, pseudonyms };
  const packageManagers = analysis?.profile.environment.packageManagers ?? [];
  const gateway = new OmpGateway({ command: config.llm.command, model: config.llm.model, timeoutMs: config.llm.timeoutSec * 1000, literals });
  let pendingAction: Action | null = null;

  async function sendMessage(content: string): Promise<void> {
    const transcript = [...loadChat(recId), { mode, role: "user" as const, content }];
    const progress = spinner();
    progress.start(PHRASES.chatting);
    let reply: string;
    try {
      const result = await gateway.complete(buildChatMessages(mode, rec, analysis, transcript, ctx), { maxTokens: config.llm.maxTokensChat });
      reply = redactOutboundText(result.content, ctx).text;
      progress.stop("Reply received.");
    } catch (error) {
      progress.stop("Request stopped.");
      throw error;
    }
    tx(() => {
      appendChat(recId, mode, "user", content);
      appendChat(recId, mode, "assistant", reply);
    });
    console.log(renderMarkdownLite(renderText(reply, pseudonyms)));
    const proposal = sanitizeAction(extractActionProposal(reply), pseudonyms, packageManagers, rec.tool);
    if (proposal) {
      printProposal(proposal, pseudonyms, recId, rec.shell);
      pendingAction = proposal;
    }
  }

  console.log(`Recommendation #${recId}: ${renderText(rec.title, pseudonyms)}`);
  console.log("Commands: /accept /discard /apply /done /exit");
  if (mode === "guide") {
    try { await sendMessage(GUIDE_KICKOFF); }
    catch (error) { if (!reportChatError(error)) throw error; }
  }

  while (true) {
    const line = await readChatLine();
    if (line === null || line.trim() === "/exit") return;
    if (!line.trim()) continue;
    const command = line.trim();
    if (command === "/accept") {
      await runAccept(recId);
      return;
    }
    try {
      if (command === "/discard") {
        performDiscard(recId);
        return;
      }
      if (command === "/done") {
        if (mode !== "guide") console.log("/done is available in guided mode. Use ghop done <id> outside chat.");
        else { performDone(recId); return; }
        continue;
      }
      if (command === "/apply") {
        if (!pendingAction) { console.log("No proposed change to apply."); continue; }
        rec = tx(() => {
          const current = getRec(recId);
          const action = sanitizeAction(pendingAction, pseudonyms, packageManagers, current.tool);
          if (!action) throw new GhopError("The proposed change is no longer available or verified.");
          return updateRec(recId, { action, actionKey: actionKey(action) });
        });
        pendingAction = null;
        console.log(`Updated recommendation #${recId}. No shell change has been applied.`);
        continue;
      }
      if (command.startsWith("/")) {
        console.log("Unknown command. Commands: /accept /discard /apply /done /exit");
        continue;
      }
      const redacted = redactOutboundText(line, ctx);
      if (redacted.findings.length > 0) {
        console.log(`Redacted before sending:\n${stripTerminalControls(redacted.text)}`);
        if (!await confirm({ message: "Send the redacted message?", initialValue: true })) continue;
      }
      await sendMessage(redacted.text);
    } catch (error) {
      if (!reportChatError(error)) throw error;
    }
  }
}

export function register(program: Command): void {
  program.command("chat").description("Discuss a recommendation with smol")
    .argument("<id>").action(async (id: string) => { await runChat(parseRecommendationId(id), "discuss"); });
}
