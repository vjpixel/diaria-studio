/**
 * Invariants de Stage 1 — Pesquisa (#1007 Fase 1).
 *
 * Checks rodados em 2 momentos distintos do Stage 1:
 *
 * 1. **Pré-gate** (ainda só `01-categorized.md` existe): apenas
 *    `categorized-has-eia-section` faz sentido aqui.
 *
 * 2. **Pós-gate apply** (após `apply-gate-edits.ts` escrever
 *    `_internal/01-approved.json`): `approved-has-3-highlights` +
 *    `coverage-line-present`.
 *
 * O orchestrator chama `--stage 1` no momento (2). Pré-gate é coberto
 * por `--stage 1 --rule categorized-has-eia-section` se quiser ser
 * explícito, ou simplesmente os checks pós-gate apply assumem que a
 * gate UI mostrou erros pré-aprovação.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { InvariantRule, InvariantViolation } from "./types.ts";
import { canonicalize } from "../url-utils.ts"; // #10988
import { collectUnresolvedTitleUrls, isPlaceholderHighlightItemWithReserve } from "../placeholder-title-guard.ts"; // #4102, #10908, #10929
// #6440: backstop — mesma verificação POSITIVA de produto (#1968) usada no
// gate do Stage 2 (`validate-lancamentos.ts --approved`), rodada aqui como
// invariante do Stage 1 (bloqueia ANTES do gate). `categorize.ts` já ganhou
// heurísticas mais específicas pro caso concreto do #6440 (programa/piloto
// sem sinal de produto), mas esta é defesa-em-profundidade: qualquer item
// `not_a_tool` que escape a essas heurísticas ainda é pego aqui, antes de
// o editor sequer ver o gate — não só no Stage 2, onde o achado original
// (edição 260828) só apareceu no gate do Stage 4, tarde demais pra evitar
// a edição manual do JSON.
import {
  validateLancamentosFromApproved,
  loadToolAllowlist,
} from "../../validate-lancamentos.ts";

// scripts/lib/invariant-checks/stage-1.ts -> scripts/lib/invariant-checks
// -> scripts/lib -> scripts -> ROOT do repo (3 níveis acima).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface HighlightLike {
  bucket?: string;
  url?: string;
  title?: string;
  article?: { url?: string; title?: string; category?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface ApprovedJson {
  highlights?: HighlightLike[];
  runners_up?: HighlightLike[];
  // #6440: lancamento[]/radar[] tipados como HighlightLike[] (não unknown[])
  // pra bater com `ApprovedShape` de `validate-lancamentos.ts` (mesmo shape
  // {url?, title?, [k: string]: unknown} — checkLancamentoHasProductSignal
  // passa `data` direto pra `validateLancamentosFromApproved`).
  lancamento?: HighlightLike[];
  radar?: HighlightLike[];
  pesquisa?: unknown[];
  noticias?: unknown[];
  coverage?: { line?: string };
  // #6440: index signature pra bater com `ApprovedShape` de
  // validate-lancamentos.ts (permissivo — mesmo objeto JSON, campos extras
  // não usados pelos outros checks deste arquivo).
  [key: string]: unknown;
}

/**
 * Stage 2 espera 2 ou 3 highlights. Editor pode ter aprovado com 1 ou 4+
 * (corrupção do gate UX). Falha cedo para fora do range {2,3}.
 * #2343: 2-destaque é suportado; range válido é [2,3].
 */
