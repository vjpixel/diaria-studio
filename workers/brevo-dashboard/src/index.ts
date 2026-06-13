/**
 * diaria-brevo-dashboard (#1141 follow-up — request 2026-05-12)
 *
 * Worker que serve dashboard HTML pra acompanhar campaigns Brevo (Clarice
 * monthly digest). Live fetch contra Brevo API com cache de 5min via
 * Cache API.
 *
 * **Página pública** — sem auth (preferência do editor 2026-05-12). Brevo
 * API key fica server-side como secret; stats per-campaign expostas pra
 * qualquer visitante. Pode rotacionar pra Basic Auth no futuro sem
 * mudança breaking — endpoint mantém shape.
 *
 * Endpoints:
 *   GET  /                 → HTML dashboard (pública)
 *   GET  /api/campaigns    → JSON com campaigns + stats (pública)
 *   GET  /healthz          → liveness probe
 *
 * Secrets:
 *   BREVO_API_KEY          → xkeysib-... da conta Clarice
 *
 * KV bindings:
 *   STATS_CACHE            → cache de stats imutáveis (campanhas > 7d)
 *
 * Cache de borda 5min via Cache API (#2144): rotas / e /api/campaigns
 * são cacheadas por 5min. Bypass: ?fresh=1. Isso reduz drasticamente
 * o número de chamadas à Brevo (de ~27/load para ~3-5 com KV quente,
 * e 0 chamadas adicionais nos 4min seguintes ao primeiro load).
 *
 * #2086 Fase 2 mínima:
 *   - Resumo A/B/C da S1 (checkpoint 17/jun)
 *   - Tendência entre waves (open+bounce cronológico)
 *   - trackableViewsRate por campanha (coluna na tabela)
 *   - Volume cumulativo vs plano 40k
 */

/**
 * Design System tokens (#2107) — importados de `ds-tokens.generated.ts`,
 * gerado automaticamente por `scripts/generate-worker-tokens.ts` a partir
 * da fonte canônica `scripts/lib/design-tokens.ts`.
 *
 * O Worker tem bundle Cloudflare separado e não pode importar de
 * `scripts/lib/` em runtime. O arquivo gerado resolve isso: é produzido
 * antes do deploy (via `[build]` no wrangler.toml) e antes dos testes
 * (via `pretest` no package.json raiz).
 *
 * Para atualizar tokens: editar `scripts/lib/design-tokens.ts` e rodar
 * `npx tsx scripts/generate-worker-tokens.ts` (ou qualquer path que
 * acione o build step).
 *
 * `DS.alert` permanece local — é uma cor semântica de ferramenta interna
 * (circuit breaker threshold), sem token canônico no DS de marca.
 */
import { DS_COLORS, DS_FONTS as DSF } from "./ds-tokens.generated.ts";

const DS = {
  ...DS_COLORS,
  // Alerta de circuit breaker: sem cor canônica no DS — red semântico de
  // ferramenta interna. Não é uma cor de marca, portanto não entra no DS.
  // Valor mantido como constante local explícita para evitar magic string.
  alert:    "#C00000",  // vermelho de alerta (circuit breaker threshold)
} as const;


/** Exportado para o teste de drift (test/brevo-dashboard-ds-drift.test.ts). */
export const DS_TOKENS = DS_COLORS;
export const DS_FONTS = DSF;

export interface Env {
  BREVO_API_KEY: string;
  /** KV namespace para cache de stats imutáveis (#2144) */
  STATS_CACHE: KVNamespace;
}

interface BrevoCampaignStats {
  listId: number;
  sent: number;
  delivered: number;
  hardBounces: number;
  softBounces: number;
  deferred: number;
  uniqueViews: number;
  viewed: number;
  trackableViews: number;
  uniqueClicks: number;
  clickers: number;
  unsubscriptions: number;
  complaints: number;
}

interface BrevoGlobalStats {
  sent: number;
  delivered: number;
  hardBounces: number;
  softBounces: number;
  uniqueViews: number;
  viewed: number;
  trackableViews: number;
  uniqueClicks: number;
  clickers: number;
  unsubscriptions: number;
  complaints: number;
  appleMppOpens: number;
  opensRate?: number;
  estimatedViews?: number;
}

/**
 * Shape do `statistics.linksStats` da Brevo API.
 * Retornado via `GET /v3/emailCampaigns/{id}?statistics=linksStats`.
 * O endpoint expõe apenas clicks totais por URL — unique-clicks por link
 * não está disponível neste endpoint da API Brevo v3 (unique clicks só
 * existem no nível da campanha, em `globalStats.uniqueClicks`).
 * Referência: https://developers.brevo.com/reference/getemailcampaigns-1
 */
export type BrevoLinksStats = Record<string, number>; // url → clicks

interface BrevoCampaign {
  id: number;
  name: string;
  subject: string;
  status: string;
  sentDate: string | null;
  scheduledAt: string | null;
  createdAt: string;
  recipients: { lists: number[] };
  statistics?: {
    campaignStats?: BrevoCampaignStats[];
    globalStats?: BrevoGlobalStats;
    linksStats?: BrevoLinksStats;
  };
}

interface BrevoList {
  id: number;
  name: string;
  totalSubscribers: number;
}


// ─── #2144: helpers de controle de concorrência e cache ──────────────────────

/**
 * mapLimit: executa `fn` sobre cada item de `arr` com no máximo `n`
 * chamadas simultâneas. Preserva a ordem do input no output.
 * Implementação local — sem dependência nova, ~15 linhas.
 */
