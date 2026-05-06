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
import { resolve } from "node:path";
import { canonicalize as canonicalize_ } from "./lib/url-utils.ts";
import { computeTotalConsidered } from "./lib/categorized-stats.ts";
import {
  countEditorSubmissions,
  formatCoverageLine,
  resolveEditorEmail,
} from "./lib/inbox-stats.ts"; // #592, #609
import type { Article, Highlight, CategorizedJson, ApprovedJson } from "./lib/schemas/edition-state.ts";

// #658 review: paths consistentes contra ROOT (não cwd) — segue padrão de
// inbox-drain.ts e drive-sync.ts.
const ROOT = resolve(import.meta.dirname, "..");

interface CoverageStats {
  /** Submissões do editor (forwards/links diretos) — count of inbox blocks. */
  editor_submitted: number;
  /** Artigos descobertos pela Diar.ia (researchers + discovery). */
  diaria_discovered: number;
  /** Total selecionado para a edição (highlights + buckets aprovados). */
  selected: number;
  /** Linha de cobertura literal pronta pra colar em reviewed.md (writer.md Step 1b). */
  line: string;
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
    // #661: aceitar — (em-dash), -- (double-hyphen) e – (en-dash) —
    // Google Drive pode autocorrigir o em-dash para double-hyphen ou en-dash.
    const urlMatch = line.match(/^(?:-|\d+\.)\s.*?(?:—|--|–)\s+(https?:\/\/\S+?)(?:\s+(?:—|--|–)|\s*$)/);
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

/**
 * Resolve a lista final de URLs para a seção Destaques (#663).
 *
 * Se o editor não preencheu os 3 destaques, completa com candidatos do scorer
 * por rank — mas **apenas** URLs que ainda existem em algum bucket do MD.
 * Artigos que o editor removeu dos buckets não podem voltar como destaques.
 *
 * Retorna array de 0–3 URLs na ordem editorial.
 */
export function resolveDestaques(
  sections: Record<BucketName, string[]>,
  originalHighlights: Array<{ rank?: number; url?: string; article?: { url?: string } | null }>,
): string[] {
  let destaquesUrls = [...sections.destaques];

  if (destaquesUrls.length < 3) {
    // #663: só aceitar URLs que ainda estão em algum bucket do MD
    const mdBucketUrls = new Set([
      ...sections.lancamento,
      ...sections.pesquisa,
      ...sections.noticias,
      ...sections.tutorial,
      ...sections.video,
    ]);
    const scorerRanked = [...originalHighlights].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    for (const h of scorerRanked) {
      if (destaquesUrls.length >= 3) break;
      const url = h.url ?? (h.article as { url?: string } | null)?.url;
      if (url && !destaquesUrls.includes(url) && mdBucketUrls.has(url)) {
        destaquesUrls.push(url);
      }
    }
  } else if (destaquesUrls.length > 3) {
    destaquesUrls = destaquesUrls.slice(0, 3);
  }

  return destaquesUrls;
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
  const inboxMdPath = args["inbox-md"] ?? resolve(ROOT, "data/inbox.md");

  if (!mdPath || !jsonPath || !outPath) {
    console.error(
      "Uso: apply-gate-edits.ts --md <categorized.md> --json <categorized.json> --out <approved.json> [--inbox-md <path>]",
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
  const destaquesUrls = resolveDestaques(sections, originalHighlights);

  if (sections.destaques.length > 3) {
    console.error(
      `[apply-gate-edits] ${sections.destaques.length} destaques no MD — mantendo só os 3 primeiros por posição.`,
    );
  } else if (sections.destaques.length < 3) {
    const filled = destaquesUrls.length - sections.destaques.length;
    if (destaquesUrls.length === 0) {
      console.error(
        `[apply-gate-edits] WARN: Destaques vazio e todos os candidatos do scorer foram removidos dos buckets — aprovado com 0 destaques.`,
      );
    } else if (filled > 0) {
      console.error(
        `[apply-gate-edits] Destaques incompletos (${sections.destaques.length}) — completando com ${filled} candidato(s) do scorer presentes nos buckets.`,
      );
    }
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

  // #592 + #609: linha de cobertura — submissões / descobertos / selecionados
  const platformConfigPath = resolve(ROOT, "platform.config.json");
  const editorEmail = resolveEditorEmail(platformConfigPath);
  const editorSubmissions = countEditorSubmissions(inboxMdPath, editorEmail);
  const totalConsidered = computeTotalConsidered(jsonPath, data);
  const totalSelected =
    approved.highlights.length +
    approved.lancamento.length +
    approved.pesquisa.length +
    approved.noticias.length +
    (approved.tutorial?.length ?? 0) +
    (approved.video?.length ?? 0);
  if (totalConsidered !== null) {
    const diariaDiscovered = Math.max(0, totalConsidered - editorSubmissions);
    approved.coverage = {
      editor_submitted: editorSubmissions,
      diaria_discovered: diariaDiscovered,
      selected: totalSelected,
      line: formatCoverageLine({
        editorSubmissions,
        diariaDiscovered,
        selected: totalSelected,
      }),
    };
  }

  writeFileSync(outPath, JSON.stringify(approved, null, 2), "utf8");

  const origTotals = `L=${originalBuckets.lancamento.length} P=${originalBuckets.pesquisa.length} N=${originalBuckets.noticias.length} T=${originalBuckets.tutorial.length} V=${originalBuckets.video.length}`;
  const approvedTotals = `L=${approved.lancamento.length} P=${approved.pesquisa.length} N=${approved.noticias.length} T=${approved.tutorial?.length ?? 0} V=${approved.video?.length ?? 0}`;
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
      tutorial: approved.tutorial?.length ?? 0,
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
