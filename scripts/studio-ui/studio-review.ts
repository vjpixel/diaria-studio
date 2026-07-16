/**
 * studio-review.ts (#3559 — Studio UI fatia 5: revisão de conteúdo rica)
 *
 * Camada de leitura/escrita + lint + diff + preview pro painel de revisão
 * dos 3 arquivos gate-facing de uma edição (`01-categorized.md`,
 * `02-reviewed.md`, `03-social.md`) — a fatia de AÇÃO do epic #3554 (as
 * fatias anteriores, #3555/#3558/#3562/#3563, são todas read-only).
 *
 * Arquivos PRÓPRIOS desta fatia (convenção pedida no dispatch: não tocar
 * `server.ts` além de registro aditivo de rotas, pra não colidir com os
 * outros painéis em construção em paralelo, #3556/#3562).
 *
 * Design (ver PR body pra rationale completo):
 *   - Baseline "versão do agente": capturada preguiçosamente na 1ª leitura
 *     de um arquivo pelo painel (`_internal/studio-review-baseline/{arquivo}.md`,
 *     nunca sincronizado pro Drive — é acessório interno do Studio, análogo
 *     a `_internal/*`). O editor pode resetar explicitamente
 *     (`resetBaseline`) se quiser tratar o estado atual como novo baseline
 *     (ex: depois de um re-run de Stage 2).
 *   - Save é ESCRITA DIRETA do conteúdo inteiro — o Studio *é* a sessão local
 *     do editor (não um agente fazendo edição cirúrgica de terceiros); #495
 *     mira em agentes editando por cima do editor, não o editor editando o
 *     próprio conteúdo. #494 (pull antes de abrir) é endereçado por
 *     `pullReviewFileBestEffort`, chamado pelo caller HTTP antes do read.
 *   - Lints reusam as funções PURAS já exportadas por
 *     `lint-newsletter-md.ts` / `lint-social-md.ts` / `validate-lancamentos.ts`
 *     — nenhuma regra é reimplementada aqui, só orquestrada. Fail-soft por
 *     check: uma exceção num check vira `{ ok: false, crashed: true, error }`
 *     em vez de derrubar o batch inteiro (#3559 princípio "erro de lint não
 *     derruba o Studio").
 *   - Preview reusa `extractContent` + `renderHTML({ fullDocument: true })`
 *     do pipeline (mesmo render usado no Stage 4) — zero reimplementação de
 *     template.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveEditionDir } from "../lib/find-current-edition.ts";
import { diffLines, diffIsEmpty, type DiffLine } from "./text-diff.ts";
import { extractContent } from "../lib/newsletter-parse.ts";
import { findOrphanBoxWarnings } from "../lib/newsletter-parse.ts";
import { renderHTML } from "../lib/newsletter-render-html.ts";
import {
  countTitlesPerHighlight,
  checkTitleLengths,
  checkWhyMattersFormat,
  checkEaiSection,
  lintIntroCount,
  checkCoverageLine,
  checkDestaqueMinChars,
  checkDestaqueMaxChars,
  checkSectionItemFormat,
  lintMultilineLinks,
  lintRelativeTime as lintNewsletterRelativeTime,
  checkUseMelhorTempo,
  checkSecondaryItemsHaveSummary,
  checkTitlePublisherSuffix,
  checkTitleTrailingPeriod,
  checkNoTrailingEllipsis,
  checkMidSentenceEllipsis,
  checkNoUntranslatedSummary,
  checkVideoLinksAreYoutube,
  lintCalloutPlacement,
  lintStackedIntroCallouts,
  checkSectionCounts,
  lintNewsletter,
} from "../lint-newsletter-md.ts";
import type { ApprovedJson } from "../lib/lint-checks/url-bucket.ts";
import {
  lintSocialMd,
  lintRelativeTime as lintSocialRelativeTime,
  lintTrailingQuestion,
  lintLinkedinSchema,
  lintPostPixelMatchesD1,
  lintPersonalPostNewsletterDeixis,
  lintLinkedinEmailCTA,
  lintInstagramEmailCTA,
  lintLinkedinPageLink,
  lintPlatformHeadersUnique,
  lintCredentialBio,
  lintAntithesisReveal,
  lintTrailingEditorialHook,
} from "../lint-social-md.ts";
import { validateLancamentos, loadToolAllowlist } from "../validate-lancamentos.ts";

// ── Arquivos revisáveis ─────────────────────────────────────────────────

export type ReviewSlug = "categorized" | "reviewed" | "social";

export const REVIEW_FILES: Record<ReviewSlug, string> = {
  categorized: "01-categorized.md",
  reviewed: "02-reviewed.md",
  social: "03-social.md",
};

/** Stage de pipeline associado a cada arquivo — usado só como metadado pro
 * `--stage` de `drive-sync.ts` (#494); não afeta comportamento do pull. */
