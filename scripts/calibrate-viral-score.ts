#!/usr/bin/env tsx
/**
 * scripts/calibrate-viral-score.ts (#8672 item 1) — os sinais "viral"
 * preveem clique melhor que os bônus atuais?
 *
 * Resposta (07/10/2026): não — e o bônus foi DESCARTADO por decisão do
 * editor com base nesta calibração (`docs/viral-score-calibration.md`). O
 * script fica como bancada para testar sinais novos (`lib/viral-signals.ts`)
 * contra clique real antes de qualquer proposta de bônus.
 *
 * Read-only: lê `data/editions/**` + `data/beehiiv-cache/posts` +
 * `data/kit-cache/broadcasts` e escreve SÓ o relatório pedido em `--out`
 * (JSON). Nunca toca `data/`, rubrico, prompt de scorer ou config.
 *
 * ## Amostra
 *
 * Unidade = link de artigo PUBLICADO numa edição: manchetes de
 * `02-reviewed.md` (o texto que foi ao leitor, com a seção de cada link) que
 * casam (URL canônica) com um artigo de `_internal/01-approved.json` — é de
 * lá que vêm título/resumo/data/score/bônus que o scorer viu. Os sinais
 * viral são recalculados RETROATIVAMENTE (`extractViralSignals`) sobre todo
 * o histórico, não só pós-POC: a maior amostra honesta.
 *
 * ## Cliques: dado ausente ≠ zero medido
 *
 * As listas de cliques por link da Beehiiv e do Kit trazem TODO link do
 * envio, inclusive os de zero clique (medido em 07/10/2026: 444 entradas
 * zeradas na Beehiiv, 1.702 no Kit). Então link publicado que NÃO aparece na
 * lista é dado faltando (lista incompleta, envio errado), nunca "zero
 * clique": fica fora do ajuste e é contado em `links_without_click_data`.
 * Edição com cobertura (links com dado / links casados) abaixo de
 * `MIN_CLICK_COVERAGE` sai inteira (`editions_skipped.low_click_coverage`).
 *
 * ## Envio → edição
 *
 * Um envio (post Beehiiv ou broadcast Kit) é atribuído a uma edição pelo
 * `edition=AAMMDD` dos links de poll, quando houver, e senão pelo maior
 * overlap entre as URLs da lista de cliques e as manchetes de `02-reviewed.md`
 * (mínimo `MIN_SEND_OVERLAP`) — nunca só pela data. Isso também descarta o
 * cache poluído por fixture (URLs `example0.com…` não casam com edição
 * nenhuma). Com mais de um envio (Beehiiv + Kit), o link só tem dado se
 * aparecer na lista de TODOS os envios atribuídos.
 *
 * ## Desfecho: CTR sobre ENTREGUES
 *
 * `cliques únicos do link (somados nos envios) / entregues (Beehiiv
 * `delivered`/`recipients` + Kit `recipients`)`, nunca `click_rate` da
 * Beehiiv (click-to-open). Regressão sobre `log(CTR + 0,5/entregues)`.
 *
 * ## Confusão de posição
 *
 * Posição domina o clique (D1 ≫ Radar). Todo modelo é estimado DENTRO da
 * célula edição × seção (efeito fixo: y e features centrados na média da
 * célula) e ainda controla `log(posição na seção)`. Como o denominador é o
 * mesmo para todos os links de uma edição, o efeito fixo também torna a
 * comparação insensível à escolha entregues × aberturas.
 *
 * ## Validação
 *
 * Holdout cronológico (`--holdout-frac`, padrão 0,3 das edições mais
 * recentes) nunca entra no ajuste. Métrica: concordância par-a-par dentro da
 * célula e R² fora da amostra do y centrado. IC 95% dos coeficientes por
 * bootstrap de edições (`--bootstrap`).
 *
 * Uso:
 *   npx tsx scripts/calibrate-viral-score.ts [--data data] [--out report.json]
 *     [--min-age-days 3] [--holdout-frac 0.3] [--bootstrap 500] [--seed 8672]
 *     [--min-coverage 0.5] [--absent-is-missing]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { canonicalize } from "./lib/url-utils.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import {
  editorialDate,
  loadBeehiivCache,
  loadKitCache,
  type UnifiedCachedPost,
} from "./lib/shared/edition-cache-reader.ts";
import {
  extractViralSignals,
  viralGuard,
  VIRAL_SIGNAL_NAMES,
  type ViralGuard,
  type ViralSignals,
} from "./lib/viral-signals.ts";

const ROOT = resolve(import.meta.dirname, "..");

/** Envio com menos destinatários que isso é pequeno demais para medir: teste/probe ou variante (ex.: `-patronos`). */
export const MIN_RECIPIENTS = 50;
/** Manchetes da edição que precisam aparecer na lista de cliques de um envio para atribuí-lo por overlap. */
export const MIN_SEND_OVERLAP = 2;
/** Fração mínima de links casados com dado de clique para a edição entrar. */
export const DEFAULT_MIN_CLICK_COVERAGE = 0.5;

/**
 * Pesos e tetos do bônus do POC (#8673, removido do repo em 07/10/2026 quando
 * o editor descartou o bônus), aplicados sobre os sinais CORRIGIDOS desta
 * calibração e com as guardas do item 3 da #8672 — portanto NÃO é o POC
 * exato que rodou na 260922 (aquele não tinha as guardas nem as correções
 * lexicais/de URL). Existe para o modelo "P" medir "o bônus como foi
 * desenhado": atores (pessoa/governo +3, big tech +1), ganchos (dano +4 —
 * não conta em `negative_impact` —, dinheiro +3, política +3; teto +8),
 * cobertura cruzada (+3/menção, teto +6), recência +2, teto total +15 e
 * score ≤ 100. Qualquer guarda (inclusive o piso de 40) zera.
 */
