/**
 * test/kit-test-broadcast.test.ts (#10395)
 *
 * `isKitTestBroadcast()` é a fonte única de "este broadcast do Kit é test-send"
 * (caminho 5 da #10307). Cobre os três sinais (ids registrados, prefixo
 * `[teste]`, filtro só na tag de teste), os falsos positivos que ele não pode
 * ter (edição real, `[testemunho]`, filtro vazio = base inteira) e o consumidor
 * que antes não filtrava nada (`reconcile-send-audiences.ts`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filterTargetsOnlyTestTags,
  hasKitTestSubjectPrefix,
  isKitTestBroadcast,
  KIT_TEST_SUBJECT_PREFIX,
  makeKitTestBroadcastPredicate,
} from "../scripts/lib/shared/kit-test-broadcast.ts";
import {
  measureKitRecentDelivery,
  pickLatestRealKitBroadcast,
  type KitRecentDeliveryDeps,
} from "../scripts/reconcile-send-audiences.ts";
import { listAllBroadcasts } from "../scripts/lib/kit-client.ts";
import { daysSinceFirstCompletedBroadcast } from "../scripts/dmarc-enforcement-engine.ts";
import { isRealEditionTitle } from "../scripts/lib/anual/annual-collect.ts";

describe("hasKitTestSubjectPrefix", () => {
  it("casa o prefixo do --send-test e as variantes de probe", () => {
    assert.equal(hasKitTestSubjectPrefix(`${KIT_TEST_SUBJECT_PREFIX} Manchete`), true);
    assert.equal(hasKitTestSubjectPrefix("[TESTE] Manchete"), true);
    assert.equal(hasKitTestSubjectPrefix("  [teste] Manchete"), true);
    assert.equal(hasKitTestSubjectPrefix("[teste-464] probe"), true);
  });

  it("#10400: casa [probe-…] e [teste #N] (o que annual-collect pegava por startsWith('['))", () => {
    assert.equal(hasKitTestSubjectPrefix("[probe-rodape] centralizar footer"), true);
    assert.equal(hasKitTestSubjectPrefix("[probe-6047] custom field"), true);
    assert.equal(hasKitTestSubjectPrefix("[probe] x"), true);
    assert.equal(hasKitTestSubjectPrefix("[teste #8371] merge tag voto_token"), true);
    assert.equal(hasKitTestSubjectPrefix("[prober] x"), false);
    assert.equal(hasKitTestSubjectPrefix("[Brasil] manchete real"), false);
  });

  it("não casa edição real, palavra parecida nem ausência", () => {
    assert.equal(hasKitTestSubjectPrefix("Manchete real"), false);
    assert.equal(hasKitTestSubjectPrefix("Manchete [teste] no meio"), false);
    assert.equal(hasKitTestSubjectPrefix("[testemunho] da semana"), false);
    assert.equal(hasKitTestSubjectPrefix(undefined), false);
    assert.equal(hasKitTestSubjectPrefix(null), false);
  });
});

describe("filterTargetsOnlyTestTags", () => {
  it("filtro escopado só à tag de teste (shape de buildTestSendFilter) → true", () => {
    assert.equal(filterTargetsOnlyTestTags([{ all: [{ type: "tag", ids: [42] }] }], new Set([42])), true);
  });

  it("filtro vazio (= base inteira, #6126), outra tag, tag mista ou lixo → false", () => {
    assert.equal(filterTargetsOnlyTestTags([], new Set([42])), false);
    assert.equal(filterTargetsOnlyTestTags([{ all: [{ type: "tag", ids: [7] }] }], new Set([42])), false);
    assert.equal(filterTargetsOnlyTestTags([{ all: [{ type: "tag", ids: [42, 7] }] }], new Set([42])), false);
    assert.equal(filterTargetsOnlyTestTags([{ all: [{ type: "segment", ids: [42] }] }], new Set([42])), false);
    assert.equal(filterTargetsOnlyTestTags([{ all: [] }], new Set([42])), false);
    assert.equal(filterTargetsOnlyTestTags(null, new Set([42])), false);
    assert.equal(filterTargetsOnlyTestTags([{ all: [{ type: "tag", ids: [42] }] }], new Set([])), false);
  });
});

describe("isKitTestBroadcast", () => {
  it("sinal 1: id registrado em test_broadcast_ids (mesmo com assunto sem prefixo)", () => {
    assert.equal(isKitTestBroadcast({ id: 556, subject: "Manchete" }, { testBroadcastIds: new Set([556]) }), true);
    assert.equal(isKitTestBroadcast({ id: "556", subject: "Manchete" }, { testBroadcastIds: new Set([556]) }), true);
    assert.equal(isKitTestBroadcast({ id: 555, subject: "Manchete" }, { testBroadcastIds: new Set([556]) }), false);
  });

  it("sinal 2: prefixo no subject ou no title (cache unificado usa title = subject)", () => {
    assert.equal(isKitTestBroadcast({ subject: "[teste] Manchete" }), true);
    assert.equal(isKitTestBroadcast({ title: "[teste] Manchete" }), true);
  });

  it("sinal 3: subscriber_filter só na tag de teste", () => {
    const b = { subject: "Manchete", subscriber_filter: [{ all: [{ type: "tag", ids: [42] }] }] };
    assert.equal(isKitTestBroadcast(b, { testTagIds: new Set([42]) }), true);
    assert.equal(isKitTestBroadcast(b), false, "sem o id da tag em mãos, o sinal 3 não dispara");
  });

  it("edição real (filtro vazio, assunto normal, id não registrado) nunca é teste", () => {
    assert.equal(
      isKitTestBroadcast({ id: 555, subject: "Modelos se replicam sozinhos", subscriber_filter: [] }, {
        testBroadcastIds: new Set([556]),
        testTagIds: new Set([42]),
      }),
      false,
    );
  });
});

describe("reconcile-send-audiences: pickLatestRealKitBroadcast (#10395)", () => {
  const b = (id: number, subject: string, published_at: string) => ({ id, subject, published_at, created_at: published_at });

  it("REGRESSÃO: test-send mais recente que a edição não vira a 'entrega recente' do Kit", () => {
    const real = b(1, "Manchete real", "2026-10-18T09:00:00Z");
    const teste = b(2, "[teste] Manchete real", "2026-10-18T22:00:00Z");
    assert.equal(pickLatestRealKitBroadcast([real, teste])?.id, 1);
    assert.equal(pickLatestRealKitBroadcast([teste, real])?.id, 1);
  });

  it("só testes entre os completed → null (o guard reporta measured:false, nunca mede 1)", () => {
    assert.equal(pickLatestRealKitBroadcast([b(2, "[teste] x", "2026-10-18T22:00:00Z")]), null);
  });
  it("measureKitRecentDelivery: só testes → measured:false (null do picker), sem buscar stats", async () => {
    let statsCalls = 0;
    const r = await measureKitRecentDelivery({
      listBroadcasts: (async () => ({
        broadcasts: [b(2, "[teste] x", "2026-10-18T22:00:00Z")],
        pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 50 },
      })) as unknown as KitRecentDeliveryDeps["listBroadcasts"],
      getBroadcastStats: async () => {
        statsCalls++;
        return { recipients: 1 };
      },
    });
    assert.equal(r.measured, false);
    assert.equal(statsCalls, 0);
  });

  it("measureKitRecentDelivery: mede a edição real, nunca o test-send mais recente", async () => {
    const asked: number[] = [];
    const r = await measureKitRecentDelivery({
      listBroadcasts: (async () => ({
        broadcasts: [b(1, "Manchete real", "2026-10-18T09:00:00Z"), b(2, "[teste] Manchete real", "2026-10-18T22:00:00Z")],
        pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 50 },
      })) as unknown as KitRecentDeliveryDeps["listBroadcasts"],
      getBroadcastStats: async (id) => {
        asked.push(id);
        return { recipients: 1234 };
      },
    });
    assert.equal(r.measured, true);
    assert.equal(r.recipients, 1234);
    assert.match(r.detail ?? "", /broadcast 1 .*1 test-send\(s\) descartado/);
    assert.deepEqual(asked, [1]);
  });
});

describe("makeKitTestBroadcastPredicate", () => {
  it("materializa os sinais uma vez e filtra a lista com os 3 sinais", () => {
    const isTest = makeKitTestBroadcastPredicate({ testBroadcastIds: ["556"], testTagIds: [42] });
    const lista = [
      { id: 555, subject: "Edição real", subscriber_filter: [] },
      { id: 556, subject: "Sem prefixo, mas registrado" },
      { id: 557, subject: "[teste] Manchete" },
      { id: 558, subject: "Manchete", subscriber_filter: [{ all: [{ type: "tag", ids: [42] }] }] },
    ];
    assert.deepEqual(
      lista.filter((b) => !isTest(b)).map((b) => b.id),
      [555],
    );
  });

  it("sem sinais, só o prefixo conta", () => {
    const isTest = makeKitTestBroadcastPredicate();
    assert.equal(isTest({ id: 1, subject: "[teste] X" }), true);
    assert.equal(isTest({ id: 1, subject: "X" }), false);
  });
});

describe("#10400: paginação e consumidores fora do helper", () => {
  const pg = (has_next_page: boolean, end_cursor: string | null) => ({
    has_previous_page: false,
    has_next_page,
    start_cursor: null,
    end_cursor,
    per_page: 100,
  });
  const b = (id: number, subject: string, published_at: string, extra: Record<string, unknown> = {}) => ({
    id,
    subject,
    published_at,
    created_at: published_at,
    status: "completed" as const,
    ...extra,
  });
  type ListFn = Parameters<typeof listAllBroadcasts>[1];

  it("REGRESSÃO: 1ª página só de test-sends não esconde a edição real da página seguinte", async () => {
    const afters: (string | undefined)[] = [];
    const r = await measureKitRecentDelivery({
      listBroadcasts: (async (opts: { after?: string }) => {
        afters.push(opts.after);
        return opts.after === "c1"
          ? { broadcasts: [b(1, "Manchete real", "2026-10-17T09:00:00Z")], pagination: pg(false, null) }
          : { broadcasts: [b(2, "[teste] x", "2026-10-18T22:00:00Z")], pagination: pg(true, "c1") };
      }) as unknown as KitRecentDeliveryDeps["listBroadcasts"],
      getBroadcastStats: async () => ({ recipients: 900 }),
    });
    assert.equal(r.measured, true);
    assert.equal(r.recipients, 900);
    assert.deepEqual(afters, [undefined, "c1"]);
  });

  it("só testes: reason diz quantos foram descartados", async () => {
    const r = await measureKitRecentDelivery({
      listBroadcasts: (async () => ({
        broadcasts: [b(2, "[teste] x", "2026-10-18T22:00:00Z"), b(3, "[probe-1] y", "2026-10-18T23:00:00Z")],
        pagination: pg(false, null),
      })) as unknown as KitRecentDeliveryDeps["listBroadcasts"],
      getBroadcastStats: async () => ({ recipients: 1 }),
    });
    assert.equal(r.measured, false);
    assert.match(r.reason ?? "", /2 descartado/);
  });

  it("prefere o real público ao envio por tag não-público mais recente (mensal dos apoiadores)", () => {
    const diaria = b(1, "Manchete", "2026-10-18T09:00:00Z", { public: true });
    const apoio = b(2, "Retrospectiva de setembro", "2026-10-18T10:00:00Z", { public: false });
    assert.equal(pickLatestRealKitBroadcast([diaria, apoio])?.id, 1);
    // era da rampa: nenhum real público → cai no real mais recente
    assert.equal(pickLatestRealKitBroadcast([{ ...diaria, public: false }, apoio])?.id, 2);
  });

  it("detail relata reais não-públicos mais recentes preteridos pela preferência por público", async () => {
    const r = await measureKitRecentDelivery({
      listBroadcasts: (async () => ({
        broadcasts: [
          b(1, "Manchete", "2026-10-17T09:00:00Z", { public: true }),
          b(2, "Edição promovida à mão", "2026-10-18T09:00:00Z", { public: false }),
        ],
        pagination: pg(false, null),
      })) as unknown as KitRecentDeliveryDeps["listBroadcasts"],
      getBroadcastStats: async () => ({ recipients: 900 }),
    });
    assert.equal(r.measured, true);
    assert.match(r.detail ?? "", /broadcast 1 /);
    assert.match(r.detail ?? "", /1 real\(is\) não-público\(s\) mais recente\(s\) preterido/);
  });

  it("listAllBroadcasts: truncamento avisa em stderr", async () => {
    const always = (async () => ({
      broadcasts: [b(1, "x", "2026-10-01T00:00:00Z")],
      pagination: pg(true, "c"),
    })) as unknown as ListFn;
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await listAllBroadcasts({ maxPages: 2 }, always);
    } finally {
      process.stderr.write = orig;
    }
    assert.ok(writes.some((w) => /TRUNCADA/.test(w)), "esperava aviso de truncamento em stderr");
  });

  it("annual: título começando com '[' continua excluído (não estreita a regra antiga)", () => {
    assert.equal(isRealEditionTitle("[probe-rodape] footer"), false);
    assert.equal(isRealEditionTitle("[TEST] rótulo futuro"), false);
    assert.equal(isRealEditionTitle("[rascunho] x"), false);
    assert.equal(isRealEditionTitle("Manchete real"), true);
  });

  it("listAllBroadcasts: para no teto (truncated) e lança em has_next_page sem cursor", async () => {
    const always = (async () => ({
      broadcasts: [b(1, "x", "2026-10-01T00:00:00Z")],
      pagination: pg(true, "c"),
    })) as unknown as ListFn;
    const r = await listAllBroadcasts({ status: "completed", maxPages: 3 }, always);
    assert.equal(r.pages, 3);
    assert.equal(r.truncated, true);
    assert.equal(r.broadcasts.length, 3);
    const broken = (async () => ({ broadcasts: [], pagination: pg(true, null) })) as unknown as ListFn;
    await assert.rejects(listAllBroadcasts({}, broken), /end_cursor ausente/);
  });

  it("dmarc: test-send/probe mais antigo não conta como 1º envio", () => {
    const now = new Date("2026-10-18T00:00:00Z");
    const days = daysSinceFirstCompletedBroadcast(
      [b(1, "[teste] probe inicial", "2026-08-01T00:00:00Z"), b(2, "Edição real", "2026-10-08T00:00:00Z")],
      now,
    );
    assert.equal(days, 10);
    assert.equal(daysSinceFirstCompletedBroadcast([b(1, "[probe-x] y", "2026-08-01T00:00:00Z")], now), null);
  });
});
