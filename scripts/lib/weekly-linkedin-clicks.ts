/**
 * weekly-linkedin-clicks.ts (#4456)
 *
 * Cruza os candidatos extraídos de `02-reviewed.md` (weekly-linkedin-parse.ts)
 * com o cache local de cliques do Beehiiv (`data/beehiiv-cache/posts/*.json`,
 * populado por `scripts/beehiiv-sync.ts` + enriquecido via MCP
 * `list_post_clicks` pelo agent `beehiiv-clicks-enricher`).
 *
 * **Por que não chama a MCP direto:** MCP não roda de script TS standalone —
 * só de subagent/top-level com a tool declarada (ver docstring de
 * `beehiiv-sync.ts` e do agent `beehiiv-clicks-enricher`). Este módulo (e o
 * script `select-linkedin-weekly.ts` que o usa) só LÊ o cache já enriquecido —
 * mesmo padrão de `monthly-click-sections.ts`, que também nunca chama a MCP,
 * só lê `data/beehiiv-cache/posts/*.json`.
 *
 * **Por que não reusa o gate de 7 dias de `identifyPostsNeedingClicks`
 * (`beehiiv-sync.ts`):** aquele gate existe pra estabilizar o CTR table (1
 * clique na 1ª hora lê como "100%"). A janela de conteúdo desta skill é
 * SEMPRE recente (a semana que acabou de terminar, publicada na segunda
 * seguinte — os posts têm entre 2 e 6 dias de idade no momento da seleção,
 * exatamente a faixa que o gate de 7 dias EXCLUIRIA). `identifyWeeklyPostsNeedingClicks`
 * abaixo pede enriquecimento pra QUALQUER post da janela com clicks
 * incompletos (ver `isClickCacheComplete`), sem o corte de idade.
 *
 * **Gate de completude compartilhado (#4493):** o critério "cache já tem
 * clicks suficientes" usa `isClickCacheComplete`
 * (`scripts/lib/shared/click-cache-completeness.ts`) — mesmo helper que
 * `identifyPostsNeedingClicks` (`beehiiv-sync.ts`) usa. Esse módulo shared
 * não tem imports com efeito colateral (nada de `dotenv/config`), então
 * importá-lo daqui não reintroduz o acoplamento que a nota acima evita.
 *
 * **Origem Beehiiv/Kit (#6185):** `matchPostsToWindow`/`uniqueOpensOf` são
 * genéricos desde #6185 — aceitam tanto `BeehiivCachePost[]` quanto
 * `UnifiedCachedPost[]` (`scripts/lib/shared/edition-cache-reader.ts`),
 * então um caller pode passar o cache unificado Beehiiv+Kit sem cast. Isso
 * cobre a SELEÇÃO por clique (ranking de candidatos); `identifyWeeklyPostsNeedingClicks`
 * continua Beehiiv-only DE PROPÓSITO — "precisa de enriquecimento via MCP
 * `list_post_clicks`" é um conceito que só existe do lado Beehiiv (o Kit é
 * REST comum, sem enriquecimento assíncrono a esperar); ver
 * `ClickWindowPost` abaixo.
 */

import { isClickCacheComplete, type ClickCacheRow } from "./shared/click-cache-completeness.ts";

/**
 * Um item do manifest de posts que precisam de enriquecimento via MCP —
 * mesmo shape de `PostNeedingClicks` (`scripts/beehiiv-sync.ts`), duplicado
 * aqui de propósito (não importado) pra este módulo não puxar os efeitos
 * colaterais de módulo de `beehiiv-sync.ts` (`import "dotenv/config"`, etc.)
 * só por causa de um tipo. `scripts/select-linkedin-weekly.ts` emite este
 * shape pro MESMO caller (`beehiiv-clicks-enricher`) que já consome o
 * manifest de `beehiiv-sync.ts` — drift entre os dois é coberto por
 * `test/weekly-linkedin-clicks.test.ts`.
 */
export interface WeeklyPostNeedingClicks {
  id: string;
  title: string;
  email_clicks: number;
}

