/**
 * test/instagram-follower-insights-12348.test.ts (#12348, Fase 2 da #8260)
 *
 * Série bruta de novos seguidores do IG via `metric=follower_count`. Nada bate
 * em rede: `fetchImpl` é sempre mock. Os valores do fixture são os da resposta
 * real de 10/11/2026 (29/10..04/11 somam 42, o número do Business Suite citado
 * na issue), então o teste trava também a regra de qual dia é cada `end_time`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectInstagramGrossFollows, collectSocialFollowers } from "../scripts/social-followers-collect.ts";
import {
  daysToAppend,
  diagnoseInsightsError,
  parseFollowerCountInsights,
  parseInstagramFollowsJsonl,
  summarizeInstagramNewFollowers,
} from "../scripts/lib/instagram-follower-insights.ts";

const REAL_VALUES: Array<[string, number]> = [
  ["2026-10-28T07:00:00+0000", 4],
  ["2026-10-29T07:00:00+0000", 30],
  ["2026-10-30T07:00:00+0000", 3],
  ["2026-10-31T07:00:00+0000", 2],
  ["2026-11-01T07:00:00+0000", 0],
  ["2026-11-02T08:00:00+0000", 1],
  ["2026-11-03T08:00:00+0000", 4],
  ["2026-11-04T08:00:00+0000", 2],
  ["2026-11-05T08:00:00+0000", 3],
  ["2026-11-09T08:00:00+0000", 0],
  ["2026-11-10T08:00:00+0000", 0], // dia do Pacífico em curso: nunca gravado
];

function insightsBody(values = REAL_VALUES) {
  return {
    data: [
      {
        name: "follower_count",
        period: "day",
        values: values.map(([end_time, value]) => ({ value, end_time })),
      },
    ],
  };
}

const NOW = () => new Date("2026-11-10T13:00:00Z"); // 05:00 PT de 10/11
const ENV = { INSTAGRAM_BUSINESS_ACCOUNT_ID: "ig123", INSTAGRAM_ACCESS_TOKEN: "segredo-nao-logar" };
const tmpFile = (name: string) => join(mkdtempSync(join(tmpdir(), "ig-follows-12348-")), name);

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("parseFollowerCountInsights — dia de cada end_time (#12348)", () => {
  it("o dia é a data de end_time no Pacífico; 29/10..04/11 soma 42 como no Business Suite", () => {
    const r = parseFollowerCountInsights(insightsBody(), "2026-11-10");
    assert.ok("days" in r);
    const sum = r.days.filter((d) => d.date >= "2026-10-29" && d.date <= "2026-11-04").reduce((s, d) => s + d.follows, 0);
    assert.equal(sum, 42);
    assert.deepEqual(r.days.find((d) => d.date === "2026-11-02"), { date: "2026-11-02", follows: 1 });
  });

  it("descarta o dia do Pacífico em curso e grava 0 dos dias sem seguidor", () => {
    const r = parseFollowerCountInsights(insightsBody(), "2026-11-10");
    assert.ok("days" in r);
    assert.equal(r.days.some((d) => d.date === "2026-11-10"), false);
    assert.deepEqual(r.days.find((d) => d.date === "2026-11-09"), { date: "2026-11-09", follows: 0 });
  });

  it("resposta sem a métrica vira erro de shape, não série vazia", () => {
    const r = parseFollowerCountInsights({ data: [] }, "2026-11-10");
    assert.ok("error" in r && r.error.kind === "shape");
  });
});

describe("diagnoseInsightsError (#12348)", () => {
  it("(#10) é falta de escopo, com a ação e o fallback no texto", () => {
    const e = diagnoseInsightsError(400, { error: { code: 10, message: "Application does not have permission for this action" } });
    assert.equal(e.kind, "permission");
    assert.match(e.message, /instagram_manage_insights/);
    assert.match(e.message, /social-followers\.jsonl/);
  });
  it("(#190) é token inválido", () => {
    assert.equal(diagnoseInsightsError(400, { error: { code: 190, message: "expired" } }).kind, "auth");
  });
});

describe("collectInstagramGrossFollows — mock da Graph API (#12348)", () => {
  it("1ª execução faz o backfill; token só no header, nunca na URL", async () => {
    const out = tmpFile("ig.jsonl");
    let seenUrl = "";
    let seenAuth = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init?.headers as Record<string, string>)?.Authorization);
      return jsonResponse(200, insightsBody());
    }) as unknown as typeof fetch;
    const r = await collectInstagramGrossFollows({ now: NOW, outputPath: out, env: ENV, fetchImpl });
    assert.equal(r.error, null);
    assert.equal(r.fetchedDays, 10);
    assert.equal(r.appended, 10);
    assert.match(seenUrl, /\/ig123\/insights\?metric=follower_count&period=day&since=\d+&until=\d+$/);
    assert.equal(seenUrl.includes("segredo"), false);
    assert.equal(seenAuth, "Bearer segredo-nao-logar");
    const { days } = parseInstagramFollowsJsonl(readFileSync(out, "utf8"));
    assert.equal(days.length, 10);
  });

  it("2ª execução só anexa o dia que a Meta revisou; a leitura fica com o último valor", async () => {
    const out = tmpFile("ig.jsonl");
    const ok = (async () => jsonResponse(200, insightsBody())) as unknown as typeof fetch;
    await collectInstagramGrossFollows({ now: NOW, outputPath: out, env: ENV, fetchImpl: ok });
    const revised = REAL_VALUES.map(([t, v]): [string, number] => (t.startsWith("2026-11-09") ? [t, 2] : [t, v]));
    const again = (async () => jsonResponse(200, insightsBody(revised))) as unknown as typeof fetch;
    const r = await collectInstagramGrossFollows({ now: NOW, outputPath: out, env: ENV, fetchImpl: again });
    assert.equal(r.appended, 1);
    const { days } = parseInstagramFollowsJsonl(readFileSync(out, "utf8"));
    assert.equal(days.find((d) => d.date === "2026-11-09")?.follows, 2);
    assert.equal(readFileSync(out, "utf8").trim().split("\n").length, 11);
  });

  it("(#10) não grava nada e devolve o diagnóstico de permissão", async () => {
    const out = tmpFile("ig.jsonl");
    const fetchImpl = (async () =>
      jsonResponse(400, { error: { code: 10, message: "Application does not have permission for this action" } })) as unknown as typeof fetch;
    const r = await collectInstagramGrossFollows({ now: NOW, outputPath: out, env: ENV, fetchImpl });
    assert.equal(r.error?.kind, "permission");
    assert.equal(r.appended, 0);
    assert.equal(r.error?.message.includes("segredo"), false);
  });

  it("fallback preservado: (#10) nos insights não impede a coleta de followers_count", async () => {
    const net = tmpFile("social-followers.jsonl");
    const fetchImpl = (async (url: string) =>
      String(url).includes("/insights")
        ? jsonResponse(400, { error: { code: 10, message: "no permission" } })
        : jsonResponse(200, { followers_count: 360 })) as unknown as typeof fetch;
    const gross = await collectInstagramGrossFollows({ now: NOW, outputPath: tmpFile("ig.jsonl"), env: ENV, fetchImpl });
    const results = await collectSocialFollowers({ now: NOW, outputPath: net, env: ENV, fetchImpl, config: {} });
    assert.equal(gross.error?.kind, "permission");
    const ig = results.find((r) => r.platform === "instagram");
    assert.equal(ig?.written, true);
    assert.equal(ig?.followersCount, 360);
  });

  it("sem credencial: erro `missing`, sem fetch", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jsonResponse(200, {});
    }) as unknown as typeof fetch;
    const r = await collectInstagramGrossFollows({ now: NOW, outputPath: tmpFile("ig.jsonl"), env: {}, fetchImpl });
    assert.equal(r.error?.kind, "missing");
    assert.equal(called, false);
  });
});

describe("summarizeInstagramNewFollowers — bruto com fallback no saldo líquido (#12348)", () => {
  const parsed = parseFollowerCountInsights(insightsBody(), "2026-11-10");
  const gross = "days" in parsed ? parsed.days : [];
  const net = [
    { date: "2026-10-28", platform: "instagram", followersCount: 319 },
    { date: "2026-11-04", platform: "instagram", followersCount: 360 },
  ];

  it("série completa no período: soma bruta (42)", () => {
    assert.deepEqual(summarizeInstagramNewFollowers(gross, net, "2026-10-29", "2026-11-04"), {
      source: "insights",
      value: 42,
      from: "2026-10-29",
      to: "2026-11-04",
    });
  });

  it("dia faltando na série: cai no saldo líquido (41) e diz quais dias faltaram", () => {
    const holed = gross.filter((d) => d.date !== "2026-10-31");
    const s = summarizeInstagramNewFollowers(holed, net, "2026-10-29", "2026-11-04");
    assert.equal(s.source, "net-balance");
    assert.equal(s.value, 41);
    assert.ok(s.source === "net-balance" && s.missingDays.includes("2026-10-31"));
  });

  it("daysToAppend ignora dia igual e pega dia novo", () => {
    assert.deepEqual(
      daysToAppend([{ date: "2026-11-01", follows: 0 }], [{ date: "2026-11-01", follows: 0 }, { date: "2026-11-02", follows: 1 }]),
      [{ date: "2026-11-02", follows: 1 }],
    );
  });

  it("#12785: fallback informa a borda UTC vs Pacífico sem deslocar datas históricas", () => {
    const s = summarizeInstagramNewFollowers([], [
      { date: "2026-11-01", platform: "instagram", followersCount: 100 },
      { date: "2026-11-02", platform: "instagram", followersCount: 105 },
      { date: "2026-11-03", platform: "instagram", followersCount: 125 },
    ], "2026-11-02", "2026-11-02");
    assert.equal(s.source, "net-balance");
    assert.equal(s.value, 5);
    if (s.source !== "net-balance") assert.fail("esperado fallback");
    assert.match(s.note, /UTC.*até 1 dia.*Pacífico/);
    assert.match(s.note, /coletas faltantes.*ampliar/);
  });
});

describe("parseInstagramFollowsJsonl — fail-soft por linha", () => {
  it("linha inválida vai para errors e não derruba as outras", () => {
    const f = tmpFile("ig.jsonl");
    writeFileSync(f, '{"date":"2026-11-01","follows":3}\nlixo\n{"date":"x","follows":1}\n');
    const r = parseInstagramFollowsJsonl(readFileSync(f, "utf8"));
    assert.equal(r.days.length, 1);
    assert.equal(r.errors.length, 2);
  });
});
