/**
 * test/studio-ads.test.ts (#5236 Parte 3)
 *
 * Cobertura de `scripts/studio-ui/studio-ads.ts`: sessão cloud (`data/`
 * ausente) nunca lança, fail-soft por camada (spend/snapshot/origem),
 * cache com TTL/forceRefresh, e o caminho feliz com fixtures em tmpdir.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAdsData,
  clearAdsCache,
  buildAdsCampaignEconomics,
  clearAdsCampaignEconomicsCache,
  makeMemoizedStoreResultProvider,
} from "../scripts/studio-ui/studio-ads.ts";
import { openDiariaSubscribersDb, ensureSubscriber, upsertSubscription } from "../scripts/lib/diaria-subscribers-db.ts";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "studio-ads-"));
}

function subscriberLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    email: "leitor@example.com",
    status: "active",
    created: 1755000000,
    utm_source: "android.googlequicksearchbox",
    utm_medium: "cpc",
    utm_campaign: "",
    referring_site: "",
    stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 40 },
    ...overrides,
  });
}

function writeSpendCsv(root: string, content?: string): void {
  const dir = join(root, "data", "aquisicao");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "spend.csv"),
    content ?? "canal,mes,moeda,valor,fonte\nGoogle Ads,2026-02,BRL,956.21,teste\nLinkedIn,2026-08,BRL,0,teste\n",
    "utf8",
  );
}

function writeSnapshot(root: string, date: string, lines: string[]): void {
  const dir = join(root, "data", "beehiiv-backup", date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "subscribers.jsonl"), lines.join("\n") + "\n", "utf8");
}

describe("buildAdsData — sessão cloud (data/ ausente) nunca lança", () => {
  it("hasDataDir=false, spend/snapshot com error, report null — sem exceção", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      // NUNCA cria data/ — simula clone fresco em cloud.
      const data = buildAdsData(root, { now: () => new Date("2026-08-14T12:00:00Z") });
      assert.equal(data.hasDataDir, false);
      assert.equal(data.execMode, "cloud");
      assert.ok(data.spend.error);
      assert.ok(data.snapshot.error);
      assert.equal(data.report, null);
      assert.equal(data.budget, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildAdsData — fail-soft por camada", () => {
  it("spend.csv ausente mas snapshot presente: spend.error preenchido, report null", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      writeSnapshot(root, "2026-08-14", [subscriberLine()]);
      const data = buildAdsData(root, { forceRefresh: true });
      assert.ok(data.spend.error);
      assert.equal(data.spend.rows.length, 0);
      assert.equal(data.snapshot.date, "2026-08-14");
      assert.equal(data.report, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("snapshot ausente mas spend.csv presente: snapshot.error preenchido, report null", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      writeSpendCsv(root);
      const data = buildAdsData(root, { forceRefresh: true });
      assert.equal(data.spend.error, null);
      assert.equal(data.spend.rows.length, 2);
      assert.ok(data.snapshot.error);
      assert.equal(data.report, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("linha inválida em spend.csv aparece em spend.rowErrors sem derrubar as válidas", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      writeSpendCsv(root, "canal,mes,moeda,valor,fonte\nGoogle Ads,2026-02,BRL,956.21,teste\n,2026-02,BRL,1,quebrada\n");
      writeSnapshot(root, "2026-08-14", [subscriberLine()]);
      const data = buildAdsData(root, { forceRefresh: true });
      assert.equal(data.spend.rows.length, 1);
      assert.equal(data.spend.rowErrors.length, 1);
      assert.ok(data.report, "1 linha válida ainda deveria produzir um report");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildAdsData — caminho feliz", () => {
  it("monta report + budget com spend.csv + snapshot presentes", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      writeSpendCsv(root);
      writeSnapshot(root, "2026-08-14", [subscriberLine({ email: "a@example.com" }), subscriberLine({ email: "b@example.com", utm_source: "direct" })]);
      // #8210 Bug 4c: monthKey/budget agora vêm do mês CORRENTE (`now`), não
      // mais de `snapshotDate.slice(0,7)` — precisa fixar `now` pra manter
      // este teste determinístico (era implícito antes, via o snapshot).
      const data = buildAdsData(root, { forceRefresh: true, now: () => new Date("2026-08-20T12:00:00Z") });
      assert.ok(data.report);
      assert.equal(data.report!.rows.length, 2);
      assert.ok(data.budget);
      assert.equal(data.monthKey, "2026-08");
      // #8210 Bug 2: sem store nesta fixture (nenhum DB criado em
      // data/diaria-subscribers/) — fail-soft pro caminho antigo.
      assert.equal(data.subscribersSource, "beehiiv-snapshot");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#8210 Bug 2: store unificado presente vira o caminho DEFAULT — subscribersSource='store', canal só-Kit aparece com cadastros > 0", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      writeSpendCsv(root, "canal,mes,moeda,valor,fonte\nMeta Ads (teste 2608),2026-09,BRL,517.85,teste\n");
      // NENHUM snapshot Beehiiv escrito — o caso real do #8210 (cadastro do
      // teste foi só pro Kit, o backend do backend está em "kit").
      const storeDir = join(root, "data", "diaria-subscribers");
      mkdirSync(storeDir, { recursive: true });
      const storePath = join(storeDir, "diaria-subscribers.db");
      const db = openDiariaSubscribersDb(storePath);
      const subscriberId = ensureSubscriber(db, "kit", "kit-1", "leitor-kit@example.com", "2026-09-01T00:00:00.000Z");
      upsertSubscription(
        db,
        subscriberId,
        "kit",
        {
          status: "active",
          enteredAt: "2026-09-01T00:00:00.000Z",
          exitedAt: null,
          source: "kit",
          utmSource: "meta-ads",
        },
        "2026-09-01T00:00:00.000Z",
      );
      db.close();

      const data = buildAdsData(root, { forceRefresh: true, now: () => new Date("2026-09-17T12:00:00Z") });
      assert.equal(data.subscribersSource, "store");
      assert.ok(data.report, "store presente deveria montar report mesmo sem snapshot Beehiiv");
      const metaRow = data.report!.rows.find((r) => r.canal === "Meta Ads (teste 2608)") as any;
      assert.ok(metaRow, "canal Meta Ads (teste 2608) deveria aparecer, vindo do store (Kit)");
      assert.equal(metaRow.kind, "measured");
      assert.ok(metaRow.cadastros > 0, "cadastro ingerido só no Kit precisa contar — era invisível no snapshot Beehiiv");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("usa o snapshot anterior quando existem 2+ datas (sinal de degradação)", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      writeSpendCsv(root);
      writeSnapshot(root, "2026-07-01", [subscriberLine({ stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 60 } })]);
      writeSnapshot(root, "2026-08-14", [subscriberLine({ stats: { total_received: 100, total_unique_clicked: 5, total_unique_opened: 20 } })]);
      const data = buildAdsData(root, { forceRefresh: true });
      assert.equal(data.snapshot.date, "2026-08-14");
      assert.equal(data.snapshot.previousDate, "2026-07-01");
      const googleRow = data.report!.rows.find((r) => r.canal === "Google Ads");
      assert.equal((googleRow as any).degradado, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildAdsData — cache + forceRefresh", () => {
  it("retorna cached=true dentro do TTL sem forceRefresh", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      writeSpendCsv(root);
      writeSnapshot(root, "2026-08-14", [subscriberLine()]);
      const first = buildAdsData(root, { now: () => new Date("2026-08-14T10:00:00Z") });
      assert.equal(first.cached, false);
      const second = buildAdsData(root, { now: () => new Date("2026-08-14T10:01:00Z") });
      assert.equal(second.cached, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forceRefresh bypassa o cache mesmo dentro do TTL", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      writeSpendCsv(root);
      writeSnapshot(root, "2026-08-14", [subscriberLine()]);
      buildAdsData(root, { now: () => new Date("2026-08-14T10:00:00Z") });
      const refreshed = buildAdsData(root, { now: () => new Date("2026-08-14T10:01:00Z"), forceRefresh: true });
      assert.equal(refreshed.cached, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TTL expirado recomputa (cached=false)", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      writeSpendCsv(root);
      writeSnapshot(root, "2026-08-14", [subscriberLine()]);
      buildAdsData(root, { now: () => new Date("2026-08-14T10:00:00Z"), cacheTtlMs: 1000 });
      const after = buildAdsData(root, { now: () => new Date("2026-08-14T10:00:02Z"), cacheTtlMs: 1000 });
      assert.equal(after.cached, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── #7536: buildAdsCampaignEconomics ("Economia da campanha ao vivo") ────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function writeRunState(root: string, extra: Record<string, unknown> = {}): void {
  const dir = join(root, "data", "aquisicao", "teste-2608");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "run-state.json"),
    JSON.stringify(
      {
        d0: "2026-01-01",
        fim_janela: "2026-01-15",
        religar_brevo: "2026-01-22",
        coorte_madura: "2026-02-11",
        apuracao_snapshot: "2026-02-15",
        bracos: ["Google Ads (teste 2608)", "Microsoft Ads (teste 2608)", "Meta Ads (teste 2608)"],
        registrado_em: "2026-01-01T00:00:00.000Z",
        ...extra,
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("buildAdsCampaignEconomics — sem run-state.json e sem credenciais (nunca lança)", () => {
  it("runState null, testState com totais zerados, freshness reporta erro por fonte ausente", async () => {
    clearAdsCampaignEconomicsCache();
    const root = makeRoot();
    try {
      const fetchImpl = (async () => jsonResponse(200, { results: [] })) as typeof fetch;
      const data = await buildAdsCampaignEconomics(root, {
        now: () => new Date("2026-01-10T12:00:00Z"),
        env: {},
        fetchImpl,
      });
      assert.equal(data.runState, null);
      assert.equal(data.runStateError, null);
      assert.equal(data.testState.emAndamento, false);
      assert.equal(data.cumulative.series.length, 0);
      const google = data.freshness.find((f) => f.source === "Google Ads")!;
      assert.equal(google.status, "error");
      assert.match(google.error ?? "", /GOOGLE_ADS_/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildAdsCampaignEconomics — run-state.json presente + fontes respondendo", () => {
  it("cruza gasto (Google Ads GAQL) com cadastros (Kit) e monta série acumulada + tabela por canal", async () => {
    clearAdsCampaignEconomicsCache();
    const root = makeRoot();
    try {
      writeRunState(root);
      const env = {
        GOOGLE_ADS_DEVELOPER_TOKEN: "dt",
        GOOGLE_ADS_CLIENT_ID: "ci",
        GOOGLE_ADS_CLIENT_SECRET: "cs",
        GOOGLE_ADS_REFRESH_TOKEN: "rt",
        GOOGLE_ADS_LOGIN_CUSTOMER_ID: "1",
        GOOGLE_ADS_CUSTOMER_ID: "2",
        KIT_API_KEY: "kit_test_key",
      };
      const fetchImpl = (async (url: string) => {
        if (url.includes("oauth2.googleapis.com")) return jsonResponse(200, { access_token: "tok" });
        return jsonResponse(200, {
          results: [{ segments: { date: "2026-01-05" }, metrics: { costMicros: "5000000", clicks: "10", impressions: "500" } }],
        });
      }) as typeof fetch;

      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        jsonResponse(200, {
          subscribers: [
            { id: 1, email_address: "a@b.com", state: "active", created_at: "2026-01-05T00:00:00.000Z", fields: { utm_source: "google-ads" } },
          ],
          pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
        })) as typeof fetch;

      let data;
      try {
        data = await buildAdsCampaignEconomics(root, { now: () => new Date("2026-01-05T12:00:00Z"), env, fetchImpl });
      } finally {
        globalThis.fetch = origFetch;
      }

      assert.ok(data.runState);
      assert.equal(data.testState.emAndamento, true);
      assert.equal(data.cumulative.series.length, 1);
      assert.equal(data.cumulative.series[0].canal, "Google Ads (teste 2608)");
      const googleRow = data.channels.find((c) => c.canal === "Google Ads (teste 2608)")!;
      assert.equal(googleRow.gastoTotalBrl, 5);
      assert.equal(googleRow.cadastrosTotal, 1);
      assert.equal(googleRow.custoPorCadastroBrl, 5);
      const googleFreshness = data.freshness.find((f) => f.source === "Google Ads")!;
      assert.equal(googleFreshness.status, "ok");
      // #8210 melhoria 1/2: sem store nesta fixture (nenhum DB em
      // data/diaria-subscribers/) e sem `revisao` no run-state.json — nunca
      // 0/"ativa" por omissão.
      assert.equal(googleRow.ativosTotal, null, "sem store ingerido — ativosTotal nunca vira 0");
      assert.equal(googleRow.ativosAmostraN, 0);
      assert.equal(googleRow.pctAtivo, null);
      assert.equal(googleRow.pauseStatus, "desconhecido", "sem revisao.pausas — nunca 'ativa' por omissão");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#8288 — run-state.json com revisao.pausa", () => {
  async function build(root: string) {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => jsonResponse(500, {})) as typeof fetch;
    try {
      return await buildAdsCampaignEconomics(root, {
        now: () => new Date("2026-01-10T12:00:00Z"),
        env: {},
        fetchImpl: (async () => jsonResponse(500, {})) as typeof fetch,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  it("formato ATUAL (`pausa`, só ele — o shape REAL de produção) é lido: badge e dias de veiculação refletem a pausa", async () => {
    clearAdsCampaignEconomicsCache();
    const root = makeRoot();
    try {
      // Pausa ABERTA desde 05/01 — em 10/01 a campanha está pausada.
      writeRunState(root, { revisao: { pausa: { inicio: "2026-01-05T00:00:00-03:00", fim: null } } });
      const data = await build(root);
      assert.equal(data.runStateError, null, "o shape real nunca é erro de leitura");
      assert.ok(data.runState, "runState carrega — se virar null, o dateRange colapsa pra hoje..hoje");
      assert.equal(data.testState.diasDecorridos, 9);
      assert.equal(data.testState.diasVeiculacaoReal, 3, "01..04 veiculados; de 05/01 em diante, pausa aberta");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("achado 1 do review — pausa com timestamp INVERTIDO degrada visivelmente, NUNCA derruba a rota com 500", async () => {
    clearAdsCampaignEconomicsCache();
    const root = makeRoot();
    try {
      // `assertValidRunState` aceita (tipos corretos), `ads-test-pause-window`
      // recusa (fim < inicio). Sem o guard no caller, isto era um 500 no
      // `GET /api/ads` inteiro — a MESMA classe de falha que o #8288 fecha.
      writeRunState(root, {
        revisao: { pausa: { inicio: "2026-01-10T00:00:00-03:00", fim: "2026-01-05T00:00:00-03:00" } },
      });
      const data = await build(root);
      assert.match(data.runStateError ?? "", /invertido/, "o motivo é reportado, nunca engolido em silêncio");
      assert.equal(data.testState.d0, null, "janela do teste sai null — nunca número derivado de dado ilegível");
      assert.equal(data.testState.emAndamento, false);
      for (const row of data.channels) {
        assert.equal(row.pauseStatus, "desconhecido", `${row.canal}: dado ilegível nunca vira 'ativa' por omissão`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#8210 melhoria 1 — buildAdsCampaignEconomics: funil por canal a partir do store unificado", () => {
  it("store presente (Kit) com cadastro 'meta-ads' active — canal Meta Ads (teste 2608) ganha ativosTotal > 0, n visível", async () => {
    clearAdsCampaignEconomicsCache();
    const root = makeRoot();
    try {
      writeRunState(root);
      const storeDir = join(root, "data", "diaria-subscribers");
      mkdirSync(storeDir, { recursive: true });
      const storePath = join(storeDir, "diaria-subscribers.db");
      const db = openDiariaSubscribersDb(storePath);
      const subscriberId = ensureSubscriber(db, "kit", "kit-1", "leitor-kit@example.com", "2026-01-02T00:00:00.000Z");
      upsertSubscription(
        db,
        subscriberId,
        "kit",
        { status: "active", enteredAt: "2026-01-02T00:00:00.000Z", exitedAt: null, source: "kit", utmSource: "meta-ads" },
        "2026-01-02T00:00:00.000Z",
      );
      db.close();

      const fetchImpl = (async () => jsonResponse(200, { results: [] })) as typeof fetch;
      const data = await buildAdsCampaignEconomics(root, { now: () => new Date("2026-01-05T12:00:00Z"), env: {}, fetchImpl });

      const metaRow = data.channels.find((c) => c.canal === "Meta Ads (teste 2608)")!;
      assert.ok(metaRow, "canal Meta Ads (teste 2608) deveria aparecer (activeCountsByChannel cobre os 3 braços de ADS_TEST_2608_BRACOS)");
      assert.equal(metaRow.ativosTotal, 1);
      assert.equal(metaRow.ativosAmostraN, 1);
      assert.equal(metaRow.pctAtivo, 1);

      // Braço sem NENHUM subscriber no store ainda ganha entrada com
      // ativosTotal=0 (dado real medido — "0 de 0" é diferente de
      // "desconhecido"), nunca aparece ausente do mapa.
      const googleRow = data.channels.find((c) => c.canal === "Google Ads (teste 2608)")!;
      assert.equal(googleRow.ativosTotal, 0);
      assert.equal(googleRow.ativosAmostraN, 0);
      assert.equal(googleRow.pctAtivo, null, "sem amostra (n=0) — pctAtivo continua null, nunca 0/0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#8210 melhoria 2 — buildAdsCampaignEconomics: badge ativa/pausada a partir de revisao.pausas", () => {
  it("today dentro de revisao.pausas — os 3 braços saem com pauseStatus='pausada'", async () => {
    clearAdsCampaignEconomicsCache();
    const root = makeRoot();
    try {
      const dir = join(root, "data", "aquisicao", "teste-2608");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "run-state.json"),
        JSON.stringify({
          d0: "2026-01-01",
          fim_janela: "2026-01-15",
          religar_brevo: "2026-01-22",
          coorte_madura: "2026-02-11",
          apuracao_snapshot: "2026-02-15",
          bracos: ["Google Ads (teste 2608)", "Microsoft Ads (teste 2608)", "Meta Ads (teste 2608)"],
          registrado_em: "2026-01-01T00:00:00.000Z",
          revisao: { pausas: [{ desde: "2026-01-04", ate: "2026-01-06" }] },
        }),
        "utf8",
      );

      const fetchImpl = (async () => jsonResponse(200, { results: [] })) as typeof fetch;
      const data = await buildAdsCampaignEconomics(root, { now: () => new Date("2026-01-05T12:00:00Z"), env: {}, fetchImpl });

      assert.ok(data.channels.length > 0);
      assert.ok(data.channels.every((c) => c.pauseStatus === "pausada"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildAdsCampaignEconomics — lookback cobre D0..hoje, nunca um fixo 30 dias (self-review #7536)", () => {
  it("mais de 30 dias após o D0: a query GAQL enviada ainda começa em run-state.d0, não recorta os primeiros dias", async () => {
    clearAdsCampaignEconomicsCache();
    const root = makeRoot();
    try {
      writeRunState(root); // d0: 2026-01-01
      const env = {
        GOOGLE_ADS_DEVELOPER_TOKEN: "dt",
        GOOGLE_ADS_CLIENT_ID: "ci",
        GOOGLE_ADS_CLIENT_SECRET: "cs",
        GOOGLE_ADS_REFRESH_TOKEN: "rt",
        GOOGLE_ADS_LOGIN_CUSTOMER_ID: "1",
        GOOGLE_ADS_CUSTOMER_ID: "2",
      };
      let capturedQuery = "";
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        if (url.includes("oauth2.googleapis.com")) return jsonResponse(200, { access_token: "tok" });
        if (init?.body) {
          const parsed = JSON.parse(String(init.body));
          if (parsed.query) capturedQuery = parsed.query;
        }
        return jsonResponse(200, { results: [] });
      }) as typeof fetch;

      // 45 dias depois do D0 — mais que o antigo lookback fixo de 30 dias.
      await buildAdsCampaignEconomics(root, { now: () => new Date("2026-02-15T12:00:00Z"), env, fetchImpl });

      assert.match(capturedQuery, /BETWEEN '2026-01-01'/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildAdsCampaignEconomics — cache com TTL/forceRefresh", () => {
  it("2ª chamada dentro do TTL vem do cache (cached=true)", async () => {
    clearAdsCampaignEconomicsCache();
    const root = makeRoot();
    try {
      const fetchImpl = (async () => jsonResponse(200, { results: [] })) as typeof fetch;
      const first = await buildAdsCampaignEconomics(root, { now: () => new Date("2026-01-05T12:00:00Z"), env: {}, fetchImpl });
      assert.equal(first.cached, false);
      const second = await buildAdsCampaignEconomics(root, { now: () => new Date("2026-01-05T12:01:00Z"), env: {}, fetchImpl });
      assert.equal(second.cached, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildAdsData — followers (#8260 Fase 1)", () => {
  it("data/metrics/social-followers.jsonl ausente: followers=null, nunca lança (mesmo com o resto do relatório ok)", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      writeSpendCsv(root);
      writeSnapshot(root, "2026-02-01", [subscriberLine()]);
      const data = buildAdsData(root, { now: () => new Date("2026-02-05T12:00:00Z") });
      assert.equal(data.followers, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("arquivo presente: calcula saldo diário de IG e FB independentemente do resto do relatório", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      const dir = join(root, "data", "metrics");
      mkdirSync(dir, { recursive: true });
      const lines = [
        { date: "2026-09-14", platform: "instagram", followersCount: 100 },
        { date: "2026-09-15", platform: "instagram", followersCount: 102 },
        { date: "2026-09-14", platform: "facebook", followersCount: 10 },
        { date: "2026-09-15", platform: "facebook", followersCount: 9 },
      ];
      writeFileSync(join(dir, "social-followers.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
      const data = buildAdsData(root, { now: () => new Date("2026-09-16T12:00:00Z") });
      assert.ok(data.followers);
      assert.equal(data.followers!.instagram.totalDelta, 2);
      assert.equal(data.followers!.instagram.currentTotal, 102);
      assert.equal(data.followers!.facebook.totalDelta, -1);
      assert.equal(data.followers!.facebook.currentTotal, 9);
      assert.equal(data.followers!.parseErrors.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("linha malformada não derruba o carregamento das outras — vira parseErrors", () => {
    clearAdsCache();
    const root = makeRoot();
    try {
      const dir = join(root, "data", "metrics");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "social-followers.jsonl"),
        `${JSON.stringify({ date: "2026-09-14", platform: "instagram", followersCount: 100 })}\nnot json\n`,
        "utf8",
      );
      const data = buildAdsData(root, { now: () => new Date("2026-09-16T12:00:00Z") });
      assert.ok(data.followers);
      assert.equal(data.followers!.instagram.points.length, 1);
      assert.equal(data.followers!.parseErrors.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// storeResultProvider (#8292) — leitura ÚNICA do store compartilhada entre
// buildAdsData e buildAdsCampaignEconomics no mesmo request. Antes desta
// correção, `handleApiAds` chamava as 2 funções sem compartilhar nada e
// cada uma relia (via `buildCacCompatibleSubscribersFromStore`) numa
// varredura completa do store — 2 leituras completas por request, medidas
// em 77s CADA em produção (#8292). Este teste trava que, quando um
// `storeResultProvider` memoizado é passado pras 2 funções, o loader
// subjacente roda NO MÁXIMO 1 vez, mesmo as 2 funções pedindo o resultado.
// ---------------------------------------------------------------------------

describe("storeResultProvider (#8292) — 1 única leitura do store por request", () => {
  it("buildAdsData + buildAdsCampaignEconomics compartilhando o mesmo provider: o loader roda no máximo 1 vez", async () => {
    clearAdsCache();
    clearAdsCampaignEconomicsCache();
    const root = makeRoot();
    try {
      writeSpendCsv(root, "canal,mes,moeda,valor,fonte\nMeta Ads (teste 2608),2026-09,BRL,517.85,teste\n");
      writeRunState(root);
      const storeDir = join(root, "data", "diaria-subscribers");
      mkdirSync(storeDir, { recursive: true });
      const storePath = join(storeDir, "diaria-subscribers.db");
      const db = openDiariaSubscribersDb(storePath);
      const subscriberId = ensureSubscriber(db, "kit", "kit-1", "leitor-kit@example.com", "2026-09-01T00:00:00.000Z");
      upsertSubscription(
        db,
        subscriberId,
        "kit",
        { status: "active", enteredAt: "2026-09-01T00:00:00.000Z", exitedAt: null, source: "kit", utmSource: "meta-ads" },
        "2026-09-01T00:00:00.000Z",
      );
      db.close();

      // 1 único provider memoizado, passado pras 2 funções — a leitura real
      // do DB (dentro de `loadStoreSubscribers`) acontece na 1ª chamada,
      // NENHUMA das duas vezes seguintes refaz o scan (garantido por
      // `makeMemoizedStoreResultProvider` — ver o teste dedicado abaixo
      // que trava essa memoização isoladamente).
      const sharedProvider = makeMemoizedStoreResultProvider(storePath);
      const fetchImpl = (async () => jsonResponse(200, { results: [] })) as typeof fetch;

      const adsData = buildAdsData(root, {
        forceRefresh: true,
        now: () => new Date("2026-09-17T12:00:00Z"),
        storeResultProvider: sharedProvider,
      });
      const campaignEconomics = await buildAdsCampaignEconomics(root, {
        forceRefresh: true,
        now: () => new Date("2026-09-17T12:00:00Z"),
        env: {},
        fetchImpl,
        storeResultProvider: sharedProvider,
      });

      assert.equal(adsData.subscribersSource, "store");
      const metaRow = campaignEconomics.channels.find((c) => c.canal === "Meta Ads (teste 2608)")!;
      assert.equal(metaRow.ativosTotal, 1, "resultado do store compartilhado ainda chega corretamente nas 2 funções");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("makeMemoizedStoreResultProvider: chama loadStoreSubscribers no máximo 1 vez mesmo com N chamadas ao provider", () => {
    const root = makeRoot();
    try {
      const storeDir = join(root, "data", "diaria-subscribers");
      mkdirSync(storeDir, { recursive: true });
      const storePath = join(storeDir, "diaria-subscribers.db");
      const db = openDiariaSubscribersDb(storePath);
      ensureSubscriber(db, "kit", "kit-1", "leitor-kit@example.com", "2026-09-01T00:00:00.000Z");
      db.close();

      const provider = makeMemoizedStoreResultProvider(storePath);
      const r1 = provider();
      const r2 = provider();
      const r3 = provider();
      assert.equal(r1, r2, "mesma referência de objeto — não recalcula");
      assert.equal(r2, r3);
      assert.ok(r1); // store presente, não deveria vir null
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("store ausente: provider memoizado devolve null de forma estável (nunca lança), sem virar 0 em nenhum caller", () => {
    const root = makeRoot();
    try {
      const storePath = join(root, "data", "diaria-subscribers", "diaria-subscribers.db"); // dir nem existe
      const provider = makeMemoizedStoreResultProvider(storePath);
      assert.equal(provider(), null);
      assert.equal(provider(), null); // 2ª chamada também estável
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
