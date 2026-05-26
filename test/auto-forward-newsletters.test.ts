import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  loadCursor,
  saveCursor,
  processThreads,
  appendToInbox,
  stripHtml,
  main,
} from "../scripts/auto-forward-newsletters.ts";
import type {
  CapturedThread,
  CapturedCursor,
} from "../scripts/auto-forward-newsletters.ts";

const TMP_DIR = resolve(import.meta.dirname, ".tmp-auto-fwd-test");

function tmpFile(name: string): string {
  return resolve(TMP_DIR, name);
}

function makeThread(overrides: Partial<CapturedThread> = {}): CapturedThread {
  return {
    thread_id: "t1",
    sender: "email@newsletter.7min.ai",
    subject: "7 Minutes in AI - Issue 42",
    date: "2026-05-25T10:00:00Z",
    body: "Check out https://openai.com/blog/gpt-5 and https://anthropic.com/news for the latest.",
    ...overrides,
  };
}

describe("processThreads — core logic", () => {
  it("processes new threads and returns entries + updated cursor", () => {
    const threads = [makeThread()];
    const cursor: CapturedCursor = { processed_thread_ids: [] };

    const { entries, result, newCursor } = processThreads(threads, cursor);

    assert.equal(result.processed, 1);
    assert.equal(result.skipped_already, 0);
    assert.equal(result.appended, 1);
    assert.ok(result.urls_extracted >= 2, `expected >=2 urls, got ${result.urls_extracted}`);

    // Entry format check
    assert.ok(entries[0].includes("## 7 Minutes in AI - Issue 42"));
    assert.ok(entries[0].includes("**from:** email@newsletter.7min.ai"));
    assert.ok(entries[0].includes("**via:** auto-capture"));
    assert.ok(entries[0].includes("https://openai.com/blog/gpt-5"));

    // Cursor updated
    assert.ok(newCursor.processed_thread_ids.includes("t1"));
  });

  it("skips already-processed threads (cursor check)", () => {
    const threads = [makeThread({ thread_id: "t1" }), makeThread({ thread_id: "t2" })];
    const cursor: CapturedCursor = { processed_thread_ids: ["t1"] };

    const { result, newCursor } = processThreads(threads, cursor);

    assert.equal(result.processed, 2);
    assert.equal(result.skipped_already, 1);
    assert.equal(result.appended, 1);
    assert.ok(newCursor.processed_thread_ids.includes("t1"));
    assert.ok(newCursor.processed_thread_ids.includes("t2"));
  });

  it("empty threads array produces no-op result", () => {
    const cursor: CapturedCursor = { processed_thread_ids: ["old"] };

    const { entries, result, newCursor } = processThreads([], cursor);

    assert.equal(entries.length, 0);
    assert.equal(result.processed, 0);
    assert.equal(result.skipped_already, 0);
    assert.equal(result.appended, 0);
    assert.equal(result.urls_extracted, 0);
    // Cursor preserved
    assert.ok(newCursor.processed_thread_ids.includes("old"));
  });

  it("extracts URLs from HTML body", () => {
    const htmlBody = `
      <div>
        <p>Top AI news this week:</p>
        <a href="https://deepmind.google/research/paper1">DeepMind Paper</a>
        <a href="https://huggingface.co/blog/transformers">HF Blog</a>
        <p>Also see https://arxiv.org/abs/2501.12345 for details.</p>
      </div>
    `;
    const threads = [makeThread({ thread_id: "html1", body: htmlBody })];
    const cursor: CapturedCursor = { processed_thread_ids: [] };

    const { result } = processThreads(threads, cursor);

    assert.equal(result.appended, 1);
    assert.ok(result.urls_extracted >= 3, `expected >=3 urls from HTML, got ${result.urls_extracted}`);
  });

  it("handles thread with no URLs gracefully", () => {
    const threads = [
      makeThread({ thread_id: "nourls", body: "This is a plain text newsletter with no links at all." }),
    ];
    const cursor: CapturedCursor = { processed_thread_ids: [] };

    const { entries, result } = processThreads(threads, cursor);

    assert.equal(result.appended, 1);
    assert.equal(result.urls_extracted, 0);
    // Still appends the entry with the body excerpt
    assert.ok(entries[0].includes("plain text newsletter"));
  });
});

describe("stripHtml — HTML to plain text", () => {
  it("strips simple tags", () => {
    assert.equal(stripHtml("<b>bold</b> text"), "bold text");
  });

  it("preserves href URLs from anchor tags", () => {
    const html = '<a href="https://example.com">click</a>';
    const text = stripHtml(html);
    assert.ok(text.includes("https://example.com"));
  });

  it("converts br/p/div to newlines", () => {
    const html = "line1<br>line2<br/>line3</p>line4</div>";
    const text = stripHtml(html);
    assert.ok(text.includes("line1\nline2\nline3\nline4"));
  });

  it("decodes common HTML entities", () => {
    assert.ok(stripHtml("a &amp; b").includes("a & b"));
    assert.ok(stripHtml("&lt;tag&gt;").includes("<tag>"));
  });
});

