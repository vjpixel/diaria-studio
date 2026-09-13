#!/usr/bin/env tsx
/**
 * render-linkedin-weekly.ts (#4456, imagem de capa #5536, defaults #8025)
 *
 * Monta o artefato final da newsletter semanal do LinkedIn a partir de
 * `data/weekly/{cycle}/_internal/ln-selection.json` (gerado por
 * `select-linkedin-weekly.ts`) + texto novo já humanizado/corrigido pela
 * skill (abertura, fecho, comentário do USE MELHOR — nunca gerado por este
 * script, ver `.claude/skills/diaria-linkedin-semanal/SKILL.md`).
 *
 * **#8025 (12/09/2026, decisão do editor) — abertura/fecho têm TEXTO PADRÃO,
 * `--opening`/`--closing` viraram opcionais.** Antes disso o Passo 3b da
 * skill pedia ao editor 1 parágrafo de cada a toda rodada — na prática o
 * MESMO texto saiu em 4 edições consecutivas (26w34-26w37, confirmado
 * idêntico em `data/weekly/26w3{4,5,6,7}/ln-*.html`), então a pergunta
 * virou dívida, não gate (mesmo critério do #4498/CLAUDE.md "Perguntar é
 * exceção"). `DEFAULT_OPENING`/`DEFAULT_CLOSING` abaixo são esse texto —
 * `resolveTextArg` cai neles quando a flag (e o arquivo `-file`
 * correspondente) vêm vazios, imprimindo o banner de default aplicado
 * (regra do #5321) — nunca travando a espera de resposta. Passar
 * `--opening`/`--opening-file` (idem closing) explicitamente ainda
 * sobrescreve o default pra uma edição específica que o editor queira variar.
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
 *     [--opening "..." --closing "..."] [--use-melhor-comment "..."]
 *   (`--opening`/`--closing` são OPCIONAIS desde #8025 — omitidos, caem no
 *   texto padrão `DEFAULT_OPENING`/`DEFAULT_CLOSING` com banner explícito;
 *   aceitam também --opening-file/--closing-file/--use-melhor-comment-file
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

/**
 * #8025 — texto padrão de abertura, derivado do histórico real: mesmo
 * parágrafo usado (idêntico, confirmado byte-a-byte) em 4 edições
 * consecutivas — 26w34, 26w35, 26w36, 26w37 (`data/weekly/26w3{4,5,6,7}/
 * ln-*.html`). O trecho "diar.ia.br, newsletter de IA" preserva o padrão
 * exigido por `linkifyWordmark` (âncora estendida por 3 palavras após o
 * wordmark — ver `weekly-linkedin-render.ts`) — não editar esse trecho sem
 * reconferir `WORDMARK_TRAILING_WORDS`.
 */
export const DEFAULT_OPENING =
  "Desde o ano passado escrevo a diar.ia.br, newsletter de IA que sai por e-mail de segunda a sexta: " +
  "5 minutos por dia pra se manter atualizado e usar melhor as IAs. Aqui no LinkedIn, trago toda segunda " +
  "os três destaques que mais renderam clique na semana. As cinco edições completas ficam com os títulos " +
  "no fim do post. Assine grátis.";

/** #8025 — texto padrão de fecho, mesma origem/evidência do `DEFAULT_OPENING` acima. */
export const DEFAULT_CLOSING =
  "Isso aqui é a semana inteira espremida em três matérias. Na edição diária cabe mais: ela chega às 6 " +
  "da manhã, todo dia útil, com três resumos como esses, dicas de uso e indicação de outros artigos. " +
  "5 minutos por dia pra se manter atualizado e usar melhor as IAs. Assine grátis.";

/**
 * Resolve `--{key}`/`--{key}-file`; quando os dois vêm vazios (flag omitida
 * ou arquivo ilegível/vazio), cai no `fallback` (se houver) e imprime o
 * banner de default aplicado (#5321) — nunca trava esperando resposta.
 * `fallback` omitido preserva o comportamento anterior (retorna `""`),
 * usado pelo comentário do Use Melhor, que continua genuinamente opcional.
 */
function resolveTextArg(argv: string[], key: string, fallback?: string): string {
  const fileArg = getArg(argv, `${key}-file`);
  const value = fileArg ? readFileSync(fileArg, "utf8") : getArg(argv, key);
  if (value.trim() || fallback === undefined) return value;
  console.log(`--${key} não informado — assumindo o texto padrão (#8025). Passe --${key}/--${key}-file explicitamente para variar esta edição.`);
  return fallback;
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

  const opening = resolveTextArg(argv, "opening", DEFAULT_OPENING);
  const closing = resolveTextArg(argv, "closing", DEFAULT_CLOSING);
  // Comentário do Use Melhor segue genuinamente opcional (#5970) — sem fallback.
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
