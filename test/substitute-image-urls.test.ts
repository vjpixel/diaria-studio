import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildFilenameMap,
  substituteImagePlaceholders,
} from "../scripts/substitute-image-urls.ts";

describe("buildFilenameMap", () => {
  it("constrói map de filename → URL a partir de images dict", () => {
    const map = buildFilenameMap({
      cover: { file_id: "1", url: "https://drive.google.com/uc?id=1&export=view", filename: "04-d1-2x1.jpg" },
      d2: { file_id: "2", url: "https://drive.google.com/uc?id=2&export=view", filename: "04-d2.jpg" },
    });
    assert.equal(map.size, 2);
    assert.equal(map.get("04-d1-2x1.jpg"), "https://drive.google.com/uc?id=1&export=view");
    assert.equal(map.get("04-d2.jpg"), "https://drive.google.com/uc?id=2&export=view");
  });

  it("pula entries sem filename ou url", () => {
    const map = buildFilenameMap({
      good: { file_id: "1", url: "https://a.com", filename: "04-d1.jpg" },
      no_url: { file_id: "2", url: "", filename: "04-d2.jpg" },
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
    const html = `<img src="{{IMG:04-d1-2x1.jpg}}"/><img src="{{IMG:04-d2.jpg}}"/><img src="{{IMG:04-d3.jpg}}"/>`;
    const map = new Map([
      ["04-d1-2x1.jpg", "https://a.com/1"],
      ["04-d2.jpg", "https://a.com/2"],
      ["04-d3.jpg", "https://a.com/3"],
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
