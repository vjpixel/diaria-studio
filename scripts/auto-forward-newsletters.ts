/**
 * auto-forward-newsletters.ts
 *
 * Reads pre-fetched Gmail thread data (JSON), extracts URLs from newsletter
 * bodies, and appends structured entries to `data/inbox.md`. Tracks processed
 * thread IDs in a cursor file for idempotency.
 *
 * This script does NOT call Gmail directly -- the orchestrator (Stage 0)
 * fetches threads via Gmail MCP and passes them as a JSON file.
 *
 * Usage:
 *   npx tsx scripts/auto-forward-newsletters.ts \
 *     --threads <path-to-threads.json> \
 *     --inbox-md data/inbox.md \
 *     --cursor data/newsletter-capture-cursor.json
 *
 * Input threads.json: array of
 *   { thread_id, sender, subject, date, body }
 *
 * Output (stdout): JSON summary
 *   { processed, skipped_already, appended, urls_extracted }
 *
 * Senders config: read from platform.config.json > newsletter_auto_capture.senders
 * (optional -- if absent, all threads in the input are processed).
 *
 * Fixes #1514
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractUrls } from "./lib/url-utils.ts";
// #2834: stripHtml consolidado em lib/strip-html.ts (era byte-idêntico ao
// de capture-newsletter-urls.ts). Reexportado aqui pra não quebrar imports
// existentes deste módulo (incl. test/auto-forward-newsletters.test.ts).
import { stripHtml } from "./lib/strip-html.ts";
export { stripHtml };

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
  appended: number;
  urls_extracted: number;
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
// Core processing (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Process a list of captured threads against a cursor, producing inbox.md
 * formatted entries and an updated cursor.
 *
 * Pure function -- no I/O side effects.
 */
export function processThreads(
  threads: CapturedThread[],
  cursor: CapturedCursor,
): { entries: string[]; result: CaptureResult; newCursor: CapturedCursor } {
  const processedSet = new Set(cursor.processed_thread_ids);
  const entries: string[] = [];
  let skippedAlready = 0;
  let totalUrls = 0;

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

    // Build inbox.md entry
    const lines: string[] = [
      `## ${thread.subject}`,
      `- **from:** ${thread.sender}`,
      `- **date:** ${thread.date}`,
      `- **via:** auto-capture`,
      "",
    ];

    if (urls.length > 0) {
      for (const u of urls) lines.push(`  - ${u}`);
      lines.push("");
    }

    // Add body excerpt (first 500 chars of plain text)
    const excerpt = plainText.slice(0, 500).replace(/\n+/g, " ").trim();
    if (excerpt) {
      lines.push(excerpt);
      lines.push("");
    }

    entries.push(lines.join("\n"));
    processedSet.add(thread.thread_id);
  }

  return {
    entries,
    result: {
      processed: threads.length,
      skipped_already: skippedAlready,
      appended: entries.length,
      urls_extracted: totalUrls,
    },
    newCursor: {
      processed_thread_ids: [...processedSet],
    },
  };
}

// ---------------------------------------------------------------------------
// Inbox.md append (mirrors inbox-drain.ts pattern)
// ---------------------------------------------------------------------------

export function appendToInbox(inboxPath: string, entries: string[]): void {
  if (entries.length === 0) return;

  if (!existsSync(inboxPath)) {
    mkdirSync(dirname(inboxPath), { recursive: true });
    writeFileSync(
      inboxPath,
      "# Inbox Editorial — Diar.ia\n\n<!-- entries abaixo -->\n",
      "utf8",
    );
  }

  const current = readFileSync(inboxPath, "utf8");
  const MARKER = "<!-- entries abaixo -->";
  const markerIdx = current.indexOf(MARKER);

  let newContent: string;
  if (markerIdx === -1) {
    newContent = current + "\n" + entries.join("\n");
  } else {
    const before = current.slice(0, markerIdx + MARKER.length);
    const after = current.slice(markerIdx + MARKER.length);
    newContent = before + "\n" + entries.join("\n") + after;
  }

  // Atomic write via tmpfile + rename
  const tmpPath = inboxPath + ".tmp";
  writeFileSync(tmpPath, newContent, "utf8");
  renameSync(tmpPath, inboxPath);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  threadsPath: string;
  inboxMdPath: string;
  cursorPath: string;
} {
  let threadsPath = "";
  let inboxMdPath = resolve(ROOT, "data", "inbox.md");
  let cursorPath = resolve(ROOT, "data", "newsletter-capture-cursor.json");

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--threads":
        threadsPath = argv[++i] ?? "";
        break;
      case "--inbox-md":
        inboxMdPath = argv[++i] ?? inboxMdPath;
        break;
      case "--cursor":
        cursorPath = argv[++i] ?? cursorPath;
        break;
    }
  }

  if (!threadsPath) {
    console.error("Usage: npx tsx scripts/auto-forward-newsletters.ts --threads <path>");
    process.exit(1);
  }

  return { threadsPath, inboxMdPath, cursorPath };
}

export function main(argv: string[] = process.argv): void {
  const { threadsPath, inboxMdPath, cursorPath } = parseArgs(argv);

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

  // Empty array = no-op
  if (threads.length === 0) {
    const result: CaptureResult = { processed: 0, skipped_already: 0, appended: 0, urls_extracted: 0 };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Load cursor
  const cursor = loadCursor(cursorPath);

  // Process
  const { entries, result, newCursor } = processThreads(threads, cursor);

  // Append to inbox.md
  appendToInbox(inboxMdPath, entries);

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
