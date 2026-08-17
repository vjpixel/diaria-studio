/**
 * test/meta-ads-ingest-5469.test.ts (#5469)
 *
 * Cobre `scripts/lib/meta-ads-ingest.ts`: parse do envelope MCP real
 * (`{"ad_entities": "<json-string>"}`, capturado ao vivo contra a conta
 * `10151064543294811` em 17/08/2026), parsing de valor monetário nos dois
 * formatos vistos na doc oficial (decimal com ponto / humano "R$X,XX BRL"),
 * agregação por mês tolerante a linha malformada, e o caminho fail-soft
 * (envelope vazio/inválido nunca lança). Espelha
 * `test/microsoft-ads-ingest-5502.test.ts`/`test/google-ads-ingest-5237.test.ts`
 * na forma.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  META_ADS_AD_ACCOUNT_ID,
  META_ADS_CANAL,
  parseAdEntitiesEnvelope,
  parseMetaSpendValue,
  aggregateMetaAdsSpendByMonth,
  runMetaAdsIngest,
  mergeSpendRows,
  type MetaAdsEntityRow,
} from "../scripts/lib/meta-ads-ingest.ts";
import type { SpendRow } from "../scripts/lib/aquisicao-spend.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(HERE, "fixtures", "meta-ads");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), "utf8"));
}

describe("#5469 — META_ADS_AD_ACCOUNT_ID travado", () => {
  it("é a conta confirmada (business_name === Diar.ia) — mudar exige revisão explícita, não silenciosa", () => {
    assert.equal(META_ADS_AD_ACCOUNT_ID, "10151064543294811");
  });

  it("META_ADS_CANAL bate com o nome canônico reservado em cac.ts (RESERVED_CHANNEL_NAMES)", () => {
    assert.equal(META_ADS_CANAL, "Meta");
  });
});

describe("#5469 — parseAdEntitiesEnvelope", () => {
  it("parseia o envelope REAL vazio capturado ao vivo (ad_entities: '[]')", () => {
    const payload = loadFixture("ad-entities-empty.json");
    const out = parseAdEntitiesEnvelope(payload);
    assert.deepEqual(out, { rows: [] });
  });

  it("parseia o envelope sintético (ad_entities é uma STRING JSON, não array direto)", () => {
    const payload = loadFixture("ad-entities-synthetic.json");
    const out = parseAdEntitiesEnvelope(payload);
    assert.ok("rows" in out);
    if ("rows" in out) assert.equal(out.rows.length, 7);
  });

  it("aceita ad_entities já como array (robustez a mudança de serialização upstream)", () => {
    const out = parseAdEntitiesEnvelope({ ad_entities: [{ id: "1" }] });
    assert.deepEqual(out, { rows: [{ id: "1" }] });
  });

  it("aceita o payload já sendo o array diretamente", () => {
    const out = parseAdEntitiesEnvelope([{ id: "1" }]);
    assert.deepEqual(out, { rows: [{ id: "1" }] });
  });

  it("ad_entities com JSON inválido vira {error}, nunca lança", () => {
    const out = parseAdEntitiesEnvelope({ ad_entities: "{not valid json" });
    assert.ok("error" in out);
  });

  it("ad_entities parseado mas não-array vira {error}", () => {
    const out = parseAdEntitiesEnvelope({ ad_entities: '{"foo":"bar"}' });
    assert.ok("error" in out);
  });

  it("payload sem a forma esperada vira {error}", () => {
    const out = parseAdEntitiesEnvelope({ foo: "bar" });
    assert.ok("error" in out);
    const outNull = parseAdEntitiesEnvelope(null);
    assert.ok("error" in outNull);
  });
});

describe("#5469 — parseMetaSpendValue", () => {
  it("number direto", () => {
    assert.equal(parseMetaSpendValue(12.34), 12.34);
  });

  it("decimal com ponto (formato usual de insights)", () => {
    assert.equal(parseMetaSpendValue("45.60"), 45.6);
  });

  it("BRL com vírgula decimal, sem símbolo", () => {
    assert.equal(parseMetaSpendValue("12,34"), 12.34);
  });

  it("formato humano 'R$X,XX BRL' (visto em amount_spent no nível ad_account)", () => {
    assert.equal(parseMetaSpendValue("R$71,74 BRL"), 71.74);
  });

  it("separador de milhar pt-BR ('1.234,56')", () => {
    assert.equal(parseMetaSpendValue("1.234,56"), 1234.56);
  });

  it("zero explícito é um valor válido, não null", () => {
    assert.equal(parseMetaSpendValue("0"), 0);
    assert.equal(parseMetaSpendValue("R$0,00 BRL"), 0);
  });

  it("undefined, string vazia, não-numérico ou negativo viram null — nunca 0 silencioso", () => {
    assert.equal(parseMetaSpendValue(undefined), null);
    assert.equal(parseMetaSpendValue(""), null);
    assert.equal(parseMetaSpendValue("indisponível"), null);
    assert.equal(parseMetaSpendValue("-5.00"), null);
  });
});

describe("#5469 — aggregateMetaAdsSpendByMonth", () => {
  it("envelope real vazio produz lista vazia", () => {
    const out = aggregateMetaAdsSpendByMonth([], { moeda: "BRL", fonteLabel: "x" });
    assert.deepEqual(out, []);
  });

  it("fixture sintética: agrega por mês, tolera linha malformada, inclui gasto explicitamente 0, usa amount_spent como fallback", () => {
    const payload = loadFixture("ad-entities-synthetic.json");
    const parsed = parseAdEntitiesEnvelope(payload);
    assert.ok("rows" in parsed);
    const rows = "rows" in parsed ? parsed.rows : [];

    const out = aggregateMetaAdsSpendByMonth(rows, {
      moeda: "BRL",
      fonteLabel: "Meta Ads MCP oficial (mcp.facebook.com/ads)",
    });

    assert.equal(out.length, 3, "só ago/set/out têm linha com data+valor parseáveis");

    const ago = out.find((r) => r.mes === "2026-08")!;
    const set = out.find((r) => r.mes === "2026-09")!;
    const out26_10 = out.find((r) => r.mes === "2026-10")!;

    assert.equal(ago.valor, 57.94, "12,34 + 45.60 — vírgula E ponto no mesmo mês");
    assert.equal(ago.canal, "Meta");
    assert.equal(ago.moeda, "BRL");
    assert.match(ago.fonte, /2 linha\(s\)/);

    assert.equal(set.valor, 0, "campanha sem gasto no período é um resultado válido, não ausência de linha");

    assert.equal(out26_10.valor, 71.74, "fallback pra amount_spent quando spend está ausente");
  });

  it("ignora linha sem date_start/date_stop, sem spend/amount_spent, ou com spend não-numérico — nunca soma como 0", () => {
    const rows: MetaAdsEntityRow[] = [
      { id: "a", spend: "10.00" }, // sem data
      { id: "b", date_start: "2026-08-01", date_stop: "2026-08-01" }, // sem spend
      { id: "c", spend: "indisponível", date_start: "2026-08-01", date_stop: "2026-08-01" }, // não-numérico
    ];
    assert.deepEqual(aggregateMetaAdsSpendByMonth(rows, { moeda: "BRL", fonteLabel: "x" }), []);
  });

  it("usa date_stop como fallback quando date_start está ausente", () => {
    const rows: MetaAdsEntityRow[] = [{ id: "a", spend: "10.00", date_stop: "2026-08-15" }];
    const out = aggregateMetaAdsSpendByMonth(rows, { moeda: "BRL", fonteLabel: "x" });
    assert.equal(out.length, 1);
    assert.equal(out[0].mes, "2026-08");
    assert.equal(out[0].valor, 10);
  });

  it("respeita canal customizado via opts.canal", () => {
    const rows: MetaAdsEntityRow[] = [{ id: "a", spend: "1", date_start: "2026-08-01" }];
    const out = aggregateMetaAdsSpendByMonth(rows, { canal: "Meta (teste)", moeda: "BRL", fonteLabel: "x" });
    assert.equal(out[0].canal, "Meta (teste)");
  });
});

describe("#5469 — runMetaAdsIngest (orquestração fail-soft)", () => {
  it("envelope real vazio (sem gasto) vira fallback com motivo — nunca escreve linha zerada", async () => {
    const payload = loadFixture("ad-entities-empty.json");
    const out = await runMetaAdsIngest({ envelopePayload: payload, existingRows: [] });
    assert.equal(out.kind, "fallback");
  });

  it("envelope inválido vira fallback, nunca lança", async () => {
    const out = await runMetaAdsIngest({ envelopePayload: { foo: "bar" }, existingRows: [] });
    assert.equal(out.kind, "fallback");
  });

  it("payload que não é objeto/array nem tem ad_entities também vira fallback, nunca lança", async () => {
    const out = await runMetaAdsIngest({ envelopePayload: "não sou json válido de verdade", existingRows: [] });
    assert.equal(out.kind, "fallback");
  });

  it("fixture sintética: atualiza e faz merge preservando linhas de outros canais/meses (idempotente por canal+mes)", async () => {
    const payload = loadFixture("ad-entities-synthetic.json");
    const existingRows: SpendRow[] = [
      { canal: "Google Ads", mes: "2026-08", moeda: "BRL", valor: 100, fonte: "existing" },
      { canal: "Meta", mes: "2026-07", moeda: "BRL", valor: 5, fonte: "linha antiga preservada" },
    ];

    const out = await runMetaAdsIngest({ envelopePayload: payload, existingRows });
    assert.equal(out.kind, "updated");
    if (out.kind !== "updated") return;

    // Google Ads e o mês 2026-07 do próprio Meta seguem intactos.
    assert.ok(out.rows.some((r) => r.canal === "Google Ads" && r.mes === "2026-08" && r.valor === 100));
    assert.ok(out.rows.some((r) => r.canal === "Meta" && r.mes === "2026-07" && r.valor === 5));

    const metaAgo = out.rows.find((r) => r.canal === "Meta" && r.mes === "2026-08")!;
    assert.equal(metaAgo.valor, 57.94);
  });

  it("re-execução com o mesmo envelope é idempotente (mergeSpendRows substitui por canal+mes, nunca duplica)", async () => {
    const payload = loadFixture("ad-entities-synthetic.json");
    const first = await runMetaAdsIngest({ envelopePayload: payload, existingRows: [] });
    assert.equal(first.kind, "updated");
    if (first.kind !== "updated") return;

    const second = await runMetaAdsIngest({ envelopePayload: payload, existingRows: first.rows });
    assert.equal(second.kind, "updated");
    if (second.kind !== "updated") return;

    assert.deepEqual(
      second.rows.filter((r) => r.canal === "Meta").map((r) => r.mes).sort(),
      first.rows.filter((r) => r.canal === "Meta").map((r) => r.mes).sort(),
    );
    assert.equal(second.rows.length, first.rows.length);
  });
});

describe("#5469 — mergeSpendRows re-exportado (mesmo símbolo de spend-ingest.ts)", () => {
  it("é a mesma implementação usada por google/microsoft — substitui por (canal, mes)", () => {
    const existing: SpendRow[] = [{ canal: "Meta", mes: "2026-08", moeda: "BRL", valor: 1, fonte: "old" }];
    const incoming: SpendRow[] = [{ canal: "Meta", mes: "2026-08", moeda: "BRL", valor: 2, fonte: "new" }];
    const merged = mergeSpendRows(existing, incoming);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].valor, 2);
  });
});