/**
 * Linha de click do cache pós-enriquecimento (shape `LegacyClick` de
 * `apply-mcp-clicks.ts`) — alias de `ClickCacheRow` (fonte de verdade real
 * persistida em `click-cache-completeness.ts`) + os campos de identificação
 * de URL que só este módulo usa (`clickCountsForUrl`). Antes deste módulo
 * declarava um `CachedClickRow` independente com `web` mais estreito (só
 * `total_unique_clicked`, sem `total_clicked`) — drift real já detectado
 * contra `ClickCacheRow` (fleet review #4383 achado 5, 260802).
 */
export type CachedClickRow = ClickCacheRow & { url: string; base_url?: string };

/** Shape mínimo do cache `data/beehiiv-cache/posts/{id}.json` usado aqui. */
export interface BeehiivCachePost {
  id: string;
  title?: string;
  status?: string;
  publish_date?: number | null; // epoch seconds
  stats?: {
    email?: { clicks?: number; unique_opens?: number; verified_clicks?: number; unique_verified_clicks?: number };
    clicks?: CachedClickRow[];
  };
}

/**
 * Shape estrutural mínimo que `matchPostsToWindow`/`uniqueOpensOf` precisam
 * (#6185) — deliberadamente mais estreito que `BeehiivCachePost` (sem `id`,
 * sem os campos de agregado bruto de `stats.email` que só
 * `identifyWeeklyPostsNeedingClicks` usa — esses continuam Beehiiv-only,
 * ver docstring dessa função). `UnifiedCachedPost`
 * (`scripts/lib/shared/edition-cache-reader.ts`, #6187/#6342) satisfaz este
 * shape estruturalmente (`stats.clicks: NormalizedLinkClick[]` é assignable
 * a `CachedClickRow[]` — mesmos campos, ver docstring de
 * `edition-cache-reader.ts`), então `matchPostsToWindow`/`uniqueOpensOf`
 * aceitam tanto `BeehiivCachePost[]` (caminho Beehiiv-only, ex.:
 * `publish-weekly-social.ts`) quanto `UnifiedCachedPost[]` (caminho
 * unificado Beehiiv+Kit, ex.: `select-linkedin-weekly.ts` — a mesma
 * partição por origem que o #6048 aplicou à verificação de assinante) sem
 * nenhum cast.
 */
export interface ClickWindowPost {
  status?: string;
  publish_date?: number | null;
  stats?: {
    email?: { unique_opens?: number };
    clicks?: CachedClickRow[];
  };
}

