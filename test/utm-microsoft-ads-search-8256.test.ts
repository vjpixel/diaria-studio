/**
 * test/utm-microsoft-ads-search-8256.test.ts (#8256)
 *
 * O braço Microsoft do teste 2608 tem 2 campanhas (PMax 571543153, Search
 * 571615527) com `utm_campaign` distinto (`ads-microsoft-2608` /
 * `ads-microsoft-2608-search`) mas o MESMO `utm_source=microsoft-ads`.
 *
 * Leitura ao vivo do painel (Chrome logado, 18/09/2026) confirmou que o UTM
 * de cada campanha está embutido direto no Final URL do asset group (PMax)
 * / anúncio (Search) — não no campo "Final URL suffix" de campanha ou grupo
 * de anúncio, que estão vazios nas duas. Nenhuma escrita foi feita no
 * painel: os valores já eram os corretos.
 *
 * O que este arquivo trava (regressão #633):
 *   1. As 2 superfícies estão registradas em `EXTERNAL_UTM_SURFACES`, com
 *      `campaign` distinto (a issue #8256 pedia isso — "utm-registry.ts com
 *      as duas superfícies").
 *   2. Um cadastro com `utm_campaign=ads-microsoft-2608-search` conta no
 *      MESMO braço que `ads-microsoft-2608` — `classifyAcquisition` (e por
 *      extensão `CHANNEL_KEY_SPECS`) casam por `utm_source`, nunca por
 *      `utm_campaign`. Prova que a Search nunca fica de fora do braço
 *      Microsoft por causa da campanha nova (o item "Nenhum consumidor
 *      perde cadastro da Search" do critério de aceite da issue).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EXTERNAL_UTM_SURFACES } from "../scripts/lib/shared/utm-registry.ts";
import { CHANNEL_KEY_SPECS } from "../scripts/lib/shared/channel-key-specs.ts";
import { classifyAcquisition } from "../scripts/lib/metrics/acquisition-class.ts";

describe("#8256 — Microsoft Ads (teste 2608): PMax e Search separadas por utm_campaign, mesmo utm_source", () => {
  it("as 2 superfícies estão registradas, com campaign distinto e mesmo source", () => {
    const pmax = EXTERNAL_UTM_SURFACES.find((s) => s.id === "ads-microsoft-2608");
    const search = EXTERNAL_UTM_SURFACES.find((s) => s.id === "ads-microsoft-2608-search");
    assert.ok(pmax, "ads-microsoft-2608 (PMax) ausente de EXTERNAL_UTM_SURFACES");
    assert.ok(search, "ads-microsoft-2608-search ausente de EXTERNAL_UTM_SURFACES");
    assert.equal(pmax!.source, "microsoft-ads");
    assert.equal(search!.source, "microsoft-ads");
    assert.notEqual(pmax!.campaign, search!.campaign);
    assert.equal(search!.campaign, "ads-microsoft-2608-search");
  });

  it("CHANNEL_KEY_SPECS do braço Microsoft casa por utm_source, não por utm_campaign", () => {
    const spec = CHANNEL_KEY_SPECS.find((s) => s.canal === "Microsoft Ads (teste 2608)");
    assert.ok(spec, "spec 'Microsoft Ads (teste 2608)' ausente de CHANNEL_KEY_SPECS");
    assert.deepEqual(spec!.keys, ["microsoft-ads"]);
    assert.equal(spec!.subcanal, undefined, "subcanal presente contaminaria a agregação de gasto por campanha (#8246)");
  });

  it("classifica 'pago' só por utm_source — AcquisitionClassInput nem aceita utm_campaign", () => {
    // A ausência do campo é o próprio invariante: a Search não pode
    // "escapar" da classificação da PMax porque não existe canal de entrada
    // pelo qual o utm_campaign influenciaria classifyAcquisition.
    const created = Math.floor(Date.parse("2026-09-10T12:00:00Z") / 1000);
    const cls = classifyAcquisition({ utm_source: "microsoft-ads", utm_medium: "cpc", created });
    assert.equal(cls, "pago");
  });
});
