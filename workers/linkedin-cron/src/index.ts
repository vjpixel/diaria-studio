/**
 * diaria-linkedin-cron — Cloudflare Worker (#TBD)
 *
 * Fila de posts LinkedIn agendados pra Diar.ia. Substitui o agendamento via
 * Make.com Data Store (que não funcionou — ver
 * `feedback_make_searchrecord_mapping_unsolved.md`).
 *
 * Arquitetura:
 *   1. publish-linkedin.ts POSTa pra /queue com {text, image_url, scheduled_at, destaque}
 *   2. KV armazena com key UUID, valor JSON
 *   3. Cron a cada 30min lê KV, fira webhook Make pra items com scheduled_at <= now
 *   4. Item é deletado após fire bem-sucedido (HTTP 2xx do webhook)
 *
 * Endpoints:
 *   POST /queue        → adiciona item à fila. Auth: header X-Diaria-Token
 *   GET  /health       → debug — quantos items na fila, próximo agendado
 *   GET  /list         → debug — lista completa (auth required)
 *
 * KV schema:
 *   queue:{uuid}       = { text, image_url, scheduled_at, destaque, created_at }
 *
 * Secrets (via `wrangler secret put`):
 *   DIARIA_TOKEN       → header X-Diaria-Token pra autenticar /queue e /list
 *   MAKE_WEBHOOK_URL   → URL do webhook Make (Scenario A "Integration LinkedIn")
 */

export interface Env {
  LINKEDIN_QUEUE: KVNamespace;
  DIARIA_TOKEN: string;
  MAKE_WEBHOOK_URL: string;
}

interface QueueEntry {
  text: string;
  image_url: string | null;
  scheduled_at: string; // ISO 8601
  destaque: string; // d1 | d2 | d3
  created_at: string;
}

// ── Auth helper ────────────────────────────────────────────────────────────

function isAuthorized(request: Request, env: Env): boolean {
  const token = request.headers.get("X-Diaria-Token");
  return !!token && token === env.DIARIA_TOKEN;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── POST /queue — enfileira ─────────────────────────────────────────────────

async function handleEnqueue(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: Partial<QueueEntry>;
  try {
    body = (await request.json()) as Partial<QueueEntry>;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const required = ["text", "scheduled_at", "destaque"] as const;
  for (const field of required) {
    if (!body[field] || typeof body[field] !== "string") {
      return json({ error: `missing or invalid field: ${field}` }, 400);
    }
  }

  // Validar scheduled_at é uma data parseable
  const scheduledMs = Date.parse(body.scheduled_at as string);
  if (isNaN(scheduledMs)) {
    return json({ error: "scheduled_at must be a valid ISO 8601 date" }, 400);
  }

  // Validar destaque
  if (!/^d[123]$/.test(body.destaque as string)) {
    return json({ error: "destaque must be d1, d2, or d3" }, 400);
  }

  const key = `queue:${crypto.randomUUID()}`;
  const entry: QueueEntry = {
    text: body.text as string,
    image_url: (body.image_url as string | null) ?? null,
    scheduled_at: body.scheduled_at as string,
    destaque: body.destaque as string,
    created_at: new Date().toISOString(),
  };
  await env.LINKEDIN_QUEUE.put(key, JSON.stringify(entry));

  return json(
    {
      queued: true,
      key,
      scheduled_at: entry.scheduled_at,
      destaque: entry.destaque,
    },
    202,
  );
}

// ── GET /health — quantos items + próximo a firar ──────────────────────────

async function handleHealth(env: Env): Promise<Response> {
  const list = await env.LINKEDIN_QUEUE.list({ prefix: "queue:" });
  let nextScheduled: { key: string; scheduled_at: string; destaque: string } | null = null;

  for (const k of list.keys) {
    const raw = await env.LINKEDIN_QUEUE.get(k.name);
    if (!raw) continue;
    const entry = JSON.parse(raw) as QueueEntry;
    if (!nextScheduled || entry.scheduled_at < nextScheduled.scheduled_at) {
      nextScheduled = {
        key: k.name,
        scheduled_at: entry.scheduled_at,
        destaque: entry.destaque,
      };
    }
  }

  return json({
    status: "ok",
    queue_size: list.keys.length,
    next_scheduled: nextScheduled,
    server_time: new Date().toISOString(),
  });
}

// ── GET /list — debug ───────────────────────────────────────────────────────

async function handleList(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return json({ error: "unauthorized" }, 401);
  }

  const list = await env.LINKEDIN_QUEUE.list({ prefix: "queue:" });
  const items: Array<QueueEntry & { key: string }> = [];

  for (const k of list.keys) {
    const raw = await env.LINKEDIN_QUEUE.get(k.name);
    if (!raw) continue;
    const entry = JSON.parse(raw) as QueueEntry;
    items.push({ key: k.name, ...entry });
  }

  items.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  return json({ count: items.length, items });
}

// ── Cron handler — fira items maduros ──────────────────────────────────────

async function fireDueItems(env: Env): Promise<{ fired: number; errors: number }> {
  const now = Date.now();
  const list = await env.LINKEDIN_QUEUE.list({ prefix: "queue:" });
  let fired = 0;
  let errors = 0;

  for (const k of list.keys) {
    const raw = await env.LINKEDIN_QUEUE.get(k.name);
    if (!raw) continue;

    let entry: QueueEntry;
    try {
      entry = JSON.parse(raw) as QueueEntry;
    } catch (e) {
      console.error(`[fire] invalid JSON in ${k.name}: ${(e as Error).message}`);
      errors++;
      continue;
    }

    const scheduledMs = Date.parse(entry.scheduled_at);
    if (isNaN(scheduledMs)) {
      console.error(`[fire] invalid scheduled_at in ${k.name}: ${entry.scheduled_at}`);
      errors++;
      continue;
    }

    if (scheduledMs > now) continue; // ainda não chegou a hora

    // Disparar webhook Make
    try {
      const res = await fetch(env.MAKE_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: entry.text,
          image_url: entry.image_url,
          scheduled_at: entry.scheduled_at,
          destaque: entry.destaque,
        }),
      });

      if (res.ok) {
        await env.LINKEDIN_QUEUE.delete(k.name);
        console.log(`[fire] ${k.name} fired (destaque=${entry.destaque}, scheduled=${entry.scheduled_at})`);
        fired++;
      } else {
        const body = await res.text();
        console.error(
          `[fire] ${k.name} make webhook returned HTTP ${res.status}: ${body.slice(0, 200)}`,
        );
        errors++;
        // NÃO deletar — vai retry no próximo cron
      }
    } catch (e) {
      console.error(`[fire] ${k.name} fetch failed: ${(e as Error).message}`);
      errors++;
    }
  }

  return { fired, errors };
}

// ── Main handler ──────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/queue" && request.method === "POST") {
      return handleEnqueue(request, env);
    }
    if (path === "/health" && request.method === "GET") {
      return handleHealth(env);
    }
    if (path === "/list" && request.method === "GET") {
      return handleList(request, env);
    }

    return json(
      {
        error: "not found",
        endpoints: [
          "POST /queue (auth: X-Diaria-Token)",
          "GET /health",
          "GET /list (auth: X-Diaria-Token)",
        ],
      },
      404,
    );
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const result = await fireDueItems(env);
        console.log(`[cron] fired=${result.fired} errors=${result.errors}`);
      })(),
    );
  },
};
