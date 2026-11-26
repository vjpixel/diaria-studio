/**
 * Invariantes do Stage 4 — repetição, recorrência e fontes (fatos, histórias, temas, URLs, destaques, marcadores de patrocínio) (#14057).
 *
 * Família extraída de `../stage-4.ts` (divisão sem mudança de lógica). O
 * registro `STAGE_4_RULES` e o reexport público continuam em `../stage-4.ts`:
 * importe sempre de lá.
 */

import { recurringEventThemes, editionDaysBefore } from "../../event-dedup.ts";
import {
  findFactRecurrences,
  findIntraEditionFactRecurrences,
  type IntraEditionItem,
} from "../../fact-recurrence.ts";
import { findStoryTwice, type PastStoryItem } from "../../story-twice-in-edition.ts"; // #11496
import { recentEditionDirs } from "../../past-editions-extract.ts"; // #11496
import {
  findStudySourceRecurrences,
  formatStudySourceWarning,
  STUDY_RECURRENCE_WINDOW_DAYS,
} from "../../study-source-recurrence.ts"; // #11763
import {
  findStoryContinuations,
  formatStoryContinuationWarning,
  STORY_CONTINUATION_WINDOW_DAYS,
} from "../../story-continuation.ts"; // #11897
import {
  findStaleHighlightRepeats,
  formatStaleHighlightWarning,
  findSourceStaleDate,
  STALE_HIGHLIGHT_WINDOW_DAYS,
} from "../../stale-highlight.ts"; // #13313, #13364
import { contentJaccard, REPEAT_THEME_WARN_THRESHOLD } from "../../repeat-theme-check.ts"; // #11517
import { readPossibleRepeatWarnings, formatPossibleRepeat } from "../../secondary-theme-repeat.ts"; // #13143
import { enumerateEditionDirs } from "../../find-current-edition.ts"; // #11496
import { existsSync, readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import type { InvariantViolation } from "../types.ts";
import {
  parseSections, // #11173
} from "../../newsletter-parse.ts";
import { detectRemovedApprovedItems } from "../../lint-checks/approved-item-removal.ts"; // #8121
import { readStage4DroppedItems, stage4DroppedUrlSet } from "../../stage4-dropped-items.ts"; // #10100
import { urlsMatch, canonicalize, dedupUrlKey } from "../../url-utils.ts";
import {
  DESTAQUE_REQUEST_FIELD,
  findEditorDestaqueRequestIssues,
  findRepeatedDestaques,
  formatPastPublications,
  readDestaqueOnlyOrigin,
  UNKNOWN_SECTION,
  type DestaqueRequest,
  type FunnelItemLite,
  type PastPublication,
  type RepeatedDestaque,
} from "../../destaque-upgrade.ts"; // #12193, #13883
import { extractUrlsWithLines } from "../../../validate-domains.ts"; // #8993
import { isNonEditorialHost } from "../../ctr-utils.ts"; // #8993
import {
  readPastEditionsMd,
  extractPastUrlsWithOriginWithinDays,
  DEDUP_URL_WINDOW_DAYS,
  extractPastPublicationsWithinDays,
} from "../../past-editions-extract.ts"; // #8993, #9955, #12193, #13883
import { detectSponsoredMarkers } from "../../lint-checks/sponsored-source-markers.ts"; // #10169
import { loadCachedBody } from "../../url-body-cache.ts"; // #10169
import { ROOT } from "./_shared.ts";

/**
 * #10169: WARN-only — página-fonte (corpo cacheado do Stage 1 em
 * `_internal/_forensic/link-verify-bodies`) ou path da URL com marcador de
 * publieditorial. Nunca bloqueia nem descarta item (decisão do editor, #7401):
 * entra no resumo do gate e o editor decide. Sem corpo cacheado, só vale o
 * marcador de path da URL.
 */
export function checkSponsoredSourceMarkers(editionDir: string): InvariantViolation[] {
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(reviewedPath)) return [];
  let md: string;
  try {
    md = readFileSync(reviewedPath, "utf8");
  } catch {
    return [];
  }
  const bodiesDir = resolve(editionDir, "_internal", "_forensic", "link-verify-bodies");
  const out: InvariantViolation[] = [];
  for (const { url, line } of extractUrlsWithLines(md)) {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (isNonEditorialHost(host)) continue;
    const markers = detectSponsoredMarkers(url, loadCachedBody(bodiesDir, url));
    if (markers.length === 0) continue;
    out.push({
      rule: "sponsored-source-marker",
      message:
        `possível publieditorial em ${url} (marcador: ${markers.join(", ")}) — ` +
        `confirmar no gate se é anúncio; manter, trocar ou sinalizar (#10169).`,
      source_issue: "#10169",
      severity: "warning",
      file: reviewedPath,
      line,
    });
  }
  return out;
}

/**
 * #11083: parágrafo editorial de `02-reviewed.md` (qualquer seção) que parece
 * repetir um INCIDENTE já coberto nos últimos 30 dias de
 * `data/past-editions.md`, mesmo com URL e título diferentes. Cada parágrafo
 * com link vira um item; a heurística (`findFactRecurrences`) exige termo de
 * incidente nos dois lados e peso de entidades compartilhadas >= 2, ignorando a
 * palavra que abre cada frase do parágrafo (#11109). Severity "warning": o
 * editor confirma se é fato novo.
 */
export function checkFactRecurrence(editionDir: string, pastMd?: string): InvariantViolation[] {
  const file = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(file)) return [];
  const md = readFileSync(file, "utf8");
  // Each editorial paragraph carries its own link and context, across all sections.
  const items = md.split(/\n\s*\n/).flatMap(title =>
    extractUrlsWithLines(title).map(({ url }) => ({ title, url })));
  return findFactRecurrences(items, pastMd ?? readPastEditionsMd(resolve(ROOT, "data/past-editions.md")), basename(editionDir))
    .map(w => ({ rule: "fact-recurrence", source_issue: "#11083", severity: "warning" as const, file,
      message: `Possível mesmo fato: ${w.item_title} (${w.item_url}) vs ${w.matched_edition} “${w.matched_title}”; score=${w.score}, entidades=${w.shared_entities.join(", ")}. ${w.possible_new_fact} Heurístico: o editor confirma a novidade.` }));
}

