#!/usr/bin/env tsx
/**
 * render-erro-intencional.ts (#911)
 *
 * Concurso "Ache o erro" — cada edição declara 1 erro intencional pros
 * assinantes acharem (sorteio mensal premia com livro). Pra fechar o
 * loop:
 *
 *   1. Edição N revela o gabarito do erro da edição N-1 (com nome do
 *      assinante que acertou primeiro, se houver)
 *   2. Edição N convida leitores pra acharem o erro desta edição
 *
 * Source de verdade do erro anterior: `data/intentional-errors.jsonl`.
 * Cada linha tem `{ edition, error_type, detail, gabarito, ... }`.
 *
 * Uso:
 *   npx tsx scripts/render-erro-intencional.ts \
 *     --edition 260507 \
 *     --md data/editions/260507/02-reviewed.md \
 *     [--errors data/intentional-errors.jsonl]
 *
 * Modo:
 *   - Insere a seção ERRO INTENCIONAL no MD em `--md`, antes de
 *     "ASSINE" / "Encerrando" (ou no final se nenhum encontrado).
 *   - Idempotente: se a seção já existe no MD, atualiza em vez de
 *     duplicar.
 *
 * Stdout: JSON `{ inserted, prev_edition, prev_revealed, current_has_intentional }`.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadIntentionalErrors,
  type IntentionalError,
} from "./lib/intentional-errors.ts";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

const SECTION_HEADER = "**ERRO INTENCIONAL**";

const ASSINE_RE = /^(?:\*\*)?ASSINE(?:\*\*)?\s*$/m;
const ENCERRAMENTO_RE = /^(?:Encerrando|Até amanhã|Até a próxima)/m;

/**
 * Pure: dado o conjunto de erros e a edição corrente (`AAMMDD`), retorna
 * o erro mais recente (por edição lexicográfica) anterior à corrente
 * com `is_feature: true`. Retorna `null` quando não existir.
 */
export function findPreviousIntentionalError(
  errors: IntentionalError[],
  currentEdition: string,
): IntentionalError | null {
  const candidates = errors
    .filter((e) => e.is_feature && typeof e.edition === "string" && e.edition < currentEdition)
    .sort((a, b) => (a.edition < b.edition ? 1 : -1));
  return candidates[0] ?? null;
}

/**
 * Pure (#961 / #1079): extrai o erro intencional declarado na linha "Nessa
 * edição, {narrativa}." de um `02-reviewed.md` publicado.
 *
 * O novo formato (#1079) usa narrativa livre — o autor escreve a frase
 * inteira, sem placeholders fixos. Exemplos válidos:
 *   - "Nessa edição, eu disse que a OpenAI lançou 4 modelos, mas listei 3."
 *   - "Nessa edição, escrevi 'X' onde deveria ser 'Y'." (formato legado)
 *   - "Nessa edição, coloquei junho onde deveria ser maio."
 *
 * Captura tudo após "Nessa edição," até o primeiro ponto final no início
 * de espaço/quebra (não pega parágrafos seguintes). Caso a linha não
 * exista, retorna null — o caller decide o fallback (JSONL).
 *
 * Retorna `{ narrative }` no novo formato; campos `detail/gabarito` ficam
 * derivados pelos consumidores que ainda precisam deles (regex legado em
 * fallback dentro desta mesma função pra back-compat).
 */
