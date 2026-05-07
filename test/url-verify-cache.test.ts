import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCache,
  saveCache,
  getCached,
  setCached,
  isCacheableVerdict,
  getCachedBody,
  MAX_CACHED_BODY_SIZE,
  DEFAULT_TTL_MS,
  type CacheEntry,
} from "../scripts/lib/url-verify-cache.ts";

describe("isCacheableVerdict (#717 hyp 2)", () => {
  it("aceita os 3 verdicts cacheáveis", () => {
    assert.equal(isCacheableVerdict("accessible"), true);
    assert.equal(isCacheableVerdict("blocked"), true);
    assert.equal(isCacheableVerdict("paywall"), true);
  });

  it("rejeita verdicts não-cacheáveis", () => {
    assert.equal(isCacheableVerdict("uncertain"), false);
    assert.equal(isCacheableVerdict("anti_bot"), false);
    assert.equal(isCacheableVerdict("aggregator"), false);
    assert.equal(isCacheableVerdict("video"), false);
    assert.equal(isCacheableVerdict("error"), false);
    assert.equal(isCacheableVerdict("weird_new"), false);
  });
});

describe("loadCache / saveCache (#717 hyp 2)", () => {
  let tmpDir: string;
  let cachePath: string;
  const NOW = new Date("2026-05-06T22:00:00Z");

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "url-verify-cache-"));
    cachePath = join(tmpDir, "link-verify-cache.json");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("loadCache retorna Map vazio quando arquivo não existe", () => {
    const map = loadCache(cachePath);
    assert.equal(map.size, 0);
  });

  it("loadCache retorna Map vazio em JSON inválido", () => {
    writeFileSync(cachePath, "not json", "utf8");
    const map = loadCache(cachePath);
    assert.equal(map.size, 0);
  });

  it("loadCache retorna Map vazio em version incompatível", () => {
    writeFileSync(
      cachePath,
      JSON.stringify({ version: 99, entries: { "x": { verdict: "accessible", verified_at: NOW.toISOString() } } }),
      "utf8",
    );
    const map = loadCache(cachePath);
    assert.equal(map.size, 0);
  });

  it("loadCache filtra entries com verified_at fora do TTL", () => {
    const old = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000); // 8 dias atrás
    const recent = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000); // 3 dias atrás
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        entries: {
          "https://old.com/x": { verdict: "accessible", verified_at: old.toISOString() },
          "https://recent.com/x": { verdict: "accessible", verified_at: recent.toISOString() },
        },
      }),
      "utf8",
    );
    const map = loadCache(cachePath, DEFAULT_TTL_MS, NOW);
    assert.equal(map.size, 1);
    assert.ok(map.has("https://recent.com/x"));
    assert.ok(!map.has("https://old.com/x"));
  });

  it("loadCache filtra entries com verdict não-cacheável (defensive)", () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        entries: {
          "https://a.com/x": { verdict: "accessible", verified_at: NOW.toISOString() },
          "https://b.com/x": { verdict: "uncertain", verified_at: NOW.toISOString() }, // não-cacheável
        },
      }),
      "utf8",
    );
    const map = loadCache(cachePath, DEFAULT_TTL_MS, NOW);
    assert.equal(map.size, 1);
    assert.ok(map.has("https://a.com/x"));
  });

  it("saveCache + loadCache round-trip preserva entries cacheáveis", () => {
    const map = new Map<string, CacheEntry>();
    map.set("https://a.com/x", {
      verdict: "accessible",
      verified_at: NOW.toISOString(),
      finalUrl: "https://a.com/x/redirected",
    });
    map.set("https://b.com/x", {
      verdict: "paywall",
      verified_at: NOW.toISOString(),
      note: "known-paywall domain",
    });
    saveCache(cachePath, map);

    const loaded = loadCache(cachePath, DEFAULT_TTL_MS, NOW);
    assert.equal(loaded.size, 2);
    assert.equal(loaded.get("https://a.com/x")?.finalUrl, "https://a.com/x/redirected");
    assert.equal(loaded.get("https://b.com/x")?.note, "known-paywall domain");
  });

  it("saveCache filtra entries não-cacheáveis no save", () => {
    const map = new Map<string, CacheEntry>();
    map.set("https://a.com/x", { verdict: "accessible", verified_at: NOW.toISOString() });
    // Insere uma entry inválida via cast pra simular corruption
    map.set("https://b.com/x", { verdict: "uncertain" as never, verified_at: NOW.toISOString() });
    saveCache(cachePath, map);

    const raw = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.ok(raw.entries["https://a.com/x"]);
    assert.ok(!raw.entries["https://b.com/x"], "uncertain não deve persistir");
  });

  it("saveCache atomic via .tmp + rename (no stale .tmp file)", () => {
    const map = new Map<string, CacheEntry>();
    map.set("https://a.com/x", { verdict: "accessible", verified_at: NOW.toISOString() });
    saveCache(cachePath, map);
    // Não deveria sobrar .tmp depois do save bem-sucedido
    assert.ok(!existsSync(cachePath + ".tmp"), "tmp removido pós-rename");
    assert.ok(existsSync(cachePath));
  });
});

