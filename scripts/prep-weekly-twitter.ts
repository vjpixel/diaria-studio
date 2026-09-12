/**
 * prep-weekly-twitter.ts (#8056)
 *
 * X/Twitter pro carrossel semanal ("os principais destaques" / "as mais
 * lidas da semana") — mesmo racional arquitetural do diário
 * (`prep-twitter-posts.ts`): a API da Buffer só é alcançável de dentro de
 * uma sessão de agente (MCP `mcp__.../create_post`), nunca de um script Node
 * puro. Este script faz só a parte determinística — reconstrói a MESMA
 * seleção de itens que `publish-weekly-social.ts` usa pro Instagram/
 * Facebook/Threads, resolve as imagens, corta pro que cabe no X, e devolve
 * ao caller (orchestrator/skill) o payload pronto pra `create_post`.
 *
 * **Diferenças do carrossel Instagram/Facebook/Threads (#8056, achado ao
 * vivo sessão 260912):**
 *   - O X não tem carrossel-swipe — o equivalente nativo é um tweet com até
 *     `TWITTER_WEEKLY_MAX_ITEMS` (4) imagens anexadas, exibidas em grade.
 *   - Corta capa e CTA, mantém só os itens de NOTÍCIA (os `TWITTER_WEEKLY_MAX_ITEMS`
 *     melhor ranqueados) — decisão ad-hoc registrada na issue #8056,
 *     pendente de confirmação do editor se ele preferir o inverso (manter
 *     capa/CTA trocando por menos itens).
 *   - Texto muito mais compacto (`formatTwitterWeekly`, limite PONDERADO de
 *     280 chars — a URL de arquivo conta só 23, peso do t.co, ver
 *     `computeTwitterWeightedLength` em `prep-twitter-posts.ts`) — sem linha
 *     de contexto por item, só título numerado.
 *
 * Uso:
 *   npx tsx scripts/prep-weekly-twitter.ts --saturday 260912 --mode highlights|clicked|both
 *     [--editions-root data/editions] [--time 11:00] [--day-offset N]
 *     [--no-skip-existing] [--force-incomplete-week] [--force-incomplete-click-data]
 *
 * `--force-incomplete-week`/`--force-incomplete-click-data`: mesmos gates de
 * `publish-weekly-social.ts` (seleção com menos itens que `WEEKLY_MIN_ITEMS`,
 * ou dado de clique não-enriquecido no modo "clicked") — sem a flag, o modo
 * é pulado (`skipped`, com o motivo) em vez de publicar sobre dado
 * incompleto em silêncio.
 *
 * `--saturday` é OBRIGATÓRIO e explícito (mesmo invariante de CLAUDE.md,
 * nunca inferido de `today()`). `--time`/`--day-offset` espelham
 * `publish-weekly-social.ts` — DEVEM bater com o horário usado pros outros
 * canais da MESMA rodada, senão o X sai dessincronizado (mesmo bug histórico
 * que motivou o #4103 no diário).
 *
 * Output (stdout, JSON): { posts: [{ destaque, text, dueAt, images: [{url, altText}] }], skipped: [...] }
 * `posts` é a lista que o caller deve efetivamente postar via Buffer MCP —
 * um `create_post` por entry, com:
 *   - `text`: post.text
 *   - `mode`: "customScheduled", `dueAt`: post.dueAt
 *   - `assets`: post.images.map(({url, altText}) => ({ image: { url, metadata: { altText } } }))
 * Depois de cada `create_post`, o caller deve gravar o resultado via:
 *   npx tsx scripts/append-twitter-published.ts --published-path {out_path}
 *     --destaque {destaque} --status scheduled --scheduled-at {dueAt}
 * (mesmo script genérico que o diário já usa — `platform: "twitter"` grava
 * no MESMO `06-weekly-published.json` dos outros 3 canais).
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { resolveWeeklyEditionDirs } from "./lib/select-weekly-d1.ts";
import {
  extractInstagramCandidates,
  matchPostsToWindow,
  toRankedCandidate,
  selectInstagramWeekly,
  selectInstagramHighlights,
  clickCountsForUrl,
  uniqueOpensOf,
  identifyInstagramPostsNeedingClicks,
  type InstagramRankedCandidate,
  type BeehiivCachePost,
} from "./lib/weekly-instagram-select.ts";
import { loadBeehiivCache as loadUnifiedBeehiivCache, loadKitCache, mergeEditionsByDate } from "./lib/shared/edition-cache-reader.ts";
import { resolveWeeklyImageUrls, computeWeeklyScheduledAt, DEFAULT_WEEKLY_TIME, DEFAULT_MODE_DAY_OFFSET, WEEKLY_EXPECTED_ITEMS, WEEKLY_MIN_ITEMS } from "./publish-weekly-social.ts";
import { formatTwitterWeekly, TWITTER_WEEKLY_MAX_ITEMS, type WeeklyInstagramMode } from "./lib/format-weekly-social.ts";
import { readSocialPublished } from "./lib/social-published-store.ts";
import { parseEditionDate } from "./compute-social-schedule.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface TwitterWeeklyPost {
  destaque: string;
  text: string;
  dueAt: string;
  /**
   * #8057 review (type-design-analyzer, alta confiança): antes eram 2 arrays
   * PARALELOS (`imageUrls`/`altTexts`), cujo pareamento por índice era só
   * convenção documentada/testada, não estrutural — exatamente o padrão que
   * silenciosamente atribui alt text errado se os 2 arrays um dia
   * divergirem. 1 array de objetos torna o pareamento estrutural.
   */
  images: Array<{ url: string; altText: string }>;
}

