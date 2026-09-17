/**
 * semantic-tiebreaker-8211.test.ts (#8211)
 *
 * Cobre os critérios de pronto da issue:
 *   - flag DESLIGADA → resultado byte-a-byte idêntico ao input.
 *   - flag ligada + API indisponível (fetch stubado lançando/retornando erro,
 *     ou TYPESAFE_API_KEY ausente) → idêntico ao de hoje, com log.
 *   - composição com #160: veredito lancamento em URL não-oficial vira radar.
 *   - reclassificação de verdade quando o classificador desempata (fetch
 *     stubado com resposta fixa — NUNCA chama a rede real).
 *
 * Todos os testes injetam `fetchImpl`/`configPath`/`rootDir` — nenhum toca
 * `platform.config.json` real nem `data/run-log.jsonl` real.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applySemanticTiebreaker,
  composeWithOfficialDomainGate,
  parseTypeSafeResponse,
  readSemanticTiebreakerConfig,
  isSemanticTiebreakerEnabled,
  type CategorizedBuckets,
} from "../scripts/lib/semantic-tiebreaker.ts";
import type { Article } from "../scripts/lib/types/article.ts";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "semantic-tiebreaker-test-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(enabled: boolean): string {
  const configPath = join(tmpDir, "platform.config.json");
  writeFileSync(configPath, JSON.stringify({ semantic_tiebreaker: { enabled } }), "utf8");
  return configPath;
}

function article(overrides: Partial<Article> & { url: string }): Article {
  return { title: "t", summary: "s", category: "noticias", ...overrides } as Article;
}

function emptyBuckets(overrides: Partial<CategorizedBuckets> = {}): CategorizedBuckets {
  return { lancamento: [], radar: [], use_melhor: [], video: [], ...overrides };
}

// ---------------------------------------------------------------------------
// Config reader — fail-soft
// ---------------------------------------------------------------------------

describe("readSemanticTiebreakerConfig / isSemanticTiebreakerEnabled (#8211)", () => {
  it("arquivo ausente → enabled:false", () => {
    const cfg = readSemanticTiebreakerConfig(join(tmpDir, "nope.json"));
    assert.equal(cfg.enabled, false);
  });

  it("JSON malformado → enabled:false (fail-soft, nunca liga sozinho)", () => {
    const p = join(tmpDir, "platform.config.json");
    writeFileSync(p, "{ not json", "utf8");
    assert.equal(isSemanticTiebreakerEnabled(p), false);
  });

  it("chave ausente no config → enabled:false", () => {
    const p = join(tmpDir, "platform.config.json");
    writeFileSync(p, JSON.stringify({ other_key: {} }), "utf8");
    assert.equal(isSemanticTiebreakerEnabled(p), false);
  });

  it("enabled:true no config → true", () => {
    const p = writeConfig(true);
    assert.equal(isSemanticTiebreakerEnabled(p), true);
  });
});

// ---------------------------------------------------------------------------
// Critério de pronto 1: flag DESLIGADA → idêntico ao de hoje
// ---------------------------------------------------------------------------

describe("applySemanticTiebreaker — flag desligada (#8211 critério de pronto 1)", () => {
  it("devolve o mesmo objeto de buckets sem chamar fetch algum", async () => {
    const configPath = writeConfig(false);
    const buckets = emptyBuckets({
      lancamento: [article({ url: "https://openai.com/index/x", category_rule: "lancamento-default" })],
      radar: [article({ url: "https://example.com/y", category_rule: "noticias-default" })],
    });
    let fetchCalled = false;
    const fakeFetch = (async () => {
      fetchCalled = true;
      throw new Error("fetch não deveria ter sido chamado");
    }) as unknown as typeof fetch;

    const out = await applySemanticTiebreaker(buckets, {
      configPath,
      apiKey: "whatever",
      fetchImpl: fakeFetch,
      rootDir: tmpDir,
    });

    assert.equal(fetchCalled, false);
    assert.equal(out.applied, false);
    assert.equal(out.reclassified, 0);
    assert.deepEqual(out.result, buckets);
  });
});

// ---------------------------------------------------------------------------
// Critério de pronto 2: flag ligada + API indisponível → idêntico, com log
// ---------------------------------------------------------------------------

describe("applySemanticTiebreaker — flag ligada, API indisponível (#8211 critério de pronto 2)", () => {
  it("TYPESAFE_API_KEY ausente → idêntico, loga em run-log.jsonl", async () => {
    const configPath = writeConfig(true);
    const buckets = emptyBuckets({
      lancamento: [article({ url: "https://openai.com/index/x", category_rule: "lancamento-default" })],
    });

    const out = await applySemanticTiebreaker(buckets, {
      configPath,
      apiKey: undefined, // simula ausência de TYPESAFE_API_KEY
      rootDir: tmpDir,
      edition: "260917",
    });

    assert.equal(out.applied, false);
    assert.equal(out.reclassified, 0);
    assert.deepEqual(out.result, buckets);

    const logPath = join(tmpDir, "data", "run-log.jsonl");
    assert.equal(existsSync(logPath), true, "run-log.jsonl deveria ter sido escrito");
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.level, "warn");
    assert.equal(last.agent, "semantic-tiebreaker");
    assert.match(last.message, /TYPESAFE_API_KEY ausente/);
  });

  it("fetch lança (rede/timeout) → idêntico, loga em run-log.jsonl", async () => {
    const configPath = writeConfig(true);
    const buckets = emptyBuckets({
      radar: [article({ url: "https://example.com/y", category_rule: "noticias-default" })],
    });
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const out = await applySemanticTiebreaker(buckets, {
      configPath,
      apiKey: "key123",
      fetchImpl: fakeFetch,
      rootDir: tmpDir,
    });

    assert.equal(out.applied, false);
    assert.deepEqual(out.result, buckets);
    const logPath = join(tmpDir, "data", "run-log.jsonl");
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    assert.match(last.message, /TypeSafe indisponível/);
  });

  it("fetch responde HTTP 500 → idêntico, loga em run-log.jsonl", async () => {
    const configPath = writeConfig(true);
    const buckets = emptyBuckets({
      radar: [article({ url: "https://example.com/y", category_rule: "noticias-default" })],
    });
    const fakeFetch = (async () =>
      new Response("server error", { status: 500 })) as unknown as typeof fetch;

    const out = await applySemanticTiebreaker(buckets, {
      configPath,
      apiKey: "key123",
      fetchImpl: fakeFetch,
      rootDir: tmpDir,
    });

    assert.equal(out.applied, false);
    assert.deepEqual(out.result, buckets);
  });

  it("resposta sem array `answers` → idêntico (falha de shape tratada como falha de transporte)", async () => {
    const configPath = writeConfig(true);
    const buckets = emptyBuckets({
      radar: [article({ url: "https://example.com/y", category_rule: "noticias-default" })],
    });
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ nope: true }), { status: 200 })) as unknown as typeof fetch;

    const out = await applySemanticTiebreaker(buckets, {
      configPath,
      apiKey: "key123",
      fetchImpl: fakeFetch,
      rootDir: tmpDir,
    });

    assert.equal(out.applied, false);
    assert.deepEqual(out.result, buckets);
  });

  it("nenhum artigo com rule de fallback → applied:true, 0 reclassificações, sem chamar fetch", async () => {
    const configPath = writeConfig(true);
    const buckets = emptyBuckets({
      lancamento: [article({ url: "https://openai.com/index/x", category_rule: "lancamento-type-hint" })],
    });
    let fetchCalled = false;
    const fakeFetch = (async () => {
      fetchCalled = true;
      throw new Error("não deveria chamar");
    }) as unknown as typeof fetch;

    const out = await applySemanticTiebreaker(buckets, {
      configPath,
      apiKey: "key123",
      fetchImpl: fakeFetch,
      rootDir: tmpDir,
    });

    assert.equal(fetchCalled, false);
    assert.equal(out.applied, true);
    assert.equal(out.reclassified, 0);
    assert.deepEqual(out.result, buckets);
  });
});

// ---------------------------------------------------------------------------
// Critério de pronto 3: composição com #160
// ---------------------------------------------------------------------------

describe("composeWithOfficialDomainGate (#8211 critério de pronto 3, #160)", () => {
  it("veredito lancamento em URL de domínio oficial → lancamento", () => {
    assert.equal(composeWithOfficialDomainGate("lancamento", "https://openai.com/index/gpt-6"), "lancamento");
  });

  it("veredito lancamento em URL NÃO-oficial (imprensa) → radar", () => {
    assert.equal(composeWithOfficialDomainGate("lancamento", "https://techcrunch.com/2026/09/17/openai-launches-x"), "radar");
  });

  it("veredito radar sempre vira radar, independente do domínio", () => {
    assert.equal(composeWithOfficialDomainGate("radar", "https://openai.com/index/report"), "radar");
  });
});

// ---------------------------------------------------------------------------
// Reclassificação de ponta a ponta com fetch stubado
// ---------------------------------------------------------------------------

describe("applySemanticTiebreaker — reclassificação real via fetch stubado (#8211)", () => {
  it("radar (noticias-default) → lancamento quando URL é oficial e classificador desempata lancamento", async () => {
    const configPath = writeConfig(true);
    const url = "https://openai.com/index/new-model";
    const buckets = emptyBuckets({
      radar: [article({ url, category: "noticias", category_rule: "noticias-default" })],
    });
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ answers: [{ id: url, answer: "lancamento" }] }), { status: 200 })) as unknown as typeof fetch;

    const out = await applySemanticTiebreaker(buckets, { configPath, apiKey: "k", fetchImpl: fakeFetch, rootDir: tmpDir });

    assert.equal(out.applied, true);
    assert.equal(out.reclassified, 1);
    assert.equal(out.result.radar.length, 0);
    assert.equal(out.result.lancamento.length, 1);
    assert.equal(out.result.lancamento[0].category, "lancamento");
    assert.equal(out.result.lancamento[0].category_rule, "semantic-tiebreaker-lancamento");
  });

  it("radar (noticias-default) → lancamento vetado por #160 (URL não-oficial) fica em radar, rule marca o motivo", async () => {
    const configPath = writeConfig(true);
    const url = "https://techcrunch.com/2026/09/17/openai-launches-x";
    const buckets = emptyBuckets({
      radar: [article({ url, category: "noticias", category_rule: "noticias-default" })],
    });
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ answers: [{ id: url, answer: "lancamento" }] }), { status: 200 })) as unknown as typeof fetch;

    const out = await applySemanticTiebreaker(buckets, { configPath, apiKey: "k", fetchImpl: fakeFetch, rootDir: tmpDir });

    assert.equal(out.applied, true);
    assert.equal(out.reclassified, 0); // já estava em radar/noticias — só a rule muda, não o bucket
    assert.equal(out.result.lancamento.length, 0);
    assert.equal(out.result.radar.length, 1);
    assert.equal(out.result.radar[0].category_rule, "semantic-tiebreaker-radar-nonofficial");
  });

  it("lancamento (lancamento-default) → radar quando classificador desempata radar", async () => {
    const configPath = writeConfig(true);
    const url = "https://openai.com/index/celebrating-milestone";
    const buckets = emptyBuckets({
      lancamento: [article({ url, category: "lancamento", category_rule: "lancamento-default" })],
    });
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ answers: [{ id: url, answer: "radar" }] }), { status: 200 })) as unknown as typeof fetch;

    const out = await applySemanticTiebreaker(buckets, { configPath, apiKey: "k", fetchImpl: fakeFetch, rootDir: tmpDir });

    assert.equal(out.applied, true);
    assert.equal(out.reclassified, 1);
    assert.equal(out.result.lancamento.length, 0);
    assert.equal(out.result.radar.length, 1);
    assert.equal(out.result.radar[0].category, "noticias");
    assert.equal(out.result.radar[0].category_rule, "semantic-tiebreaker-radar");
  });

  it("artigo sem resposta da TypeSafe (id ausente na answers) mantém bucket original, sem contar reclassificação", async () => {
    const configPath = writeConfig(true);
    const url = "https://openai.com/index/no-answer";
    const buckets = emptyBuckets({
      lancamento: [article({ url, category: "lancamento", category_rule: "lancamento-default" })],
    });
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ answers: [] }), { status: 200 })) as unknown as typeof fetch;

    const out = await applySemanticTiebreaker(buckets, { configPath, apiKey: "k", fetchImpl: fakeFetch, rootDir: tmpDir });

    assert.equal(out.applied, true);
    assert.equal(out.reclassified, 0);
    assert.deepEqual(out.result, buckets);
  });

  it("regras FORTES (não-fallback) nunca entram na chamada — não aparecem em `items` do fetch", async () => {
    const configPath = writeConfig(true);
    const strongUrl = "https://openai.com/index/gpt-6"; // lancamento-type-hint, regra forte
    const fallbackUrl = "https://openai.com/index/other"; // lancamento-default, fallback
    const buckets = emptyBuckets({
      lancamento: [
        article({ url: strongUrl, category: "lancamento", category_rule: "lancamento-type-hint" }),
        article({ url: fallbackUrl, category: "lancamento", category_rule: "lancamento-default" }),
      ],
    });
    let sentUrls: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sentUrls = body.questions.map((q: { id: string }) => q.id);
      return new Response(JSON.stringify({ answers: [{ id: fallbackUrl, answer: "radar" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await applySemanticTiebreaker(buckets, { configPath, apiKey: "k", fetchImpl: fakeFetch, rootDir: tmpDir });

    assert.deepEqual(sentUrls, [fallbackUrl]);
    // a regra forte permanece intocada em lancamento
    assert.equal(out.result.lancamento.some((a) => a.url === strongUrl && a.category_rule === "lancamento-type-hint"), true);
    assert.equal(out.result.lancamento.some((a) => a.url === fallbackUrl), false);
    assert.equal(out.result.radar.some((a) => a.url === fallbackUrl), true);
  });
});

// ---------------------------------------------------------------------------
// parseTypeSafeResponse — parsing puro
// ---------------------------------------------------------------------------

describe("parseTypeSafeResponse (#8211)", () => {
  const items = [{ url: "https://a.com/1", title: "t", summary: "s" }];

  it("lança se raw não é objeto", () => {
    assert.throws(() => parseTypeSafeResponse(null, items));
    assert.throws(() => parseTypeSafeResponse("str", items));
  });

  it("lança se `answers` não é array", () => {
    assert.throws(() => parseTypeSafeResponse({ answers: "nope" }, items));
  });

  it("ignora entrada com id fora do conjunto de items requisitados", () => {
    const out = parseTypeSafeResponse({ answers: [{ id: "https://outro.com", answer: "radar" }] }, items);
    assert.deepEqual(out, []);
  });

  it("ignora entrada com answer não reconhecida", () => {
    const out = parseTypeSafeResponse({ answers: [{ id: items[0].url, answer: "talvez" }] }, items);
    assert.deepEqual(out, []);
  });

  it("normaliza variantes de texto (lançamento/launch, notícias/news)", () => {
    const out = parseTypeSafeResponse(
      { answers: [{ id: items[0].url, answer: "Lançamento" }] },
      items,
    );
    assert.deepEqual(out, [{ url: items[0].url, verdict: "lancamento" }]);
  });
});
