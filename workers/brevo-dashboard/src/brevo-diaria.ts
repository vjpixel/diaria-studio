/**
 * brevo-diaria.ts (#4515)
 *
 * Aba nova do dashboard `clarice-dashboard.diaria.workers.dev` pra monitorar
 * o canal `brevo_diaria` (#4266/#4476 — segmento Pending da Beehiiv,
 * reativado via conta Brevo PRÓPRIA do editor, `platform.config.json >
 * brevo_diaria`). Até esta issue, o único jeito de acompanhar
 * abertura/bounce/spam/unsub desse canal era entrar manualmente no painel da
 * Brevo — este módulo espelha, numa escala bem menor (conta com poucas
 * campanhas, não ~100 da Clarice), o padrão já usado por
 * `fetchRecentCampaigns` (brevo-api.ts) pra listar campanhas + stats.
 *
 * ## Conta SEPARADA, KV COMPARTILHADO — cuidado com colisão de chave
 *
 * `brevo_diaria` é uma conta Brevo inteiramente distinta da Clarice (API key
 * própria, `BREVO_DIARIA_API_KEY`) — mas o binding `STATS_CACHE` (KV) é o
 * MESMO namespace do Worker inteiro. Como cada conta Brevo numera
 * campanhas/listas de forma independente, um `campaign.id`/`list.id` da conta
 * `brevo_diaria` pode coincidir numericamente com um id da Clarice. Por isso
 * TODA chave KV usada aqui carrega o prefixo `diaria:` (`BREVO_DIARIA_KV_PREFIX`)
 * — nunca reusa `list:{id}`/`stats:{id}` (chaves da Clarice, brevo-api.ts).
 *
 * ## Fail-soft: secret ausente esconde a aba, nunca quebra o dashboard
 *
 * `BREVO_DIARIA_API_KEY` é OPCIONAL (mesmo padrão de `STRIPE_API_KEY`/
 * `COUPONS_TAB_ENABLED`, #2718) — sem ela, `fetchBrevoDiariaTabData` retorna
 * `null` e a aba fica oculta (ver `RenderDashboardOptions.brevoDiaria` em
 * sections-core.ts). Qualquer falha de fetch ao vivo (rede, rate-limit, 5xx)
 * cai num fallback stale via KV (`BREVO_DIARIA_LASTGOOD_KEY`) — mais simples
 * que o coalescing/lock cross-colo da Clarice (`tryAcquireRefreshLock`,
 * brevo-api.ts): volume de tráfego desta aba não justifica essa camada extra
 * ainda. Sem stale disponível, a aba aparece com um banner de erro inline —
 * nunca 502 o dashboard inteiro por causa deste canal secundário.
 *
 * ## Circuit breakers — mesmos limiares, MENOS confiança no sinal de spam
 *
 * Reusa `DEFAULT_HEALTH_THRESHOLDS`/`isBounceBreach` de `thresholds.ts` (a
 * mesma fonte única que a aba Agendamento da Clarice usa) — abertura<15%,
 * bounce duro≥2%, bounce total≥5%, spam≥0,3%, unsub≥3% (valores ATUAIS de
 * `thresholds.ts`, lidos dinamicamente daqui — nunca hardcoded neste módulo;
 * a issue #4515 citou "spam≥0,1%", mas esse era o limiar PRÉ-#4154 — o #4154
 * atualizou pro oficial do Postmaster Tools, 0,1% verde / 0,3% vermelho; este
 * módulo segue o `thresholds.ts` vivo, não o número congelado no corpo da
 * issue). Diferença DELIBERADA da Envios/Rampa Clarice: lá, spam NUNCA é colorido com o número
 * bruto da Brevo (`complaints`) porque o #4063 mediu que ele subconta o spam
 * real em ~50× — só a leitura do Google Postmaster Tools (que hoje só cobre
 * o domínio `clarice.ai`, ver `postmaster-spam-sync.ts`) é confiável o
 * bastante pra colorir. O domínio `diar.ia.br` não tem esse sync ainda, então
 * esta aba NÃO tem alternativa melhor — coloriza com o `complaints`/`sent`
 * bruto mesmo assim (é o único sinal disponível, e a issue #4515 pede
 * explicitamente o breaker de spam aqui). O aviso fica explícito no próprio
 * painel (ver `renderBrevoDiariaTabPanel`), não escondido em comentário.
 *
 * ## Fila de contatos (`data/brevo-diaria/contacts.json`) — FORA DE ESCOPO
 *
 * A issue pede, "se viável sem reimplementar o store inteiro", o tamanho da
 * fila (quantos `in_brevo`/`promoted_beehiiv`/`suppressed`/`unsubscribed`).
 * Esse arquivo mora em `data/` (junction OneDrive, só local — ver CLAUDE.md
 * §Setup 2b) e NÃO é acessível de dentro de um Cloudflare Worker. Não existe
 * hoje nenhum script que sincronize esse resumo pro KV (diferente de
 * `contacts:summary`/`ContactsSummary`, que é o store ÚNICO da Clarice,
 * sincronizado por `clarice-db-summary.ts`) — introduzir esse mecanismo é
 * infraestrutura nova, fora do escopo desta PR (a própria issue trata isso
 * como opcional/condicional, não bloqueante). Documentado aqui E na própria
 * aba (nota inline) em vez de silenciosamente omitido.
 */
