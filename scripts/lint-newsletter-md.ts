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
import { parseInlineLink, isInlineLinkLine } from "./lib/inline-link.ts"; // #599

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

export function checkCoverageLine(md: string): { ok: boolean; firstLine: string } {
  const lines = md.split("\n");
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
        if (inline.title.length > MAX_TITLE_LENGTH) {
          errors.push({
            destaque: destaqueNum,
            category,
            title: inline.title,
            length: inline.title.length,
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
      if (t.length > MAX_TITLE_LENGTH) {
        errors.push({
          destaque: destaqueNum,
          category,
          title: t,
          length: t.length,
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
  return { ok: true };
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

  if (!args.md || !args.approved) {
    console.error(
      "Uso: lint-newsletter-md.ts --md <md-path> --approved <01-approved.json-path>\n" +
        "  ou: lint-newsletter-md.ts --check titles-per-highlight --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check title-length --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check why-matters-format --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check eai-section --md <md-path>",
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