/**
 * #11173: lê `02-reviewed.md` e separa os DESTAQUES (bloco `**DESTAQUE N …**`
 * até o `---`: manchete = texto do 1º link, resumo = resto do bloco sem o rótulo
 * e sem "Por que isso importa:") dos itens do pool (LANÇAMENTOS/USE MELHOR/
 * RADAR…, via `parseSections`, o mesmo parser do render). Exportada para teste.
 */
export function readIntraEditionItems(md: string): { highlights: IntraEditionItem[]; pool: IntraEditionItem[] } {
  const highlights: IntraEditionItem[] = [];
  for (const block of md.split(/^---$/m)) {
    const head = block.match(/^\s*\*\*DESTAQUE\s+(\d)[^\n]*$/m);
    if (!head) continue;
    const link = block.match(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/);
    if (!link) continue;
    const body = block
      .replace(head[0], "")
      .replace(/^\s*Por que isso importa:?\s*$/gim, "")
      .replace(/\*\*/g, "");
    highlights.push({ label: `D${head[1]}`, title: link[1].replace(/\*\*/g, ""), summary: body, url: link[2] });
  }
  const pool = parseSections(md).flatMap(s =>
    s.items.map(it => ({ label: s.name, title: it.title.replace(/\*\*/g, ""), summary: it.description, url: it.url })));
  return { highlights, pool };
}

/**
 * #11173: item do pool que conta a MESMA HISTÓRIA de um destaque da própria
 * edição, ou de outro item do pool (casos reais 261023 — Canaltech e G1 sobre
 * a falha no PHP × D1 da Wiz — e 261016 — Android × Circle to Search). Mesma
 * heurística do `fact-recurrence` (#11083), aplicada dentro da edição
 * (`findIntraEditionFactRecurrences`). Severity "warning": o editor decide se
 * é desdobramento ou corte.
 */
export function checkIntraEditionFactRecurrence(editionDir: string): InvariantViolation[] {
  const file = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(file)) return [];
  const { highlights, pool } = readIntraEditionItems(readFileSync(file, "utf8"));
  return findIntraEditionFactRecurrences(highlights, pool).map(w => {
    const why = [
      ...w.shared_entities,
      ...w.url_entities.map(e => `${e} (na URL)`),
    ].join(", ");
    return {
      rule: "intra-edition-fact-recurrence", source_issue: "#11173", severity: "warning" as const, file,
      message: `Possível mesma história na edição: [${w.item_label}] “${w.item_title}” (${w.item_url}) repete ${w.matched_label} “${w.matched_title}” (${why}). Heurístico: cortar no gate se não for desdobramento.`,
    };
  });
}

/** #11496: quantas edições anteriores entram na comparação de MESMA HISTÓRIA
 *  (`story-twice-in-edition`). Mesma janela curta do gatilho cross-source do
 *  Stage 1 (3 edições): produto+versão repetido mais longe que isso é mais
 *  provável desdobramento que repetição. */
export const STORY_TWICE_PAST_WINDOW = 3;

/**
 * #11496: itens PUBLICADOS (`02-reviewed.md`) das `window` edições anteriores
 * a `currentAammdd` em `editionsRoot` (layout flat ou nested). Arquivo
 * ausente ou ilegível = edição ignorada.
 */
export function readPastStoryItems(
  editionsRoot: string,
  currentAammdd: string,
  window: number = STORY_TWICE_PAST_WINDOW,
  withinDays?: number, // #11763: janela por data (dias) em vez de contagem
): PastStoryItem[] {
  if (!existsSync(editionsRoot)) return [];
  const dirs = enumerateEditionDirs(editionsRoot);
  const out: PastStoryItem[] = [];
  for (const aammdd of recentEditionDirs(editionsRoot, window, currentAammdd, withinDays)) {
    const dir = dirs.get(aammdd);
    if (!dir) continue;
    const file = resolve(dir, "02-reviewed.md");
    if (!existsSync(file)) continue;
    let md: string;
    try {
      md = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const { highlights, pool } = readIntraEditionItems(md);
    for (const h of highlights) out.push({ ...h, aammdd, highlight: true });
    for (const it of pool) out.push({ ...it, aammdd, highlight: false });
  }
  return out;
}

/**
 * #11496: a MESMA HISTÓRIA duas vezes na edição final — destaque × destaque,
 * item do pool × destaque (sinais do dedup intra-edição do Stage 1) — ou
 * qualquer item repetindo, por produto+versão no título, um item publicado nas
 * últimas `STORY_TWICE_PAST_WINDOW` edições. Roda sobre o `02-reviewed.md`
 * FINAL, então pega a duplicata que as trocas do gate (swap/promote/demote)
 * reintroduzem depois do Stage 1 (caso 261029: Siri demovida de D3 voltou ao
 * RADAR repetindo o D2 de 261028; Genie 4 em D2 e em LANÇAMENTOS).
 * Severity "warning" (premissa registrada na PR: o editor pode querer o
 * desdobramento; o aviso sobe ao gate como 🚨, não bloqueia).
 */
export function checkStoryTwiceInEdition(
  editionDir: string,
  editionsRoot: string = resolve(ROOT, "data/editions"),
): InvariantViolation[] {
  const file = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(file)) return [];
  const { highlights, pool } = readIntraEditionItems(readFileSync(file, "utf8"));
  const past = readPastStoryItems(editionsRoot, basename(editionDir));
  return findStoryTwice(highlights, pool, past).map(w => ({
    rule: "story-twice-in-edition", source_issue: "#11496", severity: "warning" as const, file,
    message: w.scope === "edition"
      ? `🚨 Mesma história duas vezes na edição: [${w.item_label}] “${w.item_title}” (${w.item_url}) repete ${w.matched_label} “${w.matched_title}” (sinal: ${w.signal}). Cortar um dos dois no gate, salvo desdobramento.`
      : `🚨 Mesma história de edição recente: [${w.item_label}] “${w.item_title}” (${w.item_url}) repete ${w.matched_label} de ${w.matched_edition} “${w.matched_title}” (${w.signal}). Cortar no gate, salvo fato novo.`,
  }));
}

