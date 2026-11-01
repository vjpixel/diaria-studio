/**
 * test/brevo-semanal-split-11286.test.ts (#11286)
 *
 * Divisão segunda/terça da semanal da Brevo diária (resíduo do #11226),
 * desenho (a): lista principal com todo mundo, 2ª lista "terça", campanha de
 * segunda com `exclusionListIds: [terca]` e de terça com `listIds: [terca]`,
 * agendada 24h depois. Tudo com deps injetadas: nenhuma chamada à Brevo.
 *
 * Regressões cobertas (o cenário real da issue):
 * - acima do teto e com lista de terça, a principal EXCLUI a terça e nasce a
 *   2ª campanha (antes saía inteira na segunda);
 * - a lista de terça nunca fica com quem saiu da principal (unlink/supressão);
 * - a metade de terça acumula semanais no score (antes só segunda contava).
 */
import { describe, it, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  buildSemanalEvaluationInput,
  checkSemanalCapacity,
  isSemanalSendDay,
  parseBrevoDiariaSemanal,
  semanalSplitGroup,
} from "../scripts/lib/brevo-diaria-semanal.ts";
import {
  buildMainCampaignRecipients,
  decideSemanalSplit,
  planTercaListReconcile,
  reconcileTercaList,
  tercaScheduledAt,
  TERCA_LIST_BATCH_SIZE,
  type TercaListDeps,
} from "../scripts/lib/brevo-semanal-split.ts";
import {
  checkReuseSplitConsistency,
  ensureTercaCampaign,
  readBrevoDiariaPublished,
  writeBrevoDiariaPublished,
  type BrevoDiariaPublished,
} from "../scripts/publish-daily-brevo.ts";
import { scheduleDailyBrevo, type ScheduleDailyBrevoDeps } from "../scripts/schedule-daily-brevo.ts";
import { createTercaList, TERCA_LIST_NAME } from "../scripts/create-brevo-semanal-terca-list.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** E-mails de teste com grupo conhecido (o hash é determinístico). */
function emailsOfGroup(group: "segunda" | "terca", n: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) {
    const e = `pessoa${i}@exemplo.com`;
    if (semanalSplitGroup(e) === group) out.push(e);
  }
  return out;
}

const MAIN = 7;
const TERCA = 8;

describe("parseBrevoDiariaSemanal — terca_list_id (#11286)", () => {
  const base = { enabled: true, desde: "2026-11-02" };
  it("ausente ou null ⇒ tercaListId null", () => {
    const a = parseBrevoDiariaSemanal(base);
    const b = parseBrevoDiariaSemanal({ ...base, terca_list_id: null });
    assert.ok(!("error" in a) && a.enabled && a.tercaListId === null);
    assert.ok(!("error" in b) && b.enabled && b.tercaListId === null);
  });
  it("inteiro positivo ⇒ lido", () => {
    const r = parseBrevoDiariaSemanal({ ...base, terca_list_id: 31 });
    assert.ok(!("error" in r) && r.enabled && r.tercaListId === 31);
  });
  it("tipo inválido ⇒ erro de config", () => {
    for (const v of ["31", 0, -1, 1.5]) {
      const r = parseBrevoDiariaSemanal({ ...base, terca_list_id: v });
      assert.ok("error" in r, `esperava erro pra ${JSON.stringify(v)}`);
    }
  });
});

describe("decideSemanalSplit (#11286)", () => {
  const input = { semanalMondaySend: true, recipients: 250, threshold: 200, tercaListId: TERCA as number | null, mainListId: MAIN };
  it("acima do teto, segunda de verdade, com lista de terça ⇒ divide", () => {
    assert.deepEqual(decideSemanalSplit(input), { split: true, tercaListId: TERCA });
  });
  it("no teto ou abaixo ⇒ não divide (comportamento anterior)", () => {
    assert.deepEqual(decideSemanalSplit({ ...input, recipients: 200 }), { split: false });
  });
  it("fora de segunda/transição diária ⇒ nunca divide", () => {
    assert.deepEqual(decideSemanalSplit({ ...input, semanalMondaySend: false }), { split: false });
  });
  it("sem lista de terça ⇒ não divide, com aviso", () => {
    const r = decideSemanalSplit({ ...input, tercaListId: null });
    assert.ok("split" in r && !r.split && r.warning && /terca_list_id/.test(r.warning));
  });
  it("lista de terça igual à principal ⇒ erro (excluiria todo mundo)", () => {
    assert.ok("error" in decideSemanalSplit({ ...input, tercaListId: MAIN }));
  });
});