export function pocBonusPoints(s: ViralSignals, opts: { guard: ViralGuard | null; negativeImpact: boolean; scoreCurrent: number }): number {
  if (opts.guard) return 0;
  const actors = (s.people_gov ? 3 : 0) + (s.big_company ? 1 : 0);
  const hooks = Math.min((s.conflict_harm && !opts.negativeImpact ? 4 : 0) + (s.money_scale ? 3 : 0) + (s.policy_geo ? 3 : 0), 8);
  const cross = Math.min(s.newsletter_mentions * 3, 6);
  const total = actors + hooks + cross + (s.recent_36h ? 2 : 0);
  return Math.max(0, Math.min(total, 15, 100 - opts.scoreCurrent));
}

// ---------------------------------------------------------------------------
// 1. Links publicados (02-reviewed.md)
// ---------------------------------------------------------------------------

export interface PublishedLink {
  url: string;
  section: string;
  /** 1-based, na ordem em que aparece dentro da seção. */
  position: number;
}

/** `**DESTAQUE 2 | 🚀 LANÇAMENTO**` vira `destaque`; `**📡 RADAR**` vira `radar`. */
export function sectionSlug(heading: string): string {
  const t = heading.toUpperCase();
  if (t.startsWith("DESTAQUE")) return "destaque";
  return (
    heading
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z ]/g, " ")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_") || "outro"
  );
}

const HEADING_RE = /^\*\*([^[\]*][^*]*)\*\*\s*$/;
/** `**[título](url)**` (formato atual) ou `[**título**](url)` (edições 260513–260529). */
const HEADLINE_LINK_RE = /^(?:\*\*\[[^\]]*\]|\[\*\*[^\]]*\*\*\])\((https?:\/\/[^)\s]+)\)/;

/**
 * Extrai as manchetes (link no início da linha, nos dois formatos acima) de
 * uma newsletter final, com a seção corrente. Links de corpo/CTA não entram;
 * cada bloco "DESTAQUE N" contribui só a 1ª manchete.
 */
