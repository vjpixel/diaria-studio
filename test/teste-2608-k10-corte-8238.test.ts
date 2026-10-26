/**
 * test/teste-2608-k10-corte-8238.test.ts (#8238 — resíduo da Emenda 17/09)
 *
 * Os dois itens que sobraram da apuração do teste 2608:
 * - corte determinístico por `event.ts` (`cac-report --corte`): sem ele, rodar
 *   a apuração dias depois contava as entregas das edições novas e mudava o
 *   leitor-v1 de quem estava perto do piso de 20 recebidas;
 * - K10 informativo (clique em >=1 das 10 primeiras recebidas), que a seção
 *   da apuração listava como "não calculado".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEventCutoff,
  buildCacCompatibleSubscribersFromStore,
  computeK10FromEvents,
  loadK10ByEmailFromStore,
  type PlatformCapabilities,
} from "../scripts/lib/leitor-store.ts";
import {
  openDiariaSubscribersDb,
  ensureSubscriber,
  upsertSubscription,
  recordEvent,
  type SubscriberEventRow,
  type SubscriberAlias,
} from "../scripts/lib/diaria-subscribers-db.ts";
import {
  computeEmendaArm,
  computeEmendaSection,
  formatEmendaSectionMarkdown,
  type EmendaRunStateInput,
} from "../scripts/lib/teste-2608-emenda.ts";
import { cacReportCorteExclusiveMs, main as cacReportMain } from "../scripts/cac-report.ts";
import { buildApuracaoCacReportArgv } from "../scripts/ads-test-watch.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";

const G = "Google Ads (teste 2608)";
const M = "Meta Ads (teste 2608)";
const MS = "Microsoft Ads (teste 2608)";

const RUN_STATE: EmendaRunStateInput = {
  d0: "2026-09-05",
  fim_janela: "2026-09-23",
  bracos: [G, MS, M],
  revisao: {
    pausa: { inicio: "2026-09-09T16:05:36-03:00", fim: "2026-09-17T00:16:00-03:00" } as never,
  },
};

const KIT_CAPS: PlatformCapabilities = { platformsWithDelivered: new Set(["kit"]) };
const KIT_ALIAS = [{ platform: "kit", email: "a@example.com" }] as unknown as SubscriberAlias[];

/** `n` edições entregues em dias consecutivos a partir de 01/10, com clique nas listadas. */
function kitEvents(n: number, clickedIdx: number[]): SubscriberEventRow[] {
  const out: SubscriberEventRow[] = [];
  for (let i = 0; i < n; i++) {
    const ts = new Date(Date.UTC(2026, 9, 1 + i, 9)).toISOString();
    out.push({ platform: "kit", type: "delivered", edicao: `b${i}`, external_event_id: `d${i}`, ts });
    if (clickedIdx.includes(i)) out.push({ platform: "kit", type: "click", edicao: `b${i}`, external_event_id: `c${i}`, ts });
  }
  return out;
}

describe("applyEventCutoff", () => {
  it("mantém só ts anterior ao corte; ts ausente/ilegível sai num corte, fica sem corte", () => {
    const ev = [{ ts: "2026-10-21T10:00:00.000Z" }, { ts: "2026-10-22T03:00:00.000Z" }, { ts: undefined }, { ts: "lixo" }];
    const cut = cacReportCorteExclusiveMs("2026-10-21"); // 22/10 00h00 BRT = 03h00Z
    assert.deepEqual(applyEventCutoff(ev, cut).map((e) => e.ts), ["2026-10-21T10:00:00.000Z"]);
    assert.equal(applyEventCutoff(ev, null).length, 4);
  });

  it("o dia de corte inteiro em BRT fica dentro (23h59 BRT do dia de corte = 02h59Z do dia seguinte)", () => {
    const cut = cacReportCorteExclusiveMs("2026-10-21");
    assert.equal(cut, Date.parse("2026-10-22T00:00:00-03:00"));
    assert.equal(applyEventCutoff([{ ts: "2026-10-22T02:59:00.000Z" }], cut).length, 1);
  });
});

