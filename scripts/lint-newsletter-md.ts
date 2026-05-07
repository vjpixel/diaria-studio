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
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { looksLikeTitleOption } from "./lib/title-heuristic.ts";
import { parseInlineLink } from "./lib/inline-link.ts"; // #599
import {
  checkStage2Caps,
  type ApprovedJson as CapsApprovedJson,
} from "./lib/apply-stage2-caps.ts"; // #907
import { parseHighlights } from "./lib/measure-highlights.ts"; // #914
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts"; // #926

interface ApprovedArticle {
  url: string;
  title?: string;
  [key: string]: unknown;
}

interface ApprovedJson {
  highlights?: ApprovedArticle[];
  runners_up?: ApprovedArticle[];
  lancamento?: ApprovedArticle[];
  pesquisa?: ApprovedArticle[];
  noticias?: ApprovedArticle[];
  [key: string]: unknown;
}

type Bucket = "lancamento" | "pesquisa" | "noticias";

interface SectionMapping {
  header: RegExp;
  bucket: Bucket;
  label: string;
}

// Headers podem ser plain (legacy) ou em **negrito** (#590). Aceita ambos
// pra backwards-compat com edições antigas + suporta o novo formato.
const SECTIONS: SectionMapping[] = [
  { header: /^(?:\*\*)?LAN[ÇC]AMENTOS(?:\*\*)?\s*$/m, bucket: "lancamento", label: "LANÇAMENTOS" },
  { header: /^(?:\*\*)?PESQUISAS(?:\*\*)?\s*$/m, bucket: "pesquisa", label: "PESQUISAS" },
  { header: /^(?:\*\*)?OUTRAS\s+NOT[ÍI]CIAS(?:\*\*)?\s*$/m, bucket: "noticias", label: "OUTRAS NOTÍCIAS" },
];

const SECTION_BREAK_RE = /^---\s*$/;
// Match URL up to whitespace OR markdown delimiter (`)`, `]`, `>`)
// para que [url](url) extraia 2 instâncias da mesma URL e o dedup capture.
const URL_RE = /https?:\/\/[^\s\)\]>]+/g;

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

  // Highlights primeiro — sobrescreve buckets se artigo é destaque
  for (const h of approved.highlights ?? []) {
    if (h.url) byUrl.set(h.url, { bucket: "highlights", title: h.title });
  }

  // Buckets — só seta se URL ainda não está como highlight
  for (const bucket of ["lancamento", "pesquisa", "noticias"] as const) {
    for (const a of (approved[bucket] as ApprovedArticle[] | undefined) ?? []) {
      if (a.url && !byUrl.has(a.url)) {
        byUrl.set(a.url, { bucket, title: a.title });
      }
    }
  }

  return { byUrl };
}

/**
 * #592, #609: linha de cobertura é a primeira linha não-vazia do reviewed.md.
 * Formato canônico:
 *   "Para esta edição, eu (o editor) enviei X submissões e a Diar.ia
 *    encontrou outros Y artigos. Selecionamos os Z mais relevantes para as
 *    pessoas que assinam a newsletter."
 *
 * Aceita variação com `???` no Y (fallback quando totalConsidered ausente).
 *
 * #701: aceita também forma singular ("1 submissão", "1 artigo",
 * "Selecionamos o artigo mais relevante") — concordância numérica.
 */
export const COVERAGE_LINE_RE =
  /^Para esta edi[çc][ãa]o, eu \(o editor\) enviei \d+ submiss(?:ão|ões) e a Diar\.ia encontrou outros (?:\d+|\?\?\?) artigos?\. (?:Selecionamos o artigo mais relevante|Selecionamos os \d+ mais relevantes)/i;

/**
 * #925: pula YAML frontmatter (`---\n...\n---\n`) antes de procurar a
 * primeira linha do body. Writer agent emite `eia_answer` no frontmatter
 * (output canônico, não anomalia), e o lint não pode tratar `---` (delim
 * do frontmatter) como primeira linha de cobertura.
 *
 * Frontmatter malformado (sem fechamento) é tratado como body — não pula
 * nada, deixa o regex falhar com mensagem clara.
 */
function stripFrontmatter(md: string): string {
  if (!md.startsWith("---\n") && !md.startsWith("---\r\n")) return md;
  // Procurar fechamento — `\n---` no início de linha após o delim de abertura.
  // Buscamos a partir do índice 4 pra não pegar o `---` da abertura.
  const closeMatch = md.slice(4).match(/^---\r?\n/m);
  if (!closeMatch || closeMatch.index === undefined) return md;
  const endOfClose = 4 + closeMatch.index + closeMatch[0].length;
  return md.slice(endOfClose);
}