export function parseNewsletterLinks(md: string): PublishedLink[] {
  const out: PublishedLink[] = [];
  let section = "intro";
  const counts = new Map<string, number>();
  let destaqueTaken = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const h = line.match(HEADING_RE);
    if (h) {
      section = sectionSlug(h[1]);
      destaqueTaken = false;
      continue;
    }
    const l = line.match(HEADLINE_LINK_RE);
    if (!l) continue;
    if (section === "destaque") {
      if (destaqueTaken) continue;
      destaqueTaken = true;
    }
    const pos = (counts.get(section) ?? 0) + 1;
    counts.set(section, pos);
    out.push({ url: l[1], section, position: pos });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Envios e cliques
// ---------------------------------------------------------------------------

/** AAMMDD (BRT, UTC-3) de um Unix-seconds. */
export function aammddBrt(unixSeconds: number): string {
  const d = new Date((unixSeconds - 3 * 3600) * 1000);
  const y = String(d.getUTCFullYear()).slice(2);
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

export interface Send {
  id: string;
  origin: UnifiedCachedPost["origin"];
  delivered: number;
  /** URL canônica → cliques únicos. Presença = dado medido (inclusive zero). */
  clicks: Map<string, number>;
  /** AAMMDD (BRT) da data editorial — só desempate, nunca a atribuição. */
  date: string | null;
  /** `edition=AAMMDD` dos links de poll, se houver um único. */
  editionHint: string | null;
}

export type SendSkipReason = "not_confirmed" | "small_send" | "no_click_data" | "all_zero_clicks";

function deliveredOf(p: UnifiedCachedPost): number {
  const email = (p.stats?.email ?? {}) as { delivered?: number; recipients?: number };
  return Number(email.delivered ?? email.recipients ?? 0);
}

/** `edition=AAMMDD` nos links do envio (poll do "É IA?"). Mais de um valor distinto = ambíguo = `null`. */
export function editionHintFromUrls(urls: readonly string[]): string | null {
  const found = new Set<string>();
  for (const u of urls) {
    try {
      const v = new URL(u).searchParams.get("edition");
      if (v && /^\d{6}$/.test(v)) found.add(v);
    } catch {
      // URL inválida não carrega hint
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

export function toSend(p: UnifiedCachedPost, id: string): Send | SendSkipReason {
  if (p.status !== "confirmed") return "not_confirmed";
  const delivered = deliveredOf(p);
  if (delivered < MIN_RECIPIENTS) return "small_send";
  const raw = p.stats?.clicks;
  if (!raw) return "no_click_data";
  // Envio com centenas de entregues e ZERO clique em todo link é
  // enriquecimento que falhou (ex.: 260820, 641 entregues, `clicks: []`).
  if (!raw.some((c) => Number(c.email?.unique_clicks ?? 0) > 0)) return "all_zero_clicks";
  const clicks = new Map<string, number>();
  for (const c of raw) {
    const u = canonicalize(c.url);
    clicks.set(u, (clicks.get(u) ?? 0) + Number(c.email?.unique_clicks ?? 0));
  }
  const ts = editorialDate(p);
  return {
    id,
    origin: p.origin,
    delivered,
    clicks,
    date: ts === undefined ? null : aammddBrt(ts),
    editionHint: editionHintFromUrls(raw.map((c) => c.url)),
  };
}

export type AssignMethod = "poll_hint" | "overlap";

export interface Assignment {
  byEdition: Map<string, { send: Send; method: AssignMethod }[]>;
  unassigned: number;
  ambiguous: number;
}

/**
 * Atribui cada envio a UMA edição (ver docstring do módulo). `editionLinks`
 * = URLs canônicas das manchetes de cada edição.
 */
export function assignSends(sends: readonly Send[], editionLinks: ReadonlyMap<string, ReadonlySet<string>>): Assignment {
  const byEdition = new Map<string, { send: Send; method: AssignMethod }[]>();
  let unassigned = 0;
  let ambiguous = 0;
  const push = (ed: string, send: Send, method: AssignMethod) => {
    const g = byEdition.get(ed);
    if (g) g.push({ send, method });
    else byEdition.set(ed, [{ send, method }]);
  };
  const overlap = (s: Send, links: ReadonlySet<string>) => {
    let n = 0;
    for (const u of links) if (s.clicks.has(u)) n++;
    return n;
  };
  for (const s of sends) {
    const hinted = s.editionHint ? editionLinks.get(s.editionHint) : undefined;
    if (s.editionHint && hinted && overlap(s, hinted) >= 1) {
      push(s.editionHint, s, "poll_hint");
      continue;
    }
    let best: string[] = [];
    let bestN = 0;
    for (const [ed, links] of editionLinks) {
      const n = overlap(s, links);
      if (n > bestN) {
        bestN = n;
        best = [ed];
      } else if (n === bestN && n > 0) best.push(ed);
    }
    if (bestN < MIN_SEND_OVERLAP) {
      unassigned++;
      continue;
    }
    if (best.length > 1) {
      const byDate = best.filter((ed) => ed === s.date);
      if (byDate.length !== 1) {
        ambiguous++;
        continue;
      }
      best = byDate;
    }
    push(best[0], s, "overlap");
  }
  return { byEdition, unassigned, ambiguous };
}

export interface EditionClicks {
  delivered: number;
  sends: number;
  /** URL canônica → cliques somados, só para URLs com dado em TODOS os envios da edição. Ausente = sem dado. */
  clicks: Map<string, number>;
}

/**
 * O que significa uma URL publicada AUSENTE da lista de cliques de um envio.
 *
 * Medido em 07/10/2026 sobre o cache real:
 * - **Kit** lista todo link do broadcast, inclusive os de zero clique (1.702
 *   de 2.695 entradas zeradas) — ausente = dado faltando.
 * - **Beehiiv** (`list_post_clicks`) só lista link que teve ALGUM clique: das
 *   444 entradas com `email.unique_clicks = 0`, 443 têm clique WEB (é por isso
 *   que estão na lista) e só 1 é zero em tudo. Ausente = zero clique medido.
 *
 * `strictMissing` trata ausente como faltando também na Beehiiv — é a
 * leitura conservadora pedida no review da PR #9840, rodada como
 * sensibilidade (ela descarta exatamente os links de zero clique, o que
 * trunca o desfecho por baixo).
 */
export function absentIsZero(s: Pick<Send, "origin">, strictMissing: boolean): boolean {
  return !strictMissing && s.origin === "beehiiv";
}

/** Combina os envios de uma edição para as URLs publicadas `links`. */
export function combineSends(sends: readonly Send[], links: Iterable<string>, strictMissing = false): EditionClicks {
  const clicks = new Map<string, number>();
  if (sends.length) {
    for (const u of links) {
      let total = 0;
      let ok = true;
      for (const s of sends) {
        const v = s.clicks.get(u);
        if (v !== undefined) total += v;
        else if (!absentIsZero(s, strictMissing)) {
          ok = false;
          break;
        }
      }
      if (ok) clicks.set(u, total);
    }
  }
  return { delivered: sends.reduce((t, s) => t + s.delivered, 0), sends: sends.length, clicks };
}

// ---------------------------------------------------------------------------
// 3. Linhas do dataset
// ---------------------------------------------------------------------------

export interface ApprovedArticle {
  url: string;
  title?: string;
  summary?: string;
  published_at?: string;
  category?: string;
  verify_verdict?: string;
  negative_impact?: boolean;
  flag?: string;
  score?: number;
  score_base?: number;
  bonuses_applied?: string[];
}

/** Achata `01-approved.json` (todos os buckets; `{article, score}` ou artigo direto) num índice por URL canônica. */
export function indexApproved(approved: Record<string, unknown>): Map<string, ApprovedArticle> {
  const out = new Map<string, ApprovedArticle>();
  for (const v of Object.values(approved)) {
    if (!Array.isArray(v)) continue;
    for (const item of v as Record<string, unknown>[]) {
      const art = ((item.article as Record<string, unknown> | undefined) ?? item) as Record<string, unknown>;
      if (typeof art.url !== "string") continue;
      const key = canonicalize(art.url);
      const prev = out.get(key);
      const merged: ApprovedArticle = {
        ...(prev ?? {}),
        ...(art as unknown as ApprovedArticle),
        score: (art.score as number | undefined) ?? (item.score as number | undefined) ?? prev?.score,
        score_base: (art.score_base as number | undefined) ?? (item.score_base as number | undefined) ?? prev?.score_base,
        bonuses_applied:
          (art.bonuses_applied as string[] | undefined) ?? (item.bonuses_applied as string[] | undefined) ?? prev?.bonuses_applied,
      };
      out.set(key, merged);
    }
  }
  return out;
}

function bonusPoints(bonuses: readonly string[] | undefined, prefix: string): number {
  let t = 0;
  for (const b of bonuses ?? []) if (b.startsWith(`${prefix}:`)) t += Number(b.split(":")[1]) || 0;
  return t;
}

export function bonusPrefixes(bonuses: readonly string[] | undefined): string[] {
  return [...new Set((bonuses ?? []).map((b) => b.split(":")[0]))];
}

export interface DatasetRow {
  edition: string;
  section: string;
  position: number;
  url: string;
  clicks: number;
  delivered: number;
  /** log(CTR sobre entregues + 0,5/entregues). */
  y: number;
  /** Score que o sistema usa hoje (sem o `viral:` do POC). */
  score_current: number;
  score_base: number;
  bonuses: string[];
  signals: ViralSignals;
  /** Pesos do POC sobre os sinais corrigidos, com as guardas (ver `pocBonusPoints`). */
  viral_poc_points: number;
  viral_guard: ViralGuard | null;
  has_inbox: boolean;
}

export interface EditionInput {
  edition: string;
  reviewedMd: string;
  approved: Record<string, unknown>;
  newsletterBodies: string[] | null;
}

export interface BuildCounts {
  links: number;
  unmatched_links: number;
  /** Ocorrências de URL repetida na mesma edição (todas ficam de fora). */
  duplicate_links: number;
  /** Link casado sem entrada na lista de cliques: dado faltando, não zero (fica de fora). */
  links_without_click_data: number;
  /** Artigo casado sem `score` nem `score_base` (fica de fora). */
  rows_missing_score: number;
}

export function emptyCounts(): BuildCounts {
  return { links: 0, unmatched_links: 0, duplicate_links: 0, links_without_click_data: 0, rows_missing_score: 0 };
}

export interface EditionBuild {
  rows: DatasetRow[];
  counts: BuildCounts;
  /** Links com dado de clique / links casados com artigo (sem duplicatas). `null` se nenhum casou. */
  coverage: number | null;
}

export function buildEditionRows(input: EditionInput, clicks: EditionClicks): EditionBuild {
  const counts = emptyCounts();
  const idx = indexApproved(input.approved);
  // Premissa declarada: "agora" da recência = D 00:00 UTC (D-1 21h BRT, perto
  // da hora em que a pesquisa roda). A hora real de cada run não fica gravada
  // de forma uniforme no histórico; o desvio afeta só `recent_36h` na borda.
  const now = `20${input.edition.slice(0, 2)}-${input.edition.slice(2, 4)}-${input.edition.slice(4, 6)}T00:00:00Z`;
  const ctx = { newsletterBodies: input.newsletterBodies ?? [], now };
  const rows: DatasetRow[] = [];
  const links = parseNewsletterLinks(input.reviewedMd);
  const occurrences = new Map<string, number>();
  for (const l of links) {
    const k = canonicalize(l.url);
    occurrences.set(k, (occurrences.get(k) ?? 0) + 1);
  }
  let matched = 0;
  for (const link of links) {
    const key = canonicalize(link.url);
    counts.links++;
    // URL publicada 2x na edição: o clique vem agregado por URL e não dá pra
    // atribuir a uma posição — fica de fora.
    if ((occurrences.get(key) ?? 0) > 1) {
      counts.duplicate_links++;
      continue;
    }
    const art = idx.get(key);
    if (!art) {
      counts.unmatched_links++;
      continue;
    }
    matched++;
    const c = clicks.clicks.get(key);
    if (c === undefined) {
      counts.links_without_click_data++;
      continue;
    }
    if (art.score === undefined && art.score_base === undefined) {
      counts.rows_missing_score++;
      continue;
    }
    const viralPrev = bonusPoints(art.bonuses_applied, "viral");
    const scoreCurrent = (art.score ?? art.score_base!) - viralPrev;
    const scoreBase = art.score_base ?? scoreCurrent;
    const bonuses = (art.bonuses_applied ?? []).filter((b) => !b.startsWith("viral:"));
    const negativeImpact = art.negative_impact === true;
    const signals = extractViralSignals(
      {
        url: art.url,
        title: art.title,
        summary: art.summary,
        published_at: art.published_at,
        from_newsletter: art.flag === "newsletter_extracted",
      },
      ctx,
    );
    const guard = viralGuard({ url: art.url, score_base: scoreBase, category: art.category, verify_verdict: art.verify_verdict });
    rows.push({
      edition: input.edition,
      section: link.section,
      position: link.position,
      url: key,
      clicks: c,
      delivered: clicks.delivered,
      y: Math.log((c + 0.5) / clicks.delivered),
      score_current: scoreCurrent,
      score_base: scoreBase,
      bonuses,
      signals,
      viral_poc_points: pocBonusPoints(signals, { guard, negativeImpact, scoreCurrent }),
      viral_guard: guard,
      has_inbox: input.newsletterBodies !== null,
    });
  }
  return { rows, counts, coverage: matched ? (matched - counts.links_without_click_data) / matched : null };
}

// ---------------------------------------------------------------------------
// 4. Estimação dentro da célula
// ---------------------------------------------------------------------------

export type FeatureFn = (r: DatasetRow) => number;

export function cellKey(r: DatasetRow): string {
  return `${r.edition}|${r.section}`;
}

/** Centra y e cada feature na média da célula. Células com 1 linha não informam nada e saem. */
export function demeanWithinCells(rows: readonly DatasetRow[], features: readonly FeatureFn[]): { X: number[][]; y: number[]; cells: string[] } {
  const groups = new Map<string, DatasetRow[]>();
  for (const r of rows) {
    const k = cellKey(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const X: number[][] = [];
  const y: number[] = [];
  const cells: string[] = [];
  for (const [k, g] of groups) {
    if (g.length < 2) continue;
    const fx = g.map((r) => features.map((f) => f(r)));
    const mx = features.map((_, j) => fx.reduce((t, v) => t + v[j], 0) / g.length);
    const my = g.reduce((t, r) => t + r.y, 0) / g.length;
    g.forEach((r, i) => {
      X.push(fx[i].map((v, j) => v - mx[j]));
      y.push(r.y - my);
      cells.push(k);
    });
  }
  return { X, y, cells };
}

/** Colunas de X (já centradas na célula) sem variância nenhuma — o coeficiente delas não é estimável. */
export function inestimableFeatures(X: readonly number[][], names: readonly string[]): string[] {
  return names.filter((_, j) => !X.some((row) => Math.abs(row[j]) > 1e-12));
}

/**
 * OLS com ridge mínimo (estabilidade numérica), via eliminação de Gauss.
 * Coluna sem pivô sai 0 — use `inestimableFeatures` para distinguir isso de
 * efeito nulo.
 */
export function fitOls(X: readonly number[][], y: readonly number[], ridge = 1e-6): number[] {
  const p = X[0]?.length ?? 0;
  const A = Array.from({ length: p }, () => new Array<number>(p + 1).fill(0));
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < p; a++) {
      A[a][p] += X[i][a] * y[i];
      for (let b = 0; b < p; b++) A[a][b] += X[i][a] * X[i][b];
    }
  }
  for (let a = 0; a < p; a++) A[a][a] += ridge * Math.max(1, X.length);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    const d = A[c][c];
    if (Math.abs(d) < 1e-12) continue;
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      for (let k = c; k <= p; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[p] / row[i]));
}

function dot(a: readonly number[], b: readonly number[]): number {
  let t = 0;
  for (let i = 0; i < a.length; i++) t += a[i] * b[i];
  return t;
}

/**
 * Concordância par-a-par DENTRO da célula: dos pares com y diferente, que
 * fração o preditor ordena certo (empate de predição = 0,5). 0,5 = moeda.
 */
export function withinCellConcordance(y: readonly number[], pred: readonly number[], cells: readonly string[]): { concordance: number | null; pairs: number } {
  const byCell = new Map<string, number[]>();
  cells.forEach((c, i) => {
    const g = byCell.get(c);
    if (g) g.push(i);
    else byCell.set(c, [i]);
  });
  let good = 0;
  let pairs = 0;
  for (const idx of byCell.values()) {
    for (let a = 0; a < idx.length; a++) {
      for (let b = a + 1; b < idx.length; b++) {
        const dy = y[idx[a]] - y[idx[b]];
        if (Math.abs(dy) < 1e-12) continue;
        const dp = pred[idx[a]] - pred[idx[b]];
        pairs++;
        if (Math.abs(dp) < 1e-12) good += 0.5;
        else if (Math.sign(dp) === Math.sign(dy)) good += 1;
      }
    }
  }
  return { concordance: pairs ? good / pairs : null, pairs };
}

export interface ModelSpec {
  name: string;
  features: { name: string; fn: FeatureFn }[];
}

export interface ModelResult {
  name: string;
  features: string[];
  /** Features sem variância dentro da célula na amostra inteira — coeficiente e IC saem `null`. */
  inestimable: string[];
  coefficients: Record<string, number | null>;
  ci95: Record<string, [number, number] | null>;
  holdout_concordance: number | null;
  holdout_pairs: number;
  holdout_r2: number | null;
  train_rows: number;
  holdout_rows: number;
}

function r2(y: readonly number[], pred: readonly number[]): number | null {
  if (!y.length) return null;
  const ss = y.reduce((t, v) => t + v * v, 0);
  if (ss === 0) return null;
  const res = y.reduce((t, v, i) => t + (v - pred[i]) ** 2, 0);
  return 1 - res / ss;
}

/** PRNG determinístico (mulberry32) — bootstrap reprodutível. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function evaluateModel(
  spec: ModelSpec,
  train: readonly DatasetRow[],
  holdout: readonly DatasetRow[],
  bootstrap: number,
  seed: number,
): ModelResult {
  const fns = spec.features.map((f) => f.fn);
  const names = spec.features.map((f) => f.name);
  const tr = demeanWithinCells(train, fns);
  const beta = fitOls(tr.X, tr.y);
  const ho = demeanWithinCells(holdout, fns);
  const pred = ho.X.map((x) => dot(x, beta));
  const conc = withinCellConcordance(ho.y, pred, ho.cells);

  // IC por bootstrap de edições, sobre a amostra INTEIRA (estimativa de
  // incerteza do coeficiente; o holdout acima é que mede poder preditivo).
  const all = [...train, ...holdout];
  const byEd = new Map<string, DatasetRow[]>();
  for (const r of all) {
    const g = byEd.get(r.edition);
    if (g) g.push(r);
    else byEd.set(r.edition, [r]);
  }
  const eds = [...byEd.keys()];
  const rnd = mulberry32(seed);
  const draws: number[][] = names.map(() => []);
  for (let b = 0; b < bootstrap; b++) {
    const sample: DatasetRow[] = [];
    for (let i = 0; i < eds.length; i++) {
      const e = eds[Math.floor(rnd() * eds.length)];
      // Re-rotula a edição pra cada sorteio não fundir células repetidas.
      for (const r of byEd.get(e)!) sample.push({ ...r, edition: `${r.edition}#${i}` });
    }
    const d = demeanWithinCells(sample, fns);
    const bb = fitOls(d.X, d.y);
    bb.forEach((v, j) => draws[j].push(v));
  }
  // Coeficiente reportado = ajuste na amostra INTEIRA (mesma base do IC);
  // o do treino só serve pra predizer o holdout acima.
  const full = demeanWithinCells(all, fns);
  const betaFull = fitOls(full.X, full.y);
  const inestimable = inestimableFeatures(full.X, names);
  if (inestimable.length) {
    process.stderr.write(`[calibrate-viral-score] ⚠ ${spec.name}: sem variância dentro da célula (inestimável): ${inestimable.join(", ")}\n`);
  }
  const coefficients: Record<string, number | null> = {};
  const ci95: Record<string, [number, number] | null> = {};
  names.forEach((n, j) => {
    if (inestimable.includes(n)) {
      coefficients[n] = null;
      ci95[n] = null;
      return;
    }
    coefficients[n] = betaFull[j];
    const s = draws[j].sort((a, b) => a - b);
    ci95[n] = s.length ? [s[Math.floor(0.025 * (s.length - 1))], s[Math.ceil(0.975 * (s.length - 1))]] : null;
  });

  return {
    name: spec.name,
    features: names,
    inestimable,
    coefficients,
    ci95,
    holdout_concordance: conc.concordance,
    holdout_pairs: conc.pairs,
    holdout_r2: r2(ho.y, pred),
    train_rows: tr.y.length,
    holdout_rows: ho.y.length,
  };
}

// ---------------------------------------------------------------------------
// 5. Modelos
// ---------------------------------------------------------------------------

const logPos: FeatureFn = (r) => Math.log(r.position);
const scoreCur: FeatureFn = (r) => r.score_current / 10;

/**
 * Sinal como feature. Guardas de TIPO de link (rede social, paywall/anti_bot,
 * tutorial/vídeo) zeram o sinal — esse link nunca teria bônus. O piso de
 * score (`below_min_base`) NÃO zera: ele existe para o bônus não resgatar
 * artigo fraco, mas o artigo foi publicado e o clique dele mede o sinal do
 * mesmo jeito. `viralGuard` checa o piso por último para que um link
 * guardado por tipo nunca saia rotulado só como `below_min_base`.
 */
export function signalFeature(k: keyof ViralSignals): FeatureFn {
  return (r) => {
    if (r.viral_guard && r.viral_guard !== "below_min_base") return 0;
    const v = r.signals[k];
    return typeof v === "number" ? Math.min(v, 2) : v ? 1 : 0;
  };
}

/** Bônus atuais com suporte mínimo na amostra (≥ `minSupport` linhas). */
export function currentBonusFeatures(rows: readonly DatasetRow[], minSupport = 15): { name: string; fn: FeatureFn }[] {
  const count = new Map<string, number>();
  for (const r of rows) for (const p of bonusPrefixes(r.bonuses)) count.set(p, (count.get(p) ?? 0) + 1);
  return [...count.entries()]
    .filter(([, n]) => n >= minSupport)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p]) => ({ name: `bonus:${p}`, fn: (r: DatasetRow) => (r.bonuses.some((b) => b.startsWith(`${p}:`)) ? 1 : 0) }));
}

export function buildModelSpecs(rows: readonly DatasetRow[]): ModelSpec[] {
  const pos = { name: "log_position", fn: logPos };
  const cur = { name: "score_current/10", fn: scoreCur };
  const viral = VIRAL_SIGNAL_NAMES.map((k) => ({ name: `viral:${k}`, fn: signalFeature(k) }));
  const bonuses = currentBonusFeatures(rows);
  const base = { name: "score_base/10", fn: (r: DatasetRow) => r.score_base / 10 };
  return [
    { name: "C0 posição", features: [pos] },
    { name: "A score atual", features: [pos, cur] },
    { name: "A' bônus atuais decompostos", features: [pos, base, ...bonuses] },
    { name: "V só sinais viral", features: [pos, ...viral] },
    { name: "B score atual + sinais viral", features: [pos, cur, ...viral] },
    { name: "P score atual + pesos do POC", features: [pos, cur, { name: "viral_poc_points/10", fn: (r) => r.viral_poc_points / 10 }] },
  ];
}

// ---------------------------------------------------------------------------
// 6. Orquestração
// ---------------------------------------------------------------------------

/** Ganho mínimo de concordância no holdout (B − A) para "viral prevê". */
export const MIN_CONCORDANCE_GAIN = 0.01;

/** Regra de decisão declarada antes de olhar o resultado (ver doc). */
export function decide(models: readonly ModelResult[]): { viral_predicts: boolean; reasons: string[] } {
  const get = (prefix: string) => models.find((m) => m.name.startsWith(prefix));
  const A = get("A ");
  const B = get("B ");
  const P = get("P ");
  const reasons: string[] = [];
  if (!A || !B || A.holdout_concordance === null || B.holdout_concordance === null) {
    return { viral_predicts: false, reasons: ["holdout sem pares suficientes"] };
  }
  const gain = B.holdout_concordance - A.holdout_concordance;
  reasons.push(`ganho de concordância no holdout (B − A): ${(gain * 100).toFixed(2)} p.p.`);
  const C0 = get("C0");
  if (C0 && C0.holdout_concordance !== null) {
    reasons.push(`B − só posição (C0): ${((B.holdout_concordance - C0.holdout_concordance) * 100).toFixed(2)} p.p.`);
  }
  const robust = Object.entries(B.ci95)
    .filter(([n]) => n.startsWith("viral:"))
    .filter(([n, ci]) => ci !== null && ci[0] > 0 && (B.coefficients[n] ?? 0) > 0)
    .map(([n]) => n);
  reasons.push(robust.length ? `sinais com IC95% > 0: ${robust.join(", ")}` : "nenhum sinal viral com IC95% inteiramente > 0");
  const inest = models.flatMap((m) => m.inestimable.map((f) => `${m.name}: ${f}`));
  if (inest.length) reasons.push(`inestimáveis (sem variância na célula): ${inest.join("; ")}`);
  if (P && P.holdout_concordance !== null) {
    reasons.push(`pesos do POC (P − A): ${((P.holdout_concordance - A.holdout_concordance) * 100).toFixed(2)} p.p.`);
  }
  return { viral_predicts: gain >= MIN_CONCORDANCE_GAIN && robust.length > 0, reasons };
}

export function runCalibration(
  rows: readonly DatasetRow[],
  opts: { holdoutFrac: number; bootstrap: number; seed: number },
): { models: ModelResult[]; verdict: { viral_predicts: boolean; reasons: string[] }; holdout: string[] } {
  const eds = [...new Set(rows.map((r) => r.edition))].sort();
  const nHold = Math.max(1, Math.round(eds.length * opts.holdoutFrac));
  const holdoutEds = new Set(eds.slice(eds.length - nHold));
  const train = rows.filter((r) => !holdoutEds.has(r.edition));
  const holdout = rows.filter((r) => holdoutEds.has(r.edition));
  const models = buildModelSpecs(train).map((s) => evaluateModel(s, train, holdout, opts.bootstrap, opts.seed));
  return { models, verdict: decide(models), holdout: [...holdoutEds] };
}

/**
 * Lê JSON. Erro de LEITURA (permissão, disco) propaga — é falha de ambiente,
 * não dado ruim. JSON inválido devolve `invalid` e a edição é pulada com
 * contagem própria.
 */
export function readJson<T>(p: string): { ok: true; value: T } | { ok: false; reason: "missing" | "invalid" } {
  if (!existsSync(p)) return { ok: false, reason: "missing" };
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch (e) {
    throw new Error(`[calibrate-viral-score] falha de leitura em ${p}: ${e instanceof Error ? e.message : e}`);
  }
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    process.stderr.write(`[calibrate-viral-score] ⚠ JSON inválido: ${p}\n`);
    return { ok: false, reason: "invalid" };
  }
}

