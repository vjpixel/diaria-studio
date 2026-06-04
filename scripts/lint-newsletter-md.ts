/**
 * lint-newsletter-md.ts (#165)
 *
 * Validação pós-writer do `02-draft.md` (ou `02-reviewed.md`) cruzando
 * URLs das seções secundárias contra `_internal/01-approved.json`. Pega
 * casos onde o writer LLM colocou um artigo na seção errada por
 * associação temática (ex: ferramenta nova em LANÇAMENTOS mesmo com
 * `bucket: "noticias"` no approved).
 *
 * Bug latente que o lint pega: ComfyUI (bucket: noticias, score 61) foi
 * colocado em LANÇAMENTOS na 260426 — exatamente o tipo de erro que
 * causou #160 também.
 *
 * Uso:
 *   npx tsx scripts/lint-newsletter-md.ts \
 *     --md <path> \
 *     --approved <path-to-01-approved.json>
 *
 * Exit codes:
 *   0  Todas as URLs nas seções batem com bucket
 *   1  Erros de seção (URL no bucket errado ou ausente do approved)
 *   2  Erro de leitura
 *
 * Output JSON em stdout: { ok, errors[], warnings[] }
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkStage2Caps,
  type ApprovedJson as CapsApprovedJson,
} from "./lib/apply-stage2-caps.ts"; // #907
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts"; // #926
import { lintIntroCount as sharedLintIntroCount, type IntroCountResult } from "./lib/newsletter-count.ts"; // #1455
import {
  SECTIONS as SECTION_DEFS,
  sectionHeaderRegex,
} from "./lib/section-naming.ts"; // #1737 fonte única de seções
// #1737 item 2: checks extraídos pra módulos por-check (espelha invariant-checks/).
import { lintMultilineLinks } from "./lib/lint-checks/multiline-links.ts";
import { lintRelativeTime } from "./lib/lint-checks/relative-time.ts";
import { checkWhyMattersFormat } from "./lib/lint-checks/why-matters-format.ts";
import { checkEaiSection } from "./lib/lint-checks/eai-section.ts";
import { checkCoverageLine } from "./lib/lint-checks/coverage-line-format.ts";
import {
  checkDestaqueMinChars,
  checkDestaqueMaxChars,
} from "./lib/lint-checks/destaque-chars.ts";
import { countTitlesPerHighlight } from "./lib/lint-checks/titles-per-highlight.ts";
import {
  checkTitleLengths,
  MAX_TITLE_LENGTH,
} from "./lib/lint-checks/title-length.ts";
import { checkEiaAnswer } from "./lib/lint-checks/eia-answer-check.ts";
import { checkIntentionalError } from "./lib/lint-checks/intentional-error.ts";
import { checkSectionItemFormat } from "./lib/lint-checks/section-item-format.ts";
// Re-export pra back-compat (testes + outros módulos importam daqui).
export {
  lintMultilineLinks,
  type MultilineLinkMatch,
  type MultilineLinkResult,
} from "./lib/lint-checks/multiline-links.ts";
export {
  lintRelativeTime,
  type RelativeTimeMatch,
  type RelativeTimeResult,
} from "./lib/lint-checks/relative-time.ts";
export {
  checkWhyMattersFormat,
  type WhyMattersError,
  type WhyMattersReport,
} from "./lib/lint-checks/why-matters-format.ts";
export { checkEaiSection } from "./lib/lint-checks/eai-section.ts";
export {
  checkCoverageLine,
  COVERAGE_LINE_RE,
} from "./lib/lint-checks/coverage-line-format.ts";
export {
  checkDestaqueMinChars,
  checkDestaqueMaxChars,
  DESTAQUE_MIN_CHARS,
  DESTAQUE_MAX_CHARS,
  type DestaqueMinCharsError,
  type DestaqueMinCharsReport,
  type DestaqueMaxCharsError,
  type DestaqueMaxCharsReport,
} from "./lib/lint-checks/destaque-chars.ts";
export {
  countTitlesPerHighlight,
  type TitleCheckResult,
  type TitleCheckReport,
} from "./lib/lint-checks/titles-per-highlight.ts";
export {
  checkTitleLengths,
  MAX_TITLE_LENGTH,
  type TitleLengthError,
  type TitleLengthReport,
} from "./lib/lint-checks/title-length.ts";
export {
  checkEiaAnswer,
  type EiaAnswerCheckResult,
} from "./lib/lint-checks/eia-answer-check.ts";
export {
  checkIntentionalError,
  extractFrontmatter,
  type IntentionalErrorCheckResult,
} from "./lib/lint-checks/intentional-error.ts";
export {
  checkSectionItemFormat,
  type SectionItemFormatError,
  type SectionItemFormatReport,
} from "./lib/lint-checks/section-item-format.ts";

// #1031: tipos locais reconciliados com central ApprovedJsonSchema
// (scripts/lib/schemas/edition-state.ts). url é optional pra suportar
// flat/nested highlights (#229) e runners_up que podem ter shape variado.
// Lógica abaixo já trata undefined defensivamente (`if (h.url)` etc).
interface ApprovedArticle {
  url?: string;
  title?: string;
  // article nested (HighlightNestedSchema) — opcional, pra casos de runners_up
  article?: { url?: string; title?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface ApprovedJson {
  highlights?: ApprovedArticle[];
  runners_up?: ApprovedArticle[];
  lancamento?: ApprovedArticle[];
  // #1691: buckets reais do 01-approved-capped.json são per-categoria
  // (pesquisa/noticias/tutorial/video), não per-seção. `radar` é aceito pra
  // forward-compat (e os fixtures de teste usam). Mapeados pra seção em
  // buildUrlBucketMap (pesquisa/noticias → RADAR, tutorial → USE MELHOR).
  radar?: ApprovedArticle[];
  pesquisa?: ApprovedArticle[];
  noticias?: ApprovedArticle[];
  tutorial?: ApprovedArticle[];
  video?: ApprovedArticle[];
  [key: string]: unknown;
}

// #1629: Bucket internal = section name na newsletter. #1691: + use_melhor, video.
type Bucket = "lancamento" | "radar" | "use_melhor" | "video";

interface SectionMapping {
  header: RegExp;
  bucket: Bucket;
  label: string;
}

// Headers podem ser plain (legacy) ou em **negrito** (#590). Aceita ambos
// pra backwards-compat com edições antigas + suporta o novo formato.
// #1569 / #1629: RADAR substitui PESQUISAS + OUTRAS NOTÍCIAS. Aliases legacy
// mantidos pra re-lint de edições antigas; novos lints emitem RADAR.
//
// #1737: a lista nome → bucket → label e o regex de header vêm de
// section-naming.ts (fonte única — antes esta era uma das 3 cópias). Forma
// exata preservada: bold opcional, sem captura, flags "mu", emoji prefix
// tight (range Unicode). `sectionHeaderRegex(pattern, {flags:"mu"})` produz
// o mesmo `^(?:\*\*)?<emoji>(?:<pattern>)(?:\*\*)?\s*$` de antes.
const SECTIONS: SectionMapping[] = SECTION_DEFS.map((s) => ({
  header: sectionHeaderRegex(s.pattern, { flags: "mu" }),
  bucket: s.bucket,
  label: s.label,
}));

const SECTION_BREAK_RE = /^---\s*$/;
// Match URL up to whitespace OR markdown delimiter (`)`, `]`, `>`)
// para que [url](url) extraia 2 instâncias da mesma URL e o dedup capture.
const URL_RE = /https?:\/\/[^\s\)\]>]+/g;

// #1691 review: pro JOIN newsletter↔approved, ignora SÓ o fragmento (`#...`) —
// é client-side, nunca identifica recurso diferente (RFC 3986 §3.5). Caso real
// 260521: approved tinha `.../claude-code-rce-flaw/#amp` e a newsletter a versão
// limpa → match exato falhava e a URL aprovada virava falso "missing". Não
// normaliza trailing-slash/query/www (podem ser semânticos) — mantém o espírito
// "URLs opacas" (#720), relaxando só o que é comprovadamente seguro.
function normalizeUrlForMatch(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

export interface LintError {
  section: string;
  expected_bucket: Bucket;
  url: string;
  line: number;
  found_in_bucket: Bucket | "highlights" | "missing";
  title?: string;
}

export interface LintResult {
  ok: boolean;
  errors: LintError[];
  warnings: string[];
}

function isSectionHeaderLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 5) return false;
  if (!/^[A-ZÇÃÕÁÉÍÓÚÊÔ ]+$/.test(trimmed)) return false;
  return true;
}

/**
 * Extrai URLs por seção. Mapping: section.label → array de { url, line }.
 */