export function checkCoverageLine(md: string): { ok: boolean; firstLine: string } {
  const body = stripFrontmatter(md);
  const lines = body.split("\n");
  const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? "";
  return {
    ok: COVERAGE_LINE_RE.test(firstNonEmpty.trim()),
    firstLine: firstNonEmpty.trim(),
  };
}

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
      const found = byUrl.get(url);
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
  pesquisa: number;
  noticias: number;
}

export function countItemsPerSection(md: string): SectionCounts {
  const urlsBySection = extractUrlsBySection(md);
  const dedup = (entries: Array<{ url: string; line: number }> | undefined) => {
    if (!entries) return 0;
    return new Set(entries.map((e) => e.url)).size;
  };
  return {
    lancamento: dedup(urlsBySection["LANÇAMENTOS"]),
    pesquisa: dedup(urlsBySection["PESQUISAS"]),
    noticias: dedup(urlsBySection["OUTRAS NOTÍCIAS"]),
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
  caps: { lancamento: number; pesquisa: number; noticias: number };
  destaques: number;
  violations: string[];
}

export function checkSectionCounts(
  md: string,
  approved: ApprovedJson,
): SectionCountsResult {
  const counts = countItemsPerSection(md);
  const dest = approved.highlights?.length ?? 0;
  const fakeApproved: CapsApprovedJson = {
    highlights: approved.highlights ?? [],
    lancamento: new Array(counts.lancamento),
    pesquisa: new Array(counts.pesquisa),
    noticias: new Array(counts.noticias),
  };
  const r = checkStage2Caps(fakeApproved);
  return {
    ok: r.ok,
    counts,
    caps: r.expectedCaps,
    destaques: dest,
    violations: r.violations,
  };
}

/**
 * Verifica que cada destaque atinge o mínimo de chars (#914).
 *
 * Mínimos editoriais (complementam os máximos do writer.md):
 *   D1 ≥ 1000 chars  (máx 1200)
 *   D2 ≥ 900 chars   (máx 1000)
 *   D3 ≥ 900 chars   (máx 1000)
 *
 * Char count exclui URLs (mesma estratégia do `parseHighlights` em
 * measure-highlights.ts) — mede só o body do destaque (parágrafos +
 * "Por que isso importa" + parágrafo de impacto).
 *
 * Em 260507 D1=999, D2=708, D3=679 — D1 quase no piso, D2/D3 bem abaixo
 * (variação D1↔D3 = +47% no peso editorial).
 */
export const DESTAQUE_MIN_CHARS = {
  1: 1000,
  2: 900,
  3: 900,
} as const;

export interface DestaqueMinCharsError {
  destaque: number;
  category: string;
  chars: number;
  min: number;
}

export interface DestaqueMinCharsReport {
  ok: boolean;
  errors: DestaqueMinCharsError[];
  highlights: Array<{ destaque: number; category: string; chars: number; min: number }>;
}

export function checkDestaqueMinChars(md: string): DestaqueMinCharsReport {
  const measured = parseHighlights(md);
  const errors: DestaqueMinCharsError[] = [];
  const summary: DestaqueMinCharsReport["highlights"] = [];

  for (const h of measured.highlights) {
    const min =
      DESTAQUE_MIN_CHARS[h.number as 1 | 2 | 3] ?? DESTAQUE_MIN_CHARS[3];
    summary.push({
      destaque: h.number,
      category: h.category,
      chars: h.chars,
      min,
    });
    if (h.chars < min) {
      errors.push({
        destaque: h.number,
        category: h.category,
        chars: h.chars,
        min,
      });
    }
  }

  return { ok: errors.length === 0, errors, highlights: summary };
}

/**
 * Verifica formato de itens nas seções secundárias (#909).
 *
 * Regra (writer.md passo 3 + context/templates/newsletter.md):
 *   linha N:   **[Título](URL)**
 *   linha N+1: Descrição em 1 frase plain text (não vazia, sem markdown)
 *   linha N+2: vazia (separador entre items)
 *
 * Detecções:
 *   - "[Título](URL) descrição" — título + descrição na mesma linha (bug 260507)
 *   - URL quebrada em multilinha "[Título](\nurl\n)" — pega via reflexo
 *     (depende de normalize-newsletter ter rodado antes)
 *   - inline link em uma linha mas próxima linha vazia ou outro inline
 *     link (faltou descrição entre)
 *
 * Não enforça `**negrito**` em volta — bold é cosmetic e validate-domains
 * já cobre se necessário.
 */
export interface SectionItemFormatError {
  section: string;
  line: number;
  type:
    | "title_and_description_same_line"
    | "title_without_description"
    | "broken_url_multiline";
  excerpt: string;
}

export interface SectionItemFormatReport {
  ok: boolean;
  errors: SectionItemFormatError[];
}

const SECTION_ITEM_HEADER_RE =
  /^(?:\*\*)?(LAN[ÇC]AMENTOS|PESQUISAS|OUTRAS\s+NOT[ÍI]CIAS)(?:\*\*)?\s*$/;

// Linha contendo APENAS um inline link bem-formado (com **bold** opcional
// e trailing spaces opcionais). Segura pra detectar item title-line.
const INLINE_LINK_ONLY_RE =
  /^\s*\*{0,2}\s*\[[^\]]+\]\(https?:\/\/[^\s)]+\)\s*\*{0,2}\s*$/;