export type EditionSkipReason =
  | "too_recent"
  | "no_reviewed_md"
  | "no_approved"
  | "invalid_approved"
  | "no_headlines"
  | "no_send"
  | "low_click_coverage"
  | "no_rows";

export interface LoadedDataset {
  rows: DatasetRow[];
  counts: BuildCounts;
  editions_skipped: Partial<Record<EditionSkipReason, string[]>>;
  sends_skipped: Partial<Record<SendSkipReason, number>>;
  sends_unassigned: number;
  sends_ambiguous: number;
  assign_methods: Record<AssignMethod, number>;
  coverage_by_edition: Record<string, number | null>;
}

export function loadDataset(dataDir: string, opts: { minAgeDays: number; minCoverage: number; strictMissing?: boolean; today?: Date }): LoadedDataset {
  const today = opts.today ?? new Date();
  const posts: [string, UnifiedCachedPost][] = [
    ...loadBeehiivCache(join(dataDir, "beehiiv-cache/posts")).map((p, i): [string, UnifiedCachedPost] => [`beehiiv:${p.slug ?? i}`, p]),
    ...loadKitCache(join(dataDir, "kit-cache/broadcasts")).map((p, i): [string, UnifiedCachedPost] => [`kit:${p.slug ?? i}`, p]),
  ];
  const sends: Send[] = [];
  const sends_skipped: Partial<Record<SendSkipReason, number>> = {};
  for (const [id, p] of posts) {
    const s = toSend(p, id);
    if (typeof s === "string") sends_skipped[s] = (sends_skipped[s] ?? 0) + 1;
    else sends.push(s);
  }

  const cutoff = aammddBrt(Math.floor(today.getTime() / 1000) - opts.minAgeDays * 86400);
  const skipped: Partial<Record<EditionSkipReason, string[]>> = {};
  const skip = (r: EditionSkipReason, ed: string) => (skipped[r] ??= []).push(ed);

  // 1ª passada: edições candidatas e suas manchetes (para atribuir envios).
  const candidates = new Map<string, { md: string; approved: Record<string, unknown>; nl: string[] | null }>();
  const editionLinks = new Map<string, Set<string>>();
  for (const [ed, dir] of [...enumerateEditionDirs(join(dataDir, "editions")).entries()].sort()) {
    if (ed > cutoff) {
      skip("too_recent", ed);
      continue;
    }
    const mdPath = join(dir, "02-reviewed.md");
    if (!existsSync(mdPath)) {
      skip("no_reviewed_md", ed);
      continue;
    }
    const approved = readJson<Record<string, unknown>>(join(dir, "_internal/01-approved.json"));
    if (!approved.ok) {
      skip(approved.reason === "invalid" ? "invalid_approved" : "no_approved", ed);
      continue;
    }
    const md = readFileSync(mdPath, "utf8");
    const links = parseNewsletterLinks(md);
    if (!links.length) {
      skip("no_headlines", ed);
      continue;
    }
    const nl = readJson<{ body?: string }[]>(join(dir, "_internal/captured-newsletters.json"));
    candidates.set(ed, { md, approved: approved.value, nl: nl.ok ? nl.value.map((n) => String(n.body ?? "")) : null });
    editionLinks.set(ed, new Set(links.map((l) => canonicalize(l.url))));
  }

  const assign = assignSends(sends, editionLinks);
  const assign_methods: Record<AssignMethod, number> = { poll_hint: 0, overlap: 0 };
  for (const g of assign.byEdition.values()) for (const a of g) assign_methods[a.method]++;

  const counts = emptyCounts();
  const rows: DatasetRow[] = [];
  const coverage_by_edition: Record<string, number | null> = {};
  for (const [ed, c] of candidates) {
    const assigned = assign.byEdition.get(ed);
    if (!assigned?.length) {
      skip("no_send", ed);
      continue;
    }
    const built = buildEditionRows(
      { edition: ed, reviewedMd: c.md, approved: c.approved, newsletterBodies: c.nl },
      combineSends(assigned.map((a) => a.send), editionLinks.get(ed)!, opts.strictMissing ?? false),
    );
    coverage_by_edition[ed] = built.coverage;
    if (built.coverage === null || built.coverage < opts.minCoverage) {
      skip("low_click_coverage", ed);
      continue;
    }
    for (const k of Object.keys(counts) as (keyof BuildCounts)[]) counts[k] += built.counts[k];
    if (!built.rows.length) {
      skip("no_rows", ed);
      continue;
    }
    rows.push(...built.rows);
  }
  return {
    rows,
    counts,
    editions_skipped: skipped,
    sends_skipped,
    sends_unassigned: assign.unassigned,
    sends_ambiguous: assign.ambiguous,
    assign_methods,
    coverage_by_edition,
  };
}

