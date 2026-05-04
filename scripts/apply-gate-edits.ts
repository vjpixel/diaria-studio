#!/usr/bin/env npx tsx
/**
 * apply-gate-edits.ts
 *
 * Roda após o gate humano do Stage 1. Parseia o `01-categorized.md` que
 * o editor pode ter editado (mover linhas, deletar itens, reordenar),
 * e aplica essas edições ao `_internal/01-categorized.json` para
 * produzir `_internal/01-approved.json`.
 *
 * Comportamento:
 *   - Parseia as 4 seções: `## Destaques`, `## Lançamentos`, `## Pesquisas`, `## Notícias`.
 *   - Para cada seção, extrai as URLs na ORDEM FÍSICA em que aparecem.
 *   - `Destaques`: primeiras 3 viram D1/D2/D3 (rank 1/2/3). Se < 3, completa
 *     com candidatos originais do scorer por rank. Se > 3, mantém as 3 primeiras.
 *   - `Lançamentos` / `Pesquisas` / `Notícias`: honra exatamente as URLs que o editor
 *     deixou, na ordem que aparecem. Artigos removidos do MD são dropados.
 *   - Artigos podem ter sido movidos entre buckets — o categorizer original fica
 *     irrelevante; o bucket final é o que o editor escolheu.
 *
 * Uso:
 *   npx tsx scripts/apply-gate-edits.ts \
 *     --md    data/editions/260423/01-categorized.md \
 *     --json  data/editions/260423/_internal/01-categorized.json \
 *     --out   data/editions/260423/_internal/01-approved.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { canonicalize as canonicalize_ } from "./lib/url-utils.ts";

interface Article {
  url: string;
  title?: string;
  score?: number;
  category?: string;
  [key: string]: unknown;
}

interface Highlight {
  rank: number;
  score?: number;
  bucket: string;
  reason?: string;
  url: string;
  article: Article | null;
  [key: string]: unknown;
}

interface CategorizedJson {
  highlights?: Highlight[];
  runners_up?: unknown[];
  lancamento: Article[];
  pesquisa: Article[];
  noticias: Article[];
  tutorial?: Article[];
  video?: Article[];
}

interface ApprovedJson {
  highlights: Highlight[];
  runners_up: unknown[];
  lancamento: Article[];
  pesquisa: Article[];
  noticias: Article[];
  tutorial: Article[]; // sempre array, nunca ausente (#328)
  video: Article[]; // sempre array, nunca ausente
}

type BucketName = "destaques" | "lancamento" | "pesquisa" | "noticias" | "tutorial" | "video";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

/**
 * Extrai URLs na ordem física de cada seção do MD. Retorna um mapa
 * section-name → URLs[] preservando ordem.
 */
export function parseSections(md: string): Record<BucketName, string[]> {
  // Normalizar formato de link Markdown que o Google Drive adiciona:
  // [https://url](https://url) → https://url
  md = md.replace(/\[https?:\/\/[^\]]+\]\((https?:\/\/[^)]+)\)/g, '$1');
  // Colchetes escapados que o Drive adiciona: \[N\] → [N]
  md = md.replace(/\\\[(\d+)\\\]/g, '[$1]');

  const result: Record<BucketName, string[]> = {
    destaques: [],
    lancamento: [],
    pesquisa: [],
    noticias: [],
    tutorial: [],
    video: [],
  };

  const headingToBucket: Record<string, BucketName> = {
    "Destaques": "destaques",
    "Lançamentos": "lancamento",
    "Pesquisas": "pesquisa",
    "Notícias": "noticias",
    "Aprenda hoje": "tutorial",
    "Vídeos": "video",
  };

  // Split por ## headings
  const lines = md.split("\n");
  let currentBucket: BucketName | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      const name = headingMatch[1].trim();
      currentBucket = headingToBucket[name] ?? null;
      continue;
    }
    if (line.match(/^---\s*$/)) {
      // Separador — aborta bucket atual (pode vir antes de seção Saúde)
      currentBucket = null;
      continue;
    }
    if (!currentBucket) continue;

    // Extrai URL de linha-bullet OU numerada (#322).
    // Formatos aceitos:
    //   `- [score] Título ... — URL [— YYYY-MM-DD]`  (bullets legados)
    //   `1. [score] Título ... — URL [— YYYY-MM-DD]` (numerado, novo padrão)
    const urlMatch = line.match(/^(?:-|\d+\.)\s.*?—\s+(https?:\/\/\S+?)(?:\s+—|\s*$)/);
    if (urlMatch) {
      // Strip pontuação trailing que editores mobile/autocomplete podem introduzir (#443)
      const rawUrl = urlMatch[1].replace(/[.,);:!?]+$/, "");
      result[currentBucket].push(rawUrl);
    }
  }

  // Dedup dentro de cada bucket preservando ordem (protege contra paste duplicado
  // acidental do editor).
  for (const key of Object.keys(result) as BucketName[]) {
    result[key] = [...new Set(result[key])];
  }

  return result;
}

