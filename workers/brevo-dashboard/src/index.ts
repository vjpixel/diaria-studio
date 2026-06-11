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
 * Sem KV — stats são fetch-on-demand a cada page load (sem cache, por
 * preferência do editor 2026-05-12 — refresh manual sempre busca fresh).
 * Volume típico baixo (~5-10 loads/dia), Brevo free tier suporta.
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
import { DS_COLORS, DS_FONTS as _DSF } from "./ds-tokens.generated.ts";

const DS = {
  ...DS_COLORS,
  // Alerta de circuit breaker: sem cor canônica no DS — red semântico de
  // ferramenta interna. Não é uma cor de marca, portanto não entra no DS.
  // Valor mantido como constante local explícita para evitar magic string.
  alert:    "#C00000",  // vermelho de alerta (circuit breaker threshold)
} as const;

const DSF = _DSF;

/** Exportado para o teste de drift (test/brevo-dashboard-ds-drift.test.ts). */
export const DS_TOKENS = DS_COLORS;
export const DS_FONTS = DSF;

export interface Env {
  BREVO_API_KEY: string;
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
  };
}

interface BrevoList {
  id: number;
  name: string;
  totalSubscribers: number;
}


async function brevoFetch<T>(path: string, env: Env): Promise<T> {
  const res = await fetch(`https://api.brevo.com${path}`, {
    headers: { "api-key": env.BREVO_API_KEY, accept: "application/json" },
  });
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
 */
async function fetchRecentCampaigns(
  env: Env,
  limit = 20,
): Promise<Array<BrevoCampaign & { listName?: string; listSize?: number }>> {
  const data = await brevoFetch<{ campaigns: BrevoCampaign[] }>(
    `/v3/emailCampaigns?status=sent&limit=${limit}&sort=desc`,
    env,
  );
  const campaigns = data.campaigns ?? [];

  // Coleta lista IDs únicas pra fetch em batch (max 1 chamada extra por lista)
  const listIds = new Set<number>();
  for (const c of campaigns) {
    for (const id of c.recipients?.lists ?? []) listIds.add(id);
  }

  const listMap = new Map<number, BrevoList>();
  const globalStatsMap = new Map<number, BrevoGlobalStats>();

  await Promise.all([
    // Fetch lista names em paralelo
    ...[...listIds].map(async (id) => {
      try {
        const list = await brevoFetch<BrevoList>(`/v3/contacts/lists/${id}`, env);
        listMap.set(id, list);
      } catch {
        // Lista pode ter sido apagada — skip
      }
    }),
    // Fetch globalStats per campaign em paralelo (inclui Apple MPP)
    ...campaigns.map(async (c) => {
      try {
        const detail = await brevoFetch<BrevoCampaign>(
          `/v3/emailCampaigns/${c.id}?statistics=globalStats`,
          env,
        );
        const gs = detail.statistics?.globalStats;
        if (gs) globalStatsMap.set(c.id, gs);
      } catch {
        // Falha individual não bloqueia o resto — campaignStats fica como fallback
      }
    }),
  ]);

  return campaigns.map((c) => {
    const listId = c.recipients?.lists?.[0];
    const list = listId ? listMap.get(listId) : undefined;
    const globalStats = globalStatsMap.get(c.id);
    // #1141 fix: o listing retorna `globalStats: { sent: 0, ... }` (zeroed,
    // não undefined) — verificado 2026-05-12. Por isso NÃO podemos fazer
    // `...c.statistics` cego: se nosso fetch individual falhar (globalStats
    // local = undefined), o zeroed do listing persistiria e mascara o
    // fallback pra campaignStats no render. Só incluir globalStats final
    // se o fetch individual teve sucesso.
    return {
      ...c,
      listName: list?.name,
      listSize: list?.totalSubscribers,
      statistics: {
        campaignStats: c.statistics?.campaignStats,
        ...(globalStats && { globalStats }),
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

export function renderDashboardHtml(campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>): string {
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
      if (!s) {
        return `<tr><td>${c.id}</td><td>${escHtml(c.listName ?? "?")}</td><td>${fmtTimeBRT(c.sentDate)}</td><td>—</td><td colspan="7" style="color:${DS.ink};opacity:0.6;font-style:italic;">sem stats</td></tr>`;
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
      const trackableRate = pct(s.trackableViews, s.delivered);

      // #1132/dashboard: strip parênteses do nome da lista pra display
      // (Brevo nomes têm "(150 contatos)" hardcoded). O size real vem do
      // `totalSubscribers` da API, mais fiel + atualizado.
      const cleanListName = (c.listName ?? "?").replace(/\s*\([^)]*\)\s*/g, "").trim();
      return `<tr>
        <td>${c.id}</td>
        <td><strong>${escHtml(cleanListName)}</strong></td>
        <td>${fmtTimeBRT(c.sentDate)}<br><small>${hoursSince(c.sentDate)} atrás</small></td>
        <td>${s.sent}</td>
        <td>${pct(s.delivered, s.sent)}<br><small>${s.delivered}</small></td>
        <td${cellClass("metric", openAlert && "alert")}>${opensTopLine}<br><small>${opensBottomLine}</small></td>
        <td${cellClass("metric")}>${ctr}<br><small>${s.uniqueClicks}</small></td>
        <td class="metric trackable">${trackableRate}<br><small>${s.trackableViews}</small></td>
        <td${cellClass(bounceAlert && "alert")}>${bounceRate}<br><small>${s.hardBounces + s.softBounces}</small></td>
        <td${cellClass(unsubAlert && "alert")}>${unsubRate}<br><small>${s.unsubscriptions}</small></td>
        <td${cellClass(spamAlert && "alert")}>${spamRate}<br><small>${s.complaints}</small></td>
      </tr>`;
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
  const abcSection = activeCycle ? renderAbcSection(abcRows, cumSent) : "";
  const trendRows = buildTrendRows(campaigns);
  const trendSection = renderTrendSection(trendRows);

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
  .volume-note { font-family: monospace; font-size: 0.82rem; margin-top: 10px; }
  .spark-bar { display: inline-block; letter-spacing: -1px; color: var(--brand); }
  td.spark { font-family: monospace; letter-spacing: -1px; color: var(--brand); font-size: 0.8rem; white-space: nowrap; }
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
${abcSection}
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
<th title="Cliques únicos. Bench: 1.5-3% B2C.">Clicks 🖱️</th>
<th title="trackableViews ÷ delivered: aperturas com pixel rastreável (exclui MPP/bots que não disparam pixel). Sinal mais limpo de engajamento real.">Trackable 📍</th>
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
<p class="footer">Atualize a página (F5 / Ctrl+R / ⌘+R) pra buscar dados novos da Brevo.<br>
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
 * Extrai célula A/B/C do nome da campanha Clarice News.
 * Padrão: "Clarice News {cycle} d{NN}-{cell} ({weekday})"
 * ex: "Clarice News 2605 d01-A (qua)" → cell = "A"
 * Retorna null para campanhas que não seguem o padrão (ex: T1-W1..W7).
 * Delegado a parseClariceCampaignKey para evitar regex duplicada.
 */
export function extractClariceCell(campaignName: string): "A" | "B" | "C" | null {
  return parseClariceCampaignKey(campaignName)?.cell ?? null;
}

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
  const m = campaignName.match(/Clarice News (\d{4}) d(\d{2})-([ABC])\s/i);
  if (!m) return null;
  return { cycle: m[1], dayNum: parseInt(m[2], 10), cell: m[3] as "A" | "B" | "C" };
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
    if (!gs || gs.sent === 0) continue;

    cells[parsed.cell].views += gs.uniqueViews;
    cells[parsed.cell].delivered += gs.delivered;
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

  // Ordenar por sentDate ASC (mais antigas primeiro)
  const sorted = [...campaigns].sort((a, b) => {
    const da = a.sentDate ? Date.parse(a.sentDate) : 0;
    const db = b.sentDate ? Date.parse(b.sentDate) : 0;
    return da - db;
  });

  for (const c of sorted) {
    if (!c.sentDate) continue;
    const gs = c.statistics?.globalStats;
    const cs = c.statistics?.campaignStats?.[0];
    const gsIsReal = gs && gs.sent > 0;
    const s = gsIsReal ? gs : cs;
    if (!s || s.sent === 0) continue;

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
export function renderAbcSection(abcRows: CellSummary[], cumulativeSent: number): string {
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

  const pctBar = Math.min(100, (cumulativeSent / CLARICE_PLAN_TOTAL) * 100);
  const pctLabel = pctBar.toFixed(1);
  const barFill = Math.round(pctBar * 0.3); // 30 chars = 100%
  const bar = "█".repeat(barFill) + "░".repeat(30 - barFill);

  const cellRows = abcRows
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

  const statusNote = isTied
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
  <p class="section-note volume-note">
    Volume enviado no ciclo: <strong>${cumulativeSent.toLocaleString("pt-BR")}</strong> de ${CLARICE_PLAN_TOTAL.toLocaleString("pt-BR")} (${pctLabel}%)<br>
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
  <p class="section-note">Open rate e bounce rate em ordem cronológica — do mais antigo ao mais recente.</p>
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/healthz") {
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    }

    // Sem cache (preferência do editor 2026-05-12): cada load fetch fresh
    // da Brevo. Volume baixo (~5-10 loads/dia), Brevo free tier suporta.
    // Refresh manual é necessário pra ver updates pós-carga.
    const noCacheHeaders = "no-store, no-cache, must-revalidate, max-age=0";

    if (path === "/api/campaigns") {
      try {
        const limit = Math.min(50, Number(url.searchParams.get("limit") ?? "20") || 20);
        const campaigns = await fetchRecentCampaigns(env, limit);
        return new Response(JSON.stringify(campaigns, null, 2), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": noCacheHeaders,
          },
        });
      } catch (e) {
        return new Response(`Brevo fetch error: ${(e as Error).message}`, { status: 502 });
      }
    }

    if (path === "/" || path === "/index.html") {
      try {
        const campaigns = await fetchRecentCampaigns(env, 20);
        const html = renderDashboardHtml(campaigns);
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": noCacheHeaders,
          },
        });
      } catch (e) {
        return new Response(
          `<!DOCTYPE html><html><body><h1>Dashboard error</h1><p>${escHtml((e as Error).message)}</p></body></html>`,
          { status: 502, headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
