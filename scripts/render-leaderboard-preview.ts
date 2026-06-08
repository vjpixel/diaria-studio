#!/usr/bin/env tsx
/**
 * render-leaderboard-preview.ts (debug-only)
 *
 * Renderiza standalone HTML do rodapé È IA? usando dados reais de
 * `_internal/04-leaderboard-top1.json`. Útil pra inspecionar visualmente
 * o output do `renderLeaderboardTop1Row` sem precisar de edição completa.
 *
 * Uso:
 *   npx tsx scripts/render-leaderboard-preview.ts --edition AAMMDD
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { renderLeaderboardTop1Row, type EIA } from "./render-newsletter-html.ts";

function parseArgs(argv: string[]): { edition: string } | null {
  let edition = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--edition" && argv[i + 1]) {
      edition = argv[i + 1];
      i++;
    }
  }
  return edition ? { edition } : null;
}

const PSTYLE =
  "margin:0;font-size:0.95rem;line-height:1.5;color:#1a1a1a;font-family:-apple-system,sans-serif;";

const args = parseArgs(process.argv.slice(2));
if (!args) {
  console.error("Uso: render-leaderboard-preview.ts --edition AAMMDD");
  process.exit(1);
}

const jsonPath = resolve(
  process.cwd(),
  "data",
  "editions",
  args.edition,
  "_internal",
  "04-leaderboard-top1.json",
);
if (!existsSync(jsonPath)) {
  console.error(`JSON não encontrado: ${jsonPath}`);
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
const eia: EIA = {
  credit: "",
  imageA: "",
  imageB: "",
  edition: args.edition,
  leaderboardPodium: parsed.podium,
  leaderboardTop1: parsed.top1,
  leaderboardPeriod: parsed.period,
};

const row = renderLeaderboardTop1Row(eia, PSTYLE);

const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Preview rodapé È IA? — edição ${args.edition}</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
  h2 { font-size: 1.1rem; }
  .frame { border: 1px solid #ddd; padding: 16px; background: #fff; margin: 12px 0 24px 0; }
  .meta { font-size: 0.8rem; color: #666; margin-top: 8px; }
  code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 0.85em; }
</style>
</head>
<body>

<h1>Rodapé È IA? — preview</h1>
<p class="meta">Edição ${args.edition} · Endpoint <code>/leaderboard/top1?period=${parsed.period_slug}</code></p>

<h2>Output do renderer (HTML real que vai pra newsletter)</h2>
<div class="frame">
<table style="border-collapse:collapse;width:100%;">
${row}
</table>
</div>

<h2>Dados crus do endpoint</h2>
<div class="frame">
<pre style="margin:0;font-size:0.8rem;overflow-x:auto;">${JSON.stringify(parsed, null, 2)}</pre>
</div>

<p class="meta">
Mascaramento: entries sem nickname aparecem como <code>local-part@***</code> (mesma política do <code>/leaderboard</code> público).<br>
Issue #1353 trata do follow-up UX: prompt pra esses leitores definirem nickname.
</p>

</body>
</html>
`;

const outPath = resolve(
  process.cwd(),
  "data",
  "editions",
  args.edition,
  "_internal",
  "podium-preview.html",
);
writeFileSync(outPath, html, "utf8");
console.log(`Wrote ${outPath}`);