/**
 * #11496 item 4: o passe de tema do Stage 1 (`check-highlight-themes.ts`)
 * grava em `_internal/01-highlight-theme-check.json → warnings[]` o candidato a
 * destaque que repete o tema de um DESTAQUE recente (`cross_source_match:
 * true`, threshold baixo contra destaques reais, #8951). Esse aviso nunca
 * chegava ao editor: o Stage 1 roda em `--no-gates` e o resumo do gate 4 só
 * lia `same_fact_warnings`. Caso 261029: a Siri do D1 candidato repetia o D2
 * de 261028 (jaccard 0.5) e só foi percebida porque o editor perguntou.
 * Aqui sai como warning 🚨 quando a URL do candidato ainda está no
 * `02-reviewed.md` final; item que já tem `same_fact_warnings` fica de fora
 * (um aviso por item, o MESMO FATO já aparece no gate).
 */
/**
 * #11517: jaccard de conteúdo (sem palavras de anúncio genéricas) a partir do
 * qual o aviso cross-source sai como 🚨 "Cortar no gate". Mesmo valor do passe
 * padrão de tema (`JACCARD_THRESHOLD` de check-highlight-themes.ts). O caso
 * real da 261029 (Siri) dá 0.57; os falsos positivos da 261015 dão 0.
 */
export const THEME_CROSS_SOURCE_CUT_MIN_JACCARD = 0.35;

export function checkThemeCrossSourceRepeat(editionDir: string): InvariantViolation[] {
  const reviewed = resolve(editionDir, "02-reviewed.md");
  const themeFile = resolve(editionDir, "_internal", "01-highlight-theme-check.json");
  if (!existsSync(reviewed) || !existsSync(themeFile)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(themeFile, "utf8"));
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const { warnings, same_fact_warnings } = parsed as { warnings?: unknown; same_fact_warnings?: unknown };
  if (!Array.isArray(warnings)) return [];
  const sameFactUrls = new Set(
    (Array.isArray(same_fact_warnings) ? same_fact_warnings : [])
      .map((w) => (w && typeof w === "object" ? (w as { item_url?: unknown }).item_url : undefined))
      .filter((u): u is string => typeof u === "string")
      .map((u) => canonicalize(u)),
  );
  const inEdition = new Set(extractUrlsWithLines(readFileSync(reviewed, "utf8")).map(({ url }) => canonicalize(url)));
  const out: InvariantViolation[] = [];
  const seen = new Set<string>();
  for (const w of warnings) {
    if (!w || typeof w !== "object") continue;
    const { cross_source_match, candidate_url, candidate_title, matched_edition, matched_title, jaccard, effective_threshold } = w as Record<string, unknown>;
    if (cross_source_match !== true || typeof candidate_url !== "string") continue;
    const url = canonicalize(candidate_url);
    if (!inEdition.has(url) || sameFactUrls.has(url) || seen.has(url)) continue;
    // #11517: gradua pelo jaccard SEM palavras de anúncio genéricas
    // ("introducing", "update"...), recalculado dos dois títulos. O piso é o
    // MESMO que o Stage 1 usou para aceitar o par (`effective_threshold`: 0.20,
    // ou 0.15 quando os títulos têm entidade nomeada em comum, #11652); sem o
    // campo (arquivo antigo), 0.20. Abaixo desse piso o par só tinha casado
    // por palavra genérica: não sobe. Entre o piso e
    // THEME_CROSS_SOURCE_CUT_MIN_JACCARD sobe sem 🚨, como conferência;
    // "Cortar no gate" fica para o par com sobreposição de conteúdo real.
    // Sem os dois títulos, cai no jaccard gravado pelo Stage 1.
    const contentSim =
      typeof candidate_title === "string" && typeof matched_title === "string"
        ? contentJaccard(candidate_title, matched_title)
        : typeof jaccard === "number" ? jaccard : THEME_CROSS_SOURCE_CUT_MIN_JACCARD;
    const floor =
      typeof effective_threshold === "number" && Number.isFinite(effective_threshold)
        ? effective_threshold
        : REPEAT_THEME_WARN_THRESHOLD;
    if (contentSim < floor) continue;
    seen.add(url);
    const pair = `“${String(candidate_title ?? "")}” (${candidate_url}) × ${String(matched_edition ?? "?")} “${String(matched_title ?? "")}” (jaccard=${String(jaccard ?? "?")}, sem palavras genéricas=${Math.round(contentSim * 100) / 100}, gatilho cross-source do Stage 1)`;
    out.push({
      rule: "theme-cross-source-repeat", source_issue: "#11496", severity: "warning", file: reviewed,
      message: contentSim >= THEME_CROSS_SOURCE_CUT_MIN_JACCARD
        ? `🚨 Repete tema de destaque recente: ${pair}. Cortar no gate, salvo fato novo.`
        : `Possível tema de destaque recente (sinal fraco): ${pair}. Conferir no gate se é o mesmo assunto.`,
    });
  }
  return out;
}

/**
 * #13143: item do pool (RADAR, LANÇAMENTOS, USE MELHOR...) que o passe
 * secundário do Stage 1 marcou `possible_repeat` (entidade + termo de conteúdo
 * em comum com item publicado nas últimas edições) e que segue no
 * `02-reviewed.md` final. Caso 261116: RADAR "Claude transformou planilha em
 * uma conversa" (StartSe) × destaque de 261113 "Claude agora monta planilhas e
 * lousas com seu time". O Stage 1 roda em `--no-gates` e este aviso não subia a
 * lugar nenhum. Severity "warning": desdobramento com fato novo é legítimo, o
 * editor decide no gate. Item que já tem `same_fact_warnings` fica de fora (um
 * aviso por item).
 */