function checkApprovedHas3Highlights(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "01-approved.json");
  if (!existsSync(path)) {
    return [
      {
        rule: "approved-exists",
        message: `_internal/01-approved.json ausente — gate Stage 1 não foi aprovado. Rode \`/diaria-1-pesquisa {AAMMDD}\` antes.`,
        source_issue: "#583",
        severity: "error",
        file: path,
      },
    ];
  }
  let data: ApprovedJson;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as ApprovedJson;
  } catch (e) {
    return [
      {
        rule: "approved-parseable",
        message: `_internal/01-approved.json não parseável: ${(e as Error).message}`,
        source_issue: "#583",
        severity: "error",
        file: path,
      },
    ];
  }
  const highlights = Array.isArray(data.highlights) ? data.highlights : [];
  // #2343: 2-destaque é suportado — range válido {2,3}. <2 ou >3 é erro.
  if (highlights.length < 2 || highlights.length > 3) {
    return [
      {
        rule: "approved-has-3-highlights",
        message:
          `_internal/01-approved.json tem ${highlights.length} highlight(s) — ` +
          `Stage 2 aceita 2 ou 3 (D1+D2 ou D1+D2+D3). Fora desse range indica corrupção do gate.`,
        source_issue: "#2343",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * `01-categorized.md` deve incluir seção "## É IA?" — Stage 2 writer lê esse
 * markdown pra extrair linha de crédito. Sem ela, writer omite É IA? do draft.
 */
function checkCategorizedHasEiaSection(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "01-categorized.md");
  if (!existsSync(path)) {
    return [
      {
        rule: "categorized-md-exists",
        message: `01-categorized.md ausente`,
        source_issue: "#481",
        severity: "error",
        file: path,
      },
    ];
  }
  const md = readFileSync(path, "utf8");
  // #1260: aceitar header strict (`## É IA?`) ou placeholder com sufixo (`## É IA? ⏳ (...)`).
  // Placeholder é inserido por render-categorized-md.ts quando 01-eia.md não existe ainda.
  if (!/^## É IA\?(\s|$)/m.test(md)) {
    return [
      {
        rule: "categorized-has-eia-section",
        message:
          `01-categorized.md sem "## É IA?" — render-categorized-md.ts não inseriu o bloco. ` +
          `Stage 2 writer não vai conseguir extrair linha de crédito.`,
        source_issue: "#481",
        severity: "error",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * Coverage line ("Para esta edição...") deve estar presente em `01-approved.json`.
 * Writer Stage 2 usa essa string como primeira linha do draft.
 */
function checkCoverageLinePresent(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "01-approved.json");
  if (!existsSync(path)) return []; // covered by approved-has-3-highlights
  let data: ApprovedJson;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!data.coverage?.line || data.coverage.line.trim().length === 0) {
    return [
      {
        rule: "coverage-line-present",
        message:
          `_internal/01-approved.json sem coverage.line — writer vai usar fallback "???". ` +
          `Verificar se apply-gate-edits.ts rodou após o gate humano.`,
        source_issue: "#592",
        severity: "warning",
        file: path,
      },
    ];
  }
  return [];
}

/**
 * #3436: destaques NUNCA devem vir do bucket USE MELHOR — a seção já tem
 * visibilidade garantida própria (mínimo 2 itens renderizados, #1855), então
 * promover um tutorial a destaque também é redundante e desperdiça um slot
 * editorial nobre (imagem gerada, post social próprio) que deveria ir para
 * uma notícia real de LANÇAMENTOS ou RADAR.
 *
 * Caso real: edição 260714 selecionou "Como o Copilot acha inconsistências
 * no Excel" (tutorial, `discovery: tutorial passo a passo como usar IA para`)
 * como D2.
 *
 * Backstop determinístico — a primeira linha de defesa é a instrução no
 * prompt do `scorer-select` (nunca escolher destaque de `use_melhor`); este
 * guard pega o caso de o agent ignorar a instrução, ou de o `bucket` chegar
 * corrompido por outro caminho.
 *
 * O campo `bucket` de um highlight tem 2 shapes possíveis dependendo de QUAL
 * passo do pipeline o escreveu por último:
 *   - `scorer-select`/`assemble-scored.ts` grava o bucket de SEÇÃO
 *     (`lancamento`/`radar`/`use_melhor`/`video`) — ver scorer-select.md.
 *   - `apply-gate-edits.ts` (pós-gate humano OU `--auto`) RE-ESCREVE `bucket`
 *     com a CATEGORY do artigo original (`article.category`, ex: `"tutorial"`
 *     para um item que veio do bucket use_melhor — ver `buildHighlight()` /
 *     `findArticle()` em apply-gate-edits.ts). Por isso `01-approved.json`
 *     final tipicamente tem `bucket: "tutorial"`, não `bucket: "use_melhor"`,
 *     para esse caso.
 * Checa as DUAS formas (top-level `bucket` e `article.category` nested) para
 * cobrir qualquer um dos 2 caminhos sem depender de qual escreveu por último.
 */
const USE_MELHOR_BUCKET_VALUES = new Set(["use_melhor", "tutorial"]);

function isUseMelhorHighlight(h: HighlightLike): boolean {
  if (h.bucket && USE_MELHOR_BUCKET_VALUES.has(h.bucket)) return true;
  if (h.article?.category && USE_MELHOR_BUCKET_VALUES.has(h.article.category)) return true;
  return false;
}

function checkNoUseMelhorHighlights(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "01-approved.json");
  if (!existsSync(path)) return []; // covered by approved-has-3-highlights
  let data: ApprovedJson;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as ApprovedJson;
  } catch {
    return []; // covered by approved-parseable
  }
  const highlights = Array.isArray(data.highlights) ? data.highlights : [];
  const offenders = highlights.filter(isUseMelhorHighlight);
  if (offenders.length === 0) return [];
  const titles = offenders
    .map((h) => h.title ?? h.article?.title ?? h.url ?? h.article?.url ?? "(sem título)")
    .join("; ");
  return [
    {
      rule: "no-use-melhor-highlights",
      message:
        `${offenders.length} destaque(s) do bucket USE MELHOR em highlights[] — ` +
        `destaques nunca devem vir de tutorial/use_melhor (#3436): ${titles}. ` +
        `Remover do Destaques (a seção USE MELHOR já garante visibilidade própria) e ` +
        `promover o próximo candidato de LANÇAMENTOS/RADAR.`,
      source_issue: "#3436",
      severity: "error",
      file: path,
    },
  ];
}

/**
 * #3916/#3918: toda edição deve ter, entre os destaques aprovados, ao menos 1
 * artigo tagueado `negative_impact: true` (impacto NEGATIVO real da IA — ver
 * critério completo em `context/editorial-rules.md` — Destaques). O
 * `scorer-select` já tenta promover do pool de finalistas quando os top-6 por
 * mérito não incluem nenhum tagueado (ver `scorer-select.md` §3) — este check
 * é o backstop determinístico (#573): se mesmo assim nenhum destaque final tem
 * a tag (pool do dia genuinamente sem candidato digno, OU falha silenciosa na
 * promoção), o editor precisa VER isso antes de aprovar.
 *
 * **Severity "warning" — NUNCA hard-block** (decisão de design #3918: dia sem
 * candidato digno no pool é caso legítimo; a convenção do repo é sempre
 * visível + decisão humana na exceção, nunca silencioso e nunca bloqueio
 * duro). Roda pós-gate-apply no Stage 1 (visibilidade cedo) e de novo no
 * gate consolidado do Stage 4 (`orchestrator-stage-4.md` §4b passo 5) — mesma
 * função, registrada nos dois stages.
 */
function isNegativeImpactHighlight(h: HighlightLike): boolean {
  if (h.negative_impact === true) return true;
  if (h.article?.negative_impact === true) return true;
  return false;
}

/**
 * #10988: marcas de rebaixamento DELIBERADO — item que um passo do Stage 1
 * tirou do top-3 de propósito (mesmo fato #9100, política de negativo #10795,
 * penalidade de estudo genérico #9462). Score alto nele não é falha de mérito.
 */
const DELIBERATE_DEMOTION_FLAGS = ["same_fact_demoted", "negative_promotion_excluded", "generic_study_demoted"] as const;

function isDeliberatelyDemoted(h: HighlightLike): boolean {
  return DELIBERATE_DEMOTION_FLAGS.some((flag) => {
    const v = h[flag] ?? h.article?.[flag];
    return v !== undefined && v !== null && v !== false;
  });
}

/** #10792: aviso pós-seleção; nunca reordena ou muda a seleção do editor. */
export function checkTop3Merit(editionDir: string): InvariantViolation[] {
  const scoredPath = resolve(editionDir, "_internal", "tmp-scored.json");
  const approvedPath = resolve(editionDir, "_internal", "01-approved.json");
  const categorizedPath = resolve(editionDir, "_internal", "01-categorized.json");
  const read = (path: string): ApprovedJson | null => {
    try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  };
  const approved = read(approvedPath);
  const categorized = read(categorizedPath);
  const scored = read(scoredPath);
  // #10988: o trio comparado é o que o editor VÊ. Stage 4 (com
  // `01-approved.json`): o aprovado. Stage 1 (sem approved): o de
  // `01-categorized.json`, já com os rebaixamentos #9100/#10795/#9462 —
  // `tmp-scored` tem a ordem anterior a eles e só serve de fallback. O pool
  // segue incluindo o all_scored do `tmp-scored` (#10792).
  const sources: Array<{ data: ApprovedJson; path: string }> = [];
  if (approved) sources.push({ data: approved, path: approvedPath });
  else if (categorized && Array.isArray(categorized.highlights)) sources.push({ data: categorized, path: categorizedPath });
  if (scored) sources.push({ data: scored, path: scoredPath });
  const primary = sources[0];
  if (!primary || !Array.isArray(primary.data.highlights)) return [];
  const top = primary.data.highlights!.slice(0, 3);
  const score = (h: HighlightLike): number | undefined =>
    typeof h.score === "number" && Number.isFinite(h.score) ? h.score : undefined;
  const url = (h: HighlightLike) => h.article?.url ?? h.url;
  const key = (h: HighlightLike): string => {
    const u = url(h);
    if (!u) return "";
    try { return canonicalize(u); } catch { return u; }
  };
  const scores = top.map(score);
  if (top.length < 2 || scores.some(s => s === undefined)) return [];
  const max = Math.max(...scores as number[]);
  const topKeys = new Set(top.map(key).filter(Boolean));
  const itemsOf = (data: ApprovedJson | null): HighlightLike[] => {
    const out: HighlightLike[] = [];
    if (!data) return out;
    for (const k of ["highlights", "runners_up", "all_scored", "lancamento", "radar"]) {
      const items = data[k];
      if (Array.isArray(items)) out.push(...items);
    }
    return out;
  };
  const pool = sources.flatMap(({ data }) => itemsOf(data));
  // Rebaixado em QUALQUER fonte conta: a marca vive no categorized/approved,
  // a cópia sem marca no all_scored do tmp-scored.
  const demotedKeys = new Set(
    [...pool, ...itemsOf(categorized)].filter(isDeliberatelyDemoted).map(key).filter(Boolean),
  );
  // Stage 4: item que estava no `01-categorized.json` (pré-gate) e não está no
  // aprovado foi removido pelo editor no gate 1 — não é falha de mérito.
  if (approved && categorized) {
    const approvedKeys = new Set(itemsOf(approved).map(key).filter(Boolean));
    for (const h of itemsOf(categorized)) {
      const k = key(h);
      if (k && !approvedKeys.has(k)) demotedKeys.add(k);
    }
  }
  const seen = new Set<string>();
  const offenders = pool.filter(h => {
    const k = key(h);
    const value = score(h);
    if (!k || topKeys.has(k) || demotedKeys.has(k) || seen.has(k) || value === undefined || value < max || h.bucket === "use_melhor" || isPlaceholderTitleHighlight(h)) return false;
    seen.add(k);
    return true;
  });
  if (!offenders.length) return [];
  return [{
    rule: "top3-merit-warning", source_issue: "#10792", severity: "warning",
    file: primary.path,
    message: `Item fora do top-3 com score ≥ maior score do top-3 (${max}): ` +
      offenders.map(h => `${h.article?.title ?? h.title ?? url(h)} (${h.score})`).join("; ") +
      ". Confira seleção por mérito antes da ordem editorial; a decisão continua com o editor.",
  }];
}

function checkHasNegativeImpactHighlight(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "01-approved.json");
  if (!existsSync(path)) return []; // coberto por approved-exists
  let data: ApprovedJson;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as ApprovedJson;
  } catch {
    return []; // coberto por approved-parseable
  }
  const highlights = Array.isArray(data.highlights) ? data.highlights : [];
  if (highlights.length === 0) return []; // coberto por approved-has-3-highlights
  if (highlights.some(isNegativeImpactHighlight)) return [];

  // Sugestão de swap: melhor candidato tagueado disponível no pool de runners_up.
  const runnersUp = Array.isArray(data.runners_up) ? data.runners_up : [];
  const suggestion = runnersUp.find(isNegativeImpactHighlight);
  const suggestionTitle = suggestion
    ? (suggestion.title ?? suggestion.article?.title ?? suggestion.url ?? suggestion.article?.url ?? "(sem título)")
    : null;
  const suggestionText = suggestionTitle
    ? ` Candidato disponível no pool de runners_up: "${suggestionTitle}" — considere trocar por um dos D1-D3.`
    : " Nenhum candidato tagueado disponível no pool de runners_up — publicar sem é aceitável neste caso específico, mas confirme antes de aprovar.";

  return [
    {
      rule: "has-negative-impact-highlight",
      message:
        `Nenhum destaque desta edição está tagueado negative_impact:true — a regra editorial ` +
        `"sempre ≥1 destaque de impacto negativo da IA" (context/editorial-rules.md — Destaques) ` +
        `não foi cumprida.${suggestionText}`,
      source_issue: "#3916",
      severity: "warning",
      file: path,
    },
  ];
}