const REVIEW_STAGE: Record<ReviewSlug, number> = {
  categorized: 1,
  reviewed: 2,
  social: 2,
};

export function isReviewSlug(v: string): v is ReviewSlug {
  return v === "categorized" || v === "reviewed" || v === "social";
}

const AAMMDD_RE = /^\d{6}$/;

export interface ResolvedReviewFile {
  aammdd: string;
  slug: ReviewSlug;
  filename: string;
  editionDir: string; // absoluto
  filePath: string; // absoluto
  baselinePath: string; // absoluto
}

/** Resolve os paths envolvidos — retorna `null` quando AAMMDD é inválido. */
export function resolveReviewFile(
  rootDir: string,
  aammdd: string,
  slug: string,
): ResolvedReviewFile | null {
  if (!AAMMDD_RE.test(aammdd) || !isReviewSlug(slug)) return null;
  const editionsRootAbs = resolve(rootDir, "data", "editions");
  const editionDir = resolveEditionDir(editionsRootAbs, aammdd);
  const filename = REVIEW_FILES[slug];
  const filePath = resolve(editionDir, filename);
  const baselinePath = resolve(editionDir, "_internal", "studio-review-baseline", `${filename}.md`);
  return { aammdd, slug, filename, editionDir, filePath, baselinePath };
}

/** Garante que existe um baseline capturado — cria a partir do conteúdo
 * ATUAL na 1ª chamada (arquivo do baseline ausente). Idempotente: chamadas
 * seguintes não sobrescrevem (a captura é "a versão que o agente entregou",
 * não "a última vez que alguém leu"). */
function ensureBaseline(resolved: ResolvedReviewFile, currentContent: string): string {
  if (existsSync(resolved.baselinePath)) {
    return readFileSync(resolved.baselinePath, "utf8");
  }
  mkdirSync(dirname(resolved.baselinePath), { recursive: true });
  writeFileSync(resolved.baselinePath, currentContent, "utf8");
  return currentContent;
}

export interface ReviewFileState {
  ok: boolean;
  error?: string;
  aammdd: string;
  slug: ReviewSlug;
  filename: string;
  exists: boolean;
  content: string;
  baseline: string;
  modifiedAt: string | null;
}

/** Lê o estado atual de um arquivo revisável — captura baseline se ausente. */
export function readReviewFile(rootDir: string, aammdd: string, slug: string): ReviewFileState {
  const resolved = resolveReviewFile(rootDir, aammdd, slug);
  if (!resolved) {
    return {
      ok: false,
      error: "AAMMDD ou arquivo inválido",
      aammdd,
      slug: (isReviewSlug(slug) ? slug : "reviewed") as ReviewSlug,
      filename: "",
      exists: false,
      content: "",
      baseline: "",
      modifiedAt: null,
    };
  }
  if (!existsSync(resolved.filePath)) {
    return {
      ok: true,
      aammdd,
      slug: resolved.slug,
      filename: resolved.filename,
      exists: false,
      content: "",
      baseline: "",
      modifiedAt: null,
    };
  }
  const content = readFileSync(resolved.filePath, "utf8");
  const baseline = ensureBaseline(resolved, content);
  const modifiedAt = statSync(resolved.filePath).mtime.toISOString();
  return {
    ok: true,
    aammdd,
    slug: resolved.slug,
    filename: resolved.filename,
    exists: true,
    content,
    baseline,
    modifiedAt,
  };
}

