/**
 * research-review-dates.test.ts (#1112)
 *
 * Tests dos helpers puros do `scripts/research-review-dates.ts`:
 * - `unwrapCategorized`: aceita `{kept: {...}}` wrapper ou shape direto
 * - `applyVerifyResults`: aplica datas verified mutando categorized
 *
 * Não testa o `main()` end-to-end — esse depende de network (verifyDate
 * faz fetch real). Cobertura via integration test em smoke-pipeline.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  unwrapCategorized,
  applyVerifyResults,
} from "../scripts/research-review-dates.ts";
import type { DateVerifyResult } from "../scripts/verify-dates.ts";

function fakeResult(
  url: string,
  changed: boolean,
  fetchFailed: boolean,
  verifiedDate: string | null,
  dateUnverified = false,
): DateVerifyResult {
  return {
    url,
    original_date: "2026-05-01",
    verified_date: verifiedDate,
    changed,
    fetch_failed: fetchFailed,
    date_unverified: dateUnverified,
    fallback_strategy: "html-meta",
  } as DateVerifyResult;
}

describe("unwrapCategorized (#1112)", () => {
  it("aceita shape direto {lancamento, pesquisa, ...}", () => {
    const input = { lancamento: [{ url: "a", date: "2026-05-01" }] };
    const result = unwrapCategorized(input);
    assert.deepEqual(result, input);
  });

  it("desempacota wrapper {kept: {...}} (output de filter-date-window)", () => {
    const inner = { lancamento: [{ url: "a", date: "2026-05-01" }] };
    const result = unwrapCategorized({ kept: inner });
    assert.deepEqual(result, inner);
  });

  it("rejeita input null/string/array", () => {
    assert.throws(() => unwrapCategorized(null));
    assert.throws(() => unwrapCategorized("string"));
    assert.throws(() => unwrapCategorized(42));
  });

  it("aceita object com buckets vazios", () => {
    const result = unwrapCategorized({ lancamento: [], pesquisa: [] });
    assert.deepEqual(result, { lancamento: [], pesquisa: [] });
  });
});

describe("applyVerifyResults (#1112)", () => {
  it("aplica verified_date quando changed && !fetch_failed", () => {
    const cat = {
      lancamento: [{ url: "u1", date: "2026-05-01" }],
      pesquisa: [],
      noticias: [],
    };
    const results = [fakeResult("u1", true, false, "2026-05-10")];
    const stats = applyVerifyResults(cat, results);
    assert.equal(cat.lancamento[0].date, "2026-05-10", "data foi corrigida");
    assert.equal(stats.dateCorrected, 1);
    assert.equal(stats.fetchFailed, 0);
  });

  it("preserva data original quando changed=false", () => {
    const cat = {
      lancamento: [{ url: "u1", date: "2026-05-01" }],
      pesquisa: [],
      noticias: [],
    };
    const results = [fakeResult("u1", false, false, "2026-05-01")];
    applyVerifyResults(cat, results);
    assert.equal(cat.lancamento[0].date, "2026-05-01");
  });

  it("preserva data original quando fetch_failed (e marca date_unverified)", () => {
    const cat = {
      lancamento: [{ url: "u1", date: "2026-05-01" }] as Array<{ url: string; date: string; date_unverified?: boolean }>,
      pesquisa: [],
      noticias: [],
    };
    const results = [fakeResult("u1", true, true, null, true)];
    const stats = applyVerifyResults(cat, results);
    assert.equal(cat.lancamento[0].date, "2026-05-01", "data original preservada");
    assert.equal(cat.lancamento[0].date_unverified, true, "date_unverified copiado");
    assert.equal(stats.dateCorrected, 0);
    assert.equal(stats.fetchFailed, 1);
  });

  it("aplica em múltiplos buckets na mesma chamada", () => {
    const cat = {
      lancamento: [{ url: "u1", date: "2026-05-01" }],
      pesquisa: [{ url: "u2", date: "2026-05-02" }],
      noticias: [{ url: "u3", date: "2026-05-03" }],
    };
    const results = [
      fakeResult("u1", true, false, "2026-05-10"),
      fakeResult("u2", true, false, "2026-05-11"),
      fakeResult("u3", false, false, "2026-05-03"),
    ];
    const stats = applyVerifyResults(cat, results);
    assert.equal(cat.lancamento[0].date, "2026-05-10");
    assert.equal(cat.pesquisa[0].date, "2026-05-11");
    assert.equal(cat.noticias[0].date, "2026-05-03");
    assert.equal(stats.dateCorrected, 2);
  });

  it("ignora resultados sem entry correspondente no categorized", () => {
    const cat = {
      lancamento: [{ url: "u1", date: "2026-05-01" }],
      pesquisa: [],
      noticias: [],
    };
    const results = [
      fakeResult("u1", true, false, "2026-05-10"),
      fakeResult("u-stale", true, false, "2026-05-15"),
    ];
    const stats = applyVerifyResults(cat, results);
    assert.equal(cat.lancamento[0].date, "2026-05-10");
    assert.equal(stats.dateCorrected, 1, "só conta entries que existiam");
  });

  it("não corrige quando verified_date é null mesmo com changed=true", () => {
    // edge case: API retornou changed=true mas verified_date=null (fetch ok mas no date found)
    const cat = {
      lancamento: [{ url: "u1", date: "2026-05-01" }],
      pesquisa: [],
      noticias: [],
    };
    const results = [fakeResult("u1", true, false, null)];
    const stats = applyVerifyResults(cat, results);
    assert.equal(cat.lancamento[0].date, "2026-05-01", "preserva original quando verified=null");
    assert.equal(stats.dateCorrected, 0);
  });

  it("processa bucket vazio sem erro", () => {
    const cat = {
      lancamento: [],
      pesquisa: [],
      noticias: [],
    };
    const stats = applyVerifyResults(cat, []);
    assert.equal(stats.dateCorrected, 0);
    assert.equal(stats.fetchFailed, 0);
  });

  it("ignora bucket ausente do categorized (defensive)", () => {
    const cat = { lancamento: [{ url: "u1", date: "2026-05-01" }] };
    const results = [fakeResult("u1", true, false, "2026-05-10")];
    const stats = applyVerifyResults(cat, results);
    assert.equal(stats.dateCorrected, 1);
  });
});