/**
 * #4102: destaque NUNCA pode ter título placeholder (sintético, nunca
 * enriquecido com o conteúdo real do artigo — ex: "(newsletter:...)" de link
 * extraído de newsletter capturada, "(inbox)" de submissão editorial não
 * resolvida). Backstop determinístico já existe em `assemble-scored.ts`
 * (`applyPlaceholderTitleBackstop`) — este check é a rede de segurança final,
 * cobrindo também o caminho `1q-fallback` (scorer single-call legado, que não
 * gera `tmp-finalists.json` e por isso não passa pelo backstop de
 * assemble-scored.ts).
 *
 * Caso real (edição 260727): item do Y Combinator chegou ao scorer com
 * `title: "(newsletter:\"Lenny's Newsletter\")"` e score 119 (o mais alto do
 * pool) — virou candidato a D1 com título sintético. Recuperado manualmente.
 *
 * **Severity "error" (hard block)** — diferente do `has-negative-impact-highlight`
 * (warning-only): título placeholder chegando ao publicado é sempre um bug de
 * pipeline, nunca um caso legítimo de "sem candidato melhor" — não há
 * trade-off editorial aqui.
 */
function isPlaceholderTitleHighlight(h: HighlightLike, unresolvedUrls: ReadonlySet<string> = new Set()): boolean {
  // #10908: também barra submissão do editor marcada `title_unresolved` pelo
  // categorize (#10796) cujo título ainda é a palavra solta ("Found").
  // #10929: o marcador pode ter sumido do highlight (scorer-select não copiou,
  // caminho 1q-fallback sem o backstop do assemble-scored) — vale também a
  // mesma URL marcada em outro ponto do approved ou no tmp-categorized.json.
  return isPlaceholderHighlightItemWithReserve(h, unresolvedUrls);
}