export interface CliOptions {
  dataDir: string;
  out: string | null;
  minAgeDays: number;
  holdoutFrac: number;
  bootstrap: number;
  seed: number;
  minCoverage: number;
  /** Trata link ausente da lista da Beehiiv como dado faltando (sensibilidade; ver `absentIsZero`). */
  strictMissing: boolean;
}

/** Valida os argumentos — lança com mensagem clara em vez de rodar com NaN. */
export function parseCliOptions(values: Record<string, unknown>, flags: ReadonlySet<string> = new Set()): CliOptions {
  const num = (k: string, def: number): number => {
    const raw = values[k];
    if (raw === undefined) return def;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`--${k} precisa ser um número finito (recebido: ${String(raw)})`);
    return n;
  };
  const minAgeDays = num("min-age-days", 3);
  const holdoutFrac = num("holdout-frac", 0.3);
  const bootstrap = num("bootstrap", 500);
  const seed = num("seed", 8672);
  const minCoverage = num("min-coverage", DEFAULT_MIN_CLICK_COVERAGE);
  if (minAgeDays < 0) throw new Error("--min-age-days não pode ser negativo");
  if (!(holdoutFrac > 0 && holdoutFrac < 1)) throw new Error("--holdout-frac precisa estar em (0, 1)");
  if (!Number.isInteger(bootstrap) || bootstrap < 1) throw new Error("--bootstrap precisa ser inteiro ≥ 1");
  if (!(minCoverage >= 0 && minCoverage <= 1)) throw new Error("--min-coverage precisa estar em [0, 1]");
  return {
    dataDir: resolve(String(values.data ?? join(ROOT, "data"))),
    out: values.out === undefined ? null : String(values.out),
    minAgeDays,
    holdoutFrac,
    bootstrap,
    seed,
    minCoverage,
    strictMissing: flags.has("absent-is-missing"),
  };
}

