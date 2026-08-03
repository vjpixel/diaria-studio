#!/usr/bin/env tsx
/**
 * render-linkedin-weekly.ts (#4456)
 *
 * Monta o artefato final da newsletter semanal do LinkedIn a partir de
 * `data/weekly/{cycle}/_internal/ln-selection.json` (gerado por
 * `select-linkedin-weekly.ts`) + texto novo já humanizado/corrigido pela
 * skill (abertura, fecho, comentário do USE MELHOR — nunca gerado por este
 * script, ver `.claude/skills/diaria-linkedin-semanal/SKILL.md`).
 *
 * Escreve:
 *   data/weekly/{cycle}/ln-{cycle}.html   — fragmento HTML colável (sem
 *                                            <html>/<body> — é o payload
 *                                            `text/html` pro paste no editor
 *                                            do LinkedIn, ver
 *                                            context/publishers/linkedin.md)
 *   data/weekly/{cycle}/ln-{cycle}.json   — metadados da seleção + render
 *
 * Uso:
 *   npx tsx scripts/render-linkedin-weekly.ts --cycle 26w31 \
 *     --opening "..." --closing "..." [--use-melhor-comment "..."]
 *   (aceita também --opening-file/--closing-file/--use-melhor-comment-file
 *   pra texto longo, mesmo padrão de --*-file usado noutros scripts)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import { isValidWeeklyCycle, weeklyLinkedinRelDir } from "./lib/weekly-linkedin-cycle.ts";
import { renderLinkedinWeeklyHtml, type WeeklyLinkedinRenderInput } from "./lib/weekly-linkedin-render.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function resolveTextArg(argv: string[], key: string): string {
  const fileArg = getArg(argv, `${key}-file`);
  if (fileArg) return readFileSync(fileArg, "utf8");
  return getArg(argv, key);
}

interface SelectionJson {
  cycle: string;
  headlines: Array<{ title: string; body: string; why: string }>;
  useMelhor: { title: string; url: string; body: string } | null;
  weeklyEditions: Array<{ editionDate: string; url: string; destaques: string[] }>;
}

/**
 * @param rootDirOverride Opcional. Default = raiz do repo. Em testes, passar
 *   tempdir com `data/weekly/{cycle}/_internal/ln-selection.json` já escrito
 *   (#4489 finding 4, mesmo padrão de `select-linkedin-weekly.ts main(rootDirOverride)`
 *   e de `publish-monthly.ts main(monthlyDirOverride)`).
 */
export function main(rootDirOverride?: string) {
  const rootDir = rootDirOverride ?? ROOT;
  const argv = process.argv.slice(2);
  const cycle = getArg(argv, "cycle");
  if (!isValidWeeklyCycle(cycle)) {
    console.error(`Uso: render-linkedin-weekly.ts --cycle {YY}w{WW} [--opening ... --closing ... --use-melhor-comment ...]`);
    process.exit(2);
  }

  const selectionPath = join(rootDir, weeklyLinkedinRelDir(cycle), "_internal", "ln-selection.json");
  if (!existsSync(selectionPath)) {
    console.error(`${selectionPath} não existe — rode select-linkedin-weekly.ts --publish-monday AAMMDD primeiro.`);
    process.exit(1);
  }
  const selection = JSON.parse(readFileSync(selectionPath, "utf8")) as SelectionJson;

  const opening = resolveTextArg(argv, "opening");
  const closing = resolveTextArg(argv, "closing");
  const useMelhorComment = resolveTextArg(argv, "use-melhor-comment");

  const input: WeeklyLinkedinRenderInput = {
    cycle,
    headlines: selection.headlines.map((h) => ({ title: h.title, body: h.body, why: h.why })),
    useMelhor: selection.useMelhor
      ? {
          title: selection.useMelhor.title,
          url: selection.useMelhor.url,
          description: selection.useMelhor.body,
          editorComment: useMelhorComment,
        }
      : undefined,
    weeklyEditions: selection.weeklyEditions,
    opening,
    closing,
  };

  const result = renderLinkedinWeeklyHtml(input);

  const outDir = join(rootDir, weeklyLinkedinRelDir(cycle));
  mkdirSync(outDir, { recursive: true });
  const htmlPath = join(outDir, `ln-${cycle}.html`);
  const jsonPath = join(outDir, `ln-${cycle}.json`);
  writeFileSync(htmlPath, result.html, "utf8");
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        cycle,
        useMelhorRendered: result.useMelhorRendered,
        headlinesCount: input.headlines.length,
        weeklyEditionsCount: input.weeklyEditions.length,
        warnings: result.warnings,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`OK: ${htmlPath}`);
  console.log(`OK: ${jsonPath}`);
  if (result.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of result.warnings) console.log(`  - ${w}`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
