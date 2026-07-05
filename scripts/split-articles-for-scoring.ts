/**
 * split-articles-for-scoring.ts (#1611)
 *
 * Etapa 1 do scorer chunked-parallel. Achata os buckets categorizados em uma
 * lista única e divide em N chunks de ~`chunk-size` artigos, preservando o
 * bucket de cada artigo (`category`). Cada chunk é gravado no MESMO shape que o
 * scorer espera (`{ categorized: { lancamento, radar, use_melhor, video } }`)
 * para que os agents `scorer-chunk` paralelos pontuem em wall-clock reduzido.
 *
 * Por que: o scorer Opus single-call gasta ~8min raciocinando sobre ~80-150
 * artigos numa passada só. Dividir em K chamadas paralelas (mesmo rubrico)
 * corta o wall-clock pro tempo do chunk mais lento. A seleção final dos 6
 * destaques continua holística (agent `scorer-select` sobre os finalistas do
 * merge) — ver merge-scored-chunks.ts + assemble-scored.ts.
 *
 * Determinístico e testável — a divisão é round-robin estável sobre a lista
 * achatada (ordem de bucket fixa), então o mesmo input sempre gera os mesmos
 * chunks.
 *
 * Uso:
 *   npx tsx scripts/split-articles-for-scoring.ts \
 *     --categorized data/editions/{AAMMDD}/_internal/tmp-dates-reviewed.json \
 *     --out-dir data/editions/{AAMMDD}/_internal/scoring-chunks \
 *     [--chunk-size 30]
 *
 * Output stdout: JSON manifest { total_articles, chunk_count, chunk_files[], pool_out? }.
 * Quando total_articles <= chunk-size, emite 1 chunk só (o orchestrator pode
 * cair no caminho single-scorer nesse caso).
 *
 * --pool-out <path> (#2496): quando fornecido, grava o pool capado
 * (após audience_affinity + dedup/cap use_melhor) em <path> com shape
 * { categorized: {...} }. O merge-scored-chunks.ts deve receber esse arquivo
 * como --categorized em vez de tmp-dates-reviewed.json, para que o pool de
 * comparação seja exatamente o que foi distribuído nos chunks — evita
 * falso catastrophic quando use_melhor é capado (ex: 31→15, os 16 capados
 * apareciam como missing no merge → missing_count > 2 → catastrophic falso).
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { annotateUseMelhorBucket, loadAudienceSignals } from "./lib/audience-affinity.ts"; // #2063
import { dedupeUseMelhorBucket } from "./lib/use-melhor-curation.ts"; // #2276
import { parseArgs } from "./lib/cli-args.ts"; // #2834

const ROOT = resolve(import.meta.dirname, "..");

// Ordem de bucket canônica (#1629) — fixa para tornar a divisão determinística.
export const BUCKET_ORDER = ["lancamento", "radar", "use_melhor", "video"] as const;
export type Bucket = (typeof BUCKET_ORDER)[number];

/** Mapping Category → Bucket (#1629), duplicado de categorize.ts pra evitar import circular. */
function categoryToBucket(c: string): Bucket {
  switch (c) {
    case "lancamento":
      return "lancamento";
    case "pesquisa":
    case "noticias":
      return "radar";
    case "tutorial":
      return "use_melhor";
    case "video":
      return "video";
    default:
      return "radar"; // fallback safe
  }
}

export interface Article {
  url: string;
  title?: string;
  category?: string;
  [key: string]: unknown;
}

export type Categorized = Record<string, Article[]>;

export interface SplitManifest {
  total_articles: number;
  chunk_count: number;
  chunk_files: string[];
  /** Caminho do pool capado gravado por --pool-out (#2496). Presente apenas quando o flag é passado. */
  pool_out?: string;
}

/** Achata os buckets na ordem canônica, preservando o bucket de cada artigo. */
export function flattenCategorized(categorized: Categorized): Article[] {
  const flat: Article[] = [];
  for (const bucket of BUCKET_ORDER) {
    for (const a of categorized[bucket] ?? []) flat.push(a);
  }
  // Buckets fora da ordem canônica (defensivo) — incluídos ao final.
  for (const key of Object.keys(categorized)) {
    if ((BUCKET_ORDER as readonly string[]).includes(key)) continue;
    for (const a of categorized[key] ?? []) flat.push(a);
  }
  return flat;
}

