import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyHttpStatus,
  detectSoft404Title,
  runBounded,
  shouldBypassHeadFor,
  BROWSER_UA,
} from "../scripts/verify-accessibility.ts";

const TRUSTED_HOST = "techcrunch.com"; // está em TRUSTED_PUBLISHERS
const UNKNOWN_HOST = "someblog.example.com"; // não está

describe("classifyHttpStatus (#696) — 429 sempre anti_bot", () => {
  it("429 em publisher não-trusted → anti_bot (não blocked)", () => {
    const r = classifyHttpStatus(429, UNKNOWN_HOST, "HEAD");
    assert.ok(r, "deve retornar resultado");
    assert.equal(r!.verdict, "anti_bot");
    assert.equal(r!.access_uncertain, true);
    assert.ok(r!.note?.includes("rate limited"), `note deve mencionar rate limited, got: ${r!.note}`);
  });

  it("429 em publisher trusted → também anti_bot", () => {
    const r = classifyHttpStatus(429, TRUSTED_HOST, "HEAD");
    assert.ok(r);
    assert.equal(r!.verdict, "anti_bot");
    assert.ok(r!.note?.includes("rate limited"));
  });

  it("429 no GET → anti_bot com note GET", () => {
    const r = classifyHttpStatus(429, UNKNOWN_HOST, "GET");
    assert.ok(r);
    assert.equal(r!.verdict, "anti_bot");
    assert.ok(r!.note?.includes("GET"));
  });

  it("403 em publisher trusted → anti_bot (#320)", () => {
    const r = classifyHttpStatus(403, TRUSTED_HOST, "HEAD");
    assert.ok(r);
    assert.equal(r!.verdict, "anti_bot");
    assert.ok(r!.note?.includes("trusted publisher"));
  });

  it("403 em publisher NÃO-trusted → blocked (comportamento existente preservado)", () => {
    const r = classifyHttpStatus(403, UNKNOWN_HOST, "HEAD");
    assert.ok(r);
    assert.equal(r!.verdict, "blocked");
    assert.equal(r!.access_uncertain, undefined, "blocked não deve ter access_uncertain");
  });

  it("404 em qualquer domínio → blocked", () => {
    assert.equal(classifyHttpStatus(404, UNKNOWN_HOST, "HEAD")?.verdict, "blocked");
    assert.equal(classifyHttpStatus(404, TRUSTED_HOST, "HEAD")?.verdict, "blocked");
  });

  it("500 → blocked", () => {
    assert.equal(classifyHttpStatus(500, UNKNOWN_HOST, "GET")?.verdict, "blocked");
  });

  it("200 → null (sem erro)", () => {
    assert.equal(classifyHttpStatus(200, UNKNOWN_HOST, "HEAD"), null);
  });

  it("301 → null (sem erro)", () => {
    assert.equal(classifyHttpStatus(301, UNKNOWN_HOST, "HEAD"), null);
  });
});

describe("detectSoft404Title (#695) — soft 404 via título", () => {
  it("título '404 Not Found' → retorna título", () => {
    const body = `<html><head><title>404 Not Found</title></head><body>${"x".repeat(1000)}</body></html>`;
    const result = detectSoft404Title(body);
    assert.ok(result, "deve detectar soft 404");
    assert.ok(result!.includes("404"));
  });

  it("título 'Página não encontrada' → retorna título", () => {
    const body = `<html><head><title>Página não encontrada</title></head><body>${"x".repeat(1000)}</body></html>`;
    assert.ok(detectSoft404Title(body));
  });

  it("título 'Page not found | TechCrunch' → retorna título", () => {
    const body = `<html><head><title>Page not found | TechCrunch</title></head><body>${"x".repeat(1000)}</body></html>`;
    assert.ok(detectSoft404Title(body));
  });

  it("título 'Artigo não encontrado' → retorna título", () => {
    const body = `<html><head><title>Artigo não encontrado - Canaltech</title></head><body>${"x".repeat(1000)}</body></html>`;
    assert.ok(detectSoft404Title(body));
  });

  it("artigo técnico sem padrão de 404 no título → null", () => {
    const body = `<html><head><title>Como configurar rotas no nginx corretamente</title></head><body>${"x".repeat(1000)}</body></html>`;
    assert.equal(detectSoft404Title(body), null);
  });

  it("artigo normal → null", () => {
    const body = `<html><head><title>OpenAI anuncia GPT-5</title></head><body>${"x".repeat(1000)}</body></html>`;
    assert.equal(detectSoft404Title(body), null);
  });

  it("sem tag <title> → null", () => {
    const body = `<html><body>${"x".repeat(1000)}</body></html>`;
    assert.equal(detectSoft404Title(body), null);
  });

  it("título vazio → null", () => {
    const body = `<html><head><title></title></head><body>${"x".repeat(1000)}</body></html>`;
    assert.equal(detectSoft404Title(body), null);
  });

  it("case insensitive — 'NOT FOUND' → detecta", () => {
    const body = `<html><head><title>NOT FOUND</title></head><body>${"x".repeat(1000)}</body></html>`;
    assert.ok(detectSoft404Title(body));
  });
});