export function checkSecondaryThemePossibleRepeat(editionDir: string): InvariantViolation[] {
  const reviewed = resolve(editionDir, "02-reviewed.md");
  const themeFile = resolve(editionDir, "_internal", "01-highlight-theme-check.json");
  if (!existsSync(reviewed) || !existsSync(themeFile)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(themeFile, "utf8"));
  } catch {
    return [];
  }
  const sameFact = (parsed as { same_fact_warnings?: unknown } | null)?.same_fact_warnings;
  const sameFactUrls = new Set(
    (Array.isArray(sameFact) ? sameFact : [])
      .map((w) => (w && typeof w === "object" ? (w as { item_url?: unknown }).item_url : undefined))
      .filter((u): u is string => typeof u === "string")
      .map((u) => canonicalize(u)),
  );
  const inEdition = new Set(extractUrlsWithLines(readFileSync(reviewed, "utf8")).map(({ url }) => canonicalize(url)));
  const seen = new Set<string>();
  const out: InvariantViolation[] = [];
  for (const w of readPossibleRepeatWarnings(parsed)) {
    const url = canonicalize(w.item_url);
    if (!inEdition.has(url) || sameFactUrls.has(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({
      rule: "secondary-theme-possible-repeat", source_issue: "#13143", severity: "warning", file: reviewed,
      message: formatPossibleRepeat(w),
    });
  }
  return out;
}

/**
 * #11763: item do `02-reviewed.md` final (destaque ou pool) que é cobertura
 * secundária (imprensa) de um estudo/relatório já publicado nos últimos
 * `STUDY_RECURRENCE_WINDOW_DAYS` dias, com URL e redação novas (caso 261103:
 * CNN "IA trabalha seis vezes mais que humanos" × D1 de 261020 sobre o
 * relatório da Anthropic). Roda sobre o arquivo FINAL, então também pega o
 * item que voltou por swap/promote no gate. Severity "warning": o editor
 * decide no gate; nunca remove nada.
 */
export function checkStudySourceRecurrence(
  editionDir: string,
  editionsRoot: string = resolve(ROOT, "data/editions"),
): InvariantViolation[] {
  const file = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(file)) return [];
  const { highlights, pool } = readIntraEditionItems(readFileSync(file, "utf8"));
  const past = readPastStoryItems(editionsRoot, basename(editionDir), 0, STUDY_RECURRENCE_WINDOW_DAYS);
  return findStudySourceRecurrences([...highlights, ...pool], past).map(w => ({
    rule: "study-source-recurrence", source_issue: "#11763", severity: "warning" as const, file,
    message: formatStudySourceWarning(w),
  }));
}

/**
 * #11897: DESTAQUE do `02-reviewed.md` final que continua uma história já
 * publicada nos últimos `STORY_CONTINUATION_WINDOW_DAYS` dias (mesmo
 * produto+versão no lead, ou URL que continua a outra no mesmo host). Caso
 * 261103: D1 sobre os pesos abertos do Mistral Large 4 × D3 de 261007 sobre o
 * anúncio. Informativo, não pede corte: o texto pode citar a edição anterior.
 * Destaque que o `story-twice-in-edition` já acusa contra as últimas 3 edições
 * fica de fora (um aviso por item).
 */
export function checkStoryContinuation(
  editionDir: string,
  editionsRoot: string = resolve(ROOT, "data/editions"),
): InvariantViolation[] {
  const file = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(file)) return [];
  const { highlights, pool } = readIntraEditionItems(readFileSync(file, "utf8"));
  if (highlights.length === 0) return [];
  const aammdd = basename(editionDir);
  const alreadyWarned = new Set(
    findStoryTwice(highlights, pool, readPastStoryItems(editionsRoot, aammdd))
      .filter(w => w.scope === "past")
      .map(w => canonicalize(w.item_url)),
  );
  const past = readPastStoryItems(editionsRoot, aammdd, 0, STORY_CONTINUATION_WINDOW_DAYS);
  return findStoryContinuations(highlights.filter(h => !alreadyWarned.has(canonicalize(h.url))), past)
    .map(w => ({
      rule: "story-continuation", source_issue: "#11897", severity: "warning" as const, file,
      message: formatStoryContinuationWarning(w),
    }));
}

/**
 * #13313: DESTAQUE do `02-reviewed.md` final que é notícia velha — mesma URL
 * publicada há 31-84 dias (o dedup por URL só olha 30) ou o mesmo incidente
 * contado de novo depois de 30 dias. Caso 261117: D2 com a URL do D2 de
 * 260923, D3 repetindo o caso dos agentes da OpenAI de 260928. Warning: o
 * editor troca o destaque no gate.
 */
export function checkStaleHighlightRepeat(
  editionDir: string,
  editionsRoot: string = resolve(ROOT, "data/editions"),
): InvariantViolation[] {
  const file = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(file)) return [];
  const { highlights } = readIntraEditionItems(readFileSync(file, "utf8"));
  if (highlights.length === 0) return [];
  const aammdd = basename(editionDir);
  const past = readPastStoryItems(editionsRoot, aammdd, 0, STALE_HIGHLIGHT_WINDOW_DAYS);
  return findStaleHighlightRepeats(highlights, past, aammdd).map((w) => ({
    rule: "stale-highlight-repeat", source_issue: "#13313", severity: "warning" as const, file,
    message: formatStaleHighlightWarning(w),
  }));
}

/**
 * #13313: destaques aprovados (`_internal/01-approved.json`) que seguem como
 * destaque no `02-reviewed.md` final, com o campo `date` e `date_unverified`.
 */
