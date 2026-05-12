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
 *   0 = todos os posts confirmados (count auto-derivado de fbEntries + liEntries;
 *       edição #595 normal: 12 = 3 FB + 9 LI [3 main + 3 comment_diaria + 3 comment_pixel])
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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readSocialPublished, type PostEntry } from "./lib/social-published-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Resolve FB Page ID com mesma precedência de publish-facebook.ts:
 * env FACEBOOK_PAGE_ID > data/.fb-credentials.json (legacy fallback).
 */
function resolveFbPageId(): string {
  const fromEnv = process.env.FACEBOOK_PAGE_ID;
  if (fromEnv) return fromEnv;
  try {
    const creds = JSON.parse(
      readFileSync(resolve(ROOT, "data/.fb-credentials.json"), "utf8"),
    ) as { page_id?: string };
    return creds.page_id ?? "";
  } catch {
    return "";
  }
}

/**
 * Resolve URL do Worker LinkedIn com mesma precedência de publish-linkedin.ts:
 * env DIARIA_LINKEDIN_CRON_URL > platform.config.json.
 * Sem essa fallback, o verifier falhava quando o URL era só do config (#975).
 */
function resolveLinkedinWorkerUrl(): string {
  const fromEnv = process.env.DIARIA_LINKEDIN_CRON_URL;
  if (fromEnv) return fromEnv;
  try {
    const config = JSON.parse(
      readFileSync(resolve(ROOT, "platform.config.json"), "utf8"),
    ) as {
      publishing?: { social?: { linkedin?: { cloudflare_worker_url?: string } } };
    };
    return config.publishing?.social?.linkedin?.cloudflare_worker_url ?? "";
  } catch {
    return "";
  }
}

// ---- Tipos ----

export interface VerifyResult {
  destaque: string;
  platform: string;
  expected_status: string;
  verified: boolean;
  reason?: string;
  external_state?: unknown;
  /** #595 — subtype do entry (main / comment_diaria / comment_pixel). */
  subtype?: string;
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

interface FbScheduledPost {
  id: string;
  scheduled_publish_time?: number;
  message?: string;
}

interface FbScheduledPostsResponse {
  data?: FbScheduledPost[];
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
    // #595 — opcionais; presentes pra entries enfileiradas após o rollout.
    webhook_target?: "diaria" | "pixel";
    action?: "post" | "comment";
    parent_destaque?: string;
  }>;
}

// ---- Facebook verifier ----

/**
 * Lista posts agendados pra Page (`/{page_id}/scheduled_posts`). Endpoint correto
 * pra verificar agendamentos em Graph API v25.0+ (#974). O endpoint legacy
 * `/{post_id}?fields=is_published,scheduled_publish_time` não existe mais — Graph
 * retorna `(#100) Tried accessing nonexisting field`.
 */
export async function fetchFbScheduledPosts(
  pageId: string,
  pageToken: string,
  apiVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FbScheduledPostsResponse> {
  const fields = "id,scheduled_publish_time,message";
  const url = `https://graph.facebook.com/${apiVersion}/${pageId}/scheduled_posts?fields=${fields}&limit=100`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `OAuth ${pageToken}` },
  });
  return (await res.json()) as FbScheduledPostsResponse;
}

/**
 * Confirma que um post existe (publicado ou ainda válido) via GET simples por id.
 * Usado como fallback quando o post não está em `/scheduled_posts` (já publicado
 * ou janela de agendamento passou). Pede só `id` + `permalink_url` pra evitar
 * o erro `(#100) Tried accessing nonexisting field`.
 */