/**
 * Núcleo puro-o-suficiente (recebe `items` já selecionados e a raiz de
 * edições) pra ser testável sem depender de cache de cliques/rede — mesmo
 * padrão de `resolveWeeklyImageUrls`. Corta `items` pro tamanho de
 * `TWITTER_WEEKLY_MAX_ITEMS` ANTES de resolver imagem (nunca resolve imagem
 * de item que será descartado) e ANTES de formatar o texto (texto e imagens
 * sempre descrevem os MESMOS itens, nunca um subconjunto diferente do outro).
 */
export async function buildTwitterWeeklyPost(
  items: InstagramRankedCandidate[],
  editionsRoot: string,
  mode: WeeklyInstagramMode,
  destaqueKey: string,
  dueAt: string,
  introOverride?: string,
): Promise<{ ok: true; post: TwitterWeeklyPost } | { ok: false; reason: string }> {
  const capped = items.slice(0, TWITTER_WEEKLY_MAX_ITEMS);
  const resolved = await resolveWeeklyImageUrls(capped, editionsRoot);
  if (!resolved.ok) {
    const reason = resolved.onDemandError
      ? `on_demand_card_generation_failed:${resolved.missingEditionDate}:${resolved.onDemandError}`
      : resolved.corruptError
        ? `public_image_json_corrupt:${resolved.missingEditionDate}:${resolved.corruptError}`
        : `public_image_url_missing:${resolved.missingEditionDate}:d${resolved.missingDestaqueNumber}`;
    return { ok: false, reason };
  }
  const text = formatTwitterWeekly(capped, mode, introOverride);
  return {
    ok: true,
    post: {
      destaque: destaqueKey,
      text,
      dueAt,
      images: resolved.urls.map((url, i) => ({ url, altText: capped[i].title })),
    },
  };
}

function loadUnifiedPostsForRanking(beehiivPostsDir: string, kitBroadcastsDir: string) {
  const beehiiv = existsSync(beehiivPostsDir) ? loadUnifiedBeehiivCache(beehiivPostsDir) : [];
  const kit = loadKitCache(kitBroadcastsDir);
  return mergeEditionsByDate(beehiiv, kit);
}

/**
 * Beehiiv-only, de propósito (mesmo racional de `loadBeehiivCache` em
 * `publish-weekly-social.ts`) — o manifest de enriquecimento via MCP
 * (`identifyInstagramPostsNeedingClicks`) só existe do lado Beehiiv (Kit é
 * REST comum, sem enriquecimento assíncrono a esperar).
 */
function loadBeehiivCacheOnly(beehiivPostsDir: string): BeehiivCachePost[] {
  if (!existsSync(beehiivPostsDir)) return [];
  const out: BeehiivCachePost[] = [];
  for (const f of readdirSync(beehiivPostsDir)) {
    if (f === "index.json" || !f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(resolve(beehiivPostsDir, f), "utf8")));
    } catch (e: any) {
      console.warn(`[prep-weekly-twitter] SKIP cache corrompido: ${f} — ${e.message}`);
    }
  }
  return out;
}

