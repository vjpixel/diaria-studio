/**
 * check-intra-themes.ts (#2597)
 *
 * Detecta CLUSTERING TEMÁTICO dentro da edição corrente — múltiplos itens
 * cobrindo o mesmo tema sem que sejam duplicatas exatas de URL/título.
 *
 * Problema (#2597): o `dedup-intra-edition.ts` remove itens que DUPLICAM
 * um destaque (mesmo evento), mas não sinaliza clusters onde múltiplos itens
 * secundários cobrem o mesmo TEMA entre si, ou onde um secundário compartilha
 * tema com um destaque sem ser o mesmo evento exato.
 *
 * Dois tipos de sinal:
 *
 *   1. **Cluster intra-secundários**: ≥2 itens de buckets secundários com
 *      Jaccard de título >= 0.35 OU empresa em comum + Jaccard >= 0.20.
 *      Caso real (#2597): 3 itens sobre "agentes de IA" no mesmo dia.
 *
 *   2. **Secundário duplica tema de destaque (não-mesmo-evento)**: um item
 *      secundário compartilha empresa + tema com um destaque da MESMA edição,
 *      mas não foi removido pelo dedup intra-edição (porque não é o mesmo evento
 *      exato — URLs diferentes, Jaccard abaixo do threshold). Gera aviso para
 *      o editor decidir se quer manter ou trocar.
 *      Caso real (#2597): RADAR "Google jobtools" vs D3 "Gemini notebooks".
 *
 * IMPORTANTE: Saída = AVISO apenas (não DROP automático). Clustering de tema
 * é decisão editorial — às vezes o editor QUER mostrar profundidade num tema.
 *
 * Algoritmo:
 *   - Pré-computar tokens (Jaccard) + empresas para todos os itens.
 *   - Pass 1 (cluster intra-secundários): para cada par (i, j) de secundários,
 *     checar Jaccard e empresa compartilhada. Agrupar por componente conectado.
 *     Emitir aviso quando cluster tem ≥2 membros.
 *   - Pass 2 (secundário vs destaque): para cada secundário, checar contra
 *     todos os destaques com threshold mais alto (0.25 base + empresa → 0.15).
 *     Só emite aviso quando Jaccard abaixo do threshold do dedup-intra-edition
 *     (0.45) — acima disso o dedup já teria removido.
 *
 * Uso:
 *   npx tsx scripts/check-intra-themes.ts \
 *     --categorized data/editions/260626/_internal/01-categorized.json \
 *     [--destaque-count 3] \
 *     [--out-json data/editions/260626/_internal/01-intra-theme-check.json]
 *
 * Output JSON:
 *   {
 *     "theme_clusters": [
 *       {
 *         "theme": "agentes de ia",
 *         "items": [
 *           { "url": "...", "title": "...", "bucket": "radar" },
 *           { "url": "...", "title": "...", "bucket": "radar" },
 *           { "url": "...", "title": "...", "bucket": "lancamento" }
 *         ],
 *         "cluster_size": 3
 *       }
 *     ],
 *     "secondary_vs_highlight": [
 *       {
 *         "secondary_url": "...",
 *         "secondary_title": "...",
 *         "secondary_bucket": "radar",
 *         "highlight_title": "...",
 *         "highlight_rank": 3,
 *         "jaccard": 0.22,
 *         "shared_companies": ["google"],
 *         "note": "Jaccard abaixo do threshold dedup-intra (0.45) — não removido, mas tema similar"
 *       }
 *     ],
 *     "candidates_checked": 12,
 *     "highlights_checked": 3
 *   }
 *
 * Exit codes:
 *   0 — sempre (warnings são non-fatal — gate decide)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { runMain } from "./lib/exit-handler.ts";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import {
  tokenizeForJaccard,
  jaccardSimilarity,
} from "./dedup.ts";
import {
  INTRA_JACCARD_THRESHOLD,
  highlightTitle,
  highlightUrl,
  DEFAULT_INTRA_DESTAQUE_COUNT,
} from "./dedup-intra-edition.ts";
import {
  extractCompaniesFromText,
  SECONDARY_BUCKETS,
  CategorizedJson,
} from "./check-secondary-themes.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Article and HighlightEntry are kept local — needed for internal type casts
// (CategorizedJson.highlights uses CategorizedHighlight from check-secondary-themes
// while highlightTitle/highlightUrl from dedup-intra-edition expect this shape).
interface Article {
  url: string;
  title?: string;
  [key: string]: unknown;
}

interface HighlightEntry {
  rank?: number;
  url?: string;
  title?: string;
  article?: Article;
  [key: string]: unknown;
}

export interface IntraClusterItem {
  url: string;
  title: string;
  bucket: string;
}

export interface ThemeCluster {
  theme: string;           // Descrição do tema (empresa ou token mais frequente)
  items: IntraClusterItem[];
  cluster_size: number;
}

export interface SecondaryVsHighlightWarning {
  secondary_url: string;
  secondary_title: string;
  secondary_bucket: string;
  highlight_title: string;
  highlight_rank: number;
  highlight_url: string;
  jaccard: number;
  shared_companies: string[];
  note: string;
}

export interface CheckIntraThemesResult {
  theme_clusters: ThemeCluster[];
  secondary_vs_highlight: SecondaryVsHighlightWarning[];
  candidates_checked: number;
  highlights_checked: number;
}

/**
 * #2705: mapper explícito em vez de `as unknown as HighlightEntry[]` — o cast amplo
 * silenciava TODA checagem estrutural entre `CategorizedJson["highlights"]` (raw,
 * `article.url` opcional) e o local `HighlightEntry` (article.url obrigatório, exigido
 * por `highlightTitle`/`highlightUrl` de dedup-intra-edition.ts), não só essa incompat
 * documentada. `NonNullable<...>[number]` evita ter que importar diretamente o
 * tipo `Highlight` (#2834: agora em lib/types/categorized-json.ts, reexportado
 * via check-secondary-themes.ts como parte de `CategorizedJson`).
 * Comportamento idêntico ao cast anterior: só promove `article` quando `article.url`
 * existe; senão omite `article` (highlightUrl/highlightTitle caem no fallback `h.url`/`h.title`).
 */