function readFinalApprovedHighlights(editionDir: string): Array<{ label: string; url: string; title: string; date?: string; date_unverified: boolean }> {
  const reviewed = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(reviewed)) return [];
  const finals = readIntraEditionItems(readFileSync(reviewed, "utf8")).highlights;
  const j = readJsonSafe(resolve(editionDir, "_internal", "01-approved.json")) as
    | { highlights?: Array<Record<string, unknown> & { article?: Record<string, unknown> }> }
    | undefined;
  const out: Array<{ label: string; url: string; title: string; date?: string; date_unverified: boolean }> = [];
  for (const h of j?.highlights ?? []) {
    const a = (h?.article ?? h) as Record<string, unknown>;
    if (typeof a?.url !== "string") continue;
    const final = finals.find((f) => urlsMatch(f.url, a.url as string));
    if (!final) continue;
    out.push({
      label: final.label,
      url: a.url,
      title: final.title,
      date: typeof a.date === "string" ? a.date : undefined,
      date_unverified: a.date_unverified === true,
    });
  }
  return out;
}

/**
 * #13313: destaque com `date_unverified: true` não passa em silêncio. Caso
 * 261117: a página da OpenAI não tem data, o pipeline atribuiu 14/11 a um
 * anúncio de 22/09 e o item passou pela janela de data como se fosse recente.
 */
export function checkHighlightDateUnverified(editionDir: string): InvariantViolation[] {
  const file = resolve(editionDir, "_internal", "01-approved.json");
  return readFinalApprovedHighlights(editionDir)
    .filter((h) => h.date_unverified)
    .map((h) => ({
      rule: "highlight-date-unverified", source_issue: "#13313", severity: "warning" as const, file,
      message:
        `🚨 Data do destaque não verificada: [${h.label}] “${h.title}” (${h.url}) entrou com date=${h.date ?? "?"} ` +
        `e date_unverified=true — a página não mostra a data e a do pipeline pode não ser a do anúncio. ` +
        `Conferir a data da 1ª cobertura na imprensa antes de publicar; se for de mais de 30 dias, trocar o destaque.`,
    }));
}

/**
 * #13313: o texto bruto da fonte do destaque (`_internal/fact-check-sources/
 * d{N}.txt`, mapeado pela URL do `manifest.json`) declara uma data de
 * atualização/publicação mais de 30 dias antes da edição ("Update on
 * September 29, 2026" no D2 de 261117). Só a data declarada mais recente
 * conta (#13364).
 */
export function checkHighlightSourceStaleDate(editionDir: string): InvariantViolation[] {
  const reviewed = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(reviewed)) return [];
  const dir = resolve(editionDir, "_internal", "fact-check-sources");
  const manifest = readJsonSafe(resolve(dir, "manifest.json"));
  if (!Array.isArray(manifest)) return [];
  const { highlights } = readIntraEditionItems(readFileSync(reviewed, "utf8"));
  const aammdd = basename(editionDir);
  const out: InvariantViolation[] = [];
  for (const h of highlights) {
    const entry = (manifest as Array<{ destaque?: unknown; url?: unknown }>).find(
      (e) => typeof e?.url === "string" && typeof e?.destaque === "number" && urlsMatch(e.url, h.url),
    );
    if (!entry) continue;
    const txt = resolve(dir, `d${entry.destaque}.txt`);
    if (!existsSync(txt)) continue;
    let text: string;
    try {
      text = readFileSync(txt, "utf8");
    } catch {
      continue;
    }
    // #13364: vale a data declarada mais RECENTE. A mais antiga (publicação
    // original, matéria da barra lateral) disparava aviso em página atualizada
    // há 2 dias.
    const latest = findSourceStaleDate(text, aammdd);
    if (!latest) continue;
    out.push({
      rule: "highlight-source-stale-date", source_issue: "#13313", severity: "warning" as const, file: txt,
      message:
        `🚨 A fonte do destaque [${h.label}] “${h.title}” (${h.url}) parece ser de ${latest.iso} ` +
        `(data declarada mais recente, ${latest.days} dias antes da edição; trecho: “${latest.text}”). Conferir se a notícia é desta semana; ` +
        `se não houver fato novo, trocar o destaque no gate.`,
    });
  }
  return out;
}

export interface DuplicateUrlMatch {
  url: string;
  line: number;
  originDate: string;
}

/**
 * Pure (#8993): compara as URLs editoriais de `reviewedMd` (02-reviewed.md)
 * contra `pastOrigins` (mapa URL-canônica→data-de-origem, de
 * `extractPastUrlsWithOriginWithinDays`). Separado de `checkNoDuplicateUrlsAgainstPastEditions`
 * (que só lê os 2 arquivos do disco) pra ser testável sem depender do
 * `data/past-editions.md` real da máquina — mesmo padrão de
 * `findImageContentMismatches`/`checkImageContentFresh` acima.
 */
export function findDuplicateUrlsAgainstPastEditions(
  reviewedMd: string,
  pastOrigins: Map<string, string>,
  // #12193: URLs canônicas promovidas a destaque nesta edição (destaque
  // aprovado E publicada antes só fora dos destaques) — repetição permitida.
  exemptCanonical: Set<string> = new Set(),
): DuplicateUrlMatch[] {
  if (pastOrigins.size === 0) return [];
  // #14020/#14021: compara pela chave do dedup (`dedupUrlKey`: sem prefixo de
  // idioma, sem `www.`, http→https), a mesma do Pass 1 de `dedup.ts`. Com
  // `canonicalize`, a variante `/pt-BR/` ou `www.` do link passado passava
  // calada. Na colisão de chaves fica a 1ª origem do mapa (a mais recente,
  // ordem de `extractPastUrlsWithOriginWithinDays`).
  const pastByKey = new Map<string, string>();
  for (const [u, date] of pastOrigins) {
    const k = dedupUrlKey(u);
    if (!pastByKey.has(k)) pastByKey.set(k, date);
  }
  const exemptKeys = new Set([...exemptCanonical].map(dedupUrlKey));
  const matches: DuplicateUrlMatch[] = [];
  const seenCanonical = new Set<string>(); // 1 match por URL repetida, não por ocorrência
  for (const { url, line } of extractUrlsWithLines(reviewedMd)) {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue; // URL malformada — fora de escopo deste check
    }
    if (isNonEditorialHost(host)) continue;

    const canonical = dedupUrlKey(url);
    const originDate = pastByKey.get(canonical);
    if (!originDate || seenCanonical.has(canonical) || exemptKeys.has(canonical)) continue;
    seenCanonical.add(canonical);
    matches.push({ url, line, originDate });
  }
  return matches;
}