/** Pure: `epoch seconds` → `AAMMDD` local. */
export function aammddFromEpochSeconds(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/**
 * Pure: mapa `AAMMDD → post` pros posts cacheados cujo `publish_date` cai
 * numa das datas de `windowDates` e `status === "confirmed"`. Quando mais de
 * um post publica na mesma data (raro), o mais recente por `publish_date`
 * vence — mesma semântica implícita do resto do pipeline (1 edição por dia).
 */
export function matchPostsToWindow<T extends ClickWindowPost>(
  posts: T[],
  windowDates: string[],
): Map<string, T> {
  const windowSet = new Set(windowDates);
  const out = new Map<string, T>();
  for (const post of posts) {
    if (post.status !== "confirmed" || !post.publish_date) continue;
    const date = aammddFromEpochSeconds(post.publish_date);
    if (!windowSet.has(date)) continue;
    const existing = out.get(date);
    if (!existing || (existing.publish_date ?? 0) < post.publish_date) out.set(date, post);
  }
  return out;
}

/**
 * Pure: posts da janela (já resolvidos por `matchPostsToWindow`) que ainda
 * precisam de enriquecimento de clicks — `email.clicks > 0` mas `stats.clicks`
 * INCOMPLETO no cache (`isClickCacheComplete`, #4493 — antes disto era só
 * "vazio", que deixava cache parcial de 1 linha nunca corrigido; recalibrado
 * em 260802, fleet review #4383 achado 1, ver docstring de
 * `click-cache-completeness.ts`). SEM corte de idade (ver docstring do
 * arquivo) — diferente de `identifyPostsNeedingClicks` de `beehiiv-sync.ts`.
 * Formato de saída idêntico ao `PostNeedingClicks` de lá, pro mesmo caller
 * (dispatch do agent `beehiiv-clicks-enricher`) funcionar sem adaptação.
 */
export function identifyWeeklyPostsNeedingClicks(
  windowPosts: Map<string, BeehiivCachePost>,
): WeeklyPostNeedingClicks[] {
  const out: WeeklyPostNeedingClicks[] = [];
  for (const post of windowPosts.values()) {
    const emailClicks = post.stats?.email?.clicks ?? 0;
    if (emailClicks <= 0) continue;
    // Denominador preferindo verified (mesma metodologia bot-filtered do
    // numerador em sumCachedClicks) — fallback pro bruto se ausente (#4493).
    const completenessDenominator =
      post.stats?.email?.verified_clicks ?? post.stats?.email?.unique_verified_clicks ?? emailClicks;
    if (!isClickCacheComplete(completenessDenominator, post.stats?.clicks)) {
      out.push({ id: post.id, title: post.title ?? "", email_clicks: emailClicks });
    }
  }
  return out;
}

/** Pure: normaliza URL pra matching (host lowercase, sem query/hash/barra final) — mesma técnica de `monthly-click-sections.ts` `baseUrl`. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hostname = u.hostname.toLowerCase();
    u.search = "";
    u.hash = "";
    return u.toString().replace(/[.,]+$/, "").replace(/\/$/, "");
  } catch {
    return raw.trim().replace(/[.,]+$/, "").replace(/\/$/, "");
  }
}

export interface CandidateClickCount {
  /** `email.unique_verified_clicks` somado entre variantes da mesma URL base (bot-filtered — sinal primário do #4456). */
  uniqueVerifiedClicks: number;
  /** `web.total_unique_clicked` somado — clique via preview web do e-mail (não é "webview"/pageview do post, ver docstring do arquivo). */
  webUniqueClicks: number;
}

/**
 * Pure: soma cliques (verified email + web) pra uma URL, casando por
 * `base_url`/`url` normalizado — exato primeiro, fuzzy (sem protocolo/barra
 * final) como fallback. Mesma estratégia de `matchClick` (`build-link-ctr.ts`),
 * reimplementada aqui porque o shape de retorno precisa separar email/web
 * (o CTR table não precisa).
 */
export function clickCountsForUrl(url: string, clicks: CachedClickRow[] | undefined): CandidateClickCount {
  const target = normalizeUrl(url);
  const zero: CandidateClickCount = { uniqueVerifiedClicks: 0, webUniqueClicks: 0 };
  if (!clicks || clicks.length === 0) return zero;

  const rowBase = (c: CachedClickRow) => normalizeUrl(c.base_url || c.url);

  const sum = (rows: CachedClickRow[]): CandidateClickCount =>
    rows.reduce(
      (acc, c) => ({
        uniqueVerifiedClicks: acc.uniqueVerifiedClicks + (c.email?.unique_verified_clicks ?? 0),
        webUniqueClicks: acc.webUniqueClicks + (c.web?.total_unique_clicked ?? 0),
      }),
      { ...zero },
    );

  const exact = clicks.filter((c) => rowBase(c) === target);
  if (exact.length > 0) return sum(exact);

  const normNoProto = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
  const targetFuzzy = normNoProto(target);
  const fuzzy = clicks.filter((c) => normNoProto(rowBase(c)) === targetFuzzy);
  if (fuzzy.length > 0) return sum(fuzzy);

  return zero;
}

/** Pure: `unique_opens` do e-mail do post — denominador da taxa (#4456: "aberturas é o denominador certo"). */
export function uniqueOpensOf<T extends ClickWindowPost>(post: T | undefined): number {
  return post?.stats?.email?.unique_opens ?? 0;
}
