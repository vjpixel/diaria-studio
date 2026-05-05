import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractTopicsFromBlocks, extractInboxTopics } from "../scripts/extract-inbox-topics.ts";
import { parseInboxMd, filterEditorBlocks } from "../scripts/inject-inbox-urls.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDITOR = "vjpixel@gmail.com";

// Inbox com 1 entry de URL, 1 de topic, 1 mista (URL + topic do mesmo editor)
const sampleInbox = `# Inbox Editorial — Diar.ia

<!-- entries abaixo -->
## 2026-05-05T10:00:00.000Z
- **from:** Angelo Pixel <vjpixel@gmail.com>
- **subject:** Check this article
- **urls:**
  - https://example.com/article
- **raw:** > https://example.com/article

## 2026-05-05T11:00:00.000Z
- **from:** Angelo Pixel <vjpixel@gmail.com>
- **subject:** Pesquisar esse tema
- **topic:** IA no mercado de trabalho brasileiro
- **raw:** > IA no mercado de trabalho brasileiro

## 2026-05-05T12:00:00.000Z
- **from:** Angelo Pixel <vjpixel@gmail.com>
- **subject:** Outro tema importante
- **topic:** open source LLM benchmarks 2026
- **raw:** > open source LLM benchmarks 2026

## 2026-05-05T13:00:00.000Z
- **from:** newsletter@example.com
- **subject:** Newsletter da semana
- **topic:** Conteúdo de terceiro — não do editor
- **raw:** > Conteúdo de terceiro
`;

describe("extractTopicsFromBlocks (#662)", () => {
  it("extrai topics de blocos de texto-puro do editor", () => {
    const allBlocks = parseInboxMd(sampleInbox);
    const editorBlocks = filterEditorBlocks(allBlocks, EDITOR);
    const topics = extractTopicsFromBlocks(editorBlocks, sampleInbox);

    assert.ok(topics.includes("IA no mercado de trabalho brasileiro"));
    assert.ok(topics.includes("open source LLM benchmarks 2026"));
    assert.equal(topics.length, 2, "deve ter 2 topics do editor");
  });

  it("ignora blocos sem campo **topic:**", () => {
    const allBlocks = parseInboxMd(sampleInbox);
    const editorBlocks = filterEditorBlocks(allBlocks, EDITOR);
    const topics = extractTopicsFromBlocks(editorBlocks, sampleInbox);

    // Bloco 1 tem URL, não topic → não incluído
    assert.ok(!topics.some((t) => t.includes("article")));
  });

  it("não inclui topics de remetentes não-editores", () => {
    const allBlocks = parseInboxMd(sampleInbox);
    const editorBlocks = filterEditorBlocks(allBlocks, EDITOR);
    const topics = extractTopicsFromBlocks(editorBlocks, sampleInbox);

    assert.ok(!topics.some((t) => t.includes("terceiro")));
  });

  it("dedup: topics idênticos (case-insensitive) aparecem só uma vez", () => {
    const inbox = `## 2026-05-05T10:00:00.000Z
- **from:** vjpixel@gmail.com
- **subject:** X
- **topic:** IA saúde
- **raw:** > IA saúde

## 2026-05-05T11:00:00.000Z
- **from:** vjpixel@gmail.com
- **subject:** Y
- **topic:** ia saúde
- **raw:** > ia saúde
`;
    const blocks = filterEditorBlocks(parseInboxMd(inbox), EDITOR);
    const topics = extractTopicsFromBlocks(blocks, inbox);
    assert.equal(topics.length, 1);
  });

  it("ignora topics muito curtos (< 5 chars)", () => {
    const inbox = `## 2026-05-05T10:00:00.000Z
- **from:** vjpixel@gmail.com
- **subject:** X
- **topic:** IA
- **raw:** > IA
`;
    const blocks = filterEditorBlocks(parseInboxMd(inbox), EDITOR);
    const topics = extractTopicsFromBlocks(blocks, inbox);
    assert.equal(topics.length, 0);
  });

  it("retorna [] quando inbox não tem nenhum topic", () => {
    const inbox = `## 2026-05-05T10:00:00.000Z
- **from:** vjpixel@gmail.com
- **subject:** Check this
- **urls:**
  - https://example.com/x
- **raw:** > https://example.com/x
`;
    const blocks = filterEditorBlocks(parseInboxMd(inbox), EDITOR);
    const topics = extractTopicsFromBlocks(blocks, inbox);
    assert.equal(topics.length, 0);
  });
});

describe("extractInboxTopics (#662) — integração com arquivo", () => {
  it("retorna [] quando arquivo não existe", () => {
    const topics = extractInboxTopics("/nonexistent/path/inbox.md", EDITOR);
    assert.deepEqual(topics, []);
  });

  it("lê e extrai topics de arquivo real", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-topics-"));
    const inboxPath = join(dir, "inbox.md");
    try {
      writeFileSync(inboxPath, sampleInbox, "utf8");
      const topics = extractInboxTopics(inboxPath, EDITOR);
      assert.equal(topics.length, 2);
      assert.ok(topics.includes("IA no mercado de trabalho brasileiro"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
