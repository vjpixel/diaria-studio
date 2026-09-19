/**
 * test/blind-label-features-grayzone-8417.test.ts (#8417 — medição 4 do epic #8412)
 *
 * Cobre a coleta de pares cross-edição das duas features novas de
 * `blind-label-features.ts` (`dedup-grayzone-8417`,
 * `highlight-themes-grayzone-8417`) — corpus sintético em tmpdir, nunca
 * `data/editions/` real. Confere: (1) só pares DENTRO da zona cinzenta
 * entram no pool, (2) `hiddenGuess` reflete o mesmo threshold com
 * entity-lowering (`thresholdForPair`) que o mecanismo real usa, (3) par
 * intra-edição e URL idêntica nunca entram.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEDUP_GRAYZONE_8417_FEATURE, HIGHLIGHT_THEMES_GRAYZONE_8417_FEATURE } from "../scripts/lib/blind-label-features.ts";

let rootDir: string;
beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "grayzone-8417-test-"));
});
afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function writeEdition(aammdd: string, categorized: Record<string, unknown[]>) {
  const dir = join(rootDir, "data", "editions", aammdd, "_internal");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "01-categorized.json"), JSON.stringify(categorized));
}

describe("DEDUP_GRAYZONE_8417_FEATURE.collectPool", () => {
  it("pool vazio sem lançar quando data/editions/ não existe", () => {
    const { pool, skipped } = DEDUP_GRAYZONE_8417_FEATURE.collectPool(rootDir);
    assert.deepEqual(pool, []);
    assert.deepEqual(skipped, []);
  });

  it("só entra no pool par cross-edição cujo Jaccard cai em [0.35, 0.70)", () => {
    // Jaccard alto (>=0.70, "OpenAI GPT modelo novo lançamento hoje" vs mesmo texto quase idêntico) — fora da zona, não entra.
    const highSim = { url: "https://a.com/high-a", title: "OpenAI lança modelo GPT novo hoje mesmo", summary: "s" };
    const highSimPast = { url: "https://a.com/high-b", title: "OpenAI lança modelo GPT novo hoje agora", summary: "s" };
    // Jaccard baixo (~0, sem token em comum) — fora da zona, não entra.
    const lowSim = { url: "https://a.com/low-a", title: "Empresa brasileira anuncia parceria bancária", summary: "s" };
    const lowSimPast = { url: "https://a.com/low-b", title: "Robô aspirador ganha nova função doméstica", summary: "s" };
    // Jaccard médio (~0.38, zona cinzenta) — DEVE entrar.
    const midA = { url: "https://a.com/mid-a", title: "GPT-6 Astra: OpenAI lança modelo mais inteligente da história do ChatGPT", summary: "s" };
    const midB = { url: "https://a.com/mid-b", title: "OpenAI lança GPT-6 Astra, modelo que atingiu nível crítico de cibersegurança", summary: "s" };

    writeEdition("260101", { lancamento: [], radar: [highSimPast, lowSimPast, midB], use_melhor: [] });
    writeEdition("260102", { lancamento: [], radar: [highSim, lowSim, midA], use_melhor: [] });

    const { pool } = DEDUP_GRAYZONE_8417_FEATURE.collectPool(rootDir);
    const ids = pool.map((p) => p.id);
    assert.ok(!ids.some((id) => id.includes("high-a")), "par de Jaccard alto não deve entrar na zona cinzenta");
    assert.ok(!ids.some((id) => id.includes("low-a")), "par de Jaccard baixo não deve entrar na zona cinzenta");
    assert.equal(pool.length, 1, `esperado 1 par na zona cinzenta, achou ${pool.length}: ${JSON.stringify(ids)}`);
    assert.ok(ids[0].includes("mid-a") && ids[0].includes("mid-b"));
  });

  it("jevState carrega title/summary/source de ambos os lados do par, nunca o hiddenGuess", () => {
    const A = { url: "https://a.com/j1", title: "GPT-6 Astra: OpenAI lança modelo mais inteligente da história do ChatGPT", summary: "resumo A", source: "Fonte A" };
    const B = { url: "https://a.com/j2", title: "OpenAI lança GPT-6 Astra, modelo que atingiu nível crítico de cibersegurança", summary: "resumo B", source: "Fonte B" };
    writeEdition("260101", { lancamento: [], radar: [B], use_melhor: [] });
    writeEdition("260102", { lancamento: [], radar: [A], use_melhor: [] });

    const { pool } = DEDUP_GRAYZONE_8417_FEATURE.collectPool(rootDir);
    assert.equal(pool.length, 1);
    const item = pool[0];
    assert.deepEqual(Object.keys(item.jevState).sort(), ["a", "b"]);
    assert.equal((item.jevState.a as any).summary, "resumo A");
    assert.equal((item.jevState.b as any).summary, "resumo B");
    assert.ok(!("hiddenGuess" in item.jevState));
    assert.ok(item.hiddenGuess === "mesma_historia" || item.hiddenGuess === "historias_distintas");
  });

  it("nunca gera par intra-edição nem par com a mesma URL", () => {
    const A = { url: "https://a.com/same", title: "Claude fica fora do ar nesta tarde", summary: "s" };
    const B = { url: "https://a.com/same2", title: "Claude fica fora do ar nesta manhã", summary: "s" };
    writeEdition("260101", { lancamento: [], radar: [A, B], use_melhor: [] }); // mesma edição — não deve parear
    const { pool } = DEDUP_GRAYZONE_8417_FEATURE.collectPool(rootDir);
    assert.equal(pool.length, 0);
  });

  it("labels aceitos", () => {
    assert.deepEqual([...DEDUP_GRAYZONE_8417_FEATURE.labels].sort(), ["historias_distintas", "mesma_historia"]);
  });

  it("edição com 01-categorized.json malformado entra em `skipped`, não derruba o resto (#8472 review)", () => {
    const badDir = join(rootDir, "data", "editions", "260103", "_internal");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "01-categorized.json"), "{ json malformado");

    const A = { url: "https://a.com/ok-a", title: "GPT-6 Astra: OpenAI lança modelo mais inteligente da história do ChatGPT", summary: "s" };
    const B = { url: "https://a.com/ok-b", title: "OpenAI lança GPT-6 Astra, modelo que atingiu nível crítico de cibersegurança", summary: "s" };
    writeEdition("260101", { lancamento: [], radar: [B], use_melhor: [] });
    writeEdition("260102", { lancamento: [], radar: [A], use_melhor: [] });

    const { pool, skipped } = DEDUP_GRAYZONE_8417_FEATURE.collectPool(rootDir);
    assert.equal(pool.length, 1, "edição boa continua produzindo par válido");
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /260103/);
  });

  it("estratifica por hiddenGuess, não por um stratum constante (#8472 review)", () => {
    // Par que o mecanismo classifica como historias_distintas (jaccard=0.38 < threshold 0.6/0.55).
    const A = { url: "https://a.com/s-a", title: "GPT-6 Astra: OpenAI lança modelo mais inteligente da história do ChatGPT", summary: "s" };
    const B = { url: "https://a.com/s-b", title: "OpenAI lança GPT-6 Astra, modelo que atingiu nível crítico de cibersegurança", summary: "s" };
    writeEdition("260101", { lancamento: [], radar: [B], use_melhor: [] });
    writeEdition("260102", { lancamento: [], radar: [A], use_melhor: [] });
    const { pool } = DEDUP_GRAYZONE_8417_FEATURE.collectPool(rootDir);
    assert.equal(pool.length, 1);
    assert.equal(pool[0].stratum, `dedup:${pool[0].hiddenGuess}`);
  });
});

describe("HIGHLIGHT_THEMES_GRAYZONE_8417_FEATURE.collectPool", () => {
  it("usa zona [0.15, 0.55) e threshold 0.35/0.25 (mais frouxo que o dedup)", () => {
    // Jaccard baixo mas dentro da zona de tema (fora da zona do dedup, que começa em 0.35).
    const A = { url: "https://a.com/t1", title: "Eleições 2026 e o uso de inteligência artificial nas campanhas", summary: "s" };
    const B = { url: "https://a.com/t2", title: "Como a inteligência artificial pode influenciar eleições no Brasil", summary: "s" };
    writeEdition("260101", { lancamento: [], radar: [B], use_melhor: [] });
    writeEdition("260102", { lancamento: [], radar: [A], use_melhor: [] });
    const { pool } = HIGHLIGHT_THEMES_GRAYZONE_8417_FEATURE.collectPool(rootDir);
    assert.equal(pool.length, 1);
    assert.match(pool[0].stratum, /^highlight_themes:/);
  });

  it("labels aceitos", () => {
    assert.deepEqual([...HIGHLIGHT_THEMES_GRAYZONE_8417_FEATURE.labels].sort(), ["mesmo_tema", "temas_distintos"]);
  });
});