import type { Env, BrevoCampaign, BrevoGlobalStats, PostmasterSpamEntry } from "./types.ts";
import { RECENT_STATS_TTL } from "./types.ts";
import {
  brevoFetchWithApiKey,
  withRateLimitRetry,
  mapLimit,
  isImmutableCampaign,
  normalizePostmasterSpamEntry,
} from "./brevo-api.ts";
import { DEFAULT_HEALTH_THRESHOLDS, isBounceBreach, type HealthThresholds } from "./thresholds.ts";
import { DS, pct, cellClass, fmtTimeBRT, brevoReportLink } from "./render-links.ts";
// #4973: chave KV compartilhada com o produtor (scripts/postmaster-spam-sync.ts)
// — fonte única, ver docstring de `additionalPostmasterSpamKvKey`
// (dashboard-kv-types.ts) pro racional completo de por que este import
// existe em vez de cada lado hardcodar o formato da chave.
import { additionalPostmasterSpamKvKey } from "../../../scripts/lib/dashboard-kv-types.ts";
// NOTA (mesmo padrão de render-links.ts, comentário #2832): import circular
// com sections-core.ts (escHtml é definido lá; sections-core.ts importa
// renderBrevoDiariaTabPanel/BrevoDiariaTabData daqui). Seguro — todo uso
// abaixo roda dentro de corpo de função, em request-time, nunca em top-level
// do módulo, então a ordem de inicialização ESM não importa.
import { escHtml } from "./sections-core.ts";

/**
 * Prefixo de TODA chave KV desta aba — ver docstring do módulo acima
 * (namespace COMPARTILHADO com a Clarice; ids de conta Brevo diferente podem
 * colidir numericamente).
 */
export const BREVO_DIARIA_KV_PREFIX = "diaria:";

/** Última página boa conhecida (campanhas + timestamp) — fallback stale. */
export const BREVO_DIARIA_LASTGOOD_KEY = `${BREVO_DIARIA_KV_PREFIX}lastgood:campaigns`;
const BREVO_DIARIA_LASTGOOD_TTL = 24 * 3600; // 24h — mesma folga de LASTGOOD_TTL (Clarice)

/**
 * Janela de campanhas pedida à Brevo — bem menor que `CAMPAIGNS_FETCH_LIMIT`
 * (100, Clarice): o canal `brevo_diaria` tinha, na criação desta issue, um
 * punhado de campanhas (canário de 104 contatos, #4476 item 9). 20 dá folga
 * generosa sem custo de latência extra.
 */
export const BREVO_DIARIA_FETCH_LIMIT = 20;

/**
 * #4973: domínio deste canal no Google Postmaster Tools — confirmado VERIFIED
 * com tráfego publicado na sondagem da issue (3 dias/21, todos 0,00% spam).
 * Chave KV via `additionalPostmasterSpamKvKey` (fonte única com o produtor,
 * `scripts/postmaster-spam-sync.ts`) — NUNCA a chave legada `postmaster:spam`
 * (essa é `clarice.ai`, lida pelo breaker da Rampa).
 */
