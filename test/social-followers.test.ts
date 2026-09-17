/**
 * test/social-followers.test.ts (#8260)
 *
 * Cobertura do núcleo puro de "seguidores ganhos por dia": parsing
 * fail-soft do JSONL e cálculo de saldo diário — os 3 cenários exigidos
 * explicitamente pelos critérios de aceite da issue (dia faltando, 1ª
 * coleta sem dia anterior, perda de seguidor/saldo negativo) + parsing
 * malformado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSocialFollowersJsonl,
  serializeSocialFollowerSample,
  computeDailyBalances,
  type SocialFollowerSample,
} from "../scripts/lib/social-followers.ts";

describe("parseSocialFollowersJsonl — fail-soft por linha", () => {
  it("parseia linhas válidas de ambas as plataformas", () => {
    const content = [
      JSON.stringify({ date: "2026-09-14", platform: "instagram", followersCount: 100 }),
      JSON.stringify({ date: "2026-09-14", platform: "facebook", followersCount: 10 }),
    ].join("\n");
    const { samples, errors } = parseSocialFollowersJsonl(content);
    assert.equal(errors.length, 0);
    assert.deepEqual(samples, [
      { date: "2026-09-14", platform: "instagram", followersCount: 100 },
      { date: "2026-09-14", platform: "facebook", followersCount: 10 },
    ]);
  });

  it("ignora linhas em branco (trailing newline, edição manual)", () => {
    const content = `${JSON.stringify({ date: "2026-09-14", platform: "instagram", followersCount: 100 })}\n\n\n`;
    const { samples, errors } = parseSocialFollowersJsonl(content);
    assert.equal(samples.length, 1);
    assert.equal(errors.length, 0);
  });

  it("JSON inválido numa linha não derruba as outras", () => {
    const content = [
      JSON.stringify({ date: "2026-09-14", platform: "instagram", followersCount: 100 }),
      "{ not valid json",
      JSON.stringify({ date: "2026-09-15", platform: "instagram", followersCount: 101 }),
    ].join("\n");
    const { samples, errors } = parseSocialFollowersJsonl(content);
    assert.equal(samples.length, 2);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].line, 2);
    assert.match(errors[0].reason, /JSON inválido/);
  });

  it("rejeita platform inválida, date fora do formato e followersCount negativo/ausente", () => {
    const content = [
      JSON.stringify({ date: "2026-09-14", platform: "twitter", followersCount: 1 }),
      JSON.stringify({ date: "14/09/2026", platform: "instagram", followersCount: 1 }),
      JSON.stringify({ date: "2026-09-14", platform: "instagram", followersCount: -5 }),
      JSON.stringify({ date: "2026-09-14", platform: "instagram" }),
    ].join("\n");
    const { samples, errors } = parseSocialFollowersJsonl(content);
    assert.equal(samples.length, 0);
    assert.equal(errors.length, 4);
  });

  it("serializeSocialFollowerSample produz 1 linha que o parser lê de volta idêntica", () => {
    const sample: SocialFollowerSample = { date: "2026-09-14", platform: "facebook", followersCount: 15 };
    const line = serializeSocialFollowerSample(sample);
    const { samples, errors } = parseSocialFollowersJsonl(line);
    assert.equal(errors.length, 0);
    assert.deepEqual(samples, [sample]);
  });
});

describe("computeDailyBalances", () => {
  it("1ª coleta sem dia anterior: delta null, nunca 0 (nunca inventa saldo de dia 0)", () => {
    const samples: SocialFollowerSample[] = [{ date: "2026-09-14", platform: "instagram", followersCount: 50 }];
    const result = computeDailyBalances(samples, "instagram");
    assert.equal(result.points.length, 1);
    assert.equal(result.points[0].delta, null);
    assert.equal(result.points[0].daysSincePrevious, null);
    assert.equal(result.currentTotal, 50);
    assert.equal(result.totalDelta, null);
  });

  it("dia faltando: delta do dia seguinte é o saldo do INTERVALO inteiro, daysSincePrevious > 1", () => {
    const samples: SocialFollowerSample[] = [
      { date: "2026-09-14", platform: "instagram", followersCount: 100 },
      // 15/09 ausente (task não rodou)
      { date: "2026-09-16", platform: "instagram", followersCount: 106 },
    ];
    const result = computeDailyBalances(samples, "instagram");
    assert.equal(result.points.length, 2);
    assert.equal(result.points[0].delta, null);
    assert.equal(result.points[1].date, "2026-09-16");
    assert.equal(result.points[1].delta, 6);
    assert.equal(result.points[1].daysSincePrevious, 2);
    assert.equal(result.totalDelta, 6);
  });

  it("perda de seguidor: saldo negativo é reportado, não escondido", () => {
    const samples: SocialFollowerSample[] = [
      { date: "2026-09-14", platform: "facebook", followersCount: 20 },
      { date: "2026-09-15", platform: "facebook", followersCount: 17 },
    ];
    const result = computeDailyBalances(samples, "facebook");
    assert.equal(result.points[1].delta, -3);
    assert.equal(result.points[1].daysSincePrevious, 1);
    assert.equal(result.totalDelta, -3);
    assert.equal(result.currentTotal, 17);
  });

  it("filtra por plataforma — amostras da outra plataforma não interferem no cálculo", () => {
    const samples: SocialFollowerSample[] = [
      { date: "2026-09-14", platform: "instagram", followersCount: 100 },
      { date: "2026-09-14", platform: "facebook", followersCount: 5 },
      { date: "2026-09-15", platform: "instagram", followersCount: 102 },
      { date: "2026-09-15", platform: "facebook", followersCount: 5 },
    ];
    const ig = computeDailyBalances(samples, "instagram");
    const fb = computeDailyBalances(samples, "facebook");
    assert.equal(ig.totalDelta, 2);
    assert.equal(fb.totalDelta, 0);
  });

  it("série vazia (nenhuma amostra da plataforma): tudo null, nunca lança", () => {
    const result = computeDailyBalances([{ date: "2026-09-14", platform: "facebook", followersCount: 1 }], "instagram");
    assert.deepEqual(result.points, []);
    assert.equal(result.currentTotal, null);
    assert.equal(result.totalDelta, null);
    assert.equal(result.firstDate, null);
    assert.equal(result.lastDate, null);
  });

  it("amostras fora de ordem e duplicadas no mesmo dia: ordena por data, última ocorrência do dia vence", () => {
    const samples: SocialFollowerSample[] = [
      { date: "2026-09-15", platform: "instagram", followersCount: 102 },
      { date: "2026-09-14", platform: "instagram", followersCount: 100 },
      { date: "2026-09-14", platform: "instagram", followersCount: 99 }, // reprocessamento do mesmo dia
    ];
    const result = computeDailyBalances(samples, "instagram");
    assert.equal(result.points[0].followersCount, 99);
    assert.equal(result.points[1].delta, 3);
  });
});
