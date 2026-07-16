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
 * **#3222 (260710):** os campos estruturados do erro intencional (description/
 * location/category/correct_value/reveal) vivem em `_internal/intentional-error.json`
 * de cada edição — não mais em frontmatter YAML no topo de `02-reviewed.md`.
 * Motivo: `02-reviewed.md` sincroniza com o Google Drive/Docs (editor revisa lá) e
 * o round-trip de export do Docs colapsava o bloco YAML numa única linha corrompida
 * (#3205/#3222, reproduzido 4x). `_internal/*` nunca sincroniza com o Drive
 * (convenção #959) — o JSON nunca passa pelo round-trip que causava a corrupção.
 * A prosa "Nessa edição, …"/"Na última edição, …" (texto lido pelos assinantes)
 * continua em `02-reviewed.md`, escrita pelo editor — só a estrutura
 * machine-readable saiu de lá.
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
 *   - Garante que `_internal/intentional-error.json` (sibling de `--md`) existe,
 *     escrevendo um placeholder `{PREENCHER}` quando ausente.
 *
 * Stdout: JSON `{ action, prev_edition, prev_revealed, current_has_intentional, json_path }`.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts"; // #2463/#3025: layout flat+nested
import {
  loadIntentionalErrors,
  loadIntentionalErrorJson,
  writeIntentionalErrorJson,
  intentionalErrorJsonPath,
  type IntentionalError,
  type IntentionalErrorJson,
} from "./lib/intentional-errors.ts";
import { SECTION_EMOJI_PREFIX } from "./lib/section-naming.ts"; // #1836 fonte única do prefixo de emoji
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";

export const SECTION_HEADER = "**ERRO INTENCIONAL**";

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
 * (#2438 DRY) Regex legado para extrair detail/gabarito do formato
 * "escrevi 'X' onde deveria ser 'Y'". Compartilhado por
 * extractCurrentDeclarationFromMd e extractPreviousRevealFromRecord (#3494 —
 * split de extractIntentionalErrorFromMd, onde aparecia duplicado em 2
 * lugares) para eliminar a duplicação.
 */
const LEGACY_DETAIL_RE =
  /escrevi\s+(["'])([^"']+?)\1\s+onde\s+deveria\s+ser\s+(["'])([^"']+?)\3/i;

/**
 * (#3222) Extrai um campo string do record JSON, tratando placeholder
 * `{PREENCHER…}` e string vazia como ausente. Substitui o antigo parse de
 * regex sobre o bloco YAML do frontmatter (extractIeFields/extractField) —
 * o JSON já vem estruturado, então não há mais block-scalar YAML nem aspas
 * pra desembrulhar.
 */
function jsonField(
  record: IntentionalErrorJson | null | undefined,
  field: "description" | "location" | "category" | "correct_value" | "reveal",
): string | null {
  if (!record) return null;
  const val = record[field];
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  if (trimmed.length === 0) return null;
  if (/^\{PREENCHER/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * Pure (#2419, #3222 migrado pra JSON): extrai o campo `reveal` do record
 * `_internal/intentional-error.json`. `reveal` é o campo CANÔNICO do reveal —
 * prosa FIRST-PERSON, gramatical, pública. Ex: "Na última edição, escrevi
 * 1990 onde o correto é 1998." Separado de `description` (catálogo 3ª
 * pessoa, alimenta lint + /diaria-mes-erros) — `description` NUNCA é fonte
 * do reveal.
 *
 * Retorna `null` quando: record ausente, sem `reveal`, ou valor é placeholder
 * `{PREENCHER}`.
 */
export function extractRevealFromFrontmatter(
  record: IntentionalErrorJson | null | undefined,
): string | null {
  return jsonField(record, "reveal");
}

/**
 * (#3222) Alias de `extractRevealFromFrontmatter` — pré-#3222 esta função
 * também lia um alias legado `narrative:` do frontmatter (não existe mais no
 * schema JSON), então hoje é idêntica. Mantida como nome separado só por
 * back-compat de import; delega inteiramente.
 */
export function extractNarrativeFromFrontmatter(
  record: IntentionalErrorJson | null | undefined,
): string | null {
  return extractRevealFromFrontmatter(record);
}

/**
 * Pure (#3489 split): extrai a prosa CRUA "Nessa edição, {narrativa}." do
 * bloco ERRO INTENCIONAL em `02-reviewed.md`, SEM aplicar nenhum filtro de
 * exclusão (placeholder/genérico/catalog-shaped/auto-concatenado). Usada por
 * `extractCurrentDeclarationFromMd` (que filtra) e por consumidores que
 * precisam classificar A RAZÃO pela qual uma narrativa é inválida — ex: o
 * lint `erro-intencional-placeholder` (#3489), que precisa distinguir "sem
 * narrativa nenhuma" de "narrativa presente mas corrompida" pra dar uma
 * mensagem de erro específica em vez de deixar passar silenciosamente.
 *
 * Retorna a narrativa trimmed, ou `null` se a linha "Nessa edição, …" não
 * foi encontrada no bloco.
 */
export function extractRawCurrentNarrative(md: string): string | null {
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
  return nm[1].trim();
}

/**
 * Pure (#961 / #1079 / #2411 / #2419 / #3494 split / #3489 raw split):
 * extrai a declaração da edição CORRENTE a partir da prosa "Nessa edição, …"
 * em `02-reviewed.md`.
 *
 * **NUNCA recebe/consulta `record` (`_internal/intentional-error.json`)** — o
 * campo `record.reveal` é prosa PRÉ-ESCRITA pelo editor, em primeira pessoa
 * PASSADA ("Na última edição, escrevi X…"), destinada à PRÓXIMA edição
 * revelar o erro DESTA edição (ver `extractRevealFromFrontmatter`). Não é a
 * mesma coisa que "a declaração que esta edição faz de si mesma" — misturar
 * as duas produzia "Nessa edição, Na última edição, escrevi X…" (#3205→#3485→
 * #3494: três bandaids no mesmo defeito estrutural antes deste split). Quando
 * o corpo precisa de fallback pro record de uma edição ANTERIOR (caso de
 * `findPreviousIntentionalErrorFromMd`), use `extractPreviousRevealFromRecord`.
 *
 * Filtros de exclusão sobre a prosa do corpo:
 *   - Placeholder `{PREENCHER…}` não preenchido.
 *   - Texto genérico do convite ("há um erro proposital", "concorrer ao sorteio" etc.).
 *   - (#2419 bug #9 fix) Texto catalog-shaped ("DESTAQUE N …") — label interno
 *     que vaza ao reveal público e é agramatical com "Nessa edição, DESTAQUE N…".
 *   - (#3489) Texto auto-concatenado ("Nessa edição, Na última edição, …") —
 *     assinatura exata da classe de bug do #3485: o reveal PASSADO acabou
 *     colado no lugar da declaração CORRENTE.
 *
 * Retorna `{ narrative, detail?, gabarito? }` (detail/gabarito só quando a
 * narrativa bate com o formato legado "escrevi 'X' onde deveria ser 'Y'").
 */
export function extractCurrentDeclarationFromMd(
  md: string,
): { narrative: string; detail?: string; gabarito?: string } | null {
  const narrative = extractRawCurrentNarrative(md);
  if (!narrative) return null;

  // Filtros de exclusão: placeholder não preenchido, texto genérico do
  // convite, texto catalog-shaped, texto auto-concatenado (ver docstring acima).
  if (
    /^\{PREENCHER/i.test(narrative) ||
    narrativeIsGenericPlaceholder(narrative) ||
    narrativeIsCatalogShaped(narrative) ||
    narrativeIsSelfConcatenated(narrative)
  ) {
    return null;
  }

  // Back-compat: tenta extrair detail/gabarito do formato legado
  // "escrevi 'X' onde deveria ser 'Y'" pra consumidores antigos.
  // (#2438 DRY) Usa LEGACY_DETAIL_RE compartilhado.
  const lm = narrative.match(LEGACY_DETAIL_RE);
  if (lm) {
    return { narrative, detail: lm[2], gabarito: lm[4] };
  }
  return { narrative };
}

/**
 * Pure (#961 / #1079 / #2411 / #2419 rewrite / #3222 migrado pra JSON / #3494
 * split): extrai o que uma edição PASSADA declarou — prosa de
 * `02-reviewed.md` DESSA MESMA edição + fallback pro `record.reveal` DESSE
 * MESMO `_internal/intentional-error.json` quando a prosa não basta.
 *
 * **Contrato: `md` e `record` devem pertencer à MESMA edição** — a edição
 * sendo consultada como "anterior" por `findPreviousIntentionalErrorFromMd`
 * (ou, em `sync-intentional-error.ts`, a própria edição corrente quando o
 * corpo ainda não tem prosa própria e o `record.reveal` — pré-escrito pelo
 * editor pra usar como reveal na PRÓXIMA edição — é o único dado disponível).
 * NUNCA usar pra extrair a declaração que UMA edição faz de SI MESMA — ver
 * `extractCurrentDeclarationFromMd`, que nunca consulta `record`.
 *
 * **Separação REVEAL × CATÁLOGO (#2419):**
 *   - `description` é CATÁLOGO (3ª pessoa, "DESTAQUE N faz X") — NÃO é fonte do reveal.
 *   - `reveal` (#2419 NEW) é o campo dedicado first-person para o reveal público.
 *   - A prosa "Nessa edição, …" no corpo é fonte de reveal quando nenhum campo
 *     estruturado first-person está disponível.
 *
 * Estratégia de extração:
 *   1. Prosa "Nessa edição, {narrativa}." no corpo (first-person, primário) —
 *      via `extractCurrentDeclarationFromMd`.
 *   2. `record.reveal` (`_internal/intentional-error.json`, #3222).
 *      NUNCA usa `description` — catálogo 3ª pessoa.
 *   3. Se nenhuma das duas, retornar null.
 *
 * Retorna `{ narrative, reveal? }` no novo formato; campos `detail/gabarito` ficam
 * derivados pelos consumidores que ainda precisam deles (back-compat).
 */
export function extractPreviousRevealFromRecord(
  md: string,
  record?: IntentionalErrorJson | null,
): { narrative: string; detail?: string; gabarito?: string; correct_value?: string; reveal?: string } | null {
  const correctValue = extractCorrectValueFromFrontmatter(record);
  // (#2419) Extrair o campo `reveal` dedicado para propagação — fonte canônica.
  const revealFromFm = extractRevealFromFrontmatter(record);

  // PRIORIDADE 1 — prosa "Nessa edição, …" no corpo (first-person, fonte
  // primária do reveal). O hábito editorial é o editor escrever a frase de
  // primeira pessoa que vai aparecer como reveal na próxima edição.
  const bodyDeclaration = extractCurrentDeclarationFromMd(md);
  if (bodyDeclaration) {
    return {
      ...bodyDeclaration,
      ...(correctValue ? { correct_value: correctValue } : {}),
      ...(revealFromFm ? { reveal: revealFromFm } : {}),
    };
  }

  // PRIORIDADE 2 — `record.reveal` (`_internal/intentional-error.json`, #3222).
  // NÃO usa `description` — esse campo é catálogo (terceira pessoa).
  const fmNarrative = extractNarrativeFromFrontmatter(record);
  if (fmNarrative) {
    // Back-compat: tenta extrair detail/gabarito do formato legado quando a
    // narrative usa "escrevi 'X' onde deveria ser 'Y'".
    // (#2438 DRY) Usa LEGACY_DETAIL_RE compartilhado.
    const lm = fmNarrative.match(LEGACY_DETAIL_RE);
    if (lm) {
      return {
        narrative: fmNarrative,
        detail: lm[2],
        gabarito: lm[4],
        ...(correctValue ? { correct_value: correctValue } : {}),
        ...(revealFromFm ? { reveal: revealFromFm } : {}),
      };
    }
    return {
      narrative: fmNarrative,
      ...(correctValue ? { correct_value: correctValue } : {}),
      ...(revealFromFm ? { reveal: revealFromFm } : {}),
    };
  }

  return null;
}

/**
 * Pure (#1443, #3222 migrado pra JSON): extrai `correct_value` do record
 * `_internal/intentional-error.json`. Retorna `null` se `record` ausente, sem
 * `correct_value`, ou valor é placeholder `{PREENCHER}`.
 */
export function extractCorrectValueFromFrontmatter(
  record: IntentionalErrorJson | null | undefined,
): string | null {
  return jsonField(record, "correct_value");
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
): { edition: string; detail: string; gabarito: string; narrative: string; correct_value?: string; reveal?: string } | null {
  if (!existsSync(editionsRoot)) return null;
  // #2463/#3025: enumera AMBOS os layouts (flat legado + nested novo) — antes
  // um `readdirSync(editionsRoot)` direto perdia edições no layout nested
  // pós-#3023.
  const editionDirsByAammdd = enumerateEditionDirs(editionsRoot);
  const candidates = [...editionDirsByAammdd.keys()]
    .filter((d) => d < currentEdition)
    .sort((a, b) => (a < b ? 1 : -1));
  for (const editionId of candidates) {
    const editionDir = editionDirsByAammdd.get(editionId)!;
    const mdPath = join(editionDir, "02-reviewed.md");
    if (!existsSync(mdPath)) continue;
    let md: string;
    try {
      md = readFileSync(mdPath, "utf8");
    } catch {
      continue;
    }
    // (#3222) O `record` estruturado da edição ANTERIOR vive no `_internal/`
    // dela, não no `_internal/` da edição atual — precisa ler explicitamente
    // pelo editionDir resolvido acima (não é o mesmo diretório que `--md`).
    const record = loadIntentionalErrorJson(intentionalErrorJsonPath(editionDir));
    const extracted = extractPreviousRevealFromRecord(md, record);
    if (extracted) {
      return {
        edition: editionId,
        detail: extracted.detail ?? extracted.narrative,
        gabarito: extracted.gabarito ?? "",
        narrative: extracted.narrative,
        ...(extracted.correct_value ? { correct_value: extracted.correct_value } : {}),
        // (#2419) Propaga campo `reveal` quando disponível
        ...(extracted.reveal ? { reveal: extracted.reveal } : {}),
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
 * Detecta se a narrativa é texto catálogo de terceira pessoa (#2411).
 * Texto catálogo começa com um label interno como "DESTAQUE N" (ex:
 * "DESTAQUE 2 lista o Spotify..." ou "DESTAQUE 3 (Microsoft/DeepSeek): ...").
 *
 * Esses labels são do sistema editorial interno — vazar para o reveal público
 * como "Na última edição, DESTAQUE 2 lista..." é gramaticalmente errado e
 * expõe terminologia interna ao assinante.
 *
 * Retorna `true` quando o texto parece catálogo (deve bloquear no reveal).
 * Retorna `false` quando parece prosa de primeira pessoa para o reveal.
 *
 * Exportada para uso nos testes e em defense-in-depth de composeRevealText.
 */
export function narrativeIsCatalogShaped(narrative: string): boolean {
  return /^DESTAQUE\s+\d|^[A-ZÁÉÍÓÚÀÂÊÔÃÕÜ]{4,}\s+\d/i.test(narrative);
}

/**
 * Detecta se a narrativa é o resultado de auto-concatenação do reveal
 * PASSADO com a declaração CORRENTE (#3489, causa raiz #3485). Uma narrativa
 * válida da edição corrente nunca começa com "Na última edição," — essa é a
 * abertura fixa do reveal da edição ANTERIOR (ver `composeRevealText` /
 * `SAFE_FALLBACK_REVEAL`), não da declaração desta edição sobre si mesma.
 *
 * Assinatura exata do bug observado: um fallback não-idempotente escrevia
 * `"Nessa edição, Na última edição, escrevi que a Acme foi fundada em 2020,
 * quando na verdade foi em 2022."` — texto agramatical e auto-contraditório
 * que não contém o placeholder literal `{PREENCHER_NARRATIVA_DO_ERRO}`, então
 * passava incólume pelo lint que só olhava o placeholder (#3489).
 *
 * Retorna `true` quando o narrative parece corrompido por auto-concatenação
 * (deve bloquear). Retorna `false` caso contrário.
 *
 * Exportada para uso no lint do Stage 5 (erro-intencional-placeholder) e
 * como defense-in-depth em `extractCurrentDeclarationFromMd`.
 */
const SELF_CONCATENATION_RE = /^Na\s+[úu]ltima\s+edi[çc][ãa]o,/i;

export function narrativeIsSelfConcatenated(narrative: string): boolean {
  return SELF_CONCATENATION_RE.test(narrative.trim());
}

/**
 * (#2438 DRY) Texto de fallback seguro quando nenhuma fonte válida de reveal existe.
 * Centralizado aqui para evitar as 5 ocorrências inline em composeRevealText — o texto
 * é byte-idêntico ao original (refactor puro, sem mudança de comportamento).
 */
const SAFE_FALLBACK_REVEAL =
  `Na última edição, escondemos um erro proposital — obrigado a quem respondeu apontando.`;

/**
 * Pure (#1079, #1443, #2419 rewrite): compõe o texto de revelação do erro anterior.
 *
 * **ARQUITETURA #2419 — campo `reveal` dedicado:**
 *
 * Prioridade:
 *   1. Campo `reveal` do entry/JSONL (propagado de `_internal/intentional-error.json.reveal`, #3222).
 *      Usado verbatim, exceto a formatação boldQuotedStrings (aspas → negrito, convenção
 *      da newsletter). É prosa first-person, gramatical, pública, escrita pelo editor.
 *      Ex: "Na última edição, escrevi 1990 onde o correto é 1998."
 *      NUNCA aplicar regex, síntese ou transformação além de boldQuotedStrings.
 *   2. Campo `narrative` legado (edições pré-#2419 sem `reveal`).
 *      Se presente e não for catálogo/genérico, aplicar lógica de correção (#1443).
 *   3. Campo `detail` legado (JSONL entries antigos sem `narrative`).
 *      Se não for catalog-shaped, usar com `gabarito` ou `correct_value`.
 *   4. Fallback SEGURO genérico: texto fixo sem menção de conteúdo específico.
 *      NUNCA sintetizar a partir de `description`/catálogo — isso vaza labels internos.
 *
 * Invariante de segurança: se NENHUMA fonte válida de reveal existir (reveal ausente,
 * narrative ausente ou catalog-shaped/genérico, detail ausente ou catalog-shaped),
 * o fallback SEGURO é retornado. NUNCA tenta construir reveal a partir de `description`.
 *
 * Strings entre aspas são envoltas em negrito (#915).
 */
export function composeRevealText(
  prev: IntentionalError & { narrative?: string; gabarito?: string },
): string {
  const reveal = (prev.reveal ?? "").trim();
  const narrative = (prev.narrative ?? "").trim();
  const detail = (prev.detail ?? "").trim();
  const gabarito = (prev.gabarito ?? "").trim();
  const correctValue = (prev.correct_value ?? "").trim();

  // PRIORIDADE 1: campo `reveal` dedicado (#2419).
  // Usado VERBATIM — prosa first-person escrita pelo editor. Não transformar,
  // exceto a formatação boldQuotedStrings (aspas → negrito, convenção da newsletter).
  // Guard de sanidade: não publicar catalog-shaped ou genérico mesmo que alguém
  // preencheu o campo `reveal` erroneamente com catálogo.
  if (reveal) {
    if (!narrativeIsCatalogShaped(reveal) && !narrativeIsGenericPlaceholder(reveal)) {
      // Verbatim: o `reveal` já é a frase completa (ex: "Na última edição, escrevi X.")
      // NÃO prefixar com "Na última edição" — o editor já escreveu a frase completa.
      // F1: guard de pontuação terminal — aceita ., ! ou ? para evitar "viu?." duplo.
      return boldQuotedStrings(/[.!?]$/.test(reveal.trim()) ? reveal : `${reveal}.`);
    }
    // reveal é catalog-shaped ou genérico — warn e cair para fallback
    console.warn(
      "[render-erro-intencional] WARN (#2419): campo `reveal` parece catálogo ou placeholder. " +
        "Usando fallback seguro. Corrija `reveal` em `_internal/intentional-error.json`.",
    );
    return boldQuotedStrings(
      SAFE_FALLBACK_REVEAL,
    );
  }

  // PRIORIDADE 2: campo `narrative` legado.
  // (edições pré-#2419 que preencheram o campo `narrative` ou a prosa "Nessa edição, …")
  if (narrative) {
    // Guard: narrative genérico (placeholder do convite ao sorteio) → warn + fallback.
    if (narrativeIsGenericPlaceholder(narrative)) {
      console.warn(
        "[render-erro-intencional] WARN (#2377): narrative do erro intencional parece ser " +
          "um placeholder genérico (\"há um erro proposital\", \"responda este e-mail\", etc.). " +
          "Usando fallback seguro. Preencha `reveal` em `_internal/intentional-error.json`.",
      );
      return boldQuotedStrings(
        SAFE_FALLBACK_REVEAL,
      );
    }
    // Guard: narrative catalog-shaped (começa com "DESTAQUE N") → warn + fallback seguro.
    // NÃO tenta "consertar" adicionando correct_value — um catalog-shaped é ilegível.
    if (narrativeIsCatalogShaped(narrative)) {
      console.warn(
        "[render-erro-intencional] WARN (#2411/#2419): narrative parece catálogo de terceira " +
          "pessoa (label interno \"DESTAQUE N\" ou similar). Usando fallback seguro. " +
          "Preencha `reveal` em `_internal/intentional-error.json` com texto first-person.",
      );
      return boldQuotedStrings(
        SAFE_FALLBACK_REVEAL,
      );
    }
    // Narrative válida — aplicar lógica de correção (#1443).
    let narrativeFinal: string;
    if (narrativeHasCorrection(narrative)) {
      narrativeFinal = narrative;
    } else if (correctValue) {
      narrativeFinal = `${narrative.replace(/\.$/, "")}, o correto é ${correctValue}`;
    } else {
      // Narrative sem correção e sem correct_value — formato incompleto, mas não bloqueia.
      console.warn(
        "[render-erro-intencional] WARN: narrativa do erro intencional sem frase " +
          "de correção (\"o correto é Y\") e sem `intentional_error.correct_value` " +
          "em `_internal/intentional-error.json` da edição anterior — reveal sairá sem correção explícita.",
      );
      narrativeFinal = narrative;
    }
    return boldQuotedStrings(`Na última edição, ${narrativeFinal}.`);
  }

  // PRIORIDADE 3: campo `detail` legado (JSONL entries antigos sem `narrative`/`reveal`).
  if (detail) {
    // Guard: detail catalog-shaped (sync-intentional-error.ts copia description → detail).
    // (#2419) NÃO tenta "consertar" adicionando correct_value — catalog é ilegível.
    if (narrativeIsCatalogShaped(detail)) {
      console.warn(
        "[render-erro-intencional] WARN (#2419): detail parece catálogo de terceira pessoa " +
          "(label interno \"DESTAQUE N\" ou similar). Usando fallback seguro. " +
          "Preencha `reveal` em `_internal/intentional-error.json` da edição anterior.",
      );
      return boldQuotedStrings(
        SAFE_FALLBACK_REVEAL,
      );
    }
    let narrativeFinal: string;
    if (correctValue) {
      narrativeFinal = `${detail.replace(/\.$/, "")}, o correto é ${correctValue}`;
    } else if (gabarito) {
      narrativeFinal = `${detail}, mas o correto era ${gabarito}`;
    } else {
      narrativeFinal = detail;
    }
    return boldQuotedStrings(`Na última edição, ${narrativeFinal}.`);
  }

  // PRIORIDADE 4: fallback SEGURO genérico.
  // F2: string unificada com os outros caminhos de fallback — NUNCA sintetizar
  // a partir de `description` ou catálogo. Nenhum caminho de fallback vaza
  // catálogo/description.
  return boldQuotedStrings(SAFE_FALLBACK_REVEAL);
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
  // (#3222 introduziu `opts.currentRecord` como fallback pra extrair a
  // declaração corrente do `_internal/intentional-error.json` quando a prosa
  // "Nessa edição, …" ainda não tinha sido escrita no corpo. #3485: esse
  // fallback foi REMOVIDO — `record.reveal` é prosa em 1ª pessoa PASSADA
  // ("Na última edição, escrevi X...") escrita para a PRÓXIMA edição revelar,
  // não para esta mesma edição convidar o leitor a achar o erro. Ao preencher
  // só `description`/`reveal` no JSON (sem tocar o corpo do MD) e re-rodar, o
  // fallback produzia "Nessa edição, Na última edição, escrevi X..." —
  // conteúdo corrompido/gramaticalmente incoerente sobrescrevendo o
  // placeholder (ou, pior, uma prosa real já escrita ficaria arriscada a ser
  // substituída por esse texto malformado num rerun). A declaração corrente
  // só vem do que o EDITOR já escreveu no corpo — se ainda não escreveu, o
  // placeholder "{PREENCHER_NARRATIVA_DO_ERRO}" permanece como sinal correto
  // de pendência, em vez de fabricar texto incorreto a partir de um campo
  // com público/tempo verbal diferentes.
  const currentExtracted = extractCurrentDeclarationFromMd(md);
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
 * Pure (#3222 migrado pra JSON): detecta se a edição corrente tem
 * `intentional_error` declarado — presença do record `_internal/intentional-error.json`
 * (mesmo com valores placeholder, igual ao comportamento antigo do frontmatter).
 */
export function currentHasIntentionalErrorFlag(
  record: IntentionalErrorJson | null | undefined,
): boolean {
  return record != null;
}

/**
 * Pure (#2284, #3222 migrado pra JSON): garante que `_internal/intentional-error.json`
 * existe, escrevendo um placeholder quando ausente.
 *
 * Usado pelo render-erro-intencional no final do Stage 2 (pós-Clarice, em
 * modo auto/pre-gate) pra que o placeholder exista antes do gate humano —
 * o editor preenche os campos via chat (não mais editando o Drive — essa
 * troca é o próprio ponto do #3222: `_internal/*` nunca sincroniza com o
 * Drive, então o JSON nunca passa pelo round-trip do Google Docs que
 * corrompia o antigo bloco YAML, #3205). Sem isso, o lint do Stage 5
 * (`intentional-error-flagged`) aborta na hora da publicação, e o editor
 * precisa fornecer o erro na correria — como ocorreu em 260615 (frontmatter).
 *
 * Caso o JSON já exista → no-op idempotente (não sobrescreve valores já
 * preenchidos). Caso ausente → escreve os 5 campos como placeholders
 * `{PREENCHER}`. O lint do Stage 5 rejeita valores que ainda contêm
 * `{PREENCHER}` (guard em `checkIntentionalError`,
 * `scripts/lib/lint-checks/intentional-error.ts`).
 */
export function ensureIntentionalErrorJson(
  jsonPath: string,
): { inserted: boolean } {
  if (existsSync(jsonPath)) {
    return { inserted: false };
  }
  const placeholder: IntentionalErrorJson = {
    description:
      "{PREENCHER — o que o assinante deve identificar (catálogo 3ª pessoa, não vai pro reveal)}",
    location: "{PREENCHER — ex: DESTAQUE 2, parágrafo 1}",
    category:
      "{PREENCHER — factual|ortografico|numeric|attribution|data|version_inconsistency|factual_synthetic}",
    correct_value: "{PREENCHER — valor correto}",
    reveal:
      "{PREENCHER — prosa 1ª pessoa para o reveal da próxima edição, ex: Na última edição, escrevi X onde o correto é Y.}",
  };
  writeIntentionalErrorJson(jsonPath, placeholder);
  return { inserted: true };
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
  /** (#2419) Campo reveal dedicado quando disponível no _internal/intentional-error.json do MD anterior. */
  reveal?: string;
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
    // (#2419) Propaga campo `reveal` do MD quando disponível
    ...(md.reveal ? { reveal: md.reveal } : {}),
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
      // (#2419) reveal também vem do MD (campo autoritativo para o reveal público).
      const enriched: RevealEntry = {
        ...fromJsonl,
        narrative: fromMd.narrative,
        gabarito: fromMd.gabarito,
        ...(fromMd.detail ? { detail: fromMd.detail } : {}),
        ...(fromMd.correct_value ? { correct_value: fromMd.correct_value } : {}),
        ...(fromMd.reveal ? { reveal: fromMd.reveal } : {}),
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
  // com dados estruturados de _internal/intentional-error.json. MD extraction é fallback pra
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
  // (#3222) `_internal/intentional-error.json` da edição CORRENTE — sibling do
  // `--md` recebido. Usado por `currentHasIntentionalErrorFlag` (result final,
  // abaixo) e por `ensureIntentionalErrorJson`. #3485: NÃO é mais passado pra
  // `insertOrUpdateSection` — ver comentário na própria função pro motivo
  // (fallback removido por corromper a linha "Nessa edição, …").
  const currentJsonPath = intentionalErrorJsonPath(dirname(mdPath));
  const currentRecord = loadIntentionalErrorJson(currentJsonPath);

  // #1279: --preserve-existing-reveal opt-in; default = fresh reveal sobrescreve
  // existente pra evitar bug de stale text herdado de edições anteriores.
  const preserveExistingReveal = process.argv.includes("--preserve-existing-reveal");
  const { md: updated, action } = insertOrUpdateSection(md, reveal, {
    preserveExistingReveal,
  });

  if (action !== "no_change") {
    writeFileSync(mdPath, updated, "utf8");
  }

  // #2284/#3222: garantir que `_internal/intentional-error.json` existe (com
  // placeholders quando ausente) pra que o gate humano do Stage 4 lembre o
  // editor de fornecer os campos antes da publicação. Sem isso,
  // check-stage2-invariants passa "verde" mas o lint do Stage 5 aborta na hora H.
  const { inserted: jsonInserted } = ensureIntentionalErrorJson(currentJsonPath);

  const result = {
    action,
    prev_edition: prev?.edition ?? null,
    prev_revealed: !!reveal,
    prev_source: source,
    current_has_intentional: currentHasIntentionalErrorFlag(
      jsonInserted ? loadIntentionalErrorJson(currentJsonPath) : currentRecord,
    ),
    frontmatter_inserted: jsonInserted,
    path: mdPath,
    json_path: currentJsonPath,
  };
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}
