/**
 * apply-mcp-kit-clicks.test.ts (#6186)
 *
 * Cobre mapKitClick/extractKitClicksArray (input shape) e applyKitClicks
 * (integração com fs). Mirror de test/apply-mcp-clicks.test.ts (Beehiiv),
 * ajustado pro shape mais simples do Kit (unique_clicks direto por URL,
 * sem split email/web) e pra ausência de cache prévio (Kit não tem um
 * "kit-sync.ts" que cria o arquivo antes — este script cria se preciso).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  mapKitClick,
  extractKitClicksArray,
  applyKitClicks,
  isValidId8,
  isRecognizedEmptyKitShape,
  EmptyReplaceGuardError,
} from "../scripts/apply-mcp-kit-clicks.ts";

describe("mapKitClick — MCP shape → legacy", () => {
  it("mapeia unique_clicks e as duas rates", () => {
    const mapped = mapKitClick({
      id: 1881916636,
      url: "https://example.com/a",
      unique_clicks: 7,
      click_to_delivery_rate: 0.076,
      click_to_open_rate: 0.189,
    });
    assert.equal(mapped.url, "https://example.com/a");
    assert.equal(mapped.unique_clicks, 7);
    assert.equal(mapped.click_to_delivery_rate, 0.076);
    assert.equal(mapped.click_to_open_rate, 0.189);
  });

  it("zera unique_clicks quando ausente", () => {
    const mapped = mapKitClick({ url: "https://x.com/" });
    assert.equal(mapped.unique_clicks, 0);
  });
});

describe("extractKitClicksArray — input tolerance", () => {
  it("aceita { broadcast: { clicks: [...] } } (envelope real da MCP)", () => {
    const got = extractKitClicksArray({ broadcast: { id: 1, clicks: [{ url: "a" }] } });
    assert.equal(got.length, 1);
  });
  it("aceita { clicks: [...] } sem envelope de broadcast", () => {
    const got = extractKitClicksArray({ clicks: [{ url: "a" }, { url: "b" }] });
    assert.equal(got.length, 2);
  });
  it("aceita { data: [...] }", () => {
    const got = extractKitClicksArray({ data: [{ url: "a" }] });
    assert.equal(got.length, 1);
  });
  it("aceita array nu", () => {
    const got = extractKitClicksArray([{ url: "a" }]);
    assert.equal(got.length, 1);
  });
  it("retorna [] pra null/undefined/primitivo/broadcast sem clicks", () => {
    assert.deepEqual(extractKitClicksArray(null), []);
    assert.deepEqual(extractKitClicksArray(undefined), []);
    assert.deepEqual(extractKitClicksArray(42), []);
    assert.deepEqual(extractKitClicksArray({ broadcast: { id: 1 } }), []);
  });
});

describe("applyKitClicks — integration", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "apply-mcp-kit-clicks-"));
    const postsDir = resolve(dir, "posts");
    mkdirSync(postsDir, { recursive: true });
    return { dir, postsDir };
  }

  it("cria o cache do zero quando não existe (diferente do Beehiiv, sem sync prévio)", () => {
    const { postsDir } = setup();
    const id8 = "25654292";
    const cachePath = resolve(postsDir, `kit_${id8}.json`);
    assert.equal(existsSync(cachePath), false);

    const stdin = JSON.stringify({
      broadcast: {
        id: 25654292,
        clicks: [
          { url: "https://a.com/", unique_clicks: 7 },
          { url: "https://b.com/", unique_clicks: 2 },
        ],
      },
    });
    const result = applyKitClicks(stdin, { id8, append: false, postsDir });
    assert.equal(result.before_count, 0);
    assert.equal(result.after_count, 2);
    assert.equal(result.mapped, 2);

    const written = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.equal(written.id8, id8);
    assert.equal(written.stats.clicks.length, 2);
    assert.equal(written.stats.clicks[0].unique_clicks, 7);
  });

  it("replace por default sobre cache já existente", () => {
    const { postsDir } = setup();
    const id8 = "25654293";
    const cachePath = resolve(postsDir, `kit_${id8}.json`);
    writeFileSync(cachePath, JSON.stringify({ id8, stats: { clicks: [{ url: "https://old.com/", unique_clicks: 1 }] } }));

    const result = applyKitClicks(
      JSON.stringify({ clicks: [{ url: "https://new.com/", unique_clicks: 5 }] }),
      { id8, append: false, postsDir },
    );
    assert.equal(result.before_count, 1);
    assert.equal(result.after_count, 1);

    const written = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.equal(written.stats.clicks[0].url, "https://new.com/");
  });

  it("append dedup por url, incoming vence", () => {
    const { postsDir } = setup();
    const id8 = "25654294";
    const cachePath = resolve(postsDir, `kit_${id8}.json`);
    writeFileSync(cachePath, JSON.stringify({ id8, stats: { clicks: [{ url: "https://a.com/", unique_clicks: 1 }] } }));

    const result = applyKitClicks(
      JSON.stringify({ clicks: [{ url: "https://a.com/", unique_clicks: 99 }, { url: "https://new.com/", unique_clicks: 2 }] }),
      { id8, append: true, postsDir },
    );
    assert.equal(result.after_count, 2, "a.com deduped, new.com added");

    const written = JSON.parse(readFileSync(cachePath, "utf8"));
    const aCom = written.stats.clicks.find((c: { url: string }) => c.url === "https://a.com/");
    assert.equal(aCom.unique_clicks, 99, "incoming vence no dedup");
  });
});

describe("applyKitClicks — guard REPLACE-vazio (#4836, mesmo padrão do apply-mcp-clicks.ts)", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "apply-mcp-kit-clicks-guard-"));
    const postsDir = resolve(dir, "posts");
    mkdirSync(postsDir, { recursive: true });
    return { dir, postsDir };
  }

  function writeCacheWithClicks(postsDir: string, id8: string, clicks: unknown[]) {
    const cachePath = resolve(postsDir, `kit_${id8}.json`);
    writeFileSync(cachePath, JSON.stringify({ id8, stats: { clicks } }));
    return cachePath;
  }

  it("REPLACE com payload vazio sobre cache não-vazio recusa por padrão", () => {
    const { postsDir } = setup();
    const id8 = "25000001";
    const cachePath = writeCacheWithClicks(postsDir, id8, [{ url: "https://a.com/", unique_clicks: 6 }]);

    assert.throws(
      () => applyKitClicks('{"clicks":[]}', { id8, append: false, postsDir }),
      EmptyReplaceGuardError,
    );

    const stillThere = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.equal(stillThere.stats.clicks.length, 1, "guard não deve apagar o array existente");
  });

  it("--allow-empty-replace explícito permite o replace vazio", () => {
    const { postsDir } = setup();
    const id8 = "25000002";
    const cachePath = writeCacheWithClicks(postsDir, id8, [{ url: "https://a.com/", unique_clicks: 6 }]);

    const result = applyKitClicks('{"clicks":[]}', { id8, append: false, postsDir, allowEmptyReplace: true });
    assert.equal(result.after_count, 0);

    const written = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.equal(written.stats.clicks.length, 0);
  });

  it("REPLACE vazio sobre cache já vazio não aciona o guard (nada a perder)", () => {
    const { postsDir } = setup();
    const id8 = "25000003";
    writeCacheWithClicks(postsDir, id8, []);

    const result = applyKitClicks('{"clicks":[]}', { id8, append: false, postsDir });
    assert.equal(result.after_count, 0);
    assert.equal(result.before_count, 0);
  });

  it("--append nunca aciona o guard (semântica é aditiva)", () => {
    const { postsDir } = setup();
    const id8 = "25000004";
    writeCacheWithClicks(postsDir, id8, [{ url: "https://a.com/", unique_clicks: 6 }]);

    const result = applyKitClicks('{"clicks":[]}', { id8, append: true, postsDir });
    assert.equal(result.after_count, 1, "clique existente preservado, nada novo pra somar");
  });
});

describe("isValidId8 (#6642 review — guard contra path injection via --id8)", () => {
  it("aceita string só de dígitos", () => {
    assert.equal(isValidId8("25654292"), true);
    assert.equal(isValidId8("1"), true);
  });
  it("rejeita valores com caracteres não-numéricos, inclusive tentativa de path traversal", () => {
    assert.equal(isValidId8("../../etc/passwd"), false);
    assert.equal(isValidId8("25654292.json"), false);
    assert.equal(isValidId8("abc"), false);
    assert.equal(isValidId8(""), false);
    assert.equal(isValidId8("25654292 "), false, "espaço à direita não conta como dígito");
  });
});

describe("applyKitClicks — rejeita id8 inválido antes de tocar o filesystem", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "apply-mcp-kit-clicks-id8guard-"));
    const postsDir = resolve(dir, "posts");
    mkdirSync(postsDir, { recursive: true });
    return { postsDir };
  }

  it("lança erro claro pra id8 com path traversal, sem escrever nada", () => {
    const { postsDir } = setup();
    assert.throws(
      () => applyKitClicks('{"clicks":[]}', { id8: "../escape", append: false, postsDir }),
      /--id8 inválido/,
    );
    assert.equal(existsSync(resolve(postsDir, "..", "escape.json")), false);
  });
});

describe("isRecognizedEmptyKitShape (#6642 review — distingue '0 cliques reais' de 'shape não reconhecido')", () => {
  it("reconhece array nu (vazio ou não)", () => {
    assert.equal(isRecognizedEmptyKitShape([]), true);
    assert.equal(isRecognizedEmptyKitShape([{ url: "a" }]), true);
  });
  it("reconhece os 3 envelopes com clicks: []", () => {
    assert.equal(isRecognizedEmptyKitShape({ clicks: [] }), true);
    assert.equal(isRecognizedEmptyKitShape({ data: [] }), true);
    assert.equal(isRecognizedEmptyKitShape({ broadcast: { clicks: [] } }), true);
  });
  it("NÃO reconhece shape sem clicks/data em nenhum lugar — sinal de erro real da API", () => {
    assert.equal(isRecognizedEmptyKitShape({ error: "rate limited" }), false);
    assert.equal(isRecognizedEmptyKitShape({}), false);
    assert.equal(isRecognizedEmptyKitShape({ broadcast: { id: 1 } }), false);
    assert.equal(isRecognizedEmptyKitShape(null), false);
    assert.equal(isRecognizedEmptyKitShape(42), false);
  });
});
