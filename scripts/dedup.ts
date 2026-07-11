/**
 * dedup.ts
 *
 * Remove artigos duplicados da lista de candidatos.
 * Dois passes:
 *   1. Contra `past-editions.md` — URL canônica (últimas N edições)
 *   2. Dentro da própria lista — URL canônica + similaridade de título
 *
 * Uso:
 *   npx tsx scripts/dedup.ts --articles <articles.json> --past-editions data/past-editions.md [--window 3] [--title-threshold 0.85] [--out <out.json>]
 *
 * Input:  array JSON de artigos (cada um com ao menos { url, title? })
 * Output: { kept: Article[], removed: RemovedEntry[] }
 */

import { readFileSync, writeFileSync } from "node:fs";
import { isAggregator } from "./lib/aggregators";
import { isEditoriallyBlocked } from "./lib/editorial-blocklist.ts";
import { CONFIG } from "./lib/config.ts";
import { canonicalize } from "./lib/url-utils.ts";
import { runMain } from "./lib/exit-handler.ts";
import { logEvent } from "./lib/run-log.ts";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import {
  detectEntityDuplicates,
  extractPastHighlights,
} from "./lib/entity-dedup.ts";
// #2833: extraido pra scripts/lib/title-similarity.ts (movimentacao pura) --
// re-exportado abaixo pra manter compat com importadores existentes.
import {
  normalizeTitle,
  titleSimilarity,
  tokenizeForJaccard,
  jaccardSimilarity,
  subjectSimilarity,
  extractNamedEntities,
  thresholdForPair,
} from "./lib/title-similarity.ts";
// #2833: extraido pra scripts/lib/past-editions-extract.ts (movimentacao
// pura) -- re-exportado abaixo pra manter compat com importadores existentes.
import {
  isValidEditionDir,
  DEFAULT_PAST_WINDOW,
  readPastEditionsMd,
  extractPastUrls,
  extractPastUrlsUnbounded,
  extractPastTitles,
  extractPastThemeEntities,
  matchesRecentTheme,
  readReviewedDestaqueUrls,
  readNewsletterHtmlDestaqueUrls,
  recentEditionDirs,
  deriveCurrentEdition,
  extractPastDestaqueUrls,
  extractPastEditionArticleTitles,
} from "./lib/past-editions-extract.ts";
// #2833: extraido pra scripts/lib/inbox-title-resolve.ts (movimentacao pura)
// -- re-exportado abaixo pra manter compat com importadores existentes.
import {
  needsTitleResolution,
  fetchTitle,
  resolveInboxTitles,
} from "./lib/inbox-title-resolve.ts";

export { canonicalize };
export {
  normalizeTitle,
  titleSimilarity,
  tokenizeForJaccard,
  jaccardSimilarity,
  subjectSimilarity,
  extractNamedEntities,
  thresholdForPair,
};
export {
  isValidEditionDir,
  DEFAULT_PAST_WINDOW,
  readPastEditionsMd,
  extractPastUrls,
  extractPastUrlsUnbounded,
  extractPastTitles,
  extractPastThemeEntities,
  matchesRecentTheme,
  readReviewedDestaqueUrls,
  readNewsletterHtmlDestaqueUrls,
  recentEditionDirs,
  deriveCurrentEdition,
  extractPastDestaqueUrls,
  extractPastEditionArticleTitles,
};
export { needsTitleResolution, fetchTitle, resolveInboxTitles };

// URL canonicalization -- centralizada em scripts/lib/url-utils.ts (#523)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main dedup logic
// ---------------------------------------------------------------------------

interface Article {
  url: string;
  title?: string;
  source?: string;
  discovered_source?: boolean;
  [key: string]: unknown;
}

interface RemovedEntry {
  url: string;
  title?: string;
  dedup_note: string;
}