/** Lê `_internal/tmp-categorized.json` (quem grava `title_unresolved`); ausente/ilegível → `null`. */
function readCategorizedForUnresolved(editionDir: string): unknown {
  const p = resolve(editionDir, "_internal", "tmp-categorized.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function checkNoPlaceholderTitleHighlights(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "01-approved.json");
  if (!existsSync(path)) return []; // covered by approved-exists
  let data: ApprovedJson;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as ApprovedJson;
  } catch {
    return []; // covered by approved-parseable
  }
  const highlights = Array.isArray(data.highlights) ? data.highlights : [];
  const unresolvedUrls = collectUnresolvedTitleUrls(data, readCategorizedForUnresolved(editionDir));
  const offenders = highlights.filter((h) => isPlaceholderTitleHighlight(h, unresolvedUrls));
  if (offenders.length === 0) return [];
  const urls = offenders.map((h) => h.url ?? h.article?.url ?? "(sem url)").join("; ");
  return [
    {
      rule: "no-placeholder-title-highlights",
      message:
        `${offenders.length} destaque(s) com título placeholder (nunca enriquecido) em highlights[] — ` +
        `URLs: ${urls}. Título sintético (ex: "(newsletter:...)", "(inbox)", stub de redirect como "Found") não pode virar D1/D2/D3 (#4102, #10908). ` +
        `Resolver o título via og:title/submitted_subject antes de aprovar, ou trocar por outro candidato do pool.`,
      source_issue: "#4102",
      severity: "error",
      file: path,
    },
  ];
}