/**
 * Canonicaliza URL para comparação: lowercase do scheme+host, remove tracking
 * params, hash e trailing slash. Permite que variações triviais introduzidas
 * por editores (mobile autocomplete, copy-paste com slash extra, etc.) ainda
 * encontrem o artigo no pool original (#439).
 */
export function canonicalizeUrl(url: string): string {
  return canonicalize_(url);
}

function findArticle(
  url: string,
  pools: Article[][],
): { article: Article; origBucket: string | null } | null {
  const canonUrl = canonicalizeUrl(url);
  for (const pool of pools) {
    const found = pool.find((a) => canonicalizeUrl(a.url) === canonUrl);
    if (found) return { article: found, origBucket: (found.category as string) ?? null };
  }
  return null;
}

function buildHighlight(
  url: string,
  rank: number,
  bucket: string,
  article: Article,
  originalHighlights: Highlight[],
): Highlight {
  const orig = originalHighlights.find((h) => h.url === url);
  return {
    rank,
    score: article.score ?? orig?.score ?? 0,
    bucket,
    reason: orig?.reason ?? "selecionado pelo editor no gate",
    url,
    article,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const mdPath = args["md"];
  const jsonPath = args["json"];
  const outPath = args["out"];

  if (!mdPath || !jsonPath || !outPath) {
    console.error(
      "Uso: apply-gate-edits.ts --md <categorized.md> --json <categorized.json> --out <approved.json>",
    );
    process.exit(1);
  }

  const md = readFileSync(mdPath, "utf8");
  const data: CategorizedJson = JSON.parse(readFileSync(jsonPath, "utf8"));

  const sections = parseSections(md);
  const originalHighlights = data.highlights ?? [];
  const originalBuckets = {
    lancamento: data.lancamento,
    pesquisa: data.pesquisa,
    noticias: data.noticias,
    tutorial: data.tutorial ?? [],
    video: data.video ?? [],
  };
  const allPools = [data.lancamento, data.pesquisa, data.noticias, data.tutorial ?? [], data.video ?? []];

  // ---- Destaques ---------------------------------------------------------
  let destaquesUrls = [...sections.destaques];
  if (destaquesUrls.length < 3) {
    // Completa com candidatos do scorer por rank.
    // JSON pode ter URL flat (h.url) OU nested (h.article.url) — suporta ambos (#323).
    const scorerRanked = [...originalHighlights].sort((a, b) => a.rank - b.rank);
    for (const h of scorerRanked) {
      if (destaquesUrls.length >= 3) break;
      const url = h.url ?? (h.article as { url?: string } | null)?.url;
      if (url && !destaquesUrls.includes(url)) destaquesUrls.push(url);
    }
    console.error(
      `[apply-gate-edits] Destaques incompletos (${sections.destaques.length}) — completando com ${destaquesUrls.length - sections.destaques.length} candidato(s) do scorer.`,
    );
  } else if (destaquesUrls.length > 3) {
    console.error(
      `[apply-gate-edits] ${destaquesUrls.length} destaques no MD — mantendo só os 3 primeiros por posição.`,
    );
    destaquesUrls = destaquesUrls.slice(0, 3);
  }

  const highlights: Highlight[] = [];
  for (let i = 0; i < destaquesUrls.length; i++) {
    const url = destaquesUrls[i];
    const found = findArticle(url, allPools);
    if (!found) {
      console.error(`[apply-gate-edits] WARN: URL do Destaques não encontrada no JSON: ${url}`);
      continue;
    }
    // O bucket do destaque é o bucket ORIGINAL do artigo (onde ele estava antes
    // de ser movido para Destaques). O editor move linhas do bucket para o topo
    // sem sair da seção editorial original.
    const bucket = found.origBucket ?? "noticias";
    highlights.push(buildHighlight(url, i + 1, bucket, found.article, originalHighlights));
  }

  // ---- Buckets: honra a curadoria do editor -----------------------------
  // Para cada bucket no MD, extrai URLs (na ordem editorial) e resolve artigos.
  // Artigos não listados no MD são dropados (editor os removeu).
  function resolveBucket(urls: string[]): Article[] {
    const out: Article[] = [];
    for (const url of urls) {
      const found = findArticle(url, allPools);
      if (!found) {
        console.error(`[apply-gate-edits] WARN: URL do MD não encontrada no JSON: ${url}`);
        continue;
      }
      out.push(found.article);
    }
    return out;
  }

  const tutorialResolved = resolveBucket(sections.tutorial);
  const videoResolved = resolveBucket(sections.video);
  const approved: ApprovedJson = {
    highlights,
    runners_up: data.runners_up ?? [],
    lancamento: resolveBucket(sections.lancamento),
    pesquisa: resolveBucket(sections.pesquisa),
    noticias: resolveBucket(sections.noticias),
    tutorial: tutorialResolved, // sempre array — consumers não precisam de ?? [] (#328)
    video: videoResolved, // sempre array
  };

  writeFileSync(outPath, JSON.stringify(approved, null, 2), "utf8");

  const origTotals = `L=${originalBuckets.lancamento.length} P=${originalBuckets.pesquisa.length} N=${originalBuckets.noticias.length} T=${originalBuckets.tutorial.length} V=${originalBuckets.video.length}`;
  const approvedTotals = `L=${approved.lancamento.length} P=${approved.pesquisa.length} N=${approved.noticias.length} T=${approved.tutorial.length} V=${approved.video.length}`;
  console.error(
    `[apply-gate-edits] original ${origTotals} → approved ${approvedTotals} — destaques: ${approved.highlights.length}`,
  );
  process.stdout.write(
    JSON.stringify({
      out: outPath,
      destaques: approved.highlights.length,
      lancamento: approved.lancamento.length,
      pesquisa: approved.pesquisa.length,
      noticias: approved.noticias.length,
      tutorial: approved.tutorial.length,
    }) + "\n",
  );
}

/**
 * Merge da curadoria do editor (MD existente) com um novo CategorizedJson (#293).
 *
 * Chamada pelo render-categorized-md quando detecta que o editor modificou o MD
 * (via hash fingerprint) e um re-render seria solicitado — evitando perder edições.
 *
 * Regras:
 * - URL em ambos: artigo do novo JSON (dados frescos) no bucket/ordem do editor.
 * - URL só no novo JSON (novo artigo): bucket original, marcado `new_in_pool: true`.
 * - URL só no MD do editor (removida do pool): warning, excluída do resultado.
 * - URLs no Destaques do MD: flutuam ao topo do bucket original no novo JSON.
 */
export function mergeWithNewJson(
  existingMd: string,
  newJson: CategorizedJson,
): { merged: CategorizedJson; warnings: string[] } {
  const warnings: string[] = [];
  const editorSections = parseSections(existingMd);

  // Índice url → { article, origBucket } do novo JSON
  const urlToNew = new Map<string, { article: Article; origBucket: string }>();
  const bucketEntries: [string, Article[]][] = [
    ["lancamento", newJson.lancamento],
    ["pesquisa", newJson.pesquisa],
    ["noticias", newJson.noticias],
    ["tutorial", newJson.tutorial ?? []],
    ["video", newJson.video ?? []],
  ];
  for (const [bucketName, pool] of bucketEntries) {
    for (const a of pool) {
      urlToNew.set(a.url, { article: a, origBucket: bucketName });
    }
  }

  // Todas as URLs que o editor tinha no MD (destaques incluídos)
  const editorAllUrls = new Set<string>([
    ...editorSections.destaques,
    ...editorSections.lancamento,
    ...editorSections.pesquisa,
    ...editorSections.noticias,
    ...editorSections.tutorial,
    ...editorSections.video,
  ]);

  // URLs no MD do editor que sumiram do novo JSON → avisar
  for (const url of editorAllUrls) {
    if (!urlToNew.has(url)) {
      warnings.push(`dropped from new pool: ${url}`);
    }
  }

  // Construir buckets do resultado mesclado
  const out: Record<string, Article[]> = {
    lancamento: [], pesquisa: [], noticias: [], tutorial: [], video: [],
  };
  const placed = new Set<string>();

  // 1. URLs nos Destaques do editor → topo do bucket original
  for (const url of editorSections.destaques) {
    const entry = urlToNew.get(url);
    if (!entry || placed.has(url)) continue;
    out[entry.origBucket].push(entry.article);
    placed.add(url);
  }

  // 2. URLs nas seções regulares do editor → bucket do editor, na ordem do editor
  for (const [editorBucket, urls] of [
    ["lancamento", editorSections.lancamento],
    ["pesquisa", editorSections.pesquisa],
    ["noticias", editorSections.noticias],
    ["tutorial", editorSections.tutorial],
    ["video", editorSections.video],
  ] as [string, string[]][]) {
    for (const url of urls) {
      const entry = urlToNew.get(url);
      if (!entry || placed.has(url)) continue;
      out[editorBucket].push(entry.article);
      placed.add(url);
    }
  }

  // 3. Artigos novos (não estavam no MD do editor) → bucket original, marcados
  for (const [url, { article, origBucket }] of urlToNew) {
    if (!placed.has(url)) {
      out[origBucket].push({ ...article, new_in_pool: true });
      placed.add(url);
    }
  }

  return {
    merged: {
      ...newJson,
      lancamento: out.lancamento,
      pesquisa: out.pesquisa,
      noticias: out.noticias,
      tutorial: out.tutorial,
      video: out.video,
    },
    warnings,
  };
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
const _importMeta = import.meta.url;
if (
  _importMeta === `file://${_argv1}` ||
  _importMeta === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