describe("getCached / setCached (#717 hyp 2)", () => {
  const NOW = new Date("2026-05-06T22:00:00Z");

  it("getCached retorna null quando URL não está no map", () => {
    const map = new Map<string, CacheEntry>();
    assert.equal(getCached(map, "https://x.com/y"), null);
  });

  it("getCached retorna entry quando URL presente e dentro do TTL", () => {
    const map = new Map<string, CacheEntry>();
    map.set("https://x.com/y", { verdict: "accessible", verified_at: NOW.toISOString() });
    const r = getCached(map, "https://x.com/y", DEFAULT_TTL_MS, NOW);
    assert.equal(r?.verdict, "accessible");
  });

  it("getCached retorna null quando entry expirou", () => {
    const old = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);
    const map = new Map<string, CacheEntry>();
    map.set("https://x.com/y", { verdict: "accessible", verified_at: old.toISOString() });
    const r = getCached(map, "https://x.com/y", DEFAULT_TTL_MS, NOW);
    assert.equal(r, null);
  });

  it("getCached respeita TTL custom", () => {
    const oneDayAgo = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000);
    const map = new Map<string, CacheEntry>();
    map.set("https://x.com/y", { verdict: "accessible", verified_at: oneDayAgo.toISOString() });
    // TTL 12h → 1 day ago é expirado
    assert.equal(getCached(map, "https://x.com/y", 12 * 60 * 60 * 1000, NOW), null);
    // TTL 2 dias → ainda válido
    assert.ok(getCached(map, "https://x.com/y", 2 * 24 * 60 * 60 * 1000, NOW) !== null);
  });

  it("setCached adiciona com verified_at auto se omitido", () => {
    const map = new Map<string, CacheEntry>();
    setCached(map, "https://x.com/y", { verdict: "accessible" }, NOW);
    const entry = map.get("https://x.com/y");
    assert.equal(entry?.verdict, "accessible");
    assert.equal(entry?.verified_at, NOW.toISOString());
  });

  it("setCached aceita verified_at explícito", () => {
    const map = new Map<string, CacheEntry>();
    const explicit = "2026-05-01T12:00:00.000Z";
    setCached(map, "https://x.com/y", { verdict: "blocked", verified_at: explicit });
    assert.equal(map.get("https://x.com/y")?.verified_at, explicit);
  });

  it("setCached ignora verdicts não-cacheáveis (defensive)", () => {
    const map = new Map<string, CacheEntry>();
    setCached(map, "https://x.com/y", { verdict: "uncertain" as never });
    assert.equal(map.size, 0);
  });

  it("setCached preserva note e finalUrl", () => {
    const map = new Map<string, CacheEntry>();
    setCached(map, "https://x.com/y", {
      verdict: "paywall",
      note: "known-paywall domain",
      finalUrl: "https://x.com/y/redirected",
    });
    const entry = map.get("https://x.com/y");
    assert.equal(entry?.note, "known-paywall domain");
    assert.equal(entry?.finalUrl, "https://x.com/y/redirected");
  });
});

describe("getCachedBody — body fallback cross-edição (#866)", () => {
  it("retorna null quando URL não está no cache", () => {
    const map = new Map<string, CacheEntry>();
    assert.equal(getCachedBody(map, "https://x.com/y"), null);
  });

  it("retorna null quando entry não tem body persistido", () => {
    const map = new Map<string, CacheEntry>();
    setCached(map, "https://x.com/y", {
      verdict: "accessible",
      finalUrl: "https://x.com/y",
    });
    assert.equal(getCachedBody(map, "https://x.com/y"), null);
  });

  it("retorna body quando entry tem body persistido", () => {
    const map = new Map<string, CacheEntry>();
    const html = "<html><head>...</head><body>conteúdo</body></html>";
    setCached(map, "https://x.com/y", {
      verdict: "accessible",
      finalUrl: "https://x.com/y",
      body: html,
    });
    assert.equal(getCachedBody(map, "https://x.com/y"), html);
  });

  it("body persiste através de save+load round trip", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "verify-cache-body-"));
    const cachePath = join(tmpDir, "cache.json");
    try {
      const map = new Map<string, CacheEntry>();
      const html = "<html>conteúdo cached</html>";
      setCached(map, "https://x.com/y", {
        verdict: "accessible",
        finalUrl: "https://x.com/y",
        body: html,
      });
      saveCache(cachePath, map);

      const loaded = loadCache(cachePath);
      assert.equal(getCachedBody(loaded, "https://x.com/y"), html);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("body acima de MAX_CACHED_BODY_SIZE é stripado em save", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "verify-cache-body-big-"));
    const cachePath = join(tmpDir, "cache.json");
    try {
      const map = new Map<string, CacheEntry>();
      const tooBig = "a".repeat(MAX_CACHED_BODY_SIZE + 1);
      setCached(map, "https://x.com/y", {
        verdict: "accessible",
        finalUrl: "https://x.com/y",
        body: tooBig,
      });
      saveCache(cachePath, map);

      const loaded = loadCache(cachePath);
      assert.equal(loaded.get("https://x.com/y")?.body, undefined);
      // Mas o resto da entry está preservado
      assert.equal(loaded.get("https://x.com/y")?.verdict, "accessible");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("body inserido via JSON externo acima do limite é stripado em load", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "verify-cache-body-tampered-"));
    const cachePath = join(tmpDir, "cache.json");
    try {
      const tooBig = "x".repeat(MAX_CACHED_BODY_SIZE + 100);
      // Escrever arquivo direto (bypass saveCache) com body acima do limite
      const file = {
        version: 1,
        entries: {
          "https://tampered.com/y": {
            verdict: "accessible",
            verified_at: new Date().toISOString(),
            finalUrl: "https://tampered.com/y",
            body: tooBig,
          },
        },
      };
      writeFileSync(cachePath, JSON.stringify(file), "utf8");

      const loaded = loadCache(cachePath);
      // Body stripado, resto preservado (defensive ao tampering)
      assert.equal(loaded.get("https://tampered.com/y")?.body, undefined);
      assert.equal(loaded.get("https://tampered.com/y")?.verdict, "accessible");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
