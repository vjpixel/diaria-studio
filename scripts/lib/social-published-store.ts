/**
 * Atomic read-modify-write for 06-social-published.json (#758).
 * Uses a .lock file to prevent race conditions when LinkedIn (agent) and
 * Facebook (script) publish in parallel.
 */

import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync, renameSync, existsSync } from "node:fs";

// Lock acquisition: exclusive file create (atomic on all major filesystems)
function acquireLock(lockPath: string, timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = openSync(lockPath, "wx"); // O_WRONLY | O_CREAT | O_EXCL — fails if exists
      closeSync(fd);
      return; // Lock acquired
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`[social-published-store] lock timeout after ${timeoutMs}ms: ${lockPath}`);
      }
      // Spin wait — 50ms intervals
      const end = Date.now() + 50;
      while (Date.now() < end) { /* busy wait */ }
    }
  }
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

/**
 * Entrada canônica de post social na pipeline (#650 Tier C).
 *
 * Status union inclui `"published"` pra cobrir verify-facebook-posts (que
 * promove status quando descobre que post agendado já foi enviado pelo
 * Facebook). Campos platform-específicos (`fb_post_id`, `make_request_id`,
 * `published_at`, `failure_reason`) entram via escape hatch
 * `[key: string]: unknown` — caller pode usar Pick<> ou cast pra subset.
 */
export interface PostEntry {
  platform: string;
  destaque: string;
  url: string | null;
  status: "draft" | "scheduled" | "failed" | "published";
  scheduled_at: string | null;
  reason?: string;
  /** Campos platform-specific (fb_post_id, make_request_id, published_at,
   *  failure_reason, etc.) entram via escape hatch. */
  [key: string]: unknown;
}

export interface SocialPublished {
  posts: PostEntry[];
}

/**
 * Atomically appends one or more posts to 06-social-published.json.
 * Uses a .lock file to serialize concurrent writes from parallel publishers.
 *
 * @param publishedPath  Absolute path to 06-social-published.json
 * @param posts          Posts to append (platform+destaque uniqueness enforced)
 */
export function appendSocialPosts(publishedPath: string, posts: PostEntry[]): void {
  if (posts.length === 0) return;
  const lockPath = publishedPath + ".lock";

  acquireLock(lockPath);
  try {
    const current: SocialPublished = existsSync(publishedPath)
      ? JSON.parse(readFileSync(publishedPath, "utf8"))
      : { posts: [] };

    for (const post of posts) {
      // Upsert: replace existing entry with same platform+destaque, or append
      const idx = current.posts.findIndex(
        (p) => p.platform === post.platform && p.destaque === post.destaque,
      );
      if (idx >= 0) {
        current.posts[idx] = post;
      } else {
        current.posts.push(post);
      }
    }

    const tmpPath = publishedPath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(current, null, 2) + "\n", "utf8");
    renameSync(tmpPath, publishedPath);
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Reads the current state of 06-social-published.json under lock.
 * Use this instead of a plain readFileSync when you also intend to write.
 */
export function readSocialPublished(publishedPath: string): SocialPublished {
  if (!existsSync(publishedPath)) return { posts: [] };
  return JSON.parse(readFileSync(publishedPath, "utf8"));
}