export function extractUrlsBySection(
  md: string,
): Record<string, Array<{ url: string; line: number }>> {
  const lines = md.split("\n");
  const out: Record<string, Array<{ url: string; line: number }>> = {};

  let currentSection: SectionMapping | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // Section header detected?
    const matched = SECTIONS.find((s) => s.header.test(raw));
    if (matched) {
      currentSection = matched;
      if (!out[matched.label]) out[matched.label] = [];
      continue;
    }

    // Section break ends current section
    if (currentSection && SECTION_BREAK_RE.test(raw)) {
      currentSection = null;
      continue;
    }

    // Non-section header (e.g., DESTAQUE) ends current section
    if (currentSection && isSectionHeaderLine(raw) && raw.trim() !== currentSection.label) {
      currentSection = null;
      // Re-evaluate this line: does it match a different section?
      const reMatch = SECTIONS.find((s) => s.header.test(raw));
      if (reMatch) {
        currentSection = reMatch;
        if (!out[reMatch.label]) out[reMatch.label] = [];
      }
      continue;
    }

    if (currentSection) {
      const matches = raw.matchAll(URL_RE);
      for (const m of matches) {
        const url = m[0].replace(/[).,;]+$/, "");
        out[currentSection.label].push({ url, line: i + 1 });
      }
    }
  }

  return out;
}

