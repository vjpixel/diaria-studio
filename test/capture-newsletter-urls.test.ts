import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  loadCursor,
  saveCursor,
  processThreads,
  stripHtml,
  main,
  loadAlwaysConsiderConfig,
} from "../scripts/capture-newsletter-urls.ts";
import type {
  CapturedThread,
  CapturedCursor,
} from "../scripts/capture-newsletter-urls.ts";

const TMP_DIR = resolve(import.meta.dirname, ".tmp-capture-newsletter-test");

function tmpFile(name: string): string {
  return resolve(TMP_DIR, name);
}

function makeThread(overrides: Partial<CapturedThread> = {}): CapturedThread {
  return {
    thread_id: "t1",
    sender: "AI Roundup <airoundup@mail.beehiiv.com>",
    subject: "AI Roundup - Issue 42",
    date: "2026-05-25T10:00:00Z",
    body: "Check out https://openai.com/blog/gpt-5 and https://anthropic.com/news for the latest.",
    ...overrides,
  };
}

describe("processThreads — core logic", () => {
  it("processes new threads and returns articles + updated cursor", () => {
    const threads = [makeThread()];
    const cursor: CapturedCursor = { processed_thread_ids: [] };

    const { articles, result, newCursor } = processThreads(threads, cursor);

    assert.equal(result.processed, 1);
    assert.equal(result.skipped_already, 0);
    assert.ok(result.articles_produced >= 2, `expected >=2 articles, got ${result.articles_produced}`);
    assert.ok(result.urls_extracted >= 2, `expected >=2 urls, got ${result.urls_extracted}`);

    // Article format check
    assert.ok(articles.some(a => a.url.includes("openai.com")));
    assert.ok(articles.every(a => a.flag === "newsletter_extracted"));
    assert.ok(articles.every(a => a.source.startsWith("inbox_newsletter:")));
    assert.ok(articles.every(a => a.submitted_at === "2026-05-25T10:00:00Z"));

    // Cursor updated
    assert.ok(newCursor.processed_thread_ids.includes("t1"));
  });

  it("skips already-processed threads (cursor check)", () => {
    const threads = [makeThread({ thread_id: "t1" }), makeThread({ thread_id: "t2" })];
    const cursor: CapturedCursor = { processed_thread_ids: ["t1"] };

    const { result, newCursor } = processThreads(threads, cursor);

    assert.equal(result.processed, 2);
    assert.equal(result.skipped_already, 1);
    assert.ok(newCursor.processed_thread_ids.includes("t1"));
    assert.ok(newCursor.processed_thread_ids.includes("t2"));
  });

  it("empty threads array produces no-op result", () => {
    const cursor: CapturedCursor = { processed_thread_ids: ["old"] };

    const { articles, result, newCursor } = processThreads([], cursor);

    assert.equal(articles.length, 0);
    assert.equal(result.processed, 0);
    assert.equal(result.skipped_already, 0);
    assert.equal(result.articles_produced, 0);
    assert.equal(result.urls_extracted, 0);
    assert.equal(result.urls_filtered, 0);
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

    assert.ok(result.urls_extracted >= 3, `expected >=3 urls from HTML, got ${result.urls_extracted}`);
  });

  it("handles thread with no URLs gracefully", () => {
    const threads = [
      makeThread({ thread_id: "nourls", body: "This is a plain text newsletter with no links at all." }),
    ];
    const cursor: CapturedCursor = { processed_thread_ids: [] };

    const { articles, result } = processThreads(threads, cursor);

    assert.equal(result.articles_produced, 0);
    assert.equal(result.urls_extracted, 0);
    assert.equal(articles.length, 0);
  });

  it("filters tracking URLs", () => {
    const threads = [
      makeThread({
        thread_id: "tracking1",
        body: "Click here: https://link.mail.beehiiv.com/v1/c/abc and https://techcrunch.com/real-article",
      }),
    ];
    const cursor: CapturedCursor = { processed_thread_ids: [] };

    const { articles, result } = processThreads(threads, cursor);

    assert.equal(articles.length, 1);
    assert.ok(articles[0].url.includes("techcrunch.com"));
    assert.ok(result.urls_filtered >= 1);
  });

  it("filters affiliate URLs", () => {
    const threads = [
      makeThread({
        thread_id: "affiliate1",
        body: "Sponsored: https://offers.hubspot.com/chatgpt and real: https://bbc.com/news/article",
      }),
    ];
    const cursor: CapturedCursor = { processed_thread_ids: [] };

    const { articles, result } = processThreads(threads, cursor);

    assert.equal(articles.length, 1);
    assert.ok(articles[0].url.includes("bbc.com"));
    assert.ok(result.urls_filtered >= 1);
  });

  it("filters sender own-domain URLs (auto-promo)", () => {
    const threads = [
      makeThread({
        thread_id: "selfpromo1",
        sender: "Cyberman <cyberman@mail.beehiiv.com>",
        body: "Subscribe at https://www.cyberman.ai/subscribe and read https://techcrunch.com/article-1",
      }),
    ];
    const cursor: CapturedCursor = { processed_thread_ids: [] };

    const { articles, result } = processThreads(threads, cursor);

    assert.equal(articles.length, 1);
    assert.ok(articles[0].url.includes("techcrunch.com"));
    assert.ok(result.urls_filtered >= 1);
  });

  it("#4280: não captura sufixo de lixo ')_==_' colado nos params de tracking", () => {
    const threads = [
      makeThread({
        thread_id: "garbage-suffix",
        body:
          "Veja https://platform.claude.com/prompting-claude-opus-5?utm_source=diaria&_bhlid=abc123)_==_ para mais.",
      }),
    ];
    const cursor: CapturedCursor = { processed_thread_ids: [] };

    const { articles } = processThreads(threads, cursor);

    assert.equal(articles.length, 1);
    assert.equal(
      articles[0].url,
      "https://platform.claude.com/prompting-claude-opus-5?utm_source=diaria&_bhlid=abc123",
    );
    assert.ok(!articles[0].url.endsWith(")_==_"), `sufixo de lixo vazou: ${articles[0].url}`);
  });

  it("deduplicates URLs across threads by canonical form", () => {
    const threads = [
      makeThread({
        thread_id: "dedup1",
        body: "https://example.com/article?utm_source=twitter",
      }),
      makeThread({
        thread_id: "dedup2",
        body: "https://example.com/article?utm_medium=email",
      }),
    ];
    const cursor: CapturedCursor = { processed_thread_ids: [] };

    const { articles } = processThreads(threads, cursor);

    assert.equal(articles.length, 1, "UTM variants should collapse to 1 article");
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

describe("main() CLI integration", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("processes threads file and outputs JSON articles + summary", () => {
    const threadsPath = tmpFile("threads.json");
    const outPath = tmpFile("articles.json");
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
        "--out", outPath,
        "--cursor", cursorPath,
      ]);
    } finally {
      process.stdout.write = origWrite;
    }

    const output = JSON.parse(captured.join(""));
    assert.equal(output.processed, 1);
    assert.ok(output.articles_produced >= 2);
    assert.ok(output.urls_extracted >= 2);

    // articles.json written
    assert.ok(existsSync(outPath));
    const articles = JSON.parse(readFileSync(outPath, "utf8"));
    assert.ok(Array.isArray(articles));
    assert.ok(articles.length >= 2);
    assert.ok(articles.some((a: any) => a.url.includes("openai.com")));
    assert.ok(articles.every((a: any) => a.flag === "newsletter_extracted"));

    // cursor updated
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8"));
    assert.ok(cursor.processed_thread_ids.includes("t1"));
  });

  it("re-running with same threads is idempotent", () => {
    const threadsPath = tmpFile("threads2.json");
    const outPath = tmpFile("articles2.json");
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
          "--out", outPath,
          "--cursor", cursorPath,
        ]);
      } finally {
        process.stdout.write = origWrite;
      }
      return JSON.parse(captured.join(""));
    };

    const first = run();
    assert.ok(first.articles_produced >= 2);

    const firstArticles = JSON.parse(readFileSync(outPath, "utf8"));
    assert.ok(firstArticles.length >= 2, "first run produced articles");

    const second = run();
    assert.equal(second.articles_produced, 0);
    assert.equal(second.skipped_already, 1);

    // articles.json should PRESERVE first run's articles (crash-resume safety)
    const articles = JSON.parse(readFileSync(outPath, "utf8"));
    assert.ok(Array.isArray(articles));
    assert.equal(articles.length, firstArticles.length, "second run preserves prior articles");
  });

  it("empty threads array produces no-op JSON and empty output file", () => {
    const threadsPath = tmpFile("empty.json");
    const outPath = tmpFile("articles-empty.json");
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
        "--out", outPath,
        "--cursor", tmpFile("cursor-empty.json"),
      ]);
    } finally {
      process.stdout.write = origWrite;
    }

    const output = JSON.parse(captured.join(""));
    assert.equal(output.processed, 0);
    assert.equal(output.articles_produced, 0);

    // Output file should contain empty array
    assert.ok(existsSync(outPath));
    const articles = JSON.parse(readFileSync(outPath, "utf8"));
    assert.deepEqual(articles, []);
  });
});

