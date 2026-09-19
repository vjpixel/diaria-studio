/**
 * test/ads-live-spend-signups-8256.test.ts (#8256)
 *
 * Cobre `groupByCanalSince`, extraído de `scripts/ads-live-spend-signups.ts`
 * pra também alimentar a nova seção "Quebra por campanha (Microsoft Ads,
 * #8256)" do relatório ao vivo — sem repetir o loop de agrupamento por
 * canal uma 3ª vez. Puro, sem rede. A cobertura de rede/SOAP da separação
 * por campanha em si (gasto + cadastros) vive em
 * `test/ads-campaign-economics-fetch-8256.test.ts` — este arquivo só
 * garante que o agrupamento/filtro por `d0` que a nova seção reusa continua
 * correto, e que ele bate com o comportamento das 2 tabelas "por braço" que
 * já usavam essa lógica inline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupByCanalSince } from "../scripts/ads-live-spend-signups.ts";

describe("#8256 — groupByCanalSince (pure)", () => {
  it("agrupa por canal, preservando só o que `pick` seleciona", () => {
    const rows = [
      { canal: "Microsoft Ads (teste 2608) — PMax", date: "2026-09-05", gastoBrl: 10 },
      { canal: "Microsoft Ads (teste 2608) — Search", date: "2026-09-05", gastoBrl: 15 },
      { canal: "Microsoft Ads (teste 2608) — PMax", date: "2026-09-06", gastoBrl: 5 },
    ];
    const grouped = groupByCanalSince(rows, "2026-09-01", (r) => ({ date: r.date, gastoBrl: r.gastoBrl }));
    assert.equal(grouped.size, 2);
    assert.deepEqual(grouped.get("Microsoft Ads (teste 2608) — PMax"), [
      { date: "2026-09-05", gastoBrl: 10 },
      { date: "2026-09-06", gastoBrl: 5 },
    ]);
    assert.deepEqual(grouped.get("Microsoft Ads (teste 2608) — Search"), [{ date: "2026-09-05", gastoBrl: 15 }]);
  });

  it("descarta dias anteriores a d0 — mesmo filtro que as tabelas por braço já aplicavam", () => {
    const rows = [
      { canal: "X", date: "2026-09-04", gastoBrl: 100 },
      { canal: "X", date: "2026-09-05", gastoBrl: 10 },
    ];
    const grouped = groupByCanalSince(rows, "2026-09-05", (r) => ({ date: r.date, gastoBrl: r.gastoBrl }));
    assert.deepEqual(grouped.get("X"), [{ date: "2026-09-05", gastoBrl: 10 }]);
  });

  it("entrada vazia -> Map vazio, nunca lança", () => {
    const grouped = groupByCanalSince([], "2026-09-05", (r: { date: string; canal: string }) => r);
    assert.equal(grouped.size, 0);
  });
});
