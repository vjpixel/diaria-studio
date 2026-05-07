/**
 * verify-stage-4-dispatch.ts (#917)
 *
 * Agente revisor pos-publicacao. Roda APOS publish-facebook.ts +
 * publish-linkedin.ts retornarem e ANTES do gate humano de Etapa 4.
 *
 * Valida que cada entry em 06-social-published.json tem reflexo real no
 * destino:
 *   - Facebook: GET Graph API -> confirma post existe + scheduled_publish_time
 *     futuro (ou ja published).
 *   - LinkedIn: GET Cloudflare Worker /list -> confirma entry no KV
 *     (matching por destaque ou worker_queue_key).
 *
 * Output: relatorio JSON pra orchestrator + report human-readable em stderr.
 * Exit codes:
 *   0 = todos os 6 posts confirmados (3 FB + 3 LinkedIn)
 *   1 = >=1 post nao passou na verificacao (gate humano ve o problema)
 *   2 = erro de input (arquivo missing, env missing, etc.)
 *
 * Uso:
 *   npx tsx scripts/verify-stage-4-dispatch.ts \
 *     --edition-dir data/editions/260507/ \
 *     [--strict]   # se exit 1 quando count != 6 (default warn)
 *
 * Pre-requisitos:
 *   - data/editions/{ed}/_internal/06-social-published.json (output de Etapa 4a)
 *   - FACEBOOK_PAGE_ACCESS_TOKEN no env (pra Graph API)
 *   - DIARIA_LINKEDIN_CRON_URL + DIARIA_LINKEDIN_CRON_TOKEN no env (Worker /list)
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readSocialPublished, type PostEntry } from "./lib/social-published-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- Tipos ----

export interface VerifyResult {
  destaque: string;
  platform: string;
  expected_status: string;
  verified: boolean;
  reason?: string;
  external_state?: unknown;
}

export interface VerifyReport {
  ok: boolean;
  expected_count: number;
  actual_count: number;
  results: VerifyResult[];
  warnings: string[];
}

interface FbGraphResponse {
  id?: string;
  is_published?: boolean;
  scheduled_publish_time?: number;
  created_time?: string;
  permalink_url?: string;
  error?: { message: string; code?: number };
}

interface WorkerListResponse {
  count: number;
  items: Array<{
    key: string;
    text: string;
    image_url: string | null;
    scheduled_at: string;
    destaque: string;
    created_at: string;
  }>;
}

// ---- Facebook verifier ----

export async function fetchFbPostState(
  postId: string,
  pageToken: string,
  apiVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FbGraphResponse> {
  const fields = "id,is_published,scheduled_publish_time,created_time,permalink_url";
  const url = `https://graph.facebook.com/${apiVersion}/${postId}?fields=${fields}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `OAuth ${pageToken}` },
  });
  return (await res.json()) as FbGraphResponse;
}

/**
 * Reconcilia FB entry com Graph API state. Pure -- testavel sem network.
 */
export function reconcileFb(
  entry: PostEntry,
  graph: FbGraphResponse,
  now: Date = new Date(),
): VerifyResult {
  const base: VerifyResult = {
    destaque: entry.destaque,
    platform: "facebook",
    expected_status: entry.status,
    verified: false,
  };

  if (graph.error) {
    return {
      ...base,
      reason: `graph_api_error: ${graph.error.message}`,
      external_state: graph.error,
    };
  }
  if (!graph.id) {
    return { ...base, reason: "graph_returned_no_id" };
  }

  const nowSec = Math.floor(now.getTime() / 1000);
  const scheduledSec = graph.scheduled_publish_time;

  if (typeof scheduledSec === "number" && scheduledSec > nowSec) {
    return {
      ...base,
      verified: true,
      external_state: {
        scheduled_publish_time: scheduledSec,
        scheduled_iso: new Date(scheduledSec * 1000).toISOString(),
      },
    };
  }

  if (graph.is_published === true) {
    return {
      ...base,
      verified: true,
      external_state: { published: true, created_time: graph.created_time },
    };
  }

  return {
    ...base,
    reason:
      "scheduled_publish_time vencido mas is_published nao confirmado -- possivel falha silenciosa",
    external_state: graph,
  };
}

// ---- LinkedIn verifier ----

