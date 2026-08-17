#!/usr/bin/env tsx
/**
 * render-linkedin-weekly.ts (#4456, imagem de capa #5536)
 *
 * Monta o artefato final da newsletter semanal do LinkedIn a partir de
 * `data/weekly/{cycle}/_internal/ln-selection.json` (gerado por
 * `select-linkedin-weekly.ts`) + texto novo já humanizado/corrigido pela
 * skill (abertura, fecho, comentário do USE MELHOR — nunca gerado por este
 * script, ver `.claude/skills/diaria-linkedin-semanal/SKILL.md`).
 *
 * **#5536 — imagem de capa.** O LinkedIn Article Editor tem campo nativo de
 * cover image; até o #5536 nenhum passo da skill produzia essa imagem (saiu
 * copiada manualmente 2× — ciclos `26w32` e `26w33` — sem estar em nenhum
 * passo documentado, achado só quando o editor perguntou "onde está a
 * imagem?"). Decisão (registrada aqui, não perguntada — os 2 ciclos
 * anteriores já estabeleceram o padrão observado): **obrigatória, cópia
 * mecânica.** Este script copia `04-d1-2x1.jpg` (formato 2:1, já gerado no
 * Stage 3 diário) da edição de ORIGEM da manchete #1 (`headlines[0]`, a de
 * maior taxa de clique — não necessariamente o DESTAQUE 1 literal daquela
 * edição, mas é a única imagem 2:1 que a edição de origem produz, ver
 * `04-d1-2x1.jpg`/`04-d2-1x1.jpg`/`04-d3-1x1.jpg` na tabela de outputs do
 * `CLAUDE.md`) pra `data/weekly/{cycle}/04-d1-2x1.jpg`. **Fail-soft**: se a
 * edição de origem já foi arquivada ou a imagem não existir (fixture de
 * teste, edição muito antiga), a cópia é pulada com warning — nunca aborta
 * o render do artigo por causa da capa.
 *
 * Escreve:
 *   data/weekly/{cycle}/ln-{cycle}.html   — fragmento HTML colável (sem
 *                                            <html>/<body> — é o payload
 *                                            `text/html` pro paste no editor
 *                                            do LinkedIn, ver
 *                                            context/publishers/linkedin.md)
 *   data/weekly/{cycle}/ln-{cycle}.json   — metadados da seleção + render
 *   data/weekly/{cycle}/04-d1-2x1.jpg     — imagem de capa (#5536), se a
 *                                            edição de origem da manchete #1
 *                                            ainda tiver o arquivo
 *
 * Uso:
 *   npx tsx scripts/render-linkedin-weekly.ts --cycle 26w31 \
 *     --opening "..." --closing "..." [--use-melhor-comment "..."]
 *   (aceita também --opening-file/--closing-file/--use-melhor-comment-file
 *   pra texto longo, mesmo padrão de --*-file usado noutros scripts)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import { isValidWeeklyCycle, weeklyLinkedinRelDir } from "./lib/weekly-linkedin-cycle.ts";
import { resolveEditionDir } from "./lib/find-current-edition.ts";
import { renderLinkedinWeeklyHtml, type WeeklyLinkedinRenderInput } from "./lib/weekly-linkedin-render.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Nome do arquivo de imagem de capa (2:1) — mesmo nome no destino e na origem (#5536). */
export const COVER_IMAGE_FILENAME = "04-d1-2x1.jpg";

/**
 * Resolve o caminho da imagem de capa (#5536) na edição de origem da
 * manchete #1. `null` se a edição ou o arquivo não existirem — fail-soft,
 * ver docstring do módulo. Único I/O: `existsSync` (sem ler o arquivo).
 */
export function resolveCoverImageSourcePath(editionsRootDir: string, headlineOneEditionDate: string): string | null {
  const editionDir = resolveEditionDir(editionsRootDir, headlineOneEditionDate);
  const imgPath = join(editionDir, COVER_IMAGE_FILENAME);
  return existsSync(imgPath) ? imgPath : null;
}

function resolveTextArg(argv: string[], key: string): string {
  const fileArg = getArg(argv, `${key}-file`);
  if (fileArg) return readFileSync(fileArg, "utf8");
  return getArg(argv, key);
}

interface SelectionJson {
  cycle: string;
  headlines: Array<{ title: string; body: string; why: string; editionDate: string }>;
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
    headlines: selection.headlines.map((h) => ({ title: h.title, body: h.body, why: h.why, editionDate: h.editionDate })),
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

  // #5536: imagem de capa — cópia mecânica do 04-d1-2x1.jpg da edição de
  // origem da manchete #1, fail-soft (ver docstring do módulo).
  let coverImagePath: string | null = null;
  const coverWarnings: string[] = [];
  if (selection.headlines.length > 0) {
    const headlineOneEditionDate = selection.headlines[0].editionDate;
    const editionsRootDir = join(rootDir, "data/editions");
    const src = resolveCoverImageSourcePath(editionsRootDir, headlineOneEditionDate);
    if (src) {
      coverImagePath = join(outDir, COVER_IMAGE_FILENAME);
      copyFileSync(src, coverImagePath);
    } else {
      coverWarnings.push(
        `Imagem de capa (#5536): ${COVER_IMAGE_FILENAME} não encontrada na edição de origem da manchete #1 ` +
          `(${headlineOneEditionDate}) — artigo sai sem capa, suba manualmente no LinkedIn se tiver uma imagem alternativa.`,
      );
    }
  }

  const allWarnings = [...result.warnings, ...coverWarnings];
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        cycle,
        useMelhorRendered: result.useMelhorRendered,
        headlinesCount: input.headlines.length,
        weeklyEditionsCount: input.weeklyEditions.length,
        coverImagePath,
        warnings: allWarnings,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`OK: ${htmlPath}`);
  console.log(`OK: ${jsonPath}`);
  console.log(coverImagePath ? `OK: ${coverImagePath}` : "SEM CAPA: ver warning abaixo.");
  if (allWarnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of allWarnings) console.log(`  - ${w}`);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