export function extractIntentionalErrorFromMd(
  md: string,
): { narrative: string; detail?: string; gabarito?: string } | null {
  // #1099: quando o MD tem o header `**ERRO INTENCIONAL**`, ancorar busca
  // dentro do bloco. Caso contrário, busca global (back-compat com testes
  // que passam só a linha solta). Em ambos os casos, vírgula obrigatória
  // após "edição" pra evitar matchar "Nessa edição da Diar.ia, usei..."
  // do bloco PARA ENCERRAR (incident 260512).
  let block = md;
  const headerIdx = md.indexOf("**ERRO INTENCIONAL**");
  if (headerIdx !== -1) {
    const afterHeader = md.slice(headerIdx);
    // Limitar ao próximo separador `---` em linha própria, ou próximo header bold com emoji.
    const nextSepRe = /\n---\s*\n|\n\*\*[🎁🙋📰🚀🔬🇧🇷🛠️📦📈💡🎭⚖️📊💬🏭🔐]/;
    const nextSepMatch = afterHeader.match(nextSepRe);
    block = nextSepMatch !== null && nextSepMatch.index !== undefined
      ? afterHeader.slice(0, nextSepMatch.index)
      : afterHeader;
  }

  // Formato novo (#1079): narrativa livre. Vírgula é obrigatória após
  // "edição" — evita match em "Nessa edição da Diar.ia" do PARA ENCERRAR (#1099).
  const narrativeRe = /Nessa\s+edi[çc][ãa]o,\s+([^\n]+?)\.\s*(?:\n|$)/i;
  const nm = block.match(narrativeRe);
  if (!nm) return null;
  const narrative = nm[1].trim();
  // Pular placeholder não preenchido.
  if (/^\{PREENCHER/i.test(narrative)) return null;

  // Back-compat: tenta extrair detail/gabarito do formato legado
  // "escrevi 'X' onde deveria ser 'Y'" pra consumidores antigos.
  const legacyRe = /escrevi\s+(["'])([^"']+?)\1\s+onde\s+deveria\s+ser\s+(["'])([^"']+?)\3/i;
  const lm = narrative.match(legacyRe);
  if (lm) return { narrative, detail: lm[2], gabarito: lm[4] };
  return { narrative };
}

/**
 * Pure (#961): dado o root das edições e a edição corrente, encontra a edição
 * anterior mais recente que tenha `02-reviewed.md` com a linha "Nessa edição,
 * escrevi 'X' onde deveria ser 'Y'.". Retorna `{ edition, detail, gabarito }`
 * ou null.
 *
 * Critério de "anterior": ordem lexicográfica de AAMMDD que ignora sufixos
 * (`-backup-…`). Itera pra trás até achar uma que tenha a declaração — assim
 * uma edição anterior sem declaração não bloqueia a próxima.
 */
export function findPreviousIntentionalErrorFromMd(
  editionsRoot: string,
  currentEdition: string,
): { edition: string; detail: string; gabarito: string; narrative: string } | null {
  if (!existsSync(editionsRoot)) return null;
  let entries: string[];
  try {
    entries = readdirSync(editionsRoot);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((d) => /^\d{6}$/.test(d) && d < currentEdition)
    .sort((a, b) => (a < b ? 1 : -1));
  for (const editionDir of candidates) {
    const mdPath = join(editionsRoot, editionDir, "02-reviewed.md");
    if (!existsSync(mdPath)) continue;
    let md: string;
    try {
      md = readFileSync(mdPath, "utf8");
    } catch {
      continue;
    }
    const extracted = extractIntentionalErrorFromMd(md);
    if (extracted) {
      return {
        edition: editionDir,
        detail: extracted.detail ?? extracted.narrative,
        gabarito: extracted.gabarito ?? "",
        narrative: extracted.narrative,
      };
    }
  }
  return null;
}

/**
 * Pure (#915): envolve strings entre aspas (duplas ou simples) em **negrito**
 * markdown. Editor pediu negrito nas posições "X" (erro) e "Y" (correção)
 * pra dar contraste visual no concurso "Ache o erro".
 *
 * Idempotente: não dobra negrito se string já estiver bold (`**"X"**`).
 * Aceita ambos formatos de aspas que aparecem no detail/gabarito do
 * editor (entries históricos usam single quote; novos podem usar double).
 *
 * Estratégia: temporariamente substituir pares já-bold por sentinel,
 * envolver os restantes, e restaurar. Mais simples que regex com
 * lookbehind/lookahead encadeados.
 */
export function boldQuotedStrings(text: string): string {
  const SENTINEL_DBL = "DBL";
  const SENTINEL_SGL = "SGL";
  const dblTokens: string[] = [];
  const sglTokens: string[] = [];

  // 1. Salvar pares já-bold em sentinels (ordem: double primeiro)
  let work = text.replace(/\*\*"([^"]+)"\*\*/g, (m) => {
    dblTokens.push(m);
    return `${SENTINEL_DBL}${dblTokens.length - 1}${SENTINEL_DBL}`;
  });
  work = work.replace(/\*\*'([^']+)'\*\*/g, (m) => {
    sglTokens.push(m);
    return `${SENTINEL_SGL}${sglTokens.length - 1}${SENTINEL_SGL}`;
  });

  // 2. Envolver as aspas restantes (ainda não-bold) em **
  work = work.replace(/"([^"]+)"/g, '**"$1"**');
  work = work.replace(/'([^']+)'/g, "**'$1'**");

  // 3. Restaurar sentinels
  work = work.replace(
    new RegExp(`${SENTINEL_DBL}(\\d+)${SENTINEL_DBL}`, "g"),
    (_m, idx) => dblTokens[Number(idx)],
  );
  work = work.replace(
    new RegExp(`${SENTINEL_SGL}(\\d+)${SENTINEL_SGL}`, "g"),
    (_m, idx) => sglTokens[Number(idx)],
  );
  return work;
}

