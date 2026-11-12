import type { Command } from "commander";
import { intro, outro } from "@clack/prompts";
import { getMeta } from "../core/state.ts";
import { isoNow } from "../core/dates.ts";
import { listRecs, getRec, updateRec } from "../recs/store.ts";
import { loadPseudonyms, renderText } from "../recs/pseudonyms.ts";
import { renderCard } from "../ui/render.ts";
import { printArt, PHRASES, mark } from "../ui/art.ts";
import { select } from "../ui/prompts.ts";
import { listRecommendations } from "./list.ts";

export function register(program: Command): void {
  program.action(async () => {
    const all = listRecs({});
    if (!all.length && !getMeta("consent")) {
      printArt();
      console.log(PHRASES.welcome);
      console.log("Run ghop setup to begin.");
      return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) { listRecommendations({}); return; }
    intro(`${mark()} grasshopper · ${all.filter(r => r.status === "new").length} new · ${all.filter(r => r.status === "accepted").length} accepted`);
    while (true) {
      const open = listRecs({}).filter(r => r.status === "new" || r.status === "accepted");
      const choice = await select<string>({ message: "What would you like to practice?", options: [
        ...open.map(r => ({ value: String(r.id), label: `#${r.id} [${r.category}] ${renderText(r.title, loadPseudonyms(r.analysisId))}`, hint: `${r.impact} impact · ${r.effort} effort` })),
        { value: "analyze", label: "Analyze now" }, { value: "quit", label: "Quit" },
      ] });
      if (choice === "quit") { outro("Practice is the path."); return; }
      if (choice === "analyze") { await program.parseAsync(["analyze"], { from: "user" }); continue; }
      const rec = getRec(Number(choice));
      console.log(renderCard(rec, loadPseudonyms(rec.analysisId)));
      updateRec(rec.id, { seenAt: isoNow() });
      const action = await select<string>({ message: "Recommendation", options: [
        { value: "chat", label: "Chat about it" }, { value: "accept", label: "Accept" },
        { value: "discard", label: "Discard" }, { value: "back", label: "Back" },
      ] });
      if (action !== "back") await program.parseAsync([action, String(rec.id)], { from: "user" });
    }
  });
}
