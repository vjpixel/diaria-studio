#!/usr/bin/env tsx
/**
 * scripts/calibrate-viral-score.ts (#8672 item 1) — os sinais "viral"
 * preveem clique melhor que os bônus atuais?
 *
 * Read-only: lê `data/editions/**` + `data/beehiiv-cache/posts` +
 * `data/kit-cache/broadcasts` e escreve SÓ o relatório pedido em `--out`
 * (JSON). Nunca toca `data/`, rubrico, prompt de scorer ou config.
 *
 * ## Amostra
 *
 * Unidade = link de artigo PUBLICADO numa edição: URLs extraídas de
 * `02-reviewed.md` (o texto que foi ao leitor, com a seção de cada link) que
 * casam (URL canônica) com um artigo de `_internal/01-approved.json` — é de
 * lá que vêm título/resumo/data/score/bônus que o scorer viu. Os sinais
 * viral são recalculados RETROATIVAMENTE (`extractViralSignals`) sobre todo
 * o histórico, não só pós-POC: a maior amostra honesta.
 *
 * ## Desfecho: CTR sobre ENTREGUES
 *
 * `cliques únicos do link (Beehiiv + Kit somados) / entregues (Beehiiv
 * `delivered`/`recipients` + Kit `recipients`)`, nunca `click_rate` da
 * Beehiiv (click-to-open). Regressão sobre `log(CTR + 0,5/entregues)`.
 *
 * ## Confusão de posição
 *
 * Posição domina o clique (D1 ≫ Radar). Todo modelo é estimado DENTRO da
 * célula edição × seção (efeito fixo: y e features centrados na média da
 * célula) e ainda controla `log(posição na seção)`. A pergunta respondida é:
 * mantida a mesma edição, a mesma seção e a mesma posição, o artigo com o
 * sinal recebe mais clique? Como o denominador é o mesmo para todos os links
 * de uma edição, o efeito fixo também torna a comparação insensível à
 * escolha entregues × aberturas.
 *
 * ## Validação
 *
 * Holdout cronológico (`--holdout-frac`, padrão 0,3 das edições mais
 * recentes) nunca entra no ajuste. Métrica: concordância par-a-par dentro da
 * célula (fração de pares com CTR diferente que o modelo ordena certo) e R²
 * fora da amostra do y centrado. IC 95% dos coeficientes por bootstrap de
 * edições (`--bootstrap`).
 *
 * Uso:
 *   npx tsx scripts/calibrate-viral-score.ts [--data data] [--out report.json]
 *     [--min-age-days 3] [--holdout-frac 0.3] [--bootstrap 500] [--seed 8672]
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
  computeViralBonus,
  extractViralSignals,
  viralGuard,
  VIRAL_SIGNAL_NAMES,
  type ViralSignals,
} from "./lib/viral-score.ts";

const ROOT = resolve(import.meta.dirname, "..");

/** Envio com menos destinatários que isso é teste/probe, não edição. */
export const MIN_RECIPIENTS = 50;

// ---------------------------------------------------------------------------
// 1. Links publicados (02-reviewed.md)
// ---------------------------------------------------------------------------

export interface PublishedLink {
  url: string;
  section: string;
  /** 1-based, na ordem em que aparece dentro da seção. */
  position: number;
}

/** `**DESTAQUE 2 | 🚀 LANÇAMENTO**` → `destaque`; `**📡 RADAR**` → `radar`. */
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
const HEADLINE_LINK_RE = /^\*\*\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/;

/**
 * Extrai os links-manchete (`**[título](url)**` no início da linha) de uma
 * newsletter final, com a seção corrente. Links de corpo/CTA não entram.
 */
