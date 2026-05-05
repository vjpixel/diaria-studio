import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractTopicsFromInbox, extractInboxTopics } from "../scripts/extract-inbox-topics.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDITOR = "vjpixel@gmail.com";

// Inbox com 1 entry de URL, 2 de topic do editor, 1 de terceiro
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

describe("extractTopicsFromInbox (#662)", () => {
  it("extrai topics de blocos de texto-puro do editor", () => {
    const topics = extractTopicsFromInbox(sampleInbox, EDITOR);
    assert.ok(topics.includes("IA no mercado de trabalho brasileiro"));
    assert.ok(topics.includes("open source LLM benchmarks 2026"));
    assert.equal(topics.length, 2, "deve ter 2 topics do editor");
  });

  it("ignora blocos sem campo **topic:**", () => {
    const topics = extractTopicsFromInbox(sampleInbox, EDITOR);
    assert.ok(!topics.some((t) => t.includes("article")));
  });

  it("não inclui topics de remetentes não-editores", () => {
    const topics = extractTopicsFromInbox(sampleInbox, EDITOR);
    assert.ok(!topics.some((t) => t.includes("terceiro")));
  });

  it("#688: não-editor ANTES do editor — topic do editor ainda extraído", () => {
    // Caso que falhava silenciosamente: newsletter original (não-editor) ocupa
    // o índice 0, editor com topic ocupa o índice 1. O bug de alinhamento
    // olhava segments[0] (newsletter) ao processar editorBlocks[0] (editor).
    const inbox = `## 2026-05-01T00:00:00.000Z
- **from:** Cyberman <cyberman@mail.beehiiv.com>
- **subject:** AI news
- **urls:**
  - https://cyberman.ai/article
- **raw:** > newsletter content

## 2026-05-02T00:00:00.000Z
- **from:** Angelo Pixel <vjpixel@gmail.com>
- **subject:** Pesquisar esse tema
- **topic:** IA na medicina brasileira
- **raw:** > IA na medicina brasileira
`;
    const topics = extractTopicsFromInbox(inbox, EDITOR);
    assert.equal(topics.length, 1);
    assert.ok(topics.includes("IA na medicina brasileira"), "topic do editor deve ser extraído mesmo após bloco de não-editor");
  });

  it("#688: múltiplos não-editores intercalados com editores", () => {
    const inbox = `## 2026-05-01T00:00:00.000Z
- **from:** newsletter1@x.com
- **subject:** NL 1
- **topic:** newsletter topic 1
- **raw:** > ...

## 2026-05-01T01:00:00.000Z
- **from:** vjpixel@gmail.com
- **subject:** Meu tema A
- **topic:** tema do editor A
- **raw:** > ...

## 2026-05-01T02:00:00.000Z
- **from:** newsletter2@y.com
- **subject:** NL 2
- **topic:** newsletter topic 2
- **raw:** > ...

## 2026-05-01T03:00:00.000Z
- **from:** vjpixel@gmail.com
- **subject:** Meu tema B
- **topic:** tema do editor B
- **raw:** > ...
`;
    const topics = extractTopicsFromInbox(inbox, EDITOR);
    assert.equal(topics.length, 2);
    assert.ok(topics.includes("tema do editor A"));
    assert.ok(topics.includes("tema do editor B"));
    assert.ok(!topics.some((t) => t.includes("newsletter topic")));
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
    const topics = extractTopicsFromInbox(inbox, EDITOR);
    assert.equal(topics.length, 1);
  });

  it("ignora topics muito curtos (< 5 chars)", () => {
    const inbox = `## 2026-05-05T10:00:00.000Z
- **from:** vjpixel@gmail.com
- **subject:** X
- **topic:** IA
- **raw:** > IA
`;
    const topics = extractTopicsFromInbox(inbox, EDITOR);
    assert.equal(topics.length, 0);
  });

  it("retorna [] quando inbox não tem nenhum topic do editor", () => {
    const inbox = `## 2026-05-05T10:00:00.000Z
- **from:** vjpixel@gmail.com
- **subject:** Check this
- **urls:**
  - https://example.com/x
- **raw:** > https://example.com/x
`;
    const topics = extractTopicsFromInbox(inbox, EDITOR);
    assert.equal(topics.length, 0);
  });

  it("retorna [] para inbox vazio", () => {
    assert.deepEqual(extractTopicsFromInbox("", EDITOR), []);
    assert.deepEqual(extractTopicsFromInbox("# Header apenas\n", EDITOR), []);
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
