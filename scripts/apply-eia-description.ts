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
 *   3 — qualquer input ausente/malformado (`01-eia-compose-context.json`,
 *       meta.json, --corrected, compose-context.json presente mas com shape
 *       errado, 01-eia.md sem o header esperado) — sempre erro de verdade,
 *       orchestrator reporta halt banner ao editor, nunca skip silencioso.
 *
 * #4281 (post-mortem 260729): `01-eia-compose-context.json` ausente era
 * tratado como exit 2 "benigno" sob a premissa de que só aconteceria em
 * edições compostas ANTES do #4258. Essa premissa se provou falsa — o caso
 * ocorreu numa edição composta DEPOIS do #4258 (causa raiz não investigada,
 * fora de escopo aqui), e o skip silencioso deixou a descrição do "É IA?" em
 * inglês na edição sem sinalização loud. Ausência desse arquivo agora é
 * tratada como qualquer outro erro real (exit 3, halt banner) — nunca mais
 * um skip automático. Editor que precisar reprocessar uma edição legado
 * genuinamente pré-#4258 roda humanizador/Clarice manualmente sobre a
 * creditLine, como o comentário do exit 2 antigo já sugeria.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";
import { buildCreditLine, PREV_RESULT_LINE_PREFIX, type WikimediaImage } from "./eia-compose.ts";

interface ComposeContext {
  image: WikimediaImage;
  ptLabel: string | null;
  ptWikipediaUrl: string | null;
}

/** Runtime shape check pro JSON.parse de `01-eia-compose-context.json` —
 * campo `image` é o único usado de fato (ptLabel/ptWikipediaUrl aceitam
 * null); sem isso, um `context.image` ausente só explodiria bem mais tarde,
 * dentro de `buildCreditLine`, como exceção não capturada (achado do review
 * consolidado). */
function isValidComposeContext(value: unknown): value is ComposeContext {
  if (!value || typeof value !== "object") return false;
  const image = (value as { image?: unknown }).image;
  return !!image && typeof image === "object";
}

/**
 * Pure: substitui SÓ a linha de crédito dentro do corpo de `01-eia.md`,
 * preservando frontmatter YAML (`eia_answer`), o header `**É IA?**` e a
 * `prevResultLine` opcional intactos. Estrutura fixa escrita por
 * `buildEiaMd` (eia-compose.ts): frontmatter, linha em branco, header,
 * linha em branco, creditLine, [linha em branco, prevResultLine].
 *
 * Localiza o INÍCIO da creditLine pelo marcador `**É IA?**\n\n`. Localiza o
 * FIM ancorando no prefixo literal de `prevResultLine`
 * (`PREV_RESULT_LINE_PREFIX`, exportado por eia-compose.ts) — nunca num
 * "\n\n" genérico: a creditLine já passa por humanizador/Clarice (texto
 * livre, não gerado por template) e uma quebra de linha interna ali faria um
 * "\n\n" genérico casar no lugar errado, vazando um fragmento da creditLine
 * ANTIGA pro output sem lançar nenhum erro (bug real encontrado pelo review
 * consolidado, reproduzido com uma creditLine contendo "\n\n" no meio).
 * Nunca faz parsing de markdown genérico, só string slicing determinístico
 * sobre um formato conhecido.
 *
 * Lança se o marcador não existir (formato inesperado — falhar alto em vez
 * de corromper o arquivo silenciosamente). Isso só pode acontecer pra
 * edições anteriores a #1100 (header não-negrito) — que também são
 * anteriores a #4258 e portanto já teriam sido filtradas antes pelo check de
 * `01-eia-compose-context.json` ausente (exit 2) no `main()` abaixo; chegar
 * aqui com o marcador ausente indica uma edição pós-#4258 genuinamente
 * corrompida, daí o exit 3 (erro de verdade) no catch do `main()`.
 */
export function replaceCreditLineInEiaMd(md: string, newCreditLine: string): string {
  const marker = "**É IA?**\n\n";
  const markerIdx = md.indexOf(marker);
  if (markerIdx === -1) {
    throw new Error("01-eia.md não contém o header \"**É IA?**\" — formato inesperado, abortando.");
  }
  const afterMarker = markerIdx + marker.length;
  const rest = md.slice(afterMarker);
  const prevResultMarker = `\n\n${PREV_RESULT_LINE_PREFIX}`;
  const prevResultIdx = rest.indexOf(prevResultMarker);
  // Sem prevResultLine, `rest` É a creditLine inteira + newline(s) finais
  // (buildEiaMd sempre termina com `lines.push(""); lines.join("\n")`) —
  // preserva só essas newlines finais, descarta o texto da creditLine antiga.
  const tail = prevResultIdx === -1 ? rest.slice(rest.search(/\n*$/)) : rest.slice(prevResultIdx);
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
    process.exit(3);
  }
  const correctedSentence = readFileSync(correctedPath, "utf8").trim();
  if (!correctedSentence) {
    console.error(`[apply-eia-description] ${correctedPath} está vazio.`);
    process.exit(3);
  }

  // #4281: ausência deste arquivo NÃO é mais tratada como skip benigno — a
  // premissa "só acontece em edições pré-#4258" se provou falsa (post-mortem
  // 260729, edição composta pós-#4258). Sem esse contexto a descrição do
  // "É IA?" fica em inglês sem sinalização — erro de verdade, halt loud.
  const contextPath = resolve(args.editionDir, "_internal/01-eia-compose-context.json");
  if (!existsSync(contextPath)) {
    console.error(
      `[apply-eia-description] ${contextPath} não existe — sem esse contexto a descrição do ` +
        "\"É IA?\" fica em inglês (não traduzida/adaptada). Halt: investigar por que eia-compose.ts " +
        "não gravou esse arquivo nesta edição antes de prosseguir.",
    );
    process.exit(3);
  }
  let context: ComposeContext;
  try {
    const parsed = JSON.parse(readFileSync(contextPath, "utf8"));
    if (!isValidComposeContext(parsed)) {
      console.error(`[apply-eia-description] ${contextPath} sem campo image válido — formato inesperado.`);
      process.exit(3);
    }
    context = parsed;
  } catch (e) {
    console.error(`[apply-eia-description] ${contextPath} não parseia: ${(e as Error).message}`);
    process.exit(3);
  }

  const metaPath = resolve(args.editionDir, "_internal/01-eia-meta.json");
  if (!existsSync(metaPath)) {
    console.error(`[apply-eia-description] ${metaPath} não existe.`);
    process.exit(3);
  }
  let meta: { wikimedia?: { description?: string } };
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (e) {
    console.error(`[apply-eia-description] ${metaPath} não parseia: ${(e as Error).message}`);
    process.exit(3);
  }
  if (!meta.wikimedia) {
    console.error(`[apply-eia-description] ${metaPath} sem campo wikimedia — formato inesperado.`);
    process.exit(3);
  }

  const mdPath = resolve(args.editionDir, "01-eia.md");
  if (!existsSync(mdPath)) {
    console.error(`[apply-eia-description] ${mdPath} não existe.`);
    process.exit(3);
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
    process.exit(3);
  }

  writeFileSync(mdPath, newMd, "utf8");
  meta.wikimedia.description = correctedSentence;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");

  console.log(`[apply-eia-description] wrote ${mdPath} + ${metaPath}`);
}

if (isMainModule(import.meta.url)) main();
