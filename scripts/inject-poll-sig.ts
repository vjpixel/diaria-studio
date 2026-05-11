/**
 * inject-poll-sig.ts (#1083)
 *
 * Pré-render: gera HMAC(POLL_SECRET, email) por subscriber e armazena 1 custom
 * field permanente `poll_sig` via Beehiiv API. Edition + choice vão no HTML
 * literalmente; Worker valida sig contra email.
 *
 * Substitui `inject-poll-urls.ts` (#1044) pro caso permanente — o legacy
 * permanece pra back-compat com edições já enviadas.
 *
 * Idempotente: lê valor atual e skipa se já bate com o calculado. Roda 1x por
 * subscriber (na primeira edição que ele recebe); patcha apenas novos
 * subscribers em runs subsequentes.
 *
 * Uso:
 *   npx tsx scripts/inject-poll-sig.ts
 *   npx tsx scripts/inject-poll-sig.ts --dry-run
 *   npx tsx scripts/inject-poll-sig.ts --force      # repatch all (rotação secret)
 *
 * Env:
 *   BEEHIIV_API_KEY        - acesso à API Beehiiv (required)
 *   BEEHIIV_PUBLICATION_ID - ID da publicação (required)
 *   POLL_SECRET            - HMAC key (required)
 */

import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/cli-args.ts";

const FIELD_SIG = "poll_sig";
const CONCURRENCY = 3;

interface BeehiivCustomField {
  id: string;
  kind: string;
  display: string;
}

interface BeehiivSubscription {
  id: string;
  email: string;
  status: string;
  custom_fields?: Array<{ name: string; value: string }>;
}

interface BeehiivPage<T> {
  data: T[];
  has_more?: boolean;
  next_cursor?: string;
}

/** HMAC permanente do email (lowercase + trim). Edition/choice livre na URL. */
export function generatePollSig(email: string, secret: string): string {
  const message = email.toLowerCase().trim();
  return createHmac("sha256", secret).update(message).digest("hex");
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
  // Retry com backoff exponencial pra 429 (rate limit Beehiiv).
  const MAX_RETRIES = 5;
  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (res.ok) return (await res.json()) as T;

    const body = (await res.text()).slice(0, 500);

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = parseFloat(res.headers.get("retry-after") ?? "");
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.pow(2, attempt) * 1000;
      await new Promise((r) => setTimeout(r, waitMs));
      attempt++;
      continue;
    }
    throw new Error(`Beehiiv API ${res.status}: ${body}`);
  }
}

/** Cria custom field `poll_sig` se não existir. Idempotente. */
async function ensureCustomField(opts: ApiOpts): Promise<void> {
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
  if (existing.has(FIELD_SIG)) return;
  await fetchJson(baseUrl, opts.apiKey, {
    method: "POST",
    body: JSON.stringify({ kind: "string", display: FIELD_SIG }),
  });
  console.error(`[inject-poll-sig] criado custom field "${FIELD_SIG}"`);
}

/** Subscribers active paginados. */
async function* iterateActiveSubscriptions(
  opts: ApiOpts,
): AsyncGenerator<BeehiivSubscription[]> {
  const base = opts.baseUrl ?? "https://api.beehiiv.com/v2";
  let cursor: string | undefined;
  while (true) {
    const params = new URLSearchParams({
      status: "active",
      limit: "100",
      "expand[]": "custom_fields",
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

async function patchSubscriberSig(
  subId: string,
  sig: string,
  opts: ApiOpts,
): Promise<void> {
  const base = opts.baseUrl ?? "https://api.beehiiv.com/v2";
  const url = `${base}/publications/${opts.publicationId}/subscriptions/${subId}`;
  await fetchJson(url, opts.apiKey, {
    method: "PATCH",
    body: JSON.stringify({
      custom_fields: [{ name: FIELD_SIG, value: sig }],
    }),
  });
}

async function processBatch<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
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
  total_subscribers: number;
  patched: number;
  skipped_already_correct: number;
  skipped_no_email: number;
  failed: number;
  dry_run: boolean;
}

export async function run(args: {
  dryRun: boolean;
  force: boolean;
  apiOpts: ApiOpts;
  secret: string;
}): Promise<RunResult> {
  const { dryRun, force, apiOpts, secret } = args;

  if (!dryRun) {
    await ensureCustomField(apiOpts);
  }

  let total = 0;
  let patched = 0;
  let skippedAlready = 0;
  let skippedNoEmail = 0;
  let failedTotal = 0;
  let pageNum = 0;

  for await (const page of iterateActiveSubscriptions(apiOpts)) {
    pageNum++;
    total += page.length;
    const needsPatch: Array<{ id: string; email: string; sig: string }> = [];

    for (const sub of page) {
      if (!sub.email || !sub.email.trim()) {
        skippedNoEmail++;
        continue;
      }
      const expectedSig = generatePollSig(sub.email, secret);
      if (!force) {
        const current = sub.custom_fields?.find((f) => f.name === FIELD_SIG)?.value;
        if (current === expectedSig) {
          skippedAlready++;
          continue;
        }
      }
      needsPatch.push({ id: sub.id, email: sub.email, sig: expectedSig });
    }

    if (dryRun) {
      console.error(
        `[inject-poll-sig] page ${pageNum}: ${needsPatch.length} need patch, ${skippedAlready} already correct (running)`,
      );
      continue;
    }

    const result = await processBatch(needsPatch, CONCURRENCY, (item) =>
      patchSubscriberSig(item.id, item.sig, apiOpts),
    );
    patched += result.ok;
    failedTotal += result.failed.length;
    for (const f of result.failed) {
      console.error(
        `[inject-poll-sig] FAIL ${f.item.email}: ${f.error.slice(0, 200)}`,
      );
    }
    console.error(
      `[inject-poll-sig] page ${pageNum}: patched ${result.ok}/${needsPatch.length}, skipped ${page.length - needsPatch.length - (page.filter(s => !s.email).length)} already-correct, running total patched ${patched}`,
    );
  }

  return {
    total_subscribers: total,
    patched,
    skipped_already_correct: skippedAlready,
    skipped_no_email: skippedNoEmail,
    failed: failedTotal,
    dry_run: dryRun,
  };
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const dryRun = flags.has("dry-run");
  const force = flags.has("force");

  const apiKey = process.env.BEEHIIV_API_KEY;
  const publicationId = process.env.BEEHIIV_PUBLICATION_ID;
  const secret = process.env.POLL_SECRET;
  const missing: string[] = [];
  if (!apiKey) missing.push("BEEHIIV_API_KEY");
  if (!publicationId) missing.push("BEEHIIV_PUBLICATION_ID");
  if (!secret) missing.push("POLL_SECRET");
  if (missing.length > 0) {
    console.error(
      `[inject-poll-sig] envs ausentes: ${missing.join(", ")} — abortando`,
    );
    process.exit(1);
  }

  const result = await run({
    dryRun,
    force,
    apiOpts: { apiKey: apiKey!, publicationId: publicationId! },
    secret: secret!,
  });
  console.log(JSON.stringify(result, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(`[inject-poll-sig] ${(e as Error).message}`);
    process.exit(1);
  });
}