type RawHighlight = NonNullable<CategorizedJson["highlights"]>[number];

function toHighlightEntry(h: RawHighlight): HighlightEntry {
  const { article, ...rest } = h;
  return {
    ...rest,
    article: article?.url ? { url: article.url, title: article.title } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Threshold Jaccard para cluster intra-secundários. Permissivo pois
 *  comparamos artigos sobre mesmo tema mas de fontes/ângulos diferentes. */
const CLUSTER_JACCARD_THRESHOLD = 0.35;

/** Threshold reduzido quando há empresa compartilhada entre dois secundários. */
const CLUSTER_JACCARD_WITH_COMPANY = 0.20;

/** Número mínimo de itens no cluster para sinalizar.
 *  Caso real #2597: 3 itens sobre agentes de IA. */
const CLUSTER_MIN_SIZE = 2;

/** Mínimo de itens que precisam compartilhar a mesma keyword temática
 *  para gerar um keyword-cluster (independente de Jaccard pairwise).
 *  Cobre o caso "agentes de IA" onde Jaccard é baixo mas o token-chave
 *  aparece em todos os títulos. */
const KEYWORD_CLUSTER_MIN = 3;

/** Threshold base para sinalizar secundário com tema similar a destaque.
 *  Propositalmente abaixo do INTRA_JACCARD_THRESHOLD (0.45) para pegar
 *  casos que o dedup não removeu mas que o editor pode querer avaliar.
 *  Com empresa compartilhada, cai para SECONDARY_HL_JACCARD_WITH_COMPANY. */
const SECONDARY_HL_JACCARD_THRESHOLD = 0.25;
const SECONDARY_HL_JACCARD_WITH_COMPANY = 0.15;

// ---------------------------------------------------------------------------
// Union-Find para agrupamento de clusters
// ---------------------------------------------------------------------------

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(x: number, y: number): void {
    const px = this.find(x), py = this.find(y);
    if (px !== py) this.parent[px] = py;
  }
  groups(): Map<number, number[]> {
    const g = new Map<number, number[]>();
    for (let i = 0; i < this.parent.length; i++) {
      const root = this.find(i);
      const list = g.get(root) ?? [];
      list.push(i);
      g.set(root, list);
    }
    return g;
  }
}

// ---------------------------------------------------------------------------
// Theme label: token mais frequente não-stopword no cluster
// ---------------------------------------------------------------------------

const THEME_STOPWORDS = new Set([
  "como", "para", "sobre", "mais", "novo", "nova", "este", "esta",
  "what", "with", "that", "this", "your", "from", "into", "also",
  "anuncia", "lanca", "lança", "apresenta", "libera", "lança",
]);

function extractThemeLabel(titles: string[]): string {
  const freq = new Map<string, number>();
  for (const t of titles) {
    for (const tok of tokenizeForJaccard(t)) {
      if (THEME_STOPWORDS.has(tok)) continue;
      freq.set(tok, (freq.get(tok) ?? 0) + 1);
    }
  }
  // Pegar os 3 tokens mais frequentes
  const sorted = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([tok]) => tok);
  return sorted.join(", ") || "tema não identificado";
}

