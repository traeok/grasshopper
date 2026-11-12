import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const svg = readFileSync(new URL("../assets/grasshopper.svg", import.meta.url));
const image = new Resvg(svg, {
  fitTo: { mode: "width", value: 160 },
  font: { loadSystemFonts: false },
}).render();
writeFileSync(new URL("../assets/grasshopper.png", import.meta.url), image.asPng());