describe("buildMainCampaignRecipients (#11286)", () => {
  it("sem divisão ⇒ só listIds (payload idêntico ao de antes)", () => {
    assert.deepEqual(buildMainCampaignRecipients(MAIN, null), { listIds: [MAIN] });
  });
  it("com divisão ⇒ exclui a lista de terça", () => {
    assert.deepEqual(buildMainCampaignRecipients(MAIN, TERCA), { listIds: [MAIN], exclusionListIds: [TERCA] });
  });
});

describe("checkSemanalCapacity (#11286)", () => {
  it("acima do teto com lista de terça ⇒ sem aviso (o publish divide)", () => {
    assert.deepEqual(checkSemanalCapacity(250, 200, TERCA), { splitNeeded: true });
  });
  it("acima do teto sem lista de terça ⇒ avisa que sai inteira", () => {
    const r = checkSemanalCapacity(250, 200);
    assert.ok(r.splitNeeded && r.warning && /terca_list_id/.test(r.warning));
  });
});

describe("planTercaListReconcile / reconcileTercaList (#11286)", () => {
  const terca = emailsOfGroup("terca", 3);
  const segunda = emailsOfGroup("segunda", 3);

  it("plano: adiciona os da principal no grupo terça, remove quem saiu da principal e quem é de segunda", () => {
    const main = [...terca.slice(0, 2), ...segunda];
    const current = [terca[1], terca[2] /* saiu da principal */, segunda[0] /* grupo errado */];
    const plan = planTercaListReconcile(main, current);
    assert.deepEqual(plan.toAdd, [terca[0]]);
    assert.deepEqual(plan.toRemove.sort(), [terca[2], segunda[0]].sort());
    assert.deepEqual(plan.desired.sort(), [terca[0], terca[1]].sort());
  });

  it("normaliza caixa e espaço (mesma pessoa não é removida e readicionada)", () => {
    const plan = planTercaListReconcile([` ${terca[0].toUpperCase()} `], [terca[0]]);
    assert.deepEqual(plan.toAdd, []);
    assert.deepEqual(plan.toRemove, []);
  });

  function fakeBrevo(initial: Record<number, string[]>, opts: { ignoreRemove?: boolean } = {}) {
    const lists = new Map<number, Set<string>>(Object.entries(initial).map(([k, v]) => [Number(k), new Set(v)]));
    const calls: { op: string; listId: number; emails: string[] }[] = [];
    const deps: TercaListDeps = {
      listContacts: async (id) => [...(lists.get(id) ?? [])],
      addToList: async (id, emails) => {
        calls.push({ op: "add", listId: id, emails });
        for (const e of emails) lists.get(id)!.add(e);
      },
      removeFromList: async (id, emails) => {
        calls.push({ op: "remove", listId: id, emails });
        if (!opts.ignoreRemove) for (const e of emails) lists.get(id)!.delete(e);
      },
    };
    return { deps, lists, calls };
  }

  it("cenário da issue: quem foi desvinculado da principal sai da lista de terça antes da campanha", async () => {
    const fb = fakeBrevo({ [MAIN]: [terca[0], ...segunda], [TERCA]: [terca[0], terca[1]] });
    const r = await reconcileTercaList(fb.deps, { mainListId: MAIN, tercaListId: TERCA });
    assert.deepEqual([...fb.lists.get(TERCA)!], [terca[0]]);
    assert.equal(r.terca, 1);
    assert.equal(r.segunda, 3);
    assert.equal(r.removed, 1);
    assert.equal(r.added, 0);
    assert.ok(fb.calls.every((c) => c.listId === TERCA), "nunca mexe na lista principal");
  });

  it("remoção que não pega ⇒ lança (campanha de terça não nasce com quem saiu)", async () => {
    const fb = fakeBrevo({ [MAIN]: [terca[0]], [TERCA]: [terca[0], terca[1]] }, { ignoreRemove: true });
    await assert.rejects(reconcileTercaList(fb.deps, { mainListId: MAIN, tercaListId: TERCA }), /fora da lista principal/);
  });

  it("adição que não aparece na releitura ⇒ só aviso em missing (a pessoa recebe na segunda)", async () => {
    const fb = fakeBrevo({ [MAIN]: [terca[0], terca[1]], [TERCA]: [] });
    fb.deps.addToList = async () => {};
    const r = await reconcileTercaList(fb.deps, { mainListId: MAIN, tercaListId: TERCA });
    assert.equal(r.missing.length, 2);
    assert.equal(r.terca, 0);
    assert.equal(r.segunda, 2);
  });

  it("lotes de no máximo 150 e-mails por chamada", async () => {
    const many = emailsOfGroup("terca", TERCA_LIST_BATCH_SIZE + 10);
    const fb = fakeBrevo({ [MAIN]: many, [TERCA]: [] });
    await reconcileTercaList(fb.deps, { mainListId: MAIN, tercaListId: TERCA });
    const adds = fb.calls.filter((c) => c.op === "add");
    assert.equal(adds.length, 2);
    assert.ok(adds.every((c) => c.emails.length <= TERCA_LIST_BATCH_SIZE));
  });
});

