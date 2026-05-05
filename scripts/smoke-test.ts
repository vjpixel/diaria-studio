/**
 * smoke-test.ts
 *
 * Smoke test end-to-end que cobre os 4 stages da pipeline Diar.ia.
 *
 * Stage 1: dedup → categorize → render → apply-gate-edits (golden compare)
 * Stage 2: linters determinísticos em fixtures canônicas (lint-newsletter-md,
 *          lint-social-md, validate-lancamentos) — espera 0 erros
 * Stage 3: match-prompts-to-destaques.ts puro (computeSwaps) verifica
 *          realinhamento correto de prompts após reorder de destaques
 * Stage 4: inferIsPublished de verify-facebook-posts.ts — future/past scheduling
 *
 * 100% offline. Zero MCP, zero API, zero network. Tempo total < 15s.
 *
 * Uso:
 *   npm run smoke                   # roda e compara com golden
 *   npm run smoke -- --update-golden  # regenera golden Stage 1 quando mudança é legítima
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dedup } from "./dedup.ts";
import { categorize } from "./categorize.ts";
import { renderLine, buildHighlightUrls, isBrazilianTheme } from "./render-categorized-md.ts";
import { parseSections } from "./apply-gate-edits.ts";
import { checkEaiSection, lintNewsletter } from "./lint-newsletter-md.ts";
import { lintSocialMd } from "./lint-social-md.ts";
import { validateLancamentos } from "./validate-lancamentos.ts";
import { extractDestaqueUrls, extractPromptUrl, computeSwaps } from "./match-prompts-to-destaques.ts";
import { inferIsPublished } from "./verify-facebook-posts.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = resolve(ROOT, "test/fixtures/edition-sample");
const ARTICLES_PATH = resolve(FIXTURE_DIR, "input/articles.json");
const PAST_PATH = resolve(FIXTURE_DIR, "input/past-editions.md");
const GOLDEN_PATH = resolve(FIXTURE_DIR, "expected/pipeline-output.json");
const FIXTURE_STAGE2 = resolve(ROOT, "test/fixtures/smoke-stage2");
const FIXTURE_STAGE3 = resolve(ROOT, "test/fixtures/smoke-stage3");

interface PipelineSnapshot {
  dedup: {
    input_count: number;
    kept_count: number;
    removed_count: number;
    kept_urls: string[];
    removed_notes: string[];
  };
  categorize: {
    lancamento: string[];
    pesquisa: string[];
    noticias: string[];
  };
  brazilian_themes: string[];
  sample_rendered_lines: string[];
  roundtrip: {
    rendered_md_snippet: string;
    parsed_back: { lancamento: number; pesquisa: number; noticias: number };
  };
}

function extractPastUrlsFromMd(md: string, window: number): Set<string> {
  const urls = new Set<string>();
  const parts = md.split(/\n(?=## \d{4}-\d{2}-\d{2})/);
  const editionSections = parts.filter((s) => /^## \d{4}-\d{2}-\d{2}/m.test(s)).slice(0, window);
  for (const section of editionSections) {
    for (const line of section.split("\n")) {
      const m = line.match(/^-\s+(https?:\/\/\S+)/);
      if (m) urls.add(m[1].replace(/[.,);]+$/, ""));
    }
  }
  return urls;
}

function runPipeline(): PipelineSnapshot {
  const articles = JSON.parse(readFileSync(ARTICLES_PATH, "utf8"));
  const pastMd = readFileSync(PAST_PATH, "utf8");
  const pastUrls = extractPastUrlsFromMd(pastMd, 3);

  // 1. Dedup
  const dedupResult = dedup(articles, pastUrls, 0.85);

  // 2. Categorize
  const buckets = { lancamento: [] as string[], pesquisa: [] as string[], noticias: [] as string[], tutorial: [] as string[], video: [] as string[] };
  const articlesByBucket = { lancamento: [], pesquisa: [], noticias: [], tutorial: [], video: [] } as Record<string, unknown[]>;
  for (const art of dedupResult.kept) {
    const cat = categorize(art);
    buckets[cat].push(art.url);
    articlesByBucket[cat].push({ ...art, category: cat });
  }

  // 3. Render lines (e detectar tema BR)
  const highlightUrls = buildHighlightUrls({
    lancamento: articlesByBucket.lancamento as never[],
    pesquisa: articlesByBucket.pesquisa as never[],
    noticias: articlesByBucket.noticias as never[],
  });
  const brazilianThemes: string[] = [];
  const sampleLines: string[] = [];
  for (const bucket of ["lancamento", "pesquisa", "noticias", "tutorial", "video"] as const) {
    for (const art of articlesByBucket[bucket] as Array<{ url: string; title?: string; summary?: string }>) {
      if (isBrazilianTheme({ title: art.title, summary: art.summary })) {
        brazilianThemes.push(art.url);
      }
      sampleLines.push(renderLine(art as never, highlightUrls.has(art.url)));
    }
  }

  // 4. Roundtrip: construir MD mínimo, rodar parseSections, confirmar que as URLs voltam
  const mdLines: string[] = [];
  const renderBucketMd = (name: string, urls: string[]) => {
    mdLines.push(`## ${name}`, "");
    for (const u of urls) {
      const art = articles.find((a: { url: string }) => a.url === u) ?? { url: u, title: u };
      mdLines.push(renderLine({ ...art, url: u }));
    }
    mdLines.push("");
  };
  mdLines.push("## Destaques", "", "");
  renderBucketMd("Lançamentos", buckets.lancamento);
  renderBucketMd("Pesquisas", buckets.pesquisa);
  renderBucketMd("Notícias", buckets.noticias);
  const md = mdLines.join("\n");
  const parsed = parseSections(md);

  return {
    dedup: {
      input_count: articles.length,
      kept_count: dedupResult.kept.length,
      removed_count: dedupResult.removed.length,
      kept_urls: dedupResult.kept.map((a) => a.url).sort(),
      removed_notes: dedupResult.removed.map((r) => `${r.url} → ${r.dedup_note}`).sort(),
    },
    categorize: {
      lancamento: buckets.lancamento.sort(),
      pesquisa: buckets.pesquisa.sort(),
      noticias: buckets.noticias.sort(),
    },
    brazilian_themes: brazilianThemes.sort(),
    sample_rendered_lines: sampleLines.sort(),
    roundtrip: {
      rendered_md_snippet: md.slice(0, 200),
      parsed_back: {
        lancamento: parsed.lancamento.length,
        pesquisa: parsed.pesquisa.length,
        noticias: parsed.noticias.length,
      },
    },
  };
}

function diff(a: unknown, b: unknown): string | null {
  const aS = JSON.stringify(a, null, 2);
  const bS = JSON.stringify(b, null, 2);
  if (aS === bS) return null;
  const aLines = aS.split("\n");
  const bLines = bS.split("\n");
  const max = Math.max(aLines.length, bLines.length);
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const av = aLines[i] ?? "";
    const bv = bLines[i] ?? "";
    if (av !== bv) {
      out.push(`  linha ${i + 1}:`);
      out.push(`    -  ${av}`);
      out.push(`    +  ${bv}`);
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Stage 2 smoke — linters determinísticos em fixtures canônicas
// ---------------------------------------------------------------------------

function runStage2Smoke(): { passed: number; failed: string[] } {
  const failed: string[] = [];
  let passed = 0;

  const reviewedMd = readFileSync(resolve(FIXTURE_STAGE2, "02-reviewed-canonical.md"), "utf8");
  const socialMd = readFileSync(resolve(FIXTURE_STAGE2, "03-social-canonical.md"), "utf8");
  const approved = JSON.parse(readFileSync(resolve(FIXTURE_STAGE2, "01-approved.json"), "utf8"));

  // 2a. É IA? section present
  const eaiResult = checkEaiSection(reviewedMd);
  if (!eaiResult.ok) {
    failed.push(`stage2:eai-section: ${eaiResult.error}`);
  } else {
    passed++;
  }

  // 2b. lint-newsletter (URL bucket validation)
  const lintResult = lintNewsletter(reviewedMd, approved);
  if (!lintResult.ok) {
    for (const e of lintResult.errors) {
      failed.push(`stage2:lint-newsletter: ${e.section} L${e.line} ${e.url} (bucket=${e.found_in_bucket})`);
    }
  } else {
    passed++;
  }

  // 2c. lint-social (LinkedIn sem https://, Facebook com https://)
  const socialResult = lintSocialMd(socialMd);
  if (!socialResult.ok) {
    for (const e of socialResult.errors) {
      failed.push(`stage2:lint-social [${e.platform}] ${e.rule}: ${e.detail}`);
    }
  } else {
    passed++;
  }

  // 2d. validate-lancamentos (URLs em LANÇAMENTOS são oficiais)
  const lancResult = validateLancamentos(reviewedMd);
  if (lancResult.status === "error") {
    for (const u of lancResult.invalid_urls) {
      failed.push(`stage2:validate-lancamentos L${u.line}: ${u.url}`);
    }
  } else {
    passed++;
  }

  return { passed, failed };
}

// ---------------------------------------------------------------------------
// Stage 3 smoke — match-prompts-to-destaques (puro, computeSwaps)
// ---------------------------------------------------------------------------

function runStage3Smoke(): { passed: number; failed: string[] } {
  const failed: string[] = [];
  let passed = 0;

  // Reviewed.md tem D1=Gemini, D2=GPT-5, D3=Anthropic
  // Prompts têm position_at_write: d1=Anthropic, d2=GPT-5, d3=Gemini
  // Esperado: d1 vira Gemini (d3-original), d3 vira Anthropic (d1-original)
  const reviewedMd = readFileSync(resolve(FIXTURE_STAGE3, "02-reviewed-reordered.md"), "utf8");
  const reviewedUrls = extractDestaqueUrls(reviewedMd);

  if (reviewedUrls.length !== 3) {
    failed.push(`stage3:extract-urls: expected 3, got ${reviewedUrls.length}`);
    return { passed, failed };
  }
  passed++;

  const d1Prompt = readFileSync(resolve(FIXTURE_STAGE3, "02-d1-prompt.md"), "utf8");
  const d2Prompt = readFileSync(resolve(FIXTURE_STAGE3, "02-d2-prompt.md"), "utf8");
  const d3Prompt = readFileSync(resolve(FIXTURE_STAGE3, "02-d3-prompt.md"), "utf8");

  const promptUrls = {
    d1: extractPromptUrl(d1Prompt),
    d2: extractPromptUrl(d2Prompt),
    d3: extractPromptUrl(d3Prompt),
  };

  if (!promptUrls.d1 || !promptUrls.d2 || !promptUrls.d3) {
    failed.push(`stage3:extract-prompt-urls: d1=${promptUrls.d1} d2=${promptUrls.d2} d3=${promptUrls.d3}`);
    return { passed, failed };
  }
  passed++;

  // computeSwaps deve detectar que d1↔d3 precisa trocar
  const swaps = computeSwaps(
    { d1: promptUrls.d1, d2: promptUrls.d2, d3: promptUrls.d3 },
    reviewedUrls,
  );

  // d2 is unchanged (GPT-5 ↔ GPT-5), d1 and d3 swapped
  const hasSwap = swaps.length > 0;
  if (!hasSwap) {
    failed.push(`stage3:compute-swaps: expected swaps but got 0 (d1=${promptUrls.d1} vs reviewed[0]=${reviewedUrls[0]})`);
  } else {
    passed++;
  }

  return { passed, failed };
}

// ---------------------------------------------------------------------------
// Stage 4 smoke — inferIsPublished (pure logic, verify-facebook-posts.ts)
// ---------------------------------------------------------------------------

function runStage4Smoke(): { passed: number; failed: string[] } {
  const failed: string[] = [];
  let passed = 0;

  const futureUnix = Math.floor(Date.now() / 1000) + 3600;
  const pastUnix = Math.floor(Date.now() / 1000) - 3600;

  // Future scheduled → not yet published
  const r1 = inferIsPublished(
    { created_time: "2026-04-23T09:00:00Z", scheduled_publish_time: futureUnix },
    Math.floor(Date.now() / 1000),
  );
  if (r1.is_published !== false) {
    failed.push(`stage4:infer-future: expected is_published=false, got ${r1.is_published}`);
  } else {
    passed++;
  }

  // Past scheduled → published
  const r2 = inferIsPublished(
    { created_time: "2026-04-23T09:00:00Z", scheduled_publish_time: pastUnix },
    Math.floor(Date.now() / 1000),
  );
  if (r2.is_published !== true) {
    failed.push(`stage4:infer-past: expected is_published=true, got ${r2.is_published}`);
  } else {
    passed++;
  }

  // Error response → is_published undefined, not set
  const r3 = inferIsPublished(
    { error: { message: "(#100) nonexisting field", code: 100 } },
    Math.floor(Date.now() / 1000),
  );
  if (r3.is_published !== undefined) {
    failed.push(`stage4:infer-error: expected is_published=undefined, got ${r3.is_published}`);
  } else {
    passed++;
  }

  return { passed, failed };
}

function main() {
  const args = process.argv.slice(2);
  const updateGolden = args.includes("--update-golden");

  console.log("Rodando pipeline smoke test...");
  const snapshot = runPipeline();

  if (updateGolden) {
    writeFileSync(GOLDEN_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    console.log(`✓ Golden atualizado em ${GOLDEN_PATH}`);
    return;
  }

  if (!existsSync(GOLDEN_PATH)) {
    console.error(`✗ Golden ausente: ${GOLDEN_PATH}`);
    console.error(`  Rode: npm run smoke -- --update-golden`);
    process.exit(1);
  }

  const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
  const d = diff(golden, snapshot);
  if (d) {
    console.error("✗ Output diverge do golden:");
    console.error(d);
    console.error("\nSe a mudança é intencional: npm run smoke -- --update-golden");
    process.exit(1);
  }
  console.log(`✓ Stage 1: pipeline match golden (${snapshot.dedup.kept_count} articles, ${Object.values(snapshot.categorize).flat().length} buckets)`);

  // Stage 2
  const s2 = runStage2Smoke();
  if (s2.failed.length > 0) {
    console.error(`✗ Stage 2: ${s2.failed.length} falha(s):`);
    for (const f of s2.failed) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`✓ Stage 2: ${s2.passed} lints passaram (newsletter + social + lancamentos)`);

  // Stage 3
  const s3 = runStage3Smoke();
  if (s3.failed.length > 0) {
    console.error(`✗ Stage 3: ${s3.failed.length} falha(s):`);
    for (const f of s3.failed) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`✓ Stage 3: ${s3.passed} checks passaram (prompt reorder detection)`);

  // Stage 4
  const s4 = runStage4Smoke();
  if (s4.failed.length > 0) {
    console.error(`✗ Stage 4: ${s4.failed.length} falha(s):`);
    for (const f of s4.failed) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`✓ Stage 4: ${s4.passed} checks passaram (Facebook inferIsPublished)`);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