export const BREVO_DIARIA_POSTMASTER_DOMAIN = "diar.ia.br";
export const BREVO_DIARIA_POSTMASTER_SPAM_KV_KEY = additionalPostmasterSpamKvKey(BREVO_DIARIA_POSTMASTER_DOMAIN);

export type BrevoDiariaCampaignRow = BrevoCampaign & { listName?: string };

export interface BrevoDiariaTabData {
  campaigns: BrevoDiariaCampaignRow[];
  /** ISO — quando estes dados foram de fato buscados na Brevo (ou gravados no fallback stale). */
  generatedAt: string;
  /** `true` quando `campaigns` veio do fallback KV (live fetch falhou). */
  stale?: boolean;
  /** Mensagem de erro do live fetch — presente em `stale:true` OU quando não há stale disponível (`campaigns: []`). */
  error?: string;
  /**
   * #4973: leitura do Google Postmaster Tools pro domínio `diar.ia.br`
   * (`scripts/postmaster-spam-sync.ts`, chave `BREVO_DIARIA_POSTMASTER_SPAM_KV_KEY`)
   * — INDEPENDENTE do sucesso/falha do fetch de campanhas acima (lida sempre
   * que a aba está habilitada, mesmo quando `campaigns`/`stale`/`error` vêm
   * de um caminho de falha). `null` = sem leitura no KV — cobertura rala
   * (comum aqui, ver docstring do produtor) ou 1ª execução antes do sync
   * rodar; `renderBrevoDiariaPostmasterSpam` trata isso como "aguardando
   * publicação" explícito, nunca célula vazia/omitida. Opcional no TYPE
   * (`?`, não só `| null`) pra não quebrar literais de teste pré-#4973 que
   * constroem `BrevoDiariaTabData` sem este campo — `undefined` e `null`
   * significam a MESMA coisa pro render ("sem leitura"), nunca tratados como
   * estados distintos.
   */
  postmasterSpam?: PostmasterSpamEntry | null;
}

/**
 * Busca as campanhas ENVIADAS da conta `brevo_diaria` + enriquece com nome de
 * lista e `globalStats` por campanha (mesmo motivo do #1141 na Clarice: o
 * listing não popula `globalStats`, precisa de 1 GET individual por
 * campanha). Deliberadamente SEM `linksStats` (a issue não pede distribução
 * de cliques por link pra este canal, só as métricas agregadas por
 * campanha) — reduz pela metade os GETs por campanha vs. `fetchRecentCampaigns`.
 *
 * Nunca lança por falha EM UMA campanha/lista individual (mesmo padrão de
 * `fetchRecentCampaigns`) — só propaga se a LISTAGEM em si falhar (rede,
 * rate-limit, chave inválida), permitindo ao caller (`fetchBrevoDiariaTabData`)
 * decidir entre fallback stale ou erro visível.
 *
 * `apiKey` ausente (secret não configurado) → `[]` sem nenhuma chamada de
 * rede (o caller trata isso como "aba oculta", não como erro).
 */
