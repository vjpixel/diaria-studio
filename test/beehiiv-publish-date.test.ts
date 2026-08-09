/**
 * test/beehiiv-publish-date.test.ts (#4796)
 *
 * Cobre `scripts/lib/beehiiv-publish-date.ts` — `resolvePublishDate` (override
 * por slug primeiro, `publish_date` bruto pra todo o resto) e
 * `unixSecondsToBrtDate` (a conversão Unix→BRT em si). `overrides` é sempre
 * injetado explicitamente nos testes de `resolvePublishDate` pra não depender
 * do arquivo committado (`beehiiv-publish-date-overrides.json`, hoje vazio) —
 * ver `loadPublishDateOverrides` separadamente abaixo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

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

  it("overrides vazio (o estado atual do arquivo committado): outras ~227 edições não mudam", () => {
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
});

describe("loadPublishDateOverrides (#4796)", () => {
  it("carrega o arquivo committado sem lançar e devolve um objeto (hoje vazio, aguardando as 6 datas reais)", () => {
    const overrides = loadPublishDateOverrides();
    assert.equal(typeof overrides, "object");
    assert.deepEqual(overrides, {});
  });
});