export function dedup(
  articles: Article[],
  pastUrlsSet: Set<string>,
  titleThreshold: number,
  pastTitles: string[] = [],
  titleVsPastThreshold = 0.70,
  pastArticleTitles: string[] = [],
  subjectVsPastThreshold = 0.6,
  // #1068: URLs que foram destaques (highlights) em edições passadas.
  // Quando fornecido, dedup distingue:
  //   - URL em pastDestaqueUrlsSet → bloqueia (já foi destaque, evita repetição)
  //   - URL em pastUrlsSet mas NÃO em pastDestaqueUrlsSet → permite
  //     (foi só secondary passado, permite promoção a destaque agora)
  // Quando ausente (legacy callers), comportamento antigo: bloqueia tudo em pastUrlsSet.
  pastDestaqueUrlsSet?: Set<string>,
  // #1331: threshold mais permissivo quando candidato e past compartilham
  // entidades nomeadas (default 0.55 vs 0.6 do baseline). Cobre cross-domain
  // duplicates onde vocabulário diverge mas entidades coincidem.
  subjectVsPastThresholdLowered = 0.55,
  pastThemeEntities: Set<string> = new Set(),
  // #1492: past highlights for entity-based dedup. When provided, articles
  // sharing 2+ entities (1 named + 1 numeric) with a past highlight are
  // flagged as entity_duplicate. Catches same-event coverage across
  // different URLs/titles (e.g., "DeepSeek corta 75%" vs "IA concorrente
  // do Gemini derruba preco em 75%").
  pastHighlights: { title: string; url: string; themes?: string[] }[] = [],
): { kept: Article[]; removed: RemovedEntry[] } {
  const kept: Article[] = [];
  const removed: RemovedEntry[] = [];

  // ---- Pass 0: reject aggregator URLs + blacklist editorial (safety net) --
  const afterPass0: Article[] = [];
  let pass0Rejected = 0;
  let pass0Editorial = 0;
  for (const art of articles) {
    if (isAggregator(art.url)) {
      removed.push({ url: art.url, title: art.title, dedup_note: "agregador/roundup bloqueado (use fonte primária)" });
      pass0Rejected++;
    } else if (isEditoriallyBlocked(art.url)) {
      // #1760: fonte que o editor decidiu não incluir (ex: simonwillison.net).
      removed.push({ url: art.url, title: art.title, dedup_note: "fonte em blacklist editorial (#1760)" });
      pass0Editorial++;
    } else {
      afterPass0.push(art);
    }
  }
  if (pass0Rejected > 0) {
    console.error(`dedup Pass-0: ${pass0Rejected} URL(s) de agregador/roundup rejeitadas`);
  }
  if (pass0Editorial > 0) {
    console.error(`dedup Pass-0: ${pass0Editorial} URL(s) de fonte em blacklist editorial rejeitadas (#1760)`);
  }

  // ---- Pass 1: dedup against past editions (URL only) --------------------
  // #1068: quando pastDestaqueUrlsSet fornecido, distingue destaque-passado
  // (bloqueia sempre) vs só-secondary-passado (permite promoção). Quando
  // ausente, comportamento legacy: bloqueia tudo em pastUrlsSet.
  const afterPass1: Article[] = [];
  let promotedFromSecondary = 0;
  for (const art of afterPass0) {
    const canon = canonicalize(art.url);
    const wasInPast = pastUrlsSet.has(canon);
    if (!wasInPast) {
      afterPass1.push(art);
      continue;
    }
    // #1512: removed #1068 secondary→destaque promotion at dedup time.
    // URL that appeared in ANY past edition is blocked — same URL in a
    // published newsletter should never re-appear regardless of section.
    removed.push({ url: art.url, title: art.title, dedup_note: "url-match com edição anterior" });
  }
  // #1512: promotedFromSecondary counter removed — promotion no longer applies.

  // ---- Pass 1b: title similarity vs past edition headlines (#231 defense-in-depth) ---
  // Threshold mais permissivo (0.70 vs 0.85 dentro da lista) — títulos de newsletter
  // diferem em idioma/ângulo mas evento idêntico deve ter sim > 0.70.
  // Só roda se pastTitles foi fornecido (backward-compat).
  const afterPass1b: Article[] = [];
  if (pastTitles.length > 0) {
    for (const art of afterPass1) {
      if (!art.title) {
        afterPass1b.push(art);
        continue;
      }
      let isDupVsPast = false;
      for (const pastTitle of pastTitles) {
        const sim = titleSimilarity(art.title, pastTitle);
        if (sim >= titleVsPastThreshold) {
          removed.push({
            url: art.url,
            title: art.title,
            dedup_note: `título similar (${(sim * 100).toFixed(0)}%) ao headline de edição anterior "${pastTitle}"`,
          });
          isDupVsPast = true;
          break;
        }
      }
      if (!isDupVsPast) afterPass1b.push(art);
    }
    if (afterPass1.length > afterPass1b.length) {
      console.error(`dedup Pass-1b: ${afterPass1.length - afterPass1b.length} artigo(s) removido(s) por similaridade com headline de edição anterior`);
    }
  } else {
    afterPass1b.push(...afterPass1);
  }

  // ---- Pass 1c: subject (Jaccard) similarity vs past edition ARTICLES (#897) ---
  // Diferença pra Pass-1b: 1b compara contra o headline-da-newsletter (1 título
  // por edição, normalmente o destaque #1). 1c compara contra TODOS os artigos
  // cobertos na edição (highlights + runners_up + buckets). Pega o caso "fonte
  // diferente, mesma history" que vazaria pelos outros passes.
  //
  // Jaccard em vez de Levenshtein: mais permissivo pra PT-BR vs EN — sobreposição
  // de entidades/produtos domina. Threshold default 0.6.
  //
  // Só roda quando pastArticleTitles foi fornecido (backward-compat).
  const afterPass1c: Article[] = [];
  if (pastArticleTitles.length > 0) {
    // Pré-tokenizar past titles uma vez — caro recomputar pra cada artigo.
    const pastTokens = pastArticleTitles.map((t) => ({
      title: t,
      tokens: tokenizeForJaccard(t),
    }));
    for (const art of afterPass1b) {
      if (!art.title) {
        afterPass1c.push(art);
        continue;
      }
      const candidateTokens = tokenizeForJaccard(art.title);
      // Títulos sem tokens significativos (curtos/vazios) não disparam
      // — Jaccard contra qualquer set vazio = 0.
      if (candidateTokens.size === 0) {
        afterPass1c.push(art);
        continue;
      }
      let isDupVsPastSubject = false;
      let bestMatch: { title: string; sim: number; entitiesShared: string[]; effectiveThreshold: number } | null = null;
      for (const pt of pastTokens) {
        const sim = jaccardSimilarity(candidateTokens, pt.tokens);
        // #1331: lower threshold (default 0.55) quando candidato e past
        // compartilham entidades nomeadas. Sem entity overlap, mantém 0.6.
        const { threshold: effThreshold, sharedEntities } = thresholdForPair(
          art.title,
          pt.title,
          subjectVsPastThreshold,
          subjectVsPastThresholdLowered,
        );
        if (sim >= effThreshold && (bestMatch === null || sim > bestMatch.sim)) {
          bestMatch = {
            title: pt.title,
            sim,
            entitiesShared: sharedEntities,
            effectiveThreshold: effThreshold,
          };
        }
      }
      if (bestMatch !== null) {
        const entitiesNote = bestMatch.entitiesShared.length > 0
          ? ` [entidade compartilhada: ${bestMatch.entitiesShared.join(", ")}]`
          : "";
        removed.push({
          url: art.url,
          title: art.title,
          dedup_note: `subject similar (${(bestMatch.sim * 100).toFixed(0)}% Jaccard, threshold ${bestMatch.effectiveThreshold}) a artigo de edição anterior "${bestMatch.title}"${entitiesNote}`,
        });
        isDupVsPastSubject = true;
      }
      if (!isDupVsPastSubject) afterPass1c.push(art);
    }
    if (afterPass1b.length > afterPass1c.length) {
      console.error(
        `dedup Pass-1c (#897): ${afterPass1b.length - afterPass1c.length} artigo(s) removido(s) por subject-Jaccard >= ${subjectVsPastThreshold} contra título de artigo em edição anterior`,
      );
    }
  } else {
    afterPass1c.push(...afterPass1b);
  }

  // ---- Pass 1d: theme-entity match vs past edition themes (#1475) ---------
  // Bloqueia artigos cujo título/summary contém entidade-chave de um highlight
  // recente, mesmo se URL e Jaccard divergem. Caso real 260525: "SoberanIA"
  // era destaque na 260522 com URL diferente e Jaccard baixo (~0.14).
  const afterPass1d: Article[] = [];
  if (pastThemeEntities.size > 0) {
    for (const art of afterPass1c) {
      const matchedEntity = matchesRecentTheme(
        art.title ?? "",
        String(art.summary ?? ""),
        pastThemeEntities,
      );
      if (matchedEntity) {
        removed.push({
          url: art.url,
          title: art.title,
          dedup_note: `theme-entity match: "${matchedEntity}" apareceu em highlight de edição recente (#1475)`,
        });
      } else {
        afterPass1d.push(art);
      }
    }
    if (afterPass1c.length > afterPass1d.length) {
      console.error(
        `dedup Pass-1d (#1475): ${afterPass1c.length - afterPass1d.length} artigo(s) removido(s) por theme-entity match contra edição anterior`,
      );
    }
  } else {
    afterPass1d.push(...afterPass1c);
  }

  // ---- Pass 1e: entity-based dedup vs past highlights (#1492) -------------
  // Catches same-event coverage across different URLs and titles by
  // extracting named entities (companies, models) and numeric entities
  // (percentages, monetary values) from both the candidate and past
  // highlights. Flags when an article shares at least 1 named + 1 numeric
  // entity with a highlight from a recent edition.
  const afterPass1e: Article[] = [];
  if (pastHighlights.length > 0) {
    const entityMatches = detectEntityDuplicates(afterPass1d, pastHighlights);
    const matchedUrls = new Set(entityMatches.map((m) => m.url));
    for (const art of afterPass1d) {
      if (matchedUrls.has(art.url)) {
        const match = entityMatches.find((m) => m.url === art.url)!;
        removed.push({
          url: art.url,
          title: art.title,
          dedup_note: `entity_duplicate: compartilha entidades [${match.sharedEntities.join(", ")}] com highlight "${match.matchedHighlight}" de edição anterior (#1492)`,
        });
      } else {
        afterPass1e.push(art);
      }
    }
    if (afterPass1d.length > afterPass1e.length) {
      console.error(
        `dedup Pass-1e (#1492): ${afterPass1d.length - afterPass1e.length} artigo(s) removido(s) por entity-duplicate contra highlight de edição anterior`,
      );
    }
  } else {
    afterPass1e.push(...afterPass1d);
  }

  // ---- Pass 2: dedup within the current list -----------------------------
  // Sub-pass 2a: group by canonical URL, keep best per group
  const byUrl = new Map<string, Article[]>();
  for (const art of afterPass1e) {
    const canon = canonicalize(art.url);
    const group = byUrl.get(canon) ?? [];
    group.push(art);
    byUrl.set(canon, group);
  }

  const afterUrlDedup: Article[] = [];
  for (const [, group] of byUrl) {
    if (group.length === 1) {
      afterUrlDedup.push(group[0]);
      continue;
    }
    // Keep the best: prefer registered source (no discovered_source flag) + longest title
    const sorted = [...group].sort((a, b) => {
      const aDisc = a.discovered_source ? 1 : 0;
      const bDisc = b.discovered_source ? 1 : 0;
      if (aDisc !== bDisc) return aDisc - bDisc; // non-discovered first
      return (b.title?.length ?? 0) - (a.title?.length ?? 0);
    });
    afterUrlDedup.push(sorted[0]);
    for (let i = 1; i < sorted.length; i++) {
      removed.push({ url: sorted[i].url, title: sorted[i].title, dedup_note: `url-duplicado na lista (mantido: ${sorted[0].url})` });
    }
  }

  // Sub-pass 2b: title similarity dedup
  for (let i = 0; i < afterUrlDedup.length; i++) {
    const artI = afterUrlDedup[i];
    if (!artI.title) {
      kept.push(artI);
      continue;
    }
    let isDup = false;
    for (let j = 0; j < i; j++) {
      const artJ = afterUrlDedup[j];
      if (!artJ.title) continue;
      // #482: artigos inbox têm título "(inbox)" — não comparar por título;
      // deduplicação real já foi feita por URL na sub-pass 2a.
      if (
        artI.title.toLowerCase() === "(inbox)" ||
        artJ.title.toLowerCase() === "(inbox)"
      ) continue;
      const sim = titleSimilarity(artI.title, artJ.title);
      if (sim >= titleThreshold) {
        // Keep the one from a registered source; in a tie, keep artJ (already in kept)
        const iIsDisc = artI.discovered_source ? 1 : 0;
        const jIsDisc = artJ.discovered_source ? 1 : 0;
        if (iIsDisc >= jIsDisc) {
          // artI is worse or equal — remove it
          removed.push({
            url: artI.url,
            title: artI.title,
            dedup_note: `título similar (${(sim * 100).toFixed(0)}%) ao de "${artJ.title}" (${artJ.url})`,
          });
          isDup = true;
          break;
        } else {
          // artI is from a registered source, artJ is discovered — swap: remove artJ
          // But artJ is already in kept... flag it for removal retroactively
          const jIdx = kept.findIndex((a) => a.url === artJ.url);
          if (jIdx !== -1) {
            removed.push({
              url: artJ.url,
              title: artJ.title,
              dedup_note: `título similar (${(sim * 100).toFixed(0)}%) ao de "${artI.title}" (${artI.url}) — fonte cadastrada preferida`,
            });
            kept.splice(jIdx, 1);
          }
          // artI will be added below
        }
      }
    }
    if (!isDup) kept.push(artI);
  }

  return { kept, removed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  // #926: usar parser compartilhado em vez de reinventar.
  const args = parseCliArgs(process.argv.slice(2)).values;

  const articlesPath = args["articles"];
  // #1887: `--past-editions` explícito ausente = wiring error (fail loud);
  // default ausente = bootstrap (histórico vazio).
  const pastEditionsExplicit = args["past-editions"] !== undefined;
  const pastEditionsPath = args["past-editions"] ?? "data/past-editions.md";
  const window = parseInt(args["window"] ?? String(DEFAULT_PAST_WINDOW), 10);
  const titleThreshold = parseFloat(args["title-threshold"] ?? String(CONFIG.dedup.titleThreshold));
  const outPath = args["out"];
  // #3311: override SÓ pra isolamento de teste — repassado ao logEvent de
  // auditoria abaixo. Sem essa flag, logEvent cai no default process.cwd()
  // — inofensivo em produção (roda da raiz do repo), mas testes que spawnam
  // este CLI via subprocess sem isolar cwd (test/dedup-input-shape.test.ts)
  // gravavam entries fabricadas direto em data/run-log.jsonl REAL do
  // worktree a cada test run. Mesmo padrão de --log-root-dir em
  // resolve-edition-url.ts (#3310).
  const logRootDir = args["log-root-dir"];

  if (!articlesPath) {
    console.error("Uso: dedup.ts --articles <articles.json> [--past-editions <path>] [--editions-dir data/editions] [--current-edition AAMMDD] [--window 3] [--title-threshold 0.85] [--title-vs-past-threshold 0.70] [--subject-vs-past-threshold 0.60] [--out <out.json>]");
    process.exit(1);
  }

  // #1268: aceitar array raw OU objeto wrapped `{articles, expanded?, warnings?}`
  // (output do expand-inbox-aggregators.ts e propagado por enrich-inbox-articles.ts).
  // Sem este guard, dedup crashava com "articles.filter is not a function" — erro
  // confuso quando o caller passa output direto de expand-inbox sem unwrap.
  const parsedInput = JSON.parse(readFileSync(articlesPath, "utf8"));
  const articles: Article[] = Array.isArray(parsedInput)
    ? parsedInput
    : Array.isArray(parsedInput?.articles)
      ? parsedInput.articles
      : (() => {
          console.error(
            `dedup: input ${articlesPath} não é array nem tem campo 'articles[]' — ` +
            `shape inesperado. Keys: ${Object.keys(parsedInput || {}).join(',') || '<none>'}`,
          );
          process.exit(1);
        })();

  // Pre-pass (#485): resolve placeholder titles for inbox articles before dedup
  // so "(inbox)" doesn't cause false-positive title similarity matches.
  const inboxCount = articles.filter((a) => needsTitleResolution(a.title)).length;
  if (inboxCount > 0) {
    console.error(`dedup pre-pass: ${inboxCount} artigo(s) com título placeholder — resolvendo títulos reais...`);
    const { resolved, failed } = await resolveInboxTitles(articles);
    console.error(`dedup pre-pass: ${resolved} título(s) resolvido(s), ${failed} falha(s) (mantidos com placeholder)`);
  }

  // #1847: past-editions.md mora em data/ (gitignored, regenerado no Stage 0) —
  // pode estar AUSENTE num clone fresco / CI antes do primeiro refresh-dedup.
  // Tratar ausência como histórico vazio (mesma semântica do guard #672 abaixo),
  // não crashar com ENOENT. finalize-stage1.ts já fazia esse existsSync-guard.
  const pastMd = readPastEditionsMd(pastEditionsPath, { required: pastEditionsExplicit });
  const pastUrls = extractPastUrls(pastMd, window);
  const pastTitles = extractPastTitles(pastMd, window); // #231 defense-in-depth

  // #672/#1847: guard contra past-editions.md vazio OU ausente (ex: Beehiiv
  // offline em Stage 0d, ou clone fresco sem o arquivo gerado ainda).
  if (pastUrls.size === 0 && pastTitles.length === 0) {
    console.error(
      `WARN [dedup]: past-editions.md sem seções YYYY-MM-DD — histórico vazio. ` +
      `Dedup contra edições anteriores não funcionou. Verificar se scripts/refresh-dedup.ts completou.`,
    );
  }

  const titleVsPastThreshold = parseFloat(args["title-vs-past-threshold"] ?? String(CONFIG.dedup.titleVsPastThreshold));

  // #897: também extrair títulos individuais de artigos de edições passadas
  // pra subject-level dedup. Default: data/editions/ + window edições recentes.
  const editionsDir = args["editions-dir"] ?? "data/editions";
  const subjectVsPastThreshold = parseFloat(
    args["subject-vs-past-threshold"] ?? "0.6",
  );
  // #1331: threshold mais permissivo quando candidato e past compartilham
  // entidades nomeadas. Default 0.55 — entre 0.5 (muito agressivo, false
  // positives em vocabulário coincidente) e 0.6 (baseline).
  const subjectVsPastThresholdLowered = parseFloat(
    args["subject-vs-past-threshold-lowered"] ?? "0.55",
  );
  // #1856: exclui a edição corrente do subject-dedup pra não deduplicar contra o
  // próprio 01-approved.json (self-match quebrava idempotência: re-run/resume
  // removia os próprios destaques). Deriva do --out/--articles quando o caller
  // não passa --current-edition explícito.
  const currentAammdd =
    args["current-edition"] ?? deriveCurrentEdition(outPath, articlesPath);
  if (!args["current-edition"] && currentAammdd) {
    console.error(`[dedup] edição corrente derivada do path: ${currentAammdd} (excluída do subject-dedup #1856)`);
  }
  const pastArticleTitles = extractPastEditionArticleTitles(
    editionsDir,
    window,
    currentAammdd,
  );
  if (pastArticleTitles.length > 0) {
    console.error(
      `dedup: ${pastArticleTitles.length} título(s) de artigos de edições anteriores carregado(s) (#897 subject-dedup)`,
    );
  }

  // #1068: extrair URLs que foram destaques (highlights) em edições passadas.
  // Dedup usa pra permitir promoção secondary→destaque (URL em past mas não
  // como destaque → permite na edição corrente como destaque).
  const pastDestaqueUrls = extractPastDestaqueUrls(
    editionsDir,
    window,
    currentAammdd,
  );
  if (pastDestaqueUrls.size > 0) {
    console.error(
      `dedup: ${pastDestaqueUrls.size} URL(s) de destaques passados carregados (#1068)`,
    );
  }

  // #1475: extrair entidades dos "Temas cobertos:" das edições recentes.
  const pastThemes = extractPastThemeEntities(pastMd, window);
  if (pastThemes.size > 0) {
    console.error(
      `dedup: ${pastThemes.size} entidade(s) de tema carregadas (#1475 theme-dedup)`,
    );
  }

  // #1492: extrair highlights (título + URL) das edições recentes para
  // entity-based dedup. Detecta cobertura duplicada do mesmo evento quando
  // URLs e títulos diferem mas entidades (empresa+número) coincidem.
  const pastHighlightsData = extractPastHighlights(pastMd, window);
  if (pastHighlightsData.length > 0) {
    console.error(
      `dedup: ${pastHighlightsData.length} highlight(s) de edições anteriores carregados (#1492 entity-dedup)`,
    );
  }

  const result = dedup(
    articles,
    pastUrls,
    titleThreshold,
    pastTitles,
    titleVsPastThreshold,
    pastArticleTitles,
    subjectVsPastThreshold,
    pastDestaqueUrls,
    subjectVsPastThresholdLowered,
    pastThemes,
    pastHighlightsData,
  );

  console.error(
    `dedup: ${articles.length} input → ${result.kept.length} kept, ${result.removed.length} removed (window=${window} edições, threshold=${titleThreshold}, title-vs-past=${titleVsPastThreshold}, subject-vs-past=${subjectVsPastThreshold}, subject-vs-past-lowered=${subjectVsPastThresholdLowered})`
  );

  const removed = result.removed.length;
  const kept = result.kept.length;
  logEvent({
    edition: null,
    stage: 1,
    agent: "dedup.ts",
    level: "info",
    message: `dedup: ${removed} artigos removidos por similaridade, ${kept} mantidos`,
    details: { removed, kept },
  }, logRootDir);

  const json = JSON.stringify(result, null, 2);
  if (outPath) {
    writeFileSync(outPath, json, "utf8");
    console.error(`Wrote to ${outPath}`);
  } else {
    process.stdout.write(json);
  }
}

if (isMainModule(import.meta.url)) {
  runMain(main);
}