export async function fetchBrevoDiariaCampaigns(
  env: Pick<Env, "BREVO_DIARIA_API_KEY" | "STATS_CACHE">,
  limit = BREVO_DIARIA_FETCH_LIMIT,
  isFresh = false,
  _fetchFn: typeof brevoFetchWithApiKey = brevoFetchWithApiKey,
): Promise<BrevoDiariaCampaignRow[]> {
  const apiKey = env.BREVO_DIARIA_API_KEY;
  if (!apiKey) return [];

  const data = await withRateLimitRetry(() =>
    _fetchFn<{ campaigns: BrevoCampaign[] }>(
      `/v3/emailCampaigns?status=sent&limit=${limit}&sort=desc`,
      apiKey,
    ),
  );
  const campaigns = data.campaigns ?? [];
  if (campaigns.length === 0) return [];

  const listIds = [...new Set(campaigns.flatMap((c) => c.recipients?.lists ?? []))];
  const listMap = new Map<number, { name: string; totalSubscribers?: number }>();
  const globalStatsMap = new Map<number, BrevoGlobalStats>();

  await Promise.all([
    // Nomes de lista — KV com TTL 7d (mesma folga de `fetchRecentCampaigns`).
    mapLimit(listIds, 5, async (id) => {
      try {
        const kvKey = `${BREVO_DIARIA_KV_PREFIX}list:${id}`;
        const cached =
          !isFresh && env.STATS_CACHE ? await env.STATS_CACHE.get(kvKey, "json").catch(() => null) : null;
        if (cached) {
          listMap.set(id, cached as { name: string; totalSubscribers?: number });
          return;
        }
        const list = await _fetchFn<{ id: number; name: string; totalSubscribers: number }>(
          `/v3/contacts/lists/${id}`,
          apiKey,
        );
        listMap.set(id, list);
        if (env.STATS_CACHE) {
          await env.STATS_CACHE
            .put(kvKey, JSON.stringify(list), { expirationTtl: 7 * 24 * 3600 })
            .catch(() => { /* erro de KV nunca bloqueia */ });
        }
      } catch {
        // Lista pode ter sido apagada -- linha cai no fallback "?" no render.
      }
    }),
    // globalStats por campanha — KV sem TTL pra imutáveis (>7d), TTL curto pra recentes.
    mapLimit(campaigns, 5, async (c) => {
      try {
        const kvStatsKey = `${BREVO_DIARIA_KV_PREFIX}stats:${c.id}`;
        const immutable = isImmutableCampaign(c.sentDate);
        if (!isFresh && env.STATS_CACHE) {
          const cachedGs = await env.STATS_CACHE.get(kvStatsKey, "json").catch(() => null);
          if (cachedGs) {
            globalStatsMap.set(c.id, cachedGs as BrevoGlobalStats);
            return;
          }
        }
        const detail = await withRateLimitRetry(() =>
          _fetchFn<{ statistics?: { globalStats?: BrevoGlobalStats } }>(
            `/v3/emailCampaigns/${c.id}?statistics=globalStats`,
            apiKey,
          ),
        );
        const gs = detail.statistics?.globalStats;
        // Só grava stats REAIS (sent>0) -- a Brevo pode devolver objeto
        // zerado; persistir zerado sem TTL criaria entrada permanente ruim.
        if (gs && gs.sent > 0) {
          globalStatsMap.set(c.id, gs);
          if (env.STATS_CACHE) {
            const opts = immutable ? {} : { expirationTtl: RECENT_STATS_TTL };
            await env.STATS_CACHE
              .put(kvStatsKey, JSON.stringify(gs), opts)
              .catch(() => { /* erro de KV nunca bloqueia */ });
          }
        }
      } catch {
        // Stats desta campanha ficam indisponíveis -- linha renderiza "sem stats".
      }
    }),
  ]);

  return campaigns.map((c) => {
    const ids = c.recipients?.lists ?? [];
    const list = ids.length ? listMap.get(ids[0]) : undefined;
    const globalStats = globalStatsMap.get(c.id);
    return {
      ...c,
      listName: list?.name,
      statistics: {
        ...c.statistics,
        ...(globalStats ? { globalStats } : {}),
      },
    };
  });
}

/**
 * #4973: lê a leitura do Postmaster pro domínio deste canal
 * (`BREVO_DIARIA_POSTMASTER_SPAM_KV_KEY`) — FAIL-SOFT (nunca lança, mesmo
 * padrão do resto do módulo): sem `STATS_CACHE`, KV miss (comum — cobertura
 * rala, ver docstring do produtor), ou payload corrompido, retorna `null`
 * (tratado pelo render como "aguardando publicação", não como erro).
 * Deliberadamente INDEPENDENTE da busca de campanhas acima — uma falha na
 * API Brevo (rede, rate-limit) não deve impedir a aba de mostrar a leitura
 * do Postmaster, e vice-versa.
 */
async function fetchBrevoDiariaPostmasterSpam(
  env: Pick<Env, "STATS_CACHE">,
): Promise<PostmasterSpamEntry | null> {
  if (!env.STATS_CACHE) return null;
  const raw = await env.STATS_CACHE.get(BREVO_DIARIA_POSTMASTER_SPAM_KV_KEY, "json").catch(() => null);
  return normalizePostmasterSpamEntry(raw);
}