export async function mapLimit<T, R>(
  arr: T[],
  n: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(arr.length);
  let idx = 0;
  let aborted = false;

  async function worker(): Promise<void> {
    while (idx < arr.length && !aborted) {
      const i = idx++;
      try {
        results[i] = await fn(arr[i]);
      } catch (err) {
        aborted = true; // Para todos os workers ao primeiro erro fatal
        throw err;
      }
    }
  }

  const workers = Array.from({ length: Math.min(n, arr.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * isImmutableCampaign: campanha com `sentDate` há mais de 7 dias tem
 * stats imutáveis — não muda mais no Brevo. Usada para decidir se devemos
 * tentar ler/escrever no KV.
 *
 * @param sentDate - ISO string da data de envio (null = campanha recente)
 * @param nowMs    - timestamp de referência (mockável em testes)
 */
export function isImmutableCampaign(sentDate: string | null, nowMs = Date.now()): boolean {
  if (!sentDate) return false;
  const sent = Date.parse(sentDate);
  if (isNaN(sent)) return false;
  const sevenDaysMs = 7 * 24 * 3600 * 1000;
  return nowMs - sent > sevenDaysMs;
}

/** Erro especial para 429 — carrega o header Retry-After da Brevo. */
export class BrevoRateLimitError extends Error {
  constructor(public readonly retryAfterSecs: number | null) {
    super(`Brevo rate limit (retry-after: ${retryAfterSecs ?? "?"}s)`);
    this.name = "BrevoRateLimitError";
  }
}

async function brevoFetch<T>(path: string, env: Env): Promise<T> {
  const res = await fetch(`https://api.brevo.com${path}`, {
    headers: { "api-key": env.BREVO_API_KEY, accept: "application/json" },
  });
  if (res.status === 429) {
    // Semantica observada 2026-06-10 em chamada real: x-sib-ratelimit-reset
    // retornou "256" -- um DELTA em segundos, nao epoch Unix. Aplicamos clamp
    // defensivo: se o valor for < 1e9 (< 31 anos), tratamos como delta direto;
    // se for formato epoch (>= 1e9), convertemos via Math.ceil(v - Date.now()/1000).
    // Standard retry-after (RFC 7231) e lido como delta direto quando presente.
    let retryAfter: number | null = null;
    const retryAfterHeader = res.headers.get("retry-after");
    const resetHeader = res.headers.get("x-sib-ratelimit-reset");
    if (retryAfterHeader != null) {
      const v = Number(retryAfterHeader);
      if (!isNaN(v) && v > 0) retryAfter = v;
    } else if (resetHeader != null) {
      const v = Number(resetHeader);
      if (!isNaN(v)) {
        // Delta direto (ex: 256s) ou epoch Unix (ex: ~1.7e9)?
        retryAfter = v >= 1e9
          ? Math.max(0, Math.ceil(v - Date.now() / 1000))
          : v > 0 ? v : null;
      }
    }
    throw new BrevoRateLimitError(retryAfter);
  }
  if (!res.ok) {
    throw new Error(`Brevo API ${path} failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Lista as últimas N campaigns enviadas + enriquece com nome da lista + globalStats
 * (#1141 fix: o listing default retorna `campaignStats[0]` por lista, mas
 * **não popula `globalStats`** — vem todo zerado. Pra ter contagem que bate
 * com a Brevo Web UI (que inclui Apple MPP opens), tem que fazer GET
 * individual por campanha com `?statistics=globalStats`.)
 *
 * #2144: usa mapLimit(5) em vez de Promise.all ilimitado pra não disparar
 * todos os GETs de uma vez e estourar a janela de 100 reqs/min da Brevo.
 * Stats de campanhas com sentDate > 7d são consideradas imutáveis e
 * cacheadas no KV STATS_CACHE sem TTL. Nomes de lista: KV com TTL 7d.
 */
export async function fetchRecentCampaigns(
  env: Env,
  limit = 50, // #2134 follow-up: weekday agrega todos os envios — cobrir ciclos anteriores
  isFresh = false, // #2144: fresh=1 bypassa tanto edge cache quanto KV de stats imutaveis
  // _fetchFn: injetavel em testes para mockar chamadas Brevo (padrao: brevoFetch)
  _fetchFn: typeof brevoFetch = brevoFetch,
): Promise<Array<BrevoCampaign & { listName?: string; listSize?: number }>> {
  const data = await _fetchFn<{ campaigns: BrevoCampaign[] }>(
    `/v3/emailCampaigns?status=sent&limit=${limit}&sort=desc`,
    env,
  );
  const campaigns = data.campaigns ?? [];

  // Coleta lista IDs únicas pra fetch em batch (max 1 chamada extra por lista)
  const listIds = [...new Set(campaigns.flatMap((c) => c.recipients?.lists ?? []))];

  const listMap = new Map<number, BrevoList>();
  const globalStatsMap = new Map<number, BrevoGlobalStats>();
  const linksStatsMap = new Map<number, BrevoLinksStats>();

  // Fetch listas e globalStats em paralelo -- os dois batches sao independentes.
  // mapLimit(5) por batch => concorrencia total <= 10 (bem abaixo de 100 reqs/min da Brevo).
  // Fetch listas e globalStats em paralelo -- os dois batches sao independentes.
  // mapLimit(5) por batch: concorrencia total <= 10, bem abaixo de 100 reqs/min da Brevo.
  await Promise.all([
    // Batch 1: nomes de lista com KV cache (TTL 7d)
    mapLimit(listIds, 5, async (id) => {
      try {
        // Tentar KV primeiro (isFresh=1 bypassa -- operador quer dados direto da Brevo)
        const kvKey = `list:${id}`;
        const cached = (!isFresh && env.STATS_CACHE) ? await env.STATS_CACHE.get(kvKey, "json").catch(() => null) : null;
        if (cached) {
          listMap.set(id, cached as BrevoList);
          return;
        }
        const list = await _fetchFn<BrevoList>(`/v3/contacts/lists/${id}`, env);
        listMap.set(id, list);
        // Gravar no KV com TTL 7 dias (lista pode mudar de nome ou tamanho)
        if (env.STATS_CACHE) {
          await env.STATS_CACHE.put(kvKey, JSON.stringify(list), {
            expirationTtl: 7 * 24 * 3600,
          }).catch(() => { /* erro de KV nunca bloqueia */ });
        }
      } catch {
        // Lista pode ter sido apagada -- skip
      }
    }),
    // Batch 2: globalStats + linksStats com KV cache para campanhas imutaveis (> 7d).
    // #2177: ambas as stats vêm do mesmo GET por id (param `statistics=globalStats,linksStats`),
    // sem custo extra de chamada. linksStats: url → clicks (unique-clicks por link não
    // está disponível neste endpoint da API Brevo v3).
    mapLimit(campaigns, 5, async (c) => {
      try {
        const kvGsKey = `gstats:${c.id}`;
        const kvLsKey = `lstats:${c.id}`;
        const immutable = isImmutableCampaign(c.sentDate);

        // Para campanhas imutaveis: tentar KV primeiro (exceto fresh=1)
        if (!isFresh && immutable && env.STATS_CACHE) {
          const [cachedGs, cachedLs] = await Promise.all([
            env.STATS_CACHE.get(kvGsKey, "json").catch(() => null),
            env.STATS_CACHE.get(kvLsKey, "json").catch(() => null),
          ]);
          if (cachedGs) globalStatsMap.set(c.id, cachedGs as BrevoGlobalStats);
          if (cachedLs) linksStatsMap.set(c.id, cachedLs as BrevoLinksStats);
          // Se ambos estavam em cache, skip o fetch da API.
          // Bug fix (#2183): antes o `if (cachedGs) return` pulava o fetch
          // mesmo quando lstats não estava em cache — campanhas pré-#2177 com
          // gstats cacheado nunca recebiam lstats. Agora só retorna se ambos
          // estiverem em cache.
          if (cachedGs && cachedLs) return;
        }

        // Fetch com globalStats + linksStats num único GET (sem custo extra de chamada)
        const detail = await _fetchFn<BrevoCampaign>(
          `/v3/emailCampaigns/${c.id}?statistics=globalStats,linksStats`,
          env,
        );
        const gs = detail.statistics?.globalStats;
        const ls = detail.statistics?.linksStats;

        // So gravar stats REAIS (gs.sent > 0) -- Brevo pode retornar objeto
        // zerado em certas condicoes; persistir zerado sem TTL criaria entrada
        // permanente impossivel de recuperar sem `wrangler kv:key delete`.
        if (gs && gs.sent > 0) {
          globalStatsMap.set(c.id, gs);
          // Gravar no KV sem TTL se imutavel (stats nao mudam mais)
          if (immutable && env.STATS_CACHE) {
            await env.STATS_CACHE.put(kvGsKey, JSON.stringify(gs)).catch(() => { /* nunca bloqueia */ });
          }
        }

        // linksStats: gravar se o objeto existir (mesmo que vazio — indica que a
        // campanha não tinha links rastreados, distinguindo de "não buscado ainda").
        if (ls !== undefined) {
          linksStatsMap.set(c.id, ls);
          if (immutable && env.STATS_CACHE) {
            await env.STATS_CACHE.put(kvLsKey, JSON.stringify(ls)).catch(() => { /* nunca bloqueia */ });
          }
        }
      } catch {
        // Falha individual nao bloqueia o resto -- campaignStats fica como fallback
      }
    }),
  ]); // fim Promise.all([listas, stats])

  return campaigns.map((c) => {
    const listId = c.recipients?.lists?.[0];
    const list = listId ? listMap.get(listId) : undefined;
    const globalStats = globalStatsMap.get(c.id);
    const linksStats = linksStatsMap.get(c.id);
    // #1141 fix: o listing retorna `globalStats: { sent: 0, ... }` (zeroed,
    // não undefined) — verificado 2026-05-12. Por isso NÃO podemos fazer
    // `...c.statistics` cego: se nosso fetch individual falhar (globalStats
    // local = undefined), o zeroed do listing persistiria e mascara o
    // fallback pra campaignStats no render. Só incluir globalStats final
    // se o fetch individual teve sucesso.
    // #2199.3: linksStats consolidado em statistics.linksStats (fonte única).
    // A propriedade top-level `linksStats` foi removida — era double-write
    // desnecessário. Leitores usam c.statistics?.linksStats.
    return {
      ...c,
      listName: list?.name,
      listSize: list?.totalSubscribers,
      statistics: {
        campaignStats: c.statistics?.campaignStats,
        ...(globalStats && { globalStats }),
        ...(linksStats !== undefined && { linksStats }),
      },
    };
  });
}

function pct(n: number, total: number): string {
  if (!total) return "0.0%";
  return ((n / total) * 100).toFixed(1) + "%";
}

/**
 * Gera o atributo `class="..."` a partir de N classes. Strings vazias /
 * null / false são filtradas. Retorna string vazia (sem atributo) se
 * sobrar zero classes. Uso: `<td${cellClass("metric", maybeAlert)}>...`.
 */
function cellClass(...names: Array<string | false | null | undefined>): string {
  const valid = names.filter((n): n is string => Boolean(n));
  return valid.length === 0 ? "" : ` class="${valid.join(" ")}"`;
}

// ─── #2177: CTR por link ──────────────────────────────────────────────────────

/**
 * URLs de tracking/sistema a filtrar do linksStats: unsubscribe, preferências,
 * links de tracking Brevo e Mailgun. Filtro conservador — só remove o que é
 * claramente sistema, não editorial.
 *
 * NOTA: UTMs (utm_source, utm_campaign, etc.) NÃO são filtrados — são parâmetros
 * de tracking editorial legítimos que devem aparecer no relatório de links.
 */
const SYSTEM_URL_PATTERNS = [
  /unsubscribe/i,        // também cobre r.brevo.com/links/unsubscribe — regex específico removido (#2183)
  /optout/i,
  /opt-out/i,
  /preferences/i,
  /preferencias/i,
  /manage.*subscription/i,
  /email\.mg\./i,        // Mailgun tracking
];

/**
 * Retorna true se a URL deve ser filtrada do report de links (sistema/rodapé).
 */
export function isSystemLink(url: string): boolean {
  return SYSTEM_URL_PATTERNS.some((p) => p.test(url));
}

/**
 * Trunca uma URL para exibição (max 70 chars).
 * Helper compartilhado entre parseLinksStats e aggregateLinksAcrossCampaigns
 * para evitar duplicação (#2216 cleanup, finding #2).
 */
export function truncateUrl(url: string): string {
  return url.length > 70 ? url.slice(0, 67) + "…" : url;
}

/**
 * Retorna linksStats de uma campanha — fonte canônica: statistics.linksStats,
 * com fallback pra top-level linksStats (backward compat com fixtures/testes legados).
 * Helper compartilhado (#2216 cleanup, finding #4 — elimina dual-source duplicado).
 */
export function getCampaignLinksStats(
  c: BrevoCampaign & { listName?: string; listSize?: number; linksStats?: BrevoLinksStats },
): BrevoLinksStats | undefined {
  return c.statistics?.linksStats ?? c.linksStats;
}

/**
 * Estrutura de um link processado para exibição no dashboard.
 */
export interface LinkStatRow {
  url: string;
  /** URL truncada para exibição (max 70 chars) */
  displayUrl: string;
  clicks: number;
  /** Participação percentual em relação ao total de clicks editoriais da campanha (links de sistema excluídos) */
  pctOfTotal: string;
}

/**
 * Parseia `linksStats` (mapa url→clicks) da Brevo, filtra links de sistema,
 * ordena por clicks DESC e retorna array de LinkStatRow com participação %.
 *
 * Nota sobre unique-clicks: a API Brevo v3 (`GET /v3/emailCampaigns/{id}?statistics=linksStats`)
 * expõe apenas clicks totais por URL — sem unique-clicks por link. Unique-clicks
 * só existem agregados no nível da campanha (`globalStats.uniqueClicks`).
 * Portanto, a tabela exibe apenas "Clicks" (total) e omite coluna unique graciosamente.
 *
 * @param linksStats - mapa url→clicks da Brevo (pode ser undefined/null)
 * @returns array de LinkStatRow ordenado por clicks DESC, vazio se sem dados
 */
export function parseLinksStats(linksStats: BrevoLinksStats | undefined | null): LinkStatRow[] {
  if (!linksStats) return [];

  const entries = Object.entries(linksStats)
    .filter(([url]) => !isSystemLink(url))
    // #2216 finding #3: Number.isFinite guard — `clicks > 0` is NaN-transparent
    // (NaN > 0 is false, but NaN can still propagate if checked differently elsewhere).
    // isFinite covers NaN, Infinity, and -Infinity. Consistent with #2207 NaN class.
    .filter(([, clicks]) => Number.isFinite(clicks) && clicks > 0)
    .sort(([, a], [, b]) => b - a);

  if (entries.length === 0) return [];

  const totalClicks = entries.reduce((sum, [, clicks]) => sum + clicks, 0);

  return entries.map(([url, clicks]) => ({
    url,
    displayUrl: truncateUrl(url), // #2216 finding #2: extraído helper truncateUrl
    clicks,
    pctOfTotal: pct(clicks, totalClicks), // reusa helper pct() (#2183)
  }));
}

/**
 * Renderiza a tabela de CTR por link como HTML colapsável (<details>/<summary>).
 * Graceful quando linksStats ausente ou sem links editoriais: retorna stub vazio.
 *
 * @param campaignId - usado no id do <details> para unicidade
 * @param linksStats - mapa url→clicks (pode ser undefined)
 * @param totalClicks - uniqueClicks da campanha (pra contexto no summary)
 */
export function renderLinksSection(
  campaignId: number,
  linksStats: BrevoLinksStats | undefined | null,
  totalClicks?: number,
): string {
  const rows = parseLinksStats(linksStats);

  // Stub graceful: sem linksStats ou sem links editoriais → seção oculta mas presente
  if (rows.length === 0) {
    let reason: string;
    if (linksStats == null) {
      reason = "dados de links não disponíveis";
    } else if (Object.keys(linksStats).length === 0) {
      reason = "nenhum link rastreado";
    } else {
      // Distingue "editorial com 0 clicks" de "só links de sistema" (#2183):
      // filtra só sistema; se sobrar algo → havia links editoriais, mas todos com 0 clicks.
      const editorialEntries = Object.entries(linksStats).filter(([url]) => !isSystemLink(url));
      reason = editorialEntries.length > 0
        ? "links editoriais presentes, mas com 0 cliques registrados"
        : "nenhum link editorial (apenas links de sistema)";
    }
    return `<details class="links-ctr" id="links-${campaignId}">
  <summary class="links-summary">Links clicados <span class="links-count-badge">—</span></summary>
  <p class="links-empty">${escHtml(reason)}</p>
</details>`;
  }

  // Nota: totalClicks é o uniqueClicks agregado da campanha (inclui links de sistema),
  // enquanto a coluna "% do total" usa como denominador apenas os clicks editoriais.
  // Os dois denominadores diferem intencionalmente — totalClicks é contexto global,
  // % do total é participação relativa dentro dos links editoriais.
  const clicksSuffix = totalClicks !== undefined ? ` de ${totalClicks} únicos (campanha)` : "";
  const tableRows = rows.map((r) => {
    // Defensive XSS guard: neutralize javascript: and other dangerous schemes (#2183).
    // Only allow http:// and https:// as href values.
    const safeHref = /^https?:\/\//i.test(r.url) ? escHtml(r.url) : "";
    const linkContent = safeHref
      ? `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" title="${escHtml(r.url)}">${escHtml(r.displayUrl)}</a>`
      : escHtml(r.displayUrl);
    return `<tr>
      <td class="link-url">${linkContent}</td>
      <td class="link-clicks metric">${r.clicks}</td>
      <td class="link-pct">${r.pctOfTotal}</td>
    </tr>`;
  }).join("\n");

  return `<details class="links-ctr" id="links-${campaignId}">
  <summary class="links-summary">Links clicados <span class="links-count-badge">${rows.length}</span>${clicksSuffix}</summary>
  <div class="links-table-wrap">
  <table class="links-table">
    <thead>
      <tr>
        <th class="link-url-th" title="URL do link clicado (links de sistema e descadastramento excluídos)">Link</th>
        <th title="Total de cliques neste link (unique-clicks por link não disponível na API Brevo v3)">Clicks</th>
        <th title="Participação deste link no total de clicks editoriais (links de sistema excluídos). Denominador = soma dos clicks editoriais desta seção — difere do total da campanha exibido no summary acima.">% do total</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
  <p class="links-note">Clicks totais por link — unique-clicks por link não disponível na API Brevo v3 (apenas agregado em Clicks 🖱️ acima).</p>
</details>`;
}

// ─── #2212: seção de links agregados do período ──────────────────────────────

/**
 * Linha de link agregado (across campanhas).
 */
export interface AggregatedLinkRow {
  url: string;
  /** URL truncada para exibição (max 70 chars) */
  displayUrl: string;
  /** Soma de clicks deste link entre todas as campanhas do período */
  totalClicks: number;
  /** Número de campanhas onde este link apareceu */
  campaignCount: number;
}

/**
 * Agrega links de TODAS as campanhas do período, somando o mesmo URL entre campanhas.
 * Filtra links de sistema usando `isSystemLink` (reutilizado — sem duplicação).
 * Retorna array ordenado por totalClicks DESC.
 * Graceful: sem dados de links → retorna [].
 *
 * @param campaigns - lista de campanhas (todas, com statistics.linksStats populado)
 * @returns array de AggregatedLinkRow ordenado por totalClicks DESC
 */
export function aggregateLinksAcrossCampaigns(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number; linksStats?: BrevoLinksStats }>,
): AggregatedLinkRow[] {
  const urlMap = new Map<string, { totalClicks: number; campaignCount: number }>();

  for (const c of campaigns) {
    // #2216 finding #4: getCampaignLinksStats helper elimina dual-source duplicado
    const linksStats = getCampaignLinksStats(c);
    if (!linksStats) continue;

    for (const [url, clicks] of Object.entries(linksStats)) {
      // Filtrar links de sistema reutilizando isSystemLink (sem duplicar lógica)
      if (isSystemLink(url)) continue;
      // #2216 finding #3: Number.isFinite guard — `clicks <= 0` é NaN-transparente
      // (NaN <= 0 é false, então NaN passaria o guard e acumularia em totalClicks).
      // Paridade com parseLinksStats. Consistente com classe NaN do #2207.
      if (!Number.isFinite(clicks) || clicks <= 0) continue;

      const existing = urlMap.get(url);
      if (existing) {
        existing.totalClicks += clicks;
        existing.campaignCount += 1;
      } else {
        urlMap.set(url, { totalClicks: clicks, campaignCount: 1 });
      }
    }
  }

  if (urlMap.size === 0) return [];

  return Array.from(urlMap.entries())
    .map(([url, { totalClicks, campaignCount }]) => ({
      url,
      displayUrl: truncateUrl(url), // #2216 finding #2: extraído helper truncateUrl
      totalClicks,
      campaignCount,
    }))
    .sort((a, b) => b.totalClicks - a.totalClicks);
}

/**
 * Renderiza a seção "Links mais clicados do período" com links agregados de TODAS as campanhas.
 * Sempre visível (seção presente mesmo sem dados — graceful stub).
 * Exportado pra teste unitário.
 *
 * @param rows - resultado de aggregateLinksAcrossCampaigns()
 */
export function renderAggregatedLinksSection(rows: AggregatedLinkRow[]): string {
  if (rows.length === 0) {
    return `
<section class="phase2-section" id="links-agregados">
  <h2 class="section-title">Links mais clicados do período</h2>
  <p class="section-note">Sem dados de links disponíveis para o período.</p>
</section>`;
  }

  const totalClicks = rows.reduce((sum, r) => sum + r.totalClicks, 0);

  const tableRows = rows.map((r) => {
    const safeHref = /^https?:\/\//i.test(r.url) ? escHtml(r.url) : "";
    const linkContent = safeHref
      ? `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" title="${escHtml(r.url)}">${escHtml(r.displayUrl)}</a>`
      : escHtml(r.displayUrl);
    const pctShare = pct(r.totalClicks, totalClicks);
    return `<tr>
      <td class="link-url">${linkContent}</td>
      <td class="link-clicks metric">${r.totalClicks}</td>
      <td class="link-pct">${pctShare}</td>
      <td>${r.campaignCount}</td>
    </tr>`;
  }).join("\n");

  return `
<section class="phase2-section" id="links-agregados">
  <h2 class="section-title">Links mais clicados do período</h2>
  <p class="section-note">${rows.length} links editoriais · ${totalClicks} clicks totais (soma across campanhas). Links de sistema excluídos.</p>
  <div class="table-wrap">
  <table class="links-table">
    <thead>
      <tr>
        <th class="link-url-th" title="URL do link (links de sistema e descadastramento excluídos)">Link</th>
        <th title="Total de cliques somados entre todas as campanhas do período">Clicks</th>
        <th title="Participação percentual no total de clicks editoriais do período">%</th>
        <th title="Número de campanhas onde este link apareceu">Campanhas</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
  <p class="links-note">Clicks totais por link — unique-clicks por link não disponível na API Brevo v3.</p>
</section>`;
}

function hoursSince(iso: string | null): string {
  if (!iso) return "—";
  const elapsed = Date.now() - Date.parse(iso);
  if (isNaN(elapsed)) return "—";
  const hours = elapsed / 3600000;
  if (hours < 1) return `${Math.round(hours * 60)}min`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function fmtTimeBRT(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  // #2085: weekday:"short" acrescenta dia da semana (ex: "qua., 11/06 06:00")
  // pra facilitar leitura de padrões de engajamento por dia.
  return d.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// NOTE (#2207): `linksStats?` no shape abaixo é mantido SOMENTE para fixtures de teste
// (backward compat: testes que passam linksStats top-level diretamente). Em produção,
// `fetchRecentCampaigns` nunca produz top-level `linksStats` desde #2199.3 — a propriedade
// canônica é sempre `statistics.linksStats`. Produção não usa o campo top-level.
export function renderDashboardHtml(campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number; linksStats?: BrevoLinksStats }>): string {
  const rows = campaigns
    .map((c) => {
      // #1141: prioriza globalStats (com Apple MPP, bate com Brevo Web UI).
      // Fallback pra campaignStats[0] se globalStats fetch falhou OU veio
      // zeroed (o listing retorna globalStats com todos os campos = 0 —
      // verificado 2026-05-12. fetchRecentCampaigns filtra esse caso, mas
      // o render é defensive-in-depth: trata sent=0 como "stats indisponível").
      const gs = c.statistics?.globalStats;
      const cs = c.statistics?.campaignStats?.[0];
      const gsIsReal = gs && gs.sent > 0;
      const s = gsIsReal ? gs : cs;
      // #2199.5: hoist canonical linksStats to single variable (one source of truth).
      // c.statistics?.linksStats is canonical (set by fetchRecentCampaigns #2199.3).
      // c.linksStats fallback preserved for backward compat (tests/mocks that pass top-level).
      const linksStats = c.statistics?.linksStats ?? c.linksStats;
      if (!s) {
        // #2198 Bug 1: passa linksStats real mesmo quando stats ausente, evitando
        // "dados não disponíveis" para campanha que tem linksStats mas não globalStats/campaignStats.
        const linksHtmlNoStats = renderLinksSection(c.id, linksStats);
        return `<tr><td>${c.id}</td><td>${escHtml(c.listName ?? "?")}</td><td>${fmtTimeBRT(c.sentDate)}</td><td>—</td><td colspan="7" style="color:${DS.ink};opacity:0.6;font-style:italic;">sem stats</td></tr>
      <tr class="links-row"><td colspan="11" class="links-cell">${linksHtmlNoStats}</td></tr>`;
      }
      const openRate = pct(s.uniqueViews, s.delivered);
      const ctr = pct(s.uniqueClicks, s.delivered);
      const bounceRate = pct(s.hardBounces + s.softBounces, s.sent);
      // Per circuit breakers doc 2026-05-12: unsub e spam sobre `sent`
      // (não `delivered`). Pequena diferença na prática (sent ≈ delivered +
      // bounces), mas mantém consistência com a doc operacional.
      const unsubRate = pct(s.unsubscriptions, s.sent);
      const spamRate = pct(s.complaints, s.sent);

      // Numeric versions pra comparar contra thresholds dos circuit breakers
      // (CLAUDE.md: doc operacional 2026-05-12). Alerta visual quando crossado.
      const openRateNum = s.delivered > 0 ? (s.uniqueViews / s.delivered) * 100 : 0;
      const bounceRateNum = s.sent > 0 ? ((s.hardBounces + s.softBounces) / s.sent) * 100 : 0;
      const unsubRateNum = s.sent > 0 ? (s.unsubscriptions / s.sent) * 100 : 0;
      const spamRateNum = s.sent > 0 ? (s.complaints / s.sent) * 100 : 0;
      // Thresholds dos circuit breakers.
      // openAlert exige `openRateNum > 0` pra não acionar quando o dado ainda
      // tá propagando (campanha recém-enviada, opens ainda chegando — Brevo
      // tipicamente registra MPP nos primeiros minutos). Trade-off: campanha
      // genuinamente com 0% engajamento permanente NÃO alerta. Em prática raro
      // (Brevo sempre tem MPP). Se virar problema, condicionar a `delivered >= 50`.
      const openAlert = openRateNum > 0 && openRateNum < 15;
      const bounceAlert = bounceRateNum >= 3;
      const unsubAlert = unsubRateNum >= 3;
      const spamAlert = spamRateNum >= 0.1;
      const mppOpens = gsIsReal ? (gs?.appleMppOpens ?? 0) : 0;
      const opensNoMpp = s.uniqueViews - mppOpens;
      const openRateNoMpp = pct(opensNoMpp, s.delivered);

      // Opens cell tem layout duplo quando há MPP (#1153): top mostra
      // "taxa-com-MPP (taxa-sem-MPP)" e bottom mostra "count-total (count-sem-MPP)".
      // Sem MPP: layout simples (taxa única + count único).
      const opensTopLine = mppOpens > 0
        ? `${openRate} <span class="rate-inline">(${openRateNoMpp})</span>`
        : openRate;
      const opensBottomLine = mppOpens > 0
        ? `${s.uniqueViews} (${opensNoMpp})`
        : `${s.uniqueViews}`;

      // #2086 B2: trackableViewsRate = trackableViews / delivered
      // Indica emails com rastreamento real (exclui MPP/bots que não carregam pixel).
      // ?? 0 defensivo: campo pode estar ausente no shape real da Brevo (latente em campaignStats).
      const trackableRate = pct(s.trackableViews ?? 0, s.delivered);

      // #1132/dashboard: strip parênteses do nome da lista pra display
      // (Brevo nomes têm "(150 contatos)" hardcoded). O size real vem do
      // `totalSubscribers` da API, mais fiel + atualizado.
      const cleanListName = (c.listName ?? "?").replace(/\s*\([^)]*\)\s*/g, "").trim();
      // #2177: links section colapsável por campanha
      const linksHtml = renderLinksSection(
        c.id,
        linksStats,
        s.uniqueClicks,
      );
      return `<tr>
        <td>${c.id}</td>
        <td><strong>${escHtml(cleanListName)}</strong></td>
        <td>${fmtTimeBRT(c.sentDate)}<br><small>${hoursSince(c.sentDate)} atrás</small></td>
        <td>${s.sent}</td>
        <td>${pct(s.delivered, s.sent)}<br><small>${s.delivered}</small></td>
        <td${cellClass("metric", openAlert && "alert")}>${opensTopLine}<br><small>${opensBottomLine}</small></td>
        <td class="metric trackable">${trackableRate}<br><small>${s.trackableViews ?? 0}</small></td>
        <td${cellClass("metric")}>${ctr}<br><small>${s.uniqueClicks}</small></td>
        <td${cellClass(bounceAlert && "alert")}>${bounceRate}<br><small>${s.hardBounces + s.softBounces}</small></td>
        <td${cellClass(unsubAlert && "alert")}>${unsubRate}<br><small>${s.unsubscriptions}</small></td>
        <td${cellClass(spamAlert && "alert")}>${spamRate}<br><small>${s.complaints}</small></td>
      </tr>
      <tr class="links-row"><td colspan="11" class="links-cell">${linksHtml}</td></tr>`;
    })
    .join("\n");

  const now = new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  // #2086 Fase 2: seções adicionais
  const activeCycle = detectActiveCycle(campaigns);
  const abcRows = activeCycle ? aggregateAbcSummary(campaigns, activeCycle) : [];
  const cumSent = activeCycle ? calcCumulativeSent(campaigns, activeCycle) : 0;
  const volumeSection = activeCycle ? renderVolumeSection(cumSent) : "";
  const abcSection = activeCycle ? renderAbcSection(abcRows) : "";
  const trendRows = buildTrendRows(campaigns);
  const trendSection = renderTrendSection(trendRows);
  // #2134: tabela de open rate por dia da semana (ciclo ativo).
  // Escopo: ciclo ativo quando detectado; fallback "todas as campanhas" quando
  // não há campanha Clarice News (activeCycle=null). Linha all-time separada
  // não implementada — custo de render zero pois os dados já estão em memória,
  // mas optamos por manter UI simples: 1 tabela por view. Revisitar se editor
  // pedir comparação cross-ciclo explícita.
  const weekdayScopeLabel = "todos os envios"; // #2134 follow-up: editor pediu histórico completo, não só o ciclo ativo
  const weekdayRows = aggregateByWeekday(campaigns, null);
  const weekdaySection = weekdayRows.length > 0 ? renderWeekdaySection(weekdayRows, weekdayScopeLabel) : "";
  // #2212: seção de links agregados do período
  const aggregatedLinks = aggregateLinksAcrossCampaigns(campaigns);
  const aggregatedLinksSection = renderAggregatedLinksSection(aggregatedLinks);

  // #2084: CSS usa tokens do DS (DS.*/DSF.*). Vars --muted e --rule-header
  // são derivadas do DS: --muted = ink com opacity 55% (ferramenta interna,
  // sem token canônico de cinza — DS só tem ink; usamos inline hex aproximado
  // #666 → substituído por DS.ink para uniformidade, com opacity via class).
  // --rule-header = DS.rule (bege #EBE5D0); --rule de linhas = DS.rule.
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diar.ia Clarice Dashboard</title>
<style>
  :root {
    --brand: ${DS.brand};
    --ink: ${DS.ink};
    --paper: ${DS.paper};
    --paper-alt: ${DS.paperAlt};
    --rule: ${DS.rule};
    --alert: ${DS.alert};
  }
  body { font-family: ${DSF.sans}; max-width: 1200px; margin: 30px auto; padding: 0 20px; background: var(--paper); color: var(--ink); }
  h1 { font-size: 1.6rem; margin: 0 0 4px 0; color: var(--ink); }
  .sub { color: var(--ink); opacity: 0.6; font-size: 0.9rem; margin: 0 0 24px 0; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { padding: 8px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
  th { background: var(--paper-alt); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--ink); position: sticky; top: 0; cursor: help; border-bottom: 2px solid rgba(23,20,17,0.18); }
  /* #2104: borda do th era --rule (#EBE5D0) sobre fundo --paper-alt (#EBE5D0) → invisível.
     Substituída por ink (#171411) com 18% opacity — visível no DS claro sem ser pesada. */
  td.metric { font-weight: 600; color: var(--brand); }
  td.trackable { font-size: 0.85em; opacity: 0.85; }
  td.alert { font-weight: 600; color: var(--alert); }
  td.alert small, td.alert .rate-inline { color: var(--alert); opacity: 1; }
  .alert-label { font-weight: 600; color: var(--alert); }
  td .rate-inline { font-weight: normal; color: var(--ink); }
  td small { color: var(--ink); opacity: 0.6; font-weight: normal; }
  .footer { color: var(--ink); opacity: 0.6; font-size: 0.75rem; margin-top: 24px; text-align: center; }
  .footer code { background: var(--paper-alt); padding: 1px 5px; border-radius: 3px; font-size: 0.95em; }
  /* #2086: seções de fase 2 */
  .phase2-section { margin: 32px 0 8px 0; }
  .section-title { font-size: 1.1rem; font-weight: 700; margin: 0 0 6px 0; color: var(--ink); border-bottom: 2px solid var(--rule); padding-bottom: 6px; }
  .section-note { font-size: 0.85rem; color: var(--ink); opacity: 0.75; margin: 0 0 12px 0; }
  .volume-note { font-size: 0.95rem; margin-top: 10px; } /* número no font do DS; só a spark-bar é monospace */
  .spark-bar { display: block; font-family: monospace; font-size: 0.8rem; line-height: 1.2; letter-spacing: -1px; color: var(--brand); margin-top: 4px; overflow: hidden; white-space: nowrap; }
  td.spark { font-family: monospace; letter-spacing: -1px; color: var(--brand); font-size: 0.8rem; white-space: nowrap; }
  /* #2177: CTR por link */
  tr.links-row td.links-cell { padding: 0; border-bottom: 2px solid var(--rule); background: var(--paper); }
  details.links-ctr { margin: 0; }
  summary.links-summary { padding: 5px 8px; font-size: 0.8rem; cursor: pointer; color: var(--ink); opacity: 0.75; user-select: none; list-style: none; }
  summary.links-summary::-webkit-details-marker { display: none; }
  summary.links-summary::before { content: "▶ "; font-size: 0.65rem; }
  details[open] > summary.links-summary::before { content: "▼ "; }
  .links-count-badge { background: var(--paper-alt); border-radius: 8px; padding: 1px 6px; font-size: 0.75rem; margin-left: 4px; }
  .links-empty { padding: 4px 12px 6px; font-size: 0.8rem; color: var(--ink); opacity: 0.5; margin: 0; }
  .links-table-wrap { overflow-x: auto; padding: 0 8px 8px; }
  .links-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  .links-table th, .links-table td { padding: 4px 6px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
  .links-table th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.4px; background: transparent; color: var(--ink); opacity: 0.7; }
  .links-table td.link-url { max-width: 420px; word-break: break-all; }
  .links-table td.link-url a { color: var(--brand); text-decoration: none; }
  .links-table td.link-url a:hover { text-decoration: underline; }
  .links-table td.link-clicks { font-weight: 600; color: var(--brand); }
  .links-table td.link-pct { opacity: 0.75; }
  .links-note { font-size: 0.72rem; color: var(--ink); opacity: 0.5; padding: 2px 12px 6px; margin: 0; }
  @media (max-width: 700px) {
    body { margin: 16px auto; padding: 0 12px; }
    table { font-size: 0.8rem; }
    th, td { padding: 6px 4px; }
  }
</style>
</head>
<body>
<h1>📧 Diar.ia Clarice Dashboard</h1>
<p class="sub">Últimas ${campaigns.length} campaigns. Dados em tempo real — carregado às ${now} BRT.</p>
${volumeSection}
${abcSection}
${weekdaySection}
<section class="phase2-section" id="campaigns-table">
  <h2 class="section-title">Campanhas enviadas</h2>
<div class="table-wrap">
<table>
<thead>
<tr>
<th title="ID da campanha no Brevo.">ID</th>
<th title="Lista de destinatários no Brevo.">Lista</th>
<th title="Data e hora do envio (horário de Brasília).">Enviado</th>
<th title="Total de emails enviados (inclui bounces).">Sent</th>
<th title="Emails entregues nas caixas dos leitores.">Delivered</th>
<th title="Aberturas únicas. Inclui Apple MPP e bots/proxies. Bench: 15-25% B2C, 30-45% engajadas.">Opens 👁️</th>
<th title="trackableViews ÷ delivered: aperturas com pixel rastreável (exclui MPP/bots que não disparam pixel). Sinal mais limpo de engajamento real.">Trackable 📍</th>
<th title="Cliques únicos. Bench: 1.5-3% B2C.">Clicks 🖱️</th>
<th title="Hard bounces (inválido) + soft bounces (caixa cheia). Bench: <2% saudável. ≥3% pausa o ramp.">Bounces</th>
<th title="Descadastros. Esperado em baixo volume. Bench: <0.5%. ≥3% pausa o ramp.">Unsub</th>
<th title="Marcações de spam. Prejudica reputação do domínio. Bench: <0.1%. ≥0.1% pausa o ramp.">Spam</th>
</tr>
</thead>
<tbody>
${rows || `<tr><td colspan="11" style="text-align:center;color:${DS.ink};opacity:0.6;padding:24px;">Nenhuma campaign encontrada.</td></tr>`}
</tbody>
</table>
</div>
</section>
${trendSection}
${aggregatedLinksSection}
<p class="footer">Dados com cache de até 5 min — <a href="?fresh=1" style="color:var(--brand)">?fresh=1</a> força atualização imediata.<br>
Open rate e CTR calculados sobre <em>delivered</em>; bounce, unsub e spam sobre <em>sent</em>. Em cada coluna de métrica, a linha de cima é a taxa e a linha de baixo é o count absoluto. Passe o mouse nos headers pra ver detalhes de cada coluna.<br>
Em Opens, a taxa à esquerda é o total (com Apple MPP e bots, como na Brevo Web UI); entre parênteses, a taxa sem Apple MPP (ainda pode incluir outros bots). Coluna Trackable 📍 mostra aberturas com pixel real (trackableViews ÷ delivered). Dados brutos em <code>/api/campaigns</code>.<br>
Cells em <span class="alert-label">vermelho</span> indicam que a métrica cruzou o threshold de circuit breaker (open <15%, bounce ≥3%, unsub ≥3%, spam ≥0.1%).</p>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── #2086 Fase 2: helpers de agregação ──────────────────────────────────────

/**
 * Volume total do plano S1/ciclo 2605-06 conforme clarice-build-edition-sends.ts.
 * S1 = d01–d07 A/B/C = 5.600. Total S1+S2+S3 = 40.000.
 * Exportado pra teste unitário.
 */
export const CLARICE_PLAN_TOTAL = 40_000;
export const CLARICE_PLAN_S1 = 5_600;

/**
 * Extrai o ciclo e o número do dia de uma campanha Clarice News.
 * ex: "Clarice News 2605 d02-C (qui)" → { cycle: "2605", dayNum: 2, cell: "C" }
 * Retorna null para campanhas que não seguem o padrão.
 */
export function parseClariceCampaignKey(campaignName: string): {
  cycle: string;
  dayNum: number;
  cell: "A" | "B" | "C";
} | null {
  const m = campaignName.match(/Clarice News (\d{4}) d(\d{2})-([ABC])(?=\s|$)/i);
  if (!m) return null;
  return { cycle: m[1], dayNum: parseInt(m[2], 10), cell: m[3].toUpperCase() as "A" | "B" | "C" };
}

export interface CellSummary {
  cell: "A" | "B" | "C";
  /** Soma de uniqueViews das campanhas da célula */
  totalViews: number;
  /** Soma de delivered das campanhas da célula */
  totalDelivered: number;
  /** Open rate agregado (totalViews / totalDelivered) */
  openRate: number;
  /** Número de campanhas contabilizadas (dias enviados) */
  campaignCount: number;
}

/**
 * Agrega resumo A/B/C das campanhas S1 (d01–d07) de um ciclo Clarice.
 * Usa apenas campanhas com status "sent" e stats reais (gs.sent > 0).
 * Exportado pra teste unitário.
 */
export function aggregateAbcSummary(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
  cycle: string,
): CellSummary[] {
  const cells: Record<"A" | "B" | "C", { views: number; delivered: number; count: number }> = {
    A: { views: 0, delivered: 0, count: 0 },
    B: { views: 0, delivered: 0, count: 0 },
    C: { views: 0, delivered: 0, count: 0 },
  };

  for (const c of campaigns) {
    const parsed = parseClariceCampaignKey(c.name);
    if (!parsed || parsed.cycle !== cycle) continue;
    // S1 = d01–d07
    if (parsed.dayNum > 7) continue;

    const gs = c.statistics?.globalStats;
    // #2199: same robust guard as aggregateByWeekday — `!(gs.sent > 0)` covers
    // sent=0, sent=undefined, and sent=null, preventing NaN in accumulators.
    if (!gs || !(gs.sent > 0)) continue;

    cells[parsed.cell].views += gs.uniqueViews ?? 0;
    cells[parsed.cell].delivered += gs.delivered ?? 0;
    cells[parsed.cell].count += 1;
  }

  return (["A", "B", "C"] as const).map((cell) => {
    const d = cells[cell];
    return {
      cell,
      totalViews: d.views,
      totalDelivered: d.delivered,
      openRate: d.delivered > 0 ? (d.views / d.delivered) * 100 : 0,
      campaignCount: d.count,
    };
  });
}

/**
 * Calcula volume enviado cumulativo de campanhas Clarice News de um ciclo.
 * Soma "sent" de todas as campanhas do ciclo (todos os dias, todas as células).
 * Usa globalStats como primário (com Apple MPP, bate com Brevo UI); cai pra
 * campaignStats[0].sent se globalStats fetch falhou — evita subcontagem quando
 * o fetch individual de stats não funcionou pra alguma campanha.
 * Exportado pra teste unitário.
 */
export function calcCumulativeSent(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
  cycle: string,
): number {
  let total = 0;
  for (const c of campaigns) {
    const parsed = parseClariceCampaignKey(c.name);
    if (!parsed || parsed.cycle !== cycle) continue;
    const gs = c.statistics?.globalStats;
    const cs = c.statistics?.campaignStats?.[0];
    const gsIsReal = gs && gs.sent > 0;
    const sent = gsIsReal ? gs.sent : (cs?.sent ?? 0);
    if (!sent) continue;
    total += sent;
  }
  return total;
}

/**
 * Detecta o ciclo ativo (mais recente) entre campanhas Clarice News.
 * Retorna o cycle string (ex: "2605") ou null se nenhuma encontrada.
 * Exportado pra teste unitário.
 */
export function detectActiveCycle(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
): string | null {
  let latest: string | null = null;
  for (const c of campaigns) {
    const parsed = parseClariceCampaignKey(c.name);
    if (!parsed) continue;
    if (!latest || parsed.cycle > latest) latest = parsed.cycle;
  }
  return latest;
}

// ─── #2134: tabela de open rate por dia da semana ────────────────────────────

/**
 * Ordem canônica seg→dom (índice 0=seg, 6=dom).
 * Corresponde a `new Date().getDay()` mapeado pra ordem BRT-friendly:
 * JS getDay(): 0=dom, 1=seg, ..., 6=sab.
 * Aqui usamos nossa própria chave 0–6 (seg–dom) — ver weekdayKey().
 */
export const WEEKDAY_LABELS: Record<number, string> = {
  0: "Seg",
  1: "Ter",
  2: "Qua",
  3: "Qui",
  4: "Sex",
  5: "Sáb",
  6: "Dom",
};

export interface WeekdaySummary {
  /** 0=Seg, 1=Ter, 2=Qua, 3=Qui, 4=Sex, 5=Sáb, 6=Dom */
  weekday: number;
  label: string;
  /** Número de campanhas enviadas neste dia */
  count: number;
  delivered: number;
  opens: number;
  /** open rate agregado = opens / delivered (0 quando delivered=0) */
  openRate: number;
  /** true quando count < 2 — amostra insuficiente para conclusão */
  smallSample: boolean;
}

/**
 * Retorna a chave do dia da semana em BRT (0=Seg, 1=Ter, ..., 6=Dom).
 * Converte o ISO string pra BRT antes de extrair o weekday — evita erro
 * de "envio às 21h BRT = dia UTC seguinte" (ex: 22:00 BRT = 01:00 UTC+1dia).
 *
 * Estratégia: usa Intl.DateTimeFormat com timeZone BRT pra extrair o dia
 * numérico (JS weekday: 0=dom..6=sab → mapeado pra nossa escala 0=seg..6=dom).
 */
export function weekdayKeyBRT(iso: string): number | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;

  // Extrai partes de data em BRT via formatToParts
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
  }).formatToParts(d);

  const weekdayShort = parts.find((p) => p.type === "weekday")?.value ?? "";

  // Mapeia abreviação pt-BR → índice 0=Seg..6=Dom
  // Browsers/Node retornam "seg.", "ter.", "qua.", "qui.", "sex.", "sáb.", "dom."
  // Fazemos lowercase + strip ponto pra normalizar.
  const normalized = weekdayShort.toLowerCase().replace(/\./g, "").trim();
  const map: Record<string, number> = {
    seg: 0, ter: 1, qua: 2, qui: 3, sex: 4, sáb: 5, sab: 5, dom: 6,
  };
  return map[normalized] ?? null;
}

/**
 * Agrega open rate por dia da semana (seg–dom, BRT) para as campanhas do
 * ciclo ativo. Inclui apenas campanhas com stats reais (mesmo fallback do
 * render principal: globalStats primário, campaignStats[0] como fallback, ?? 0
 * defensivo para campos ausentes).
 *
 * Retorna apenas os weekdays que tiveram ao menos 1 campanha, ordenados seg→dom.
 * Weekdays com count < 2 são marcados com smallSample=true.
 *
 * @param campaigns - lista de campanhas (todas, filtradas internamente por ciclo)
 * @param cycle     - filtro por ciclo (ex: "2605"); produção passa SEMPRE null (todos os envios,
 *                    decisão do editor 2026-06-11) — o filtro vive pra testes/uso futuro
 * @returns array de WeekdaySummary ordenado por weekday (0=Seg..6=Dom)
 */
export function aggregateByWeekday(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
  cycle: string | null,
): WeekdaySummary[] {
  type Acc = { count: number; delivered: number; opens: number };
  const acc: Record<number, Acc> = {};

  for (const c of campaigns) {
    // Filtro por ciclo ativo (quando passado)
    if (cycle !== null) {
      const parsed = parseClariceCampaignKey(c.name);
      if (!parsed || parsed.cycle !== cycle) continue;
    }

    if (!c.sentDate) continue;

    // Mesmo fallback defensivo do render principal (#2124 defensivo)
    const gs = c.statistics?.globalStats;
    const cs = c.statistics?.campaignStats?.[0];
    const gsIsReal = gs && gs.sent > 0;
    const s = gsIsReal ? gs : cs;
    // #2198 Bug 2: `s.sent === 0` não cobre `s.sent === undefined` → NaN em openRate.
    // `!(s.sent > 0)` cobre 0, undefined e null corretamente.
    if (!s || !(s.sent > 0)) continue;

    const wk = weekdayKeyBRT(c.sentDate);
    if (wk === null) continue;

    if (!acc[wk]) acc[wk] = { count: 0, delivered: 0, opens: 0 };
    acc[wk].count += 1;
    acc[wk].delivered += s.delivered ?? 0;
    acc[wk].opens += s.uniqueViews ?? 0;
  }

  // Ordenar seg→dom (chave 0..6) e construir WeekdaySummary
  return Object.keys(acc)
    .map(Number)
    .sort((a, b) => a - b)
    .map((wk) => {
      const d = acc[wk];
      return {
        weekday: wk,
        label: WEEKDAY_LABELS[wk] ?? `Dia ${wk}`,
        count: d.count,
        delivered: d.delivered,
        opens: d.opens,
        openRate: d.delivered > 0 ? (d.opens / d.delivered) * 100 : 0,
        smallSample: d.count < 2,
      };
    });
}

/**
 * Renderiza a seção de open rate por dia da semana.
 * Melhor dia destacado com ▲ MELHOR DIA (mesmo padrão visual do LÍDER A/B/C).
 * Empate → mesmo tratamento do #2118/#2124 (nenhuma linha recebe tag).
 * Semana completa seg→dom; dias sem campanha são omitidos.
 * Exportado pra teste unitário.
 */
export function renderWeekdaySection(
  rows: WeekdaySummary[],
  scopeLabel: string,
): string {
  if (rows.length === 0) return "";

  // Calcula melhor dia (max openRate entre rows com count >= 1)
  // Empate: nenhuma linha recebe tag
  const validRows = rows.filter((r) => r.count > 0);
  const maxRate = validRows.reduce((m, r) => Math.max(m, r.openRate), 0);
  const tiedCount = validRows.filter((r) => r.openRate === maxRate).length;
  const isTied = validRows.length >= 2 && tiedCount > 1;
  const winnerWk = !isTied && validRows.length >= 2
    ? (validRows.find((r) => r.openRate === maxRate)?.weekday ?? null)
    : null;

  // #2134 follow-up (editor 2026-06-11): exibir do melhor open rate pro pior.
  const orderedRows = [...rows].sort((a, b) => {
    if (a.count === 0 && b.count === 0) return 0;
    if (a.count === 0) return 1;
    if (b.count === 0) return -1;
    return b.openRate - a.openRate;
  });

  const tableRows = orderedRows
    .map((r) => {
      const isWinner = r.weekday === winnerWk;
      const winnerTag = isWinner ? ` <strong style="color:${DS.brand}">▲ MELHOR DIA</strong>` : "";
      const smallSampleNote = r.smallSample
        ? ` <span style="color:${DS.ink};opacity:0.6;font-size:0.8em;">(amostra pequena)</span>`
        : "";
      const openRateFmt = r.openRate.toFixed(1) + "%";
      return `<tr>
        <td><strong>${escHtml(r.label)}</strong></td>
        <td>${r.count}</td>
        <td>${r.delivered.toLocaleString("pt-BR")}</td>
        <td>${r.opens.toLocaleString("pt-BR")}</td>
        <td class="metric">${openRateFmt}${winnerTag}${smallSampleNote}</td>
      </tr>`;
    })
    .join("\n");

  const allZero = isTied && maxRate === 0;
  const statusNote = allZero
    ? `Aguardando dados de abertura — primeiras horas pós-envio.`
    : isTied
    ? `Empate entre dias com ${maxRate.toFixed(1)}% — aguardar mais dados.`
    : validRows.length < 2
    ? `Dados insuficientes — aguardar mais dias de envio.`
    : winnerWk !== null
    ? `Melhor dia provisório: <strong style="color:${DS.brand}">${WEEKDAY_LABELS[winnerWk]}</strong> — aguardar mais dados para conclusão.`
    : `Dados insuficientes para comparação.`;

  return `
<section class="phase2-section" id="weekday-openrate">
  <h2 class="section-title">Open rate por dia da semana — ${escHtml(scopeLabel)}</h2>
  <p class="section-note">${statusNote}</p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Dia da semana do envio (horário de Brasília)">Dia</th>
        <th title="Número de campanhas enviadas neste dia">Campanhas</th>
        <th title="Total entregue">Delivered</th>
        <th title="Soma de aberturas únicas (uniqueViews) das campanhas enviadas neste dia.">Opens</th>
        <th title="Open rate agregado: opens ÷ delivered. Dias com < 2 campanhas = amostra pequena.">Open rate agr.</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
</section>`;
}

export interface WaveTrendRow {
  label: string;
  sentDate: string | null;
  openRate: number;
  bounceRate: number;
  sent: number;
  delivered: number;
}

/**
 * Monta tabela de tendência cronológica para todas as campanhas com stats reais.
 * Ordenada por sentDate ASC. Cada linha: label reduzido, data, open%, bounce%.
 * Exportado pra teste unitário.
 */
export function buildTrendRows(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
): WaveTrendRow[] {
  const rows: WaveTrendRow[] = [];

  // Ordenar por sentDate DESC — mais recente NO TOPO (pedido do editor 2026-06-11);
  // a mais antiga fica embaixo.
  const sorted = [...campaigns].sort((a, b) => {
    const da = a.sentDate ? Date.parse(a.sentDate) : 0;
    const db = b.sentDate ? Date.parse(b.sentDate) : 0;
    return db - da;
  });

  for (const c of sorted) {
    if (!c.sentDate) continue;
    const gs = c.statistics?.globalStats;
    const cs = c.statistics?.campaignStats?.[0];
    const gsIsReal = gs && gs.sent > 0;
    const s = gsIsReal ? gs : cs;
    if (!s || !(s.sent > 0)) continue;

    // Label compacto: extrair a parte mais informativa do nome
    // "Diar.ia Mensal 2604 — 2026-05-17 14:45" → "Mensal 2604 W7"
    // "Clarice News 2605 d01-A (qua)" → "2605 d01-A"
    let label = c.name;
    const clariceMatch = c.name.match(/Clarice News (\d{4}) (d\d{2}-[ABC])/i);
    const mensalMatch = c.name.match(/Diar\.ia Mensal (\d{4})/i);
    const listNameMatch = (c.listName ?? "").match(/T1-(W\d+)/i);
    if (clariceMatch) {
      label = `${clariceMatch[1]} ${clariceMatch[2]}`;
    } else if (mensalMatch && listNameMatch) {
      label = `Mensal ${mensalMatch[1]} ${listNameMatch[1]}`;
    } else if (mensalMatch) {
      label = `Mensal ${mensalMatch[1]}`;
    }

    const openRate = s.delivered > 0 ? (s.uniqueViews / s.delivered) * 100 : 0;
    const bounceRate = s.sent > 0 ? ((s.hardBounces + s.softBounces) / s.sent) * 100 : 0;

    rows.push({
      label,
      sentDate: c.sentDate,
      openRate,
      bounceRate,
      sent: s.sent,
      delivered: s.delivered,
    });
  }

  return rows;
}

/**
 * Renderiza a seção de resumo A/B/C da S1.
 * Exportado pra teste unitário.
 */
export function renderAbcSection(abcRows: CellSummary[]): string {
  if (abcRows.every((r) => r.campaignCount === 0)) return "";

  const sampledRows = abcRows.filter((r) => r.campaignCount > 0);
  const allSampled = sampledRows.length >= 2;

  // Winner: célula com maior open rate entre as que têm dados.
  // Em empate (taxa idêntica), nenhuma célula recebe tag LÍDER — exibir "EMPATE".
  const maxRate = sampledRows.reduce((m, r) => Math.max(m, r.openRate), 0);
  const tiedCount = sampledRows.filter((r) => r.openRate === maxRate).length;
  const isTied = allSampled && tiedCount > 1;
  const winnerCell = !isTied && allSampled
    ? sampledRows.find((r) => r.openRate === maxRate)?.cell ?? null
    : null;

  // #2134 follow-up (editor 2026-06-11): ordenar do melhor open rate pro pior;
  // células sem dados (campaignCount 0) vão pro fim.
  const orderedRows = [...abcRows].sort((a, b) => {
    if (a.campaignCount === 0 && b.campaignCount === 0) return 0;
    if (a.campaignCount === 0) return 1;
    if (b.campaignCount === 0) return -1;
    return b.openRate - a.openRate;
  });

  const cellRows = orderedRows
    .map((r) => {
      const isWinner = r.cell === winnerCell && r.campaignCount > 0;
      const winnerTag = isWinner ? ` <strong style="color:${DS.brand}">▲ LÍDER</strong>` : "";
      const openRateFmt = r.campaignCount > 0 ? r.openRate.toFixed(1) + "%" : "—";
      return `<tr>
        <td><strong>Célula ${r.cell}</strong></td>
        <td>${r.campaignCount > 0 ? r.totalViews : "—"}</td>
        <td>${r.campaignCount > 0 ? r.totalDelivered : "—"}</td>
        <td class="${r.campaignCount > 0 ? "metric" : ""}">${openRateFmt}${winnerTag}</td>
        <td>${r.campaignCount}</td>
      </tr>`;
    })
    .join("\n");

  // Quando todas as células amostradas têm openRate 0 (primeiras horas pós-envio,
  // antes de qualquer abertura registrada), evitar "Empate...0.0%" — informação enganosa.
  const allZero = isTied && maxRate === 0;
  const statusNote = allZero
    ? `Aguardando dados de abertura — primeiras horas pós-envio.`
    : isTied
    ? `Empate entre células com ${maxRate.toFixed(1)}% — aguardar mais dias de envio.`
    : allSampled && winnerCell
    ? `Vencedor provisório: <strong style="color:${DS.brand}">Célula ${winnerCell}</strong> — aguardar checkpoint de análise para decisão final.`
    : `Dados insuficientes para comparação — aguardar mais dias de envio.`;

  return `
<section class="phase2-section" id="abc-summary">
  <h2 class="section-title">Resumo A/B/C — S1 (d01–d07)</h2>
  <p class="section-note">${statusNote}</p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Célula do teste A/B/C">Célula</th>
        <th title="Soma de aberturas únicas dos dias enviados">Opens (total)</th>
        <th title="Soma de entregues dos dias enviados">Delivered (total)</th>
        <th title="Open rate agregado: opens ÷ delivered">Open rate agr.</th>
        <th title="Dias enviados contabilizados">Dias</th>
      </tr>
    </thead>
    <tbody>${cellRows}</tbody>
  </table>
  </div>
</section>`;
}

/**
 * Renderiza a seção de Volume enviado no ciclo — primeira informação do dashboard
 * (decisão do editor 2026-06-11: volume vem ANTES do resumo A/B/C).
 * Exportado pra teste unitário.
 */
export function renderVolumeSection(cumulativeSent: number): string {
  const pctBar = Math.min(100, (cumulativeSent / CLARICE_PLAN_TOTAL) * 100);
  const pctLabel = pctBar.toFixed(1);
  const barFill = Math.round(pctBar * 0.3); // 30 chars = 100%
  const bar = "█".repeat(barFill) + "░".repeat(30 - barFill);
  return `
<section class="phase2-section" id="volume-ciclo">
  <h2 class="section-title">Volume enviado no ciclo</h2>
  <p class="section-note volume-note">
    <strong>${cumulativeSent.toLocaleString("pt-BR")}</strong> de ${CLARICE_PLAN_TOTAL.toLocaleString("pt-BR")} (${pctLabel}%)<br>
    <span class="spark-bar" title="${pctLabel}% do plano total">${bar}</span>
  </p>
</section>`;
}

/**
 * Renderiza a seção de tendência entre waves (mini-tabela cronológica).
 * Exportado pra teste unitário.
 */
export function renderTrendSection(rows: WaveTrendRow[]): string {
  if (rows.length === 0) return "";

  const trendRows = rows
    .map((r) => {
      const openAlert = r.openRate > 0 && r.openRate < 15;
      const bounceAlert = r.bounceRate >= 3;
      // Sparkline ASCII simples: █ = 10pp, escala 0–50%
      const openTicks = Math.min(10, Math.round(r.openRate / 5));
      const spark = "█".repeat(openTicks) + "░".repeat(10 - openTicks);
      return `<tr>
        <td>${escHtml(r.label)}</td>
        <td>${fmtTimeBRT(r.sentDate)}</td>
        <td${openAlert ? ` class="alert"` : ""}>${r.openRate.toFixed(1)}%</td>
        <td${bounceAlert ? ` class="alert"` : ""}>${r.bounceRate.toFixed(1)}%</td>
        <td class="spark">${spark}</td>
        <td>${r.sent.toLocaleString("pt-BR")}</td>
      </tr>`;
    })
    .join("\n");

  return `
<section class="phase2-section" id="wave-trend">
  <h2 class="section-title">Tendência entre waves</h2>
  <p class="section-note">Open rate e bounce rate por envio — do mais recente (topo) ao mais antigo.</p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Campanha">Campanha</th>
        <th title="Data/hora do envio (BRT)">Enviado</th>
        <th title="Open rate (uniqueViews ÷ delivered). Alerta < 15%.">Open%</th>
        <th title="Bounce rate ((hard+soft) ÷ sent). Alerta ≥ 3%.">Bounce%</th>
        <th title="Sparkline de open rate (cada █ = ~5pp, escala 0–50%)">Open ▏</th>
        <th title="Total enviado">Sent</th>
      </tr>
    </thead>
    <tbody>${trendRows}</tbody>
  </table>
  </div>
</section>`;
}

/**
 * Renderiza resposta de rate limit amigável (#2144).
 * Retorna 503 + Retry-After quando o listing Brevo responde 429.
 */
function rateLimitResponse(retryAfterSecs: number | null, isHtml: boolean): Response {
  const retryMsg = retryAfterSecs != null ? `${retryAfterSecs}s` : "alguns minutos";
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
  };
  if (retryAfterSecs != null) headers["Retry-After"] = String(retryAfterSecs);

  if (isHtml) {
    const body = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>Rate limit — Diar.ia Clarice Dashboard</title>
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:60px auto;padding:0 20px;text-align:center;}</style>
</head>
<body>
<h1>⏳ Brevo rate limit</h1>
<p>A API da Brevo retornou 429 (too many requests).<br>
Aguarde <strong>${escHtml(retryMsg)}</strong> e tente novamente.<br>
<a href="?fresh=1">Tentar agora</a></p>
</body></html>`;
    return new Response(body, { status: 503, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  }

  return new Response(
    JSON.stringify({ error: "brevo_rate_limit", retryAfterSecs }),
    { status: 503, headers: { ...headers, "Content-Type": "application/json" } },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/healthz") {
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    }

    // #2144: edge cache 5min via Cache API pras rotas cacheáveis.
    // fresh=1 → bypass completo: nem edge cache nem KV de stats imutáveis.
    const isFresh = url.searchParams.get("fresh") === "1";
    const isCacheable = (path === "/" || path === "/index.html" || path === "/api/campaigns");
    const cache = caches.default;

    if (isCacheable && !isFresh) {
      const cached = await cache.match(request);
      if (cached) return cached;
    }

    if (path === "/api/campaigns") {
      try {
        const limit = Math.min(50, Number(url.searchParams.get("limit") ?? "20") || 20);
        const campaigns = await fetchRecentCampaigns(env, limit, isFresh);
        const response = new Response(JSON.stringify(campaigns, null, 2), {
          headers: {
            "Content-Type": "application/json",
            // Cache-Control: private impede proxies compartilhados de cachear metricas
            // de negocio. CDN-Cache-Control (CF-especifico) permite cache no edge do
            // proprio Worker. fresh=1 retorna no-store para o browser nao cachear o "fresh".
            "Cache-Control": isFresh ? "no-store" : "private, max-age=300",
            ...(isFresh ? {} : { "CDN-Cache-Control": "public, max-age=300" }),
          },
        });
        if (!isFresh) {
          // Clonar antes de armazenar — Response só pode ser lida uma vez
          await cache.put(request, response.clone());
        }
        return response;
      } catch (e) {
        if (e instanceof BrevoRateLimitError) {
          return rateLimitResponse(e.retryAfterSecs, false);
        }
        return new Response(`Brevo fetch error: ${(e as Error).message}`, { status: 502 });
      }
    }

    if (path === "/" || path === "/index.html") {
      try {
        const campaigns = await fetchRecentCampaigns(env, 50, isFresh); // #2142 review: rota / hardcodava 20 e ignorava o default novo
        const html = renderDashboardHtml(campaigns);
        const response = new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": isFresh ? "no-store" : "private, max-age=300",
            ...(isFresh ? {} : { "CDN-Cache-Control": "public, max-age=300" }),
          },
        });
        if (!isFresh) {
          await cache.put(request, response.clone());
        }
        return response;
      } catch (e) {
        if (e instanceof BrevoRateLimitError) {
          return rateLimitResponse(e.retryAfterSecs, true);
        }
        return new Response(
          `<!DOCTYPE html><html><body><h1>Dashboard error</h1><p>${escHtml((e as Error).message)}</p></body></html>`,
          { status: 502, headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