/**
 * Mapa { url → bucket } a partir do approved JSON. Highlights ficam
 * separados (não erro se aparecem em qualquer seção — destaques podem
 * vir de qualquer bucket original).
 */
export function buildUrlBucketMap(
  approved: ApprovedJson,
): { byUrl: Map<string, { bucket: Bucket | "highlights"; title?: string }> } {
  const byUrl = new Map<
    string,
    { bucket: Bucket | "highlights"; title?: string }
  >();

  // Highlights primeiro — sobrescreve buckets se artigo é destaque.
  // #1691 review: highlights podem ter shape flat (h.url) OU nested
  // (h.article.url) — #229. Sem ler o nested, um destaque que reaparece numa
  // seção secundária era falsamente marcado "missing" (a regra #165 re-dispararia
  // o writer à toa). Mesmo padrão do pickEntry em canonical-urls.ts.
  for (const h of approved.highlights ?? []) {
    const url = h.url ?? h.article?.url;
    if (url) byUrl.set(normalizeUrlForMatch(url), { bucket: "highlights", title: h.title ?? h.article?.title });
  }

  // #1691: o 01-approved-capped.json usa buckets per-CATEGORIA
  // (pesquisa/noticias/tutorial/video), mas as SEÇÕES da newsletter são
  // per-bucket (RADAR = pesquisa+noticias, USE MELHOR = tutorial). Mapeia
  // categoria → seção (mesma lógica do bucketOf em merge-scored-chunks). O
  // map antigo só lia ["lancamento","radar"] — e como approved não tem chave
  // `radar`, NENHUMA URL de pesquisa/noticias/tutorial/video era mapeada (todas
  // viravam "missing" se o lint chegasse a rodar). `radar` mantido pra
  // forward-compat + fixtures de teste.
  const APPROVED_BUCKET_TO_SECTION: Record<string, Bucket> = {
    lancamento: "lancamento",
    radar: "radar",
    pesquisa: "radar",
    noticias: "radar",
    tutorial: "use_melhor",
    video: "video",
  };
  // Só seta se URL ainda não está como highlight (#1629)
  for (const [approvedKey, sectionBucket] of Object.entries(APPROVED_BUCKET_TO_SECTION)) {
    for (const a of (approved[approvedKey] as ApprovedArticle[] | undefined) ?? []) {
      const url = a.url ? normalizeUrlForMatch(a.url) : undefined;
      if (url && !byUrl.has(url)) {
        byUrl.set(url, { bucket: sectionBucket, title: a.title });
      }
    }
  }

  return { byUrl };
}