export interface SaveReviewResult {
  ok: boolean;
  error?: string;
  filename: string;
  modifiedAt: string | null;
}

/** Escreve o conteúdo inteiro do editor de volta no arquivo — o Studio é a
 * sessão local ativa do editor (ver nota de design no topo do arquivo). */
export function saveReviewFile(
  rootDir: string,
  aammdd: string,
  slug: string,
  content: string,
): SaveReviewResult {
  const resolved = resolveReviewFile(rootDir, aammdd, slug);
  if (!resolved) return { ok: false, error: "AAMMDD ou arquivo inválido", filename: "", modifiedAt: null };
  if (!existsSync(resolved.editionDir)) {
    return { ok: false, error: `edição não encontrada: ${aammdd}`, filename: resolved.filename, modifiedAt: null };
  }
  try {
    writeFileSync(resolved.filePath, content, "utf8");
    const modifiedAt = statSync(resolved.filePath).mtime.toISOString();
    return { ok: true, filename: resolved.filename, modifiedAt };
  } catch (e) {
    return { ok: false, error: (e as Error).message, filename: resolved.filename, modifiedAt: null };
  }
}

/** Reseta o baseline pro conteúdo atual (editor decide "isto agora é a nova
 * versão de referência" — ex: depois de um re-run manual de Stage 2). */
export function resetBaseline(rootDir: string, aammdd: string, slug: string): SaveReviewResult {
  const resolved = resolveReviewFile(rootDir, aammdd, slug);
  if (!resolved) return { ok: false, error: "AAMMDD ou arquivo inválido", filename: "", modifiedAt: null };
  if (!existsSync(resolved.filePath)) {
    return { ok: false, error: `arquivo ainda não existe: ${resolved.filename}`, filename: resolved.filename, modifiedAt: null };
  }
  const content = readFileSync(resolved.filePath, "utf8");
  mkdirSync(dirname(resolved.baselinePath), { recursive: true });
  writeFileSync(resolved.baselinePath, content, "utf8");
  return { ok: true, filename: resolved.filename, modifiedAt: new Date().toISOString() };
}

export interface ReviewDiffResult {
  ok: boolean;
  error?: string;
  filename: string;
  isEmpty: boolean;
  lines: DiffLine[];
}

/** Diff do conteúdo ATUAL em disco vs. o baseline capturado. */
export function computeReviewDiff(rootDir: string, aammdd: string, slug: string): ReviewDiffResult {
  const state = readReviewFile(rootDir, aammdd, slug);
  if (!state.ok) return { ok: false, error: state.error, filename: state.filename, isEmpty: true, lines: [] };
  if (!state.exists) {
    return { ok: true, filename: state.filename, isEmpty: true, lines: [] };
  }
  const lines = diffLines(state.baseline, state.content);
  return { ok: true, filename: state.filename, isEmpty: diffIsEmpty(lines), lines };
}

// ── Lints ────────────────────────────────────────────────────────────────

export interface LintCheckResult {
  id: string;
  label: string;
  /** `false` = achado bloqueia o gate na pipeline real; `true` = warn-only
   * (mesma classificação documentada em lint-newsletter-md.ts/lint-social-md.ts). */
  blocking: boolean;
  ok: boolean;
  /** `true` quando o check lançou exceção — fail-soft, não derruba o batch. */
  crashed: boolean;
  detail?: unknown;
  error?: string;
}

export interface LintReport {
  ok: boolean; // agregado: false se algum check BLOCKING falhou ou crashou
  checks: LintCheckResult[];
  skipped: string[]; // checks pulados (ex: falta 01-approved.json)
}