export function parseNewsletterLinks(md: string): PublishedLink[] {
  const out: PublishedLink[] = [];
  let section = "intro";
  const counts = new Map<string, number>();
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const h = line.match(HEADING_RE);
    if (h) {
      section = sectionSlug(h[1]);
      continue;
    }
    const l = line.match(HEADLINE_LINK_RE);
    if (!l) continue;
    // Destaque: só a 1ª manchete de cada bloco "DESTAQUE N" é o destaque.
    const pos = (counts.get(section) ?? 0) + 1;
    counts.set(section, pos);
    out.push({ url: l[1], section, position: pos });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Cliques por edição (Beehiiv + Kit)
// ---------------------------------------------------------------------------

export interface EditionClicks {
  delivered: number;
  clicks: Map<string, number>;
  sends: number;
}

/** AAMMDD (BRT, UTC-3) de um Unix-seconds. */
export function aammddBrt(unixSeconds: number): string {
  const d = new Date((unixSeconds - 3 * 3600) * 1000);
  const y = String(d.getUTCFullYear()).slice(2);
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function deliveredOf(p: UnifiedCachedPost): number {
  const email = (p.stats?.email ?? {}) as { delivered?: number; recipients?: number };
  return Number(email.delivered ?? email.recipients ?? 0);
}

/**
 * Agrupa envios reais (publicado, ≥ `MIN_RECIPIENTS`, com cliques
 * buscados) por AAMMDD e soma entregues + cliques únicos por URL canônica.
 * Envio sem `stats.clicks` (nunca enriquecido) ou com zero clique em todos
 * os links fica de fora — zero-clique inventado enviesaria o CTR pra baixo.
 */
export function groupClicksByEdition(posts: readonly UnifiedCachedPost[]): Map<string, EditionClicks> {
  const out = new Map<string, EditionClicks>();
  for (const p of posts) {
    if (p.status !== "confirmed") continue;
    const ts = editorialDate(p);
    if (ts === undefined) continue;
    const delivered = deliveredOf(p);
    if (delivered < MIN_RECIPIENTS) continue;
    if (!p.stats?.clicks) continue;
    // Envio real com centenas de entregues e ZERO clique em todo link é
    // enriquecimento que falhou (ex.: 260820, 641 entregues, `clicks: []`),
    // não leitor que não clicou — entraria como zero-clique fabricado.
    if (!p.stats.clicks.some((c) => Number(c.email?.unique_clicks ?? 0) > 0)) continue;
    const key = aammddBrt(ts);
    const cur = out.get(key) ?? { delivered: 0, clicks: new Map<string, number>(), sends: 0 };
    cur.delivered += delivered;
    cur.sends += 1;
    for (const c of p.stats.clicks) {
      const u = canonicalize(c.url);
      cur.clicks.set(u, (cur.clicks.get(u) ?? 0) + Number(c.email?.unique_clicks ?? 0));
    }
    out.set(key, cur);
  }
  return out;
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
  /** Bônus que o POC daria (pesos do POC, com as guardas). */
  viral_poc_points: number;
  viral_guard: string | null;
  has_inbox: boolean;
}

export interface EditionInput {
  edition: string;
  reviewedMd: string;
  approved: Record<string, unknown>;
  newsletterBodies: string[] | null;
}

export interface BuildStats {
  links: number;
  unmatched_links: number;
}

export function buildEditionRows(input: EditionInput, clicks: EditionClicks, stats?: BuildStats): DatasetRow[] {
  const idx = indexApproved(input.approved);
  const now = `20${input.edition.slice(0, 2)}-${input.edition.slice(2, 4)}-${input.edition.slice(4, 6)}T00:00:00Z`;
  const ctx = { newsletterBodies: input.newsletterBodies ?? [], now };
  const rows: DatasetRow[] = [];
  const seen = new Set<string>();
  for (const link of parseNewsletterLinks(input.reviewedMd)) {
    const key = canonicalize(link.url);
    if (seen.has(key)) continue; // mesma URL 2x (destaque + lançamento): conta 1x, na 1ª posição
    seen.add(key);
    if (stats) stats.links++;
    const art = idx.get(key);
    if (!art) {
      if (stats) stats.unmatched_links++;
      continue;
    }
    const viralPrev = bonusPoints(art.bonuses_applied, "viral");
    const scoreCurrent = (art.score ?? art.score_base ?? 0) - viralPrev;
    const scoreBase = art.score_base ?? scoreCurrent;
    const bonuses = (art.bonuses_applied ?? []).filter((b) => !b.startsWith("viral:"));
    const viralInput = {
      url: art.url,
      title: art.title,
      summary: art.summary,
      published_at: art.published_at,
      category: art.category,
      verify_verdict: art.verify_verdict,
      negative_impact: art.negative_impact === true,
      from_newsletter: art.flag === "newsletter_extracted",
    };
    const c = clicks.clicks.get(key) ?? 0;
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
      signals: extractViralSignals(viralInput, ctx),
      viral_poc_points: computeViralBonus({ ...viralInput, score_base: scoreCurrent }, ctx).bonus,
      viral_guard: viralGuard({ ...viralInput, score_base: scoreCurrent }),
      has_inbox: input.newsletterBodies !== null,
    });
  }
  return rows;
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

/** OLS com ridge mínimo (estabilidade numérica), via eliminação de Gauss. */
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
  coefficients: Record<string, number>;
  ci95: Record<string, [number, number]>;
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
  const ci95: Record<string, [number, number]> = {};
  names.forEach((n, j) => {
    const s = draws[j].sort((a, b) => a - b);
    ci95[n] = s.length ? [s[Math.floor(0.025 * (s.length - 1))], s[Math.ceil(0.975 * (s.length - 1))]] : [NaN, NaN];
  });
  // Coeficiente reportado = ajuste na amostra INTEIRA (mesma base do IC);
  // o do treino só serve pra predizer o holdout acima.
  const full = demeanWithinCells(all, fns);
  const betaFull = fitOls(full.X, full.y);

  return {
    name: spec.name,
    features: names,
    coefficients: Object.fromEntries(names.map((n, j) => [n, betaFull[j]])),
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
const sig = (k: keyof ViralSignals): FeatureFn => (r) => {
  if (r.viral_guard && r.viral_guard !== "below_min_base") return 0; // guardas de produção zeram o sinal
  const v = r.signals[k];
  return typeof v === "number" ? Math.min(v, 2) : v ? 1 : 0;
};

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
  const viral = VIRAL_SIGNAL_NAMES.map((k) => ({ name: `viral:${k}`, fn: sig(k) }));
  const bonuses = currentBonusFeatures(rows);
  const base = { name: "score_base/10", fn: (r: DatasetRow) => r.score_base / 10 };
  return [
    { name: "C0 posição", features: [pos] },
    { name: "A score atual", features: [pos, cur] },
    { name: "A' bônus atuais decompostos", features: [pos, base, ...bonuses] },
    { name: "V só sinais viral", features: [pos, ...viral] },
    { name: "B score atual + sinais viral", features: [pos, cur, ...viral] },
    { name: "P score atual + bônus do POC", features: [pos, cur, { name: "viral_poc_points/10", fn: (r) => r.viral_poc_points / 10 }] },
  ];
}

// ---------------------------------------------------------------------------
// 6. Orquestração
// ---------------------------------------------------------------------------

export interface CalibrationReport {
  generated_at: string;
  sample: {
    editions: number;
    editions_with_inbox: number;
    rows: number;
    links_parsed: number;
    unmatched_links: number;
    first_edition: string | null;
    last_edition: string | null;
    holdout_editions: string[];
    signal_prevalence: Record<string, number>;
    sections: Record<string, number>;
  };
  models: ModelResult[];
  verdict: { viral_predicts: boolean; reasons: string[] };
}

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
    .filter(([n, [lo]]) => lo > 0 && B.coefficients[n] > 0)
    .map(([n]) => n);
  reasons.push(robust.length ? `sinais com IC95% > 0: ${robust.join(", ")}` : "nenhum sinal viral com IC95% inteiramente > 0");
  if (P && P.holdout_concordance !== null) {
    reasons.push(`bônus do POC (P − A): ${((P.holdout_concordance - A.holdout_concordance) * 100).toFixed(2)} p.p.`);
  }
  return { viral_predicts: gain >= 0.01 && robust.length > 0, reasons };
}

