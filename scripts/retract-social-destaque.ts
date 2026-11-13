#!/usr/bin/env tsx
/**
 * retract-social-destaque.ts (#12961)
 *
 * Cancela os posts AGENDADOS de um destaque (ex.: d3) depois do dispatch da
 * Etapa 5, para corrigir o texto e re-despachar só ele. Antes disto, na
 * edição 261113, o editor apagou o post do Facebook (Graph DELETE), as
 * entradas do Worker e as linhas de `06-social-published.json` com um script
 * avulso.
 *
 * Contrato de segurança (o que tornava o script avulso perigoso):
 *   - Worker (LinkedIn/Instagram/Threads): usa SÓ o cancelamento condicional
 *     `POST /queue-cancel/:key` (#12961, worker linkedin-cron).
 *     O DO recusa (409) post que já saiu, terminou ambíguo ou está saindo; só
 *     a resposta 200 com `conditional: true` confirmada libera a linha do
 *     registro. 404 (já disparou OU já removido; num Worker sem o #12961, a
 *     rota não existe e nada acontece) nunca libera.
 *   - Facebook: relê o post na Graph API (`is_published`,
 *     `scheduled_publish_time`) e só apaga se ainda está agendado e falta mais
 *     de `FB_MIN_LEAD_SEC` para sair. Post já no ar não é apagado aqui.
 *   - X (Buffer) e qualquer entrada sem identificador cancelável: manual,
 *     listados no resultado.
 *   - A linha só sai de `06-social-published.json` com o cancelamento
 *     confirmado; o que saiu fica em `_internal/06-social-retracted.jsonl`
 *     (entrada inteira + resultado), para não perder a evidência.
 *
 * Dry-run por padrão: sem `--confirm` só lista o plano e não toca em nada
 * (nem rede).
 *
 * Uso:
 *   npx tsx scripts/retract-social-destaque.ts --edition-dir data/editions/2611/261113 --destaque d3
 *   npx tsx scripts/retract-social-destaque.ts --edition-dir ... --destaque d3 --channels facebook,linkedin --confirm
 *
 * Depois: re-despachar os canais cancelados (os publishers agendam só o que
 * falta no registro) — o `next_steps` do JSON diz quais.
 *
 * Exit: 0 tudo cancelado (ou dry-run); 1 algum alvo não foi cancelado
 * (recusado, ambíguo, erro, manual); 2 uso inválido.
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { readSocialPublished, rewriteSocialPosts, type PostEntry } from "./lib/social-published-store.ts";
import {
  loadResolvedFacebookPages,
  resolveFacebookPageForEntry,
  socialEntryKey,
  type ResolvedFacebookPage,
} from "./lib/facebook-pages.ts";
import { cancelWorkerQueueEntryConditional, type ConditionalCancelResult } from "./lib/worker-queue-client.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Folga mínima até o horário agendado do Facebook para apagar com segurança. */
export const FB_MIN_LEAD_SEC = 120;

export const RETRACT_CHANNELS = ["facebook", "linkedin", "instagram", "threads", "twitter"] as const;
export type RetractChannel = (typeof RETRACT_CHANNELS)[number];

export type TargetAction = "worker" | "facebook" | "manual" | "skip";

export interface RetractTarget {
  entry: PostEntry;
  action: TargetAction;
  identifier: string | null;
  reason?: string;
}

/**
 * Pure: alvos do destaque nos canais pedidos. Só `status: scheduled` é
 * cancelável; o resto vira `skip` (com o motivo), X vira `manual`.
 */