describe("computeK10FromEvents", () => {
  it("clique na 3ª recebida → K10; clique só na 11ª → não K10", () => {
    assert.deepEqual(computeK10FromEvents(kitEvents(15, [2]), KIT_ALIAS, KIT_CAPS, new Map()), { k10: true, recebidasConsideradas: 10 });
    assert.deepEqual(computeK10FromEvents(kitEvents(15, [10]), KIT_ALIAS, KIT_CAPS, new Map()), { k10: false, recebidasConsideradas: 10 });
  });

  it("a ordem é a do ts de entrega, não a da lista de eventos", () => {
    const ev = kitEvents(12, [0]).reverse(); // b0 (clicada) vem por último na lista
    assert.equal(computeK10FromEvents(ev, KIT_ALIAS, KIT_CAPS, new Map()).k10, true);
  });

  it("menos de 10 recebidas: conta o que recebeu e devolve quantas", () => {
    assert.deepEqual(computeK10FromEvents(kitEvents(4, []), KIT_ALIAS, KIT_CAPS, new Map()), { k10: false, recebidasConsideradas: 4 });
  });

  it("plataforma sem delivered usa sent − bounce (edição com bounce não é recebida)", () => {
    const alias = [{ platform: "brevo_diaria", email: "a@example.com" }] as unknown as SubscriberAlias[];
    const caps: PlatformCapabilities = { platformsWithDelivered: new Set() };
    const ev: SubscriberEventRow[] = [
      { platform: "brevo_diaria", type: "sent", edicao: "c1", external_event_id: "s1", ts: "2026-10-01T09:00:00.000Z" },
      { platform: "brevo_diaria", type: "bounce", edicao: "c1", external_event_id: "x1", ts: "2026-10-01T09:00:00.000Z" },
      { platform: "brevo_diaria", type: "sent", edicao: "c2", external_event_id: "s2", ts: "2026-10-02T09:00:00.000Z" },
    ];
    assert.equal(computeK10FromEvents(ev, alias, caps, new Map()).recebidasConsideradas, 1);
  });
});