describe("score: a metade de terça acumula semanais (#11286)", () => {
  const desdeMs = Date.parse("2026-11-02T00:00:00-03:00");
  const nowMs = Date.parse("2026-12-01T12:00:00Z");
  const stats = {
    messagesSent: [
      { campaignId: 1, eventTime: "2026-11-03T09:00:00Z" }, // terça 06:00 BRT
      { campaignId: 2, eventTime: "2026-11-10T09:00:00Z" }, // terça
    ],
    opened: [{ campaignId: 2 }],
  };

  it("pessoa do grupo terça: envios de terça contam como semanais", () => {
    const [e] = emailsOfGroup("terca", 1);
    // #11420 — só as campanhas de terça da semanal dividida (ids registrados).
    const r = buildSemanalEvaluationInput(stats, desdeMs, nowMs, e, new Set([1, 2]));
    assert.equal(r.semanais.length, 2);
    assert.equal(r.semanais.filter((s) => s.opened).length, 1);
  });

  it("pessoa do grupo segunda: envio de terça (forçado) não conta", () => {
    const [e] = emailsOfGroup("segunda", 1);
    assert.equal(buildSemanalEvaluationInput(stats, desdeMs, nowMs, e, new Set([1, 2])).semanais.length, 0);
  });

  it("sem e-mail: só segunda (comportamento anterior)", () => {
    assert.equal(buildSemanalEvaluationInput(stats, desdeMs, nowMs).semanais.length, 0);
    const [e] = emailsOfGroup("terca", 1);
    assert.equal(isSemanalSendDay(Date.parse("2026-11-02T09:00:00Z")), true);
    assert.equal(isSemanalSendDay(Date.parse("2026-11-04T09:00:00Z"), e), false, "quarta nunca conta");
  });
});