/** Mapeia um artigo de volta pro bucket categorizado (#1629). */
function bucketOf(a: Article): Bucket {
  return categoryToBucket(a.category ?? "");
}

/** Reconstrói o shape `categorized` a partir de uma lista de artigos. */
export function toCategorized(articles: Article[]): Categorized {
  const out: Categorized = { lancamento: [], radar: [], use_melhor: [], video: [] };
  for (const a of articles) out[bucketOf(a)].push(a);
  return out;
}

/**
 * Divide a lista achatada em `chunkCount` chunks via round-robin estável.
 * Round-robin (em vez de fatias contíguas) garante que cada chunk receba uma
 * mistura de buckets — evita que um chunk fique só com `noticias` e outro só
 * com `lancamento`, o que enviesaria a pontuação relativa intra-chunk.
 */
export function splitRoundRobin(articles: Article[], chunkCount: number): Article[][] {
  const chunks: Article[][] = Array.from({ length: chunkCount }, () => []);
  articles.forEach((a, i) => chunks[i % chunkCount].push(a));
  return chunks;
}

/** Quantos chunks pra um pool de `total` artigos com alvo `chunkSize`. */
export function chunkCountFor(total: number, chunkSize: number): number {
  if (total <= 0) return 0;
  return Math.max(1, Math.ceil(total / chunkSize));
}

export function buildChunks(
  categorized: Categorized,
  chunkSize: number,
): Categorized[] {
  const flat = flattenCategorized(categorized);
  const count = chunkCountFor(flat.length, chunkSize);
  if (count === 0) return [];
  return splitRoundRobin(flat, count).map(toCategorized);
}

