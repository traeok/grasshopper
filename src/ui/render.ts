import { renderAlias } from "../apply/shells.ts";
import { loadConfig } from "../core/config.ts";
import { GhopError } from "../core/errors.ts";
import type { PseudonymMap } from "../privacy/pseudonyms.ts";
import { depseudonymizeForShell, loadPseudonyms, renderText, stripTerminalControls } from "../recs/pseudonyms.ts";
import type { StoredRecommendation } from "../recs/store.ts";
import { mark } from "./art.ts";
import { bold, categoryColors, dim, leaf, sprout, stem, warn, wheat } from "./style.ts";

export function renderRow(rec: StoredRecommendation): string {
  const map = loadPseudonyms(rec.analysisId);
  const title = renderText(rec.title, map).replace(/[\n\t]/g, " ");
  return `  #${wheat(String(rec.id))}  ${categoryColors[rec.category](rec.category.padEnd(9))}  ${title}  ${dim(rec.impact)}`;
}

export function renderCard(rec: StoredRecommendation, map: PseudonymMap): string {
  const lines = [
    leaf(bold(`#${rec.id} ${renderText(rec.title, map)}`)),
    `${categoryColors[rec.category](rec.category)} · ${rec.impact} impact/${rec.effort} effort · ${rec.status}`,
    "",
    renderText(rec.summary, map),
    "",
    `Why: ${dim(renderText(rec.rationale, map))}`,
  ];
  if (rec.steps.length > 0) {
    lines.push("", ...rec.steps.map((step, index) => `${index + 1}. ${renderText(step, map)}`));
  }
  if (rec.action) {
    const action = rec.action;
    const substitute = (text: string): string => {
      try { return stripTerminalControls(depseudonymizeForShell(text, map, rec.shell)); }
      catch (error) {
        if (!(error instanceof GhopError)) throw error;
        return renderText(text, map);
      }
    };
    let preview: string[];
    switch (action.type) {
      case "alias": {
        const command = substitute(action.command);
        const safeName = stripTerminalControls(action.name);
        preview = renderAlias(rec.shell, safeName, command);
        break;
      }
      case "snippet":
        preview = action.lines.map(substitute);
        break;
      case "install": {
        const argv = action.manager === "winget"
          ? ["winget", "install", "--id", action.id, "--exact", "--source", "winget"]
          : action.manager === "npm" ? ["npm", "install", "--global", action.id] : ["brew", "install", action.id];
        preview = [argv.map((arg) => stripTerminalControls(/^[A-Za-z0-9_./~:@%+=,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", rec.shell === "powershell" ? "''" : "'\\''")}'`)).join(" "), ...action.initLines.map(substitute)];
        break;
      }
    }
    lines.push("", "Change:", ...preview.flatMap((line) => line.split("\n").map((part) => `${stem("│ ")}${part}`)));
  }
  if (rec.tool) {
    const tool = rec.tool;
    const details = [tool.name];
    if (tool.githubRepo) details.push(`github.com/${tool.githubRepo}`);
    if (tool.npmPackage) details.push(`npm ${tool.npmPackage}`);
    if (tool.wingetId) details.push(`winget ${tool.wingetId}`);
    if (tool.brewFormula) details.push(`brew ${tool.brewFormula}`);
    const badge = tool.verification.status === "verified"
      ? leaf(`✓ verified open source${tool.verification.license ? ` (${stripTerminalControls(tool.verification.license)})` : ""}`)
      : warn("? unverified");
    lines.push("", `${stripTerminalControls(details.join(" · "))} · ${badge}`);
  }
  if (Object.keys(map).length === 0) lines.push("", dim("(original values no longer available)"));
  return lines.join("\n");
}

/** total is the full pending-new count, including rows omitted by the caller. */
export function renderBanner(newRecs: StoredRecommendation[], total: number, lastError: string | null): string {
  const rows = newRecs.slice(0, loadConfig().daily.maxItems);
  const lines = [`${mark()} ${leaf(bold("grasshopper"))} · ${total} new recommendation${total === 1 ? "" : "s"}`, ...rows.map(renderRow)];
  const remaining = Math.max(0, total - rows.length);
  if (remaining > 0) lines.push(`   +${remaining} more`);
  const id = rows[0]?.id ?? "<id>";
  lines.push(dim(`   ghop to review · ghop chat ${id} · ghop accept ${id}`));
  if (lastError) lines.push(dim(`   Last background analysis failed: ${stripTerminalControls(lastError).replace(/[\n\t]/g, " ")}. Run ghop doctor`));
  return lines.join("\n");
}

export function renderMarkdownLite(text: string): string {
  // renderText may already have added theme SGR. Preserve only harmless color/emphasis
  // codes; cursor movement, OSC links/clipboard writes, and other controls are removed.
  const clean = text.split(/(\x1b\[[\d;]*m)/).map((part) =>
    /^\x1b\[(?:1|2|3|4|22|23|24|39|3[0-7]|9[0-7]|38;5;\d{1,3}|38;2;\d{1,3};\d{1,3};\d{1,3})m$/.test(part)
      ? part : stripTerminalControls(part),
  ).join("");
  let fenced = false;
  const lines: string[] = [];
  for (const line of clean.split("\n")) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) { lines.push(`${stem("│ ")}${line}`); continue; }
    const inline = line.replace(/`([^`]+)`|\*\*([^*]+)\*\*/g, (_match: string, code: string | undefined, strong: string | undefined) =>
      code !== undefined ? sprout(code) : bold(strong ?? ""),
    );
    lines.push(inline.replace(/^(\s*)- /, "$1• "));
  }
  return lines.join("\n");
}