export function runCalibration(rows: readonly DatasetRow[], opts: { holdoutFrac: number; bootstrap: number; seed: number }): Omit<CalibrationReport, "generated_at" | "sample"> & { holdout: string[] } {
  const eds = [...new Set(rows.map((r) => r.edition))].sort();
  const nHold = Math.max(1, Math.round(eds.length * opts.holdoutFrac));
  const holdoutEds = new Set(eds.slice(eds.length - nHold));
  const train = rows.filter((r) => !holdoutEds.has(r.edition));
  const holdout = rows.filter((r) => holdoutEds.has(r.edition));
  const models = buildModelSpecs(train).map((s) => evaluateModel(s, train, holdout, opts.bootstrap, opts.seed));
  return { models, verdict: decide(models), holdout: [...holdoutEds] };
}

function readJson<T>(p: string): T | null {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    process.stderr.write(`[calibrate-viral-score] ⚠ JSON inválido: ${p}\n`);
    return null;
  }
}

export function loadDataset(dataDir: string, minAgeDays: number, today = new Date()): { rows: DatasetRow[]; stats: BuildStats } {
  const posts = [...loadBeehiivCache(join(dataDir, "beehiiv-cache/posts")), ...loadKitCache(join(dataDir, "kit-cache/broadcasts"))];
  const clicksByEd = groupClicksByEdition(posts);
  const cutoff = aammddBrt(Math.floor(today.getTime() / 1000) - minAgeDays * 86400);
  const stats: BuildStats = { links: 0, unmatched_links: 0 };
  const rows: DatasetRow[] = [];
  for (const [ed, dir] of [...enumerateEditionDirs(join(dataDir, "editions")).entries()].sort()) {
    if (ed > cutoff) continue; // CTR ainda imaturo
    const clicks = clicksByEd.get(ed);
    if (!clicks) continue;
    const md = existsSync(join(dir, "02-reviewed.md")) ? readFileSync(join(dir, "02-reviewed.md"), "utf8") : null;
    const approved = readJson<Record<string, unknown>>(join(dir, "_internal/01-approved.json"));
    if (!md || !approved) continue;
    const nl = readJson<{ body?: string }[]>(join(dir, "_internal/captured-newsletters.json"));
    rows.push(
      ...buildEditionRows(
        { edition: ed, reviewedMd: md, approved, newsletterBodies: nl ? nl.map((n) => String(n.body ?? "")) : null },
        clicks,
        stats,
      ),
    );
  }
  return { rows, stats };
}

