#!/usr/bin/env tsx
/**
 * render-erro-intencional.ts (#911)
 *
 * Concurso "Ache o erro" — cada edição declara 1 erro intencional pros
 * assinantes acharem (sorteio mensal premia com uma caneca da Diar.ia). Pra fechar o
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
import { SECTION_EMOJI_PREFIX } from "./lib/section-naming.ts"; // #1836 fonte única do prefixo de emoji

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
// #1588: posição canônica é ANTES de SORTEIO. Fallback pra PARA ENCERRAR /
// ASSINE / ENCERRAMENTO quando SORTEIO ausente (edição legacy ou template
// custom). Match aceita emoji opcional (🎁) + bold opcional + whitespace.
// #1836: emoji-prefix do registry (opcional → cobre header com e sem emoji,
// colapsando a alternação bare que existia aqui).
const SORTEIO_HEADER_RE = new RegExp(
  `^\\s*(?:\\*\\*)?${SECTION_EMOJI_PREFIX}SORTEIO(?:\\*\\*)?\\s*$`,
  "imu",
);
const PARA_ENCERRAR_HEADER_RE = new RegExp(
  `^\\s*(?:\\*\\*)?${SECTION_EMOJI_PREFIX}PARA\\s+ENCERRAR(?:\\*\\*)?\\s*$`,
  "imu",
);

/**
 * Pure: dado o conjunto de erros e a edição corrente (`AAMMDD`), retorna
 * a entry mais recente (por edição lexicográfica) anterior à corrente
 * que seja relevante para o reveal. Inclui entradas com `is_feature: true`
 * (erros reais) e entradas com `no_error: true` (#2037 fix 2 — edição sem
 * erro intencional, que deve revelar "não havia erro" em vez de silenciosamente
 * pular pra 2 edições atrás). Retorna `null` quando não existir nenhuma.
 */