/**
 * #5081: destaque sem `article.summary` chega ao writer-destaque sem base de
 * conteúdo — `.claude/agents/writer-destaque.md` proíbe explicitamente
 * inventar fato/comparação além do que está em `destaque.summary`/`title`
 * (#4000), então um summary undefined/vazio é pior que um título placeholder
 * silencioso: o writer ou trava (nada pra escrever) ou preenche com
 * suposição, exatamente o que #4000 já documentou como erro real.
 *
 * Causa suspeita (não confirmada com certeza — ver PR #5081): cache-miss em
 * `enrich-inbox-articles.ts` pra artigo NÃO-inbox (fallback bounded por
 * `NON_INBOX_FALLBACK_FETCH_CAP`, #2545) deixa `summary` ausente e só
 * registra a falha em `outcomes[]`/stdout — nunca gate-blocking. Esta
 * invariante é a rede de segurança determinística independente da causa
 * raiz exata: falha cedo e alto (gate Stage 1) em vez de deixar o campo
 * ausente atravessar silenciosamente até o writer. Caso real: D3
 * (about.fb.com/news/2026/08/the-future-is-for-everyone) chegou ao
 * highlight com `article.summary` undefined, 1ª ocorrência 2026-08-11.
 */
function isMissingSummaryHighlight(h: HighlightLike): boolean {
  const summary = h.article?.summary ?? h.summary;
  return typeof summary !== "string" || summary.trim().length === 0;
}