/**
 * Pure (#1079): compõe o texto de revelação do erro anterior no novo formato
 * "Na última edição, {narrative}.".
 *
 * Prioridade de fonte de narrativa:
 *   1. Campo `narrative` (extraído do MD anterior pela regex livre)
 *   2. Composição a partir de `detail` + `gabarito` legados:
 *      "{detail}, mas o correto era {gabarito}"
 *   3. Fallback genérico quando só `detail` está disponível
 *   4. Fallback genérico sem detalhe
 *
 * Strings entre aspas são envoltas em negrito (#915).
 */
export function composeRevealText(prev: IntentionalError & { narrative?: string }): string {
  const narrative = (prev.narrative ?? "").trim();
  const detail = (prev.detail ?? "").trim();
  const gabarito = ((prev as { gabarito?: string }).gabarito ?? "").trim();

  let narrativeFinal: string;
  if (narrative) {
    narrativeFinal = narrative;
  } else if (gabarito && detail) {
    narrativeFinal = `${detail}, mas o correto era ${gabarito}`;
  } else if (detail) {
    narrativeFinal = detail;
  } else {
    narrativeFinal = "houve um erro intencional";
  }

  return boldQuotedStrings(`Na última edição, ${narrativeFinal}.`);
}

/**
 * Pure (#1079): renderiza o bloco da seção ERRO INTENCIONAL no novo formato.
 *
 * Estrutura:
 *   **ERRO INTENCIONAL**
 *
 *   Na última edição, {prev_narrative}.   (do reveal calculado)
 *
 *   {currentDeclaration ?? "Nessa edição, …"}   (preservado se já existir no MD; placeholder caso contrário)
 *
 * O autor escreve `Nessa edição, …` manualmente no MD. O renderer detecta a
 * linha existente e a preserva; quando ausente, insere um placeholder pra
 * lembrar o autor de preencher antes de publicar.
 */
