/**
 * scripts/beehiiv-sync.ts
 *
 * Complete backup / mirror of all Beehiiv data to local cache.
 *
 * Usage:
 *   npx tsx scripts/beehiiv-sync.ts                     # sync all (incremental)
 *   npx tsx scripts/beehiiv-sync.ts --posts             # posts only
 *   npx tsx scripts/beehiiv-sync.ts --subscribers       # subscribers only
 *   npx tsx scripts/beehiiv-sync.ts --full              # re-fetch everything (ignore cache)
 *   npx tsx scripts/beehiiv-sync.ts --no-sub-details    # skip per-subscriber detail expansion
 *
 * Requires: BEEHIIV_API_KEY env var
 *
 * Output: data/beehiiv-cache/
 *   sync-state.json
 *   workspace.json
 *   publication.json               (info + stats)
 *   authors.json
 *   content-tags.json
 *   custom-fields.json
 *   referral-program.json
 *   condition-sets.json
 *   posts/
 *     index.json
 *     {post_id}.json               (content + stats + clicks + click_subscribers)
 *   subscribers/
 *     index.json                   (lightweight: id, email, status, tier, dates)
 *     all.jsonl                    (full subscription records)
 *     details/
 *       {sub_id}.json              (expanded: custom_fields, tags, referrals, stats)
 *   polls/
 *     index.json
 *     {poll_id}.json               (+ responses)
 *   surveys/
 *     index.json
 *     {survey_id}.json             (+ responses)
 *   tiers/
 *     index.json
 *   automations/
 *     index.json
 *     {automation_id}.json         (+ journeys)
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  createWriteStream,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Paths ──────────────────────────────────────────────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = resolve(ROOT, "data/beehiiv-cache");
const POSTS_DIR = resolve(CACHE, "posts");
const SUBS_DIR = resolve(CACHE, "subscribers");
const SUBS_DETAIL_DIR = resolve(SUBS_DIR, "details");
const POLLS_DIR = resolve(CACHE, "polls");
const SURVEYS_DIR = resolve(CACHE, "surveys");
const TIERS_DIR = resolve(CACHE, "tiers");
const AUTOMATIONS_DIR = resolve(CACHE, "automations");
const SEGMENTS_DIR = resolve(CACHE, "segments");
const STATE_PATH = resolve(CACHE, "sync-state.json");

// ── Config ─────────────────────────────────────────────────────────────────

const config = JSON.parse(
  readFileSync(resolve(ROOT, "platform.config.json"), "utf8")
);
const PUB_ID: string = config.beehiiv.publicationId;
const API_KEY = process.env.BEEHIIV_API_KEY;
if (!API_KEY) {
  console.error("❌  BEEHIIV_API_KEY env var is required.");
  process.exit(1);
}

const BASE = "https://api.beehiiv.com/v2";
const HEADERS = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

// ── CLI flags ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const FULL = args.includes("--full");
const POSTS_ONLY = args.includes("--posts");
const SUBS_ONLY = args.includes("--subscribers");
const NO_SUB_DETAILS = args.includes("--no-sub-details");
const DO_POSTS = !SUBS_ONLY;
const DO_SUBS = !POSTS_ONLY;
const DO_ALL = !POSTS_ONLY && !SUBS_ONLY;

// ── Rate-limit aware fetch ─────────────────────────────────────────────────

const DELAY_MS = 300;
const MAX_RETRIES = 5;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiFetch(url: string, retries = 0): Promise<unknown> {
  await sleep(DELAY_MS);
  const res = await fetch(url, { headers: HEADERS });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "120", 10);
    const wait = Math.max(retryAfter * 1000, 60_000);
    console.warn(`\n  ⏳ Rate limited — waiting ${Math.round(wait / 1000)}s (attempt ${retries + 1}/${MAX_RETRIES})…`);
    await sleep(wait);
    if (retries >= MAX_RETRIES) throw new Error(`Rate limit exceeded after ${MAX_RETRIES} retries`);
    return apiFetch(url, retries + 1);
  }

  if (res.status === 404) return null;

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}\n${body}`);
  }

  return res.json();
}

/** Fetch all pages via offset pagination (most endpoints). Returns flat array. */
async function fetchAllPages(baseUrl: string, label: string): Promise<unknown[]> {
  const items: unknown[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${sep}per_page=100&page=${page}`;
    process.stdout.write(`  → ${label} page ${page}/${totalPages === 1 && page === 1 ? "?" : totalPages}…\r`);

    const data = (await apiFetch(url)) as {
      data: unknown[];
      pages?: number;
      total_pages?: number;
      total_results?: number;
      limit?: number;
    } | null;

    if (!data) break;

    const pg = data.pages ?? data.total_pages;
    if (pg != null) {
      totalPages = pg;
    } else if (data.total_results != null && data.limit != null && data.limit > 0) {
      totalPages = Math.ceil(data.total_results / data.limit);
    }

    items.push(...(data.data ?? []));
    page++;
  }

  return items;
}

/** Fetch all pages via cursor pagination (subscriptions endpoint). Returns flat array. */
async function fetchAllCursor(
  baseUrl: string,
  label: string,
  onPage: (items: unknown[]) => void
): Promise<number> {
  let cursor: string | null = null;
  let hasMore = true;
  let pageNum = 0;
  let total = 0;

  while (hasMore) {
    pageNum++;
    const sep = baseUrl.includes("?") ? "&" : "?";
    let url = `${baseUrl}${sep}per_page=100`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

    process.stdout.write(`  → ${label} page ${pageNum} (${total} so far)…\r`);

    const data = (await apiFetch(url)) as {
      data: unknown[];
      has_more?: boolean;
      next_cursor?: string;
    } | null;

    if (!data || !data.data?.length) break;

    onPage(data.data);
    total += data.data.length;
    hasMore = data.has_more ?? false;
    cursor = data.next_cursor ?? null;
  }

  return total;
}

// ── State helpers ──────────────────────────────────────────────────────────

type SyncState = {
  posts?: { last_synced_at: string; count: number };
  subscribers?: { last_synced_at: string; count: number };
  subscriber_details?: { last_synced_at: string; count: number };
  polls?: { last_synced_at: string; count: number };
  surveys?: { last_synced_at: string; count: number };
  tiers?: { last_synced_at: string; count: number };
  automations?: { last_synced_at: string; count: number };
  segments?: { last_synced_at: string; count: number };
  misc?: { last_synced_at: string };
};

function loadState(): SyncState {
  return existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : {};
}

function saveState(state: SyncState) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

function ensureDirs() {
  for (const dir of [POSTS_DIR, SUBS_DIR, SUBS_DETAIL_DIR, POLLS_DIR, SURVEYS_DIR, TIERS_DIR, AUTOMATIONS_DIR, SEGMENTS_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}

function write(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

// ── Post helpers ───────────────────────────────────────────────────────────

type PostIndex = {
  id: string;
  title: string;
  subtitle?: string;
  slug: string;
  status: string;
  published_at: string | null;
  updated_at: string | null;
  web_url: string | null;
  email_subject: string | null;
  authors: string[];
  content_tags: string[];
};

function postPath(id: string) { return resolve(POSTS_DIR, `${id}.json`); }

function loadPostIndex(): PostIndex[] {
  const p = resolve(POSTS_DIR, "index.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : [];
}

function needsUpdate(post: { id: string; updated_at?: string | null }, existingIndex: Map<string, PostIndex>): boolean {
  if (FULL) return true;
  const cached = existingIndex.get(post.id);
  if (!cached) return true;
  if (post.updated_at && cached.updated_at !== post.updated_at) return true;
  if (!existsSync(postPath(post.id))) return true;
  return false;
}

// ── Post sync ──────────────────────────────────────────────────────────────

async function syncPosts(state: SyncState) {
  console.log("\n📄  Syncing posts…");

  const existingIndex = new Map(loadPostIndex().map((p) => [p.id, p]));
  const newIndex: PostIndex[] = [];
  let fetched = 0, skipped = 0;
  let page = 1, totalPages = 1;

  while (page <= totalPages) {
    const url = `${BASE}/publications/${PUB_ID}/posts?order_by=last_updated&per_page=100&page=${page}`;
    console.log(`  → Page ${page}/${totalPages === 1 && page === 1 ? "?" : totalPages}…`);

    const data = (await apiFetch(url)) as {
      data: Array<{
        id: string; title?: string; subtitle?: string; slug?: string;
        status?: string; publish_date?: number; updated_at?: string;
        web_url?: string; email_subject_line?: string;
        authors?: Array<{ name?: string }>;
        content_tags?: Array<{ name?: string }>;
      }>;
      total_results?: number; page?: number; limit?: number;
      pages?: number; total_pages?: number;
    };

    totalPages = data.pages ?? data.total_pages ?? 1;

    let allKnown = true;
    for (const post of data.data) {
      if (needsUpdate(post, existingIndex)) { allKnown = false; break; }
    }

    for (const post of data.data) {
      const published_at = post.publish_date
        ? new Date(post.publish_date * 1000).toISOString() : null;

      const indexEntry: PostIndex = {
        id: post.id,
        title: post.title ?? "",
        subtitle: post.subtitle,
        slug: post.slug ?? "",
        status: post.status ?? "",
        published_at,
        updated_at: post.updated_at ?? null,
        web_url: post.web_url ?? null,
        email_subject: post.email_subject_line ?? null,
        authors: (post.authors ?? []).map((a) => a.name ?? "").filter(Boolean),
        content_tags: (post.content_tags ?? []).map((t) => t.name ?? "").filter(Boolean),
      };
      newIndex.push(indexEntry);

      if (!needsUpdate(post, existingIndex)) { skipped++; continue; }

      // Full post detail with content + stats
      const expandParams = [
        "expand[]=free_web_content",
        "expand[]=free_email_content",
        "expand[]=stats",
      ].join("&");
      let detail: unknown = post;
      try {
        const d = (await apiFetch(`${BASE}/publications/${PUB_ID}/posts/${post.id}?${expandParams}`)) as { data: unknown };
        detail = d?.data ?? post;
      } catch (err) {
        console.warn(`\n    ⚠️  Detail fetch failed for ${post.id}: ${err}`);
      }

      // Clicks (link-level click data)
      let clicks: unknown[] = [];
      try {
        clicks = await fetchAllPages(
          `${BASE}/publications/${PUB_ID}/posts/${post.id}/clicks`,
          `clicks[${post.id}]`
        );
      } catch { /* not all posts have click data */ }

      write(postPath(post.id), {
        ...detail as object,
        _clicks: clicks,
        _index: indexEntry,
        _synced_at: new Date().toISOString(),
      });
      fetched++;
      console.log(`    ✓ ${post.id} — ${post.title}`);
    }

    if (!FULL && allKnown && page > 1) {
      console.log(`  → All posts on page ${page} already up-to-date — stopping.`);
      for (const [id, entry] of existingIndex) {
        if (!newIndex.find((p) => p.id === id)) newIndex.push(entry);
      }
      break;
    }

    page++;
  }

  newIndex.sort((a, b) => {
    const da = a.published_at ? new Date(a.published_at).getTime() : 0;
    const db = b.published_at ? new Date(b.published_at).getTime() : 0;
    return db - da;
  });

  write(resolve(POSTS_DIR, "index.json"), newIndex);
  state.posts = { last_synced_at: new Date().toISOString(), count: newIndex.length };
  console.log(`  ✅ Posts: ${fetched} fetched, ${skipped} skipped, ${newIndex.length} total.`);
}

// ── Subscriber list sync ───────────────────────────────────────────────────

async function syncSubscribers(state: SyncState) {
  console.log("\n👥  Syncing subscribers (list)…");

  const allPath = resolve(SUBS_DIR, "all.jsonl");
  const indexPath = resolve(SUBS_DIR, "index.json");

  type SubIndex = {
    id: string; email: string; status: string; tier: string;
    subscribed_at: string; updated_at: string | null;
  };

  const existingIndex: SubIndex[] = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, "utf8")) : [];
  const indexMap = new Map(existingIndex.map((s) => [s.id, s]));
  const rawLines: string[] = [];

  const total = await fetchAllCursor(
    `${BASE}/publications/${PUB_ID}/subscriptions`,
    "subscribers",
    (items) => {
      for (const sub of items as Array<{
        id: string; email?: string; status?: string;
        subscription_tier?: string; tier?: string;
        created?: string; created_at?: string; updated_at?: string;
        [k: string]: unknown;
      }>) {
        indexMap.set(sub.id, {
          id: sub.id,
          email: sub.email ?? "",
          status: sub.status ?? "",
          tier: sub.subscription_tier ?? sub.tier ?? "free",
          subscribed_at: sub.created ?? sub.created_at ?? "",
          updated_at: sub.updated_at ?? null,
        });
        rawLines.push(JSON.stringify(sub));
      }
    }
  );

  console.log(`\n  → Writing ${total} records…`);
  writeFileSync(allPath, rawLines.join("\n") + (rawLines.length ? "\n" : ""), "utf8");

  const mergedIndex = [...indexMap.values()].sort(
    (a, b) => new Date(b.subscribed_at).getTime() - new Date(a.subscribed_at).getTime()
  );
  write(indexPath, mergedIndex);
  state.subscribers = { last_synced_at: new Date().toISOString(), count: mergedIndex.length };
  console.log(`  ✅ Subscribers: ${total} fetched, ${mergedIndex.length} total.`);
}

// ── Individual subscriber details ──────────────────────────────────────────

async function syncSubscriberDetails(state: SyncState) {
  console.log("\n🔍  Syncing individual subscriber details (custom fields, tags, referrals, stats)…");
  console.log("    This fetches one record per subscriber — may take several minutes.");

  const indexPath = resolve(SUBS_DIR, "index.json");
  if (!existsSync(indexPath)) {
    console.log("  ⚠️  No subscriber index found — run subscriber list sync first.");
    return;
  }

  const index = JSON.parse(readFileSync(indexPath, "utf8")) as Array<{ id: string }>;
  const expandParams = [
    "expand[]=custom_fields",
    "expand[]=tags",
    "expand[]=referrals",
    "expand[]=stats",
  ].join("&");

  let fetched = 0, skipped = 0;

  for (const sub of index) {
    const detailPath = resolve(SUBS_DETAIL_DIR, `${sub.id}.json`);
    if (!FULL && existsSync(detailPath)) { skipped++; continue; }

    process.stdout.write(`  → ${fetched + skipped + 1}/${index.length} — ${sub.id}…\r`);

    try {
      const data = (await apiFetch(
        `${BASE}/publications/${PUB_ID}/subscriptions/${sub.id}?${expandParams}`
      )) as { data: unknown } | null;

      if (data?.data) {
        write(detailPath, { ...data.data as object, _synced_at: new Date().toISOString() });
        fetched++;
      }
    } catch (err) {
      console.warn(`\n    ⚠️  Could not fetch detail for ${sub.id}: ${err}`);
    }
  }

  console.log(`\n  ✅ Subscriber details: ${fetched} fetched, ${skipped} skipped.`);
  state.subscriber_details = { last_synced_at: new Date().toISOString(), count: fetched + skipped };
}

// ── Workspace ──────────────────────────────────────────────────────────────

async function syncWorkspace(_state: SyncState) {
  console.log("\n🏢  Syncing workspace…");
  // Try common workspace endpoint patterns
  const endpoints = [
    `${BASE}/workspace`,
    `${BASE}/publications/${PUB_ID}/workspace`,
  ];
  for (const url of endpoints) {
    try {
      const data = (await apiFetch(url)) as { data: unknown } | null;
      if (data?.data) {
        write(resolve(CACHE, "workspace.json"), { ...data.data as object, _synced_at: new Date().toISOString() });
        console.log("  ✅ Workspace saved.");
        return;
      }
    } catch { /* try next */ }
  }
  console.log("  ℹ️  Workspace endpoint not available.");
}

// ── Publication info + stats ───────────────────────────────────────────────

async function syncPublication(_state: SyncState) {
  console.log("\n📰  Syncing publication info + stats…");
  const data = (await apiFetch(`${BASE}/publications/${PUB_ID}?expand[]=stats`)) as { data: unknown } | null;
  if (data?.data) {
    write(resolve(CACHE, "publication.json"), { ...data.data as object, _synced_at: new Date().toISOString() });
    console.log("  ✅ Publication saved.");
  }
}

// ── Authors ────────────────────────────────────────────────────────────────

async function syncAuthors(_state: SyncState) {
  console.log("\n✍️   Syncing authors…");
  const items = await fetchAllPages(`${BASE}/publications/${PUB_ID}/authors`, "authors");
  write(resolve(CACHE, "authors.json"), { data: items, _synced_at: new Date().toISOString() });
  console.log(`  ✅ Authors: ${items.length} saved.`);
}

// ── Content tags ───────────────────────────────────────────────────────────

async function syncContentTags(_state: SyncState) {
  console.log("\n🏷️   Syncing content tags…");
  const items = await fetchAllPages(`${BASE}/publications/${PUB_ID}/tags`, "tags");
  write(resolve(CACHE, "content-tags.json"), { data: items, _synced_at: new Date().toISOString() });
  console.log(`  ✅ Content tags: ${items.length} saved.`);
}

// ── Custom fields ──────────────────────────────────────────────────────────

async function syncCustomFields(_state: SyncState) {
  console.log("\n🗂️   Syncing custom fields…");
  const items = await fetchAllPages(`${BASE}/publications/${PUB_ID}/custom_fields`, "custom_fields");
  write(resolve(CACHE, "custom-fields.json"), { data: items, _synced_at: new Date().toISOString() });
  console.log(`  ✅ Custom fields: ${items.length} saved.`);
}

// ── Tiers ──────────────────────────────────────────────────────────────────

async function syncTiers(state: SyncState) {
  console.log("\n💎  Syncing tiers…");
  const items = await fetchAllPages(`${BASE}/publications/${PUB_ID}/tiers`, "tiers");
  write(resolve(TIERS_DIR, "index.json"), { data: items, _synced_at: new Date().toISOString() });
  state.tiers = { last_synced_at: new Date().toISOString(), count: items.length };
  console.log(`  ✅ Tiers: ${items.length} saved.`);
}

// ── Referral program ───────────────────────────────────────────────────────

async function syncReferralProgram(_state: SyncState) {
  console.log("\n🔗  Syncing referral program…");
  const data = (await apiFetch(`${BASE}/publications/${PUB_ID}/referral_program`)) as { data: unknown } | null;
  if (data?.data) {
    write(resolve(CACHE, "referral-program.json"), { ...data.data as object, _synced_at: new Date().toISOString() });
    console.log("  ✅ Referral program saved.");
  } else {
    console.log("  ℹ️  No referral program data.");
  }
}

// ── Condition sets ─────────────────────────────────────────────────────────

async function syncConditionSets(_state: SyncState) {
  console.log("\n🔧  Syncing condition sets…");
  try {
    const items = await fetchAllPages(`${BASE}/publications/${PUB_ID}/condition_sets`, "condition_sets");
    write(resolve(CACHE, "condition-sets.json"), { data: items, _synced_at: new Date().toISOString() });
    console.log(`  ✅ Condition sets: ${items.length} saved.`);
  } catch (err) {
    console.log(`  ℹ️  Condition sets not available: ${err}`);
  }
}

// ── Polls ──────────────────────────────────────────────────────────────────

async function syncPolls(state: SyncState) {
  console.log("\n📊  Syncing polls + responses…");
  const polls = await fetchAllPages(`${BASE}/publications/${PUB_ID}/polls`, "polls");

  const index: unknown[] = [];
  let saved = 0;

  for (const poll of polls as Array<{ id: string; [k: string]: unknown }>) {
    index.push({ id: poll.id, question: poll.question });

    let responses: unknown[] = [];
    try {
      responses = await fetchAllPages(
        `${BASE}/publications/${PUB_ID}/polls/${poll.id}/responses`,
        `poll responses`
      );
    } catch { /* ok */ }

    write(resolve(POLLS_DIR, `${poll.id}.json`), {
      ...poll, _responses: responses, _synced_at: new Date().toISOString(),
    });
    saved++;
    console.log(`    ✓ ${poll.id} — ${String(poll.question ?? "(untitled)").slice(0, 60)}`);
  }

  write(resolve(POLLS_DIR, "index.json"), { data: index, _synced_at: new Date().toISOString() });
  state.polls = { last_synced_at: new Date().toISOString(), count: saved };
  console.log(`  ✅ Polls: ${saved} saved.`);
}

// ── Surveys ────────────────────────────────────────────────────────────────

async function syncSurveys(state: SyncState) {
  console.log("\n📋  Syncing surveys + responses…");
  let surveys: unknown[] = [];
  try {
    surveys = await fetchAllPages(`${BASE}/publications/${PUB_ID}/surveys`, "surveys");
  } catch {
    console.log("  ℹ️  Surveys endpoint not available.");
    return;
  }

  const index: unknown[] = [];
  let saved = 0;

  for (const survey of surveys as Array<{ id: string; [k: string]: unknown }>) {
    index.push({ id: survey.id, name: survey.name });

    let responses: unknown[] = [];
    try {
      responses = await fetchAllPages(
        `${BASE}/publications/${PUB_ID}/surveys/${survey.id}/responses`,
        `survey responses`
      );
    } catch { /* ok */ }

    write(resolve(SURVEYS_DIR, `${survey.id}.json`), {
      ...survey, _responses: responses, _synced_at: new Date().toISOString(),
    });
    saved++;
    console.log(`    ✓ ${survey.id} — ${String(survey.name ?? "(untitled)").slice(0, 60)}`);
  }

  write(resolve(SURVEYS_DIR, "index.json"), { data: index, _synced_at: new Date().toISOString() });
  state.surveys = { last_synced_at: new Date().toISOString(), count: saved };
  console.log(`  ✅ Surveys: ${saved} saved.`);
}

// ── Segments ───────────────────────────────────────────────────────────────

async function syncSegments(state: SyncState) {
  console.log("\n🗃️   Syncing segments…");
  try {
    const segments = await fetchAllPages(`${BASE}/publications/${PUB_ID}/segments`, "segments");
    const index: unknown[] = [];

    for (const seg of segments as Array<{ id: string; [k: string]: unknown }>) {
      index.push({ id: seg.id, name: seg.name, total_count: seg.total_count });

      // Fetch subscribers in this segment
      let subscribers: unknown[] = [];
      try {
        subscribers = await fetchAllPages(
          `${BASE}/publications/${PUB_ID}/segments/${seg.id}/subscriptions`,
          `segment[${String(seg.name).slice(0, 20)}] subs`
        );
      } catch { /* ok — not all segments expose subscriptions */ }

      write(resolve(SEGMENTS_DIR, `${seg.id}.json`), {
        ...seg,
        _subscriptions: subscribers,
        _synced_at: new Date().toISOString(),
      });
      console.log(`    ✓ ${seg.id} — ${String(seg.name ?? "").padEnd(30)} (${subscribers.length} subs fetched)`);
    }

    write(resolve(SEGMENTS_DIR, "index.json"), { data: index, _synced_at: new Date().toISOString() });
    state.segments = { last_synced_at: new Date().toISOString(), count: segments.length };
    console.log(`  ✅ Segments: ${segments.length} saved.`);
  } catch (err) {
    console.log(`  ℹ️  Segments not available: ${err}`);
  }
}

// ── Webhooks ───────────────────────────────────────────────────────────────

async function syncWebhooks(_state: SyncState) {
  console.log("\n🪝  Syncing webhooks…");
  try {
    const items = await fetchAllPages(`${BASE}/publications/${PUB_ID}/webhooks`, "webhooks");
    write(resolve(CACHE, "webhooks.json"), { data: items, _synced_at: new Date().toISOString() });
    console.log(`  ✅ Webhooks: ${items.length} saved.`);
  } catch (err) {
    console.log(`  ℹ️  Webhooks not available: ${err}`);
  }
}

// ── Automations + journeys ─────────────────────────────────────────────────

async function syncAutomations(state: SyncState) {
  console.log("\n⚙️   Syncing automations + journeys…");
  let automations: unknown[] = [];
  try {
    automations = await fetchAllPages(`${BASE}/publications/${PUB_ID}/automations`, "automations");
  } catch {
    console.log("  ℹ️  Automations not available.");
    return;
  }

  const index: unknown[] = [];
  let saved = 0;

  for (const auto of automations as Array<{ id: string; [k: string]: unknown }>) {
    index.push({ id: auto.id, name: auto.name, status: auto.status });

    // Fetch full automation detail
    let detail: unknown = auto;
    try {
      const d = (await apiFetch(`${BASE}/publications/${PUB_ID}/automations/${auto.id}`)) as { data: unknown } | null;
      if (d?.data) detail = d.data;
    } catch { /* ok */ }

    // Fetch subscriber journeys for this automation
    let journeys: unknown[] = [];
    try {
      journeys = await fetchAllPages(
        `${BASE}/publications/${PUB_ID}/automations/${auto.id}/journeys`,
        `journeys`
      );
    } catch { /* ok */ }

    // Fetch email steps (content) for this automation
    let emails: unknown[] = [];
    try {
      const emailData = (await apiFetch(
        `${BASE}/publications/${PUB_ID}/automations/${auto.id}/emails`
      )) as { data: unknown[] } | null;
      if (emailData?.data) {
        // Fetch full content for each email step
        for (const email of emailData.data as Array<{ id: string }>) {
          try {
            const detail = (await apiFetch(
              `${BASE}/publications/${PUB_ID}/automations/${auto.id}/emails/${email.id}?expand[]=free_email_content`
            )) as { data: unknown } | null;
            emails.push(detail?.data ?? email);
          } catch {
            emails.push(email);
          }
        }
      }
    } catch { /* ok */ }

    write(resolve(AUTOMATIONS_DIR, `${auto.id}.json`), {
      ...detail as object,
      _emails: emails,
      _journeys: journeys,
      _synced_at: new Date().toISOString(),
    });
    saved++;
    console.log(`    ✓ ${auto.id} — ${String(auto.name ?? "(untitled)")} (${journeys.length} journeys)`);
  }

  write(resolve(AUTOMATIONS_DIR, "index.json"), { data: index, _synced_at: new Date().toISOString() });
  state.automations = { last_synced_at: new Date().toISOString(), count: saved };
  console.log(`  ✅ Automations: ${saved} saved.`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  ensureDirs();
  const state = loadState();

  console.log(`🐝  Beehiiv full backup — pub: ${PUB_ID}`);
  console.log(`  Mode: ${FULL ? "FULL (re-fetching everything)" : "incremental"}`);
  if (NO_SUB_DETAILS) console.log("  --no-sub-details: skipping individual subscriber expansion");

  try {
    if (DO_POSTS) await syncPosts(state);
    if (DO_SUBS) {
      await syncSubscribers(state);
      if (!NO_SUB_DETAILS) await syncSubscriberDetails(state);
    }

    if (DO_ALL) {
      await syncWorkspace(state);
      await syncPublication(state);
      await syncAuthors(state);
      await syncContentTags(state);
      await syncCustomFields(state);
      await syncTiers(state);
      await syncReferralProgram(state);
      await syncConditionSets(state);
      await syncPolls(state);
      await syncSurveys(state);
      await syncAutomations(state);
      await syncSegments(state);
      await syncWebhooks(state);
      state.misc = { last_synced_at: new Date().toISOString() };
    }
  } finally {
    saveState(state);
  }

  console.log("\n✅  Backup complete. State saved to", STATE_PATH);
}

main().catch((err) => {
  console.error("\n❌  Backup failed:", err);
  process.exit(1);
});