/**
 * #8993: URL editorial de `02-reviewed.md` já apareceu numa edição publicada
 * nos últimos `DEDUP_URL_WINDOW_DAYS` (30) dias (`data/past-editions.md`) —
 * violação da regra invariável "sem links repetidos dos últimos ~30 dias"
 * (context/editorial-rules.md; janela ampliada de 3 edições no #9955). Achado real (edição 260929): o editor
 * inseriu/promoveu um D1 com link que já tinha saído no RADAR da edição
 * anterior durante o gate do Stage 4 — o dedup por URL só roda no Stage 1
 * (`dedup.ts`), então um item que entra ou é promovido DEPOIS desse ponto
 * (edição manual do editor, swap no gate) nunca passa por ele.
 *
 * Reusa `extractUrlsWithLines`/`isNonEditorialHost` (mesmo par que
 * `validate-domain-diversity.ts` usa pra extrair só links EDITORIAIS — exclui
 * rodapé/crédito de imagem/link de casa, ex: *.diar.ia.br, linkedin.com,
 * apoia.se) e `dedupUrlKey`/`extractPastUrlsWithOriginWithinDays` (mesmos helpers do
 * dedup de Stage 1, `scripts/dedup.ts`), pra ficar consistente com o que já
 * é considerado "mesmo link" em todo o resto do pipeline.
 *
 * **Severity "warning" — nunca bloqueia** (mesmo padrão de
 * `has-negative-impact-highlight`/`image-crop-warn` acima): CLAUDE.md proíbe
 * reverter uma escolha editorial pra satisfazer um lint mecânico sem
 * primeiro perguntar/investigar (#7401) — um check gate-blocking aqui
 * forçaria a decisão errada (reverter automaticamente ou travar o Stage 4)
 * justamente no caso em que o editor decidiu deliberadamente repetir o link
 * (ex: atualização de uma história em andamento). O warning aparece no
 * resumo consolidado do gate citando a edição de origem — o editor decide:
 * mantém (override implícito, aprovando o gate normalmente) ou troca o item.
 */
export function checkNoDuplicateUrlsAgainstPastEditions(editionDir: string): InvariantViolation[] {
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(reviewedPath)) return [];
  let md: string;
  try {
    md = readFileSync(reviewedPath, "utf8");
  } catch {
    return [];
  }

  const pastEditionsPath = resolve(ROOT, "data", "past-editions.md");
  const pastMd = readPastEditionsMd(pastEditionsPath);
  if (!pastMd.trim()) return []; // sem histórico (bootstrap) — nada pra comparar

  // #9955: janela em dias antes da edição revisada (AAMMDD do dir; sem ele,
  // ancora na seção mais recente de past-editions.md).
  const edition = /^\d{6}$/.test(basename(editionDir)) ? basename(editionDir) : undefined;
  const pastOrigins = extractPastUrlsWithOriginWithinDays(pastMd, DEDUP_URL_WINDOW_DAYS, edition);
  // #13883: destaque aprovado repetido é acusado por
  // `destaque-repeated-past-edition`, com a edição, a seção e o marcador do
  // upgrade do #12193 — aqui ficaria em dobro (e o upgrade, que antes saía
  // isento em silêncio, passou a ter aviso próprio). Este check fica com o
  // resto: pool e link inserido no 02-reviewed.md fora dos destaques.
  const exempt = new Set(readApprovedHighlightUrls(editionDir).map((u) => canonicalize(u)));
  const matches = findDuplicateUrlsAgainstPastEditions(md, pastOrigins, exempt);

  return matches.map(({ url, line, originDate }) => ({
    rule: "no-duplicate-urls-vs-past-editions",
    message:
      `URL já publicada na edição de ${originDate} (dentro da janela dos últimos ` +
      `${DEDUP_URL_WINDOW_DAYS} dias): ${url}. Regra invariável "sem links repetidos dos ` +
      `últimos ~30 dias" (context/editorial-rules.md, #9955). Se foi promovido/inserido durante o ` +
      `gate, o dedup do Stage 1 não viu este link — confirme se a repetição é intencional ` +
      `(ex: atualização da mesma história) antes de aprovar.`,
    source_issue: "#8993",
    severity: "warning" as const,
    file: reviewedPath,
    line,
  }));
}

/** #12193: URLs dos destaques aprovados (`_internal/01-approved.json`), na ordem. */
function readApprovedHighlightUrls(editionDir: string): string[] {
  const p = resolve(editionDir, "_internal", "01-approved.json");
  if (!existsSync(p)) return [];
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { highlights?: Array<{ url?: unknown; article?: { url?: unknown } }> };
    return (j.highlights ?? [])
      .map((h) => (typeof h?.url === "string" ? h.url : typeof h?.article?.url === "string" ? h.article.url : ""))
      .filter((u) => u);
  } catch {
    return [];
  }
}

/**
 * Pure (#13883): mensagem de cada destaque repetido. Separado de
 * `checkDestaqueRepeatedPastEdition` (que lê o disco) para o teste não
 * depender do `data/past-editions.md` real.
 */
