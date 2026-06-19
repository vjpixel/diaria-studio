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
import { extractFrontmatter } from "./lib/lint-checks/intentional-error.ts"; // #2398: parser canônico (CRLF-safe, #2304)
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
 * Pure (#2398): extrai `intentional_error.description` (ou `.narrative`) do
 * frontmatter YAML como a declaração real do editor. O campo `description` é o
 * que o editor de fato preenche no Drive (ver hábito real em 260617/260618); o
 * campo `narrative` é um alias aceito por compatibilidade futura.
 *
 * Retorna `null` quando: frontmatter ausente, sem `intentional_error`, sem
 * `description`/`narrative`, ou valor é um placeholder `{PREENCHER}`.
 *
 * Reutiliza o mesmo parser regex-leve de `extractCorrectValueFromFrontmatter`
 * (não depende de YAML parser externo).
 */
export function extractNarrativeFromFrontmatter(md: string): string | null {
  // #2398 fix: reusa o extractFrontmatter canônico (CRLF-safe, #2304) em vez do
  // parser hand-rolled que tinha 3 bugs: (1) quote-stripping quebrado com aspas
  // simples, (2) return null no primeiro {PREENCHER} saía da função inteira antes
  // de checar campos alternativos, (3) ordem `narrative` antes de `description`
  // invertia a prioridade declarada no docstring.
  const fm = extractFrontmatter(md);
  if (!fm) return null;

  const ieBlock = fm.match(
    /intentional_error\s*:\s*\n((?:[ \t]+[\w-]+\s*:\s*.+\n?)+)/,
  );
  if (!ieBlock) return null;

  // Helper: extrai e limpa o valor de um campo do bloco intentional_error.
  // Strip aspas duplas E simples (o parser canônico de intentional-error.ts só
  // lida com duplas; aqui precisamos de ambas pra back-compat com edições legadas).
  const extractField = (field: string): string | null => {
    for (const line of ieBlock[1].split("\n")) {
      // Aceita valor com ou sem aspas (duplas ou simples).
      const m = line.match(
        new RegExp(`^[ \\t]+${field}\\s*:\\s*(['"]?)(.*?)\\1\\s*$`),
      );
      if (!m) continue;
      const val = m[2].trim();
      if (val.length === 0) continue;
      // Pular placeholder não preenchido — skip pra tentar campo seguinte.
      if (/^\{PREENCHER/i.test(val)) return null;
      return val;
    }
    return null;
  };

  // Prioridade: `description` (campo real do editor, hábito 260617/260618) →
  // `narrative` (alias futuro por compatibilidade). Ordem corrigida em #2398.
  return extractField("description") ?? extractField("narrative") ?? null;
}

/**
 * Pure (#961 / #1079 / #2398): extrai o erro intencional declarado em
 * `02-reviewed.md` publicado.
 *
 * **Prioridade da fonte (#2398):** o frontmatter `intentional_error.description`
 * (ou `.narrative`) é a declaração REAL do editor — o hábito documentado em
 * 260617/260618 é preencher o frontmatter com a declaração específica e manter
 * o corpo com o convite genérico ao sorteio. A prosa "Nessa edição, …" no corpo
 * é um FALLBACK para edições mais antigas onde o frontmatter não foi preenchido.
 *
 * Estratégia:
 *   1. Tentar frontmatter `intentional_error.description` / `.narrative`.
 *   2. Se ausente, tentar a linha "Nessa edição, {narrativa}." no corpo.
 *   3. Se nenhuma das duas, retornar null.
 *
 * Retorna `{ narrative }` no novo formato; campos `detail/gabarito` ficam
 * derivados pelos consumidores que ainda precisam deles (regex legado em
 * fallback dentro desta mesma função pra back-compat).
 */
export function extractIntentionalErrorFromMd(
  md: string,
): { narrative: string; detail?: string; gabarito?: string; correct_value?: string } | null {
  // #2398: PRIORIDADE 1 — declaração no frontmatter (hábito real do editor).
  // `description` é o campo que o editor preenche no Drive; `narrative` é alias.
  const fmNarrative = extractNarrativeFromFrontmatter(md);
  const correctValue = extractCorrectValueFromFrontmatter(md);

  if (fmNarrative) {
    // Back-compat: tenta extrair detail/gabarito do formato legado quando a
    // description usa "escrevi 'X' onde deveria ser 'Y'".
    const legacyRe = /escrevi\s+(["'])([^"']+?)\1\s+onde\s+deveria\s+ser\s+(["'])([^"']+?)\3/i;
    const lm = fmNarrative.match(legacyRe);
    if (lm) {
      return {
        narrative: fmNarrative,
        detail: lm[2],
        gabarito: lm[4],
        ...(correctValue ? { correct_value: correctValue } : {}),
      };
    }
    return { narrative: fmNarrative, ...(correctValue ? { correct_value: correctValue } : {}) };
  }

  // #2398: PRIORIDADE 2 — prosa "Nessa edição, …" no corpo (fallback para
  // edições sem frontmatter preenchido / publicações manuais antigas).
  //
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
  // edição possa enforçar "o correto é Y". (correctValue já foi extraído acima)

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
 * Detecta se a narrativa do erro intencional é um placeholder genérico (#2377
 * root-cause fix). O bug foi causado por um `narrative` genérico (copiado do
 * bloco de convite ao sorteio — "há um erro proposital escondido em um dos
 * destaques. Responda este e-mail com a correção para concorrer ao sorteio")
 * que acabou sendo formatado pelo `composeRevealText` como se fosse a
 * declaração específica do editor.
 *
 * Um narrative genérico é distinguível de um narrative real porque:
 *   - fala sobre "há um erro proposital" (meta-instrução, não declaração do erro)
 *   - fala sobre "responda este e-mail" (convite, não descrição do erro)
 *   - fala sobre "concorrer ao sorteio" (convite, não descrição do erro)
 *   - fala sobre "um erro escondido em" (meta-descrição)
 *   - fala sobre "esta edição tem um erro" (placeholder do writer, não do editor)
 *
 * A declaração real do editor é sempre de primeira pessoa e específica:
 *   - "escrevi que [afirmação concreta]..."
 *   - "contei que [fato específico]..."
 *   - "coloquei [valor errado] onde deveria ser [valor correto]"
 *
 * Retorna `true` quando o narrative é genérico/placeholder (deve bloquear).
 * Retorna `false` quando parece uma declaração real de primeira pessoa.
 *
 * Exportada para uso no lint do Stage 4 (erro-intencional-narrative-generico)
 * e no composeRevealText como defense-in-depth.
 */
const GENERIC_NARRATIVE_RE =
  /há\s+um\s+erro\s+proposital|esta\s+edição\s+tem\s+um\s+erro\s+proposital|responda\s+este\s+e-?mail|concorrer\s+ao\s+sorteio|um\s+erro\s+(?:proposital\s+)?escondido\s+em/i;

export function narrativeIsGenericPlaceholder(narrative: string): boolean {
  return GENERIC_NARRATIVE_RE.test(narrative);
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
    // Defense-in-depth (#2377): se a narrativa é um placeholder genérico (copiado
    // do bloco de convite ao sorteio em vez de uma declaração real do editor),
    // emitir warn visível. O bloqueio primário é o lint Stage 4
    // (--check erro-intencional-narrative-generico), mas esta warn garante que
    // edições legadas sem esse lint não geram reveal silenciosamente corrompido.
    if (narrativeIsGenericPlaceholder(narrative)) {
      console.warn(
        "[render-erro-intencional] WARN (#2377): narrative do erro intencional parece ser " +
          "um placeholder genérico (contém frases como \"há um erro proposital\", " +
          "\"responda este e-mail\", \"concorrer ao sorteio\") em vez de uma declaração " +
          "específica de primeira pessoa do editor. " +
          "O reveal sairá com o texto genérico em vez da descrição real do erro. " +
          "Corrija o narrative no frontmatter intentional_error.narrative (ou na prosa " +
          "\"Nessa edição, …\") antes de publicar.",
      );
    }
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
  // \r?\n handles both LF (Unix) and CRLF (Windows) line endings (P1 fix).
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return false;
  return /\bintentional_error\s*:/i.test(fm[1]);
}

/**
 * Pure (#2284): insere bloco de frontmatter placeholder `intentional_error`
 * em `md` quando nenhum frontmatter (ou nenhuma chave `intentional_error`)
 * existe. Retorna `{ md, inserted }`.
 *
 * Usado pelo render-erro-intencional no final do Stage 2 (pós-Clarice, em
 * modo auto/pre-gate) pra que o editor encontre o bloco no Drive (Stage 4)
 * e preencha os 4 campos antes da publicação. Sem isso, o lint do Stage 5
 * (`intentional-error-flagged`) aborta na hora da publicação, e o editor
 * precisa adicionar o bloco na correria — como ocorreu em 260615.
 *
 * Caso frontmatter já exista com `intentional_error:` → retorna md sem
 * modificação (idempotente). Caso frontmatter exista mas SEM
 * `intentional_error:` → insere a chave dentro do bloco existente.
 * Caso sem frontmatter → cria bloco YAML no topo.
 *
 * Os 4 campos são placeholders `{PREENCHER}` — o editor substitui no Drive.
 * O lint do Stage 5 rejeita valores que ainda contêm `{PREENCHER}` (guard em
 * `checkIntentionalError` em scripts/lib/lint-checks/intentional-error.ts).
 */
export function ensureIntentionalErrorFrontmatter(
  md: string,
): { md: string; inserted: boolean } {
  // Já tem intentional_error: — nada a fazer.
  if (currentHasIntentionalErrorFlag(md)) {
    return { md, inserted: false };
  }

  // Detect the file's line ending so inserted block matches existing EOL (#2304).
  // Prefer CRLF when the file already has CRLF (Windows/OneDrive). Fall back to LF.
  const eol = md.includes("\r\n") ? "\r\n" : "\n";

  const PLACEHOLDER_BLOCK = [
    "intentional_error:",
    '  description: "{PREENCHER — o que o assinante deve identificar}"',
    '  location: "{PREENCHER — ex: DESTAQUE 2, parágrafo 1}"',
    '  category: "{PREENCHER — factual|ortografico|numeric|attribution|data|version_inconsistency|factual_synthetic}"',
    '  correct_value: "{PREENCHER — valor correto}"',
  ].join(eol);

  // Frontmatter existente sem intentional_error → inserir chave dentro do bloco.
  // \r?\n handles CRLF on Windows (P1 fix). Replacer function avoids $-pattern
  // expansion in replacement string (e.g. "R$1.5bi" → "$1" capture group) (P1 fix).
  const existingFmMatch = md.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (existingFmMatch) {
    const [full, open, body, close] = existingFmMatch;
    const newBody = body.trimEnd() + eol + PLACEHOLDER_BLOCK;
    const updated = md.replace(full, () => `${open}${newBody}${close}`);
    return { md: updated, inserted: true };
  }

  // Sem frontmatter → criar no topo.
  const updated = `---${eol}${PLACEHOLDER_BLOCK}${eol}---${eol}${md}`;
  return { md: updated, inserted: true };
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
      // #2078: edição anterior declarou explicitamente que não havia erro
      // intencional (intentional_error: none). Usar frase natural em vez de
      // reveal=null (que emitia a genérica "A edição anterior não trazia erro
      // intencional declarado." — pouco informativa para o leitor do concurso).
      reveal = "Na última edição, não havia erro intencional: quem respondeu que não há erro, acertou.";
    } else {
      reveal = composeRevealText(prev as IntentionalError & { narrative?: string; gabarito?: string });
    }
  }

  const md = readFileSync(mdPath, "utf8");
  // #1279: --preserve-existing-reveal opt-in; default = fresh reveal sobrescreve
  // existente pra evitar bug de stale text herdado de edições anteriores.
  const preserveExistingReveal = process.argv.includes("--preserve-existing-reveal");
  const { md: withSection, action } = insertOrUpdateSection(md, reveal, {
    preserveExistingReveal,
  });

  // #2284: garantir que o frontmatter intentional_error existe (com placeholders
  // quando ausente) pra que o editor encontre o bloco no Drive (Stage 4) e
  // preencha antes da publicação. Sem isso, check-stage2-invariants passa
  // "verde" mas o lint do Stage 5 aborta na hora H.
  const { md: updated, inserted: frontmatterInserted } = ensureIntentionalErrorFrontmatter(withSection);

  if (action !== "no_change" || frontmatterInserted) {
    writeFileSync(mdPath, updated, "utf8");
  }

  const result = {
    action,
    prev_edition: prev?.edition ?? null,
    prev_revealed: !!reveal,
    prev_source: source,
    current_has_intentional: currentHasIntentionalErrorFlag(updated),
    frontmatter_inserted: frontmatterInserted,
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
