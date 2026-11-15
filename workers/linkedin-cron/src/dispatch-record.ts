import type { Env, QueueEntry } from "./index";
import type { FireOutcome } from "./dispatch";
import { defaultLinkedInApiVersion } from "./linkedin-api-version";

export interface DispatchRecord {
  key: string;
  channel: string;
  destaque: string;
  scheduled_at: string;
  dispatched_at: string;
  status: FireOutcome["status"];
  post_id: string | null;
  container_id: string | null;
  http_status: number | null;
  ig_account?: string;
}

// Whitelist only: never persist payload, credentials, URLs or platform error bodies.
export async function recordDispatch(kv: KVNamespace | undefined, key: string, entry: QueueEntry, outcome: FireOutcome): Promise<void> {
  const record: DispatchRecord = {
    key, channel: entry.channel ?? "linkedin", destaque: entry.destaque,
    scheduled_at: entry.scheduled_at, dispatched_at: new Date().toISOString(),
    status: outcome.status, post_id: outcome.postId ?? null,
    container_id: outcome.containerId ?? null, http_status: outcome.httpStatus ?? null,
    ...(entry.ig_account && { ig_account: entry.ig_account }),
  };
  console.log(JSON.stringify({ event: "dispatch", ...record }));
  try {
    await kv?.put(`fired:${key}`, JSON.stringify(record), { expirationTtl: 30 * 86400 });
  } catch {
    // Observability failure must never re-dispatch an already published post.
    console.error(JSON.stringify({ event: "dispatch_record_failed", key }));
  }
}

export async function verifyDispatchRecord(record: DispatchRecord, env: Env): Promise<{ verified: boolean; http_status: number | null }> {
  const id = record.post_id;
  if (record.status !== "fired" || !id) return { verified: false, http_status: null };
  let url: string;
  let token: string | undefined;
  const headers: Record<string, string> = {};
  if (record.channel === "instagram") {
    token = record.ig_account === "vjpixel" ? env.INSTAGRAM_VJPIXEL_ACCESS_TOKEN : env.INSTAGRAM_ACCESS_TOKEN;
    url = `https://graph.facebook.com/${env.INSTAGRAM_API_VERSION || "v25.0"}/${encodeURIComponent(id)}?fields=id`;
  } else if (record.channel === "threads") {
    token = env.THREADS_ACCESS_TOKEN;
    url = `https://graph.threads.net/${env.THREADS_API_VERSION || "v1.0"}/${encodeURIComponent(id)}?fields=id`;
  } else {
    token = env.LINKEDIN_ACCESS_TOKEN;
    url = `https://api.linkedin.com/rest/posts/${encodeURIComponent(id)}`;
    headers["LinkedIn-Version"] = env.LINKEDIN_API_VERSION || defaultLinkedInApiVersion(new Date());
    headers["X-Restli-Protocol-Version"] = "2.0.0";
  }
  if (!token) return { verified: false, http_status: null };
  try {
    const res = await fetch(url, { headers: { ...headers, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    const body = await res.json() as { id?: string };
    return { verified: res.ok && body.id === id, http_status: res.status };
  } catch {
    return { verified: false, http_status: null };
  }
}
