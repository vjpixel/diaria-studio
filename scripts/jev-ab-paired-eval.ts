#!/usr/bin/env npx tsx
/**
 * jev-ab-paired-eval.ts (#9531) — CLI da avaliação pareada retroativa do A/B
 * do Jev. Lógica pura e racional completo em `scripts/lib/jev-ab-paired-eval.ts`.
 *
 * Uso:
 *   npx tsx scripts/jev-ab-paired-eval.ts [--since 260901] [--until 261231] \
 *     [--root .] [--out data/jev-eval/ab-paired-9531] [--no-network]
 *
 * Entradas por edição (todas já persistidas em `data/editions/{AAMM}/{AAMMDD}/`):
 *   - `_internal/researcher-results.json` — pool bruto do Stage 1 (proxy do
 *     input do dedup: os `tmp-*` intermediários não sobrevivem à edição);
 *   - `_internal/01-approved.json` das edições anteriores da janela — títulos
 *     passados do Pass 1c (mesma fonte de `extractPastEditionArticleTitles`);
 *   - `_internal/01-approved.json` + `02-reviewed.md` da própria edição — gabarito;
 *   - `_internal/01-categorized.json` — itens que o `annotate-actor-brazil` anota.
 *
 * Chamadas Jev têm cache em disco (`{out}/cache`) — re-rodar não paga de novo;
 * `wall Jev` só é medido quando houve chamada real. `--no-network` usa só o
 * cache (pares sem cache ficam sem veredito → caem na heurística, como em prod).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { readApprovedTitles } from "./lib/past-editions-extract.ts";
import { askJevBatch, type JevChoiceAnswer, type JevNoulAnswer } from "./lib/jev.ts";
import { ACTOR_BRAZIL_8416_ACTOR, ACTOR_BRAZIL_8416_BRAZIL, DEDUP_GRAYZONE_8417 } from "./lib/jev-questions.ts";
import { GRAYZONE_SAME_PROBABILITY, pairKey, type GrayZoneVerdict } from "./lib/dedup-grayzone-jev.ts";
import { detectBrazil, JEV_BRAZIL_THRESHOLD } from "./collect-monthly.ts";
import {
  approvedItems,
  brazilDivergence,
  decide,
  estimateJevTokens,
  evaluateDedupArticle,
  flattenResearcherPool,
  grayZonePairs,
  labelDedupDivergence,
  normalizeUrlForMatch,
  pastWindow,
  renderPairedReport,
  tokensToUsd,
  urlsInMarkdown,
  windowForEdition,
  type DedupDivergence,
  type BrazilDivergence,
  type EditionEval,
} from "./lib/jev-ab-paired-eval.ts";

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function evalEdition(opts: {
  edition: string;
  dirs: Map<string, string>;
  apiKey: string | undefined;
  cacheDir: string;
  noNetwork: boolean;
}): Promise<EditionEval | null> {
  const { edition, dirs } = opts;
  const dir = dirs.get(edition)!;
  const internal = join(dir, "_internal");
  const notes: string[] = [];
  const pool = flattenResearcherPool(readJson(join(internal, "researcher-results.json")));
  const approved = readJson(join(internal, "01-approved.json"));
  if (pool.length === 0 || !approved) return null;

  const profile = readJson(join(internal, ".jev-profile.json")) as { profile?: string } | undefined;
  const arm: "A" | "B" = profile?.profile === "all" ? "B" : "A";

  // Janela de edições passadas que o dedup daquela edição viu.
  const withApproved = [...dirs.keys()].filter((k) => /^\d{6}$/.test(k) && existsSync(join(dirs.get(k)!, "_internal", "01-approved.json")));
  const window = pastWindow(withApproved, edition, windowForEdition(edition));
  const pastTitles = new Set<string>();
  const pastUrls = new Set<string>();
  for (const p of window) {
    const path = join(dirs.get(p)!, "_internal", "01-approved.json");
    for (const t of readApprovedTitles(path)) pastTitles.add(t);
    for (const it of approvedItems(readJson(path))) pastUrls.add(normalizeUrlForMatch(it.url));
  }
  // Pass 1 (URL vs. passado) remove esses antes do Pass 1c — fora da comparação.
  const candidates = pool.filter((a) => !pastUrls.has(normalizeUrlForMatch(a.url)));
  const past = [...pastTitles];

  const editorKept = {
    approved: new Set<string>(approvedItems(approved).map((i) => normalizeUrlForMatch(i.url))),
    published: new Set<string>(),
  };
  const reviewedPath = join(dir, "02-reviewed.md");
  if (existsSync(reviewedPath)) editorKept.published = urlsInMarkdown(readFileSync(reviewedPath, "utf8"));
  else notes.push("sem 02-reviewed.md — gabarito só pelo 01-approved.json");

  let jevCalls = 0;
  let estTokens = 0;
  let wallMs = 0;
  let anyNetwork = false;

  // --- dedup zona cinzenta ---
  const pairs = grayZonePairs(candidates, past);
  const verdicts = new Map<string, GrayZoneVerdict>();
  const dedupItems = pairs.map((p) => ({
    id: pairKey(p.article.title, p.past),
    state: { a: { title: p.article.title, summary: p.article.summary, source: p.article.source }, b: { title: p.past, summary: "", source: "" } },
    questions: [DEDUP_GRAYZONE_8417.question],
    cacheKey: pairKey(p.article.title, p.past),
  }));
  for (const it of dedupItems) estTokens += estimateJevTokens(it.state, it.questions);
  jevCalls += dedupItems.length;
  if (dedupItems.length > 0 && opts.apiKey) {
    const t0 = Date.now();
    try {
      const { results, errors } = await askJevBatch(dedupItems, {
        apiKey: opts.apiKey,
        cacheDir: opts.cacheDir,
        fetchImpl: opts.noNetwork ? (() => Promise.reject(new Error("--no-network"))) as typeof fetch : undefined,
        maxRetries: opts.noNetwork ? 0 : undefined,
      });
      if (errors.size > 0) notes.push(`dedup: ${errors.size} par(es) sem veredito Jev (falha/cache ausente) → heurística`);
      for (const r of results) {
        const a = r.answers[0] as JevNoulAnswer | undefined;
        if (!a || a.type !== "noul") continue;
        verdicts.set(r.id, { sameStory: a.probability >= GRAYZONE_SAME_PROBABILITY, probability: a.probability, confidence: a.confidence });
      }
    } catch (e) {
      notes.push(`dedup: Jev falhou por inteiro (${e instanceof Error ? e.message : String(e)}) → heurística`);
    }
    const dt = Date.now() - t0;
    if (dt > 500) { wallMs += dt; anyNetwork = true; }
  } else if (dedupItems.length > 0) {
    notes.push("TYPESAFE_API_KEY ausente — sem vereditos Jev");
  }
  const dedup: DedupDivergence[] = [];
  for (const art of candidates) {
    const d = labelDedupDivergence(art, evaluateDedupArticle(art, past, verdicts), editorKept);
    if (d) dedup.push(d);
  }

  // --- Brasil (itens que o annotate-actor-brazil anota: 01-categorized) ---
  const categorized = readJson(join(internal, "01-categorized.json")) ?? approved;
  const items = approvedItems(categorized);
  const brazilP = new Map<string, number>();
  const brItems = items.map((i) => ({
    id: i.url,
    state: { title: i.title, url: i.url, summary: i.summary },
    questions: [ACTOR_BRAZIL_8416_ACTOR.question, ACTOR_BRAZIL_8416_BRAZIL.question],
    cacheKey: i.url,
  }));
  for (const it of brItems) estTokens += estimateJevTokens(it.state, it.questions);
  jevCalls += brItems.length;
  if (brItems.length > 0 && opts.apiKey) {
    const t0 = Date.now();
    try {
      const { results, errors } = await askJevBatch(brItems, {
        apiKey: opts.apiKey,
        cacheDir: opts.cacheDir,
        fetchImpl: opts.noNetwork ? (() => Promise.reject(new Error("--no-network"))) as typeof fetch : undefined,
        maxRetries: opts.noNetwork ? 0 : undefined,
      });
      if (errors.size > 0) notes.push(`brasil: ${errors.size} item(ns) sem anotação Jev`);
      for (const r of results) {
        const b = r.answers.find((a): a is JevNoulAnswer => a.type === "noul" && a.id === "brazil");
        const actor = r.answers.find((a): a is JevChoiceAnswer => a.type === "choice");
        if (b && actor) brazilP.set(r.id, b.probability);
      }
    } catch (e) {
      notes.push(`brasil: Jev falhou por inteiro (${e instanceof Error ? e.message : String(e)})`);
    }
    const dt = Date.now() - t0;
    if (dt > 500) { wallMs += dt; anyNetwork = true; }
  }
  const brazil: BrazilDivergence[] = [];
  for (const i of items) {
    const base = detectBrazil({ category: i.bucket, url: i.url, title: i.title, body: i.summary }).is_brazil;
    const d = brazilDivergence(i, base, brazilP.get(i.url), JEV_BRAZIL_THRESHOLD);
    if (d) brazil.push(d);
  }

  return {
    edition,
    arm,
    poolSize: candidates.length,
    grayPairs: pairs.length,
    jevVerdicts: verdicts.size,
    dedup,
    brazilItems: items.length,
    brazilAnnotated: brazilP.size,
    brazil,
    jevCalls,
    estTokens,
    estUsd: tokensToUsd(estTokens),
    jevWallMs: anyNetwork ? wallMs : null,
    notes,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const root = resolve(getStringArg(argv, "root") ?? process.cwd());
  const since = getStringArg(argv, "since") ?? "260901";
  const until = getStringArg(argv, "until") ?? "999999";
  const outDir = resolve(root, getStringArg(argv, "out") ?? "data/jev-eval/ab-paired-9531");
  const noNetwork = hasFlag(argv, "--no-network");
  loadProjectEnv(root);
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) console.error("[jev-ab-paired-eval] TYPESAFE_API_KEY ausente — só a heurística será avaliada");

  const dirs = enumerateEditionDirs(resolve(root, "data/editions"));
  const editions = [...dirs.keys()].filter((k) => /^\d{6}$/.test(k) && k >= since && k <= until).sort();
  mkdirSync(join(outDir, "cache"), { recursive: true });

  const evals: EditionEval[] = [];
  for (const edition of editions) {
    const ev = await evalEdition({ edition, dirs, apiKey, cacheDir: join(outDir, "cache"), noNetwork });
    if (!ev) {
      console.error(`[jev-ab-paired-eval] ${edition}: sem pool/approved — pulada`);
      continue;
    }
    console.error(`[jev-ab-paired-eval] ${edition} (${ev.arm}): ${ev.grayPairs} par(es) zona, ${ev.dedup.length} divergência(s) dedup, ${ev.brazil.length} Brasil`);
    evals.push(ev);
  }
  const verdict = decide(evals);
  const strictVerdict = decide(evals, { strict: true });
  const md = renderPairedReport(evals, verdict, strictVerdict);
  writeFileSync(join(outDir, "report.md"), md, "utf8");
  writeFileSync(join(outDir, "report.json"), JSON.stringify({ verdict, strictVerdict, evals }, null, 2), "utf8");
  console.log(md);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(1);
  });
}