describe("cursor persistence", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("loadCursor returns empty array when file does not exist", () => {
    const cursor = loadCursor(tmpFile("nonexistent.json"));
    assert.deepEqual(cursor.processed_thread_ids, []);
  });

  it("loadCursor returns empty array on malformed JSON", () => {
    writeFileSync(tmpFile("bad.json"), "not json", "utf8");
    const cursor = loadCursor(tmpFile("bad.json"));
    assert.deepEqual(cursor.processed_thread_ids, []);
  });

  it("saveCursor + loadCursor round-trip", () => {
    const path = tmpFile("cursor.json");
    const cursor: CapturedCursor = { processed_thread_ids: ["a", "b", "c"] };
    saveCursor(path, cursor);
    const loaded = loadCursor(path);
    assert.deepEqual(loaded.processed_thread_ids, ["a", "b", "c"]);
  });
});

describe("appendToInbox", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("creates inbox.md if it does not exist", () => {
    const path = tmpFile("inbox.md");
    appendToInbox(path, ["## Test Entry\n- **from:** test\n"]);
    assert.ok(existsSync(path));
    const content = readFileSync(path, "utf8");
    assert.ok(content.includes("## Test Entry"));
    assert.ok(content.includes("<!-- entries abaixo -->"));
  });

  it("appends after marker in existing file", () => {
    const path = tmpFile("inbox.md");
    writeFileSync(path, "# Inbox\n\n<!-- entries abaixo -->\n## Old Entry\n", "utf8");
    appendToInbox(path, ["## New Entry\n- **from:** new\n"]);
    const content = readFileSync(path, "utf8");
    assert.ok(content.includes("## New Entry"));
    assert.ok(content.includes("## Old Entry"));
    // New entry should be between marker and old entry
    const markerIdx = content.indexOf("<!-- entries abaixo -->");
    const newIdx = content.indexOf("## New Entry");
    const oldIdx = content.indexOf("## Old Entry");
    assert.ok(newIdx > markerIdx, "new entry should be after marker");
    assert.ok(newIdx < oldIdx, "new entry should be before old entry");
  });

  it("no-op when entries array is empty", () => {
    const path = tmpFile("inbox-noop.md");
    appendToInbox(path, []);
    assert.ok(!existsSync(path), "should not create file for empty entries");
  });
});

describe("main() CLI integration", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("processes threads file and outputs JSON summary", () => {
    const threadsPath = tmpFile("threads.json");
    const inboxPath = tmpFile("inbox.md");
    const cursorPath = tmpFile("cursor.json");

    writeFileSync(threadsPath, JSON.stringify([makeThread()]), "utf8");

    // Capture stdout
    const captured: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: any) => {
      if (typeof chunk === "string") captured.push(chunk);
      return true;
    };

    try {
      main([
        "node", "script.ts",
        "--threads", threadsPath,
        "--inbox-md", inboxPath,
        "--cursor", cursorPath,
      ]);
    } finally {
      process.stdout.write = origWrite;
    }

    const output = JSON.parse(captured.join(""));
    assert.equal(output.processed, 1);
    assert.equal(output.appended, 1);
    assert.ok(output.urls_extracted >= 2);

    // inbox.md written
    assert.ok(existsSync(inboxPath));
    const content = readFileSync(inboxPath, "utf8");
    assert.ok(content.includes("https://openai.com/blog/gpt-5"));

    // cursor updated
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8"));
    assert.ok(cursor.processed_thread_ids.includes("t1"));
  });

  it("re-running with same threads is idempotent", () => {
    const threadsPath = tmpFile("threads2.json");
    const inboxPath = tmpFile("inbox2.md");
    const cursorPath = tmpFile("cursor2.json");

    writeFileSync(threadsPath, JSON.stringify([makeThread()]), "utf8");

    const run = () => {
      const captured: string[] = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: any) => {
        if (typeof chunk === "string") captured.push(chunk);
        return true;
      };
      try {
        main([
          "node", "script.ts",
          "--threads", threadsPath,
          "--inbox-md", inboxPath,
          "--cursor", cursorPath,
        ]);
      } finally {
        process.stdout.write = origWrite;
      }
      return JSON.parse(captured.join(""));
    };

    const first = run();
    assert.equal(first.appended, 1);

    const second = run();
    assert.equal(second.appended, 0);
    assert.equal(second.skipped_already, 1);

    // inbox.md should have only one entry, not two
    const content = readFileSync(inboxPath, "utf8");
    const matches = content.match(/## 7 Minutes in AI/g);
    assert.equal(matches?.length, 1, "should not duplicate entry on re-run");
  });

  it("empty threads array produces no-op JSON", () => {
    const threadsPath = tmpFile("empty.json");
    writeFileSync(threadsPath, "[]", "utf8");

    const captured: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: any) => {
      if (typeof chunk === "string") captured.push(chunk);
      return true;
    };
    try {
      main([
        "node", "script.ts",
        "--threads", threadsPath,
        "--inbox-md", tmpFile("inbox-empty.md"),
        "--cursor", tmpFile("cursor-empty.json"),
      ]);
    } finally {
      process.stdout.write = origWrite;
    }

    const output = JSON.parse(captured.join(""));
    assert.equal(output.processed, 0);
    assert.equal(output.appended, 0);
  });
});
