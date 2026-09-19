/**
 * test/blind-label-features.test.ts (#8413)
 *
 * Cobre `scripts/lib/blind-label-features.ts` — a feature real
 * `bucket-tiebreaker-8211`, que reproduz a coleta de pool "em silêncio" do
 * `scripts/blind-label-sample.ts` original (#5995/#8206) sobre a nova
 * interface genérica. Corpus sintético em tmpdir, nunca `data/editions/` real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BUCKET_TIEBREAKER_8211_FEATURE, FEATURE_REGISTRY, getFeature } from "../scripts/lib/blind-label-features.ts";

let rootDir: string;
beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "blind-label-features-test-"));
});
afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function writeEdition(aammdd: string, approved: Record<string, unknown[]>, categorized: Record<string, unknown[]>) {
  const dir = join(rootDir, "data", "editions", aammdd, "_internal");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "01-approved.json"), JSON.stringify(approved));
  writeFileSync(join(dir, "01-categorized.json"), JSON.stringify(categorized));
}

describe("getFeature / FEATURE_REGISTRY", () => {
  it("bucket-tiebreaker-8211 está registrado", () => {
    assert.equal(getFeature("bucket-tiebreaker-8211"), BUCKET_TIEBREAKER_8211_FEATURE);
    assert.ok(FEATURE_REGISTRY["bucket-tiebreaker-8211"]);
  });

  it("id desconhecido devolve undefined", () => {
    assert.equal(getFeature("nao-existe"), undefined);
  });
});

describe("BUCKET_TIEBREAKER_8211_FEATURE.collectPool", () => {
  it("devolve pool vazio sem lançar quando data/editions/ não existe", () => {
    const { pool, skipped } = BUCKET_TIEBREAKER_8211_FEATURE.collectPool(rootDir);
    assert.deepEqual(pool, []);
    assert.deepEqual(skipped, []);
  });

  it("coleta só itens do SILÊNCIO (aprovado == categorizado, mesmo bucket)", () => {
    const article = { url: "https://example.com/1", title: "Something launches", summary: "s" };
    writeEdition(
      "260101",
      { lancamento: [article], radar: [], use_melhor: [] },
      { lancamento: [article], radar: [], use_melhor: [] },
    );
    const { pool } = BUCKET_TIEBREAKER_8211_FEATURE.collectPool(rootDir);
    assert.equal(pool.length, 1);
    assert.equal(pool[0].id, article.url);
    assert.equal(pool[0].stratum, "lancamento");
    assert.equal(pool[0].jevState.title, article.title);
  });

  it("exclui item MOVIDO pelo editor entre categorizado e aprovado (é decisão, não silêncio)", () => {
    const article = { url: "https://example.com/2", title: "Moved item", summary: "s" };
    writeEdition(
      "260102",
      { lancamento: [article], radar: [], use_melhor: [] }, // aprovado: editor moveu pra lancamento
      { lancamento: [], radar: [article], use_melhor: [] }, // categorizado original: radar
    );
    const { pool } = BUCKET_TIEBREAKER_8211_FEATURE.collectPool(rootDir);
    assert.equal(pool.length, 0);
  });

  it("edição ilegível (JSON malformado) entra em `skipped`, não derruba o resto", () => {
    const dir = join(rootDir, "data", "editions", "260103", "_internal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-approved.json"), "{ json malformado");
    writeFileSync(join(dir, "01-categorized.json"), "{ json malformado");

    const article = { url: "https://example.com/3", title: "ok item", summary: "s" };
    writeEdition("260104", { lancamento: [], radar: [article], use_melhor: [] }, { lancamento: [], radar: [article], use_melhor: [] });

    const { pool, skipped } = BUCKET_TIEBREAKER_8211_FEATURE.collectPool(rootDir);
    assert.equal(pool.length, 1);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /260103/);
  });

  it("URL duplicada entre edições entra só 1x no pool", () => {
    const article = { url: "https://example.com/dup", title: "dup", summary: "s" };
    writeEdition("260105", { lancamento: [article], radar: [], use_melhor: [] }, { lancamento: [article], radar: [], use_melhor: [] });
    writeEdition("260106", { lancamento: [article], radar: [], use_melhor: [] }, { lancamento: [article], radar: [], use_melhor: [] });
    const { pool } = BUCKET_TIEBREAKER_8211_FEATURE.collectPool(rootDir);
    assert.equal(pool.filter((p) => p.id === article.url).length, 1);
  });

  it("labels aceitos incluem os 3 buckets rastreados + nao_pertence", () => {
    assert.deepEqual([...BUCKET_TIEBREAKER_8211_FEATURE.labels].sort(), ["lancamento", "nao_pertence", "radar", "use_melhor"].sort());
  });
});
