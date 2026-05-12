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
 */

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
  return d.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
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
        return `<tr><td>${c.id}</td><td>${escHtml(c.listName ?? "?")}</td><td>${fmtTimeBRT(c.sentDate)}</td><td>—</td><td colspan="6" style="color:#999;font-style:italic;">sem stats</td></tr>`;
      }
      const openRate = pct(s.uniqueViews, s.delivered);
      const ctr = pct(s.uniqueClicks, s.delivered);
      const bounceRate = pct(s.hardBounces + s.softBounces, s.sent);
      // Per circuit breakers doc 2026-05-12: unsub e spam sobre `sent`
      // (não `delivered`). Pequena diferença na prática (sent ≈ delivered +
      // bounces), mas mantém consistência com a doc operacional.
      const unsubRate = pct(s.unsubscriptions, s.sent);
      const spamRate = pct(s.complaints, s.sent);
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
        <td class="metric">${opensTopLine}<br><small>${opensBottomLine}</small></td>
        <td class="metric">${ctr}<br><small>${s.uniqueClicks}</small></td>
        <td>${bounceRate}<br><small>${s.hardBounces + s.softBounces}</small></td>
        <td>${unsubRate}<br><small>${s.unsubscriptions}</small></td>
        <td>${spamRate}<br><small>${s.complaints}</small></td>
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

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diar.ia Clarice Dashboard</title>
<style>
  :root { --teal: #00A0A0; --text: #1A1A1A; --muted: #666; --rule: #E5E5E5; }
  body { font-family: -apple-system, BlinkMacSystemFont, Inter, sans-serif; max-width: 1200px; margin: 30px auto; padding: 0 20px; color: var(--text); }
  h1 { font-size: 1.6rem; margin: 0 0 4px 0; }
  .sub { color: var(--muted); font-size: 0.9rem; margin: 0 0 24px 0; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { padding: 8px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
  th { background: #FAFAFA; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); position: sticky; top: 0; cursor: help; border-bottom: 1px dotted var(--muted); }
  td.metric { font-weight: 600; color: var(--teal); }
  td .rate-inline { font-weight: normal; color: var(--text); }
  td small { color: var(--muted); font-weight: normal; }
  .footer { color: var(--muted); font-size: 0.75rem; margin-top: 24px; text-align: center; }
  .footer code { background: #F5F5F5; padding: 1px 5px; border-radius: 3px; font-size: 0.95em; }
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
<th title="Hard bounces (inválido) + soft bounces (caixa cheia). Bench: <2% saudável. ≥3% pausa o ramp.">Bounces</th>
<th title="Descadastros. Esperado em baixo volume. Bench: <0.5%. ≥3% pausa o ramp.">Unsub</th>
<th title="Marcações de spam. Prejudica reputação do domínio. Bench: <0.1%. ≥0.1% pausa o ramp.">Spam</th>
</tr>
</thead>
<tbody>
${rows || '<tr><td colspan="10" style="text-align:center;color:#999;padding:24px;">Nenhuma campaign encontrada.</td></tr>'}
</tbody>
</table>
</div>
<p class="footer">Atualize a página (F5 / Ctrl+R / ⌘+R) pra buscar dados novos da Brevo.<br>
Open rate e CTR calculados sobre <em>delivered</em>; bounce, unsub e spam sobre <em>sent</em>. Em cada coluna de métrica, a linha de cima é a taxa e a linha de baixo é o count absoluto. Passe o mouse nos headers pra ver detalhes de cada coluna.<br>
Em Opens, a taxa à esquerda é o total (com Apple MPP e bots, como na Brevo Web UI); entre parênteses, a taxa sem Apple MPP (ainda pode incluir outros bots). Pra valor mais limpo, consultar <em>trackableViews</em> em <code>/api/campaigns</code>.</p>
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