describe("store com corte: buildCacCompatibleSubscribersFromStore / loadK10ByEmailFromStore", () => {
  function seed(path: string): void {
    const db = openDiariaSubscribersDb(path);
    const id = ensureSubscriber(db, "kit", "k1", "a@example.com", "2026-09-06T13:00:00.000Z");
    upsertSubscription(db, id, "kit", { status: "active", enteredAt: "2026-09-06T13:00:00.000Z", exitedAt: null, source: "kit", utmSource: "google-ads" }, "2026-09-06T13:00:00.000Z");
    // 19 entregas até 21/10, a 20ª em 23/10 (depois do corte), clique só na 20ª.
    for (let i = 0; i < 20; i++) {
      const ts = i < 19 ? new Date(Date.UTC(2026, 9, 1 + i, 9)).toISOString() : "2026-10-23T09:00:00.000Z";
      recordEvent(db, { subscriberId: id, platform: "kit", type: "delivered", externalEventId: `d${i}`, edicao: `b${i}`, ts });
    }
    recordEvent(db, { subscriberId: id, platform: "kit", type: "click", externalEventId: "c19", edicao: "b19", ts: "2026-10-23T09:00:00.000Z" });
    // Cadastro DEPOIS do corte: não existia na data de corte.
    const late = ensureSubscriber(db, "kit", "k2", "b@example.com", "2026-10-24T13:00:00.000Z");
    upsertSubscription(db, late, "kit", { status: "active", enteredAt: "2026-10-24T13:00:00.000Z", exitedAt: null, source: "kit", utmSource: "google-ads" }, "2026-10-24T13:00:00.000Z");
    db.close();
  }

  it("REGRESSÃO: sem corte a 20ª entrega (posterior) entra; com corte, não — e o cadastro tardio some", () => {
    const root = mkdtempSync(join(tmpdir(), "k10-corte-8238-"));
    try {
      const path = join(root, "s.db");
      seed(path);
      const db = openDiariaSubscribersDb(path);
      try {
        const semCorte = buildCacCompatibleSubscribersFromStore(db);
        const a = semCorte.find((s) => s.email === "a@example.com");
        assert.equal(a?.stats?.total_received, 20);
        assert.ok(semCorte.some((s) => s.email === "b@example.com"));

        const eventsBeforeMs = cacReportCorteExclusiveMs("2026-10-21");
        const comCorte = buildCacCompatibleSubscribersFromStore(db, undefined, { eventsBeforeMs });
        const a2 = comCorte.find((s) => s.email === "a@example.com");
        assert.equal(a2?.stats?.total_received, 19, "a entrega de 23/10 não existia em 21/10");
        assert.equal(a2?.stats?.total_unique_clicked, 0);
        assert.ok(!comCorte.some((s) => s.email === "b@example.com"), "cadastro de 24/10 fica fora do corte de 21/10");

        const k10 = loadK10ByEmailFromStore(db, undefined, { eventsBeforeMs });
        assert.deepEqual(k10.get("a@example.com"), { k10: false, recebidasConsideradas: 10 });
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function sub(utm: string, createdIso: string, email: string, clicked = 5): BeehiivBackupSubscriber {
  return {
    email,
    status: "active",
    created: Math.floor(Date.parse(createdIso) / 1000),
    utm_source: utm,
    utm_medium: "",
    utm_campaign: "",
    referring_site: "",
    stats: { total_received: 25, total_unique_clicked: clicked },
  } as BeehiivBackupSubscriber;
}

describe("seção da apuração com K10", () => {
  const subs = [
    sub("google-ads", "2026-09-06T10:00:00-03:00", "G1@Example.com"),
    sub("google-ads", "2026-09-06T11:00:00-03:00", "g2@example.com"),
    sub("google-ads", "2026-09-20T10:00:00-03:00", "g3@example.com"),
  ];
  const k10 = new Map([
    ["g1@example.com", { k10: true, recebidasConsideradas: 10 }],
    ["g2@example.com", { k10: false, recebidasConsideradas: 10 }],
    ["g3@example.com", { k10: true, recebidasConsideradas: 6 }],
  ]);
  const spend = [{ canal: G, mes: "2026-09", moeda: "BRL", valor: 300, fonte: "t" }];

  it("conta K10 por fase (e-mail casado sem caixa) e divide o gasto", () => {
    const arm = computeEmendaArm(subs, spend, RUN_STATE, G, { [G]: { "pre-pausa": 100, "pos-retomada": 200 } }, k10);
    assert.deepEqual(arm.fases.map((f) => f.k10), [1, 1]);
    assert.deepEqual(arm.fases.map((f) => f.cadastrosCom10Recebidas), [2, 0]);
    assert.deepEqual(arm.fases.map((f) => f.custoPorK10), [100, 200]);
    assert.equal(arm.k10, 2);
    assert.equal(arm.custoPorK10, 150);
    assert.deepEqual(arm.membros.map((m) => m.k10), [true, false, true]);
  });

  it("sem mapa de K10: colunas nulas e o markdown diz que não calculou", () => {
    const arm = computeEmendaArm(subs, spend, RUN_STATE, G);
    assert.equal(arm.k10, null);
    assert.equal(arm.custoPorK10, null);
    const md = formatEmendaSectionMarkdown(computeEmendaSection(subs, spend, RUN_STATE, { runStatePath: "rs.json", corte: "2026-10-21" })).join("\n");
    assert.match(md, /K10 não calculado/);
    assert.match(md, /sem corte por `event\.ts`/);
    assert.doesNotMatch(md, /escopo remanescente/);
  });

  it("com mapa e corte: tabela informativa de K10 e frase do corte com o limite do ts do Kit", () => {
    const s = computeEmendaSection(subs, spend, RUN_STATE, { runStatePath: "rs.json", corte: "2026-10-21", corteEventos: true }, null, k10);
    const md = formatEmendaSectionMarkdown(s).join("\n");
    assert.match(md, /Informativo: K10/);
    assert.match(md, /\| \*\*Google Ads \(teste 2608\)\*\* \| total \| 3 \| 2 \| 66\.7% \| R\$ 300,00 \| R\$ 150,00 \|/);
    assert.match(md, /Corte determinístico: 2026-10-21/);
    assert.match(md, /clique tardio/);
  });
});

describe("cac-report --corte", () => {
  async function run(argv: string[], root?: string) {
    const exitBefore = process.exitCode;
    process.exitCode = undefined;
    const origLog = console.log;
    const origErr = console.error;
    let out = "";
    console.log = (x: string) => { out += x; };
    console.error = () => {};
    try {
      const r = await cacReportMain(argv, root);
      return { r, code: process.exitCode, out };
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.exitCode = exitBefore;
    }
  }

  it("recusa --corte com --fonte beehiiv e data inválida", async () => {
    assert.equal((await run(["--fonte", "beehiiv", "--corte", "2026-10-21", "--no-register"])).code, 1);
    assert.equal((await run(["--fonte", "store", "--snapshot", "2026-10-21", "--corte", "2026-02-30", "--no-register"])).code, 1);
  });

  it("apuração com --corte: K10 calculado, corte na procedência e leitura cortada", async () => {
    const root = mkdtempSync(join(tmpdir(), "cac-report-corte-8238-"));
    try {
      const spendPath = join(root, "spend.csv");
      writeFileSync(spendPath, "canal,mes,moeda,valor,fonte\nGoogle Ads (teste 2608),2026-09,BRL,500.57,teste\n", "utf8");
      const storePath = join(root, "s.db");
      const db = openDiariaSubscribersDb(storePath);
      const id = ensureSubscriber(db, "kit", "k1", "l1@example.com", "2026-09-06T13:00:00.000Z");
      upsertSubscription(db, id, "kit", { status: "active", enteredAt: "2026-09-06T13:00:00.000Z", exitedAt: null, source: "kit", utmSource: "google-ads" }, "2026-09-06T13:00:00.000Z");
      for (let i = 0; i < 12; i++) {
        recordEvent(db, { subscriberId: id, platform: "kit", type: "delivered", externalEventId: `d${i}`, edicao: `b${i}`, ts: new Date(Date.UTC(2026, 9, 1 + i, 9)).toISOString() });
      }
      recordEvent(db, { subscriberId: id, platform: "kit", type: "click", externalEventId: "c1", edicao: "b1", ts: "2026-10-02T09:00:00.000Z" });
      db.close();
      const rsPath = join(root, "run-state.json");
      writeFileSync(rsPath, JSON.stringify(RUN_STATE));

      const { r, code, out } = await run(
        [
          "--fonte", "store", "--snapshot", "2026-10-05", "--corte", "2026-10-05", "--spend", spendPath,
          "--origem", join(root, "x.json"), "--store-db", storePath, "--no-kit", "--no-store-leitores", "--no-ltv",
          "--apuracao-2608", rsPath, "--no-register",
        ],
        root,
      );
      assert.ok(r, `cac-report deveria rodar (exit ${code})`);
      assert.match(out, /Corte por evento: só eventos com `ts` até 2026-10-05 23h59 BRT/);
      // Corte em 05/10: 5 entregas (01..05/10), clique na 2ª → K10.
      assert.match(out, /\| \*\*Google Ads \(teste 2608\)\*\* \| total \| 1 \| 1 \| 0\.0% \|/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ads-test-watch: argv da apuração", () => {
  it("com run-state, corta a leitura no próprio apuracao_snapshot", () => {
    assert.deepEqual(buildApuracaoCacReportArgv("2026-10-21", "rs.json"), [
      "--snapshot", "2026-10-21", "--fonte", "store", "--apuracao-2608", "rs.json", "--corte", "2026-10-21",
    ]);
    assert.deepEqual(buildApuracaoCacReportArgv("2026-10-21"), ["--snapshot", "2026-10-21", "--fonte", "store"]);
  });
});
