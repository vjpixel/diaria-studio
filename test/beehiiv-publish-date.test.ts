/**
 * test/beehiiv-publish-date.test.ts (#4796, #4803)
 *
 * Cobre `scripts/lib/beehiiv-publish-date.ts` — `resolvePublishDate` (override
 * por slug primeiro, `publish_date` bruto pra todo o resto) e
 * `unixSecondsToBrtDate` (a conversão Unix→BRT em si). `overrides` é sempre
 * injetado explicitamente nos testes de `resolvePublishDate` pra não depender
 * do arquivo committado (`beehiiv-publish-date-overrides.json`, hoje vazio) —
 * ver `loadPublishDateOverrides` separadamente abaixo.
 *
 * #4803 (fleet review da PR #4803): `loadPublishDateOverrides` cobre 3
 * estados — ausente, válido, malformado — e valida formato por entrada
 * (`isValidOverrideDate`, privada, testada indiretamente via
 * `loadPublishDateOverrides`/`resolvePublishDate`). Os testes de "arquivo
 * malformado"/"entrada inválida" usam `overridesPath` injetável pra apontar
 * pra um fixture temporário — nunca tocam nem cacheiam o arquivo committado.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadPublishDateOverrides,
  resolvePublishDate,
  unixSecondsToBrtDate,
} from "../scripts/lib/beehiiv-publish-date.ts";

describe("unixSecondsToBrtDate (#4796)", () => {
  it("converte publish_date (Unix seconds) pra YYYY-MM-DD ajustado pra BRT (UTC-3)", () => {
    // 2026-07-28T02:00:00Z → BRT (UTC-3) é 2026-07-27 23:00 — ainda dia 27.
    const unixSeconds = Date.UTC(2026, 6, 28, 2, 0, 0) / 1000;
    assert.equal(unixSecondsToBrtDate(unixSeconds), "2026-07-27");
  });

  it("horário BRT dentro do mesmo dia UTC não muda a data", () => {
    const unixSeconds = Date.UTC(2026, 6, 28, 18, 0, 0) / 1000;
    assert.equal(unixSecondsToBrtDate(unixSeconds), "2026-07-28");
  });
});

describe("resolvePublishDate (#4796)", () => {
  it("slug presente no override: devolve a data do override, NÃO o publish_date bruto", () => {
    // publish_date aponta pro dia do import em lote (2025-09-03) — a data
    // real do override é bem anterior, cenário das 6 primeiras edições.
    const publishDateUnix = Date.UTC(2025, 8, 3, 18, 0, 0) / 1000; // 2025-09-03
    const overrides = { "edicao-antiga": "2025-06-15" };
    assert.equal(resolvePublishDate("edicao-antiga", publishDateUnix, overrides), "2025-06-15");
  });

  it("slug ausente do override: comportamento idêntico ao pré-#4796 — converte publish_date bruto", () => {
    const publishDateUnix = Date.UTC(2026, 6, 28, 18, 0, 0) / 1000;
    const overrides = { "outra-edicao": "2025-06-15" };
    assert.equal(resolvePublishDate("edicao-normal", publishDateUnix, overrides), "2026-07-28");
  });

  it("overrides vazio (o estado atual do arquivo committado): comportamento pré-#4796 inalterado", () => {
    const publishDateUnix = Date.UTC(2026, 6, 28, 18, 0, 0) / 1000;
    assert.equal(resolvePublishDate("qualquer-slug", publishDateUnix, {}), "2026-07-28");
  });

  it("sem override e sem publish_date válido: retorna null, não lança", () => {
    assert.equal(resolvePublishDate("sem-data", null, {}), null);
    assert.equal(resolvePublishDate("sem-data", undefined, {}), null);
    assert.equal(resolvePublishDate("sem-data", 0, {}), null);
  });

  it("slug null/undefined nunca lança, só cai no publish_date bruto", () => {
    const publishDateUnix = Date.UTC(2026, 6, 28, 18, 0, 0) / 1000;
    assert.equal(resolvePublishDate(null, publishDateUnix, {}), "2026-07-28");
    assert.equal(resolvePublishDate(undefined, publishDateUnix, {}), "2026-07-28");
  });

  it("#4803 achado 3: override '' é tratado como AUSENTE (checagem por chave, não truthy), cai no publish_date bruto", () => {
    const publishDateUnix = Date.UTC(2026, 6, 28, 18, 0, 0) / 1000;
    const overrides = { "slug-com-placeholder": "" };
    assert.equal(resolvePublishDate("slug-com-placeholder", publishDateUnix, overrides), "2026-07-28");
  });

  it("#4803 achado 2/3: override de formato inválido injetado direto (sem passar por loadPublishDateOverrides) é rejeitado, não aceito como data", () => {
    const publishDateUnix = Date.UTC(2026, 6, 28, 18, 0, 0) / 1000;
    const overrides = { "slug-invalido": "2025-13-45" };
    assert.equal(resolvePublishDate("slug-invalido", publishDateUnix, overrides), "2026-07-28");
  });
});

describe("loadPublishDateOverrides (#4796)", () => {
  it("carrega o arquivo committado sem lançar e devolve overrides vazio (hoje, aguardando as 6 datas reais)", () => {
    const result = loadPublishDateOverrides();
    assert.equal(typeof result, "object");
    assert.deepEqual(result.overrides, {});
    assert.equal(result.error, undefined);
    assert.deepEqual(result.discarded, []);
  });
});

describe("loadPublishDateOverrides — arquivo custom (#4803)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "beehiiv-publish-date-overrides-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente: overrides vazio, SEM error (estado esperado, não um problema)", () => {
    const path = join(tmpDir, "nao-existe.json");
    const result = loadPublishDateOverrides(path);
    assert.deepEqual(result.overrides, {});
    assert.equal(result.error, undefined);
    assert.deepEqual(result.discarded, []);
  });

  it("achado 1: JSON malformado NUNCA lança — retorna {overrides: {}, error: <mensagem>} distinguível de 'arquivo ausente'", () => {
    const path = join(tmpDir, "overrides.json");
    writeFileSync(path, "{ isso não é JSON válido", "utf8");
    const result = loadPublishDateOverrides(path);
    assert.deepEqual(result.overrides, {});
    assert.ok(result.error, "error deve estar setado pra JSON malformado — indistinguível de 'ausente' seria o bug do achado 1");
    assert.equal(typeof result.error, "string");
  });

  it("achado 2: valor de override com formato inválido (mês/dia fora de alcance) é descartado, não aceito como data canônica", () => {
    const path = join(tmpDir, "overrides.json");
    writeFileSync(path, JSON.stringify({ overrides: { "edicao-x": "2025-13-45" } }), "utf8");
    const result = loadPublishDateOverrides(path);
    assert.deepEqual(result.overrides, {}, "entrada inválida não deve aparecer em overrides");
    assert.equal(result.discarded.length, 1);
    assert.match(result.discarded[0], /edicao-x/);
  });

  it("achado 2: valor não-string (número) é descartado com warning", () => {
    const path = join(tmpDir, "overrides.json");
    writeFileSync(path, JSON.stringify({ overrides: { "edicao-y": 20250615 } }), "utf8");
    const result = loadPublishDateOverrides(path);
    assert.deepEqual(result.overrides, {});
    assert.equal(result.discarded.length, 1);
    assert.match(result.discarded[0], /edicao-y/);
  });

  it("achado 2/3: valor '' é descartado com warning (mesmo caminho de validação da entrada inválida)", () => {
    const path = join(tmpDir, "overrides.json");
    writeFileSync(path, JSON.stringify({ overrides: { "edicao-z": "" } }), "utf8");
    const result = loadPublishDateOverrides(path);
    assert.deepEqual(result.overrides, {});
    assert.equal(result.discarded.length, 1);
  });

  it("rollover silencioso (dia 30 de fevereiro) bate o regex mas não é uma data real — descartado", () => {
    const path = join(tmpDir, "overrides.json");
    writeFileSync(path, JSON.stringify({ overrides: { "edicao-v": "2025-02-30" } }), "utf8");
    const result = loadPublishDateOverrides(path);
    assert.deepEqual(result.overrides, {});
    assert.equal(result.discarded.length, 1);
  });

  it("formato de data errado (DD/MM/YYYY) é descartado — só YYYY-MM-DD é aceito", () => {
    const path = join(tmpDir, "overrides.json");
    writeFileSync(path, JSON.stringify({ overrides: { "edicao-w": "15/06/2025" } }), "utf8");
    const result = loadPublishDateOverrides(path);
    assert.deepEqual(result.overrides, {});
    assert.equal(result.discarded.length, 1);
  });

  it("mistura de entrada válida e inválida: só a válida sobrevive, a inválida vai pra discarded", () => {
    const path = join(tmpDir, "overrides.json");
    writeFileSync(
      path,
      JSON.stringify({ overrides: { "edicao-boa": "2025-06-15", "edicao-ruim": "2025-99-99" } }),
      "utf8",
    );
    const result = loadPublishDateOverrides(path);
    assert.deepEqual(result.overrides, { "edicao-boa": "2025-06-15" });
    assert.equal(result.discarded.length, 1);
    assert.match(result.discarded[0], /edicao-ruim/);
  });

  it("path custom nunca usa nem escreve o cache do path default — chamadas repetidas relêem o arquivo", () => {
    const path = join(tmpDir, "overrides.json");
    writeFileSync(path, JSON.stringify({ overrides: { s1: "2025-06-15" } }), "utf8");
    const first = loadPublishDateOverrides(path);
    assert.deepEqual(first.overrides, { s1: "2025-06-15" });

    // Reescreve o MESMO path com conteúdo diferente — se estivesse cacheando
    // por engano, a 2ª leitura devolveria o valor antigo.
    writeFileSync(path, JSON.stringify({ overrides: { s2: "2025-07-01" } }), "utf8");
    const second = loadPublishDateOverrides(path);
    assert.deepEqual(second.overrides, { s2: "2025-07-01" });

    // O path default (arquivo committado, vazio) continua intocado por essas chamadas.
    const defaultResult = loadPublishDateOverrides();
    assert.deepEqual(defaultResult.overrides, {});
  });
});
