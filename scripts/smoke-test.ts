/**
 * smoke-test.ts
 *
 * Smoke test end-to-end: roda a cadeia dedup → categorize → render → apply-gate-edits
 * sobre uma fixture committed e compara com golden output.
 *
 * Captura bugs de integração entre os scripts que unit tests isolados podem
 * não pegar (ex: shape de output mudou num lado, outro não acompanhou).
 *
 * Uso:
 *   npm run smoke                   # roda e compara com golden
 *   npm run smoke -- --update-golden  # regenera golden quando mudança é legítima
 *
 * 100% offline. Zero MCP, zero API, zero network.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dedup } from "./dedup.ts";
import { categorize } from "./categorize.ts";
import { renderLine, buildHighlightUrls, isBrazilianTheme } from "./render-categorized-md.ts";
import { parseSections } from "./apply-gate-edits.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = resolve(ROOT, "test/fixtures/edition-sample");
const ARTICLES_PATH = resolve(FIXTURE_DIR, "input/articles.json");
const PAST_PATH = resolve(FIXTURE_DIR, "input/past-editions.md");
const GOLDEN_PATH = resolve(FIXTURE_DIR, "expected/pipeline-output.json");

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
  console.log(`✓ Pipeline match golden (${snapshot.dedup.kept_count} articles, ${Object.values(snapshot.categorize).flat().length} buckets)`);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