describe("#7662 — always_consider_senders allowlist", () => {
  const SENDER = "7min.ai <email@newsletter.7min.ai>";

  function fixtureThread(overrides: Partial<CapturedThread> = {}): CapturedThread {
    return {
      thread_id: "t-7662",
      sender: SENDER,
      subject: "7min.ai Weekly",
      date: "2026-09-09T08:00:00Z",
      body: [
        // (a) tracking wrapper NOT covered by any known TRACKER_DECODERS —
        // isTrackingUrl fires, decodeTrackerUrl does not decode it.
        "Tracking: https://link.mail.beehiiv.com/click?url=https://example.com/article-a",
        // (b) affiliate path
        "Affiliate: https://go.granola.ai/partner-abc",
        // (c) sender's own domain (auto-promo)
        "Own edition: https://newsletter.7min.ai/edition-99",
        // control: a normal external link, always kept regardless of allowlist
        "External: https://example.com/normal-article",
      ].join("\n"),
      ...overrides,
    };
  }

  it("sender na allowlist: as 3 URLs que seriam filtradas chegam ao pool, marcadas always_consider", () => {
    const { articles, result } = processThreads(
      [fixtureThread()],
      { processed_thread_ids: [] },
      { alwaysConsiderSenders: ["email@newsletter.7min.ai"] },
    );

    assert.equal(result.urls_filtered, 0, "nada filtrado quando o sender está na allowlist");
    assert.equal(articles.length, 4, "as 4 URLs (3 que seriam heuristicamente filtradas + 1 normal) chegam ao pool");
    assert.ok(articles.every((a) => a.always_consider === true));
    assert.ok(articles.some((a) => a.url.includes("example.com/article-a")));
    assert.ok(articles.some((a) => a.url.includes("go.granola.ai")));
    assert.ok(articles.some((a) => a.url.includes("newsletter.7min.ai/edition-99")));
    assert.ok(articles.some((a) => a.url.includes("example.com/normal-article")));

    // Observabilidade (#7662): cada URL isenta aparece nomeada com a regra
    // que TERIA sido aplicada — não só um contador agregado.
    assert.equal(result.always_consider_exemptions.length, 3);
    const rules = result.always_consider_exemptions.map((e) => e.rule).sort();
    assert.deepEqual(rules, ["affiliate", "sender-own", "tracking"]);
    assert.ok(result.always_consider_exemptions.every((e) => e.sender === SENDER));
  });

  it("sem allowlist: comportamento atual preservado — as 3 URLs continuam filtradas", () => {
    const { articles, result } = processThreads(
      [fixtureThread({ thread_id: "t-7662-no-allow" })],
      { processed_thread_ids: [] },
      { alwaysConsiderSenders: [] },
    );

    assert.equal(result.urls_filtered, 3, "as 3 heurísticas continuam cortando sem a allowlist");
    assert.equal(articles.length, 1, "só a URL normal sobrevive");
    assert.equal(articles[0].url, "https://example.com/normal-article");
    assert.ok(articles.every((a) => a.always_consider === undefined));
    assert.equal(result.always_consider_exemptions.length, 0);
  });

  it("sender fora da allowlist (mesmo com allowlist configurada) não é isento", () => {
    const otherThread = fixtureThread({
      thread_id: "t-7662-other-sender",
      sender: "Other Newsletter <other@mail.beehiiv.com>",
    });
    const { articles, result } = processThreads(
      [otherThread],
      { processed_thread_ids: [] },
      { alwaysConsiderSenders: ["email@newsletter.7min.ai"] },
    );
    // Só tracking + affiliate são filtrados aqui — o "sender-own" da fixture
    // aponta pra newsletter.7min.ai, que não é o domínio DESTE sender, então
    // isSenderOwnUrl nunca dispararia pra ele mesmo sem allowlist nenhuma.
    assert.equal(result.urls_filtered, 2);
    assert.equal(articles.length, 2);
    assert.ok(articles.every((a) => a.always_consider === undefined));
  });

  it("decodeTrackerUrl continua rodando em always_consider — queremos a URL final, não o wrapper", () => {
    // 7min.ai's own known tracker wrapper (track.newsletter.7min.ai/c/...) IS
    // decoded by decodeTrackerUrl regardless of allowlist — the issue is
    // explicit that decoding must never be skipped, allowlist or not.
    const dest = "https://example.com/decoded-destination";
    const encoded = Buffer.from(`x|y|${dest}`, "utf8").toString("base64");
    const thread = fixtureThread({
      thread_id: "t-7662-decode",
      body: `Wrapped: https://track.newsletter.7min.ai/c/${encoded}`,
    });
    const { articles } = processThreads(
      [thread],
      { processed_thread_ids: [] },
      { alwaysConsiderSenders: ["email@newsletter.7min.ai"] },
    );
    assert.ok(articles.some((a) => a.url === dest), "URL final decodificada, não o wrapper");
  });
});