export function planRetraction(posts: readonly PostEntry[], destaque: string, channels: readonly string[]): RetractTarget[] {
  const out: RetractTarget[] = [];
  for (const entry of posts) {
    if (entry.destaque !== destaque || !channels.includes(entry.platform)) continue;
    const key = typeof entry.worker_queue_key === "string" && entry.worker_queue_key ? entry.worker_queue_key : null;
    const fbId = typeof entry.fb_post_id === "string" && entry.fb_post_id ? entry.fb_post_id : null;
    if (entry.status !== "scheduled") {
      out.push({ entry, action: "skip", identifier: key ?? fbId, reason: `status ${entry.status} — só agendado é cancelável aqui` });
    } else if (entry.platform === "twitter") {
      const id = typeof entry.buffer_post_id === "string" ? entry.buffer_post_id : null;
      out.push({ entry, action: "manual", identifier: id, reason: "X sai pela Buffer — cancelar pelo MCP/painel da Buffer" });
    } else if (entry.platform === "facebook") {
      out.push(fbId ? { entry, action: "facebook", identifier: fbId } : { entry, action: "manual", identifier: null, reason: "sem fb_post_id" });
    } else if (key) {
      out.push({ entry, action: "worker", identifier: key });
    } else {
      out.push({ entry, action: "manual", identifier: null, reason: "sem worker_queue_key (rota fora do Worker)" });
    }
  }
  return out;
}

export type FacebookRetractOutcome =
  | { outcome: "cancelled" }
  | { outcome: "refused"; reason: string }
  | { outcome: "not_found" }
  | { outcome: "error"; error: string };

/**
 * Lê o post e só apaga se ainda não saiu e falta mais que `FB_MIN_LEAD_SEC`.
 * 404/código 100 = ambíguo (não autoriza re-despacho). Nunca lança.
 */