// ---------------------------------------------------------------------------
// Main check function
// ---------------------------------------------------------------------------

/**
 * Lê o categorized.json e detecta clusters temáticos intra-edição.
 */
export function checkIntraThemes(
  data: CategorizedJson,
  destaqueCount: number = DEFAULT_INTRA_DESTAQUE_COUNT,
): CheckIntraThemesResult {
  // Coletar secundários
  const secondaryItems: IntraClusterItem[] = [];
  for (const bucket of SECONDARY_BUCKETS) {
    const entries = data[bucket] as Article[] | undefined;
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (e.title && e.url) {
        secondaryItems.push({ url: e.url, title: e.title.trim(), bucket });
      }
    }
  }

  // Coletar destaques (top N por rank). Mapper explícito (#2705) — ver toHighlightEntry.
  const allHighlights = (data.highlights ?? []).map(toHighlightEntry);
  const topHighlights = [...allHighlights]
    .sort((a, b) => {
      const ra = typeof a.rank === "number" ? a.rank : 999;
      const rb = typeof b.rank === "number" ? b.rank : 999;
      return ra - rb;
    })
    .slice(0, destaqueCount);

  // Pré-computar tokens/companies para secundários
  interface SecondaryIndex {
    item: IntraClusterItem;
    tokens: Set<string>;
    companies: Set<string>;
  }
  const secIndex: SecondaryIndex[] = secondaryItems.map((item) => ({
    item,
    tokens: tokenizeForJaccard(item.title),
    companies: extractCompaniesFromText(item.title),
  }));

  // ── Pass 1: cluster intra-secundários ─────────────────────────────────────
  const n = secIndex.length;
  const uf = new UnionFind(n);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = secIndex[i];
      const b = secIndex[j];
      if (a.tokens.size === 0 || b.tokens.size === 0) continue;

      const sharedCompanies: string[] = [];
      for (const c of a.companies) {
        if (b.companies.has(c)) sharedCompanies.push(c);
      }
      const threshold = sharedCompanies.length > 0
        ? CLUSTER_JACCARD_WITH_COMPANY
        : CLUSTER_JACCARD_THRESHOLD;

      const jaccard = jaccardSimilarity(a.tokens, b.tokens);
      if (jaccard >= threshold) {
        uf.union(i, j);
      }
    }
  }

  const theme_clusters: ThemeCluster[] = [];

  // Pass 1a: clusters por Jaccard/empresa (UnionFind)
  for (const [, members] of uf.groups()) {
    if (members.length < CLUSTER_MIN_SIZE) continue;
    const clusterItems = members.map((idx) => secIndex[idx].item);
    const theme = extractThemeLabel(clusterItems.map((it) => it.title));
    theme_clusters.push({
      theme,
      items: clusterItems,
      cluster_size: clusterItems.length,
    });
  }

  // Pass 1b: clusters por keyword frequente (#2597 — "agentes de IA").
  // Jaccard pairwise é baixo quando itens compartilham 1 keyword temática mas
  // divergem em vocabulário geral (ex: 1/9 ≈ 0.11). Solução: inverter o índice:
  // para cada token significativo, verificar quais itens o contêm; se ≥ N,
  // emitir cluster. Evitar duplicação com clusters da Pass 1a.
  {
    // Tokens que não discriminam tema (muito comuns no domínio IA/tech)
    const KEYWORD_STOPWORDS = new Set([
      // THEME_STOPWORDS expandido com termos de frequência alta no corpus
      ...THEME_STOPWORDS,
      "empresa", "empresas", "tech", "tecnologia", "uso", "usar", "usar",
      "novo", "novos", "nova", "novas", "anos", "todo", "todas", "todos",
      "pode", "devem", "sera", "vai", "vao", "tem", "sao", "quando",
      "2025", "2026", "2027",
    ]);

    // Construir índice invertido: token → lista de índices de secundários
    const tokenToIndices = new Map<string, number[]>();
    for (let i = 0; i < secIndex.length; i++) {
      for (const tok of secIndex[i].tokens) {
        if (tok.length < 5) continue; // tokens curtos não discriminam
        if (KEYWORD_STOPWORDS.has(tok)) continue;
        const list = tokenToIndices.get(tok) ?? [];
        list.push(i);
        tokenToIndices.set(tok, list);
      }
    }

    // URLs já no cluster de Pass 1a — evitar duplicar no keyword-cluster
    const alreadyClustered = new Set(
      theme_clusters.flatMap((c) => c.items.map((it) => it.url)),
    );

    // Tokens com ≥ KEYWORD_CLUSTER_MIN itens → keyword cluster
    const seenKeywordClusters = new Set<string>(); // evitar emitir mesmo grupo várias vezes
    for (const [tok, indices] of tokenToIndices) {
      if (indices.length < KEYWORD_CLUSTER_MIN) continue;
      // Ordenar e criar chave canônica pra dedup de cluster
      const sortedIndices = [...new Set(indices)].sort((a, b) => a - b);
      const clusterKey = sortedIndices.join(",");
      if (seenKeywordClusters.has(clusterKey)) continue;
      seenKeywordClusters.add(clusterKey);

      const clusterItems = sortedIndices.map((idx) => secIndex[idx].item);
      // Só emitir se há ao menos 1 item NÃO coberto pela Pass 1a.
      // Caso "2-alto+1" (#2629): 2 itens já pareados pelo Jaccard (Pass 1a) + 1 novo
      // compartilha keyword → total = 3 (>= KEYWORD_CLUSTER_MIN) e newItems = 1 → emite.
      // Se todos os itens já estão no Pass 1a (newItems = 0), o Pass 1a já sinalizou
      // esses itens → não duplicar.
      const newItems = clusterItems.filter((it) => !alreadyClustered.has(it.url));
      if (newItems.length < 1) continue;

      // Evitar aviso duplicado: remover clusters do Pass 1a que são subconjuntos
      // deste cluster (todos os seus itens já estão cobertos aqui com contagem total).
      const clusterUrlSet = new Set(clusterItems.map((it) => it.url));
      for (let i = theme_clusters.length - 1; i >= 0; i--) {
        if (theme_clusters[i].items.every((it) => clusterUrlSet.has(it.url))) {
          theme_clusters.splice(i, 1);
        }
      }

      theme_clusters.push({
        theme: tok,
        items: clusterItems, // todos, incluindo os já em cluster 1a (melhor contexto)
        cluster_size: clusterItems.length,
      });

      // #2715 item 4: registrar os itens deste keyword-cluster em `alreadyClustered`
      // ANTES de avaliar o próximo token do índice invertido. Sem isso, dois
      // keyword-clusters que compartilham itens já pareados no Pass 1a (ex:
      // 'openai' e 'gpt' cobrindo A,B do Pass 1a + C e D respectivamente, cada
      // um) calculam `newItems` contra o MESMO snapshot pré-loop — ambos veem
      // newItems.length >= 1 e ambos emitem, duplicando o aviso sobre A,B.
      for (const it of clusterItems) alreadyClustered.add(it.url);
    }
  }

  // ── Pass 2: secundário vs destaque (tema similar mas abaixo do dedup-intra) ─
  const secondary_vs_highlight: SecondaryVsHighlightWarning[] = [];

  for (const { item, tokens: sTokens, companies: sCompanies } of secIndex) {
    if (sTokens.size === 0) continue;

    for (const h of topHighlights) {
      const hTitle = highlightTitle(h);
      if (!hTitle) continue;

      const hUrl = highlightUrl(h);
      // Skip exact-same URL
      if (hUrl && item.url === hUrl) continue;

      const hTokens = tokenizeForJaccard(hTitle);
      if (hTokens.size === 0) continue;

      const hCompanies = extractCompaniesFromText(hTitle);
      const sharedCompanies: string[] = [];
      for (const c of sCompanies) {
        if (hCompanies.has(c)) sharedCompanies.push(c);
      }

      const threshold = sharedCompanies.length > 0
        ? SECONDARY_HL_JACCARD_WITH_COMPANY
        : SECONDARY_HL_JACCARD_THRESHOLD;

      const jaccard = jaccardSimilarity(sTokens, hTokens);

      // Só sinalizar quando: acima do threshold de aviso E abaixo do threshold
      // do dedup-intra (0.45) — acima disso já teria sido removido.
      if (jaccard >= threshold && jaccard < INTRA_JACCARD_THRESHOLD) {
        const hRank = typeof h.rank === "number" ? h.rank : 0;
        secondary_vs_highlight.push({
          secondary_url: item.url,
          secondary_title: item.title,
          secondary_bucket: item.bucket,
          highlight_title: hTitle,
          highlight_rank: hRank,
          highlight_url: hUrl ?? "",
          jaccard: Math.round(jaccard * 100) / 100,
          shared_companies: sharedCompanies,
          note: `Jaccard ${Math.round(jaccard * 100)}% (abaixo do threshold dedup-intra ${Math.round(INTRA_JACCARD_THRESHOLD * 100)}%) — não removido, mas tema similar ao D${hRank}`,
        });
        break; // Um match por secundário é suficiente
      }
    }
  }

  return {
    theme_clusters,
    secondary_vs_highlight,
    candidates_checked: secondaryItems.length,
    highlights_checked: topHighlights.length,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2)).values;

  const categorizedPath = args["categorized"];
  const destaqueCount = parseInt(
    args["destaque-count"] ?? String(DEFAULT_INTRA_DESTAQUE_COUNT),
    10,
  );
  const outJson = args["out-json"];

  if (!categorizedPath) {
    console.error(
      "Uso: check-intra-themes.ts --categorized <path> [--destaque-count 3] [--out-json <path>]",
    );
    process.exit(1);
  }

  if (!existsSync(categorizedPath)) {
    console.error(`[check-intra-themes] WARN: ${categorizedPath} não encontrado — skip.`);
    const empty: CheckIntraThemesResult = {
      theme_clusters: [],
      secondary_vs_highlight: [],
      candidates_checked: 0,
      highlights_checked: 0,
    };
    if (outJson) {
      writeFileSync(resolve(outJson), JSON.stringify(empty, null, 2), "utf8");
    } else {
      process.stdout.write(JSON.stringify(empty, null, 2) + "\n");
    }
    return;
  }

  let data: CategorizedJson;
  try {
    data = JSON.parse(readFileSync(categorizedPath, "utf8")) as CategorizedJson;
  } catch (e) {
    console.error(`[check-intra-themes] Erro ao ler ${categorizedPath}: ${(e as Error).message}`);
    process.exit(1);
  }

  const result = checkIntraThemes(data, destaqueCount);

  if (result.theme_clusters.length > 0) {
    for (const cluster of result.theme_clusters) {
      const titles = cluster.items.map((it) => `"${it.title}" (${it.bucket})`).join("; ");
      console.error(
        `[check-intra-themes] ⚠️  Cluster temático "${cluster.theme}" (${cluster.cluster_size} itens): ${titles}`,
      );
    }
  }

  if (result.secondary_vs_highlight.length > 0) {
    for (const w of result.secondary_vs_highlight) {
      console.error(
        `[check-intra-themes] ⚠️  "${w.secondary_title}" (${w.secondary_bucket}) tema similar ao D${w.highlight_rank} "${w.highlight_title}" (Jaccard=${w.jaccard}, empresas=[${w.shared_companies.join(",")}])`,
      );
    }
  }

  if (result.theme_clusters.length === 0 && result.secondary_vs_highlight.length === 0) {
    console.error(
      `[check-intra-themes] ✓ ${result.candidates_checked} secundário(s) vs ${result.highlights_checked} destaque(s) — nenhum cluster temático detectado.`,
    );
  }

  const json = JSON.stringify(result, null, 2);
  if (outJson) {
    writeFileSync(resolve(outJson), json, "utf8");
    console.error(`[check-intra-themes] Wrote ${outJson}`);
  } else {
    process.stdout.write(json + "\n");
  }
}

if (isMainModule(import.meta.url)) {
  runMain(main);
}