export async function runOneMode(
  mode: WeeklyInstagramMode,
  saturday: string,
  editionsRoot: string,
  dataRoot: string,
  time: string,
  dayOffsetOverride: number | undefined,
  skipExisting: boolean,
  forceIncompleteWeek: boolean,
  forceIncompleteClickData: boolean,
): Promise<{ posts: TwitterWeeklyPost[]; skipped: Array<{ destaque: string; reason: string }> }> {
  const { year, month, day } = parseEditionDate(saturday);
  const saturdayDate = new Date(year, month - 1, day);
  const weekCandidates = resolveWeeklyEditionDirs(saturdayDate, editionsRoot);
  const existingCandidates = weekCandidates.filter((c) => c.exists);
  const contentWindow = weekCandidates.map((c) => c.date);
  const destaqueKey = `weekly-${mode}`;

  const rawCandidates = existingCandidates.flatMap((c) => {
    try {
      return extractInstagramCandidates(readFileSync(resolve(c.dir, "02-reviewed.md"), "utf8"), c.date);
    } catch (e: any) {
      console.warn(`[prep-weekly-twitter] SKIP ${c.dir} — falha ao ler/parsear 02-reviewed.md: ${e.message}`);
      return [];
    }
  });
  if (rawCandidates.length === 0) {
    return { posts: [], skipped: [{ destaque: destaqueKey, reason: "no_candidates_in_window" }] };
  }

  let items: InstagramRankedCandidate[];
  if (mode === "highlights") {
    // #5330: modo "highlights" não ranqueia por clique — CandidateClickCount
    // zerado é inerte aqui (selectInstagramHighlights ignora clicks/opens),
    // mas o tipo precisa do shape completo mesmo assim.
    const ranked = rawCandidates.map((c) => toRankedCandidate(c, { uniqueVerifiedClicks: 0, webUniqueClicks: 0 }, 0, false));
    items = selectInstagramHighlights(ranked).selected;
  } else {
    const beehiivPostsDir = resolve(dataRoot, "beehiiv-cache/posts");
    const kitBroadcastsDir = resolve(dataRoot, "kit-cache/broadcasts");
    const unified = loadUnifiedPostsForRanking(beehiivPostsDir, kitBroadcastsDir);
    const windowPostsUnified = matchPostsToWindow(unified, contentWindow);

    // #4511 fleet review ALTO (achado do review da #8057, mesma classe do
    // #4511 original em publish-weekly-social.ts): dado de clique
    // NÃO-enriquecido é indistinguível de "genuinamente zero cliques" — sem
    // este guard, a seleção do X compete sobre um ranking que pode estar
    // incompleto em silêncio. Beehiiv-only de propósito (ver docstring de
    // `loadBeehiivCacheOnly`).
    const windowPosts = matchPostsToWindow(loadBeehiivCacheOnly(beehiivPostsDir), contentWindow);
    const editionsMissingClickData = existingCandidates.filter((c) => !windowPostsUnified.has(c.date)).map((c) => c.date);
    const manifest = identifyInstagramPostsNeedingClicks(windowPosts);
    if ((editionsMissingClickData.length > 0 || manifest.length > 0) && !forceIncompleteClickData) {
      return {
        posts: [],
        skipped: [
          {
            destaque: destaqueKey,
            reason:
              `incomplete_click_data: ${editionsMissingClickData.length} edição(ões) sem post confirmado ` +
              `no cache Beehiiv/Kit, ${manifest.length} post(s) sem clicks enriquecidos por link — rode ` +
              `--manifest-only em publish-weekly-social.ts (mesmo cache), dispatche beehiiv-clicks-enricher, ` +
              `e re-rode, ou passe --force-incomplete-click-data pra prosseguir mesmo assim.`,
          },
        ],
      };
    }

    const ranked = rawCandidates.map((c) => {
      const post = windowPostsUnified.get(c.editionDate);
      const clicks = clickCountsForUrl(c.url, post?.stats?.clicks);
      const opens = uniqueOpensOf(post);
      return toRankedCandidate(c, clicks, opens, windowPostsUnified.has(c.editionDate));
    });
    items = selectInstagramWeekly(ranked, WEEKLY_EXPECTED_ITEMS).selected;
  }
  if (items.length === 0) {
    return { posts: [], skipped: [{ destaque: destaqueKey, reason: "empty_selection" }] };
  }
  // #4101 self-review finding 6 (achado do review da #8057): mesma
  // semântica de "seleção materialmente incompleta" que
  // publish-weekly-social.ts já aplica aos outros 3 canais — sem este
  // guard, uma semana curta (feriado, poucas edições) abortaria
  // Instagram/Facebook/Threads mas publicaria no X em silêncio.
  if (items.length < WEEKLY_MIN_ITEMS && !forceIncompleteWeek) {
    return {
      posts: [],
      skipped: [
        {
          destaque: destaqueKey,
          reason: `incomplete_week: selecionados ${items.length} de ${WEEKLY_EXPECTED_ITEMS} itens esperados (mínimo aceito sem confirmação: ${WEEKLY_MIN_ITEMS}) — passe --force-incomplete-week pra prosseguir mesmo assim.`,
        },
      ],
    };
  }

  if (skipExisting) {
    const publishedPath = resolve(dataRoot, "weekly", saturday, "06-weekly-published.json");
    if (existsSync(publishedPath)) {
      const published = readSocialPublished(publishedPath);
      // #633 (achado do review da #8057): "draft" tinha que contar como já
      // existente, igual ao skip-existing dos outros 3 canais em
      // publish-weekly-social.ts (`status === "draft" || "scheduled"`) —
      // sem isso, um post que só chegou a rascunho no Buffer (nunca
      // avançou pra scheduled/published) não era reconhecido, e um re-run
      // bem-intencionado duplicaria.
      const existing = published.posts.find(
        (p) => p.platform === "twitter" && p.destaque === destaqueKey && (p.status === "draft" || p.status === "scheduled" || p.status === "published"),
      );
      if (existing) {
        return { posts: [], skipped: [{ destaque: destaqueKey, reason: `already_${existing.status}` }] };
      }
    }
  }

  const dayOffset = dayOffsetOverride ?? DEFAULT_MODE_DAY_OFFSET[mode];
  const dueAt = computeWeeklyScheduledAt({ saturday, time, timezone: "America/Sao_Paulo", dayOffset });

  const result = await buildTwitterWeeklyPost(items, editionsRoot, mode, destaqueKey, dueAt);
  if (!result.ok) {
    console.error(`ERRO ${destaqueKey}: ${result.reason}`);
    return { posts: [], skipped: [{ destaque: destaqueKey, reason: result.reason }] };
  }
  return { posts: [result.post], skipped: [] };
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { flags, values } = parseArgs(argv);
  const saturday = values["saturday"];
  if (!saturday) {
    console.error("ERRO: --saturday AAMMDD é obrigatório (data explícita, nunca inferida de today()).");
    process.exit(1);
    return;
  }
  try {
    parseEditionDate(saturday);
  } catch (e: any) {
    console.error(`ERRO: ${e.message}`);
    process.exit(1);
    return;
  }
  const modeArg = values["mode"] ?? "clicked";
  if (modeArg !== "clicked" && modeArg !== "highlights" && modeArg !== "both") {
    console.error(`ERRO: --mode inválido: '${modeArg}' (esperado 'clicked', 'highlights' ou 'both').`);
    process.exit(1);
    return;
  }
  const editionsRoot = resolve(ROOT, values["editions-root"] ?? "data/editions");
  const dataRoot = resolve(ROOT, "data");
  const time = values["time"] ?? DEFAULT_WEEKLY_TIME;
  const dayOffsetOverride = values["day-offset"] != null ? Number(values["day-offset"]) : undefined;
  const skipExisting = !flags.has("no-skip-existing");
  const forceIncompleteWeek = flags.has("force-incomplete-week");
  const forceIncompleteClickData = flags.has("force-incomplete-click-data");

  const modes: WeeklyInstagramMode[] = modeArg === "both" ? ["highlights", "clicked"] : [modeArg as WeeklyInstagramMode];
  const allPosts: TwitterWeeklyPost[] = [];
  const allSkipped: Array<{ destaque: string; reason: string }> = [];
  for (const mode of modes) {
    const { posts, skipped } = await runOneMode(
      mode,
      saturday,
      editionsRoot,
      dataRoot,
      time,
      dayOffsetOverride,
      skipExisting,
      forceIncompleteWeek,
      forceIncompleteClickData,
    );
    allPosts.push(...posts);
    allSkipped.push(...skipped);
  }

  mkdirSync(resolve(dataRoot, "weekly", saturday), { recursive: true });
  const outPath = resolve(dataRoot, "weekly", saturday, "06-weekly-published.json");
  console.log(JSON.stringify({ out_path: outPath, posts: allPosts, skipped: allSkipped }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}
