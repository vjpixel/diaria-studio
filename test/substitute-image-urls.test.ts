import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildFilenameMap,
  substituteImagePlaceholders,
  checkInputHtmlFreshness,
} from "../scripts/substitute-image-urls.ts";

describe("buildFilenameMap", () => {
  it("constrói map de filename → URL a partir de images dict", () => {
    const map = buildFilenameMap({
      cover: { file_id: "1", url: "https://drive.google.com/uc?id=1&export=view", filename: "04-d1-2x1.jpg" },
      d2: { file_id: "2", url: "https://drive.google.com/uc?id=2&export=view", filename: "04-d2-1x1.jpg" },
    });
    assert.equal(map.size, 2);
    assert.equal(map.get("04-d1-2x1.jpg"), "https://drive.google.com/uc?id=1&export=view");
    assert.equal(map.get("04-d2-1x1.jpg"), "https://drive.google.com/uc?id=2&export=view");
  });

  it("pula entries sem filename ou url", () => {
    const map = buildFilenameMap({
      good: { file_id: "1", url: "https://a.com", filename: "04-d1.jpg" },
      no_url: { file_id: "2", url: "", filename: "04-d2-1x1.jpg" },
      no_filename: { file_id: "3", url: "https://a.com", filename: "" },
    });
    assert.equal(map.size, 1);
    assert.ok(map.has("04-d1.jpg"));
  });

  it("mapa vazio pra images vazio", () => {
    assert.equal(buildFilenameMap({}).size, 0);
  });
});

describe("substituteImagePlaceholders", () => {
  it("substitui placeholder único", () => {
    const html = `<img src="{{IMG:04-d1-2x1.jpg}}" alt="cover"/>`;
    const map = new Map([["04-d1-2x1.jpg", "https://drive.google.com/uc?id=abc"]]);
    const result = substituteImagePlaceholders(html, map);
    assert.equal(result.html, `<img src="https://drive.google.com/uc?id=abc" alt="cover"/>`);
    assert.equal(result.substitutions, 1);
    assert.deepEqual(result.unresolved, []);
  });

  it("substitui múltiplas placeholders", () => {
    const html = `<img src="{{IMG:04-d1-2x1.jpg}}"/><img src="{{IMG:04-d2-1x1.jpg}}"/><img src="{{IMG:04-d3-1x1.jpg}}"/>`;
    const map = new Map([
      ["04-d1-2x1.jpg", "https://a.com/1"],
      ["04-d2-1x1.jpg", "https://a.com/2"],
      ["04-d3-1x1.jpg", "https://a.com/3"],
    ]);
    const result = substituteImagePlaceholders(html, map);
    assert.equal(result.substitutions, 3);
    assert.ok(result.html.includes("https://a.com/1"));
    assert.ok(result.html.includes("https://a.com/2"));
    assert.ok(result.html.includes("https://a.com/3"));
    assert.equal(result.unresolved.length, 0);
  });

  it("placeholder sem match fica como está + unresolved tem o nome", () => {
    const html = `<img src="{{IMG:missing.jpg}}"/>`;
    const map = new Map<string, string>();
    const result = substituteImagePlaceholders(html, map);
    assert.equal(result.substitutions, 0);
    assert.equal(result.html, `<img src="{{IMG:missing.jpg}}"/>`);
    assert.deepEqual(result.unresolved, ["missing.jpg"]);
  });

  it("mix de resolvido + não resolvido", () => {
    const html = `<img src="{{IMG:04-d1.jpg}}"/><img src="{{IMG:ghost.jpg}}"/>`;
    const map = new Map([["04-d1.jpg", "https://a.com/d1"]]);
    const result = substituteImagePlaceholders(html, map);
    assert.equal(result.substitutions, 1);
    assert.deepEqual(result.unresolved, ["ghost.jpg"]);
    assert.ok(result.html.includes("https://a.com/d1"));
    assert.ok(result.html.includes("{{IMG:ghost.jpg}}"));
  });

  it("unresolved dedupe (mesmo placeholder 2x vira 1 entry)", () => {
    const html = `{{IMG:missing.jpg}} e {{IMG:missing.jpg}}`;
    const result = substituteImagePlaceholders(html, new Map());
    assert.deepEqual(result.unresolved, ["missing.jpg"]);
  });

  it("HTML sem placeholders retorna unchanged", () => {
    const html = `<p>Conteúdo sem imagens</p>`;
    const result = substituteImagePlaceholders(html, new Map());
    assert.equal(result.html, html);
    assert.equal(result.substitutions, 0);
    assert.equal(result.unresolved.length, 0);
  });

  it("trim de espaços no nome do placeholder", () => {
    const html = `<img src="{{IMG: 04-d1.jpg }}"/>`;
    const map = new Map([["04-d1.jpg", "https://a.com/d1"]]);
    const result = substituteImagePlaceholders(html, map);
    assert.equal(result.substitutions, 1);
  });
});

// ── #2316: fail-loud stale guard ─────────────────────────────────────────────

describe("#2316: checkInputHtmlFreshness — rejeita HTML mais antigo que 02-reviewed.md", () => {
  it("retorna null quando HTML é mais novo que reviewed.md (pipeline ok)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-subst-fresh-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const htmlPath = join(dir, "newsletter-draft.html");
      // MD criado primeiro (timestamp mais antigo)
      writeFileSync(mdPath, "# md", "utf8");
      // Força mtime do MD para 1s no passado
      const pastMs = Date.now() - 2000;
      utimesSync(mdPath, new Date(pastMs), new Date(pastMs));
      // HTML criado depois (timestamp mais recente)
      writeFileSync(htmlPath, "<html/>", "utf8");
      assert.strictEqual(checkInputHtmlFreshness(htmlPath, mdPath), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna mensagem de erro quando HTML é mais antigo que reviewed.md (render falhou)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-subst-stale-"));
    try {
      const htmlPath = join(dir, "newsletter-draft.html");
      const mdPath = join(dir, "02-reviewed.md");
      // HTML criado primeiro (timestamp mais antigo)
      writeFileSync(htmlPath, "<html/>", "utf8");
      // Força mtime do HTML para 2s no passado
      const pastMs = Date.now() - 2000;
      utimesSync(htmlPath, new Date(pastMs), new Date(pastMs));
      // MD criado depois (timestamp mais recente = render não rodou desde o MD)
      writeFileSync(mdPath, "# md", "utf8");

      const result = checkInputHtmlFreshness(htmlPath, mdPath);
      assert.ok(result !== null, "deve retornar mensagem de erro quando HTML está stale");
      assert.match(result, /desatualizado/);
      assert.match(result, /render-newsletter-html\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null quando reviewed.md não existe (fail-open)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-subst-nomd-"));
    try {
      const htmlPath = join(dir, "newsletter-draft.html");
      writeFileSync(htmlPath, "<html/>", "utf8");
      // reviewed.md não existe — sem guard (compatibilidade)
      assert.strictEqual(
        checkInputHtmlFreshness(htmlPath, join(dir, "02-reviewed.md")),
        null,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