export async function retractFacebookScheduledPost(
  fbPostId: string,
  pageToken: string,
  apiVersion: string,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<FacebookRetractOutcome> {
  const base = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(fbPostId)}`;
  const headers = { Authorization: `Bearer ${pageToken}` }; // nunca na query string (#7779)
  const isGone = (status: number, body: string) => {
    if (status === 404) return true;
    if (status !== 400) return false;
    try {
      return (JSON.parse(body) as { error?: { code?: unknown } })?.error?.code === 100;
    } catch {
      return false;
    }
  };
  try {
    const res = await fetchImpl(`${base}?fields=is_published,scheduled_publish_time`, { headers });
    const body = await res.text();
    if (!res.ok) return isGone(res.status, body) ? { outcome: "not_found" } : { outcome: "error", error: `GET HTTP ${res.status}: ${body.slice(0, 200)}` };
    const info = JSON.parse(body) as { is_published?: unknown; scheduled_publish_time?: unknown };
    if (info.is_published !== false) return { outcome: "refused", reason: "post já publicado (is_published != false)" };
    const when = typeof info.scheduled_publish_time === "number" ? info.scheduled_publish_time : Number(info.scheduled_publish_time);
    if (!Number.isFinite(when)) return { outcome: "refused", reason: "sem scheduled_publish_time legível" };
    if (when - now.getTime() / 1000 <= FB_MIN_LEAD_SEC) {
      return { outcome: "refused", reason: `sai em menos de ${FB_MIN_LEAD_SEC}s — não apagar no limite` };
    }
    const del = await fetchImpl(base, { method: "DELETE", headers });
    const delBody = await del.text();
    if (del.ok) return { outcome: "cancelled" };
    return isGone(del.status, delBody) ? { outcome: "not_found" } : { outcome: "error", error: `DELETE HTTP ${del.status}: ${delBody.slice(0, 200)}` };
  } catch (e) {
    return { outcome: "error", error: (e as Error).message ?? String(e) };
  }
}

export interface TargetResult {
  platform: string;
  destaque: string;
  subtype: string;
  page?: string;
  action: TargetAction;
  identifier: string | null;
  status: "dry_run" | "cancelled" | "refused" | "not_found" | "unconfirmed" | "error" | "manual" | "skipped";
  detail?: string;
}

export interface RetractDeps {
  cancelWorker: (key: string) => Promise<ConditionalCancelResult>;
  retractFacebook: (entry: PostEntry, fbPostId: string) => Promise<FacebookRetractOutcome>;
}

/** Executa (ou simula) o plano. Não grava nada: devolve os resultados. */
export async function executeRetraction(targets: readonly RetractTarget[], confirm: boolean, deps: RetractDeps): Promise<TargetResult[]> {
  const results: TargetResult[] = [];
  for (const t of targets) {
    const base = {
      platform: t.entry.platform,
      destaque: t.entry.destaque,
      subtype: typeof t.entry.subtype === "string" ? t.entry.subtype : "main",
      ...(t.entry.platform === "facebook" ? { page: typeof t.entry.page === "string" ? t.entry.page : "diaria" } : {}),
      action: t.action,
      identifier: t.identifier,
    };
    if (t.action === "skip") {
      results.push({ ...base, status: "skipped", detail: t.reason });
      continue;
    }
    if (t.action === "manual") {
      results.push({ ...base, status: "manual", detail: t.reason });
      continue;
    }
    if (!confirm) {
      results.push({ ...base, status: "dry_run" });
      continue;
    }
    if (t.action === "worker") {
      const r = await deps.cancelWorker(t.identifier as string);
      const detail =
        r.outcome === "refused" ? r.reason : r.outcome === "error" ? r.error : r.outcome === "unconfirmed" ? `2xx sem a confirmação completa do cancelamento: ${r.body}` : undefined;
      results.push({ ...base, status: r.outcome, ...(detail ? { detail } : {}) });
      continue;
    }
    const r = await deps.retractFacebook(t.entry, t.identifier as string);
    results.push({
      ...base,
      status: r.outcome,
      ...(r.outcome === "refused" ? { detail: r.reason } : r.outcome === "error" ? { detail: r.error } : {}),
    });
  }
  return results;
}

/**
 * Pure: tira do registro SÓ as entradas com cancelamento confirmado (mesma
 * chave de upsert + mesmo identificador, para não levar uma entrada regravada
 * no meio). Devolve as removidas.
 */
export function removeCancelledEntries(
  posts: PostEntry[],
  cancelled: ReadonlyArray<{ entry: PostEntry; identifier: string | null }>,
): { posts: PostEntry[]; removed: PostEntry[] } {
  const wanted = new Set(cancelled.map((c) => `${socialEntryKey(c.entry)}#${c.identifier}`));
  const removed: PostEntry[] = [];
  const kept = posts.filter((p) => {
    const id = (typeof p.worker_queue_key === "string" && p.worker_queue_key) || (typeof p.fb_post_id === "string" && p.fb_post_id) || null;
    if (wanted.has(`${socialEntryKey(p)}#${id}`)) {
      removed.push(p);
      return false;
    }
    return true;
  });
  return { posts: kept, removed };
}

