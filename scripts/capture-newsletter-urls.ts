/**
 * capture-newsletter-urls.ts (#1520)
 *
 * Reads pre-fetched Gmail thread data (JSON), extracts URLs from newsletter
 * bodies, applies newsletter URL filtering (tracking, affiliate, sender-domain),
 * and writes SyntheticInboxArticle[] JSON directly to
 * `_internal/captured-newsletter-articles.json`.
 *
 * Eliminates the inbox.md intermediary for newsletters — URLs go straight
 * into a JSON array that inject-inbox-urls.ts merges into the article pool.
 *
 * This script does NOT call Gmail directly -- the orchestrator (Stage 0)
 * fetches threads via Gmail MCP and passes them as a JSON file.
 *
 * Usage:
 *   npx tsx scripts/capture-newsletter-urls.ts \
 *     --threads <path-to-threads.json> \
 *     --out <path-to-output.json> \
 *     --cursor data/newsletter-capture-cursor.json
 *
 * Input threads.json: array of
 *   { thread_id, sender, subject, date, body }
 *
 * Output (stdout): JSON summary
 *   { processed, skipped_already, articles_produced, urls_extracted, urls_filtered }
 *
 * Senders config: read from platform.config.json > newsletter_auto_capture.senders
 * (optional -- if absent, all threads in the input are processed).
 *
 * Refactored from auto-forward-newsletters.ts — #1514 origin, #1520 refactor.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractUrls, canonicalize } from "./lib/url-utils.ts";
import {
  isTrackingUrl,
  decodeTrackerUrl,
  isSenderOwnUrl,
  isAffiliateUrl,
  senderDomain,
} from "./inject-inbox-urls.ts";
import type { SyntheticInboxArticle } from "./inject-inbox-urls.ts";

const ROOT = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CapturedThread {
  thread_id: string;
  sender: string;
  subject: string;
  date: string; // ISO date string
  body: string; // plain text or HTML body
}

export interface CapturedCursor {
  processed_thread_ids: string[];
}

export interface CaptureResult {
  processed: number;
  skipped_already: number;
  articles_produced: number;
  urls_extracted: number;
  urls_filtered: number;
}

// ---------------------------------------------------------------------------
// Cursor helpers (exported for testing)
// ---------------------------------------------------------------------------

export function loadCursor(cursorPath: string): CapturedCursor {
  if (!existsSync(cursorPath)) return { processed_thread_ids: [] };
  try {
    const data = JSON.parse(readFileSync(cursorPath, "utf8")) as CapturedCursor;
    if (!Array.isArray(data.processed_thread_ids)) {
      return { processed_thread_ids: [] };
    }
    return data;
  } catch {
    return { processed_thread_ids: [] };
  }
}

export function saveCursor(cursorPath: string, cursor: CapturedCursor): void {
  mkdirSync(dirname(cursorPath), { recursive: true });
  const tmpPath = cursorPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(cursor, null, 2), "utf8");
  renameSync(tmpPath, cursorPath);
}

// ---------------------------------------------------------------------------
// HTML stripping (lightweight, no external deps)
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags to extract readable text. Preserves href attribute values
 * as inline text so URL extraction still works on HTML bodies.
 */