export function sectionStats(rows: readonly DatasetRow[]): Record<string, { n: number; clicks: number; zero_clicks: number; mean_ctr_pct: number }> {
  const out: Record<string, { n: number; clicks: number; zero_clicks: number; mean_ctr_pct: number }> = {};
  for (const r of rows) {
    const s = (out[r.section] ??= { n: 0, clicks: 0, zero_clicks: 0, mean_ctr_pct: 0 });
    s.n++;
    s.clicks += r.clicks;
    if (r.clicks === 0) s.zero_clicks++;
    s.mean_ctr_pct += (r.clicks / r.delivered) * 100;
  }
  for (const s of Object.values(out)) s.mean_ctr_pct = s.n ? s.mean_ctr_pct / s.n : 0;
  return out;
}

function main(): void {
  let opts: CliOptions;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    opts = parseCliOptions(parsed.values, parsed.flags);
  } catch (e) {
    console.error(`[calibrate-viral-score] ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  const ds = loadDataset(opts.dataDir, { minAgeDays: opts.minAgeDays, minCoverage: opts.minCoverage, strictMissing: opts.strictMissing });
  if (!ds.rows.length) {
    console.error("[calibrate-viral-score] nenhuma linha — data/ ausente ou sem edições com cliques");
    process.exit(1);
  }
  const res = runCalibration(ds.rows, { holdoutFrac: opts.holdoutFrac, bootstrap: opts.bootstrap, seed: opts.seed });
  const eds = [...new Set(ds.rows.map((r) => r.edition))].sort();
  const prevalence: Record<string, number> = {};
  for (const k of VIRAL_SIGNAL_NAMES) prevalence[k] = ds.rows.filter((r) => signalFeature(k)(r) > 0).length;
  prevalence["viral_poc_points>0"] = ds.rows.filter((r) => r.viral_poc_points > 0).length;
  const report = {
    generated_at: new Date().toISOString(),
    options: { ...opts, dataDir: undefined },
    sample: {
      editions: eds.length,
      editions_with_inbox: new Set(ds.rows.filter((r) => r.has_inbox).map((r) => r.edition)).size,
      rows: ds.rows.length,
      /** Linhas em célula com ≥ 2 links — as que de fato informam o ajuste. */
      effective_rows: demeanWithinCells(ds.rows, [logPos]).y.length,
      ...ds.counts,
      clicks_total: ds.rows.reduce((t, r) => t + r.clicks, 0),
      first_edition: eds[0] ?? null,
      last_edition: eds[eds.length - 1] ?? null,
      holdout_editions: res.holdout,
      editions_skipped: ds.editions_skipped,
      sends_skipped: ds.sends_skipped,
      sends_unassigned: ds.sends_unassigned,
      sends_ambiguous: ds.sends_ambiguous,
      assign_methods: ds.assign_methods,
      coverage_by_edition: ds.coverage_by_edition,
      signal_prevalence: prevalence,
      section_stats: sectionStats(ds.rows),
    },
    models: res.models,
    verdict: res.verdict,
  };
  const json = JSON.stringify(report, null, 2);
  if (opts.out) writeFileSync(opts.out, json);
  else console.log(json);
}

if (isMainModule(import.meta.url)) main();
