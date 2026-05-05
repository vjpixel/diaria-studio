import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countEditorSubmissions,
  formatCoverageLine,
  resolveEditorEmail,
} from "../scripts/lib/inbox-stats.ts";
import { checkCoverageLine } from "../scripts/lint-newsletter-md.ts";

const sampleArchive = `# Inbox Editorial — Diar.ia

<!-- entries abaixo -->
## 2026-05-04T17:44:00.000Z
- **from:** Angelo Pixel <vjpixel@gmail.com>
- **subject:** Gemini's new UI is out now
- **urls:**
  - https://www.androidauthority.com/gemini-ui-ios-app-3663119/

## 2026-05-03T03:02:10.000Z
- **from:** AI Agents News <agentpulse@mail.beehiiv.com>
- **subject:** forwarded newsletter
- **urls:**
  - https://example.com/article

## 2026-05-04T19:09:10.000Z
- **from:** Angelo Pixel <vjpixel@gmail.com>
- **subject:** Fwd: TLDR AI - 2026-05-04
- **urls:**
  - https://example.org/real-article

## 2026-05-04T20:00:00.000Z
- **from:** TLDR <tracking@tldrnewsletter.com>
- **subject:** TLDR AI
- **urls:**
  - https://example.io/x
`;

describe("countEditorSubmissions (#592, #609)", () => {
  function withArchive(content: string): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "diaria-archive-"));
    const path = join(dir, "archive.md");
    writeFileSync(path, content, "utf8");
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("conta blocos cujo from contém o e-mail do editor", () => {
    const { path, cleanup } = withArchive(sampleArchive);
    try {
      assert.equal(countEditorSubmissions(path, "vjpixel@gmail.com"), 2);
    } finally {
      cleanup();
    }
  });

  it("é case-insensitive", () => {
    const { path, cleanup } = withArchive(sampleArchive);
    try {
      assert.equal(countEditorSubmissions(path, "VJPIXEL@gmail.com"), 2);
    } finally {
      cleanup();
    }
  });

  it("retorna 0 se arquivo ausente", () => {
    assert.equal(countEditorSubmissions("/path/never/exists.md", "vjpixel@gmail.com"), 0);
  });

  it("retorna 0 se nenhum bloco bate", () => {
    const { path, cleanup } = withArchive(sampleArchive);
    try {
      assert.equal(countEditorSubmissions(path, "ninguem@example.com"), 0);
    } finally {
      cleanup();
    }
  });

  it("usa default vjpixel@gmail.com se editor não passado", () => {
    const { path, cleanup } = withArchive(sampleArchive);
    try {
      assert.equal(countEditorSubmissions(path), 2);
    } finally {
      cleanup();
    }
  });
});

describe("formatCoverageLine (#592, #609)", () => {
  it("monta linha canônica com 'submissões' (não 'artigos')", () => {
    const line = formatCoverageLine({
      editorSubmissions: 26,
      diariaDiscovered: 186,
      selected: 12,
    });
    assert.match(line, /enviei 26 submissões/);
    assert.match(line, /encontrou outros 186 artigos/);
    assert.match(line, /Selecionamos os 12 mais relevantes/);
    assert.match(line, /pessoas que assinam a newsletter\.$/);
  });
});

describe("resolveEditorEmail (#592)", () => {
  function withConfig(content: string): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "diaria-config-"));
    const path = join(dir, "platform.config.json");
    writeFileSync(path, content, "utf8");
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("retorna default vjpixel@gmail.com se config ausente", () => {
    assert.equal(resolveEditorEmail("/path/never/exists.json"), "vjpixel@gmail.com");
  });

  it("retorna editor_personal_email se configurado", () => {
    const { path, cleanup } = withConfig(JSON.stringify({
      inbox: { editor_personal_email: "outro@example.com" },
    }));
    try {
      assert.equal(resolveEditorEmail(path), "outro@example.com");
    } finally {
      cleanup();
    }
  });

  it("retorna default se config malformado", () => {
    const { path, cleanup } = withConfig("not json");
    try {
      assert.equal(resolveEditorEmail(path), "vjpixel@gmail.com");
    } finally {
      cleanup();
    }
  });
});

describe("checkCoverageLine (#592, #609 lint)", () => {
  it("aceita linha canônica como primeira linha", () => {
    const md = `Para esta edição, eu (o editor) enviei 26 submissões e a Diar.ia encontrou outros 186 artigos. Selecionamos os 12 mais relevantes para as pessoas que assinam a newsletter.

---

DESTAQUE 1 | NOTÍCIA
`;
    const result = checkCoverageLine(md);
    assert.equal(result.ok, true);
  });

  it("aceita variação com ??? no Y (fallback)", () => {
    const md = `Para esta edição, eu (o editor) enviei 26 submissões e a Diar.ia encontrou outros ??? artigos. Selecionamos os 12 mais relevantes para as pessoas...`;
    assert.equal(checkCoverageLine(md).ok, true);
  });

  it("rejeita linha sem 'submissões'", () => {
    const md = `Para esta edição, eu (o editor) enviei 26 artigos e a Diar.ia encontrou outros 186 artigos. Selecionamos os 12 mais relevantes para as pessoas...`;
    assert.equal(checkCoverageLine(md).ok, false);
  });

  it("rejeita linha em formato antigo", () => {
    const md = `Para essa edição, foram considerados 212 artigos e selecionados 12.`;
    assert.equal(checkCoverageLine(md).ok, false);
  });

  it("rejeita md vazio", () => {
    assert.equal(checkCoverageLine("").ok, false);
  });

  it("ignora linhas em branco antes da primeira linha", () => {
    const md = `\n\n\nPara esta edição, eu (o editor) enviei 5 submissões e a Diar.ia encontrou outros 100 artigos. Selecionamos os 8 mais relevantes para as pessoas que assinam a newsletter.\n`;
    assert.equal(checkCoverageLine(md).ok, true);
  });
});