/**
 * Orquestração de topo pra esta aba — NUNCA lança. `null` quando o secret
 * `BREVO_DIARIA_API_KEY` não está configurado (aba oculta, ver
 * `RenderDashboardOptions.brevoDiaria` em sections-core.ts). Qualquer falha
 * do live fetch cai no último dado bom conhecido no KV
 * (`BREVO_DIARIA_LASTGOOD_KEY`, write-through a cada sucesso, mesmo padrão de
 * `LASTGOOD_CAMPAIGNS_KEY` na Clarice); sem stale disponível, retorna
 * `campaigns: []` com `error` preenchido (o painel mostra um banner
 * explícito em vez de esconder a falha).
 *
 * `postmasterSpam` (#4973) é buscado em TODOS os caminhos de retorno — ver
 * `fetchBrevoDiariaPostmasterSpam` (independente do resultado das campanhas).
 */
export async function fetchBrevoDiariaTabData(
  env: Pick<Env, "BREVO_DIARIA_API_KEY" | "STATS_CACHE">,
  isFresh = false,
  // Injetável em testes (mesmo padrão de `_fetchFn` em `fetchBrevoDiariaCampaigns`/
  // `fetchRecentCampaigns`) — garante que NENHUM teste desta função precise
  // tocar a rede real, mesmo indiretamente através desta camada de orquestração.
  _fetchFn: typeof brevoFetchWithApiKey = brevoFetchWithApiKey,
): Promise<BrevoDiariaTabData | null> {
  if (!env.BREVO_DIARIA_API_KEY) return null;
  const postmasterSpam = await fetchBrevoDiariaPostmasterSpam(env);
  try {
    const campaigns = await fetchBrevoDiariaCampaigns(env, BREVO_DIARIA_FETCH_LIMIT, isFresh, _fetchFn);
    const generatedAt = new Date().toISOString();
    if (env.STATS_CACHE && !isFresh) {
      await env.STATS_CACHE
        .put(BREVO_DIARIA_LASTGOOD_KEY, JSON.stringify({ campaigns, generatedAt }), {
          expirationTtl: BREVO_DIARIA_LASTGOOD_TTL,
        })
        .catch(() => { /* erro de KV nunca bloqueia o render */ });
    }
    return { campaigns, generatedAt, postmasterSpam };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[#4515] fetchBrevoDiariaTabData: live fetch falhou, tentando fallback stale:", errMsg);
    const cached = env.STATS_CACHE
      ? await env.STATS_CACHE
          .get<{ campaigns: BrevoDiariaCampaignRow[]; generatedAt: string }>(BREVO_DIARIA_LASTGOOD_KEY, "json")
          .catch(() => null)
      : null;
    if (cached) {
      return { campaigns: cached.campaigns, generatedAt: cached.generatedAt, stale: true, error: errMsg, postmasterSpam };
    }
    return { campaigns: [], generatedAt: new Date().toISOString(), error: errMsg, postmasterSpam };
  }
}

export interface BrevoDiariaBreachFlags {
  openAlert: boolean;
  bounceAlert: boolean;
  spamAlert: boolean;
  unsubAlert: boolean;
}

/**
 * Aplica os circuit breakers da Rampa Clarice (`thresholds.ts`, fonte única)
 * às stats brutas de UMA campanha `brevo_diaria`. Pura — recebe só os counts
 * necessários (não o `BrevoCampaign` inteiro), testável sem fixture grande.
 *
 * `spamAlert` usa `complaints/sent` bruto da Brevo — ver ressalva na
 * docstring do módulo (nenhuma leitura do Postmaster pro domínio
 * `diar.ia.br` ainda; diferente da Envios/Rampa Clarice, que NUNCA colore
 * spam com este número por causa do #4063).
 */
export function evaluateBrevoDiariaBreaches(
  s: Pick<BrevoGlobalStats, "sent" | "delivered" | "uniqueViews" | "hardBounces" | "softBounces" | "complaints" | "unsubscriptions">,
  t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): BrevoDiariaBreachFlags {
  const openRateNum = s.delivered > 0 ? (s.uniqueViews / s.delivered) * 100 : 0;
  const hardBounceRateNum = s.sent > 0 ? (s.hardBounces / s.sent) * 100 : 0;
  const bounceRateNum = s.sent > 0 ? ((s.hardBounces + s.softBounces) / s.sent) * 100 : 0;
  const spamRateNum = s.sent > 0 ? (s.complaints / s.sent) * 100 : 0;
  const unsubRateNum = s.sent > 0 ? (s.unsubscriptions / s.sent) * 100 : 0;
  return {
    // Mesmo guard de sections-core.ts (Envios): exige openRateNum>0 pra não
    // alertar enquanto o dado ainda está propagando (campanha recém-enviada).
    openAlert: openRateNum > 0 && openRateNum < t.openRate.yellow,
    bounceAlert: isBounceBreach(hardBounceRateNum, bounceRateNum, t),
    spamAlert: spamRateNum >= t.spamRate.yellow,
    unsubAlert: unsubRateNum >= t.unsubRate.yellow,
  };
}

function renderBrevoDiariaRow(c: BrevoDiariaCampaignRow, t: HealthThresholds): string {
  const gs = c.statistics?.globalStats;
  const listLabel = escHtml((c.listName ?? "?").replace(/\s*\([^)]*\)\s*/g, "").trim() || "?");
  if (!gs || gs.sent <= 0) {
    return `<tr><td>${brevoReportLink(c.id)}</td><td>${listLabel}</td><td>${fmtTimeBRT(c.sentDate)}</td><td colspan="7" style="color:${DS.ink};opacity:0.6;font-style:italic;">sem stats</td></tr>`;
  }
  const flags = evaluateBrevoDiariaBreaches(gs, t);
  const openRate = pct(gs.uniqueViews, gs.delivered);
  const clickRate = pct(gs.uniqueClicks, gs.delivered);
  const bounceRate = pct(gs.hardBounces + gs.softBounces, gs.sent);
  const spamRate = pct(gs.complaints, gs.sent, 3);
  const unsubRate = pct(gs.unsubscriptions, gs.sent);
  return `<tr>
        <td>${brevoReportLink(c.id)}</td>
        <td>${listLabel}</td>
        <td>${fmtTimeBRT(c.sentDate)}</td>
        <td>${gs.sent}</td>
        <td>${pct(gs.delivered, gs.sent)}<br><small>${gs.delivered}</small></td>
        <td${cellClass("metric", flags.openAlert && "alert")}>${openRate}<br><small>${gs.uniqueViews}</small></td>
        <td${cellClass("metric")}>${clickRate}<br><small>${gs.uniqueClicks}</small></td>
        <td${cellClass(flags.bounceAlert && "alert")}>${bounceRate}<br><small>${gs.hardBounces + gs.softBounces} (${gs.hardBounces} duro)</small></td>
        <td${cellClass(flags.spamAlert && "alert")}>${spamRate}<br><small>${gs.complaints}</small></td>
        <td${cellClass(flags.unsubAlert && "alert")}>${unsubRate}<br><small>${gs.unsubscriptions}</small></td>
      </tr>`;
}