export function formatRepeatedDestaqueMessage(r: RepeatedDestaque): string {
  const label = `D${r.position}${r.title ? ` “${r.title}”` : ""}`;
  const where = formatPastPublications(r.origins);
  if (r.marked) {
    const fact =
      r.newerSources > 0
        ? `${r.newerSources} fonte(s) do cluster com data posterior: conferir se trazem fato novo.`
        : `Nenhuma fonte nova no cluster: se a notícia é a mesma, trocar o destaque no gate.`;
    return (
      `⚠️ ${label} repete link já publicado em ${where}: ${r.url}. Entrou pelo upgrade a destaque do #12193 ` +
      `(URL que saiu fora dos destaques pode voltar como destaque), que vale para fato novo, não para repetir a mesma notícia. ${fact}`
    );
  }
  return (
    `🚨 ${label} repete link já publicado em ${where}: ${r.url}, sem o marcador do upgrade do #12193 ` +
    `(dedup_destaque_only): o dedup do Stage 1 não liberou esta repetição (troca no gate ou falha do dedup). ` +
    `Regra "sem links repetidos dos últimos ~30 dias" (context/editorial-rules.md): trocar o destaque, salvo atualização intencional da mesma história.`
  );
}

/**
 * #13883: destaque aprovado (`_internal/01-approved.json → highlights[]`)
 * cuja URL já saiu na janela de dedup (`past-editions.md`, chave
 * `dedupUrlKey`). Caso 261124: o D2 "Gemini agora clica e digita sozinho no
 * seu Mac" era o mesmo link do RADAR de 261123; o upgrade do #12193 o
 * liberou e nada apareceu no gate. Com o marcador do dedup é ⚠️ (upgrade
 * permitido, mas pede fato novo); sem ele é 🚨 (repetição que o dedup não
 * liberou). As duas formas são warning: o editor decide no gate, e travar o
 * Stage 4 por uma escolha deliberada dele (atualização da mesma história)
 * contraria o #7401 — mesma razão do `no-duplicate-urls-vs-past-editions`.
 *
 * A seção de origem sai do campo gravado pelo dedup
 * (`dedup_destaque_only_origin`) quando presente; senão do `01-approved.json`
 * da pasta local daquela edição (`extractPastPublicationsWithinDays`).
 */
export function checkDestaqueRepeatedPastEdition(
  editionDir: string,
  // Teste: fixtures no lugar de `data/past-editions.md`/`data/editions` reais.
  paths: { pastEditionsPath?: string; editionsDir?: string } = {},
): InvariantViolation[] {
  const approvedPath = resolve(editionDir, "_internal", "01-approved.json");
  const approved = readJsonSafe(approvedPath) as { highlights?: unknown[] } | undefined;
  const highlights = Array.isArray(approved?.highlights) ? approved.highlights : [];
  if (highlights.length === 0) return [];
  const pastMd = readPastEditionsMd(paths.pastEditionsPath ?? resolve(ROOT, "data", "past-editions.md"));
  if (!pastMd.trim()) return [];
  const edition = /^\d{6}$/.test(basename(editionDir)) ? basename(editionDir) : undefined;
  const urls = readApprovedHighlightUrls(editionDir);
  const pubs = extractPastPublicationsWithinDays(
    urls,
    pastMd,
    paths.editionsDir ?? resolve(ROOT, "data", "editions"),
    DEDUP_URL_WINDOW_DAYS,
    edition,
    dedupUrlKey,
  );
  // Seção gravada pelo dedup vence a "não identificada" lida das pastas.
  for (const h of highlights) {
    const art = ((h as { article?: unknown }).article ?? h) as { url?: unknown };
    if (typeof art.url !== "string") continue;
    const key = dedupUrlKey(art.url);
    const list = pubs.get(key);
    if (!list) continue;
    const recorded = new Map<string, PastPublication>(readDestaqueOnlyOrigin(art).map((p) => [p.date, p]));
    pubs.set(key, list.map((p) => (p.section === UNKNOWN_SECTION ? recorded.get(p.date) ?? p : p)));
  }
  return findRepeatedDestaques(highlights, pubs, dedupUrlKey).map((r) => ({
    rule: "destaque-repeated-past-edition",
    message: formatRepeatedDestaqueMessage(r),
    source_issue: "#13883",
    severity: "warning" as const,
    file: approvedPath,
  }));
}

/** #13923: avisos técnicos, sem mudar a política de seleção do #13901. */
export function checkDedupRecurrence(
  editionDir: string,
  editionsDir: string = resolve(ROOT, "data", "editions"),
): InvariantViolation[] {
  const file = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(file)) return [];
  const current = readIntraEditionItems(readFileSync(file, "utf8"));
  const selected = [...current.highlights, ...current.pool];
  const out: InvariantViolation[] = [];
  const warn = (message: string) => out.push({ rule: "dedup-recurrence", message, severity: "warning", source_issue: "#13923", file });
  // Ler o marcador tanto na seleção quanto no pool de pesquisa: o scorer
  // pode projetar só parte dos campos no approved.json.
  const warned = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const item = value as Record<string, unknown>;
    if (typeof item.url === "string" && typeof item.date_window_warning === "string" &&
        selected.some(s => dedupUrlKey(s.url) === dedupUrlKey(item.url as string)) && !warned.has(item.url)) {
      warned.add(item.url);
      warn(`⚠️ ${item.title ?? item.url}: ${item.date_window_warning}. ${item.url}`);
    }
    Object.values(item).forEach(visit);
  };
  for (const name of ["01-approved.json", "01-categorized.json"]) visit(readJsonSafe(resolve(editionDir, "_internal", name)));
  const edition = basename(editionDir);
  const past = [...enumerateEditionDirs(editionsDir)].filter(([date]) => {
    const days = editionDaysBefore(date, edition);
    return days !== undefined && days > 0 && days <= 10;
  });
  for (const item of current.pool.filter(i => /radar|use melhor/i.test(i.label))) {
    const themes = recurringEventThemes(item.title);
    if (!themes.length) continue;
    for (const [date, dir] of past) {
      const reviewed = resolve(dir, "02-reviewed.md");
      if (!existsSync(reviewed)) continue;
      const match = readIntraEditionItems(readFileSync(reviewed, "utf8")).highlights.find(h =>
        recurringEventThemes(h.title).some(theme => themes.includes(theme)));
      if (match) warn(`⚠️ ${item.label}: “${item.title}” repete tema de destaque de ${date}: “${match.title}”. Conferir fato novo. ${item.url}`);
    }
  }
  return out;
}