export async function fetchFbPostState(
  postId: string,
  pageToken: string,
  apiVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FbGraphResponse> {
  const fields = "id,permalink_url,created_time";
  const url = `https://graph.facebook.com/${apiVersion}/${postId}?fields=${fields}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `OAuth ${pageToken}` },
  });
  return (await res.json()) as FbGraphResponse;
}

/**
 * Faz match de PostEntry com a lista `/scheduled_posts` da Page (#974).
 * Graph API retorna IDs no formato `{page_id}_{post_id}`; o fb_post_id que
 * gravamos pode ser só o sufixo. Match por sufixo (endsWith) cobre os dois.
 */
export function findScheduledMatch(
  fbPostId: string,
  scheduled: FbScheduledPost[],
): FbScheduledPost | undefined {
  return scheduled.find(
    (sp) => sp.id === fbPostId || sp.id.endsWith(`_${fbPostId}`) || fbPostId.endsWith(`_${sp.id}`),
  );
}

/**
 * Reconcilia FB entry contra (1) lista `/scheduled_posts` (preferred), com
 * fallback (2) GET simples por post_id pra confirmar que existe (caso já
 * tenha sido publicado/expirado e saido da queue). Pure -- testavel sem network.
 *
 * `directGraph` é opcional — só consultado quando `scheduledPosts` não tem match.
 */
export function reconcileFb(
  entry: PostEntry,
  scheduledPosts: FbScheduledPost[],
  directGraph?: FbGraphResponse,
  now: Date = new Date(),
): VerifyResult {
  const base: VerifyResult = {
    destaque: entry.destaque,
    platform: "facebook",
    expected_status: entry.status,
    verified: false,
  };

  const fbPostId = (entry.fb_post_id as string | undefined) ?? "";
  if (!fbPostId) return { ...base, reason: "no_fb_post_id" };

  const match = findScheduledMatch(fbPostId, scheduledPosts);
  if (match) {
    // #1180: detect "scheduled_at in past" — post ainda está em /scheduled_posts
    // mas a hora já passou. Próximo tick do Brevo/FB publica imediato (= sai
    // antes do horário planejado da wave). Falha grave.
    const scheduledMs =
      typeof match.scheduled_publish_time === "number"
        ? match.scheduled_publish_time * 1000
        : null;
    if (scheduledMs !== null && scheduledMs < now.getTime()) {
      return {
        ...base,
        reason: `scheduled_at_in_past: scheduled_publish_time ${new Date(scheduledMs).toISOString()} ja passou de ${now.toISOString()} — post vai publicar imediato no proximo tick`,
        external_state: {
          scheduled_publish_time: match.scheduled_publish_time,
          scheduled_iso: new Date(scheduledMs).toISOString(),
          matched_id: match.id,
        },
      };
    }
    return {
      ...base,
      verified: true,
      external_state: {
        scheduled_publish_time: match.scheduled_publish_time,
        scheduled_iso:
          scheduledMs !== null ? new Date(scheduledMs).toISOString() : null,
        matched_id: match.id,
      },
    };
  }

  // Fallback: post não está em /scheduled_posts. Pode ser:
  //   (a) já publicado (passou o scheduled_publish_time)
  //   (b) deletado/expirado
  // GET por id confirma existência sem campos quebrados.
  if (directGraph) {
    if (directGraph.error) {
      return {
        ...base,
        reason: `graph_api_error: ${directGraph.error.message}`,
        external_state: directGraph.error,
      };
    }
    if (directGraph.id) {
      return {
        ...base,
        verified: true,
        external_state: {
          post_exists: true,
          permalink_url: directGraph.permalink_url,
          created_time: directGraph.created_time,
          note: "not in /scheduled_posts — provavelmente já publicado",
        },
      };
    }
    return { ...base, reason: "graph_returned_no_id", external_state: directGraph };
  }

  return {
    ...base,
    reason: "post_missing: nao esta em /scheduled_posts e fallback GET nao foi feito",
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
 *
 * #595: edição agora tem 9 LinkedIn entries (3 main + 3 comment_diaria + 3
 * comment_pixel). Match por `worker_queue_key` (UUID único) é o caminho
 * primário; fallback por (destaque, subtype/action) é necessário porque
 * destaque sozinho retorna múltiplos itens.
 */
export function reconcileLinkedin(
  entry: PostEntry,
  queueItems: WorkerListResponse["items"],
  now: Date = new Date(),
): VerifyResult {
  const subtype = (entry.subtype as string | undefined) ?? "main";
  const base: VerifyResult = {
    destaque: entry.destaque,
    platform: "linkedin",
    expected_status: entry.status,
    verified: false,
    subtype, // #595 — sempre exposto pra desambiguar 9 entries por edição
  };

  /** #1180: helper pra detectar item na queue com scheduled_at já passado.
   * Worker cron dispara no próximo tick (~1min) → publica imediato. */
  const isPastSchedule = (scheduled_at: string): boolean => {
    const ms = Date.parse(scheduled_at);
    return Number.isFinite(ms) && ms < now.getTime();
  };

  // #1180: fallback_used significa que Worker falhou e Make foi acionado
  // diretamente — Make IGNORA scheduled_at e publica IMEDIATO. Pra wave que
  // deveria ser agendada pro futuro, isso é FALHA grave (post sai antes do
  // horário planejado). Antes (#917) marcava verified=true porque "não
  // enfileiravel" — mas isso esconde o bug do editor. Agora marca falha.
  if (entry.fallback_used) {
    return {
      ...base,
      verified: false,
      reason: `fallback_used_immediate_publish: Worker falhou, Make fire-now (post foi/sera publicado IMEDIATO, ignorando scheduled_at=${entry.scheduled_at ?? "?"}). Acao sugerida: post ja saiu — pra desfazer, deletar do LinkedIn manualmente e republicar com novo agendamento`,
      external_state: { fallback_used: true, subtype },
    };
  }

  // Match por worker_queue_key (mais preciso) — UUID único, sempre 1:1.
  const expectedKey = entry.worker_queue_key as string | undefined;
  const matchByKey = expectedKey
    ? queueItems.find((it) => it.key === expectedKey)
    : null;

  if (matchByKey) {
    // #1180: item está na queue MAS scheduled_at já passou → vai disparar
    // no próximo tick do cron worker (~1min), publicação imediata.
    if (isPastSchedule(matchByKey.scheduled_at)) {
      return {
        ...base,
        reason: `scheduled_at_in_past: item esta na queue mas scheduled_at=${matchByKey.scheduled_at} ja passou de ${now.toISOString()} — worker vai disparar imediato no proximo tick`,
        external_state: {
          key: matchByKey.key,
          scheduled_at: matchByKey.scheduled_at,
          subtype,
          webhook_target: matchByKey.webhook_target,
          action: matchByKey.action,
        },
      };
    }
    return {
      ...base,
      verified: true,
      external_state: {
        key: matchByKey.key,
        scheduled_at: matchByKey.scheduled_at,
        subtype,
        webhook_target: matchByKey.webhook_target,
        action: matchByKey.action,
      },
    };
  }

  // #595 — Fallback por (destaque, action, webhook_target). Sem isso, 3 entries
  // por destaque colapsariam num só match destaque-based.
  const expectedAction = subtype === "main" ? "post" : "comment";
  const expectedTarget = subtype === "comment_pixel" ? "pixel" : "diaria";
  const matchesNarrow = queueItems.filter((it) => {
    if (it.destaque !== entry.destaque) return false;
    // Backward-compat: items sem webhook_target/action pré-#595 → main only
    const itAction = it.action ?? "post";
    const itTarget = it.webhook_target ?? "diaria";
    return itAction === expectedAction && itTarget === expectedTarget;
  });

  if (matchesNarrow.length === 0) {
    return {
      ...base,
      reason: `nenhum item no Worker KV pro (${entry.destaque}, ${subtype}) (queue silent fail?)`,
      external_state: { queue_size: queueItems.length, subtype },
    };
  }

  // Múltiplos itens narrow -> pegar o mais próximo do entry.scheduled_at
  const expectedSched = entry.scheduled_at;
  const best = expectedSched
    ? matchesNarrow.reduce((acc, it) => {
        const accDiff = Math.abs(Date.parse(acc.scheduled_at) - Date.parse(expectedSched));
        const itDiff = Math.abs(Date.parse(it.scheduled_at) - Date.parse(expectedSched));
        return itDiff < accDiff ? it : acc;
      }, matchesNarrow[0])
    : matchesNarrow[0];

  // #1180: detectar past-schedule também no path narrow.
  if (isPastSchedule(best.scheduled_at)) {
    return {
      ...base,
      reason: `scheduled_at_in_past: item esta na queue (narrow match) mas scheduled_at=${best.scheduled_at} ja passou de ${now.toISOString()} — worker vai disparar imediato no proximo tick`,
      external_state: {
        key: best.key,
        scheduled_at: best.scheduled_at,
        multiple_matches: matchesNarrow.length,
        subtype,
        webhook_target: best.webhook_target,
        action: best.action,
      },
    };
  }
  return {
    ...base,
    verified: true,
    external_state: {
      key: best.key,
      scheduled_at: best.scheduled_at,
      multiple_matches: matchesNarrow.length,
      subtype,
      webhook_target: best.webhook_target,
      action: best.action,
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

  // Facebook verification (#974: usar /scheduled_posts em vez de /{post_id})
  const fbToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN ?? "";
  const fbApiVersion = process.env.FACEBOOK_API_VERSION ?? "v25.0";
  const fbPageId = resolveFbPageId();
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
  } else if (!fbPageId && fbEntries.length > 0) {
    warnings.push(
      "FACEBOOK_PAGE_ID ausente -- nao consigo consultar /scheduled_posts. " +
        "FB entries serao marcadas como unverified.",
    );
    for (const e of fbEntries) {
      results.push({
        destaque: e.destaque,
        platform: "facebook",
        expected_status: e.status,
        verified: false,
        reason: "missing_fb_page_id",
      });
    }
  } else if (fbEntries.length > 0) {
    let scheduledPosts: FbScheduledPost[] = [];
    try {
      const resp = await fetchFbScheduledPosts(fbPageId, fbToken, fbApiVersion);
      if (resp.error) {
        warnings.push(`/scheduled_posts retornou erro: ${resp.error.message}`);
      } else {
        scheduledPosts = resp.data ?? [];
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`/scheduled_posts falhou: ${msg}`);
    }

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
      // Match na lista de scheduled. Se não achou, fallback pra GET direto
      // (post pode ter sido publicado já, sai da queue de scheduled).
      const match = findScheduledMatch(fbId, scheduledPosts);
      if (match) {
        results.push(reconcileFb(e, scheduledPosts));
        continue;
      }
      try {
        const direct = await fetchFbPostState(fbId, fbToken, fbApiVersion);
        results.push(reconcileFb(e, scheduledPosts, direct));
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

  // LinkedIn verification (#975: fallback URL pra platform.config.json)
  const workerUrl = resolveLinkedinWorkerUrl();
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
          subtype: (e.subtype as string | undefined) ?? "main",
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
          subtype: (e.subtype as string | undefined) ?? "main",
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
