/**
 * inject-poll-urls.ts (#1044)
 *
 * Pré-render: gera 2 URLs HMAC-assinadas (choice A, choice B) por subscriber
 * pra edição corrente, e injeta como custom fields via Beehiiv API. O template
 * Beehiiv usa `{{custom_fields.poll_a_url}}` / `{{custom_fields.poll_b_url}}`
 * no Custom HTML pra renderizar botões A/B clicáveis no email.
 *
 * Worker em workers/poll/ valida HMAC contra POLL_SECRET e registra voto em KV.
 *
 * Idempotente: re-rodar sobrescreve sem duplicar. Custom fields são reusados
 * entre edições — nome fixo (`poll_a_url`/`poll_b_url`), valor varia.
 *
 * Uso:
 *   npx tsx scripts/inject-poll-urls.ts --edition 260510
 *   npx tsx scripts/inject-poll-urls.ts --edition 260510 --dry-run
 *
 * Env:
 *   BEEHIIV_API_KEY        - acesso à API Beehiiv (required)
 *   BEEHIIV_PUBLICATION_ID - ID da publicação (required)
 *   POLL_SECRET            - HMAC key (required)
 *   POLL_WORKER_URL        - default https://diar-ia-poll.diaria.workers.dev
 */

import { createHmac } from "node:crypto";
import { parseArgs } from "./lib/cli-args.ts";

const POLL_WORKER_URL =
  process.env.POLL_WORKER_URL ?? "https://diar-ia-poll.diaria.workers.dev";

const FIELD_A = "poll_a_url";
const FIELD_B = "poll_b_url";
const CONCURRENCY = 8;

interface BeehiivCustomField {
  id: string;
  kind: string;
  display: string;
}

interface BeehiivSubscription {
  id: string;
  email: string;
  status: string;
}

interface BeehiivPage<T> {
  data: T[];
  has_more?: boolean;
  next_cursor?: string;
}

// HMAC cobre só (email, edition) — choice é param independente. URLs A e B
// têm sig idêntico; permite leitor mudar de ideia A↔B no client sem regenerar.
export function generatePollUrl(
  email: string,
  edition: string,
  choice: "A" | "B",
  secret: string,
): string {
  const message = `${email.toLowerCase().trim()}:${edition}`;
  const sig = createHmac("sha256", secret).update(message).digest("hex");
  return `${POLL_WORKER_URL}/vote?email=${encodeURIComponent(email)}&edition=${edition}&choice=${choice}&sig=${sig}`;
}

interface ApiOpts {
  publicationId: string;
  apiKey: string;
  baseUrl?: string;
}