export function findPreviousIntentionalError(
  errors: IntentionalError[],
  currentEdition: string,
): IntentionalError | null {
  const candidates = errors
    .filter(
      (e) =>
        typeof e.edition === "string" &&
        e.edition < currentEdition &&
        (e.is_feature === true || e.no_error === true),
    )
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
): { narrative: string; detail?: string; gabarito?: string; correct_value?: string } | null {
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

  // #1443: pull `correct_value` do frontmatter pra que o reveal da próxima
  // edição possa enforçar "o correto é Y". Frontmatter shape esperada (validada
  // pelo lint-newsletter-md `intentional-error-flagged`):
  //   intentional_error:
  //     correct_value: "..."
  const correctValue = extractCorrectValueFromFrontmatter(md);

  // Back-compat: tenta extrair detail/gabarito do formato legado
  // "escrevi 'X' onde deveria ser 'Y'" pra consumidores antigos.
  const legacyRe = /escrevi\s+(["'])([^"']+?)\1\s+onde\s+deveria\s+ser\s+(["'])([^"']+?)\3/i;
  const lm = narrative.match(legacyRe);
  if (lm) {
    return {
      narrative,
      detail: lm[2],
      gabarito: lm[4],
      ...(correctValue ? { correct_value: correctValue } : {}),
    };
  }
  return { narrative, ...(correctValue ? { correct_value: correctValue } : {}) };
}

/**
 * Pure (#1443): extrai `intentional_error.correct_value` do frontmatter YAML.
 * Reusa o mesmo regex leve do lint-newsletter-md.ts — não traz dependência
 * de YAML parser. Retorna `null` se frontmatter ausente, sem `intentional_error`,
 * ou sem `correct_value`.
 */
export function extractCorrectValueFromFrontmatter(md: string): string | null {
  // Frontmatter pode estar nas primeiras 60 linhas — espelhar `extractFrontmatter`
  // de lint-newsletter-md.ts (default scanLines=30) e dar margem extra pro caso
  // do bloco TÍTULO/SUBTÍTULO injetado por insert-titulo-subtitulo.ts antes do
  // YAML (#1378).
  const lines = md.split("\n").slice(0, 60);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  const fm = lines.slice(start + 1, end).join("\n");
  const ieBlock = fm.match(
    /intentional_error\s*:\s*\n((?:[ \t]+[\w-]+\s*:\s*.+\n?)+)/,
  );
  if (!ieBlock) return null;
  for (const line of ieBlock[1].split("\n")) {
    const m = line.match(/^[ \t]+correct_value\s*:\s*"?(.*?)"?\s*$/);
    if (m && m[1].trim().length > 0) return m[1].trim();
  }
  return null;
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
): { edition: string; detail: string; gabarito: string; narrative: string; correct_value?: string } | null {
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
        ...(extracted.correct_value ? { correct_value: extracted.correct_value } : {}),
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
 * Heurística pra detectar se a narrativa já inclui a correção (#1443).
 * Match fraseologias comuns: "o correto é X", "mas o correto era X", "na verdade
 * é X", "deveria ser X", "onde deveria ser X" (formato legado).
 *
 * Boundaries: sem `\b` final porque `\b` é ascii-only no JS — falha em "é " (é
 * não está em `\w`, então não há boundary). Usar prefix-boundary só no início,
 * e confiar que as fraseologias são distintivas o suficiente.
 */
const HAS_CORRECTION_RE =
  /(?:^|[\s,;.])(o\s+correto\s+(?:é|era)|mas\s+o\s+correto|na\s+verdade\s+(?:é|era)|deveria\s+ser|onde\s+deveria\s+ser)/i;

export function narrativeHasCorrection(narrative: string): boolean {
  return HAS_CORRECTION_RE.test(narrative);
}

/**
 * Pure (#1079, #1443): compõe o texto de revelação do erro anterior no formato
 * "Na última edição, {narrative}, o correto é {correct_value}.".
 *
 * #1443: o reveal precisa SEMPRE incluir uma frase de correção explícita ("o
 * correto é Y") pra fechar o loop do concurso "ache o erro". Antes desse fix,
 * o autor podia escrever uma narrativa neutra ("contei que Karpathy cofundou
 * a OpenAI em 1914, depois liderou a IA da Tesla") sem dizer o que era o
 * erro — leitor que pulou a edição anterior ficava sem entender.
 *
 * Estratégia:
 *   - Se narrative já tem fraseologia de correção (`o correto é`, `mas o
 *     correto era`, `na verdade é`, `deveria ser`, `onde deveria ser`) →
 *     preservar.
 *   - Senão e `correct_value` (do frontmatter) está presente → auto-append
 *     `, o correto é {correct_value}`.
 *   - Senão e há `detail + gabarito` legados → "{detail}, mas o correto era
 *     {gabarito}".
 *   - Senão e há só `detail` (sem correct_value/gabarito) → emitir warn
 *     e devolver narrative/detail crus (formato incompleto, mas não falha).
 *   - Fallback genérico final.
 *
 * Strings entre aspas são envoltas em negrito (#915).
 */
export function composeRevealText(
  prev: IntentionalError & { narrative?: string; gabarito?: string },
): string {
  const narrative = (prev.narrative ?? "").trim();
  const detail = (prev.detail ?? "").trim();
  const gabarito = (prev.gabarito ?? "").trim();
  const correctValue = (prev.correct_value ?? "").trim();

  let narrativeFinal: string;
  if (narrative) {
    if (narrativeHasCorrection(narrative)) {
      narrativeFinal = narrative;
    } else if (correctValue) {
      narrativeFinal = `${narrative.replace(/\.$/, "")}, o correto é ${correctValue}`;
    } else {
      // Narrative sem correção e sem correct_value pra auto-completar — formato
      // incompleto (leitor não sabe qual é o erro). Avisar pra ficar visível no
      // log; ainda assim devolve o que tem (não bloqueia).
      console.warn(
        "[render-erro-intencional] WARN: narrativa do erro intencional sem frase " +
          "de correção (\"o correto é Y\") e sem `intentional_error.correct_value` " +
          "no frontmatter da edição anterior — reveal sairá sem correção explícita.",
      );
      narrativeFinal = narrative;
    }
  } else if (correctValue && detail) {
    narrativeFinal = `${detail.replace(/\.$/, "")}, o correto é ${correctValue}`;
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
    // Review #1593: `\Z` é literal Z em JS (não EOF) — usar `$(?![\s\S])`.
    // #1569 + review: SORTEIO, PARA ENCERRAR, RADAR como sentinelas pra strip
    // funcionar em edições novas. Legacy PESQUISAS/OUTRAS preservados.
    // Review #1612: sentinelas precisam aceitar emoji prefix (📡 RADAR,
    // 🎁 SORTEIO, 🙋🏼‍♀️ PARA ENCERRAR) — sem isso, strip cai pra EOF e
    // engole tudo até o fim do MD em edições sem `---` separator entre
    // ERRO INTENCIONAL e a próxima seção.
    const emojiOpt = SECTION_EMOJI_PREFIX; // #1836: cópia local idêntica → registry
    const stripRe = new RegExp(
      `(?:^---\\s*\\n[\\s\\n]*)?^${headerEsc}\\s*\\n[\\s\\S]*?(?=^---\\s*$|^\\*?\\*?${emojiOpt}(?:ASSINE|DESTAQUE|LAN[ÇC]AMENTOS|PESQUISAS|OUTRAS|RADAR|SORTEIO|PARA ENCERRAR|É IA\\?|Encerrando|Até)|$(?![\\s\\S]))(?:^---\\s*\\n[\\s\\n]*)?`,
      "mu",
    );
    mdClean = md.replace(stripRe, "").replace(/\n{3,}/g, "\n\n");
  }

  const lines = mdClean.split("\n");
  // #1588: posição canônica = antes de SORTEIO. Cai em PARA ENCERRAR / ASSINE
  // / ENCERRAMENTO quando SORTEIO ausente (back-compat). Antes do fix, o
  // renderer só procurava ASSINE/ENCERRAMENTO — em edições com SORTEIO + PARA
  // ENCERRAR mas sem ASSINE explícito, caía no fim do MD (após PARA ENCERRAR).
  const ANCHOR_REGEXES = [
    SORTEIO_HEADER_RE,
    PARA_ENCERRAR_HEADER_RE,
    ASSINE_RE,
    ENCERRAMENTO_RE,
  ];
  let insertAt = lines.length;
  outer: for (const anchorRe of ANCHOR_REGEXES) {
    for (let i = 0; i < lines.length; i++) {
      if (anchorRe.test(lines[i])) {
        let j = i - 1;
        while (j >= 0 && lines[j].trim() === "") j--;
        if (j >= 0 && lines[j].trim() === "---") {
          insertAt = j;
        } else {
          insertAt = i;
        }
        break outer;
      }
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

/** Shape devolvido por findPreviousIntentionalErrorFromMd. */
type MdPrevError = {
  edition: string;
  detail: string;
  gabarito: string;
  narrative: string;
  correct_value?: string;
};

/** Entry enriquecida que composeRevealText consome (IntentionalError + narrativa/gabarito). */
type RevealEntry = IntentionalError & { narrative?: string; gabarito?: string };

/**
 * Pure (#1854/#1860): reconcilia a edição-fonte do reveal entre o JSONL
 * (fonte primária estruturada) e o MD (fallback que pega declarações em prosa
 * / publicações manuais que nunca chegaram ao JSONL).
 *
 * Casos:
 *   1. Ambos apontam pra MESMA edição → enriquece a entry do JSONL com os
 *      campos de narrativa/correção do MD quando faltarem (source "jsonl+md").
 *   2. MD aponta pra edição MAIS RECENTE que o JSONL → há um buraco no JSONL
 *      (uma edição declarou erro só na prosa). Revela a do MD e sinaliza
 *      `gap: true` pro caller logar o aviso de sync (source "md").
 *   3. Só JSONL → usa JSONL (source "jsonl").
 *   4. Só MD → usa MD (source "md").
 *   5. Nenhum → null.
 *
 * Ordem lexicográfica de AAMMDD decide "mais recente" (igual aos finders).
 */
export function resolvePreviousError(
  fromJsonl: IntentionalError | null,
  fromMd: MdPrevError | null,
): { prev: RevealEntry | null; source: "md" | "jsonl" | "jsonl+md" | null; gap: boolean } {
  const mdToEntry = (md: MdPrevError): RevealEntry => ({
    edition: md.edition,
    error_type: "editor_declared",
    is_feature: true,
    detail: md.detail,
    gabarito: md.gabarito,
    narrative: md.narrative,
    ...(md.correct_value ? { correct_value: md.correct_value } : {}),
  });

  if (fromJsonl && fromMd) {
    if (fromMd.edition === fromJsonl.edition) {
      // Caso 1: mesma edição — #1589: MD frontmatter é a fonte AUTORITATIVA.
      // Quando há drift entre JSONL e MD (incidente 260528→260529:
      // detail/correct_value divergiam), MD vence — incluindo correct_value.
      // Evita "reveal Frankenstein". Entre publicar N-1 e renderizar N nada
      // re-sincroniza o JSONL, então o MD ao vivo é a verdade mais recente.
      // narrative/gabarito não existem no JSONL (frontmatterToEntry só grava
      // detail+correct_value), então sempre vêm do MD.
      const enriched: RevealEntry = {
        ...fromJsonl,
        narrative: fromMd.narrative,
        gabarito: fromMd.gabarito,
        ...(fromMd.detail ? { detail: fromMd.detail } : {}),
        ...(fromMd.correct_value ? { correct_value: fromMd.correct_value } : {}),
      };
      return { prev: enriched, source: "jsonl+md", gap: false };
    }
    if (fromMd.edition > fromJsonl.edition) {
      // Caso 2: MD tem edição mais recente que o JSONL — buraco no JSONL.
      return { prev: mdToEntry(fromMd), source: "md", gap: true };
    }
    // fromMd mais antigo que o JSONL → JSONL é o reveal correto (caso normal).
    return { prev: fromJsonl, source: "jsonl", gap: false };
  }
  if (fromJsonl) return { prev: fromJsonl, source: "jsonl", gap: false };
  if (fromMd) return { prev: mdToEntry(fromMd), source: "md", gap: false };
  return { prev: null, source: null, gap: false };
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
  // #1471: JSONL é fonte primária — populado por sync-intentional-error.ts
  // com dados estruturados do frontmatter. MD extraction é fallback pra
  // edições antigas sem entry no JSONL.
  // Bug pré-#1471: MD era primário, mas edições com narrativa não-preenchida
  // ({PREENCHER_NARRATIVA_DO_ERRO}) eram puladas silenciosamente, caindo em
  // edição mais antiga. JSONL sempre tem a entry correta (frontmatter é
  // validado pelo lint antes de entrar no JSONL).
  let prev: IntentionalError | null = null;
  let reveal: string | null = null;
  let source: "md" | "jsonl" | "jsonl+md" | null = null;

  const errors = loadIntentionalErrors(errorsPath);
  const fromJsonl = findPreviousIntentionalError(errors, args.edition);
  const fromMd = findPreviousIntentionalErrorFromMd(editionsRoot, args.edition);
  const resolved = resolvePreviousError(fromJsonl, fromMd);
  prev = resolved.prev;
  source = resolved.source;
  if (resolved.gap && fromJsonl && fromMd) {
    // #1854/#1860: JSONL tem buraco — uma edição mais recente declarou erro só
    // no MD (prosa / publicação manual). Revelando a do MD; warn pra fechar o gap.
    console.error(
      `[render-erro] GAP: edição ${fromMd.edition} tem erro intencional no MD mas não no JSONL ` +
        `(provável declaração só na prosa / publicação manual). Revelando ${fromMd.edition} ` +
        `em vez de ${fromJsonl.edition}. Rode sync-intentional-error.ts pra fechar o gap.`,
    );
  }
  if (prev) {
    if (prev.no_error) {
      // #2037 fix 2: edição anterior declarou explicitamente que não havia erro
      // intencional. reveal=null faz renderSection usar a frase padrão
      // "A edição anterior não trazia erro intencional declarado."
      reveal = null;
    } else {
      reveal = composeRevealText(prev as IntentionalError & { narrative?: string; gabarito?: string });
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