export function main(): void {
  const { values } = parseArgs(process.argv.slice(2));
  const categorizedPath = values.categorized;
  const outDir = values["out-dir"];
  const chunkSize = parseInt(values["chunk-size"] ?? "30", 10);
  // #2496: --pool-out emite o pool capado para que merge-scored-chunks use como
  // --categorized. Sem isso o merge compara contra o pool não-capado e gera
  // falso catastrophic quando use_melhor tem muitos itens capados.
  const poolOut = values["pool-out"];

  if (!categorizedPath || !outDir) {
    console.error(
      "Uso: split-articles-for-scoring.ts --categorized <tmp-dates-reviewed.json> --out-dir <dir> [--chunk-size 30] [--pool-out <path>]",
    );
    process.exit(1);
  }
  if (!Number.isFinite(chunkSize) || chunkSize < 1) {
    console.error(`--chunk-size inválido: ${values["chunk-size"]}`);
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(resolve(ROOT, categorizedPath), "utf8"));
  // Aceita tanto { categorized: {...} } (tmp-dates-reviewed) quanto {...} direto.
  const categorized: Categorized = raw.categorized ?? raw;

  // #2063: anotar artigos use_melhor com audience_affinity antes de distribuir
  // nos chunks. Fallback gracioso: se data/ ausente (CI, worktree fresco),
  // signals.loaded === false e annotateUseMelhorBucket retorna 0 sem anotação.
  try {
    const signals = loadAudienceSignals(ROOT);
    const annotated = annotateUseMelhorBucket(categorized, signals);
    if (annotated > 0) {
      console.error(`[split-articles-for-scoring] audience_affinity anotada em ${annotated} artigo(s) use_melhor`);
    }
  } catch (e) {
    console.error(`[split-articles-for-scoring] WARN: audience_affinity falhou (${(e as Error).message}) — seguindo sem anotação`);
  }

  // #2276: de-dup temático + cap por domínio antes de distribuir nos chunks.
  // Evita que o scorer receba 3/5 itens do mesmo vendor (ex: 260615: 3× AWS Bedrock).
  // Default: maxPerDomain=2 (mais conservador que 1 — preserva variedade dentro do scorer
  // sem perder pool para o gate humano. O editor ainda pode remover duplicatas no gate).
  if ((categorized["use_melhor"] ?? []).length > 0) {
    const before = (categorized["use_melhor"] ?? []).length;
    const deduped = dedupeUseMelhorBucket(categorized["use_melhor"] ?? [], { maxPerDomain: 2 });
    if (deduped.length < before) {
      console.error(
        `[split-articles-for-scoring] use_melhor: ${before} → ${deduped.length} após dedup/cap (#2276)`,
      );
    }
    categorized["use_melhor"] = deduped;
  }

  const chunks = buildChunks(categorized, chunkSize);
  const absOutDir = resolve(ROOT, outDir);
  mkdirSync(absOutDir, { recursive: true });

  // #2496: caminho do pool capado (--pool-out). Resolvido após o mkdirSync de
  // absOutDir (garante que o pai _internal/ existe). A escrita acontece no PASSO 3,
  // DEPOIS da escrita dos chunks (crash-consistency: se o loop de chunks falhar no
  // meio, não fica um pool fresco apontando pra chunks parciais → falso catastrophic).
  const absPoolOut = poolOut ? resolve(ROOT, poolOut) : null;

  // #2287 / #6-fix: limpar scoring-chunks/ pré-existentes antes de escrever os novos.
  // Chunks de runs anteriores podem ter scores de URLs de outra edição.
  // Se o scorer-chunk lê um arquivo stale antes de sobrescrever, pode mesclar
  // dados antigos. Limpar garante que o diretório começa vazio.
  //
  // GUARDA SEGURA (#6): scored-chunk-*.json são o OUTPUT dos scorer-chunk paralelos.
  // Apagá-los incondicionalmente destrói o trabalho de scoring em caso de retry
  // (pipeline interrompida entre scoring e merge). Só apagar scored-chunk-*.json
  // se a merge ainda não completou — i.e., tmp-allscored.json (output do merge)
  // ainda NÃO existe no diretório pai. Se o merge já rodou, os scored-chunk-*.json
  // já foram consumidos e não precisamos protegê-los; mas se o merge ainda não
  // rodou (ou nunca rodou), limpá-los forçaria re-scoring desnecessário.
  //
  // #2313 (#4): ao re-splittar, apagar tmp-allscored.json DEPOIS de usar sua
  // presença para decidir sobre os scored-chunk-*.json (#6 guard). O arquivo
  // é re-gerado pelo merge depois. NÃO apagar se não existir (idempotente).
  // Razão: scores stale de runs anteriores contaminam o finalize-stage1 —
  // ex: 260616: AWS Bedrock scores de um run anterior atravessaram o threshold.
  //
  // Ordem:
  //   1. Checar tmp-allscored.json → decidir cleanup de scored-chunk-*.json (#6).
  //   2. Remover tmp-allscored.json stale (invalida merge anterior — scorer novo vai gerar).
  //   3. Escrever scoring-chunk-*.json novos.
  const parentDir = resolve(absOutDir, "..");
  const allScoredPath = resolve(parentDir, "tmp-allscored.json");
  if (existsSync(absOutDir)) {
    // PASSO 1: Detectar se merge já completou (scored-chunk-*.json já foram consumidos).
    const mergeCompleted = existsSync(allScoredPath);

    let scoringChunksRemoved = 0;
    let scoredChunksRemoved = 0;
    for (const entry of readdirSync(absOutDir)) {
      if (entry.startsWith("scoring-chunk-") && entry.endsWith(".json")) {
        rmSync(resolve(absOutDir, entry), { force: true });
        scoringChunksRemoved++;
      }
      // scored-chunk-*.json: só remover se merge ainda NÃO completou.
      // Se merge completou, scorer-chunk já foi consumido — podemos limpar também.
      // Se merge NÃO completou mas scored-chunk existe, scoring pode estar em curso
      // ou parcialmente concluído → preservar para evitar re-scoring desnecessário.
      if (entry.startsWith("scored-chunk-") && entry.endsWith(".json")) {
        if (mergeCompleted) {
          // Merge já consumiu os chunks — limpar é seguro.
          rmSync(resolve(absOutDir, entry), { force: true });
          scoredChunksRemoved++;
        } else {
          // Merge ainda não rodou: estes podem ser chunks de scoring em andamento.
          // Preservar — log avisa o operador que scored-chunk pré-existentes ficaram.
          console.error(
            `[split-articles-for-scoring] PRESERVANDO ${entry} — merge ainda não completou ` +
            `(tmp-allscored.json ausente). Re-rodar split não destrói scoring em andamento (#2287/#6).`,
          );
        }
      }
    }
    if (scoringChunksRemoved > 0 || scoredChunksRemoved > 0) {
      console.error(
        `[split-articles-for-scoring] scoring-chunks/ limpo: ` +
        `${scoringChunksRemoved} scoring-chunk, ${scoredChunksRemoved} scored-chunk removidos (#2287)`,
      );
    }

    // PASSO 2 (#2313/#4): após usar a presença de tmp-allscored.json para decidir
    // o cleanup de scored-chunks, REMOVER o arquivo — scores do merge anterior não
    // devem contaminar o finalize-stage1 neste re-split. O merge irá re-gerá-lo.
    if (existsSync(allScoredPath)) {
      rmSync(allScoredPath, { force: true });
      console.error(
        "[split-articles-for-scoring] tmp-allscored.json removido após re-split — " +
        "scores do run anterior não contaminarão o finalize (#2313/#4). " +
        "O merge vai re-gerar o arquivo.",
      );
    }
  }

  // PASSO 2-bis (#2496/#2519): invalidar tmp-scoring-pool.json STALE antes de
  // (re)escrever os chunks. Remove SOMENTE os paths que serão re-escritos neste
  // run pelo PASSO 3 (i.e., absPoolOut não-null). Se --pool-out foi passado,
  // apaga tanto o canonicalPoolPath (que o orchestrator hardcoda no merge em 1q.3)
  // quanto absPoolOut (se diferente) — ambos serão reescritos logo abaixo.
  //
  // #2519: a versão anterior era incondicional e removia canonicalPoolPath MESMO
  // quando --pool-out estava ausente (absPoolOut null). Nesse caso o PASSO 3 não
  // reescreve o arquivo → merge em 1q.3 recebe ENOENT → exit 1 → HALT. Fix:
  // só deletar quando absPoolOut está definido (o arquivo SERÁ reescrito em PASSO 3).
  const canonicalPoolPath = resolve(parentDir, "tmp-scoring-pool.json");
  if (absPoolOut) {
    for (const stale of new Set([canonicalPoolPath, absPoolOut])) {
      if (existsSync(stale)) {
        rmSync(stale, { force: true });
        console.error(
          `[split-articles-for-scoring] tmp-scoring-pool.json stale removido (${stale}) — ` +
          "o merge não consumirá um pool de run anterior (#2496).",
        );
      }
    }
  }

  const chunkFiles: string[] = [];
  chunks.forEach((chunk, i) => {
    const fileAbs = join(absOutDir, `scoring-chunk-${i}.json`);
    writeFileSync(fileAbs, JSON.stringify({ categorized: chunk }, null, 2), "utf8");
    // path relativo ao ROOT pro manifest (consumível pelo orchestrator).
    chunkFiles.push(join(outDir, `scoring-chunk-${i}.json`).replaceAll("\\", "/"));
  });

  // PASSO 3 (#2496): gravar o pool capado DEPOIS dos chunks (crash-consistency).
  // O orchestrator passa este arquivo como --categorized do merge (1q.3) — assim o
  // merge compara contra exatamente o que foi distribuído nos chunks (evita falso
  // catastrophic quando use_melhor é capado, ex: 31→15: os 16 capados apareciam como
  // missing → missing_count > 2 → catastrophic falso). buildChunks acima NÃO muta
  // `categorized` (flattenCategorized lê; splitRoundRobin/toCategorized criam arrays
  // novos), então o pool gravado bate exatamente com a união dos chunks. Escrever por
  // último garante que um crash no loop de chunks NÃO deixa um pool fresco apontando
  // pra chunks parciais (PASSO 2-bis já removeu o pool anterior de qualquer forma).
  if (absPoolOut) {
    writeFileSync(absPoolOut, JSON.stringify({ categorized }, null, 2), "utf8");
    console.error(`[split-articles-for-scoring] pool capado gravado em ${absPoolOut} (#2496)`);
  }

  const manifest: SplitManifest = {
    total_articles: flattenCategorized(categorized).length,
    chunk_count: chunks.length,
    chunk_files: chunkFiles,
    // #2496: caminho do pool capado no manifest (quando --pool-out foi passado).
    // Informacional — hoje o orchestrator HARDCODA o path em 1q.1/1q.3 (não lê este
    // campo); fica disponível pra um consumidor futuro que prefira derivá-lo do manifest.
    // Normalizar separador igual a chunk_files[] — manifest 100% forward-slash no Windows
    // (senão um consumidor que interpole pool_out num comando shell quebraria com `\`).
    ...(poolOut ? { pool_out: poolOut.replaceAll("\\", "/") } : {}),
  };
  process.stdout.write(JSON.stringify(manifest) + "\n");
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
const _importMeta = import.meta.url;
if (
  _importMeta === `file://${_argv1}` ||
  _importMeta === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