describe("runBounded — bounded worker pool (#717 hyp 3)", () => {
  it("processa todos os indices fornecidos exatamente uma vez", async () => {
    const indices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const visited: number[] = [];
    await runBounded(indices, 3, async (idx) => {
      visited.push(idx);
    });
    assert.equal(visited.length, indices.length);
    assert.deepEqual([...visited].sort((a, b) => a - b), indices);
  });

  it("respeita cap de concorrência (no máximo N tasks ativas em paralelo)", async () => {
    const indices = Array.from({ length: 20 }, (_, i) => i);
    let active = 0;
    let peak = 0;
    await runBounded(indices, 4, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    assert.ok(peak <= 4, `peak active deveria ser ≤ 4, foi ${peak}`);
    assert.ok(peak >= 1, `peak active deveria ser ≥ 1, foi ${peak}`);
  });

  it("concurrency=1 vira execução serial", async () => {
    const indices = [0, 1, 2, 3, 4];
    let active = 0;
    let peak = 0;
    await runBounded(indices, 1, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
    });
    assert.equal(peak, 1);
  });

  it("concurrency 0 é tratado como 1 (não trava)", async () => {
    const indices = [0, 1, 2];
    const visited: number[] = [];
    await runBounded(indices, 0, async (idx) => {
      visited.push(idx);
    });
    assert.equal(visited.length, 3);
  });

  it("array vazio é no-op", async () => {
    let called = 0;
    await runBounded([], 4, async () => {
      called++;
    });
    assert.equal(called, 0);
  });

  it("concurrency > indices.length usa apenas indices.length workers efetivos", async () => {
    const indices = [0, 1];
    let active = 0;
    let peak = 0;
    await runBounded(indices, 10, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 3));
      active--;
    });
    assert.ok(peak <= 2, `peak deveria ser ≤ 2, foi ${peak}`);
  });

  it("propaga indices arbitrários (não precisa ser 0..N)", async () => {
    const indices = [42, 100, 7];
    const visited: number[] = [];
    await runBounded(indices, 2, async (idx) => {
      visited.push(idx);
    });
    assert.deepEqual([...visited].sort((a, b) => a - b), [7, 42, 100]);
  });
});

describe("classifyHttpStatus (#899) — 405/406 em trusted publisher = anti_bot", () => {
  it("406 em theguardian.com → anti_bot (bot blocking típico)", () => {
    const r = classifyHttpStatus(406, "theguardian.com", "HEAD");
    assert.ok(r);
    assert.equal(r!.verdict, "anti_bot");
    assert.equal(r!.access_uncertain, true);
    assert.ok(r!.note?.includes("trusted publisher"));
  });

  it("405 em bbc.com → anti_bot", () => {
    const r = classifyHttpStatus(405, "bbc.com", "HEAD");
    assert.ok(r);
    assert.equal(r!.verdict, "anti_bot");
  });

  it("406 em domínio NÃO-trusted → blocked (preserva comportamento)", () => {
    const r = classifyHttpStatus(406, "random-blog.example.com", "HEAD");
    assert.ok(r);
    assert.equal(r!.verdict, "blocked");
  });

  it("405/406 em GET continua sendo anti_bot em trusted publisher", () => {
    assert.equal(classifyHttpStatus(405, "bloomberg.com", "GET")?.verdict, "anti_bot");
    assert.equal(classifyHttpStatus(406, "theguardian.com", "GET")?.verdict, "anti_bot");
  });
});

describe("shouldBypassHeadFor (#899) — trusted publishers pulam HEAD", () => {
  it("theguardian.com → true", () => {
    assert.equal(shouldBypassHeadFor("theguardian.com"), true);
  });

  it("bbc.com → true", () => {
    assert.equal(shouldBypassHeadFor("bbc.com"), true);
  });

  it("bloomberg.com → true", () => {
    assert.equal(shouldBypassHeadFor("bloomberg.com"), true);
  });

  it("anthropic.com → true (já estava em trusted publishers)", () => {
    assert.equal(shouldBypassHeadFor("anthropic.com"), true);
  });

  it("random domain → false", () => {
    assert.equal(shouldBypassHeadFor("randomblog.example.com"), false);
  });
});

describe("BROWSER_UA (#899)", () => {
  it("é UA Chrome típico (passa em sites com bot detection básico)", () => {
    assert.ok(BROWSER_UA.includes("Mozilla/5.0"));
    assert.ok(BROWSER_UA.includes("Chrome"));
    assert.ok(BROWSER_UA.includes("Safari"));
  });
});
