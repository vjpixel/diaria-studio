#!/usr/bin/env npx tsx
/**
 * jev-ab-paired-eval.ts (#9531) — CLI da avaliação pareada retroativa do A/B
 * do Jev. Lógica pura, limitações e racional completo em
 * `scripts/lib/jev-ab-paired-eval.ts`.
 *
 * Uso:
 *   npx tsx scripts/jev-ab-paired-eval.ts [--since 260901] [--until 261231] \
 *     [--root .] [--out data/jev-eval/ab-paired-9531] [--no-network]
 *
 * Entradas por edição (todas já persistidas em `data/editions/`):
 *   - `_internal/researcher-results.json` — pool bruto do Stage 1 (aproximação
 *     do input do dedup: os `tmp-*` intermediários não sobrevivem à edição);
 *   - `_internal/01-approved.json` das edições anteriores da janela — títulos
 *     passados do Pass 1c (mesma fonte de `extractPastEditionArticleTitles`);
 *     URLs PUBLICADAS (`02-reviewed.md`) da janela aproximam o Pass 1, que em
 *     produção lê `past-editions.md` (o que foi publicado);
 *   - `_internal/dedup-grayzone-jev.json` (braço B) — vereditos gravados AO
 *     VIVO, usados no lugar de reconsultar o Jev;
 *   - `_internal/01-approved.json` + `02-reviewed.md` da própria edição — gabarito;
 *   - `_internal/01-categorized.json` — itens que o `annotate-actor-brazil` anota
 *     (com `brazil_p` gravado ao vivo no braço B).
 *
 * Chamadas Jev têm cache em disco (`{out}/cache`). `--no-network` usa só o
 * cache/artefatos (não precisa de `TYPESAFE_API_KEY`); sem a flag, a chave é
 * obrigatória — rodar sem ela daria vereditos ausentes → "sem divergência"
 * silencioso. Cobertura < 90% → veredito `inconclusivo`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { readApprovedTitles } from "./lib/past-editions-extract.ts";
import { askJevBatch, type JevBatchItem, type JevBatchResult, type JevChoiceAnswer, type JevNoulAnswer } from "./lib/jev.ts";
import { ACTOR_BRAZIL_8416_ACTOR, ACTOR_BRAZIL_8416_BRAZIL, DEDUP_GRAYZONE_8417 } from "./lib/jev-questions.ts";
import { GRAYZONE_SAME_PROBABILITY, pairKey, type GrayZoneVerdict } from "./lib/dedup-grayzone-jev.ts";
import { armFromProfile, type Tri } from "./lib/jev-ab-report.ts";
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
  verdictsFromRecordedArtifact,
  windowForEdition,
  type BrazilDivergence,
  type DedupDivergence,
  type EditionEval,
} from "./lib/jev-ab-paired-eval.ts";

const VALID_ACTORS = new Set(["big_tech_lab", "startup", "academia", "governo_regulador", "empresa_usuaria", "outro"]);

/** Distingue ausente de corrompido — parse error nunca se passa por "arquivo não existe". */
function readJsonTri(path: string): Tri<unknown> {
  if (!existsSync(path)) return { state: "absent" };
  try {
    return { state: "ok", value: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { state: "corrupt" };
  }
}

function okValue(t: Tri<unknown>): unknown {
  return t.state === "ok" ? t.value : undefined;
}

interface JevRun {
  results: JevBatchResult[];
  errors: number;
  failedEntirely: string | null;
  networkMs: number | null;
}

/**
 * Wrapper: separa o tempo de chamadas que de fato foram à rede (fetch
 * instrumentado) de acertos de cache — `networkMs` null = nenhuma chamada real.
 */
async function runJev(items: JevBatchItem[], apiKey: string, cacheDir: string, noNetwork: boolean): Promise<JevRun> {
  let networkCalls = 0;
  const fetchImpl: typeof fetch = noNetwork
    ? (() => Promise.reject(new Error("--no-network: sem cache"))) as typeof fetch
    : ((input, init) => {
        networkCalls++;
        return fetch(input, init);
      }) as typeof fetch;
  const t0 = Date.now();
  try {
    const { results, errors } = await askJevBatch(items, { apiKey, cacheDir, fetchImpl, maxRetries: noNetwork ? 0 : undefined });
    return { results, errors: errors.size, failedEntirely: null, networkMs: networkCalls > 0 ? Date.now() - t0 : null };
  } catch (e) {
    return { results: [], errors: items.length, failedEntirely: e instanceof Error ? e.message : String(e), networkMs: null };
  }
}

async function evalEdition(opts: {
  edition: string;
  dirs: Map<string, string>;
  apiKey: string;
  cacheDir: string;
  noNetwork: boolean;
}): Promise<{ ev: EditionEval } | { skip: string }> {
  const { edition, dirs } = opts;
  const dir = dirs.get(edition)!;
  const internal = join(dir, "_internal");
  const notes: string[] = [];

  const poolTri = readJsonTri(join(internal, "researcher-results.json"));
  const approvedTri = readJsonTri(join(internal, "01-approved.json"));
  if (poolTri.state === "corrupt") return { skip: "researcher-results.json ilegível (JSON inválido)" };
  if (approvedTri.state === "corrupt") return { skip: "01-approved.json ilegível (JSON inválido)" };
  const pool = flattenResearcherPool(okValue(poolTri));
  if (pool.length === 0) return { skip: "sem pool em researcher-results.json" };
  if (approvedTri.state !== "ok") return { skip: "sem 01-approved.json" };
  const approved = approvedTri.value;

  const profileTri = readJsonTri(join(internal, ".jev-profile.json"));
  const arm = armFromProfile(profileTri);
  if (arm === "unknown") notes.push(".jev-profile.json corrompido ou incompleto — braço desconhecido");

  // Janela de edições passadas que o dedup daquela edição viu (aproximação).
  const withApproved = [...dirs.keys()].filter((k) => /^\d{6}$/.test(k) && existsSync(join(dirs.get(k)!, "_internal", "01-approved.json")));
  const window = pastWindow(withApproved, edition, windowForEdition(edition));
  const pastTitles = new Set<string>();
  const pastPublishedUrls = new Set<string>();
  for (const p of window) {
    const pdir = dirs.get(p)!;
    const apath = join(pdir, "_internal", "01-approved.json");
    if (readJsonTri(apath).state === "corrupt") notes.push(`janela: ${p}/01-approved.json ilegível — títulos dessa edição perdidos`);
    for (const t of readApprovedTitles(apath)) pastTitles.add(t);
    const rpath = join(pdir, "02-reviewed.md");
    if (existsSync(rpath)) for (const u of urlsInMarkdown(readFileSync(rpath, "utf8"))) pastPublishedUrls.add(u);
  }
  // Pass 1 (URL vs. o que foi publicado na janela) remove esses antes do Pass 1c.
  const candidates = pool.filter((a) => !pastPublishedUrls.has(normalizeUrlForMatch(a.url)));
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
  let wallMs: number | null = null;
  const addWall = (ms: number | null) => {
    if (ms !== null) wallMs = (wallMs ?? 0) + ms;
  };

  // --- dedup zona cinzenta ---
  const { pairs, truncated } = grayZonePairs(candidates, past);
  const verdicts = new Map<string, GrayZoneVerdict>();
  // Braço B: vereditos gravados ao vivo primeiro.
  let recorded = 0;
  if (arm === "B") {
    const artTri = readJsonTri(join(internal, "dedup-grayzone-jev.json"));
    if (artTri.state === "corrupt") notes.push("dedup-grayzone-jev.json ilegível — reconsultando o Jev");
    const rec = verdictsFromRecordedArtifact(okValue(artTri));
    for (const p of pairs) {
      const k = pairKey(p.candidate.title, p.pastTitle);
      const v = rec.get(k);
      if (v) { verdicts.set(k, v); recorded++; }
    }
  }
  const dedupItems: JevBatchItem[] = pairs
    .filter((p) => !verdicts.has(pairKey(p.candidate.title, p.pastTitle)))
    .map((p) => ({
      id: pairKey(p.candidate.title, p.pastTitle),
      state: { a: { title: p.candidate.title, summary: p.candidate.summary ?? "", source: p.candidate.source ?? "" }, b: { title: p.pastTitle, summary: "", source: "" } },
      questions: [DEDUP_GRAYZONE_8417.question],
      cacheKey: pairKey(p.candidate.title, p.pastTitle),
    }));
  // Custo = o que o perfil B consultaria em produção (todos os pares), não só os reconsultados aqui.
  for (const p of pairs) estTokens += estimateJevTokens({ a: { title: p.candidate.title, summary: p.candidate.summary ?? "", source: p.candidate.source ?? "" }, b: { title: p.pastTitle, summary: "", source: "" } }, [DEDUP_GRAYZONE_8417.question]);
  jevCalls += pairs.length;
  if (dedupItems.length > 0) {
    const run = await runJev(dedupItems, opts.apiKey, opts.cacheDir, opts.noNetwork);
    addWall(run.networkMs);
    if (run.failedEntirely) notes.push(`dedup: Jev falhou por inteiro (${run.failedEntirely}) → heurística`);
    else if (run.errors > 0) notes.push(`dedup: ${run.errors} par(es) sem veredito Jev → heurística`);
    let malformed = 0;
    for (const r of run.results) {
      const a = r.answers.find((x): x is JevNoulAnswer => x.type === "noul" && x.id === DEDUP_GRAYZONE_8417.question.id);
      if (!a || !Number.isFinite(a.probability) || !Number.isFinite(a.confidence)) { malformed++; continue; }
      verdicts.set(r.id, { sameStory: a.probability >= GRAYZONE_SAME_PROBABILITY, probability: a.probability, confidence: a.confidence });
    }
    if (malformed > 0) notes.push(`dedup: ${malformed} resposta(s) Jev malformada(s) ignorada(s) → heurística`);
  }
  const dedup: DedupDivergence[] = [];
  for (const art of candidates) {
    const d = labelDedupDivergence(art, evaluateDedupArticle(art, past, verdicts), editorKept);
    if (d) dedup.push(d);
  }

  // --- Brasil (itens que o annotate-actor-brazil anota: 01-categorized) ---
  const catTri = readJsonTri(join(internal, "01-categorized.json"));
  if (catTri.state === "corrupt") notes.push("01-categorized.json ilegível — Brasil avaliado sobre o 01-approved.json");
  const items = approvedItems(okValue(catTri) ?? approved);
  const brazilP = new Map<string, number>();
  for (const i of items) if (i.brazilP !== undefined) brazilP.set(i.url, i.brazilP);
  const brItems: JevBatchItem[] = items
    .filter((i) => !brazilP.has(i.url))
    .map((i) => ({
      id: i.url,
      state: { title: i.title, url: i.url, summary: i.summary },
      questions: [ACTOR_BRAZIL_8416_ACTOR.question, ACTOR_BRAZIL_8416_BRAZIL.question],
      cacheKey: i.url,
    }));
  for (const i of items) estTokens += estimateJevTokens({ title: i.title, url: i.url, summary: i.summary }, [ACTOR_BRAZIL_8416_ACTOR.question, ACTOR_BRAZIL_8416_BRAZIL.question]);
  jevCalls += items.length;
  if (brItems.length > 0) {
    const run = await runJev(brItems, opts.apiKey, opts.cacheDir, opts.noNetwork);
    addWall(run.networkMs);
    if (run.failedEntirely) notes.push(`brasil: Jev falhou por inteiro (${run.failedEntirely})`);
    let malformed = 0;
    for (const r of run.results) {
      const b = r.answers.find((a): a is JevNoulAnswer => a.type === "noul" && a.id === "brazil");
      const actor = r.answers.find((a): a is JevChoiceAnswer => a.type === "choice" && a.id === "actor");
      if (!b || !actor || !VALID_ACTORS.has(actor.choice) || !Number.isFinite(b.probability)) { malformed++; continue; }
      brazilP.set(r.id, b.probability);
    }
    const missing = brItems.length - (brItems.filter((i) => brazilP.has(i.id)).length);
    if (missing > 0) notes.push(`brasil: ${missing} item(ns) sem anotação Jev (${malformed} malformado[s])`);
  }
  const brazil: BrazilDivergence[] = [];
  for (const i of items) {
    // `category` editorial (ex: BRASIL) quando gravada; o nome do bucket não é categoria.
    const base = detectBrazil({ category: i.category, url: i.url, title: i.title, body: i.summary }).is_brazil;
    const d = brazilDivergence(i, base, brazilP.get(i.url), JEV_BRAZIL_THRESHOLD);
    if (d) brazil.push(d);
  }

  return {
    ev: {
      edition,
      arm,
      poolSize: candidates.length,
      grayPairs: pairs.length,
      grayPairsTruncated: truncated,
      jevVerdicts: verdicts.size,
      jevVerdictsRecorded: recorded,
      dedup,
      brazilItems: items.length,
      brazilAnnotated: brazilP.size,
      brazil,
      jevCalls,
      estTokens,
      estUsd: tokensToUsd(estTokens),
      jevWallMs: wallMs,
      notes,
    },
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
  const envKey = process.env.TYPESAFE_API_KEY;
  if (!envKey && !noNetwork) {
    console.error("[jev-ab-paired-eval] TYPESAFE_API_KEY ausente — rode com a chave, ou --no-network para usar só cache/artefatos.");
    process.exit(2);
  }
  // Com --no-network o fetch nunca é chamado; a chave só compõe o header.
  const apiKey = envKey ?? "no-network";

  const dirs = enumerateEditionDirs(resolve(root, "data/editions"));
  const editions = [...dirs.keys()].filter((k) => /^\d{6}$/.test(k) && k >= since && k <= until).sort();
  mkdirSync(join(outDir, "cache"), { recursive: true });

  const evals: EditionEval[] = [];
  const skipped: Array<{ edition: string; reason: string }> = [];
  for (const edition of editions) {
    const r = await evalEdition({ edition, dirs, apiKey, cacheDir: join(outDir, "cache"), noNetwork });
    if ("skip" in r) {
      skipped.push({ edition, reason: r.skip });
      console.error(`[jev-ab-paired-eval] ${edition}: pulada — ${r.skip}`);
      continue;
    }
    const ev = r.ev;
    console.error(`[jev-ab-paired-eval] ${edition} (${ev.arm}): ${ev.grayPairs} par(es) zona, ${ev.dedup.length} divergência(s) dedup, ${ev.brazil.length} Brasil`);
    evals.push(ev);
  }
  if (evals.length === 0) {
    console.error(`[jev-ab-paired-eval] nenhuma edição avaliável em ${since}..${until} (root=${root}) — sem dados não há veredito.`);
    process.exit(1);
  }
  const verdict = decide(evals);
  const strictVerdict = decide(evals, { strict: true });
  const md = renderPairedReport(evals, verdict, strictVerdict, skipped);
  writeFileSync(join(outDir, "report.md"), md, "utf8");
  writeFileSync(join(outDir, "report.json"), JSON.stringify({ verdict, strictVerdict, skipped, evals }, null, 2), "utf8");
  console.log(md);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(1);
  });
}