function resolveWorkerUrl(config: Record<string, unknown>): string {
  const social = (config.publishing as { social?: Record<string, { cloudflare_worker_url?: string }> } | undefined)?.social;
  return process.env.DIARIA_LINKEDIN_CRON_URL ?? social?.linkedin?.cloudflare_worker_url ?? "";
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { flags, values } = parseArgs(argv);
  const dirArg = values["edition-dir"];
  const destaque = values["destaque"];
  if (!dirArg || !destaque || !/^(d[123]|um)$/.test(destaque)) {
    console.error("uso: retract-social-destaque.ts --edition-dir DIR --destaque d1|d2|d3|um [--channels facebook,linkedin,instagram,threads,twitter] [--confirm]");
    return 2;
  }
  const channels = values["channels"] ? values["channels"].split(",").map((c) => c.trim()).filter(Boolean) : [...RETRACT_CHANNELS];
  const bad = channels.filter((c) => !(RETRACT_CHANNELS as readonly string[]).includes(c));
  if (bad.length > 0) {
    console.error(`retract-social-destaque: canal desconhecido: ${bad.join(", ")} (aceitos: ${RETRACT_CHANNELS.join(", ")})`);
    return 2;
  }
  const editionDir = resolve(dirArg);
  const publishedPath = resolve(editionDir, "_internal", "06-social-published.json");
  if (!existsSync(publishedPath)) {
    console.error(`retract-social-destaque: ${publishedPath} não existe`);
    return 2;
  }
  const confirm = flags.has("confirm");
  const targets = planRetraction(readSocialPublished(publishedPath).posts ?? [], destaque, channels);

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as Record<string, unknown>;
  } catch {
    /* sem config: Worker só pelo env, Facebook pelo fallback de compat */
  }
  const workerUrl = resolveWorkerUrl(config);
  const workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
  let fb: { pages: ResolvedFacebookPage[]; apiVersion: string } = { pages: [], apiVersion: "v25.0" };
  try {
    fb = loadResolvedFacebookPages(ROOT, config);
  } catch (e) {
    console.error(`retract-social-destaque: config de páginas do Facebook inválido: ${(e as Error).message}`);
  }
  if (confirm && targets.some((t) => t.action === "worker") && (!workerUrl || !workerToken)) {
    console.error("retract-social-destaque: DIARIA_LINKEDIN_CRON_URL/TOKEN ausentes — nada foi cancelado.");
    return 2;
  }

  const results = await executeRetraction(targets, confirm, {
    cancelWorker: (key) => cancelWorkerQueueEntryConditional(workerUrl, workerToken, key),
    retractFacebook: async (entry, fbPostId) => {
      const page = resolveFacebookPageForEntry(entry, fb.pages);
      if (!page.ok) return { outcome: "error", error: page.reason };
      return retractFacebookScheduledPost(fbPostId, page.page.token, fb.apiVersion, new Date());
    },
  });

  let removed: PostEntry[] = [];
  if (confirm) {
    const cancelled = targets.filter((t, i) => results[i].status === "cancelled");
    if (cancelled.length > 0) {
      const log = resolve(editionDir, "_internal", "06-social-retracted.jsonl");
      rewriteSocialPosts(publishedPath, (posts) => {
        const r = removeCancelledEntries(posts, cancelled);
        removed = r.removed;
        // Log ANTES da reescrita (ainda sob o lock): se ele falhar, o transform
        // lança e o registro fica intacto — a linha nunca some sem evidência.
        if (removed.length > 0) {
          const at = new Date().toISOString();
          appendFileSync(log, removed.map((e) => JSON.stringify({ retracted_at: at, destaque, entry: e })).join("\n") + "\n", "utf8");
        }
        return r.posts;
      });
    }
  }

  const pending = results.filter((r) => !["cancelled", "dry_run"].includes(r.status));
  const cancelledChannels = [...new Set(results.filter((r) => r.status === "cancelled").map((r) => r.platform))];
  const nextSteps = !confirm
    ? [`Plano acima é só simulação. Para cancelar de fato: repetir com --confirm.`]
    : [
        ...(cancelledChannels.length > 0
          ? [
              `Corrigir o texto de ## ${destaque} em 03-social.md (e cards, se o carrossel muda) antes de re-despachar.`,
              `Re-despachar só ${cancelledChannels.join(", ")}: os publishers da Etapa 5 agendam o que falta no registro (/diaria-5-publicacao com o canal correspondente).`,
            ]
          : []),
        ...(pending.length > 0 ? [`Alvos NÃO cancelados ficam no registro — não re-despachar esses canais sem conferir: ${pending.map((r) => `${r.platform}/${r.subtype} (${r.status})`).join(", ")}.`] : []),
      ];
  console.log(JSON.stringify({ destaque, confirm, results, removed_entries: removed.length, next_steps: nextSteps }, null, 2));
  return confirm && pending.length > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  main().then((code) => (process.exitCode = code)).catch((e) => {
    console.error(`retract-social-destaque: ${(e as Error).message}`);
    process.exitCode = 2;
  });
}