function runCheck<T extends { ok: boolean }>(
  id: string,
  label: string,
  blocking: boolean,
  fn: () => T,
): LintCheckResult {
  try {
    const result = fn();
    return { id, label, blocking, ok: result.ok, crashed: false, detail: result };
  } catch (e) {
    return { id, label, blocking, ok: false, crashed: true, error: (e as Error).message };
  }
}

function readApprovedJson(editionDir: string): ApprovedJson | null {
  const p = resolve(editionDir, "_internal", "01-approved.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ApprovedJson;
  } catch {
    return null;
  }
}

function lintCategorized(md: string, rootDir: string): LintReport {
  const skipped: string[] = [];
  const checks: LintCheckResult[] = [
    runCheck("lancamentos-oficiais", "LANÇAMENTOS só com link oficial (#160)", true, () => {
      const allowlist = loadToolAllowlist(rootDir);
      const r = validateLancamentos(md, allowlist);
      return { ok: r.status === "ok" && r.invalid_urls.length === 0 && r.not_a_tool.length === 0, ...r };
    }),
  ];
  return { ok: checks.every((c) => !c.blocking || c.ok), checks, skipped };
}

function lintReviewed(md: string, rootDir: string, editionDir: string): LintReport {
  const skipped: string[] = [];
  const approved = readApprovedJson(editionDir);

  const checks: LintCheckResult[] = [
    runCheck("titles-per-highlight", "1 título por destaque após poda (#178)", true, () => countTitlesPerHighlight(md)),
    runCheck("title-length", "Título ≤52 chars", true, () => checkTitleLengths(md)),
    runCheck("why-matters-format", "'Por que isso importa' sem abertura 'Para [audiência],'", true, () => checkWhyMattersFormat(md)),
    runCheck("eai-section", "Seção É IA? presente", true, () => checkEaiSection(md)),
    runCheck("intro-count", "Intro bate com contagem real de itens (#743)", true, () => lintIntroCount(md)),
    runCheck("coverage-line-format", "Linha de cobertura no formato canônico", true, () => checkCoverageLine(md)),
    runCheck("destaque-min-chars", "Destaque acima do mínimo de chars", true, () => checkDestaqueMinChars(md)),
    runCheck("destaque-max-chars", "Destaque abaixo do máximo de chars", true, () => checkDestaqueMaxChars(md)),
    runCheck("section-item-format", "Itens de seção secundária no formato esperado", true, () => checkSectionItemFormat(md)),
    runCheck("multiline-links", "Sem links markdown quebrados em múltiplas linhas", true, () => lintMultilineLinks(md)),
    runCheck("relative-time", "Sem referência temporal relativa (edição publica D+1)", true, () => lintNewsletterRelativeTime(md)),
    runCheck("use-melhor-tempo", "Itens USE MELHOR com estimativa de tempo", true, () => checkUseMelhorTempo(md)),
    runCheck("secondary-items-have-summary", "Itens de seção secundária com descrição", true, () => checkSecondaryItemsHaveSummary(md)),
    runCheck("no-untranslated-summary", "Sem descrição não-traduzida", true, () => checkNoUntranslatedSummary(md)),
    runCheck("video-links-are-youtube", "Links de VÍDEOS são do YouTube", true, () => checkVideoLinksAreYoutube(md)),
    runCheck("callout-placement", "Callout isolado (não colado dentro de destaque)", true, () => lintCalloutPlacement(md)),
    runCheck("stacked-intro-callouts", "Sem callouts empilhados na intro", true, () => lintStackedIntroCallouts(md)),
    runCheck("orphan-box-in-gap", "Sem box de divulgação órfão numa lacuna", true, () => {
      const placement = lintCalloutPlacement(md);
      const orphanGaps = findOrphanBoxWarnings(md);
      return { ok: placement.ok && orphanGaps.length === 0, placement, orphanGaps };
    }),
    // Warn-only (#2715) — mesma classificação da pipeline: nunca bloqueiam,
    // só surfaçam pro editor decidir.
    runCheck("title-publisher-suffix", "Título sem sufixo de veículo (warn)", false, () => checkTitlePublisherSuffix(md)),
    runCheck("title-trailing-period", "Título sem ponto final (warn)", false, () => checkTitleTrailingPeriod(md)),
    runCheck("no-trailing-ellipsis", "Descrição sem reticências finais (warn)", false, () => checkNoTrailingEllipsis(md)),
    runCheck("mid-sentence-ellipsis", "Descrição sem reticências no meio (warn)", false, () => checkMidSentenceEllipsis(md)),
  ];

  if (approved) {
    checks.push(
      runCheck("section-counts", "Seções secundárias respeitam caps (#358)", true, () => checkSectionCounts(md, approved)),
      runCheck("url-bucket", "URL na seção certa (bucket do 01-approved.json)", true, () => lintNewsletter(md, approved)),
    );
  } else {
    skipped.push("section-counts", "url-bucket");
  }

  return { ok: checks.every((c) => !c.blocking || c.ok), checks, skipped };
}