// #1737 item 2: COVERAGE_LINE_RE + checkCoverageLine (#592/#609/#1207) movidos
// pra scripts/lib/lint-checks/coverage-line-format.ts. Re-exportados no topo.

export function lintNewsletter(
  md: string,
  approved: ApprovedJson,
): LintResult {
  const urlsBySection = extractUrlsBySection(md);
  const { byUrl } = buildUrlBucketMap(approved);

  const errors: LintError[] = [];
  const warnings: string[] = [];

  for (const sec of SECTIONS) {
    const urls = urlsBySection[sec.label] ?? [];
    const seen = new Set<string>();
    for (const { url, line } of urls) {
      if (seen.has(url)) continue; // dedup markdown link [url](url)
      seen.add(url);
      const found = byUrl.get(normalizeUrlForMatch(url));
      if (!found) {
        errors.push({
          section: sec.label,
          expected_bucket: sec.bucket,
          url,
          line,
          found_in_bucket: "missing",
        });
        continue;
      }
      if (found.bucket === "highlights") {
        // Destaques podem aparecer em qualquer lugar — só warn
        warnings.push(
          `${sec.label} (linha ${line}): URL ${url} é destaque (rank). Geralmente destaque não duplica em seção secundária.`,
        );
        continue;
      }
      if (found.bucket !== sec.bucket) {
        errors.push({
          section: sec.label,
          expected_bucket: sec.bucket,
          url,
          line,
          found_in_bucket: found.bucket,
          title: found.title,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Conta itens distintos por seção secundária (LANÇAMENTOS / PESQUISAS /
 * OUTRAS NOTÍCIAS). Cada item = 1 URL única na seção. (#907)
 *
 * Reusa `extractUrlsBySection` mas dedup por URL (markdown link emite a
 * mesma URL 2x — `[url](url)` casa o regex 2 vezes).
 */
export interface SectionCounts {
  lancamento: number;
  radar: number;
  // #1693: USE MELHOR é só observabilidade (sem cap máximo documentado);
  // VÍDEOS é validado (≤ 2). Ambos contados pra completar o report.
  use_melhor: number;
  video: number;
}

export function countItemsPerSection(md: string): SectionCounts {
  const urlsBySection = extractUrlsBySection(md);
  const dedup = (entries: Array<{ url: string; line: number }> | undefined) => {
    if (!entries) return 0;
    return new Set(entries.map((e) => e.url)).size;
  };
  // #1569/#1629: RADAR substitui PESQUISAS + OUTRAS NOTÍCIAS. Soma todos os
  // 3 nomes (RADAR atual, PESQUISAS/OUTRAS NOTÍCIAS legacy pra parsear
  // newsletters históricas pré-#1569).
  const lancamento = dedup(urlsBySection["LANÇAMENTOS"]);
  const radarCurrent = dedup(urlsBySection["RADAR"]);
  const pesquisasLegacy = dedup(urlsBySection["PESQUISAS"]);
  const outrasNoticiasLegacy = dedup(urlsBySection["OUTRAS NOTÍCIAS"]);
  return {
    lancamento,
    radar: radarCurrent + pesquisasLegacy + outrasNoticiasLegacy,
    use_melhor: dedup(urlsBySection["USE MELHOR"]),
    video: dedup(urlsBySection["VÍDEOS"]),
  };
}

/**
 * Validador #907: verifica que cada seção secundária respeita o cap de #358.
 *
 * Lê o `01-approved.json` pra obter o número de destaques (entra na fórmula
 * de Outras Notícias). Conta itens no MD e compara com cap calculado.
 *
 * Retorna `ok: false` quando alguma seção excede cap. Editor (Pixel)
 * detectou em 260507: writer publicou 9 itens de Outras Notícias quando
 * cap esperado era 4.
 */
export interface SectionCountsResult {
  ok: boolean;
  counts: SectionCounts;
  caps: { lancamento: number; radar: number; video: number };
  destaques: number;
  violations: string[];
}

export function checkSectionCounts(
  md: string,
  approved: ApprovedJson,
): SectionCountsResult {
  const counts = countItemsPerSection(md);
  const dest = approved.highlights?.length ?? 0;
  // #1693: passa VÍDEOS pro cap check (≤ 2). USE MELHOR fica fora — sem cap
  // máximo documentado; o count vai no `counts` só pra observabilidade.
  const fakeApproved: CapsApprovedJson = {
    highlights: approved.highlights ?? [],
    lancamento: new Array(counts.lancamento),
    radar: new Array(counts.radar),
    video: new Array(counts.video),
  };
  const r = checkStage2Caps(fakeApproved);
  // dest used only via fakeApproved.highlights
  void dest;
  return {
    ok: r.ok,
    counts,
    caps: r.expectedCaps,
    destaques: dest,
    violations: r.violations,
  };
}

// #1737 item 2: checkDestaqueMinChars (#914) + checkDestaqueMaxChars (#964) +
// constantes DESTAQUE_MIN/MAX_CHARS movidos pra
// scripts/lib/lint-checks/destaque-chars.ts. Re-exportados no topo.

// #1737 item 2: checkSectionItemFormat (#909) → lint-checks/section-item-format.ts. Re-export no topo.

// #1737 item 2: checkEiaAnswer (#744/#927) → lint-checks/eia-answer-check.ts;
// checkIntentionalError (#754) + extractFrontmatter → lint-checks/intentional-error.ts.
// Re-export no topo do arquivo pra back-compat.

/**
 * Verifica que o número declarado na intro ("Selecionamos os N mais relevantes")
 * bate com a contagem real de URLs editoriais no body (#743).
 *
 * URLs contadas:
 *   - 1 URL por bloco DESTAQUE (a URL canônica, não as opções de título)
 *   - 1 URL por item em LANÇAMENTOS, PESQUISAS, OUTRAS NOTÍCIAS
 *   - É IA? é excluído (créditos de imagem)
 *
 * Retorna `{ ok, claimed, actual }`.
 * Se não conseguir parsear o número da intro, retorna `{ ok: true }` (não bloqueia).
 */
// #1455: re-exporta `IntroCountResult` da lib pra manter compat com callers
// existentes (test/lint-intro-count.test.ts, scripts/check-stage2-invariants.ts).
export type { IntroCountResult } from "./lib/newsletter-count.ts";

/**
 * #1454/#1455: wrapper sobre `lib/newsletter-count.ts:lintIntroCount` —
 * single source of truth com `sync-coverage-line.ts:countSelectedItems`.
 *
 * Antes (até #1453) os dois usavam algoritmos diferentes: producer dividia
 * por `---` E section-header lookahead com emoji+singular suportados, consumer
 * (este) tinha state machine line-by-line com regex que NÃO casava emoji
 * prefix (`**🚀 LANÇAMENTOS**`) nem singular (`**🚀 LANÇAMENTO**`). Caso
 * real 260522: intro dizia "12" (correto), lint reclamava "real é 3".
 *
 * Agora delegam pra mesma função — divergência por construção é impossível.
 */
export function lintIntroCount(md: string): IntroCountResult {
  return sharedLintIntroCount(md);
}

// #1737 item 2: lintMultilineLinks (#1213) e lintRelativeTime (#747) movidos
// pra scripts/lib/lint-checks/. Re-exportados abaixo pra back-compat (vários
// testes importam daqui). main() usa as funções importadas no topo do arquivo.

// #926: parseArgs local removido — usar parseCliArgs (scripts/lib/cli-args.ts).

// #1737 item 2: countTitlesPerHighlight (#178) + checkTitleLengths (#701) +
// as regexes de header compartilhadas movidos pra scripts/lib/lint-checks/
// (titles-per-highlight.ts, title-length.ts, highlight-parsing.ts). Re-export no topo.

// #1737 item 2: checkWhyMattersFormat (#701) e checkEaiSection (#588) movidos
// pra scripts/lib/lint-checks/. Re-exportados no topo do arquivo pra back-compat.

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseCliArgs(process.argv.slice(2)).values;

  // Modo --check titles-per-highlight (#178)
  if (args.check === "titles-per-highlight") {
    if (!args.md) {
      console.error(
        "Uso: lint-newsletter-md.ts --check titles-per-highlight --md <md-path>",
      );
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = countTitlesPerHighlight(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`\n❌ ${result.errors.length} erro(s):`);
      for (const e of result.errors) console.error(`  ${e}`);
      process.exit(1);
    }
    return;
  }

  // Modo --check title-length (#701) — verifica que títulos cabem em ≤52 chars
  if (args.check === "title-length") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check title-length --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkTitleLengths(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`\n❌ ${result.errors.length} título(s) excedem ${MAX_TITLE_LENGTH} chars:`);
      for (const e of result.errors) {
        console.error(`  DESTAQUE ${e.destaque} (${e.category}): ${e.length} chars — "${e.title}"`);
      }
      process.exit(1);
    }
    return;
  }

  // Modo --check why-matters-format (#701) — bloqueia "Para [audiência]," opener
  if (args.check === "why-matters-format") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check why-matters-format --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkWhyMattersFormat(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.errors.length} parágrafo(s) "Por que isso importa" começam com ` +
          `"Para [audiência]," (editorial-rules:35):`,
      );
      for (const e of result.errors) {
        console.error(`  linha ${e.line}: "${e.text}"`);
      }
      process.exit(1);
    }
    return;
  }

  // Modo --check eai-section (#588) — verifica presença da seção É IA?
  if (args.check === "eai-section") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check eai-section --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkEaiSection(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`\n❌ ${result.error}`);
      process.exit(1);
    }
    return;
  }

  // Modo --check eia-answer (#744) — verifica que 02-reviewed.md tem eia_answer
  // quando 01-eia.md existe na edition_dir
  if (args.check === "eia-answer") {
    if (!args.md) {
      console.error(
        "Uso: lint-newsletter-md.ts --check eia-answer --md <md-path> [--edition-dir <dir>]",
      );
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    const editionDir = args["edition-dir"]
      ? resolve(ROOT, args["edition-dir"])
      : undefined;
    const result = checkEiaAnswer(mdPath, editionDir);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`\n❌ ${result.label}`);
      process.exit(1);
    }
    return;
  }

  // Modo --check intentional-error-flagged (#754) — verifica que 02-reviewed.md
  // tem intentional_error declarado no frontmatter (concurso mensal de erro
  // proposital). Roda no Stage 4 (publish-newsletter) antes de criar draft.
  if (args.check === "intentional-error-flagged") {
    if (!args.md) {
      console.error(
        "Uso: lint-newsletter-md.ts --check intentional-error-flagged --md <md-path>",
      );
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    const result = checkIntentionalError(mdPath);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`\n❌ ${result.label}`);
      console.error(
        `\nEdite ${args.md} e adicione o frontmatter intentional_error com 4 campos:`,
      );
      console.error(`---
intentional_error:
  description: "o que o assinante deve identificar"
  location: "DESTAQUE 2, parágrafo 2, primeira frase"
  category: "factual"   # factual | ortografico | numerico | attribution | data
  correct_value: "valor correto"
---`);
      process.exit(1);
    }
    return;
  }

  // Modo --check destaque-min-chars (#914) — valida mínimo de chars por destaque
  if (args.check === "destaque-min-chars") {
    if (!args.md) {
      console.error(
        "Uso: lint-newsletter-md.ts --check destaque-min-chars --md <md-path>",
      );
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkDestaqueMinChars(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ destaque-min-chars: ${result.errors.length} destaque(s) abaixo do mínimo:`,
      );
      for (const e of result.errors) {
        const deficit = e.min - e.chars;
        console.error(
          `  D${e.destaque} (${e.category}): ${e.chars} chars — abaixo do mínimo de ${e.min} (deficit: ${deficit} chars)`,
        );
      }
      console.error(
        `\nFix: re-disparar writer pra expandir o body do destaque (mais 1 parágrafo OU "Por que isso importa" estendido).`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check destaque-max-chars (#964) — valida máximo de chars por destaque
  if (args.check === "destaque-max-chars") {
    if (!args.md) {
      console.error(
        "Uso: lint-newsletter-md.ts --check destaque-max-chars --md <md-path>",
      );
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkDestaqueMaxChars(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ destaque-max-chars: ${result.errors.length} destaque(s) acima do máximo:`,
      );
      for (const e of result.errors) {
        const excess = e.chars - e.max;
        console.error(
          `  D${e.destaque} (${e.category}): ${e.chars} chars — acima do máximo de ${e.max} (excesso: ${excess} chars)`,
        );
      }
      console.error(
        `\nFix: re-disparar writer pra trimar o body do destaque (corte parágrafo redundante OU encurte "Por que isso importa").`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check section-item-format (#909) — valida formato de itens em seções secundárias
  if (args.check === "section-item-format") {
    if (!args.md) {
      console.error(
        "Uso: lint-newsletter-md.ts --check section-item-format --md <md-path>",
      );
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkSectionItemFormat(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ section-item-format: ${result.errors.length} item(ns) fora do formato esperado:`,
      );
      for (const e of result.errors) {
        console.error(`  ${e.section} linha ${e.line}: ${e.type}`);
        console.error(`    "${e.excerpt}"`);
      }
      console.error(
        `\nFormato esperado: "**[Título](URL)**" + linha em branco + descrição plain.`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check section-counts (#907) — verifica que seções secundárias
  // respeitam caps de #358 (lançamentos≤5, pesquisas≤3, outras=max(2, 12-d-l-p))
  if (args.check === "section-counts") {
    if (!args.md || !args.approved) {
      console.error(
        "Uso: lint-newsletter-md.ts --check section-counts --md <md-path> --approved <01-approved.json-path>",
      );
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    const approvedPath = resolve(ROOT, args.approved);
    if (!existsSync(mdPath) || !existsSync(approvedPath)) {
      console.error(
        `Arquivo não encontrado: ${!existsSync(mdPath) ? mdPath : approvedPath}`,
      );
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const approved = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedJson;
    const result = checkSectionCounts(md, approved);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ section-counts: ${result.violations.length} seção(ões) excede(m) cap de #358:`,
      );
      for (const v of result.violations) console.error(`  ${v}`);
      console.error(
        `\nDestaques na edição: ${result.destaques}. Caps esperados: ` +
          `lançamentos≤${result.caps.lancamento}, radar≤${result.caps.radar}, ` +
          `vídeos≤${result.caps.video} ` +
          `(#1629: radar = max(5, 12-${result.destaques}-l); #1693: vídeos≤2)`,
      );
      console.error(
        `\nFix: re-rodar /diaria-2-escrita ${args.md.match(/\d{6}/)?.[0] ?? "AAMMDD"} newsletter — ` +
          `o orchestrator agora aplica caps via apply-stage2-caps.ts antes do writer.`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check intro-count (#743) — verifica que intro bate com contagem real
  if (args.check === "intro-count") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check intro-count --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = lintIntroCount(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ intro-count: intro afirma ${result.claimed} mas contagem real é ${result.actual}`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check coverage-line-format (#1207) — valida formato canônico da
  // linha de cobertura via checkCoverageLine (existing helper, #592/#609)
  if (args.check === "coverage-line-format") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check coverage-line-format --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkCoverageLine(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`\n❌ coverage-line-format: primeira linha não bate com regex canônico.`);
      console.error(
        `   Esperado: "Para esta edição, eu (o editor) enviei X submissões e a Diar.ia encontrou outros Y artigos. Selecionamos os Z mais relevantes para as pessoas que assinam a newsletter."`,
      );
      console.error(`   Encontrado: "${result.firstLine.slice(0, 120)}"`);
      process.exit(1);
    }
    return;
  }

  // Modo --check multiline-links (#1213) — detecta links markdown quebrados
  if (args.check === "multiline-links") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check multiline-links --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = lintMultilineLinks(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.matches.length} link(s) markdown quebrado(s) em múltiplas linhas:`,
      );
      for (const m of result.matches) {
        console.error(`  linha ${m.line}: "${m.context}"`);
      }
      console.error(
        `\n   Fix: junte cada link em uma única linha — [Label](url) sem newline entre os elementos.`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check relative-time (#747) — detecta referências temporais relativas
  if (args.check === "relative-time") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check relative-time --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = lintRelativeTime(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.matches.length} referência(s) temporal(is) relativa(s) detectada(s):`,
      );
      for (const m of result.matches) {
        console.error(
          `  linha ${m.line}: relative_time: '${m.word}' encontrado — edição publica D+1, use data absoluta\n    contexto: "...${m.context}..."`,
        );
      }
      process.exit(1);
    }
    return;
  }

  if (!args.md || !args.approved) {
    console.error(
      "Uso: lint-newsletter-md.ts --md <md-path> --approved <01-approved.json-path>\n" +
        "  ou: lint-newsletter-md.ts --check titles-per-highlight --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check title-length --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check why-matters-format --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check eai-section --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check eia-answer --md <md-path> [--edition-dir <dir>]\n" +
        "  ou: lint-newsletter-md.ts --check intro-count --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check coverage-line-format --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check relative-time --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check section-counts --md <md-path> --approved <01-approved.json>\n" +
        "  ou: lint-newsletter-md.ts --check destaque-min-chars --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check destaque-max-chars --md <md-path>",
    );
    process.exit(2);
  }
  const mdPath = resolve(ROOT, args.md);
  const approvedPath = resolve(ROOT, args.approved);
  if (!existsSync(mdPath) || !existsSync(approvedPath)) {
    console.error(`Arquivo não encontrado: ${!existsSync(mdPath) ? mdPath : approvedPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const approved = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedJson;
  const result = lintNewsletter(md, approved);
  // #592, #609: check separado da linha de cobertura — não polui lintNewsletter
  // (que tem semântica focada em buckets), mas roda no mesmo CLI.
  const coverage = checkCoverageLine(md);
  if (!coverage.ok) {
    result.errors.push({
      section: "coverage_line",
      expected_bucket: "radar",
      url: "",
      line: 1,
      found_in_bucket: "missing",
      title: coverage.firstLine.slice(0, 80),
    });
    result.ok = false;
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    const sectionErrors = result.errors.filter((e) => e.section !== "coverage_line");
    const coverageErrors = result.errors.filter((e) => e.section === "coverage_line");
    if (coverageErrors.length > 0) {
      console.error(`\n❌ Linha de cobertura ausente ou em formato inválido (#592, #609).`);
      console.error(
        `  Esperado: "Para esta edição, eu (o editor) enviei X submissões e a Diar.ia encontrou outros Y artigos. Selecionamos os Z mais relevantes para as pessoas que assinam a newsletter."`,
      );
      console.error(`  Encontrado (primeira linha): "${coverageErrors[0].title}"`);
    }
    if (sectionErrors.length > 0) console.error(`\n❌ ${sectionErrors.length} erro(s) de seção:`);
    for (const e of sectionErrors) {
      const titleHint = e.title ? ` ("${e.title.slice(0, 60)}")` : "";
      console.error(
        `  ${e.section} (linha ${e.line}): ${e.url}${titleHint}\n    bucket no approved: ${e.found_in_bucket}, esperado: ${e.expected_bucket}`,
      );
    }
    process.exit(1);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
