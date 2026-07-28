#!/usr/bin/env tsx
/**
 * apply-eia-description.ts (#4258 item 3)
 *
 * Recebe a frase de descrição do "É IA?" JÁ humanizada+corrigida pela
 * Clarice (par de `scripts/extract-eia-description.ts`) e regrava, a partir
 * da MESMA fonte, os dois lugares que precisam ficar sincronizados:
 *
 *   - `_internal/01-eia-meta.json` → `wikimedia.description` (o que viaja
 *     pipeline → KV → revelação do jogo, `renderEiaMetaHtml` no Worker).
 *   - `01-eia.md` → a linha de crédito, REGERADA via `buildCreditLine` com a
 *     frase corrigida (usa o contexto persistido por `eia-compose.ts` em
 *     `01-eia-compose-context.json` — image/ptLabel/ptWikipediaUrl — pra não
 *     precisar refazer as chamadas Wikimedia/Gemini).
 *
 * Nunca escreve as duas saídas a partir de fontes diferentes — as duas
 * derivam do MESMO texto corrigido, então não podem divergir (mesmo
 * princípio do invariante travado por test/stage-4-eia-credit-synced.test.ts,
 * aplicado aqui na origem em vez de detectado depois).
 *
 * Uso:
 *   npx tsx scripts/apply-eia-description.ts --edition-dir <dir> --corrected <path>
 *
 * Exit codes:
 *   0 — sucesso, ambos os arquivos regravados
 *   1 — args inválidos
 *   2 — algum input ausente/malformado (meta.json, compose-context.json,
 *       01-eia.md, ou o arquivo --corrected)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";
import { buildCreditLine, type WikimediaImage } from "./eia-compose.ts";

interface ComposeContext {
  image: WikimediaImage;
  ptLabel: string | null;
  ptWikipediaUrl: string | null;
}

/**
 * Pure: substitui SÓ a linha de crédito dentro do corpo de `01-eia.md`,
 * preservando frontmatter YAML (`eia_answer`), o header `**É IA?**` e a
 * `prevResultLine` opcional intactos. Estrutura fixa escrita por
 * `buildEiaMd` (eia-compose.ts): frontmatter, linha em branco, header,
 * linha em branco, creditLine, [linha em branco, prevResultLine].
 *
 * Localiza a creditLine pelo marcador `**É IA?**\n\n` (início) e pelo
 * próximo `\n\n` ou fim de string (fim) — nunca faz parsing de markdown
 * genérico, só string slicing determinístico sobre um formato conhecido.
 *
 * Lança se o marcador não existir (formato inesperado — falhar alto em vez
 * de corromper o arquivo silenciosamente).
 */
export function replaceCreditLineInEiaMd(md: string, newCreditLine: string): string {
  const marker = "**É IA?**\n\n";
  const markerIdx = md.indexOf(marker);
  if (markerIdx === -1) {
    throw new Error("01-eia.md não contém o header \"**É IA?**\" — formato inesperado, abortando.");
  }
  const afterMarker = markerIdx + marker.length;
  const rest = md.slice(afterMarker);
  const sepIdx = rest.indexOf("\n\n");
  // Sem prevResultLine, `rest` É a creditLine inteira + newline(s) finais
  // (buildEiaMd sempre termina com `lines.push(""); lines.join("\n")`) —
  // preserva só essas newlines finais, descarta o texto da creditLine antiga.
  const tail = sepIdx === -1 ? rest.slice(rest.search(/\n*$/)) : rest.slice(sepIdx);
  return md.slice(0, afterMarker) + newCreditLine + tail;
}

function parseArgs(argv: string[]): { editionDir: string; corrected: string } | null {
  const args = parseArgsSimple(argv);
  const editionDir = args["edition-dir"] ?? "";
  const corrected = args.corrected ?? "";
  if (!editionDir || !corrected) return null;
  return { editionDir, corrected };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("Uso: apply-eia-description.ts --edition-dir <dir> --corrected <path>");
    process.exit(1);
  }

  const correctedPath = resolve(args.corrected);
  if (!existsSync(correctedPath)) {
    console.error(`[apply-eia-description] ${correctedPath} não existe.`);
    process.exit(2);
  }
  const correctedSentence = readFileSync(correctedPath, "utf8").trim();
  if (!correctedSentence) {
    console.error(`[apply-eia-description] ${correctedPath} está vazio.`);
    process.exit(2);
  }

  const contextPath = resolve(args.editionDir, "_internal/01-eia-compose-context.json");
  if (!existsSync(contextPath)) {
    console.error(
      `[apply-eia-description] ${contextPath} não existe — edições compostas antes do #4258 ` +
        "não têm esse arquivo (nada a regerar; rode humanizador/Clarice direto se quiser corrigir manualmente).",
    );
    process.exit(2);
  }
  let context: ComposeContext;
  try {
    context = JSON.parse(readFileSync(contextPath, "utf8"));
  } catch (e) {
    console.error(`[apply-eia-description] ${contextPath} não parseia: ${(e as Error).message}`);
    process.exit(2);
  }

  const metaPath = resolve(args.editionDir, "_internal/01-eia-meta.json");
  if (!existsSync(metaPath)) {
    console.error(`[apply-eia-description] ${metaPath} não existe.`);
    process.exit(2);
  }
  let meta: { wikimedia?: { description?: string } };
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (e) {
    console.error(`[apply-eia-description] ${metaPath} não parseia: ${(e as Error).message}`);
    process.exit(2);
  }
  if (!meta.wikimedia) {
    console.error(`[apply-eia-description] ${metaPath} sem campo wikimedia — formato inesperado.`);
    process.exit(2);
  }

  const mdPath = resolve(args.editionDir, "01-eia.md");
  if (!existsSync(mdPath)) {
    console.error(`[apply-eia-description] ${mdPath} não existe.`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");

  const newCreditLine = buildCreditLine(context.image, {
    ptLabel: context.ptLabel,
    ptWikipediaUrl: context.ptWikipediaUrl,
    translatedSentence: correctedSentence,
  });

  let newMd: string;
  try {
    newMd = replaceCreditLineInEiaMd(md, newCreditLine);
  } catch (e) {
    console.error(`[apply-eia-description] ${(e as Error).message}`);
    process.exit(2);
  }

  writeFileSync(mdPath, newMd, "utf8");
  meta.wikimedia.description = correctedSentence;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");

  console.log(`[apply-eia-description] wrote ${mdPath} + ${metaPath}`);
}

if (isMainModule(import.meta.url)) main();