export function stripHtml(html: string): string {
  // Replace <a href="..."> with the URL followed by a space
  let text = html.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>/gi, "$1 ");
  // Replace <br>, <p>, <div> closings with newlines
  text = text.replace(/<\/(p|div|tr|li)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse multiple spaces/newlines
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// ---------------------------------------------------------------------------
// Core processing (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Process a list of captured threads against a cursor, producing
 * SyntheticInboxArticle[] with newsletter URL filtering applied.
 *
 * Pure function -- no I/O side effects.
 */
export function processThreads(
  threads: CapturedThread[],
  cursor: CapturedCursor,
): { articles: SyntheticInboxArticle[]; result: CaptureResult; newCursor: CapturedCursor } {
  const processedSet = new Set(cursor.processed_thread_ids);
  const articles: SyntheticInboxArticle[] = [];
  const seen = new Set<string>();
  let skippedAlready = 0;
  let totalUrls = 0;
  let totalFiltered = 0;

  for (const thread of threads) {
    if (processedSet.has(thread.thread_id)) {
      skippedAlready++;
      continue;
    }

    // Extract text from body (handle HTML)
    const isHtml = /<[a-z][\s\S]*>/i.test(thread.body);
    const plainText = isHtml ? stripHtml(thread.body) : thread.body;
    const urls = extractUrls(plainText);
    totalUrls += urls.length;

    // Derive sender metadata for filtering
    const senderDom = senderDomain(thread.sender);
    const senderLabel = (thread.sender.match(/^([^<]+?)\s*</)?.[1] ?? senderDom).trim() || "newsletter";
    const senderBrand = senderLabel.replace(/[^a-z0-9]/gi, "").toLowerCase();

    for (const rawUrl of urls) {
      // Decode tracker URLs before filtering
      const { url, decoded: trackerDecoded } = decodeTrackerUrl(rawUrl);

      // Apply filters: tracking, affiliate, sender-own
      if (!trackerDecoded && isTrackingUrl(rawUrl)) {
        totalFiltered++;
        continue;
      }
      if (isAffiliateUrl(url)) {
        totalFiltered++;
        continue;
      }
      if (isSenderOwnUrl(url, senderDom, senderBrand)) {
        totalFiltered++;
        continue;
      }

      // Dedup by canonical URL
      const key = canonicalize(url).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      articles.push({
        url,
        source: `inbox_newsletter:${senderLabel}`,
        title: `(newsletter:${senderLabel})`,
        flag: "newsletter_extracted",
        submitted_at: thread.date,
        submitted_subject: thread.subject,
        submitted_via: `newsletter:${senderLabel}`,
        tracker_decoded: trackerDecoded || undefined,
      });
    }

    processedSet.add(thread.thread_id);
  }

  return {
    articles,
    result: {
      processed: threads.length,
      skipped_already: skippedAlready,
      articles_produced: articles.length,
      urls_extracted: totalUrls,
      urls_filtered: totalFiltered,
    },
    newCursor: {
      processed_thread_ids: [...processedSet],
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  threadsPath: string;
  outPath: string;
  cursorPath: string;
} {
  let threadsPath = "";
  let outPath = "";
  let cursorPath = resolve(ROOT, "data", "newsletter-capture-cursor.json");

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--threads":
        threadsPath = argv[++i] ?? "";
        break;
      case "--out":
        outPath = argv[++i] ?? "";
        break;
      case "--cursor":
        cursorPath = argv[++i] ?? cursorPath;
        break;
    }
  }

  if (!threadsPath || !outPath) {
    console.error("Usage: npx tsx scripts/capture-newsletter-urls.ts --threads <path> --out <path>");
    process.exit(1);
  }

  return { threadsPath, outPath, cursorPath };
}

export function main(argv: string[] = process.argv): void {
  const { threadsPath, outPath, cursorPath } = parseArgs(argv);

  // Read threads
  if (!existsSync(threadsPath)) {
    console.error(`Threads file not found: ${threadsPath}`);
    process.exit(1);
  }

  let threads: CapturedThread[];
  try {
    const raw = JSON.parse(readFileSync(threadsPath, "utf8"));
    if (!Array.isArray(raw)) {
      console.error("Threads file must contain a JSON array");
      process.exit(1);
    }
    threads = raw as CapturedThread[];
  } catch (err) {
    console.error(`Failed to parse threads file: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Empty array = no-op (preserve existing output if any)
  if (threads.length === 0) {
    const result: CaptureResult = { processed: 0, skipped_already: 0, articles_produced: 0, urls_extracted: 0, urls_filtered: 0 };
    const absOut = resolve(ROOT, outPath);
    if (!existsSync(absOut)) {
      mkdirSync(dirname(absOut), { recursive: true });
      const tmpOut = absOut + ".tmp";
      writeFileSync(tmpOut, JSON.stringify([], null, 2) + "\n", "utf8");
      renameSync(tmpOut, absOut);
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Load cursor
  const cursor = loadCursor(cursorPath);

  // Process
  const { articles, result, newCursor } = processThreads(threads, cursor);

  // Merge with existing output (crash-resume safety: re-run preserves prior articles)
  const absOut = resolve(ROOT, outPath);
  mkdirSync(dirname(absOut), { recursive: true });
  let existing: SyntheticInboxArticle[] = [];
  if (existsSync(absOut)) {
    try {
      existing = JSON.parse(readFileSync(absOut, "utf8"));
    } catch { /* corrupt file — overwrite */ }
  }
  const existingUrls = new Set(existing.map((a) => a.url));
  const merged = [...existing, ...articles.filter((a) => !existingUrls.has(a.url))];
  const tmpOut = absOut + ".tmp";
  writeFileSync(tmpOut, JSON.stringify(merged, null, 2) + "\n", "utf8");
  renameSync(tmpOut, absOut);

  // Save cursor
  saveCursor(cursorPath, newCursor);

  // Print summary
  console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
