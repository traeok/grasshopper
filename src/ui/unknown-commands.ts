import type { AnalysisStats } from "../profile/types.ts";

export function renderUnknownCommands(commands: AnalysisStats["unknownCommands"]): string {
  const lines = [`Top unknown commands (local only): ${JSON.stringify(commands)}`];
  const words = commands.map(({ c }) => c).filter(c => /^[a-z0-9][a-z0-9._-]{0,30}$/.test(c));
  if (words.length) {
    lines.push("Only allow public names you want included in model requests (privacy.allowWords):",
      `  ghop config allow ${words.join(" ")}`);
  }
  return lines.join("\n");
}