function main(): void {
  const a = parseArgs(process.argv.slice(2)).values;
  const dataDir = resolve(String(a.data ?? join(ROOT, "data")));
  const minAge = Number(a["min-age-days"] ?? 3);
  const holdoutFrac = Number(a["holdout-frac"] ?? 0.3);
  const bootstrap = Number(a.bootstrap ?? 500);
  const seed = Number(a.seed ?? 8672);
  const { rows, stats } = loadDataset(dataDir, minAge);
  if (!rows.length) {
    console.error("[calibrate-viral-score] nenhuma linha — data/ ausente ou sem edições com cliques");
    process.exit(1);
  }
  const res = runCalibration(rows, { holdoutFrac, bootstrap, seed });
  const eds = [...new Set(rows.map((r) => r.edition))].sort();
  const prevalence: Record<string, number> = {};
  for (const k of VIRAL_SIGNAL_NAMES) prevalence[k] = rows.filter((r) => sig(k)(r) > 0).length;
  prevalence["viral_poc_points>0"] = rows.filter((r) => r.viral_poc_points > 0).length;
  const sections: Record<string, number> = {};
  for (const r of rows) sections[r.section] = (sections[r.section] ?? 0) + 1;
  const report: CalibrationReport = {
    generated_at: new Date().toISOString(),
    sample: {
      editions: eds.length,
      editions_with_inbox: new Set(rows.filter((r) => r.has_inbox).map((r) => r.edition)).size,
      rows: rows.length,
      links_parsed: stats.links,
      unmatched_links: stats.unmatched_links,
      first_edition: eds[0] ?? null,
      last_edition: eds[eds.length - 1] ?? null,
      holdout_editions: res.holdout,
      signal_prevalence: prevalence,
      sections,
    },
    models: res.models,
    verdict: res.verdict,
  };
  const json = JSON.stringify(report, null, 2);
  if (a.out) writeFileSync(String(a.out), json);
  else console.log(json);
}

if (isMainModule(import.meta.url)) main();