describe("#7662 — loadAlwaysConsiderConfig: nunca degrada em silêncio", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("config ilegível vira config_warnings, não [] silencioso", () => {
    const badPath = tmpFile("bad-platform-config.json");
    writeFileSync(badPath, "{ not valid json", "utf8");
    const { alwaysConsiderSenders, configWarnings } = loadAlwaysConsiderConfig(badPath);
    assert.deepEqual(alwaysConsiderSenders, []);
    assert.equal(configWarnings.length, 1);
    assert.ok(configWarnings[0].includes("ilegível"));
  });

  it("config ausente vira config_warnings, não [] silencioso", () => {
    const { alwaysConsiderSenders, configWarnings } = loadAlwaysConsiderConfig(tmpFile("does-not-exist.json"));
    assert.deepEqual(alwaysConsiderSenders, []);
    assert.equal(configWarnings.length, 1);
    assert.ok(configWarnings[0].includes("não encontrado"));
  });

  it("sender em always_consider_senders ausente de senders[] gera warning — allowlist sem efeito é reportada, não silenciosa", () => {
    const cfgPath = tmpFile("mismatched-platform-config.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        newsletter_auto_capture: {
          senders: ["a@example.com"],
          always_consider_senders: ["email@newsletter.7min.ai"],
        },
      }),
      "utf8",
    );
    const { alwaysConsiderSenders, configWarnings } = loadAlwaysConsiderConfig(cfgPath);
    assert.deepEqual(alwaysConsiderSenders, ["email@newsletter.7min.ai"]);
    assert.equal(configWarnings.length, 1);
    assert.ok(configWarnings[0].includes("email@newsletter.7min.ai"));
    assert.ok(configWarnings[0].includes("senders[]"));
  });

  it("config bem-formada e consistente não gera warning", () => {
    const cfgPath = tmpFile("ok-platform-config.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        newsletter_auto_capture: {
          senders: ["email@newsletter.7min.ai"],
          always_consider_senders: ["email@newsletter.7min.ai"],
        },
      }),
      "utf8",
    );
    const { alwaysConsiderSenders, configWarnings } = loadAlwaysConsiderConfig(cfgPath);
    assert.deepEqual(alwaysConsiderSenders, ["email@newsletter.7min.ai"]);
    assert.deepEqual(configWarnings, []);
  });
});
