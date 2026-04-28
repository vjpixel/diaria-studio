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
import { looksLikeTitleOption } from "./lib/title-heuristic.ts";

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

const SECTIONS: SectionMapping[] = [
  { header: /^LAN[ÇC]AMENTOS\s*$/m, bucket: "lancamento", label: "LANÇAMENTOS" },
  { header: /^PESQUISAS\s*$/m, bucket: "pesquisa", label: "PESQUISAS" },
  { header: /^OUTRAS\s+NOT[ÍI]CIAS\s*$/m, bucket: "noticias", label: "OUTRAS NOTÍCIAS" },
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

const HIGHLIGHT_HEADER_RE = /^DESTAQUE\s+(\d+)\s*\|\s*(.+)$/;
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

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));

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

  if (!args.md || !args.approved) {
    console.error(
      "Uso: lint-newsletter-md.ts --md <md-path> --approved <01-approved.json-path>\n" +
        "  ou: lint-newsletter-md.ts --check titles-per-highlight --md <md-path>",
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
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n❌ ${result.errors.length} erro(s) de seção:`);
    for (const e of result.errors) {
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