/**
 * #4973: painel da leitura do Postmaster pro domínio deste canal
 * (`diar.ia.br`) — pura/testável, separada de `renderBrevoDiariaTabPanel`
 * (mesmo padrão de `renderBrevoDiariaRow` acima). `entry` ausente/`null`
 * NUNCA vira célula/seção vazia — mostra "aguardando publicação" explícito
 * (mesmo padrão de estado explícito já usado por #4970 na tabela Envios da
 * Clarice), porque cobertura rala é o caso COMUM aqui (3 dias em 21 na
 * sondagem original da #4973), não uma falha a esconder.
 */
export function renderBrevoDiariaPostmasterSpam(entry: PostmasterSpamEntry | null | undefined): string {
  if (!entry) {
    return `<p class="section-note" id="brevodiaria-postmaster-spam">📊 Google Postmaster Tools (<code>${BREVO_DIARIA_POSTMASTER_DOMAIN}</code>): <strong>aguardando publicação</strong> — o Google só publica quando o volume do dia passa o mínimo dele; cobertura rala é o esperado pra este canal, não um erro.</p>`;
  }
  const daysDetail =
    entry.daysWithData != null && entry.daysProbed != null
      ? ` (${entry.daysWithData}/${entry.daysProbed} dias com dado na janela)`
      : "";
  return `<p class="section-note" id="brevodiaria-postmaster-spam">📊 Google Postmaster Tools (<code>${BREVO_DIARIA_POSTMASTER_DOMAIN}</code>): <strong>${entry.spamRatePct.toFixed(3)}%</strong> de spam em ${escHtml(entry.date)}${escHtml(daysDetail)} — só diagnóstico nesta aba (#4973): cobertura ainda insuficiente pra sustentar um circuit breaker automático aqui (ver checklist da issue).</p>`;
}