describe("publish: rascunho, reaproveitamento e campanha de terça (#11286)", () => {
  const base: BrevoDiariaPublished = {
    campaign_id: 42,
    subject: "Assunto",
    preview_text: "Preview",
    status: "draft",
    list_id: MAIN,
    created_at: "2026-11-01T20:00:00.000Z",
    terca_list_id: TERCA,
  };
  const params = {
    tercaListId: TERCA,
    subject: "Assunto",
    previewText: "Preview",
    html: "<html></html>",
    sender: { name: "diar.ia.br", email: "editor@diar.ia.br" },
    nowIso: "2026-11-01T20:00:00.000Z",
  };

  it("cria a campanha de terça com listIds [terca], mesmo conteúdo, e devolve o id no estado", async () => {
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    const r = await ensureTercaCampaign(
      { post: async (path, body) => (posts.push({ path, body }), { id: 99 }), put: async () => ({}) },
      { ...params, base },
    );
    assert.equal(r.created, true);
    assert.equal(r.state.terca_campaign_id, 99);
    assert.equal(r.state.campaign_id, 42);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body.recipients, { listIds: [TERCA] });
    assert.equal(posts[0].body.htmlContent, "<html></html>");
    assert.equal(posts[0].body.subject, "Assunto");
  });

  it("já registrada ⇒ PUT do conteúdo, nunca uma 2ª campanha", async () => {
    let posted = false;
    const puts: string[] = [];
    const r = await ensureTercaCampaign(
      { post: async () => ((posted = true), { id: 1 }), put: async (path) => (puts.push(path), {}) },
      { ...params, base: { ...base, terca_campaign_id: 99 } },
    );
    assert.equal(posted, false);
    assert.deepEqual(puts, ["/emailCampaigns/99"]);
    assert.equal(r.created, false);
  });

  it("resposta sem id ⇒ lança", async () => {
    await assert.rejects(
      ensureTercaCampaign({ post: async () => ({}), put: async () => ({}) }, { ...params, base }),
      /sem 'id'/,
    );
  });

  it("checkReuseSplitConsistency: rascunho dividido e decisão sem divisão ⇒ recusa", () => {
    assert.equal(checkReuseSplitConsistency(base, null).ok, false);
    assert.equal(checkReuseSplitConsistency(base, TERCA).ok, true);
    assert.equal(checkReuseSplitConsistency({ terca_list_id: undefined, status: "draft" }, TERCA).ok, true, "inteiro → dividido é aceito");
    assert.equal(checkReuseSplitConsistency(null, null).ok, true);
  });

  it("regressão: segunda já AGENDADA inteira + publish de novo acima do teto ⇒ recusa (terça receberia 2 envios)", () => {
    const r = checkReuseSplitConsistency({ terca_list_id: undefined, status: "scheduled" }, TERCA);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /AGENDADA inteira/);
    assert.equal(checkReuseSplitConsistency({ terca_list_id: undefined, status: "scheduled" }, null).ok, true, "sem divisão segue ok");
    assert.equal(checkReuseSplitConsistency({ terca_list_id: undefined, status: "test_sent" }, TERCA).ok, true, "rascunho testado ainda aceita");
  });

  it("estado gravado preserva os campos de terça na releitura", () => {
    const dir = mkdtempSync(join(tmpdir(), "brevo-split-11286-"));
    try {
      writeBrevoDiariaPublished(dir, { ...base, terca_campaign_id: 99, terca_scheduled_at: "2026-11-03T09:00:00.000Z" });
      const back = readBrevoDiariaPublished(dir);
      assert.equal(back?.terca_list_id, TERCA);
      assert.equal(back?.terca_campaign_id, 99);
      assert.equal(back?.terca_scheduled_at, "2026-11-03T09:00:00.000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("schedule-daily-brevo: agenda a de terça 24h depois (#11286)", () => {
  const EDITION_DIR = "/fake/root/data/editions/2611/261102";
  const MONDAY = "2026-11-02T09:00:00.000Z";
  const TUESDAY = "2026-11-03T09:00:00.000Z";

  // #11689 — relógio fixo: o guard "não agendar no passado" dos agendadores depende de "agora".
  before(() => mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-01T00:00:00.000Z") }));
  after(() => mock.timers.reset());

  function splitState(overrides: Partial<BrevoDiariaPublished> = {}): BrevoDiariaPublished {
    return {
      campaign_id: 42,
      subject: "S",
      preview_text: "P",
      status: "draft",
      list_id: MAIN,
      created_at: "2026-11-01T20:00:00.000Z",
      terca_list_id: TERCA,
      terca_campaign_id: 99,
      ...overrides,
    };
  }

  function makeDeps(state: BrevoDiariaPublished, overrides: Partial<ScheduleDailyBrevoDeps> = {}) {
    const puts: { id: number; at: string }[] = [];
    const quotas: { listId: number; day: string; exclude?: number }[] = [];
    const writes: BrevoDiariaPublished[] = [];
    const scheduled = new Map<number, string>();
    const deps: ScheduleDailyBrevoDeps = {
      readPublished: () => state,
      writePublished: (_d, s) => void writes.push(s),
      putSchedule: async (id, at) => {
        puts.push({ id, at });
        scheduled.set(id, at);
      },
      getCampaign: async (id) => ({ status: "queued", scheduledAt: scheduled.get(id) ?? null }),
      checkQuota: async (listId, day, exclude) => {
        quotas.push({ listId, day, ...(exclude !== undefined ? { exclude } : {}) });
        return { check: { ok: true as const, consumed: 0, available: 300 }, warnings: [] };
      },
      ...overrides,
    };
    return { deps, puts, quotas, writes };
  }

  it("tercaScheduledAt = +24h", () => {
    assert.equal(tercaScheduledAt(MONDAY), TUESDAY);
    assert.equal(tercaScheduledAt("lixo"), null);
  });

  it("dividida: agenda segunda e terça; cota da segunda desconta a lista de terça", async () => {
    const t = makeDeps(splitState());
    const r = await scheduleDailyBrevo(EDITION_DIR, MONDAY, t.deps);
    assert.ok(r.ok);
    assert.deepEqual(t.puts, [
      { id: 42, at: MONDAY },
      { id: 99, at: TUESDAY },
    ]);
    assert.deepEqual(t.quotas, [
      { listId: MAIN, day: "2026-11-02", exclude: TERCA },
      { listId: TERCA, day: "2026-11-03" },
    ]);
    if (r.ok) assert.equal(r.terca?.campaignId, 99);
    assert.equal(t.writes.at(-1)?.terca_scheduled_at, TUESDAY);
    assert.equal(t.writes.at(-1)?.status, "scheduled");
  });

  it("re-rodar com as duas já agendadas ⇒ nenhum PUT", async () => {
    const t = makeDeps(splitState({ status: "scheduled", scheduled_at: MONDAY, terca_scheduled_at: TUESDAY }));
    const r = await scheduleDailyBrevo(EDITION_DIR, MONDAY, t.deps);
    assert.ok(r.ok && r.alreadyScheduled && r.terca?.alreadyScheduled);
    assert.equal(t.puts.length, 0);
  });

  it("segunda já agendada e terça falhou antes ⇒ re-rodar agenda só a terça", async () => {
    const t = makeDeps(splitState({ status: "scheduled", scheduled_at: MONDAY }));
    const r = await scheduleDailyBrevo(EDITION_DIR, MONDAY, t.deps);
    assert.ok(r.ok);
    assert.deepEqual(t.puts, [{ id: 99, at: TUESDAY }]);
  });

  it("PUT da terça falha ⇒ code 3, segunda já gravada como agendada", async () => {
    const t = makeDeps(splitState());
    const origPut = t.deps.putSchedule;
    t.deps.putSchedule = async (id, at) => {
      if (id === 99) throw new Error("boom");
      return origPut(id, at);
    };
    const r = await scheduleDailyBrevo(EDITION_DIR, MONDAY, t.deps);
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.equal(r.code, 3);
      assert.match(r.reason, /segunda 42 agendada/);
    }
    assert.equal(t.writes.length, 1);
    assert.equal(t.writes[0].status, "scheduled");
  });

  it("sem divisão: comportamento anterior (uma campanha, cota sem exclusão)", async () => {
    const t = makeDeps(splitState({ terca_list_id: undefined, terca_campaign_id: undefined }));
    const r = await scheduleDailyBrevo(EDITION_DIR, MONDAY, t.deps);
    assert.ok(r.ok && r.terca === undefined);
    assert.deepEqual(t.puts, [{ id: 42, at: MONDAY }]);
    assert.deepEqual(t.quotas, [{ listId: MAIN, day: "2026-11-02" }]);
  });
});

describe("create-brevo-semanal-terca-list (#11286)", () => {
  const deps = (lists: { id: number; name: string }[], created: unknown = { id: 55 }) => {
    let createdCalls = 0;
    return {
      d: {
        listAllLists: async () => lists,
        getList: async () => ({ folderId: 3 }),
        createList: async () => ((createdCalls++), created as { id?: unknown }),
      },
      calls: () => createdCalls,
    };
  };
  it("já existe ⇒ devolve o id, não cria", async () => {
    const t = deps([{ id: 55, name: TERCA_LIST_NAME }]);
    assert.deepEqual(await createTercaList(t.d, { mainListId: MAIN, apply: true }), { status: "exists", listId: 55 });
    assert.equal(t.calls(), 0);
  });
  it("dry-run ⇒ não cria", async () => {
    const t = deps([]);
    assert.deepEqual(await createTercaList(t.d, { mainListId: MAIN, apply: false }), { status: "dry_run", folderId: 3 });
    assert.equal(t.calls(), 0);
  });
  it("--apply ⇒ cria na pasta da principal", async () => {
    const t = deps([]);
    assert.deepEqual(await createTercaList(t.d, { mainListId: MAIN, apply: true }), { status: "created", listId: 55 });
    assert.equal(t.calls(), 1);
  });
  it("nome duplicado ⇒ erro, não escolhe sozinho", async () => {
    const t = deps([{ id: 1, name: TERCA_LIST_NAME }, { id: 2, name: TERCA_LIST_NAME }]);
    const r = await createTercaList(t.d, { mainListId: MAIN, apply: true });
    assert.equal(r.status, "error");
  });
});