function checkNoMissingSummaryHighlights(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "01-approved.json");
  if (!existsSync(path)) return []; // covered by approved-exists
  let data: ApprovedJson;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as ApprovedJson;
  } catch {
    return []; // covered by approved-parseable
  }
  const highlights = Array.isArray(data.highlights) ? data.highlights : [];
  const offenders = highlights.filter(isMissingSummaryHighlight);
  if (offenders.length === 0) return [];
  const urls = offenders.map((h) => h.url ?? h.article?.url ?? "(sem url)").join("; ");
  return [
    {
      rule: "no-missing-summary-highlights",
      message:
        `${offenders.length} destaque(s) sem article.summary (undefined/vazio) em highlights[] — ` +
        `URLs: ${urls}. writer-destaque não tem WebFetch e é proibido inventar conteúdo além do ` +
        `summary (#4000) — sem ele não há base pra escrever o destaque. Provável cache-miss silencioso ` +
        `em enrich-inbox-articles.ts (#5081). Resolver o summary (re-rodar enrich, ou preencher manualmente ` +
        `no gate) antes de aprovar, ou trocar por outro candidato do pool.`,
      source_issue: "#5081",
      severity: "error",
      file: path,
    },
  ];
}

/**
 * #4837: `url` (top-level) e `article.url` (nested) de um highlight são duas
 * referências à MESMA URL do artigo — nunca deveriam divergir. Downstream
 * (writer-destaque, publish) sempre lê `article.url`, então quando os dois
 * campos divergem, `url` fica um valor "fantasma" desatualizado que não
 * corresponde ao que de fato foi publicado — contaminando qualquer análise
 * feita sobre `01-approved.json` a partir do campo `url` (caso real: medição
 * de recall do scorer, 8 highlights em 5 edições jul/ago 260702/260723/
 * 260727/260804/260807).
 *
 * A causa raiz exata da escrita que introduziu a divergência histórica NÃO
 * foi confirmada com certeza (diagnóstico por leitura de código, sem acesso
 * a `data/` real — ver PR #4837). `apply-gate-edits.ts`, o único ponto de
 * escrita de `01-approved.json`, foi corrigido para sempre derivar `url` de
 * `article.url` na construção do highlight (`buildHighlight()`) — este guard
 * é a rede de segurança determinística independente da causa raiz, cobrindo
 * qualquer caminho de escrita futuro que reintroduza o padrão.
 *
 * #4865: `runners_up[]` tem o MESMO shape nested (rank/score/bucket/url/
 * article) e a mesma classe de bug pode chegar por um caminho diferente — é
 * copiado (agora normalizado, ver `normalizeRunnerUp()` em
 * `apply-gate-edits.ts`) direto da saída do `scorer-select` (LLM), sem passar
 * por `findArticle()`/canonicalização como `highlights[]`. `swap-destaque.ts`
 * promove itens de `runners_up[]` (e de outros buckets) diretamente pra
 * `highlights[]` — sem essa cobertura, um item divergente em `runners_up[]`
 * reintroduziria o bug do #4837 por um caminho que a invariante original não
 * enxergava (self-review do #4864/#4837).
 */
