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

import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
 * Pure: compõe o texto de revelação do erro anterior.
 *
 * Estratégia:
 *   - Tem `gabarito` explícito: "trazia '<detail snippet>' quando o correto era '<gabarito>'"
 *   - Sem gabarito: "trazia o erro: <detail>"
 *   - Detail vazio: "tinha um erro intencional"
 *
 * Não vaza informação demais — usa o detail tal como gravado pelo editor
 * (já é redação humana). Não tenta reformatar — só envolve strings entre
 * aspas em negrito (#915).
 */
export function composeRevealText(prev: IntentionalError): string {
  const detail = (prev.detail ?? "").trim();
  const gabarito = ((prev as { gabarito?: string }).gabarito ?? "").trim();
  const editionFmt = formatEditionLabel(prev.edition);

  let text: string;
  if (gabarito && detail) {
    text = `A edição anterior (${editionFmt}) tinha um erro intencional: ${detail}. O correto era ${gabarito}.`;
  } else if (detail) {
    text = `A edição anterior (${editionFmt}) tinha um erro intencional: ${detail}.`;
  } else {
    text = `A edição anterior (${editionFmt}) tinha um erro intencional.`;
  }
  return boldQuotedStrings(text);
}

/**
 * Pure: renderiza o bloco completo da seção ERRO INTENCIONAL pra inserir
 * no MD.
 */
export function renderSection(reveal: string | null): string {
  const lines: string[] = [];
  lines.push(SECTION_HEADER);
  lines.push("");
  if (reveal) {
    lines.push(reveal);
    lines.push("");
  } else {
    lines.push(
      "A edição anterior não trazia erro intencional declarado.",
    );
    lines.push("");
  }
  lines.push(
    "Esta edição tem um erro proposital. Responda este e-mail com a correção para concorrer ao sorteio mensal de livros.",
  );
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
): { md: string; action: "inserted" | "updated" | "no_change" } {
  const block = renderSection(reveal);
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
  const errors = loadIntentionalErrors(errorsPath);
  const prev = findPreviousIntentionalError(errors, args.edition);
  const reveal = prev ? composeRevealText(prev) : null;

  const md = readFileSync(mdPath, "utf8");
  const { md: updated, action } = insertOrUpdateSection(md, reveal);
  if (action !== "no_change") {
    writeFileSync(mdPath, updated, "utf8");
  }

  const result = {
    action,
    prev_edition: prev?.edition ?? null,
    prev_revealed: !!reveal,
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