function readJsonSafe(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * #12193: link que o editor pediu como destaque no inbox ("esse deve ser o
 * d1") e que ficou de fora — barrado por qualquer regra do Stage 1, deixado
 * no pool, ou destaque em outra posição. Antes o motivo só ia para o log
 * (caso 261105: o TechCrunch pedido como D1 caiu no dedup por ter saído no
 * RADAR de 261104, e ninguém avisou o editor).
 *
 * Pedidos: `_internal/tmp-articles-raw.json`, artigos com
 * `editor_destaque_request` (gravado por `inject-inbox-urls.ts`). Motivo:
 * `_internal/stage1-funnel.json`. Warning-only: o editor decide no gate.
 */
export function checkEditorDestaqueRequests(editionDir: string): InvariantViolation[] {
  const internal = resolve(editionDir, "_internal");
  const rawJson = readJsonSafe(resolve(internal, "tmp-articles-raw.json"));
  const rawList: unknown[] = Array.isArray(rawJson)
    ? rawJson
    : Array.isArray((rawJson as { articles?: unknown } | undefined)?.articles)
      ? (rawJson as { articles: unknown[] }).articles
      : [];
  const requests: DestaqueRequest[] = [];
  for (const a of rawList) {
    const art = a as { url?: unknown; title?: unknown; [k: string]: unknown } | null;
    const req = art?.[DESTAQUE_REQUEST_FIELD];
    if (!art || typeof art.url !== "string" || typeof req !== "string" || !req) continue;
    requests.push({ url: art.url, request: req, title: typeof art.title === "string" ? art.title : undefined });
  }
  if (requests.length === 0) return [];

  const approvedPath = resolve(internal, "01-approved.json");
  const approved = readJsonSafe(approvedPath) as Record<string, Array<{ url: string }> | undefined> | undefined;
  if (!approved) return []; // gate 1 ainda não aprovado — nada a comparar
  const funnel = readJsonSafe(resolve(internal, "stage1-funnel.json")) as { items?: FunnelItemLite[] } | undefined;
  const issues = findEditorDestaqueRequestIssues(
    requests,
    readApprovedHighlightUrls(editionDir),
    Array.isArray(funnel?.items) ? funnel.items : [],
    { lancamento: approved.lancamento, radar: approved.radar, use_melhor: approved.use_melhor, video: approved.video },
  );
  return issues.map((i) => ({
    rule: "editor-destaque-request",
    message:
      `Link que você pediu como ${i.request === "destaque" ? "destaque" : i.request.toUpperCase()} não saiu como pedido: ${i.url} — ${i.reason}. ` +
      `Decida no gate: trocar o destaque ou seguir assim.`,
    source_issue: "#12193",
    severity: "warning" as const,
    file: approvedPath,
  }));
}

/**
 * #8121: warn-only guard — item REMOVIDO de `01-approved.json` durante o
 * Stage 4 (comparado ao snapshot pós-Stage 1/2, `stage2-post-gate`,
 * mantido por `derive-editor-requests.ts snapshot-stage2` — #5731), em vez
 * de apenas desreferenciado em `02-reviewed.md`. Ver o docblock de
 * `detectRemovedApprovedItems` (`../lint-checks/approved-item-removal.ts`)
 * pro racional completo — em resumo: remover apaga o registro de que o
 * categorizador processou o item naquele dia e corrompe o sinal que
 * `analyze-bucket-overrides.ts` usa pra aprender onde o categorizador erra.
 *
 * Warning, não error: o item já foi removido no momento em que este check
 * roda — não há ação automática segura (recriar o item por aproximação
 * arrisca reintroduzir dado errado; reverter a edição do editor sem
 * perguntar viola #7401). O guard serve pra o editor VER o que aconteceu
 * antes de aprovar o gate, não pra bloquear a publicação por isso.
 *
 * Ausência do snapshot (edição sem gate humano no Stage 1/2, `--no-gates`
 * nunca chamou `snapshot-stage2`, ou edição anterior ao #5731) é
 * fail-soft: sem baseline pra comparar, não há o que checar — não é
 * indício de remoção, é ausência de dado.
 */
export function checkApprovedItemRemoval(editionDir: string): InvariantViolation[] {
  const baselinePath = resolve(
    editionDir,
    "_internal",
    "editor-request-snapshots",
    "stage2-post-gate",
    "_internal",
    "01-approved.json",
  );
  const currentPath = resolve(editionDir, "_internal", "01-approved.json");
  if (!existsSync(baselinePath) || !existsSync(currentPath)) return [];
  let baselineJson: unknown;
  let currentJson: unknown;
  try {
    baselineJson = JSON.parse(readFileSync(baselinePath, "utf8"));
    currentJson = JSON.parse(readFileSync(currentPath, "utf8"));
  } catch {
    return [];
  }
  // #10100: descarte declarado por `swap-destaque(s).ts --drop` (registrado em
  // `_internal/stage4-dropped-items.json`) é decisão explícita do editor, não
  // remoção acidental — fica fora do warning.
  const declaredDrops = stage4DroppedUrlSet(readStage4DroppedItems(editionDir));
  return detectRemovedApprovedItems(baselineJson, currentJson)
    .filter((item) => !declaredDrops.has(canonicalize(item.url)))
    .map((item) => ({
    rule: "approved-item-removed",
    message:
      `Item removido de 01-approved.json durante o Stage 4 (estava em "${item.bucket}" no snapshot pós-Stage 1): ` +
      `${item.title} (${item.url}). Nunca remover à mão — desreferencie do 02-reviewed.md e mantenha o item em ` +
      `01-approved.json; para descartar um destaque, use swap-destaque.ts --drop, que registra o descarte ` +
      `em _internal/stage4-dropped-items.json (#8121, #10100).`,
    source_issue: "#8121",
    severity: "warning" as const,
    file: currentPath,
  }));
}