/**
 * Renderiza o conteúdo da aba `brevo_diaria` (#4515). `null` → string vazia
 * (a aba inteira — radio/label/panel — some no template de
 * `sections-core.ts`, mesmo tratamento que a aba Cupons dá a
 * `couponUsage===null` sem `studioMode`).
 */
export function renderBrevoDiariaTabPanel(
  data: BrevoDiariaTabData | null,
  t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): string {
  if (!data) return "";
  const banner = data.stale
    ? `<div style="background:#FBE9A8;color:#5c4a00;padding:10px 16px;border-radius:6px;margin-bottom:12px;font-size:14px;">⏳ Brevo (conta <code>brevo_diaria</code>) indisponível no momento — mostrando o último dado bom conhecido${data.generatedAt ? ` (${escHtml(fmtTimeBRT(data.generatedAt))})` : ""}.${data.error ? ` Erro: ${escHtml(data.error)}` : ""} <a href="?fresh=1">Tentar novamente</a>.</div>`
    : data.error
      ? `<div style="background:#FBE1DC;color:#7a1f0d;padding:10px 16px;border-radius:6px;margin-bottom:12px;font-size:14px;">🔌 Falha ao buscar campanhas do canal <code>brevo_diaria</code>: ${escHtml(data.error)} <a href="?fresh=1">Tentar novamente</a>.</div>`
      : "";
  const rows = data.campaigns.map((c) => renderBrevoDiariaRow(c, t)).join("\n");
  return `${banner}<section class="phase2-section" id="brevodiaria-campaigns-table">
  <h2 class="section-title">Campanhas — brevo_diaria</h2>
  <p class="section-note">Conta Brevo PRÓPRIA do editor (#4266/#4476), SEPARADA da parceria Clarice mostrada nas demais abas — segmento Pending da Beehiiv reativado por este canal. Circuit breakers: mesmos limiares da aba Agendamento (abertura&lt;${t.openRate.yellow}%, bounce duro≥${t.hardBounceRate.yellow}%, bounce total≥${t.bounceRate.yellow}%, spam≥${t.spamRate.yellow}%, unsub≥${t.unsubRate.yellow}%). <strong>Diferente da tabela Envios da Clarice, aqui o spam É colorido</strong> — a leitura do Google Postmaster Tools pro domínio diar.ia.br (painel abaixo, #4973) ainda não é atribuída POR CAMPANHA (sem FEEDBACK_LOOP_ID pra este domínio), então a coluna Spam desta tabela continua usando o <code>complaints</code> bruto da Brevo, que pode subcontar o spam real (mesma ressalva do #4063 pra Clarice); tratar como sinal, não medida definitiva.</p>
  ${renderBrevoDiariaPostmasterSpam(data.postmasterSpam)}
  <div class="table-wrap">
  <table id="brevodiaria-table">
  <thead><tr>
    <th scope="col">ID</th><th scope="col">Lista</th><th scope="col">Enviado</th><th scope="col">Enviados</th>
    <th scope="col">Entregues</th><th scope="col">Abertura</th><th scope="col">Cliques</th>
    <th scope="col">Bounce (total · duro)</th><th scope="col">Spam</th><th scope="col">Unsub</th>
  </tr></thead>
  <tbody>
${rows || `<tr><td colspan="10" style="text-align:center;color:${DS.ink};opacity:0.6;padding:24px;">Nenhuma campanha encontrada.</td></tr>`}
  </tbody>
  </table>
  </div>
  <p class="section-note">Fila de contatos (<code>data/brevo-diaria/contacts.json</code> — quantos <code>in_brevo</code>/<code>promoted_beehiiv</code>/<code>suppressed</code>/<code>unsubscribed</code>) NÃO aparece aqui: esse arquivo mora em <code>data/</code> (junction OneDrive, só local), inacessível de dentro do Worker, e não existe hoje nenhum sync pra KV que o exponha — introduzir esse mecanismo é infraestrutura nova, fora do escopo desta PR (#4515). Ver o arquivo local ou rodar <code>evaluate-brevo-diaria.ts</code> pra esse número.</p>
</section>`;
}