export function renderSection(
  reveal: string | null,
  currentDeclaration: string | null = null,
): string {
  const lines: string[] = [];
  lines.push(SECTION_HEADER);
  lines.push("");
  if (reveal) {
    lines.push(reveal);
  } else {
    lines.push("A edição anterior não trazia erro intencional declarado.");
  }
  lines.push("");
  if (currentDeclaration && currentDeclaration.trim()) {
    lines.push(currentDeclaration.trim());
  } else {
    lines.push("Nessa edição, {PREENCHER_NARRATIVA_DO_ERRO}.");
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Pure: insere ou atualiza a seção ERRO INTENCIONAL em `md`. Idempotente.
 *
 * Posicionamento: imediatamente antes da primeira ocorrência de "ASSINE"
 * ou "Encerrando" (ou no fim do MD se nenhuma das duas existir).
 *
 * Retorna `{ md, action }` onde `action ∈ "inserted" | "updated" | "no_change"`.
 *
 * Estratégia: se a seção já existe, remove o bloco inteiro (incluindo
 * separadores `---` adjacentes) e re-insere fresh. Garante idempotência —
 * 2 chamadas com mesmo input → mesmo output, sem `---` duplicados.
 */
export function insertOrUpdateSection(
  md: string,
  reveal: string | null,
  opts: { preserveExistingReveal?: boolean } = {},
): { md: string; action: "inserted" | "updated" | "no_change" } {
  // #1079: preserva linhas "Na última edição, …" e "Nessa edição, …" do MD da
  // edição corrente se já existirem (autor pode ter editado wording à mão).
  // Renderer só calcula reveal anterior quando ausente.
  //
  // #1279: default mudou pra "fresh wins". Bug recorrente em 260513-260515:
  // template MD da nova edição herda "Na última edição..." stale da edição
  // anterior, e o preserve mantinha o stale silenciosamente, repetindo o
  // mesmo reveal por 3 edições seguidas. Agora reveal computado SEMPRE
  // sobrescreve a menos que `opts.preserveExistingReveal=true`.
  const currentExtracted = extractIntentionalErrorFromMd(md);
  const currentDeclaration = currentExtracted
    ? `Nessa edição, ${currentExtracted.narrative}.`
    : null;

  const existingRevealRe = /Na\s+[úu]ltima\s+edi[çc][ãa]o,?\s+([^\n]+?)\.\s*(?:\n|$)/i;
  const existingRevealMatch = md.match(existingRevealRe);
  // #1279: só preserva existing se opt-in explícito; default = fresh wins.
  const finalReveal = opts.preserveExistingReveal && existingRevealMatch
    ? `Na última edição, ${existingRevealMatch[1].trim()}.`
    : reveal;

  const block = renderSection(finalReveal, currentDeclaration);
  const headerEsc = SECTION_HEADER.replace(/\*/g, "\\*");

  // Existing section detection (header + body sem dependência de --- explícitos)
  const existingHeaderRe = new RegExp(`^${headerEsc}\\s*$`, "m");
  const hadExisting = existingHeaderRe.test(md);

  let mdClean = md;
  if (hadExisting) {
    // Stripa o bloco inteiro: opcional `---`+blanks antes, header,
    // body até próximo separador (`---`) ou header conhecido, e
    // opcional `---`+blanks após.
    const stripRe = new RegExp(
      `(?:^---\\s*\\n[\\s\\n]*)?^${headerEsc}\\s*\\n[\\s\\S]*?(?=^---\\s*$|^\\*?\\*?(?:ASSINE|DESTAQUE|LAN[ÇC]AMENTOS|PESQUISAS|OUTRAS|É IA\\?|Encerrando|Até)|\\Z)(?:^---\\s*\\n[\\s\\n]*)?`,
      "m",
    );
    mdClean = md.replace(stripRe, "").replace(/\n{3,}/g, "\n\n");
  }

  const lines = mdClean.split("\n");
  let insertAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (ASSINE_RE.test(lines[i]) || ENCERRAMENTO_RE.test(lines[i])) {
      let j = i - 1;
      while (j >= 0 && lines[j].trim() === "") j--;
      if (j >= 0 && lines[j].trim() === "---") {
        insertAt = j;
      } else {
        insertAt = i;
      }
      break;
    }
  }

  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  // Garantir blank line antes e usa `---` como separador apenas quando
  // há conteúdo antes (sempre o caso pra newsletters reais).
  while (before.length > 0 && before[before.length - 1].trim() === "") {
    before.pop();
  }
  const toInsert = ["", "---", "", block.trimEnd(), "", "---", ""];
  const merged = [...before, ...toInsert, ...after];
  // Normaliza newlines triplos
  const out = merged.join("\n").replace(/\n{3,}/g, "\n\n");

  if (out === md) return { md, action: "no_change" };
  return { md: out, action: hadExisting ? "updated" : "inserted" };
}

/**
 * Pure: detecta se a edição corrente tem `intentional_error` declarado no
 * frontmatter. Quando o YAML está bem-formado retorna true.
 */
export function currentHasIntentionalErrorFlag(md: string): boolean {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return false;
  return /\bintentional_error\s*:/i.test(fm[1]);
}

function formatEditionLabel(edition: string): string {
  // Aceita YYYYMMDD ou AAMMDD. Devolve ISO-curta `AAMMDD` literal —
  // editor reconhece o formato sem confusão.
  return edition.replace(/[^0-9]/g, "");
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  if (!args.md || !args.edition) {
    console.error(
      "Uso: render-erro-intencional.ts --edition AAMMDD --md <md-path> [--errors data/intentional-errors.jsonl]",
    );
    process.exit(1);
  }
  const mdPath = resolve(ROOT, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(1);
  }
  const errorsPath = args.errors
    ? resolve(ROOT, args.errors)
    : join(ROOT, "data", "intentional-errors.jsonl");

  // #961: source of truth primária = "Nessa edição..." declarado pelo editor
  // no 02-reviewed.md publicado da edição anterior. JSONL fica como fallback
  // pra quando o MD anterior não tem a linha (ex: edição muito antiga).
  const editionsRoot = args["editions-dir"]
    ? resolve(ROOT, args["editions-dir"])
    : join(ROOT, "data", "editions");
  const fromMd = findPreviousIntentionalErrorFromMd(editionsRoot, args.edition);

  let prev: IntentionalError | null = null;
  let reveal: string | null = null;
  let source: "md" | "jsonl" | null = null;

  if (fromMd) {
    source = "md";
    prev = {
      edition: fromMd.edition,
      detail: fromMd.detail,
      gabarito: fromMd.gabarito,
      is_feature: true,
      error_type: "editor_declared",
      source: "md_extract",
    } as IntentionalError;
    reveal = composeRevealText(prev);
  } else {
    const errors = loadIntentionalErrors(errorsPath);
    prev = findPreviousIntentionalError(errors, args.edition);
    if (prev) {
      source = "jsonl";
      reveal = composeRevealText(prev);
    }
  }

  const md = readFileSync(mdPath, "utf8");
  // #1279: --preserve-existing-reveal opt-in; default = fresh reveal sobrescreve
  // existente pra evitar bug de stale text herdado de edições anteriores.
  const preserveExistingReveal = process.argv.includes("--preserve-existing-reveal");
  const { md: updated, action } = insertOrUpdateSection(md, reveal, {
    preserveExistingReveal,
  });
  if (action !== "no_change") {
    writeFileSync(mdPath, updated, "utf8");
  }

  const result = {
    action,
    prev_edition: prev?.edition ?? null,
    prev_revealed: !!reveal,
    prev_source: source,
    current_has_intentional: currentHasIntentionalErrorFlag(updated),
    path: mdPath,
  };
  console.log(JSON.stringify(result, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
