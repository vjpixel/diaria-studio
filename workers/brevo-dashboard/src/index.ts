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

/** Lista as últimas N campaigns enviadas + enriquece com nome da lista. */
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
  await Promise.all(
    [...listIds].map(async (id) => {
      try {
        const list = await brevoFetch<BrevoList>(`/v3/contacts/lists/${id}`, env);
        listMap.set(id, list);
      } catch {
        // Lista pode ter sido apagada — skip
      }
    }),
  );

  return campaigns.map((c) => {
    const listId = c.recipients?.lists?.[0];
    const list = listId ? listMap.get(listId) : undefined;
    return {
      ...c,
      listName: list?.name,
      listSize: list?.totalSubscribers,
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

function renderDashboardHtml(campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>): string {
  const rows = campaigns
    .map((c) => {
      const s = c.statistics?.campaignStats?.[0];
      if (!s) {
        return `<tr><td>${c.id}</td><td>${escHtml(c.listName ?? "?")}</td><td>${fmtTimeBRT(c.sentDate)}</td><td>—</td><td colspan="6" style="color:#999;font-style:italic;">sem stats</td></tr>`;
      }
      const openRate = pct(s.uniqueViews, s.delivered);
      const ctr = pct(s.uniqueClicks, s.delivered);
      const bounceRate = pct(s.hardBounces + s.softBounces, s.sent);
      // #1132/dashboard: strip parênteses do nome da lista pra display
      // (Brevo nomes têm "(150 contatos)" hardcoded). O size real vem do
      // `totalSubscribers` da API, mais fiel + atualizado.
      const cleanListName = (c.listName ?? "?").replace(/\s*\([^)]*\)\s*/g, "").trim();
      return `<tr>
        <td>${c.id}</td>
        <td><strong>${escHtml(cleanListName)}</strong>${c.listSize ? `<br><small>${c.listSize} subs</small>` : ""}</td>
        <td>${fmtTimeBRT(c.sentDate)}<br><small>${hoursSince(c.sentDate)} atrás</small></td>
        <td>${s.sent}</td>
        <td>${s.delivered}<br><small>${pct(s.delivered, s.sent)}</small></td>
        <td class="metric">${s.uniqueViews}<br><small>${openRate}</small></td>
        <td class="metric">${s.uniqueClicks}<br><small>${ctr}</small></td>
        <td>${s.hardBounces + s.softBounces}<br><small>${bounceRate}</small></td>
        <td>${s.unsubscriptions}</td>
        <td>${s.complaints}</td>
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
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { padding: 8px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
  th { background: #FAFAFA; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); position: sticky; top: 0; cursor: help; border-bottom: 1px dotted var(--muted); }
  td.metric { font-weight: 600; color: var(--teal); }
  td small { color: var(--muted); font-weight: normal; }
  .actions { margin-bottom: 16px; }
  button { background: var(--teal); color: white; border: 0; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.85rem; }
  button:hover { opacity: 0.85; }
  .footer { color: var(--muted); font-size: 0.75rem; margin-top: 24px; text-align: center; }
  @media (max-width: 700px) {
    body { margin: 16px auto; padding: 0 12px; }
    table { font-size: 0.8rem; }
    th, td { padding: 6px 4px; }
  }
</style>
</head>
<body>
<h1>📧 Diar.ia Clarice Dashboard</h1>
<p class="sub">Últimas ${campaigns.length} campaigns enviadas. Atualizado: ${now} BRT.</p>
<div class="actions">
  <button onclick="window.location.reload()">↻ Refresh</button>
</div>
<table>
<thead>
<tr>
<th title="ID interno da campaign no Brevo. Use pra referenciar suporte ou linkar dashboard interno.">ID</th>
<th title="Lista de destinatários. Nome conforme cadastro no Brevo + número de subscribers ativos (não-blacklisted).">Lista</th>
<th title="Data e hora do envio em horário de Brasília (BRT). Linha de baixo mostra quanto tempo decorrido.">Enviado</th>
<th title="Total de emails que o Brevo tentou entregar (incluindo bounces). Igual ao tamanho da lista alvo.">Sent</th>
<th title="Emails efetivamente entregues nas caixas dos destinatários (Sent - bounces - deferred). Taxa abaixo: delivered/sent.">Delivered</th>
<th title="Unique opens — destinatários que abriram pelo menos 1×. Taxa abaixo: uniqueOpens/delivered. Bench: 15-25% típico B2C, 30-45% em listas engajadas.">Opens 👁️</th>
<th title="Unique clicks — destinatários que clicaram em qualquer link pelo menos 1×. Taxa abaixo: uniqueClicks/delivered. Bench: 1.5-3% típico B2C.">Clicks 🖱️</th>
<th title="Hard bounces (endereço inexistente) + soft bounces (caixa cheia/temporário). Taxa abaixo: bounces/sent. Bench: <2% saudável.">Bounces</th>
<th title="Unsubscribes — destinatários que clicaram 'Cancelar inscrição'. Caminho amigável (esperado, baixo impacto). Bench: <0.5% por envio.">Unsub</th>
<th title="Complaints (spam) — destinatários que marcaram o email como spam. Pior que unsub: prejudica reputação do domínio. Bench: 0% ideal, <0.1% aceitável.">Compl.</th>
</tr>
</thead>
<tbody>
${rows || '<tr><td colspan="10" style="text-align:center;color:#999;padding:24px;">Nenhuma campaign encontrada.</td></tr>'}
</tbody>
</table>
<p class="footer">Open rate / CTR calculados sobre <em>delivered</em>. Bounce rate sobre <em>sent</em>.</p>
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