function isUrlArticleUrlMismatch(h: HighlightLike): boolean {
  const topUrl = h.url;
  const nestedUrl = h.article?.url;
  return typeof topUrl === "string" && typeof nestedUrl === "string" && topUrl !== nestedUrl;
}

function checkUrlMatchesArticleUrl(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "01-approved.json");
  if (!existsSync(path)) return []; // coberto por approved-exists
  let data: ApprovedJson;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as ApprovedJson;
  } catch {
    return []; // coberto por approved-parseable
  }
  const highlights = Array.isArray(data.highlights) ? data.highlights : [];
  const runnersUp = Array.isArray(data.runners_up) ? data.runners_up : [];
  const highlightOffenders = highlights.filter(isUrlArticleUrlMismatch);
  const runnerUpOffenders = runnersUp.filter(isUrlArticleUrlMismatch);
  if (highlightOffenders.length === 0 && runnerUpOffenders.length === 0) return [];
  const details = [
    ...highlightOffenders.map((h) => `highlights[]: "${h.url}" ≠ "${h.article?.url}"`),
    ...runnerUpOffenders.map((h) => `runners_up[]: "${h.url}" ≠ "${h.article?.url}"`),
  ].join("; ");
  return [
    {
      rule: "url-matches-article-url",
      message:
        `${highlightOffenders.length + runnerUpOffenders.length} item(ns) com url !== article.url em ` +
        `highlights[]/runners_up[] — ${details}. As duas referências deveriam sempre apontar pra mesma ` +
        `URL do artigo — article.url é o valor de fato publicado/promovido (writer/publish/swap-destaque ` +
        `leem article, não o url top-level). Sempre bug de pipeline, nunca decisão editorial legítima ` +
        `(#4837, #4865).`,
      source_issue: "#4837",
      severity: "error",
      file: path,
    },
  ];
}

/**
 * #6440: backstop — todo item de `lancamento[]` precisa de sinal POSITIVO de
 * produto (#1968). `categorize.ts` já filtra a maioria antes de chegar aqui,
 * mas essa invariante é a rede de segurança: qualquer item `not_a_tool` que
 * escape as heurísticas de categorização trava o gate do Stage 1 em vez de
 * só aparecer no gate do Stage 4 (achado ao vivo #6440, edição 260828 — dois
 * itens sem link oficial de produto chegaram a LANÇAMENTOS e só foram
 * pegos tarde, com o `url-bucket` (#165) e `validate-lancamentos.ts` (#1968)
 * em contradição no gate final).
 */
