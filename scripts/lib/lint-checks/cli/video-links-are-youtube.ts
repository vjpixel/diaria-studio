/**
 * lib/lint-checks/cli/video-links-are-youtube.ts
 *
 * CLI handler pro check `--check video-links-are-youtube` de lint-newsletter-md.ts.
 * Extraído de main() (#5895, motion puro — mesma leitura de args, mesma
 * chamada de check, mesma formatação de erro/exit code de antes).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkVideoLinksAreYoutube } from "../video-links-are-youtube.ts";

// Modo --check video-links-are-youtube (#3202) — item da seção VÍDEOS com
// URL fora de youtube.com/youtu.be (página que só embeda o vídeo, ex: blog
// oficial). GATE-BLOCKING: regra editorial nova (context/editorial-rules.md
// — Seção "Vídeos") exige link do YouTube sempre; a resolução automática
// (Stage 1, scripts/resolve-video-youtube.ts) já tenta trocar pela URL do
// YouTube — este lint é o backstop que garante que nada não-YouTube
// sobrevive até o gate (resolução pulada, ou link colado manualmente).
export function runCli(args: Record<string, string>, root: string): void {
  if (!args.md) {
    console.error("Uso: lint-newsletter-md.ts --check video-links-are-youtube --md <md-path>");
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const result = checkVideoLinksAreYoutube(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(
      `\n❌ video-links-are-youtube: ${result.errors.length} item(ns) da seção VÍDEOS sem URL do YouTube:`,
    );
    for (const e of result.errors) {
      console.error(`  linha ${e.line}: ${e.url}`);
    }
    console.error(
      `\nFix: substitua pela URL do YouTube (youtube.com/watch?v=... ou youtu.be/...) equivalente em 02-reviewed.md antes de aprovar, ou mova o item pra fora de VÍDEOS.`,
    );
    process.exit(1);
  }
  return;
}
