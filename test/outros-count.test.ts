/**
 * test/outros-count.test.ts (#2331/F4, #3052)
 *
 * Testa `resolveOutrosCountFromEditionDir` — extraído de publish-linkedin.ts
 * (#2331 F1/F2/F3) pra reuso por resolve-post-pixel.ts (#3052). Cobre os
 * mesmos 3 caminhos (capped OK, capped corrompido → fallback uncapped+caps,
 * nenhum legível → null) isoladamente da CLI de publish-linkedin.ts — os
 * testes de integração via spawnSync continuam em publish-linkedin.test.ts
 * (#2331/F1-F3), este arquivo cobre a função pura diretamente.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { outrosCount, resolveOutrosCountFromEditionDir } from "../scripts/lib/outros-count.ts";

describe("#2331/F4 outrosCount — soma pura de buckets", () => {
  it("soma lancamento + radar + use_melhor + video", () => {
    const count = outrosCount({
      lancamento: new Array(3),
      radar: new Array(5),
      use_melhor: new Array(2),
      video: new Array(1),
    });
    assert.equal(count, 11);
  });

  it("arrays ausentes contam como 0", () => {
    assert.equal(outrosCount({}), 0);
  });
});

describe("#3052 resolveOutrosCountFromEditionDir — resolução a partir do disco", () => {
  function setupEditionDir(): { editionDir: string; tmp: string } {
    const tmp = mkdtempSync(resolve(tmpdir(), "outros-count-"));
    const editionDir = resolve(tmp, "260999");
    mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
    return { editionDir, tmp };
  }

  it("resolve do 01-approved-capped.json quando presente e válido", () => {
    const { editionDir, tmp } = setupEditionDir();
    writeFileSync(
      resolve(editionDir, "_internal", "01-approved-capped.json"),
      JSON.stringify({
        lancamento: new Array(2),
        radar: new Array(5),
        use_melhor: new Array(3),
        video: new Array(1),
      }),
    );
    const result = resolveOutrosCountFromEditionDir(editionDir);
    assert.equal(result, 11);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("F1: capped corrompido → fallback pro uncapped+caps", () => {
    const { editionDir, tmp } = setupEditionDir();
    writeFileSync(resolve(editionDir, "_internal", "01-approved-capped.json"), "{ corrupted json");
    writeFileSync(
      resolve(editionDir, "_internal", "01-approved.json"),
      JSON.stringify({
        highlights: [
          { article: { title: "D1", url: "https://a.com/1" } },
          { article: { title: "D2", url: "https://a.com/2" } },
          { article: { title: "D3", url: "https://a.com/3" } },
        ],
        lancamento: [
          { title: "L1", url: "https://l.com/1" },
          { title: "L2", url: "https://l.com/2" },
        ],
        radar: [
          { title: "R1", url: "https://r.com/1" },
          { title: "R2", url: "https://r.com/2" },
          { title: "R3", url: "https://r.com/3" },
          { title: "R4", url: "https://r.com/4" },
          { title: "R5", url: "https://r.com/5" },
          { title: "R6", url: "https://r.com/6" },
        ],
        use_melhor: [],
        video: [],
      }),
    );
    const result = resolveOutrosCountFromEditionDir(editionDir);
    // applyStage2Caps não deve lançar em input real; resultado deve ser um número
    // não-null (fallback funcionou), demonstrando que F1 não abandona a resolução.
    assert.notEqual(result, null);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("F3: nenhum arquivo legível → null (nunca lança)", () => {
    const { editionDir, tmp } = setupEditionDir();
    const result = resolveOutrosCountFromEditionDir(editionDir);
    assert.equal(result, null);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("F3: ambos arquivos corrompidos → null", () => {
    const { editionDir, tmp } = setupEditionDir();
    writeFileSync(resolve(editionDir, "_internal", "01-approved-capped.json"), "{ corrupted");
    writeFileSync(resolve(editionDir, "_internal", "01-approved.json"), "{ also corrupted");
    const result = resolveOutrosCountFromEditionDir(editionDir);
    assert.equal(result, null);
    rmSync(tmp, { recursive: true, force: true });
  });
});