function checkLancamentoHasProductSignal(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "01-approved.json");
  if (!existsSync(path)) return []; // coberto por approved-exists
  let data: ApprovedJson;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as ApprovedJson;
  } catch {
    return []; // coberto por approved-parseable
  }
  const allowlist = loadToolAllowlist(REPO_ROOT);
  const summary = validateLancamentosFromApproved(data, allowlist);
  if (summary.not_a_tool.length === 0) return [];
  const details = summary.not_a_tool
    .map((u) => (u.title ? `${u.url} ("${u.title.slice(0, 60)}")` : u.url))
    .join("; ");
  return [
    {
      rule: "lancamento-has-product-signal",
      message:
        `${summary.not_a_tool.length} item(ns) em lancamento[] sem sinal POSITIVO de produto ` +
        `(#1968) — ${details}. Mova para radar/notícias, ou — se for ferramenta legítima de ` +
        `slug atípico — adicione a URL a seed/lancamentos-tool-allowlist.txt.`,
      source_issue: "#6440",
      severity: "error",
      file: path,
    },
  ];
}

export const STAGE_1_RULES: InvariantRule[] = [
  {
    id: "approved-has-3-highlights",
    description: "01-approved.json tem 2 ou 3 highlights (#2343)",
    source_issue: "#2343",
    stage: 1,
    run: checkApprovedHas3Highlights,
  },
  {
    id: "categorized-has-eia-section",
    description: "01-categorized.md inclui seção '## É IA?' (#481)",
    source_issue: "#481",
    stage: 1,
    run: checkCategorizedHasEiaSection,
  },
  {
    id: "coverage-line-present",
    description: "01-approved.json tem coverage.line (#592)",
    source_issue: "#592",
    stage: 1,
    run: checkCoverageLinePresent,
  },
  {
    id: "no-use-melhor-highlights",
    description: "highlights[] nunca contém item do bucket USE MELHOR/tutorial (#3436)",
    source_issue: "#3436",
    stage: 1,
    run: checkNoUseMelhorHighlights,
  },
  {
    id: "top3-merit-warning",
    description: "item fora do top-3 com score ≥ maior do trio (warning-only)",
    source_issue: "#10792", stage: 1, run: checkTop3Merit,
  },
  {
    id: "has-negative-impact-highlight",
    description: "≥1 destaque tagueado negative_impact:true (#3916, #3918, warning-only)",
    source_issue: "#3916",
    stage: 1,
    run: checkHasNegativeImpactHighlight,
  },
  {
    id: "no-placeholder-title-highlights",
    description: "highlights[] nunca contém item com título placeholder não-enriquecido (#4102)",
    source_issue: "#4102",
    stage: 1,
    run: checkNoPlaceholderTitleHighlights,
  },
  {
    id: "url-matches-article-url",
    description: "url === article.url em todo item de highlights[] e runners_up[] (#4837, #4865)",
    source_issue: "#4837",
    stage: 1,
    run: checkUrlMatchesArticleUrl,
  },
  {
    id: "no-missing-summary-highlights",
    description: "highlights[] nunca contém item com article.summary ausente/vazio (#5081)",
    source_issue: "#5081",
    stage: 1,
    run: checkNoMissingSummaryHighlights,
  },
  {
    id: "lancamento-has-product-signal",
    description: "lancamento[] nunca contém item sem sinal POSITIVO de produto (#1968, backstop #6440)",
    source_issue: "#6440",
    stage: 1,
    run: checkLancamentoHasProductSignal,
  },
];

export {
  checkApprovedHas3Highlights,
  checkCategorizedHasEiaSection,
  checkCoverageLinePresent,
  checkNoUseMelhorHighlights,
  isUseMelhorHighlight,
  checkHasNegativeImpactHighlight,
  isNegativeImpactHighlight,
  checkNoPlaceholderTitleHighlights,
  isPlaceholderTitleHighlight,
  checkUrlMatchesArticleUrl,
  isUrlArticleUrlMismatch,
  checkNoMissingSummaryHighlights,
  isMissingSummaryHighlight,
  checkLancamentoHasProductSignal,
};