// Linha com inline link + texto extra (descrição colada). Match conservador.
const INLINE_LINK_WITH_TEXT_RE =
  /^\s*\*{0,2}\s*\[[^\]]+\]\(https?:\/\/[^\s)]+\)\*{0,2}\s+\S/;

export function checkSectionItemFormat(md: string): SectionItemFormatReport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const errors: SectionItemFormatError[] = [];

  let currentSection: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    const sectionMatch = t.match(SECTION_ITEM_HEADER_RE);
    if (sectionMatch) {
      currentSection = sectionMatch[1].toUpperCase();
      continue;
    }
    if (t === "---") {
      currentSection = null;
      continue;
    }
    if (
      currentSection &&
      /^(?:\*\*)?DESTAQUE\s+\d+/.test(t)
    ) {
      currentSection = null;
      continue;
    }

    if (!currentSection) continue;

    // Detecta inline link + descrição na mesma linha
    if (INLINE_LINK_WITH_TEXT_RE.test(raw)) {
      errors.push({
        section: currentSection,
        line: i + 1,
        type: "title_and_description_same_line",
        excerpt: t.slice(0, 100),
      });
      continue;
    }

    // Inline link bem-formado em linha solo: validar próxima linha não-vazia
    // existe e é descrição (não outro inline link nem header).
    if (INLINE_LINK_ONLY_RE.test(raw)) {
      // Próxima linha não-vazia
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j >= lines.length) {
        errors.push({
          section: currentSection,
          line: i + 1,
          type: "title_without_description",
          excerpt: t.slice(0, 100),
        });
        continue;
      }
      const nextNonEmpty = lines[j].trim();
      // Próximo é outro inline link → faltou descrição
      if (INLINE_LINK_ONLY_RE.test(lines[j])) {
        errors.push({
          section: currentSection,
          line: i + 1,
          type: "title_without_description",
          excerpt: t.slice(0, 100),
        });
        continue;
      }
      // Se a próxima linha não-vazia for um header (DESTAQUE, --- ou
      // SEÇÃO) também conta como faltando descrição.
      if (
        SECTION_ITEM_HEADER_RE.test(nextNonEmpty) ||
        /^(?:\*\*)?DESTAQUE\s+\d+/.test(nextNonEmpty) ||
        nextNonEmpty === "---"
      ) {
        errors.push({
          section: currentSection,
          line: i + 1,
          type: "title_without_description",
          excerpt: t.slice(0, 100),
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Verifica que `02-reviewed.md` tem `eia_answer` no frontmatter quando
 * `01-eia.md` existe na mesma edition_dir (#744).
 *
 * @param mdPath  Path absoluto para o `02-reviewed.md` (ou equivalente).
 * @param editionDir  Path do diretório da edição (ex: `data/editions/260506`).
 *                    Se omitido, inferido a partir de mdPath.
 */
export interface EiaAnswerCheckResult {
  ok: boolean;
  label?: string;
}

export function checkEiaAnswer(
  mdPath: string,
  editionDir?: string,
): EiaAnswerCheckResult {
  const dir = editionDir ?? dirname(mdPath);
  const eiaPath = join(dir, "01-eia.md");
  if (!existsSync(eiaPath)) {
    // 01-eia.md não existe — check não aplicável
    return { ok: true };
  }
  // 01-eia.md existe: verificar que o md tem eia_answer no frontmatter
  if (!existsSync(mdPath)) {
    return {
      ok: false,
      label: "eia_answer_missing: 01-eia.md exists but 02-reviewed.md not found",
    };
  }
  const md = readFileSync(mdPath, "utf8");
  const hasFm = /^---[\s\S]*?eia_answer[\s\S]*?---/.test(md);
  if (!hasFm) {
    return {
      ok: false,
      label:
        "eia_answer_missing: 01-eia.md exists but 02-reviewed.md has no eia_answer frontmatter",
    };
  }
  return { ok: true };
}

/**
 * Verifica que `02-reviewed.md` tem `intentional_error` declarado no
 * frontmatter (#754). Editor adiciona manualmente após revisar a edição.
 *
 * Convenção editorial Diar.ia: cada edição inclui 1 erro proposital pros
 * assinantes acharem (concurso mensal). Sem declaração, `review-test-email`
 * não consegue distinguir erro intencional de erro real, e o concurso
 * mensal precisa lembrar manualmente o que era cada erro.
 *
 * Frontmatter esperado:
 * ```yaml
 * intentional_error:
 *   description: "..."
 *   location: "..."
 *   category: "factual|attribution|numeric|ortografico|data"
 *   correct_value: "..."
 * ```
 *
 * Roda no Stage 4 (publish-newsletter) ANTES de criar o draft no Beehiiv.
 * Falha bloqueia publicação.
 */
export interface IntentionalErrorCheckResult {
  ok: boolean;
  label?: string;
  parsed?: {
    description?: string;
    location?: string;
    category?: string;
    correct_value?: string;
  };
}

const REQUIRED_INTENTIONAL_ERROR_FIELDS = [
  "description",
  "location",
  "category",
  "correct_value",
] as const;

export function checkIntentionalError(
  mdPath: string,
): IntentionalErrorCheckResult {
  if (!existsSync(mdPath)) {
    return {
      ok: false,
      label: `intentional_error_missing: ${mdPath} not found`,
    };
  }
  const md = readFileSync(mdPath, "utf8");

  // Extract frontmatter block
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return {
      ok: false,
      label:
        "intentional_error_missing: 02-reviewed.md sem frontmatter — adicione bloco YAML com intentional_error",
    };
  }

  const fmBody = fmMatch[1];
  if (!/intentional_error\s*:/i.test(fmBody)) {
    return {
      ok: false,
      label:
        "intentional_error_missing: frontmatter sem chave intentional_error — adicione description/location/category/correct_value",
    };
  }

  // Parse simple YAML — intentional_error is a mapping with 4 string fields.
  const parsed: IntentionalErrorCheckResult["parsed"] = {};
  const ieBlockMatch = fmBody.match(
    /intentional_error\s*:\s*\n((?:[ \t]+[\w-]+\s*:\s*.+\n?)+)/,
  );
  if (!ieBlockMatch) {
    return {
      ok: false,
      label:
        "intentional_error_missing: chave intentional_error não está no formato mapping (4 campos indentados)",
    };
  }
  for (const line of ieBlockMatch[1].split("\n")) {
    const m = line.match(/^[ \t]+(\w+)\s*:\s*"?(.*?)"?\s*$/);
    if (!m) continue;
    const key = m[1] as keyof typeof parsed;
    const value = m[2].trim();
    if (value.length > 0) parsed[key] = value;
  }

  const missing = REQUIRED_INTENTIONAL_ERROR_FIELDS.filter(
    (f) => !parsed[f as keyof typeof parsed],
  );
  if (missing.length > 0) {
    return {
      ok: false,
      label: `intentional_error_incomplete: campos faltando — ${missing.join(", ")}`,
      parsed,
    };
  }

  return { ok: true, parsed };
}

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
export interface IntroCountResult {
  ok: boolean;
  claimed?: number;
  actual?: number;
}

export function lintIntroCount(md: string): IntroCountResult {
  const normalized = md.replace(/\r\n/g, "\n");

  // Extrair número declarado na intro.
  // Cobre frase canônica + variações pós-humanizador/Clarice (#804):
  //   "Selecionamos os N mais relevantes"
  //   "Escolhemos os N mais relevantes"
  //   "Reunimos os N mais relevantes"
  //   "Destacamos os N mais relevantes"
  //   "Separamos os N mais relevantes"
  //   "Trouxemos os N mais relevantes"
  const introMatch = normalized.match(
    /(?:Selecionamos|Escolhemos|Reunimos|Destacamos|Separamos|Trouxemos)\s+os?\s+(\d+)/i,
  );
  if (!introMatch) return { ok: true }; // forma singular, ausente ou frase não reconhecida — não verificar
  const claimed = parseInt(introMatch[1], 10);

  // Contar URLs editoriais no body
  // Separar blocos por `---`. Processar linha a linha.
  let actual = 0;
  const lines = normalized.split("\n");
  let inHighlight = false;
  let highlightUrlSeen = false;
  let inSection = false;
  let inEai = false;
  let sectionItemState: "expect_title" | "expect_url" | "body" = "expect_title";

  // Helper: linha é URL canônica (bare ou inline link)
  const isUrl = (s: string) =>
    /^\s*(?:\[https?:\/\/\S+\]\(https?:\/\/\S+\)|https?:\/\/\S+)\s*$/.test(s);
  const isInlineLink = (s: string) => /^\[.+\]\(https?:\/\/.+\)\s*$/.test(s);

  for (const raw of lines) {
    const t = raw.trim();

    if (t === "---") {
      inHighlight = false;
      highlightUrlSeen = false;
      inSection = false;
      inEai = false;
      sectionItemState = "expect_title";
      continue;
    }

    // É IA? — excluir desta seção inteira
    if (/^(##\s+)?É IA\?\s*$/i.test(t)) {
      inEai = true;
      inHighlight = false;
      inSection = false;
      continue;
    }
    if (inEai) continue;

    // Header de destaque — plain ou em **negrito** (#590)
    if (/^(?:\*\*)?DESTAQUE\s+\d+\s*\|/.test(t)) {
      inHighlight = true;
      highlightUrlSeen = false;
      inSection = false;
      sectionItemState = "expect_title";
      continue;
    }

    // Header de seção secundária — plain ou em **negrito** (#590)
    if (/^(?:\*\*)?(LAN[ÇC]AMENTOS|PESQUISAS|OUTRAS\s+NOT[ÍI]CIAS)(?:\*\*)?\s*$/.test(t)) {
      inSection = true;
      inHighlight = false;
      sectionItemState = "expect_title";
      continue;
    }

    // Linha em branco
    if (t === "") {
      if (inSection && sectionItemState === "body") {
        sectionItemState = "expect_title";
      }
      continue;
    }

    // Dentro de destaque: contar 1 URL por bloco (a primeira URL encontrada)
    if (inHighlight && !highlightUrlSeen) {
      if (isUrl(t) || isInlineLink(t)) {
        actual++;
        highlightUrlSeen = true;
      }
      continue;
    }

    // Dentro de seção secundária
    if (inSection) {
      // #599 — formato inline `[Título](url)`: título e URL na mesma linha.
      // Contar direto e avançar para body sem transição via expect_url.
      if (sectionItemState === "expect_title" && isInlineLink(t)) {
        actual++;
        sectionItemState = "body";
        continue;
      }
      if (sectionItemState === "expect_title" && !isUrl(t)) {
        sectionItemState = "expect_url";
        continue;
      }
      if (sectionItemState === "expect_url" && isUrl(t)) {
        actual++;
        sectionItemState = "body";
        continue;
      }
      if (sectionItemState === "expect_url" && !isUrl(t)) {
        // Edge: URL não veio após o título — reset pra próximo item
        sectionItemState = "expect_title";
      }
    }
  }

  return { ok: claimed === actual, claimed, actual };
}

/**
 * Detecta referências temporais relativas banidas no MD da newsletter (#747).
 *
 * Edições publicam D+1: "hoje" / "ontem" / "esta semana" são ambíguos no
 * momento da leitura.
 *
 * Retorna array de matches com contexto (trecho da linha).
 */
export interface RelativeTimeMatch {
  word: string;
  context: string;
  line: number;
}

export interface RelativeTimeResult {
  ok: boolean;
  matches: RelativeTimeMatch[];
}

// Nota: \b não funciona com caracteres Unicode (ã, ê, etc.) — usamos
// lookahead/lookbehind em vez de \b para cobrir amanhã, mês, etc.
const RELATIVE_TIME_RE =
  /(?<!\w)(hoje|ontem|amanhã|agora mesmo|esta semana|na semana passada|na próxima semana|este mês|mês passado|recentemente|há pouco|acabou de|nesta (?:segunda|terça|quarta|quinta|sexta|sábado|domingo))(?!\w)/gi;

export function lintRelativeTime(md: string): RelativeTimeResult {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const matches: RelativeTimeMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    // Reset lastIndex (g flag) between lines
    RELATIVE_TIME_RE.lastIndex = 0;
    while ((m = RELATIVE_TIME_RE.exec(line)) !== null) {
      matches.push({
        word: m[1],
        context: line.slice(Math.max(0, m.index - 20), m.index + m[1].length + 20).trim(),
        line: i + 1,
      });
    }
  }

  return {
    ok: matches.length === 0,
    matches,
  };
}

// #926: parseArgs local removido — usar parseCliArgs (scripts/lib/cli-args.ts).

/**
 * Conta linhas de título por bloco DESTAQUE (#178, atualizado em #245).
 *
 * Espera que cada bloco DESTAQUE tenha exatamente 1 título antes do gate
 * de Stage 2 ser aprovado. Writer produz 3 opções; editor deve podar
 * pra 1 antes de prosseguir pro Stage 3.
 *
 * **Formato pós-#245** (double newlines entre cada elemento):
 *
 *   DESTAQUE N | CATEGORIA
 *
 *   <opção 1>
 *
 *   <opção 2>      ← removidas pelo editor pré-Stage 3
 *
 *   <opção 3>
 *
 *   <URL>
 *
 *   <parágrafo 1>
 *
 * Algoritmo: após o header, pula linhas em branco e coleta linhas
 * não-vazias e não-URL como títulos. Para no primeiro de:
 *   - Linha de URL (terminator canônico — URL vem logo após títulos por #172)
 *   - Próximo header DESTAQUE
 *   - Header de seção secundária (LANÇAMENTOS/etc.)
 *   - Section break `---`
 *
 * Compatível com formato pré-#245 (single newline) — a ausência de blank
 * line entre título e URL ainda funciona porque a URL termina o bloco.
 */

// Header de destaque — plain ou em **negrito** (#590). O `**` final é
// stripado da capture group 2 abaixo se presente.
const HIGHLIGHT_HEADER_RE = /^(?:\*\*)?DESTAQUE\s+(\d+)\s*\|\s*(.+?)(?:\*\*)?$/;
const URL_LINE_RE = /^https?:\/\//;
const SECTION_BREAK_LINE_RE = /^---\s*$/;
const SECTION_HEADER_LINE_RE = /^[A-ZÇÃÕÁÉÍÓÚÊÔ ]{5,}$/;
const WHY_MATTERS_LINE_RE = /^Por que isso importa:/i;

export interface TitleCheckResult {
  destaque: number;
  category: string;
  title_count: number;
  titles: string[];
  status: "ok" | "needs_pruning";
}

export interface TitleCheckReport {
  ok: boolean;
  destaques: TitleCheckResult[];
  errors: string[];
}

export function countTitlesPerHighlight(md: string): TitleCheckReport {
  const lines = md.split("\n");
  const destaques: TitleCheckResult[] = [];
  const errors: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(HIGHLIGHT_HEADER_RE);
    if (!m) {
      i++;
      continue;
    }
    const destaqueNum = parseInt(m[1], 10);
    const category = m[2].trim();
    // Coletar títulos: pula blanks, para em URL/header/section break/marker.
    // Heurística adicional (#245): linha que parece body (longa OU termina
    // com ponto) também encerra — protege legacy onde URL fica no fim do
    // bloco e o título não tem URL imediatamente abaixo.
    const titles: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const t = lines[j].trim();
      // Pula linhas em branco (blank line entre elementos no formato #245)
      if (t === "") {
        j++;
        continue;
      }
      // #599 — formato inline `[título](URL)`: extrai título do link.
      // No formato inline, o título inteiro pode passar de 60 chars (limite
      // do looksLikeTitleOption); precisa tratar antes do filtro legacy.
      const inline = parseInlineLink(t);
      if (inline) {
        titles.push(inline.title);
        j++;
        continue;
      }
      // URL é o terminator canônico (URL imediatamente após títulos por #172)
      if (URL_LINE_RE.test(t)) break;
      // "Por que isso importa:" termina o título block (legacy URL-no-fim)
      if (WHY_MATTERS_LINE_RE.test(t)) break;
      // Outro DESTAQUE (raro — destaque sem URL/body)
      if (HIGHLIGHT_HEADER_RE.test(t)) break;
      // Section break ou cabeçalho de seção secundária
      if (SECTION_BREAK_LINE_RE.test(t)) break;
      if (SECTION_HEADER_LINE_RE.test(t) && t !== category) break;
      // Heurística #259: aceita título curto terminando em `?`, `!`, `...`
      // ou palavras; rejeita ponto único final (= body). Mesmo critério do
      // parseDestaques (extract-destaques.ts).
      if (!looksLikeTitleOption(t)) break;
      titles.push(t);
      j++;
    }
    destaques.push({
      destaque: destaqueNum,
      category,
      title_count: titles.length,
      titles,
      status: titles.length === 1 ? "ok" : "needs_pruning",
    });
    if (titles.length !== 1) {
      errors.push(
        `DESTAQUE ${destaqueNum} (${category}): ${titles.length} título(s) — esperado 1. ${
          titles.length > 1
            ? "Delete os excedentes antes de prosseguir."
            : "Adicione 1 título."
        }`,
      );
    }
    i = j;
  }

  // Garantir que houve 3 destaques
  if (destaques.length !== 3) {
    errors.push(
      `Esperado 3 destaques (DESTAQUE 1/2/3); encontrei ${destaques.length}.`,
    );
  }

  return { ok: errors.length === 0, destaques, errors };
}

/**
 * Verifica que cada título de destaque cabe em ≤52 caracteres (#701).
 *
 * `editorial-rules.md` exige "Título: máximo 52 caracteres" — antes desse
 * check só self-validation do writer LLM pegava. `--check titles-per-highlight`
 * conta quantos, este conta a largura.
 *
 * Não reusa `countTitlesPerHighlight` porque essa função usa `looksLikeTitleOption`
 * que rejeita linhas >60 chars (= body) — exatamente os candidatos que
 * precisamos pegar aqui (título mal-formado pelo writer LLM com 60+ chars).
 *
 * Parser próprio mais permissivo: após cada DESTAQUE header, coleta toda
 * linha não-vazia, não-URL, que não termine com ponto único (= body óbvio),
 * até a primeira URL ou próximo header. Não impõe limite superior — quanto
 * maior o título errado, mais importante é pegar.
 */
export interface TitleLengthError {
  destaque: number;
  category: string;
  title: string;
  length: number;
  max: number;
}

export interface TitleLengthReport {
  ok: boolean;
  errors: TitleLengthError[];
}

const MAX_TITLE_LENGTH = 52;

/**
 * Conta grafemas (caracteres visíveis) em vez de code units UTF-16.
 * Evita falsos positivos em títulos com emojis de bandeira (ex: 🇧🇷 = 1
 * grafema mas 4 code units). Usa Intl.Segmenter (Node 16+). (#801)
 */
function graphemeLength(str: string): number {
  return [...new Intl.Segmenter().segment(str)].length;
}

export function checkTitleLengths(md: string): TitleLengthReport {
  const lines = md.split("\n");
  const errors: TitleLengthError[] = [];

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(HIGHLIGHT_HEADER_RE);
    if (!m) {
      i++;
      continue;
    }
    const destaqueNum = parseInt(m[1], 10);
    const category = m[2].trim();
    let j = i + 1;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (t === "") { j++; continue; }
      // #599 — formato inline: extrai título do link e mede só o texto.
      const inline = parseInlineLink(t);
      if (inline) {
        const gLen = graphemeLength(inline.title);
        if (gLen > MAX_TITLE_LENGTH) {
          errors.push({
            destaque: destaqueNum,
            category,
            title: inline.title,
            length: gLen,
            max: MAX_TITLE_LENGTH,
          });
        }
        j++;
        continue;
      }
      if (URL_LINE_RE.test(t)) break;
      if (HIGHLIGHT_HEADER_RE.test(t)) break;
      if (SECTION_BREAK_LINE_RE.test(t)) break;
      if (SECTION_HEADER_LINE_RE.test(t) && t !== category) break;
      if (WHY_MATTERS_LINE_RE.test(t)) break;
      // Body óbvio: termina em ponto único (não ellipsis). Pula sem flag.
      if (/\.\s*$/.test(t) && !/\.{3,}\s*$/.test(t)) {
        j++;
        continue;
      }
      // Candidato a título legacy (sem inline link) — valida linha inteira
      const gLen = graphemeLength(t);
      if (gLen > MAX_TITLE_LENGTH) {
        errors.push({
          destaque: destaqueNum,
          category,
          title: t,
          length: gLen,
          max: MAX_TITLE_LENGTH,
        });
      }
      j++;
    }
    i = j;
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Verifica formato do parágrafo "Por que isso importa:" (#701, editorial-rules:35).
 *
 * Regra: "O parágrafo de 'Por que isso importa' vai direto ao impacto —
 * nunca começa com 'Para [audiência],' ou endereça o leitor explicitamente."
 *
 * Detecta tanto formato inline ("Por que isso importa: Para X,...") quanto
 * em linha separada (próxima linha não-vazia começando com "Para X,").
 */
export interface WhyMattersError {
  line: number;
  text: string;
}

export interface WhyMattersReport {
  ok: boolean;
  errors: WhyMattersError[];
}

const WHY_MATTERS_BAD_START_RE = /^Para\s+[a-záéíóúâêôãõç]/i;

export function checkWhyMattersFormat(md: string): WhyMattersReport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const errors: WhyMattersError[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^Por que isso importa:\s*(.*)$/i);
    if (!m) continue;
    const inlineRest = m[1].trim();
    if (inlineRest) {
      // Forma inline: "Por que isso importa: Para X,..."
      if (WHY_MATTERS_BAD_START_RE.test(inlineRest)) {
        errors.push({ line: i + 1, text: inlineRest.slice(0, 80) });
      }
      continue;
    }
    // Forma multi-linha: próxima linha não-vazia
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t === "") continue;
      if (WHY_MATTERS_BAD_START_RE.test(t)) {
        errors.push({ line: j + 1, text: t.slice(0, 80) });
      }
      break;
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Verifica que a seção É IA? está presente no MD da newsletter (#588).
 *
 * Writer agent (Sonnet) tem instrução explícita pra emitir bloco É IA? entre
 * D2 e D3 (ver writer.md step 2b). Mas tem ignorado silenciosamente.
 * Este check determinístico bloqueia o gate quando a seção falta.
 *
 * Aceita as 2 formas de marcação:
 *   - "É IA?" como linha solo (formato cru do writer)
 *   - "## É IA?" (formato categorized embedded #371)
 *
 * #908: quando o frontmatter contém `eia_answer` (gabarito A/B), a seção
 * deve incluir uma linha "Gabarito: **A = ..., B = ..." pro editor revisar
 * o draft no Drive sem ter que abrir frontmatter ou 01-eia.md em paralelo.
 * Stage 4 (publish-newsletter) lê 01-eia.md direto pro HTML — gabarito
 * fica em 02-reviewed.md, não bleeds pra newsletter publicada.
 */
export function checkEaiSection(md: string): { ok: boolean; error?: string } {
  // Normalizar CRLF
  const normalized = md.replace(/\r\n/g, "\n");
  const hasEia =
    /^É IA\?\s*$/m.test(normalized) ||
    /^##\s+É IA\?\s*$/m.test(normalized);
  if (!hasEia) {
    return {
      ok: false,
      error:
        "Seção É IA? ausente. Writer deveria inserir entre DESTAQUE 2 e DESTAQUE 3 (writer.md step 2b). " +
        "Inserir bloco lendo de 01-eia.md ou 01-categorized.md.",
    };
  }

  // #908: se frontmatter tem eia_answer, body deve ter linha de gabarito.
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const hasEiaAnswer = /eia_answer\s*:/.test(fm);
    if (hasEiaAnswer) {
      // Aceitar formatos: "Gabarito: A = ia, B = real" com ou sem negrito,
      // com ou sem prefixo `>` (blockquote), com qualquer combinação ia/real.
      const hasGabarito = /Gabarito\s*:\s*\*{0,2}A\s*=\s*(ia|real)\*{0,2}\s*,\s*\*{0,2}B\s*=\s*(ia|real)\*{0,2}/i.test(
        normalized,
      );
      if (!hasGabarito) {
        return {
          ok: false,
          error:
            "Seção É IA? sem linha de gabarito no body (#908). Frontmatter tem `eia_answer` mas falta " +
            "linha `> Gabarito: **A = {ia|real}**, **B = {ia|real}**` no body — editor não consegue ver " +
            "qual imagem é qual no Drive review sem abrir frontmatter ou 01-eia.md em paralelo.",
        };
      }
    }
  }

  return { ok: true };
}

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
          `lançamentos≤${result.caps.lancamento}, pesquisas≤${result.caps.pesquisa}, ` +
          `outras≤${result.caps.noticias} (formula: max(2, 12-${result.destaques}-l-p))`,
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
        "  ou: lint-newsletter-md.ts --check relative-time --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check section-counts --md <md-path> --approved <01-approved.json>\n" +
        "  ou: lint-newsletter-md.ts --check destaque-min-chars --md <md-path>",
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
      expected_bucket: "noticias",
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
