import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countEditorSubmissions,
  formatCoverageLine,
  resolveEditorEmail,
  readInboxLinkCountFromMarker,
  readInjectPoolSizeFromMarker,
  computeDiariaDiscovered,
  getTotalEditorSubmissions,
  readCaptureFailedFromMarker,
  renderCaptureFailedLine,
} from "../scripts/lib/inbox-stats.ts";
import { checkCoverageLine } from "../scripts/lint-newsletter-md.ts";

describe("readInjectPoolSizeFromMarker (#1864)", () => {
  it("lê total_pool_size (top-level e details); ausente → null", () => {
    const d1 = mkdtempSync(join(tmpdir(), "pool-"));
    const d2 = mkdtempSync(join(tmpdir(), "pool-"));
    const d3 = mkdtempSync(join(tmpdir(), "pool-"));
    writeFileSync(join(d1, ".marker-inject-inbox-urls.json"), JSON.stringify({ total_pool_size: 350 }), "utf8");
    writeFileSync(join(d2, ".marker-inject-inbox-urls.json"), JSON.stringify({ details: { total_pool_size: 350 } }), "utf8");
    writeFileSync(join(d3, ".marker-inject-inbox-urls.json"), JSON.stringify({ foo: 1 }), "utf8");
    try {
      assert.equal(readInjectPoolSizeFromMarker(d1), 350);
      assert.equal(readInjectPoolSizeFromMarker(d2), 350);
      assert.equal(readInjectPoolSizeFromMarker(d3), null);
      assert.equal(readInjectPoolSizeFromMarker(join(tmpdir(), "nope-xyz")), null);
    } finally {
      for (const d of [d1, d2, d3]) rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("computeDiariaDiscovered (#1864)", () => {
  it("stage-consistente: rawPoolSize − inboxLinks (caso 260605 → 193)", () => {
    assert.equal(
      computeDiariaDiscovered({ rawPoolSize: 350, inboxLinks: 157, totalConsidered: 138, editorSubmissions: 12 }),
      193,
    );
  });
  it("NÃO zera quando rawPoolSize disponível (não usa totalConsidered pós-filtro)", () => {
    // O bug do review: 138 − 157 = −19 → 0. Com rawPoolSize, usa 350 − 157 = 193.
    const y = computeDiariaDiscovered({ rawPoolSize: 350, inboxLinks: 157, totalConsidered: 138, editorSubmissions: 12 });
    assert.notEqual(y, 0);
  });
  it("fallback (marker ausente): totalConsidered − editorSubmissions", () => {
    assert.equal(
      computeDiariaDiscovered({ rawPoolSize: null, inboxLinks: null, totalConsidered: 138, editorSubmissions: 12 }),
      126,
    );
  });
  it("nenhum total conhecido → null (sem coverage)", () => {
    assert.equal(
      computeDiariaDiscovered({ rawPoolSize: null, inboxLinks: null, totalConsidered: null, editorSubmissions: 12 }),
      null,
    );
  });
  it("clamp a 0 (defensive) se inboxLinks > rawPoolSize", () => {
    assert.equal(
      computeDiariaDiscovered({ rawPoolSize: 5, inboxLinks: 9, totalConsidered: null, editorSubmissions: 0 }),
      0,
    );
  });
});

describe("readInboxLinkCountFromMarker (#1864)", () => {
  function setup(marker: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "inbox-links-"));
    writeFileSync(join(dir, ".marker-inject-inbox-urls.json"), JSON.stringify(marker), "utf8");
    return dir;
  }

  it("soma total_editor_urls + total_newsletter_urls (links do canal do editor)", () => {
    const dir = setup({ total_editor_urls: 3, total_newsletter_urls: 154 });
    try {
      assert.equal(readInboxLinkCountFromMarker(dir), 157);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("suporta campos em `details` (shape novo)", () => {
    const dir = setup({ details: { total_editor_urls: 3, total_newsletter_urls: 154 } });
    try {
      assert.equal(readInboxLinkCountFromMarker(dir), 157);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("campo ausente conta como 0; ambos ausentes → null", () => {
    const d1 = setup({ total_editor_urls: 5 });
    const d2 = setup({ foo: "bar" });
    try {
      assert.equal(readInboxLinkCountFromMarker(d1), 5); // só editor
      assert.equal(readInboxLinkCountFromMarker(d2), null); // nenhum campo
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
    }
  });

  it("marker ausente → null (caller faz fallback)", () => {
    assert.equal(readInboxLinkCountFromMarker(join(tmpdir(), "nao-existe-dir-xyz")), null);
  });
});

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

describe("countEditorSubmissions (#592, #609, #1486)", () => {
  function withArchive(content: string): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "diaria-archive-"));
    const path = join(dir, "archive.md");
    writeFileSync(path, content, "utf8");
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("#1486: conta TODOS os blocos como submissões (inclui forwards)", () => {
    const { path, cleanup } = withArchive(sampleArchive);
    try {
      // sampleArchive tem 4 blocos (2 do editor + 2 forwards)
      assert.equal(countEditorSubmissions(path), 4);
    } finally {
      cleanup();
    }
  });

  it("#1486: _editorEmail é ignorado (backwards compat)", () => {
    const { path, cleanup } = withArchive(sampleArchive);
    try {
      assert.equal(countEditorSubmissions(path, "ninguem@example.com"), 4);
    } finally {
      cleanup();
    }
  });

  it("retorna 0 se arquivo ausente", () => {
    assert.equal(countEditorSubmissions("/path/never/exists.md"), 0);
  });

  it("retorna 0 se archive vazio (sem blocos)", () => {
    const { path, cleanup } = withArchive("# Inbox Editorial — Diar.ia\n\n<!-- entries abaixo -->\n");
    try {
      assert.equal(countEditorSubmissions(path), 0);
    } finally {
      cleanup();
    }
  });

  it("sem args opcionais funciona (backwards compat)", () => {
    const { path, cleanup } = withArchive(sampleArchive);
    try {
      assert.equal(countEditorSubmissions(path), 4);
    } finally {
      cleanup();
    }
  });
});

describe("getTotalEditorSubmissions (#3696)", () => {
  function withFixture(
    archiveContent: string,
    marker: Record<string, unknown> | null,
    capturedNewsletters: unknown[] | null = null,
  ): { archivePath: string; internalDir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "diaria-total-submissions-"));
    const archivePath = join(dir, "archive.md");
    writeFileSync(archivePath, archiveContent, "utf8");
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    if (marker) {
      writeFileSync(
        join(internalDir, ".marker-inject-inbox-urls.json"),
        JSON.stringify(marker),
        "utf8",
      );
    }
    if (capturedNewsletters) {
      writeFileSync(
        join(internalDir, "captured-newsletters.json"),
        JSON.stringify(capturedNewsletters),
        "utf8",
      );
    }
    return { archivePath, internalDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("caso real 260720: 3 blocos no archive (só editor) + 9 newsletters capturadas = 12 (não 3)", () => {
    // sampleArchive tem 4 blocos, mas aqui simulamos o cenário da issue: só os
    // forwards diretos do editor foram parseados pro archive (3), e as 9
    // newsletters vieram 100% pelo caminho "captured-articles" — nunca criam
    // bloco em inbox.md (#1520).
    const archiveWithOnlyEditorBlocks = `## 2026-07-19T10:00:00.000Z
- **from:** Angelo Pixel <vjpixel@gmail.com>

## 2026-07-19T11:00:00.000Z
- **from:** Angelo Pixel <vjpixel@gmail.com>

## 2026-07-19T12:00:00.000Z
- **from:** Angelo Pixel <vjpixel@gmail.com>
`;
    const { archivePath, internalDir, cleanup } = withFixture(
      archiveWithOnlyEditorBlocks,
      {
        editor_blocks: 3,
        newsletter_blocks: 0,
        newsletter_source: "captured-articles",
        captured_newsletter_count: 9,
      },
    );
    try {
      assert.equal(countEditorSubmissions(archivePath), 3, "sozinha, subcontava (bug #3696)");
      assert.equal(getTotalEditorSubmissions(archivePath, internalDir), 12, "3 blocos + 9 capturadas");
    } finally {
      cleanup();
    }
  });

  it("newsletter_source ausente/captured_newsletter_count sem número → fallback lê captured-newsletters.json direto", () => {
    const { archivePath, internalDir, cleanup } = withFixture(
      "## 2026-07-19T10:00:00.000Z\n- **from:** editor@example.com\n",
      { editor_blocks: 1, newsletter_source: "captured-articles" }, // sem captured_newsletter_count
      [{ thread_id: "a" }, { thread_id: "b" }],
    );
    try {
      assert.equal(getTotalEditorSubmissions(archivePath, internalDir), 3, "1 bloco + 2 do fallback file");
    } finally {
      cleanup();
    }
  });

  it("newsletter_source === 'inbox-md' → NÃO soma captured_newsletter_count (já contado nos blocos)", () => {
    // Quando o caminho é inbox-md, as newsletters JÁ viraram blocos no
    // archive — countEditorSubmissions (que conta TODOS os blocos) já as
    // inclui. Somar de novo duplicaria.
    const { archivePath, internalDir, cleanup } = withFixture(
      sampleArchive, // 4 blocos (2 editor + 2 forwards)
      {
        editor_blocks: 2,
        newsletter_blocks: 2,
        newsletter_source: "inbox-md",
        captured_newsletter_count: 0,
      },
    );
    try {
      assert.equal(getTotalEditorSubmissions(archivePath, internalDir), 4, "não duplica — só os blocos do archive");
    } finally {
      cleanup();
    }
  });

  it("marker ausente → cai pra countEditorSubmissions sozinha (comportamento anterior)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-total-submissions-nomarker-"));
    const archivePath = join(dir, "archive.md");
    writeFileSync(archivePath, sampleArchive, "utf8");
    try {
      assert.equal(
        getTotalEditorSubmissions(archivePath, join(dir, "_internal")),
        4,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marker presente mas sem newsletter_source (formato pre-#1520) → não soma nada extra", () => {
    const { archivePath, internalDir, cleanup } = withFixture(sampleArchive, {
      editor_blocks: 2,
      newsletter_blocks: 2,
    });
    try {
      assert.equal(getTotalEditorSubmissions(archivePath, internalDir), 4);
    } finally {
      cleanup();
    }
  });
});

describe("readCaptureFailedFromMarker (#3709 — mesmo guard do #2878, agora no Stage 1)", () => {
  function setup(marker: Record<string, unknown> | null): string {
    const dir = mkdtempSync(join(tmpdir(), "capture-failed-"));
    if (marker) {
      writeFileSync(join(dir, ".marker-inject-inbox-urls.json"), JSON.stringify(marker), "utf8");
    }
    return dir;
  }

  it("capture_failed: true no marker → failed=true com o capture_error", () => {
    const dir = setup({ capture_failed: true, capture_error: "401 unauthorized" });
    try {
      assert.deepEqual(readCaptureFailedFromMarker(dir), { failed: true, error: "401 unauthorized" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("capture_failed: true sem capture_error → mensagem default 'motivo desconhecido'", () => {
    const dir = setup({ capture_failed: true });
    try {
      assert.deepEqual(readCaptureFailedFromMarker(dir), { failed: true, error: "motivo desconhecido" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("suporta campo em `details` (shape novo)", () => {
    const dir = setup({ details: { capture_failed: true, capture_error: "timeout" } });
    try {
      assert.deepEqual(readCaptureFailedFromMarker(dir), { failed: true, error: "timeout" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("capture_failed ausente/false → failed=false", () => {
    const d1 = setup({ captured_newsletter_count: 9 });
    const d2 = setup({ capture_failed: false });
    try {
      assert.deepEqual(readCaptureFailedFromMarker(d1), { failed: false });
      assert.deepEqual(readCaptureFailedFromMarker(d2), { failed: false });
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
    }
  });

  it("marker ausente → failed=false (nunca inventa failed:true por ausência de dado)", () => {
    assert.deepEqual(readCaptureFailedFromMarker(join(tmpdir(), "nao-existe-dir-xyz-3709")), { failed: false });
  });

  it("marker corrompido → failed=false (fail-soft)", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-failed-corrupt-"));
    writeFileSync(join(dir, ".marker-inject-inbox-urls.json"), "not json", "utf8");
    try {
      assert.deepEqual(readCaptureFailedFromMarker(dir), { failed: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderCaptureFailedLine (#3709)", () => {
  it("formata o aviso com o motivo passado", () => {
    assert.equal(
      renderCaptureFailedLine("401 unauthorized"),
      "⚠️ contagem de submissões indisponível (captura de newsletters falhou: 401 unauthorized) — recompute após reautenticar.",
    );
  });
});

describe("formatCoverageLine (#3461 — bloco de boas-vindas, padrão desde 260715)", () => {
  it("monta o bloco de 4 parágrafos com total = editorSubmissions + diariaDiscovered", () => {
    const line = formatCoverageLine({
      editorSubmissions: 26,
      diariaDiscovered: 186,
      selected: 12,
    });
    assert.match(line, /^Olá! Eu sou o \[Pixel\]\(https:\/\/www\.linkedin\.com\/in\/vjpixel\/\), editor desta newsletter\./);
    assert.match(line, /Todos os dias, junto com a IA da diar\.ia\.br, seleciono e resumo as notícias mais importantes/);
    assert.match(line, /Nesta edição, a IA analisou 212 artigos \(26 enviados por mim e 186 encontrados automaticamente\) e selecionei os 12 mais relevantes\./);
    assert.match(line, /Se este trabalho faz diferença para você, \[considere apoiar o projeto\]\(https:\/\/apoia\.se\/diaria\)\.$/);
    // 4 parágrafos separados por linha em branco
    assert.equal(line.split("\n\n").length, 4);
  });

  it("#701: concordância singular quando selected=1 → 'selecionei o artigo mais relevante'", () => {
    const line = formatCoverageLine({
      editorSubmissions: 5,
      diariaDiscovered: 100,
      selected: 1,
    });
    assert.match(line, /e selecionei o artigo mais relevante\./);
    assert.doesNotMatch(line, /selecionei os 1 /);
  });

  it("#701: concordância plural quando selected>1 → 'selecionei os N mais relevantes'", () => {
    const line = formatCoverageLine({
      editorSubmissions: 5,
      diariaDiscovered: 100,
      selected: 3,
    });
    assert.match(line, /e selecionei os 3 mais relevantes\./);
  });

  it("total soma editorSubmissions + diariaDiscovered mesmo com números pequenos/1", () => {
    const line = formatCoverageLine({
      editorSubmissions: 1,
      diariaDiscovered: 1,
      selected: 1,
    });
    // #3731: "1 enviado"/"1 encontrado" (singular) — antes deste fix, o
    // template flexionava "artigos"/selPhrase mas mantinha "enviados"/
    // "encontrados" fixos no plural mesmo pra contagem 1.
    assert.match(line, /Nesta edição, a IA analisou 2 artigos \(1 enviado por mim e 1 encontrado automaticamente\) e selecionei o artigo mais relevante\./);
  });

  it("#3731: concordância singular quando editorSubmissions=1 (1 enviado, não '1 enviados')", () => {
    const line = formatCoverageLine({
      editorSubmissions: 1,
      diariaDiscovered: 50,
      selected: 3,
    });
    assert.match(line, /\(1 enviado por mim e 50 encontrados automaticamente\)/);
    assert.doesNotMatch(line, /1 enviados/);
  });

  it("#3731: concordância singular quando diariaDiscovered=1 (1 encontrado, não '1 encontrados')", () => {
    const line = formatCoverageLine({
      editorSubmissions: 5,
      diariaDiscovered: 1,
      selected: 3,
    });
    assert.match(line, /\(5 enviados por mim e 1 encontrado automaticamente\)/);
    assert.doesNotMatch(line, /1 encontrados/);
  });

  it("#3731: concordância singular quando total=editorSubmissions+diariaDiscovered=1 (analisou 1 artigo)", () => {
    const line = formatCoverageLine({
      editorSubmissions: 1,
      diariaDiscovered: 0,
      selected: 1,
    });
    assert.match(line, /analisou 1 artigo \(1 enviado por mim e 0 encontrados automaticamente\)/);
    assert.doesNotMatch(line, /analisou 1 artigos/);
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

  it("#701: aceita forma singular pluralizada", () => {
    const md = `Para esta edição, eu (o editor) enviei 1 submissão e a Diar.ia encontrou outros 1 artigo. Selecionamos o artigo mais relevante para as pessoas que assinam a newsletter.`;
    assert.equal(checkCoverageLine(md).ok, true);
  });

  it("#701: aceita 1 submissão + N artigos plural", () => {
    const md = `Para esta edição, eu (o editor) enviei 1 submissão e a Diar.ia encontrou outros 186 artigos. Selecionamos os 12 mais relevantes para as pessoas que assinam a newsletter.`;
    assert.equal(checkCoverageLine(md).ok, true);
  });

  describe("#925: pula YAML frontmatter", () => {
    it("aceita cover line após frontmatter eia_answer", () => {
      const md = [
        "---",
        "eia_answer:",
        "  A: ia",
        "  B: real",
        "---",
        "",
        "Para esta edição, eu (o editor) enviei 11 submissões e a Diar.ia encontrou outros 369 artigos. Selecionamos os 12 mais relevantes para as pessoas que assinam a newsletter.",
        "",
        "---",
        "",
        "DESTAQUE 1 | ...",
      ].join("\n");
      const r = checkCoverageLine(md);
      assert.equal(r.ok, true, `firstLine: ${r.firstLine}`);
    });

    it("regression: sem frontmatter continua funcionando", () => {
      const md = [
        "Para esta edição, eu (o editor) enviei 26 submissões e a Diar.ia encontrou outros 186 artigos. Selecionamos os 12 mais relevantes para as pessoas que assinam a newsletter.",
        "",
        "---",
        "",
        "DESTAQUE 1",
      ].join("\n");
      assert.equal(checkCoverageLine(md).ok, true);
    });

    it("aceita cover line com frontmatter vazio", () => {
      const md = [
        "---",
        "---",
        "",
        "Para esta edição, eu (o editor) enviei 5 submissões e a Diar.ia encontrou outros 100 artigos. Selecionamos os 8 mais relevantes para as pessoas que assinam a newsletter.",
      ].join("\n");
      assert.equal(checkCoverageLine(md).ok, true);
    });

    it("frontmatter malformado (sem fechamento) → trata tudo como body, lint falha (não quebra)", () => {
      const md = [
        "---",
        "eia_answer:",
        "  A: ia",
        "Para esta edição, eu (o editor) enviei 5 submissões...",
      ].join("\n");
      // `---` é primeira linha, regex falha — comportamento esperado, não crash.
      const r = checkCoverageLine(md);
      assert.equal(r.ok, false);
      assert.equal(r.firstLine, "---");
    });

    it("CRLF: aceita cover line após frontmatter com line endings Windows", () => {
      const md = [
        "---",
        "eia_answer:",
        "  A: ia",
        "  B: real",
        "---",
        "",
        "Para esta edição, eu (o editor) enviei 11 submissões e a Diar.ia encontrou outros 369 artigos. Selecionamos os 12 mais relevantes para as pessoas que assinam a newsletter.",
      ].join("\r\n");
      assert.equal(checkCoverageLine(md).ok, true);
    });

    it("--- como separador de seção do body NÃO conta como frontmatter", () => {
      const md = [
        "Para esta edição, eu (o editor) enviei 26 submissões e a Diar.ia encontrou outros 186 artigos. Selecionamos os 12 mais relevantes para as pessoas que assinam a newsletter.",
        "",
        "---",
        "",
        "DESTAQUE 1",
        "",
        "---",
        "",
        "DESTAQUE 2",
      ].join("\n");
      assert.equal(checkCoverageLine(md).ok, true);
    });
  });
});