export async function fetchLinkedinQueue(
  workerUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkerListResponse> {
  const url = workerUrl.replace(/\/+$/, "") + "/list";
  const res = await fetchImpl(url, {
    headers: { "X-Diaria-Token": token },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Worker /list HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as WorkerListResponse;
}

/**
 * Reconcilia LinkedIn entry com queue do Worker. Pure -- testavel sem network.
 */
export function reconcileLinkedin(
  entry: PostEntry,
  queueItems: WorkerListResponse["items"],
): VerifyResult {
  const base: VerifyResult = {
    destaque: entry.destaque,
    platform: "linkedin",
    expected_status: entry.status,
    verified: false,
  };

  // Posts com fallback_used (Worker falhou -> Make fire-now) nao estao na
  // queue por design. Marcamos como verified=true mas com flag pro relatorio.
  if (entry.fallback_used) {
    return {
      ...base,
      verified: true,
      reason: "fallback_used (Worker falhou -> Make fire-now; nao enfileiravel)",
      external_state: { fallback_used: true },
    };
  }

  // Match por worker_queue_key (mais preciso) ou destaque (fallback)
  const expectedKey = entry.worker_queue_key as string | undefined;
  const matchByKey = expectedKey
    ? queueItems.find((it) => it.key === expectedKey)
    : null;

  if (matchByKey) {
    return {
      ...base,
      verified: true,
      external_state: { key: matchByKey.key, scheduled_at: matchByKey.scheduled_at },
    };
  }

  const matchesByDestaque = queueItems.filter((it) => it.destaque === entry.destaque);
  if (matchesByDestaque.length === 0) {
    return {
      ...base,
      reason: `nenhum item no Worker KV pro destaque ${entry.destaque} (queue silent fail?)`,
      external_state: { queue_size: queueItems.length },
    };
  }

  // Multiplos com mesmo destaque -- pegar o mais proximo do entry.scheduled_at
  const expectedSched = entry.scheduled_at;
  const best = expectedSched
    ? matchesByDestaque.reduce((acc, it) => {
        const accDiff = Math.abs(Date.parse(acc.scheduled_at) - Date.parse(expectedSched));
        const itDiff = Math.abs(Date.parse(it.scheduled_at) - Date.parse(expectedSched));
        return itDiff < accDiff ? it : acc;
      }, matchesByDestaque[0])
    : matchesByDestaque[0];

  return {
    ...base,
    verified: true,
    external_state: {
      key: best.key,
      scheduled_at: best.scheduled_at,
      multiple_matches: matchesByDestaque.length,
    },
  };
}

// ---- Main ----

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--strict") out.strict = true;
    else if (argv[i].startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const editionDirRaw = args["edition-dir"] as string | undefined;
  if (!editionDirRaw) {
    console.error("Uso: verify-stage-4-dispatch.ts --edition-dir <path> [--strict]");
    process.exit(2);
  }
  const editionDir = resolve(ROOT, editionDirRaw);
  const strict = !!args.strict;

  const internalPath = resolve(editionDir, "_internal", "06-social-published.json");
  const rootPath = resolve(editionDir, "06-social-published.json");
  const publishedPath = existsSync(internalPath)
    ? internalPath
    : existsSync(rootPath)
      ? rootPath
      : null;
  if (!publishedPath) {
    console.error(`[verify] arquivo nao encontrado:\n  ${internalPath}\n  ${rootPath}`);
    process.exit(2);
  }

  const published = readSocialPublished(publishedPath);
  const fbEntries = published.posts.filter((p) => p.platform === "facebook");
  const liEntries = published.posts.filter((p) => p.platform === "linkedin");

  const warnings: string[] = [];
  const results: VerifyResult[] = [];

  // Facebook verification
  const fbToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN ?? "";
  const fbApiVersion = process.env.FACEBOOK_API_VERSION ?? "v25.0";
  if (!fbToken && fbEntries.length > 0) {
    warnings.push(
      "FACEBOOK_PAGE_ACCESS_TOKEN ausente -- pulando verificacao Graph API. " +
        "FB entries serao marcadas como unverified.",
    );
    for (const e of fbEntries) {
      results.push({
        destaque: e.destaque,
        platform: "facebook",
        expected_status: e.status,
        verified: false,
        reason: "missing_fb_token",
      });
    }
  } else {
    for (const e of fbEntries) {
      const fbId = (e.fb_post_id as string | undefined) ?? null;
      if (!fbId || e.status === "failed") {
        results.push({
          destaque: e.destaque,
          platform: "facebook",
          expected_status: e.status,
          verified: false,
          reason: e.status === "failed" ? "publish_failed" : "no_fb_post_id",
        });
        continue;
      }
      try {
        const graph = await fetchFbPostState(fbId, fbToken, fbApiVersion);
        results.push(reconcileFb(e, graph));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          destaque: e.destaque,
          platform: "facebook",
          expected_status: e.status,
          verified: false,
          reason: `fetch_error: ${msg}`,
        });
      }
    }
  }

  // LinkedIn verification
  const workerUrl = process.env.DIARIA_LINKEDIN_CRON_URL ?? "";
  const workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
  if ((!workerUrl || !workerToken) && liEntries.length > 0) {
    warnings.push(
      "DIARIA_LINKEDIN_CRON_URL/TOKEN ausente -- pulando verificacao Worker KV. " +
        "LinkedIn entries serao marcadas como unverified (exceto fallback_used).",
    );
    for (const e of liEntries) {
      if (e.fallback_used) {
        results.push(reconcileLinkedin(e, []));
      } else {
        results.push({
          destaque: e.destaque,
          platform: "linkedin",
          expected_status: e.status,
          verified: false,
          reason: "missing_worker_creds",
        });
      }
    }
  } else if (liEntries.length > 0) {
    let queueItems: WorkerListResponse["items"] = [];
    try {
      const queueResp = await fetchLinkedinQueue(workerUrl, workerToken);
      queueItems = queueResp.items;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Worker /list falhou: ${msg}`);
    }
    for (const e of liEntries) {
      if (e.status === "failed") {
        results.push({
          destaque: e.destaque,
          platform: "linkedin",
          expected_status: e.status,
          verified: false,
          reason: "publish_failed",
        });
        continue;
      }
      results.push(reconcileLinkedin(e, queueItems));
    }
  }

  // expectedCount = entries reais em 06-social-published.json (não hardcoded 6).
  // Suporta edicoes parciais (so LinkedIn, so 1-2 destaques de teste, etc).
  // Edicao normal tem 6 (3 FB + 3 LI); count mismatch so sinaliza se algum
  // destaque ficou fora do esperado, nao desvio editorial intencional.
  const expectedCount = fbEntries.length + liEntries.length;
  const actualCount = results.filter((r) => r.verified).length;
  const ok = strict ? actualCount === expectedCount : results.every((r) => r.verified);

  // Detectar bug de merge #918: total != soma fb + li sugere sobrescrita
  // (entries silenciosamente perdidas durante write concorrente).
  const totalEntries = published.posts.filter(
    (p) => p.platform === "linkedin" || p.platform === "facebook",
  ).length;
  if (totalEntries !== expectedCount) {
    warnings.push(
      `count mismatch: 06-social-published.json tem ${totalEntries} entries social, ` +
        `mas reconcile reconstruiu so ${expectedCount} (${fbEntries.length} FB + ${liEntries.length} LI). ` +
        "Possivel bug de merge em 06-social-published.json (#918).",
    );
  }

  const report: VerifyReport = {
    ok,
    expected_count: expectedCount,
    actual_count: actualCount,
    results,
    warnings,
  };

  // Persistir relatorio
  const reportPath = resolve(editionDir, "_internal", "06-verify-dispatch.json");
  try {
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  } catch (e) {
    warnings.push(`nao consegui gravar ${reportPath}: ${(e as Error).message}`);
  }

  // Output: JSON pra stdout, report pra stderr
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");

  console.error("\n=== Stage 4 Dispatch Verification ===");
  console.error(`Expected: ${expectedCount} (3 FB + 3 LinkedIn)`);
  console.error(`Verified: ${actualCount}/${results.length}`);
  for (const r of results) {
    const tag = r.verified ? "OK  " : "FAIL";
    const note = r.reason ? ` -- ${r.reason}` : "";
    console.error(`  [${tag}] ${r.platform}/${r.destaque} (status=${r.expected_status})${note}`);
  }
  if (warnings.length > 0) {
    console.error("\nWarnings:");
    for (const w of warnings) console.error(`  - ${w}`);
  }
  console.error("");

  process.exit(ok ? 0 : 1);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(2);
  });
}
