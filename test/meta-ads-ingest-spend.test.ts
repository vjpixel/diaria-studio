/**
 * test/meta-ads-ingest-spend.test.ts (#8239)
 *
 * Cobre `META_ADS_CANAL` de `scripts/meta-ads-ingest-spend.ts` — o canal
 * escrito em `spend.csv` pelo caminho mensal do Meta durante o teste 2608.
 * Espelha `test/microsoft-ads-ingest-spend.ts` (#7544, mesma classe de
 * defeito já corrigida pro Microsoft): antes desta PR,
 * `meta-ads-ingest-spend.ts` não sobrescrevia o `canal` passado a
 * `runMetaAdsIngest`, então caía no default `"Meta"` (`RESERVED_CHANNEL_NAMES`,
 * sem spec própria em `CHANNEL_KEY_SPECS`) — a 1ª execução real teria criado
 * `Meta,2026-09` ao lado de `Meta Ads (teste 2608),2026-09`, duplicando o
 * gasto do teste (mesmo defeito do Google, #8239).
 *
 * Não chama a API/MCP — só importa a constante e valida contra as 2 fontes
 * de verdade (`CHANNEL_KEY_SPECS`, `ADS_TEST_2608_BRACOS`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { META_ADS_CANAL } from "../scripts/meta-ads-ingest-spend.ts";
import { CHANNEL_KEY_SPECS, RESERVED_CHANNEL_NAMES } from "../scripts/lib/shared/channel-key-specs.ts";
import { ADS_TEST_2608_BRACOS } from "../scripts/lib/ads-test-run-state.ts";

describe("#8239 — META_ADS_CANAL trava contra drift de nome de canal", () => {
  it("META_ADS_CANAL é o nome do braço Meta do teste 2608", () => {
    assert.equal(META_ADS_CANAL, "Meta Ads (teste 2608)");
  });

  it("META_ADS_CANAL bate com uma entrada real de CHANNEL_KEY_SPECS (não apenas RESERVED_CHANNEL_NAMES)", () => {
    // Defeito original (#8239, espelha #7544 pro Microsoft): o script não
    // sobrescrevia o canal, então `runMetaAdsIngest` usava o default `"Meta"`
    // (só RESERVED_CHANNEL_NAMES, sem spec cadastrada) — a linha caía no
    // caminho "canal desconhecido" mesmo com gasto real, e duplicava o
    // gasto do teste numa linha que nenhum braço reconhece. O canal
    // ESCRITO precisa ter spec ativa em CHANNEL_KEY_SPECS, senão a
    // asserção abaixo falha como erro de teste (não como aviso em stderr
    // no runtime).
    const specCanais = CHANNEL_KEY_SPECS.map((spec) => spec.canal);
    assert.ok(
      specCanais.includes(META_ADS_CANAL),
      `META_ADS_CANAL="${META_ADS_CANAL}" não tem spec em CHANNEL_KEY_SPECS ` +
        `(canais com spec: ${JSON.stringify(specCanais)}) — a ingestão cairia no caminho ` +
        `"canal desconhecido" (unknownCanais) mesmo com gasto real. Se a spec "(teste 2608)" ` +
        `saiu (decisão #5862), atualizar META_ADS_CANAL junto.`,
    );
  });

  it("META_ADS_CANAL bate com um dos 3 braços de ADS_TEST_2608_BRACOS", () => {
    assert.ok(
      ADS_TEST_2608_BRACOS.includes(META_ADS_CANAL),
      `META_ADS_CANAL="${META_ADS_CANAL}" não está em ADS_TEST_2608_BRACOS ` +
        `(${JSON.stringify(ADS_TEST_2608_BRACOS)}) — o gasto ingerido não seria atribuído ` +
        `ao braço Meta do teste 2608.`,
    );
  });

  it("um canal fora de RESERVED_CHANNEL_NAMES/CHANNEL_KEY_SPECS falha esta asserção (prova que o guard pega o defeito original)", () => {
    const driftedCanal = "Meta"; // valor antigo (default da lib), causa raiz do #8239
    const specCanais = CHANNEL_KEY_SPECS.map((spec) => spec.canal);
    const hasSpec = specCanais.includes(driftedCanal);
    const isReserved = (RESERVED_CHANNEL_NAMES as readonly string[]).includes(driftedCanal);
    // "Meta" é RESERVADO mas não tem spec — reservado sozinho não basta
    // pro relatório reconhecer o canal como medido, nem pra atribuir ao
    // braço do teste 2608.
    assert.equal(isReserved, true, "sanity check: RESERVED_CHANNEL_NAMES deveria seguir citando o nome canônico legado");
    assert.equal(hasSpec, false, "sanity check: o valor antigo não deveria ter spec própria — é essa lacuna que causa o defeito 2 do #8239");
    assert.equal(ADS_TEST_2608_BRACOS.includes(driftedCanal), false, "sanity check: 'Meta' não é um braço do teste 2608");
  });
});