function lintSocial(md: string): LintReport {
  const skipped: string[] = [];
  const checks: LintCheckResult[] = [
    runCheck("cta-format", "CTAs LinkedIn/Facebook no formato certo (#602)", true, () => lintSocialMd(md)),
    runCheck("relative-time", "Sem timestamp relativo em post social (#877)", true, () => lintSocialRelativeTime(md)),
    runCheck("no-trailing-question", "Post não encerra com pergunta (#1762)", true, () => lintTrailingQuestion(md)),
    runCheck("linkedin-schema", "3 textos por destaque no LinkedIn (#595)", true, () => lintLinkedinSchema(md)),
    runCheck("post-pixel-matches-d1", "Post pessoal do Pixel alinhado ao D1 (#1861)", true, () => lintPostPixelMatchesD1(md)),
    runCheck("personal-post-deixis", "Sem deixis de newsletter em post pessoal (#2148)", true, () => lintPersonalPostNewsletterDeixis(md)),
    runCheck("no-email-cta-linkedin", "Sem CTA de e-mail no LinkedIn (#2458)", true, () => lintLinkedinEmailCTA(md)),
    runCheck("no-email-cta-instagram", "Sem CTA de e-mail no Instagram (#2486)", true, () => lintInstagramEmailCTA(md)),
    runCheck("linkedin-page-link", "Link da página da Diar.ia presente (#2458)", true, () => lintLinkedinPageLink(md)),
    runCheck("platform-headers-unicos", "Headers # LinkedIn / # Facebook únicos (#3388)", true, () => lintPlatformHeadersUnique(md)),
    runCheck("no-credential-bio", "Sem frase de credencial/bio auto-referencial (#2494)", true, () => lintCredentialBio(md)),
    // Warn-only (#2715-like — o próprio CLI documenta "sempre exit 0").
    runCheck("no-antithesis-reveal", "Sem construção de antítese-revelação (warn, #2526)", false, () => {
      const r = lintAntithesisReveal(md);
      return { ...r, ok: r.matches.length === 0 };
    }),
    runCheck("no-trailing-editorial-hook", "Sem gancho editorial emendado (warn, #2658)", false, () => {
      const r = lintTrailingEditorialHook(md);
      return { ...r, ok: r.matches.length === 0 };
    }),
  ];
  return { ok: checks.every((c) => !c.blocking || c.ok), checks, skipped };
}

/** Roda o conjunto de lints aplicável ao `slug`, sobre `content` (o que está
 * no editor/disco agora — não precisa ter sido salvo ainda). Fail-soft por
 * check (ver `runCheck`); nunca lança. */
export function runReviewLints(
  rootDir: string,
  editionDir: string,
  slug: ReviewSlug,
  content: string,
): LintReport {
  if (slug === "categorized") return lintCategorized(content, rootDir);
  if (slug === "reviewed") return lintReviewed(content, rootDir, editionDir);
  return lintSocial(content);
}