async function fetchJson<T>(
  url: string,
  apiKey: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 500); // truncate — 5xx pode vir HTML grande
    throw new Error(`Beehiiv API ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

/**
 * Garante que os 2 custom fields (`poll_a_url`, `poll_b_url`) existem na
 * publicação. Idempotente — se já existem, no-op.
 *
 * Pagina via cursor pra cobrir publications com >100 fields (Diar.ia tinha 21
 * em 2026-05-09, perto do default limit de 10 que dispararia false-create).
 */
export async function ensureCustomFields(opts: ApiOpts): Promise<void> {
  const base = opts.baseUrl ?? "https://api.beehiiv.com/v2";
  const baseUrl = `${base}/publications/${opts.publicationId}/custom_fields`;
  const existing = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const page = await fetchJson<BeehiivPage<BeehiivCustomField>>(
      `${baseUrl}?${params.toString()}`,
      opts.apiKey,
    );
    for (const f of page.data ?? []) existing.add(f.display);
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
  for (const name of [FIELD_A, FIELD_B]) {
    if (existing.has(name)) continue;
    await fetchJson(baseUrl, opts.apiKey, {
      method: "POST",
      body: JSON.stringify({ kind: "string", display: name }),
    });
    console.error(`[inject-poll-urls] criado custom field "${name}"`);
  }
}

/**
 * Pagina por subscribers active, yielding página por página pra permitir
 * processamento incremental (não carrega ~milhares na memória).
 */
async function* iterateActiveSubscriptions(
  opts: ApiOpts,
): AsyncGenerator<BeehiivSubscription[]> {
  const base = opts.baseUrl ?? "https://api.beehiiv.com/v2";
  let cursor: string | undefined;
  while (true) {
    const params = new URLSearchParams({
      status: "active",
      limit: "100",
    });
    if (cursor) params.set("cursor", cursor);
    const url = `${base}/publications/${opts.publicationId}/subscriptions?${params.toString()}`;
    const page = await fetchJson<BeehiivPage<BeehiivSubscription>>(
      url,
      opts.apiKey,
    );
    yield page.data ?? [];
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
}

/**
 * Atualiza os 2 custom fields de 1 subscriber. Falha individual lançada pra
 * caller decidir (script principal loga e continua).
 */
export async function patchSubscriberPollUrls(
  subId: string,
  email: string,
  edition: string,
  secret: string,
  opts: ApiOpts,
): Promise<void> {
  const base = opts.baseUrl ?? "https://api.beehiiv.com/v2";
  const url = `${base}/publications/${opts.publicationId}/subscriptions/${subId}`;
  const body = {
    custom_fields: [
      { name: FIELD_A, value: generatePollUrl(email, edition, "A", secret) },
      { name: FIELD_B, value: generatePollUrl(email, edition, "B", secret) },
    ],
  };
  await fetchJson(url, opts.apiKey, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/**
 * Processa array em batches paralelos com concurrency limitada. Coleta erros
 * mas não interrompe — return de [resultados, erros].
 */
async function processBatch<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<{ ok: number; failed: Array<{ item: T; error: string }> }> {
  let ok = 0;
  const failed: Array<{ item: T; error: string }> = [];
  let idx = 0;
  async function next(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      try {
        await worker(items[i]);
        ok++;
      } catch (e) {
        failed.push({ item: items[i], error: (e as Error).message });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => next()));
  return { ok, failed };
}

interface RunResult {
  edition: string;
  total_subscribers: number;
  patched: number;
  failed: number;
  skipped_no_email: number;
  dry_run: boolean;
}

export async function run(args: {
  edition: string;
  dryRun: boolean;
  apiOpts: ApiOpts;
  secret: string;
}): Promise<RunResult> {
  const { edition, dryRun, apiOpts, secret } = args;

  if (!dryRun) {
    await ensureCustomFields(apiOpts);
  }

  let total = 0;
  let patched = 0;
  let failedTotal = 0;
  let skippedNoEmail = 0;
  let pageNum = 0;

  for await (const page of iterateActiveSubscriptions(apiOpts)) {
    pageNum++;
    const validSubs = page.filter((s) => {
      if (!s.email || !s.email.trim()) {
        skippedNoEmail++;
        return false;
      }
      return true;
    });
    total += page.length;

    if (dryRun) {
      // Em dry-run, ainda mostra preview de 1 URL por página
      if (validSubs[0]) {
        const sampleUrl = generatePollUrl(
          validSubs[0].email,
          edition,
          "A",
          secret,
        );
        console.error(
          `[inject-poll-urls] page ${pageNum} (${validSubs.length} valid): preview ${sampleUrl}`,
        );
      }
      continue;
    }

    const result = await processBatch(validSubs, CONCURRENCY, (sub) =>
      patchSubscriberPollUrls(sub.id, sub.email, edition, secret, apiOpts),
    );
    patched += result.ok;
    failedTotal += result.failed.length;
    for (const f of result.failed) {
      console.error(
        `[inject-poll-urls] FAIL ${f.item.email}: ${f.error.slice(0, 200)}`,
      );
    }
    console.error(
      `[inject-poll-urls] page ${pageNum}: ${result.ok}/${validSubs.length} ok, running total ${patched}`,
    );
  }

  return {
    edition,
    total_subscribers: total,
    patched,
    failed: failedTotal,
    skipped_no_email: skippedNoEmail,
    dry_run: dryRun,
  };
}

async function main(): Promise<void> {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const edition = values["edition"];
  const dryRun = flags.has("dry-run");

  if (!edition) {
    console.error(
      "Uso: inject-poll-urls.ts --edition AAMMDD [--dry-run]",
    );
    process.exit(1);
  }
  if (!/^\d{6}$/.test(edition)) {
    console.error(
      `[inject-poll-urls] --edition deve ser AAMMDD (6 dígitos), recebido: "${edition}"`,
    );
    process.exit(1);
  }

  const apiKey = process.env.BEEHIIV_API_KEY;
  const publicationId = process.env.BEEHIIV_PUBLICATION_ID;
  const secret = process.env.POLL_SECRET;

  const missing: string[] = [];
  if (!apiKey) missing.push("BEEHIIV_API_KEY");
  if (!publicationId) missing.push("BEEHIIV_PUBLICATION_ID");
  if (!secret) missing.push("POLL_SECRET");
  if (missing.length > 0) {
    console.error(
      `[inject-poll-urls] envs ausentes: ${missing.join(", ")} — abortando`,
    );
    process.exit(1);
  }

  const result = await run({
    edition,
    dryRun,
    apiOpts: { publicationId: publicationId!, apiKey: apiKey! },
    secret: secret!,
  });

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(`[inject-poll-urls] ${(e as Error).message}`);
    process.exit(2);
  });
}
