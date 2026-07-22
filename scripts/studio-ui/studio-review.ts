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
 *     próprio conteúdo. #494 (pull do Drive antes de abrir) foi removido em
 *     #3723 — #3636 já tinha aposentado o Drive sync do fluxo diário, então
 *     a pasta da edição não existe mais lá pra puxar.
 *   - Lints reusam as funções PURAS já exportadas por
 *     `lint-newsletter-md.ts` / `lint-social-md.ts` / `validate-lancamentos.ts`
 *     — nenhuma regra é reimplementada aqui, só orquestrada. Fail-soft por
 *     check: uma exceção num check vira `{ ok: false, crashed: true, error }`
 *     em vez de derrubar o batch inteiro (#3559 princípio "erro de lint não
 *     derruba o Studio").
 *   - Preview reusa `extractContent` + `renderHTML({ fullDocument: true })`
 *     do pipeline (mesmo render usado no Stage 4) — zero reimplementação de
 *     template.
 *   - #3635: 4º slug `html-final` → `_internal/newsletter-final.html`, o
 *     HTML que a Etapa 4 pré-renderiza e a Etapa 5 PUBLICA de verdade (não é
 *     só o preview acima, que é derivado do MD). Opt-in, "última milha":
 *     reusa a mesma máquina de read/save/diff/baseline dos outros 3 slugs
 *     (generalizada via `REVIEW_FILES`), mas SEM lints (HTML não-Markdown,
 *     ver `lintHtmlFinal`). Risco explícito: qualquer re-render a
 *     partir do MD (rodar a Etapa 4 de novo) sobrescreve edições manuais
 *     feitas aqui sem aviso automático da pipeline — o guard de divergência
 *     fica do lado do cliente (`revisao.js`), que consulta
 *     `GET .../review/html-final/diff` (mesma rota genérica de diff, já
 *     roteada por `isReviewSlug`) e avisa antes de salvar um dos outros 3
 *     slugs quando o HTML final diverge do baseline (= foi editado
 *     manualmente desde a última vez que a Etapa 4 rodou).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { resolve, dirname, basename, extname } from "node:path";
import { resolveEditionDir } from "../lib/find-current-edition.ts";
import { diffLines, diffIsEmpty, type DiffLine } from "./text-diff.ts";
import { extractContent } from "../lib/newsletter-parse.ts";
import { findOrphanBoxWarnings } from "../lib/newsletter-parse.ts";
import { renderHTML } from "../lib/newsletter-render-html.ts";
import { substituteImagePlaceholders } from "../substitute-image-urls.ts";
// #3663: preview do conteúdo social (03-social.md) — reusa o MESMO
// parser/renderer que a pipeline REAL usa no Stage 4 (§4b step 3 de
// orchestrator-stage-4.md) pra gerar `_internal/social-preview.html`, em vez
// de reimplementar o parsing de `## d1/d2/d3` por plataforma aqui.
import { parsePlatforms, buildSocialHtml, type ImageMap } from "../render-social-html.ts";
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
// #3806 (Opção B spike): mapeamento determinístico campo -> região do MD
// pro título de destaque, editável na visão renderizada.
import { replaceDestaqueTitleInMd } from "../extract-destaques.ts";

// ── Arquivos revisáveis ─────────────────────────────────────────────────

export type ReviewSlug = "categorized" | "reviewed" | "social" | "html-final";

export const REVIEW_FILES: Record<ReviewSlug, string> = {
  categorized: "01-categorized.md",
  reviewed: "02-reviewed.md",
  social: "03-social.md",
  // #3635: última milha — HTML final que a Etapa 4 pré-renderiza e a Etapa 5
  // publica de verdade (não é só preview). Editável diretamente no painel
  // como camada de acabamento OPT-IN, fora do fluxo de lint/Drive/MD — ver
  // nota de design no topo do arquivo.
  "html-final": "_internal/newsletter-final.html",
};

export function isReviewSlug(v: string): v is ReviewSlug {
  return v === "categorized" || v === "reviewed" || v === "social" || v === "html-final";
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
  // basename(filename) — não `filename` cru — pra `html-final` não criar uma
  // subpasta `_internal/` aninhada dentro do baseline dir (`filename` para
  // esse slug é `_internal/newsletter-final.html`, com separador). Sem
  // efeito nos outros 3 slugs (já são basename puro, sem separador).
  // #3829: pro slug `html-final` especificamente, esta MESMA fórmula é
  // recalculada de forma independente em `htmlFinalBaselinePath`
  // (`scripts/substitute-image-urls.ts`) — é lá que a Etapa 4 refresca o
  // baseline logo após (re)escrever `newsletter-final.html`. Mudar o formato
  // do path aqui sem espelhar lá reabre o bug do banner travado.
  const baselinePath = resolve(
    editionDir,
    "_internal",
    "studio-review-baseline",
    `${basename(filename)}.md`,
  );
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

export interface SaveReviewOptions {
  /**
   * mtime (ISO 8601) do arquivo tal como o client o viu quando abriu/carregou
   * o painel (`GET .../review/:slug` → `modifiedAt`, `null` quando o arquivo
   * ainda não existia naquele momento) — usado pra detectar escrita
   * concorrente (#3729: editor salva no Studio no exato momento em que o
   * pipeline reescreveu o mesmo arquivo por baixo — title-picker, Clarice,
   * humanizador). `undefined` (campo omitido) pula a checagem inteiramente —
   * mantém compat com chamadas que não têm noção de baseline temporal (scripts
   * internos, `resetBaseline`, chamadas de teste pré-#3729).
   */
  expectedModifiedAt?: string | null;
  /**
   * `true` = ignora divergência detectada e sobrescreve mesmo assim — usado
   * quando o client já avisou o editor (dialog de conflito) e ele confirmou
   * explicitamente que quer sobrescrever (#3729).
   */
  force?: boolean;
}

export interface SaveReviewResult {
  ok: boolean;
  error?: string;
  filename: string;
  modifiedAt: string | null;
  /**
   * `true` quando o save foi recusado por divergência entre
   * `expectedModifiedAt` e o mtime atual em disco (#3729) — o caller HTTP
   * responde 409 (não 400) nesse caso, pro client distinguir "erro" de
   * "conflito, decida o que fazer".
   */
  conflict?: boolean;
  /** mtime atual em disco no momento da tentativa — só presente quando
   * `conflict` é `true`, pro client decidir entre sobrescrever (force) ou
   * recarregar a versão do disco. */
  currentModifiedAt?: string | null;
}

/** mtime (ISO) do arquivo em disco agora, ou `null` se ele não existe. */
function currentMtimeOf(filePath: string): string | null {
  return existsSync(filePath) ? statSync(filePath).mtime.toISOString() : null;
}

/** Escreve o conteúdo inteiro do editor de volta no arquivo — o Studio é a
 * sessão local ativa do editor (ver nota de design no topo do arquivo).
 *
 * #3729 (warn-before-save): quando `opts.expectedModifiedAt` é fornecido (não
 * `undefined`) e `opts.force` não é `true`, compara contra o mtime ATUAL em
 * disco antes de escrever. Divergência (ex: pipeline reescreveu o arquivo
 * depois que o editor abriu o painel) aborta o write e retorna
 * `{ conflict: true }` em vez de sobrescrever silenciosamente — mesmo padrão
 * de reference do guard de divergência client-side já usado pro slug
 * `html-final` desde #3635, mas aqui detectando divergência do PRÓPRIO
 * arquivo sendo salvo, não de um arquivo derivado. Escopo explícito: protege
 * o save do EDITOR de sobrescrever uma escrita do PIPELINE — não o inverso
 * (ver CLAUDE.md, risco residual documentado). */
export function saveReviewFile(
  rootDir: string,
  aammdd: string,
  slug: string,
  content: string,
  opts: SaveReviewOptions = {},
): SaveReviewResult {
  const resolved = resolveReviewFile(rootDir, aammdd, slug);
  if (!resolved) return { ok: false, error: "AAMMDD ou arquivo inválido", filename: "", modifiedAt: null };
  if (!existsSync(resolved.editionDir)) {
    return { ok: false, error: `edição não encontrada: ${aammdd}`, filename: resolved.filename, modifiedAt: null };
  }
  if (!opts.force && opts.expectedModifiedAt !== undefined) {
    const currentModifiedAt = currentMtimeOf(resolved.filePath);
    if (currentModifiedAt !== opts.expectedModifiedAt) {
      return {
        ok: false,
        error: "o arquivo foi modificado desde que você abriu o painel — recarregue ou sobrescreva explicitamente",
        filename: resolved.filename,
        modifiedAt: currentModifiedAt,
        conflict: true,
        currentModifiedAt,
      };
    }
  }
  try {
    // mkdir recursivo do dirname — no-op pros 3 slugs de raiz (dirname já é
    // editionDir, sempre existente), mas necessário pro slug `html-final`
    // (dirname = editionDir/_internal, que pode não existir se o editor
    // salvar antes de qualquer stage ter rodado, ex: edição recém-criada).
    mkdirSync(dirname(resolved.filePath), { recursive: true });
    writeFileSync(resolved.filePath, content, "utf8");
    const modifiedAt = statSync(resolved.filePath).mtime.toISOString();
    return { ok: true, filename: resolved.filename, modifiedAt };
  } catch (e) {
    return { ok: false, error: (e as Error).message, filename: resolved.filename, modifiedAt: null };
  }
}

// ── Edição visual de campo (#3806, Opção B — spike título de destaque) ────

export interface ApplyDestaqueTitleEditResult extends SaveReviewResult {
  /** Lint do conteúdo NOVO (pós-edição), rodado com o mesmo `runReviewLints`
   * de sempre — ausente quando o save falhou/teve conflito (nada foi escrito,
   * lint sobre um conteúdo descartado não ajudaria o caller). */
  lint?: LintReport;
}

/**
 * Aplica a edição visual do título do destaque `n` em `02-reviewed.md`: lê o
 * conteúdo atual, reescreve SÓ a região do título via
 * `replaceDestaqueTitleInMd` (preserva o resto do arquivo), roda os lints de
 * sempre sobre o resultado, e salva via `saveReviewFile` — reusando o MESMO
 * guard de conflito mtime (`expectedModifiedAt`/`force`, #3729) sem
 * duplicá-lo: se o conteúdo lido aqui já estiver obsoleto (o painel salvou
 * uma versão mais nova entre o GET que o client fez e este PUT), a MESMA
 * checagem de `saveReviewFile` recusa o write antes de qualquer coisa chegar
 * no disco — não precisa de uma checagem extra "antes de ler" (ver PR body
 * do #3806 pra rationale).
 *
 * Só o slug `reviewed` é suportado (a única região mapeada nesta 1ª fatia,
 * ver escopo do #3806) — chamado sempre com esse slug fixo pelo caller HTTP.
 */
export function applyDestaqueTitleEdit(
  rootDir: string,
  aammdd: string,
  n: 1 | 2 | 3,
  newTitle: string,
  opts: SaveReviewOptions = {},
): ApplyDestaqueTitleEditResult {
  const resolved = resolveReviewFile(rootDir, aammdd, "reviewed");
  if (!resolved) return { ok: false, error: "AAMMDD inválido", filename: "", modifiedAt: null };
  if (!existsSync(resolved.filePath)) {
    return {
      ok: false,
      error: "02-reviewed.md ainda não existe nesta edição",
      filename: resolved.filename,
      modifiedAt: null,
    };
  }
  const current = readFileSync(resolved.filePath, "utf8");
  const replaced = replaceDestaqueTitleInMd(current, n, newTitle);
  if (!replaced.ok || replaced.md === undefined) {
    return {
      ok: false,
      error: replaced.error ?? "falha ao aplicar edição de título",
      filename: resolved.filename,
      modifiedAt: null,
    };
  }
  const saveResult = saveReviewFile(rootDir, aammdd, "reviewed", replaced.md, opts);
  if (!saveResult.ok) return saveResult;
  return { ...saveResult, lint: runReviewLints(rootDir, resolved.editionDir, "reviewed", replaced.md) };
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
  /** Nota exibida no lugar da lista de checks quando não há nenhum aplicável
   * por design (não por falta de pré-requisito) — ex: `html-final` (#3635).
   * Mesmo campo que `handleReviewLint` (server.ts) já sintetiza ad-hoc pro
   * caso "arquivo ainda não existe". */
  note?: string;
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
    runCheck("linkedin-schema", "Post principal por destaque no LinkedIn (#595, #3627)", true, () => lintLinkedinSchema(md)),
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

/** #3635: `html-final` não tem lints — é edição de última milha do HTML já
 * pré-renderizado, deliberadamente FORA do fluxo de lint/Drive/MD (ver nota
 * de design no topo do arquivo). `note` deixa isso explícito na UI em vez de
 * simplesmente não mostrar nada (ambíguo — pareceria um bug/lista vazia). */
function lintHtmlFinal(): LintReport {
  return {
    ok: true,
    checks: [],
    skipped: [],
    note:
      "newsletter-final.html é edição de última milha — NÃO passa pelos lints de " +
      "Markdown (títulos, formato de seções, etc). Sem rede de segurança automática " +
      "aqui: revise visualmente (aba Preview/HTML renderizado) antes de publicar.",
  };
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
  if (slug === "html-final") return lintHtmlFinal();
  return lintSocial(content);
}

// ── Preview do e-mail ───────────────────────────────────────────────────

export interface PreviewResult {
  ok: boolean;
  html: string;
  error?: string;
}

/** Extensões de imagem servidas pelo preview local — mesmo conjunto que a
 * pipeline gera pros destaques/É IA (`.jpg`/`.jpeg`/`.png`). */
const REVIEW_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

/** Nomes de arquivo de imagem presentes DIRETO em `editionDir` (não recursivo
 * — os arquivos de imagem da edição sempre ficam na raiz do diretório, nunca
 * em `_internal/`). Usado tanto pra montar o mapa de substituição do preview
 * quanto (via `resolveReviewImagePath`) pra validar que uma requisição de
 * imagem só serve arquivo que genuinamente pertence à edição. */
function listReviewImageFilenames(editionDir: string): string[] {
  if (!existsSync(editionDir)) return [];
  return readdirSync(editionDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && REVIEW_IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name);
}

/** Resolve o path absoluto de uma imagem da edição, validando que `filename`
 * (vindo de request HTTP) é exatamente um arquivo de imagem presente na raiz
 * de `editionDir` — nunca um path (basename-only, sem `..`/separador), nunca
 * uma extensão fora da allowlist. Retorna `null` se inválido/inexistente
 * (caller responde 404, nunca serve fora do diretório da edição). */
export function resolveReviewImagePath(editionDir: string, filename: string): string | null {
  const safeName = basename(filename);
  if (safeName !== filename) return null; // continha separador de path
  if (!REVIEW_IMAGE_EXTENSIONS.has(extname(safeName).toLowerCase())) return null;
  const fullPath = resolve(editionDir, safeName);
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) return null;
  return fullPath;
}

/** Renderiza o HTML completo do e-mail a partir do `02-reviewed.md` (+
 * `01-eia.md`) ATUALMENTE em disco — reusa `extractContent`/`renderHTML` do
 * pipeline (mesmo caminho do Stage 4). Fail-soft: qualquer exceção de parse
 * (ex: menos de 2 destaques, seção ausente) vira uma página de erro simples
 * em vez de derrubar a rota.
 *
 * `renderHTML` produz `<img src="{{IMG:filename}}">` — placeholders que a
 * pipeline REAL só resolve depois de subir as imagens publicamente
 * (`upload-images-public.ts` + `substitute-image-urls.ts`, fluxo Custom HTML
 * do Beehiiv). Pra um preview LOCAL no Studio isso é cedo demais (a edição
 * pode nem estar pronta pra publicar ainda) — em vez de subir nada, aponta
 * cada placeholder pra uma rota local (`GET /api/editions/:aammdd/image/:filename`,
 * ver `resolveReviewImagePath`) que serve o arquivo já gerado em disco pela
 * Etapa 3. `aammdd` é necessário só pra montar essa URL — se omitido
 * (chamada fora do contexto de rota HTTP), os placeholders ficam intactos
 * (mesmo comportamento de antes, sem imagem — não quebra, só sem preview
 * visual de imagem). */
export function buildReviewPreviewHtml(editionDir: string, aammdd?: string): PreviewResult {
  if (!existsSync(resolve(editionDir, "02-reviewed.md"))) {
    return {
      ok: false,
      error: "02-reviewed.md ainda não existe nesta edição — nada pra pré-visualizar.",
      html: errorHtml("Sem preview", "02-reviewed.md ainda não existe nesta edição."),
    };
  }
  try {
    const content = extractContent(editionDir);
    let html = renderHTML(content, { fullDocument: true });
    if (aammdd) {
      const filenameMap = new Map<string, string>();
      for (const filename of listReviewImageFilenames(editionDir)) {
        filenameMap.set(filename, `/api/editions/${aammdd}/image/${filename}`);
      }
      html = substituteImagePlaceholders(html, filenameMap).html;
    }
    return { ok: true, html };
  } catch (e) {
    const message = (e as Error).message;
    return { ok: false, error: message, html: errorHtml("Erro ao renderizar preview", message) };
  }
}

/**
 * #3663: mapa de imagens LOCAL pro preview social — análogo em espírito ao
 * `filenameMap` de `buildReviewPreviewHtml` acima, mas resolvendo pras chaves
 * `d1`/`d2`/`d3` que `buildSocialHtml` (render-social-html.ts) espera em vez
 * de um placeholder `{{IMG:filename}}`.
 *
 * A pipeline REAL (`upload-images-public.ts`, rodado só na Etapa 4/5) sobe a
 * variante `04-d{N}-1x1.jpg` (quadrada, 800×800/1024×1024 — o mesmo crop que
 * LinkedIn/Facebook/Instagram usam de verdade) pra Drive/Cloudflare e grava
 * a URL pública em `06-public-images.json`, que é o que `render-social-html.ts
 * --images` consome no fluxo real. Esse upload é cedo demais pra um preview
 * local no Studio (a edição pode nem estar pronta pra publicar ainda) — em
 * vez disso, aponta direto pro arquivo `04-d{N}-1x1.jpg` já gerado em disco
 * pela Etapa 3, servido pela MESMA rota local de imagem que o preview de
 * e-mail já usa (`GET /api/editions/:aammdd/image/:filename`,
 * `resolveReviewImagePath`). Sem 1x1 em disco (edição antiga ou Etapa 3
 * ainda não rodou), cai pra `04-d{N}-2x1.jpg` como fallback — melhor mostrar
 * a imagem larga do que nenhuma. Destaque sem nenhum arquivo correspondente
 * simplesmente fica sem entry no mapa (`buildSocialHtml` já trata ausência
 * de imagem sem quebrar — mesmo fail-open do preview de e-mail).
 */
function buildLocalSocialImageMap(editionDir: string, aammdd: string): ImageMap {
  const filenames = listReviewImageFilenames(editionDir);
  const map: ImageMap = {};
  for (let n = 1; n <= 3; n++) {
    const key = `d${n}`;
    const squareRe = new RegExp(`^04-d${n}-1x1\\.(jpe?g|png)$`, "i");
    const wideRe = new RegExp(`^04-d${n}-2x1\\.(jpe?g|png)$`, "i");
    const filename = filenames.find((f) => squareRe.test(f)) ?? filenames.find((f) => wideRe.test(f));
    if (filename) {
      map[key] = { url: `/api/editions/${aammdd}/image/${filename}`, filename };
    }
  }
  return map;
}

/** Lê o marker opcional de override do destaque coberto pelo `## post_pixel`
 * (default D1, #1690/#2549) — mesmo arquivo que `render-social-html.ts`
 * (CLI) já lê antes de montar o HTML, mas aqui `editionDir` já É a raiz da
 * edição (o CLI reconstrói via `dirname(mdPath)`). */
function readPostPixelImageNum(editionDir: string): string {
  const ppMarker = resolve(editionDir, "_internal", "post-pixel-image.txt");
  if (!existsSync(ppMarker)) return "1";
  const v = readFileSync(ppMarker, "utf8").trim().replace(/\D/g, "");
  return v || "1";
}

/** Renderiza o HTML de preview do conteúdo social (`03-social.md`) —
 * análogo a `buildReviewPreviewHtml` acima, mas pro card LinkedIn/Facebook/
 * Instagram em vez do e-mail. Reusa `parsePlatforms` + `buildSocialHtml` de
 * `render-social-html.ts` (mesmo módulo que a Etapa 4 real invoca via CLI
 * pra gerar `_internal/social-preview.html`, #1800) — zero reimplementação
 * de parsing/template. Fail-soft: `03-social.md` ausente vira página de erro
 * clara (nunca lança); uma seção de plataforma ausente (ex: só LinkedIn, sem
 * Facebook ainda) ou um destaque faltando (edição com 2 destaques em vez de
 * 3, #3369) não quebra — `parsePlatforms`/`buildSocialHtml` já iteram sobre
 * o que existir, sem indexação fixa d1/d2/d3. */
export function buildSocialPreviewHtml(editionDir: string, aammdd?: string): PreviewResult {
  const socialPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialPath)) {
    return {
      ok: false,
      error: "03-social.md ainda não existe nesta edição — nada pra pré-visualizar.",
      html: errorHtml("Sem preview", "03-social.md ainda não existe nesta edição."),
    };
  }
  try {
    const md = readFileSync(socialPath, "utf8");
    const platforms = parsePlatforms(md);
    const imageMap = aammdd ? buildLocalSocialImageMap(editionDir, aammdd) : {};
    const postPixelImageNum = readPostPixelImageNum(editionDir);
    const html = buildSocialHtml(platforms, imageMap, postPixelImageNum);
    return { ok: true, html };
  } catch (e) {
    const message = (e as Error).message;
    return { ok: false, error: message, html: errorHtml("Erro ao renderizar preview social", message) };
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

// #3723: pull do Drive antes de abrir (#494) foi removido — #3636 aposentou
// o Drive sync do fluxo diário (Studio grava direto no arquivo local via
// PUT, não há mais cópia externa no Drive pra puxar). A função
// `pullReviewFileBestEffort` chamava `scripts/drive-sync.ts --mode pull` a
// cada GET e sempre falhava fail-soft (pasta da edição não existe mais lá) —
// puro desperdício de latência, nunca um bug funcional. Ver PR de remoção.