// ── Preview do e-mail ───────────────────────────────────────────────────

export interface PreviewResult {
  ok: boolean;
  html: string;
  error?: string;
}

/** Renderiza o HTML completo do e-mail a partir do `02-reviewed.md` (+
 * `01-eia.md`) ATUALMENTE em disco — reusa `extractContent`/`renderHTML` do
 * pipeline (mesmo caminho do Stage 4). Fail-soft: qualquer exceção de parse
 * (ex: menos de 2 destaques, seção ausente) vira uma página de erro simples
 * em vez de derrubar a rota. */
export function buildReviewPreviewHtml(editionDir: string): PreviewResult {
  if (!existsSync(resolve(editionDir, "02-reviewed.md"))) {
    return {
      ok: false,
      error: "02-reviewed.md ainda não existe nesta edição — nada pra pré-visualizar.",
      html: errorHtml("Sem preview", "02-reviewed.md ainda não existe nesta edição."),
    };
  }
  try {
    const content = extractContent(editionDir);
    const html = renderHTML(content, { fullDocument: true });
    return { ok: true, html };
  } catch (e) {
    const message = (e as Error).message;
    return { ok: false, error: message, html: errorHtml("Erro ao renderizar preview", message) };
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function errorHtml(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title></head>` +
    `<body style="font-family: sans-serif; padding: 2rem; color: #444;">` +
    `<h1>${escHtml(title)}</h1><p>${escHtml(message)}</p></body></html>`;
}

// ── Pull do Drive antes de abrir (#494) — best-effort, fail-soft ────────

export interface PullResult {
  attempted: boolean;
  ok: boolean;
  detail?: unknown;
  error?: string;
}

export type SpawnFn = typeof spawnSync;

/**
 * Chama `scripts/drive-sync.ts --mode pull` pro arquivo, best-effort (#494).
 * Nunca lança — falha (offline, sem credenciais, sem cache) vira
 * `{ ok: false, error }`, não bloqueia a leitura do arquivo local (mesmo
 * invariante fail-soft documentado em CLAUDE.md "Sync com Google Drive").
 * `spawnFn` é injetável pra testes (evita spawnar processo real).
 */
export function pullReviewFileBestEffort(
  rootDir: string,
  aammdd: string,
  slug: ReviewSlug,
  spawnFn: SpawnFn = spawnSync,
): PullResult {
  const resolved = resolveReviewFile(rootDir, aammdd, slug);
  if (!resolved) return { attempted: false, ok: false, error: "AAMMDD ou arquivo inválido" };
  if (!existsSync(resolved.editionDir)) return { attempted: false, ok: false, error: "edição não encontrada" };

  try {
    const scriptPath = resolve(rootDir, "scripts", "drive-sync.ts");
    const editionDirArg = resolved.editionDir.startsWith(rootDir)
      ? resolved.editionDir.slice(rootDir.length).replace(/^[\\/]/, "")
      : resolved.editionDir;
    const proc = spawnFn(
      process.execPath,
      [
        "--import", "tsx",
        scriptPath,
        "--mode", "pull",
        "--edition-dir", editionDirArg,
        "--stage", String(REVIEW_STAGE[slug]),
        "--files", resolved.filename,
      ],
      { cwd: rootDir, encoding: "utf8", timeout: 20_000 },
    );
    if (proc.error) return { attempted: true, ok: false, error: proc.error.message };
    if (proc.status !== 0) {
      return { attempted: true, ok: false, error: proc.stderr || `drive-sync saiu com status ${proc.status}` };
    }
    try {
      return { attempted: true, ok: true, detail: JSON.parse(proc.stdout) };
    } catch {
      return { attempted: true, ok: true, detail: proc.stdout };
    }
  } catch (e) {
    return { attempted: true, ok: false, error: (e as Error).message };
  }
}
