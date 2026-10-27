/**
 * test/brevo-semanal-kit-frio-11221-11226.test.ts
 *
 * #11226 — Brevo diária só semanal (cadastros não confirmados): score por
 * semanal, clique promove, supressão 12/4 semanais seguidas sem sinal.
 * #11221 — frios do Kit ficam no Kit (tag `frio`, semanal de segunda), nunca
 * descadastro.
 *
 * Regressões exigidas pelas issues:
 *  - quem tem >= 1 abertura NUNCA é suprimido antes de 12 semanais sem sinal;
 *  - a supressão por score/inatividade NUNCA chama unsubscribe no Kit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyBrevoDiariaSemanalAction,
  trailingSemanaisSemSinal,
  type BrevoSemanalSend,
} from "../scripts/lib/shared/brevo-diaria-score.ts";
import {
  buildSemanalEvaluationInput,
  checkSemanalCapacity,
  decideBrevoSemanalSend,
  editionWeekday,
  parseBrevoDiariaSemanal,
  semanalSplitGroup,
} from "../scripts/lib/brevo-diaria-semanal.ts";
import { runEvaluation, type KitFrioTagDeps, type KitEnvioBrevoTagDeps } from "../scripts/evaluate-brevo-diaria.ts";
import { findContact, type BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";
import {
  KIT_FRIO_SUPPRESS_AFTER_SEMANAIS,
  KIT_SEMANAL_FRIO_BUTTON_LABEL,
  KIT_SEMANAL_FRIO_INTRO_TEXT,
  buildLastSignalIndex,
  buildSemanalFrioSilentStreaks,
  decideKitFrio,
  decideSemanalFrioVigia,
  gmailOpenRate,
  injectSemanalFrioIntro,
  parseSemanalFrioPauseState,
  type KitFrioCandidate,
} from "../scripts/lib/kit-frio.ts";
import { runKitFrioSync, type KitFrioDeps } from "../scripts/sync-kit-frio.ts";
import { publishKitSemanalFrio, type SemanalFrioPublishDeps } from "../scripts/publish-kit-semanal-frio.ts";
import { collectRestoreTargets, decideKitRestore, runKitSemAberturaRestore } from "../scripts/restore-kit-sem-abertura-frio.ts";
import { decideRestore, runRestoreSemanal, selectRestoreCandidates } from "../scripts/restore-brevo-semanal-suppressed.ts";
import { runStage5BrevoDispatch, type Stage5BrevoDeps } from "../scripts/brevo-diaria-stage5-dispatch.ts";
import { runBrevoDiaria, type ExecFn } from "../scripts/brevo-diaria-run.ts";
import { resolveDailyBrevoIntro } from "../scripts/publish-daily-brevo.ts";
import { buildTagFilter } from "../scripts/lib/kit-broadcasts.ts";
import type { DiariaBroadcastRecord } from "../scripts/lib/kit-sem-abertura.ts";

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2027-02-01T12:00:00Z");

function weekly(n: number, opts: { openedAt?: number[]; clickedAt?: number[]; immatureLast?: boolean } = {}): BrevoSemanalSend[] {
  return Array.from({ length: n }, (_, i) => ({
    sentAtMs: NOW - (n - i) * 7 * DAY,
    mature: !(opts.immatureLast && i === n - 1),
    opened: opts.openedAt?.includes(i) ?? false,
    clicked: opts.clickedAt?.includes(i) ?? false,
  }));
}

// ── #11226: score semanal ──────────────────────────────────────────────────

describe("classifyBrevoDiariaSemanalAction (#11226)", () => {
  it("REGRESSÃO: quem abriu alguma vez nunca é suprimido antes de 12 semanais seguidas sem sinal", () => {
    for (let n = 0; n < 12; n++) {
      assert.equal(classifyBrevoDiariaSemanalAction({ semanais: weekly(n), everOpened: true, everClicked: false }), "keep", `n=${n}`);
    }
    assert.equal(classifyBrevoDiariaSemanalAction({ semanais: weekly(12), everOpened: true, everClicked: false }), "suppress");
  });

  it("abertura numa semanal zera a sequência (abriu na 3ª de 14: só 11 seguidas depois ⇒ mantém)", () => {
    const s = weekly(14, { openedAt: [2] });
    assert.equal(trailingSemanaisSemSinal(s), 11);
    assert.equal(classifyBrevoDiariaSemanalAction({ semanais: s, everOpened: false, everClicked: false }), "keep");
  });

  it("nunca abriu nem clicou: 4 semanais ⇒ suprime; 3 ⇒ mantém", () => {
    assert.equal(classifyBrevoDiariaSemanalAction({ semanais: weekly(3), everOpened: false, everClicked: false }), "keep");
    assert.equal(classifyBrevoDiariaSemanalAction({ semanais: weekly(4), everOpened: false, everClicked: false }), "suppress");
  });

  it("semanal imatura (<48h) não entra na sequência", () => {
    const s = weekly(4, { immatureLast: true });
    assert.equal(trailingSemanaisSemSinal(s), 3);
    assert.equal(classifyBrevoDiariaSemanalAction({ semanais: s, everOpened: false, everClicked: false }), "keep");
  });

  it("clique (em qualquer campanha, inclusive antes do corte) ⇒ promote_by_click, antes de tudo", () => {
    assert.equal(classifyBrevoDiariaSemanalAction({ semanais: weekly(20), everOpened: false, everClicked: true }), "promote_by_click");
    assert.equal(classifyBrevoDiariaSemanalAction({ semanais: weekly(2, { clickedAt: [1] }), everOpened: false, everClicked: false }), "promote_by_click");
  });

  it("abertura > 51% em >= 3 semanais promove; 2 de 2 não (piso de amostra contado em semanais)", () => {
    assert.equal(classifyBrevoDiariaSemanalAction({ semanais: weekly(3, { openedAt: [0, 1] }), everOpened: true, everClicked: false }), "promote_to_beehiiv");
    assert.equal(classifyBrevoDiariaSemanalAction({ semanais: weekly(2, { openedAt: [0, 1] }), everOpened: true, everClicked: false }), "keep");
  });
});

describe("buildSemanalEvaluationInput (#11226)", () => {
  const desde = Date.parse("2026-11-02T00:00:00-03:00");
  it("só campanhas a partir do corte contam como semanal; abertura/clique de vida inteira", () => {
    const stats = {
      messagesSent: [
        { campaignId: 1, eventTime: "2026-10-20T09:00:00Z" },
        { campaignId: 2, eventTime: "2026-11-02T09:00:00Z" },
        { campaignId: 3, eventTime: "2026-11-09T09:00:00Z" },
      ],
      opened: [{ campaignId: 1, eventTime: "2026-10-20T10:00:00Z" }],
      clicked: [{ campaignId: 3, links: [{ eventTime: "2026-11-09T11:00:00Z" }] }],
    };
    const input = buildSemanalEvaluationInput(stats, desde, Date.parse("2026-11-10T12:00:00Z"));
    assert.equal(input.semanais.length, 2);
    assert.equal(input.everOpened, true);
    assert.equal(input.everClicked, true);
    assert.equal(input.semanais.find((s) => s.clicked)?.mature, false, "envio de 09/11 09:00 tem < 48h em 10/11 12:00");
  });
});

describe("decideBrevoSemanalSend + config (#11226)", () => {
  const on = parseBrevoDiariaSemanal({ enabled: true, desde: "2026-11-02" });
  it("desligado ⇒ diária como antes", () => {
    assert.deepEqual(decideBrevoSemanalSend({ semanal: parseBrevoDiariaSemanal(undefined), editionAammdd: "261103", kitSemAberturaInBrevo: 0 }), {
      send: true,
      mode: "diaria",
    });
  });
  it("ligado: segunda sai (semanal), terça não", () => {
    assert.equal(editionWeekday("261102"), 1);
    assert.deepEqual(decideBrevoSemanalSend({ semanal: on, editionAammdd: "261102", kitSemAberturaInBrevo: 0 }), { send: true, mode: "semanal" });
    assert.equal(decideBrevoSemanalSend({ semanal: on, editionAammdd: "261103", kitSemAberturaInBrevo: 0 }).send, false);
  });
  it("transição: kit-sem-abertura: em in_brevo ⇒ segue diária com aviso (#10533)", () => {
    const d = decideBrevoSemanalSend({ semanal: on, editionAammdd: "261103", kitSemAberturaInBrevo: 9 });
    assert.equal(d.send, true);
    assert.ok(d.send && d.mode === "diaria" && /kit-sem-abertura/.test(d.warning ?? ""));
  });
  it("config ligada sem desde válido é erro", () => {
    assert.ok("error" in parseBrevoDiariaSemanal({ enabled: true }));
  });
  it("divisão fixa por pessoa (hash estável, insensível a caixa) e aviso de capacidade", () => {
    assert.equal(semanalSplitGroup("A@x.com"), semanalSplitGroup(" a@x.com "));
    const groups = new Set(Array.from({ length: 50 }, (_, i) => semanalSplitGroup(`p${i}@x.com`)));
    assert.equal(groups.size, 2);
    assert.equal(checkSemanalCapacity(200, 200).splitNeeded, false);
    assert.equal(checkSemanalCapacity(201, 200).splitNeeded, true);
  });
});

// ── runEvaluation (fetch mockado) ────────────────────────────────────────

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function contact(email: string, origin: string): BrevoDiariaContact {
  return {
    email,
    beehiiv_subscription_id: origin,
    status: "in_brevo",
    opens_count: 0,
    sends_count: 0,
    last_open_rate: null,
    added_at: "2026-10-10T00:00:00.000Z",
    last_evaluated_at: null,
  };
}

async function withFetch<T>(impl: (url: string, init?: RequestInit) => Response | Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => impl(String(url), init)) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

describe("runEvaluation — kit-sem-abertura suprimido volta pro Kit com frio, NUNCA descadastro (#11221)", () => {
  it("REGRESSÃO: supressão por score não chama unsubscribe no Kit; tag frio + tira envio-brevo + unlink da Brevo", async () => {
    let unsubscribeCalls = 0;
    const ops: string[] = [];
    const frioDeps: KitFrioTagDeps = {
      findTagId: async () => 900,
      tag: async (tagId, id) => {
        ops.push(`tag ${tagId} ${id}`);
      },
      listTags: async () => [{ id: 900, name: "frio" } as never],
    };
    const envioDeps: KitEnvioBrevoTagDeps = {
      findTagId: async () => 555,
      untag: async (tagId, id) => {
        ops.push(`untag ${tagId} ${id}`);
      },
      listTags: async () => [],
    };
    const sent = Array.from({ length: 6 }, (_, i) => ({ campaignId: i + 1, eventTime: "2026-10-01T09:00:00Z" }));
    const brevoPuts: string[] = [];
    const r = await withFetch(
      (url, init) => {
        if (url.includes("api.kit.com")) throw new Error(`Kit não deveria ser chamado direto: ${url}`);
        if (init?.method === "PUT") {
          brevoPuts.push(String(init.body));
          return jsonRes(200, {});
        }
        return jsonRes(200, { emailBlacklisted: false, listIds: [7], statistics: { messagesSent: sent, opened: [] } });
      },
      () => {
        const contacts = [contact("frio@x.com", "kit-sem-abertura:42")];
        return runEvaluation({
          contacts,
          store: { contacts },
          push: true,
          publicationId: "pub",
          beehiivApiKey: "b",
          brevoApiKey: "br",
          kitApiKey: "k",
          listId: 7,
          log: () => {},
          newsletterBackend: "kit",
          unsubscribeKitSemAberturaDeps: {
            unsubscribe: async () => {
              unsubscribeCalls++;
            },
            getState: async () => "active",
          },
          kitFrioTagDeps: frioDeps,
          kitEnvioBrevoTagDeps: envioDeps,
        });
      },
    );
    assert.equal(unsubscribeCalls, 0, "supressão por score nunca descadastra no Kit");
    assert.deepEqual(ops, ["tag 900 42", "untag 555 42"], "frio aplicada ANTES de tirar envio-brevo");
    assert.equal(r.kitSemAberturaReturnedToFrio, 1);
    assert.ok(brevoPuts.some((b) => b.includes("unlinkListIds")), "sai da lista Brevo");
    assert.ok(!brevoPuts.some((b) => b.includes("emailBlacklisted")), "sem blacklist na Brevo");
    const stored = findContact(r.store, "frio@x.com")!;
    assert.equal(stored.status, "converted_to_kit");
    assert.equal(stored.resolution_reason, "kit_sem_abertura_frio");
  });

  it("tag frio não confirmada ⇒ fica in_brevo, conta falha, e ainda assim nenhum unsubscribe", async () => {
    let unsubscribeCalls = 0;
    const sent = Array.from({ length: 6 }, (_, i) => ({ campaignId: i + 1, eventTime: "2026-10-01T09:00:00Z" }));
    const r = await withFetch(
      () => jsonRes(200, { emailBlacklisted: false, listIds: [7], statistics: { messagesSent: sent, opened: [] } }),
      () => {
        const contacts = [contact("frio@x.com", "kit-sem-abertura:42")];
        return runEvaluation({
          contacts,
          store: { contacts },
          push: true,
          publicationId: "pub",
          beehiivApiKey: "b",
          brevoApiKey: "br",
          kitApiKey: "k",
          listId: 7,
          log: () => {},
          newsletterBackend: "kit",
          unsubscribeKitSemAberturaDeps: { unsubscribe: async () => void unsubscribeCalls++, getState: async () => "active" },
          kitFrioTagDeps: { findTagId: async () => 900, tag: async () => {}, listTags: async () => [] },
          kitEnvioBrevoTagDeps: { findTagId: async () => 555, untag: async () => {}, listTags: async () => [] },
        });
      },
    );
    assert.equal(unsubscribeCalls, 0);
    assert.equal(r.failed, 1);
    assert.equal(findContact(r.store, "frio@x.com")!.status, "in_brevo");
  });
});

describe("runEvaluation — regime semanal (#11226)", () => {
  const desde = Date.parse("2026-11-02T00:00:00-03:00");
  function statsWithWeeklies(n: number) {
    const sent = [{ campaignId: 100, eventTime: "2026-10-20T09:00:00Z" }];
    for (let i = 0; i < n; i++) sent.push({ campaignId: i + 1, eventTime: new Date(desde + 9 * 3600 * 1000 + i * 7 * DAY).toISOString() });
    return { messagesSent: sent, opened: [{ campaignId: 100, eventTime: "2026-10-20T10:00:00Z" }] };
  }
  async function evalOne(n: number) {
    return withFetch(
      () => jsonRes(200, { emailBlacklisted: false, listIds: [7], statistics: statsWithWeeklies(n) }),
      () => {
        const contacts = [contact("leitor@x.com", "curated:leitor@x.com")];
        return runEvaluation({
          contacts,
          store: { contacts },
          push: false,
          publicationId: "pub",
          beehiivApiKey: "b",
          brevoApiKey: "br",
          listId: 7,
          log: () => {},
          semanalDesdeMs: desde,
          nowMs: desde + (n * 7 + 3) * DAY,
        });
      },
    );
  }
  it("REGRESSÃO: abriu uma diária antiga + 11 semanais sem sinal ⇒ mantém; 12 ⇒ suprime", async () => {
    const r11 = await evalOne(11);
    assert.equal(r11.suppressed, 0);
    assert.equal(r11.kept, 1);
    const r12 = await evalOne(12);
    assert.equal(r12.suppressed, 1);
  });

  it("clique na Brevo ⇒ ativa no Kit pelo form de sistema (inactive → active) e sai da lista", async () => {
    let activated = false;
    const activateCalls: string[] = [];
    const brevoPuts: string[] = [];
    const sentAt = new Date(desde + 9 * 3600 * 1000).toISOString();
    const r = await withFetch(
      (url, init) => {
        if (url.includes("api.kit.com")) {
          if (url.includes("/subscribers?")) {
            return jsonRes(200, {
              subscribers: [{ id: 77, email_address: "clicou@x.com", state: activated ? "active" : "inactive", created_at: "2026-10-01T00:00:00Z", fields: {} }],
              pagination: { has_next_page: false, has_previous_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
            });
          }
          if (/\/subscribers\/77/.test(url)) {
            return jsonRes(200, { subscriber: { id: 77, email_address: "clicou@x.com", state: activated ? "active" : "inactive", created_at: "2026-10-01T00:00:00Z", fields: {} } });
          }
          throw new Error(`Kit inesperado: ${init?.method ?? "GET"} ${url}`);
        }
        if (init?.method === "PUT") {
          brevoPuts.push(String(init.body));
          return jsonRes(200, {});
        }
        return jsonRes(200, {
          emailBlacklisted: false,
          listIds: [7],
          statistics: { messagesSent: [{ campaignId: 1, eventTime: sentAt }], clicked: [{ campaignId: 1, links: [{ eventTime: sentAt }] }] },
        });
      },
      () => {
        const contacts = [contact("clicou@x.com", "kit:77")];
        return runEvaluation({
          contacts,
          store: { contacts },
          push: true,
          publicationId: "pub",
          beehiivApiKey: "b",
          brevoApiKey: "br",
          kitApiKey: "k",
          listId: 7,
          log: () => {},
          newsletterBackend: "kit",
          semanalDesdeMs: desde,
          nowMs: desde + DAY,
          kitActivateFormId: "9839463",
          activateKitViaForm: async (formId, id) => {
            activateCalls.push(`${formId}/${id}`);
            activated = true;
          },
        });
      },
    );
    assert.deepEqual(activateCalls, ["9839463/77"]);
    assert.equal(r.promotedByClick, 1);
    const stored = findContact(r.store, "clicou@x.com")!;
    assert.equal(stored.status, "promoted_beehiiv");
    assert.equal(stored.resolution_reason, "click_kit_activated");
    assert.ok(brevoPuts.some((b) => b.includes("unlinkListIds")));
  });
});

// ── #11221: frio no Kit ───────────────────────────────────────────────────

function cand(email: string, createdDaysAgo: number, tagNames: string[] = [], fields: Record<string, string | null> = {}): KitFrioCandidate {
  return { id: email.length, email, created_at: new Date(NOW - createdDaysAgo * DAY).toISOString(), tagNames, fields };
}
const registry: DiariaBroadcastRecord[] = Array.from({ length: 100 }, (_, i) => ({
  broadcastId: i + 1,
  sentAt: new Date(NOW - (100 - i) * DAY).toISOString(),
  edition: `e${i}`,
}));
const ctxBase = { nowMs: NOW, silentStreaks: new Map<string, number>(), diariaRecords: registry, seedEmails: new Set<string>() };

describe("decideKitFrio (#11221)", () => {
  it("cadastro < 90 dias: 30 dias sem sinal ⇒ frio; sinal há 10 dias ⇒ não", () => {
    assert.deepEqual(decideKitFrio(cand("a@x.com", 60), { ...ctxBase, lastSignal: new Map([["a@x.com", NOW - 40 * DAY]]) }), {
      action: "tag_frio",
      windowDays: 30,
    });
    assert.equal(decideKitFrio(cand("a@x.com", 60), { ...ctxBase, lastSignal: new Map([["a@x.com", NOW - 10 * DAY]]) }).action, "skip");
  });
  it("cadastro >= 90 dias usa 90 dias; sinal há 40 dias ⇒ não esfria", () => {
    assert.equal(decideKitFrio(cand("b@x.com", 120), { ...ctxBase, lastSignal: new Map([["b@x.com", NOW - 40 * DAY]]) }).action, "skip");
    assert.deepEqual(decideKitFrio(cand("b@x.com", 120), { ...ctxBase, lastSignal: new Map() }), { action: "tag_frio", windowDays: 90 });
  });
  it("registro que não cobre a janela ⇒ nunca afirma frio", () => {
    const short = registry.slice(-20);
    assert.deepEqual(decideKitFrio(cand("c@x.com", 60), { ...ctxBase, diariaRecords: short, lastSignal: new Map() }), {
      action: "skip",
      reason: "registro_nao_cobre_a_janela",
    });
  });
  it("frio com sinal recente ⇒ volta; 12 semanais sem sinal ⇒ suprime (só tags)", () => {
    const c = cand("d@x.com", 60, ["frio"]);
    assert.equal(decideKitFrio(c, { ...ctxBase, lastSignal: new Map([["d@x.com", NOW - 5 * DAY]]) }).action, "remove_frio");
    assert.equal(
      decideKitFrio(c, { ...ctxBase, lastSignal: new Map(), silentStreaks: new Map([["d@x.com", KIT_FRIO_SUPPRESS_AFTER_SEMANAIS - 1]]) }).action,
      "keep_frio",
    );
    assert.equal(
      decideKitFrio(c, { ...ctxBase, lastSignal: new Map(), silentStreaks: new Map([["d@x.com", KIT_FRIO_SUPPRESS_AFTER_SEMANAIS]]) }).action,
      "suppress",
    );
  });
  it("apoiador, suprimido e envio-brevo ficam de fora", () => {
    const ctx = { ...ctxBase, lastSignal: new Map<string, number>() };
    assert.equal(decideKitFrio(cand("e@x.com", 60, [], { apoio_nivel: "patrono" }), ctx).action, "skip");
    assert.equal(decideKitFrio(cand("f@x.com", 60, ["suprimido"]), ctx).action, "skip");
    assert.equal(decideKitFrio(cand("g@x.com", 60, ["envio-brevo"]), ctx).action, "skip");
  });
});

describe("sinais e sequência das semanais de frio (#11221)", () => {
  it("lastSignal = envio mais recente aberto/clicado", () => {
    const idx = buildLastSignalIndex([
      { broadcastId: 1, sentAt: "2026-10-01T09:00:00Z", opens: ["A@x.com"], clicks: [] },
      { broadcastId: 2, sentAt: "2026-10-05T09:00:00Z", opens: [], clicks: ["a@x.com"] },
    ]);
    assert.equal(idx.get("a@x.com"), Date.parse("2026-10-05T09:00:00Z"));
  });
  it("sequência sem sinal conta da mais recente pra trás e para no sinal", () => {
    const s = (i: number, opens: string[] = []) => ({
      broadcastId: i,
      sentAt: new Date(NOW - (10 - i) * 7 * DAY).toISOString(),
      delivered: ["a@x.com", "b@x.com"],
      opens,
      clicks: [],
    });
    const streaks = buildSemanalFrioSilentStreaks([s(1), s(2, ["a@x.com"]), s(3), s(4)], NOW);
    assert.equal(streaks.get("a@x.com"), 2);
    assert.equal(streaks.get("b@x.com"), 4);
  });
});

describe("vigia da semanal (#11221)", () => {
  it("reclamação > 0,1% pausa; = 0,1% não", () => {
    assert.equal(decideSemanalFrioVigia({ semanalDelivered: 1000, semanalComplained: 2, gmailOpenRatesBefore: [], gmailOpenRatesAfter: [] }).pause, true);
    assert.equal(decideSemanalFrioVigia({ semanalDelivered: 1000, semanalComplained: 1, gmailOpenRatesBefore: [], gmailOpenRatesAfter: [] }).pause, false);
  });
  it("queda >= 5 pp no Gmail pausa (com 3+ diárias de cada lado)", () => {
    const v = decideSemanalFrioVigia({ semanalDelivered: 0, semanalComplained: 0, gmailOpenRatesBefore: [0.4, 0.4, 0.4], gmailOpenRatesAfter: [0.34, 0.35, 0.35] });
    assert.equal(v.pause, true);
    const ok = decideSemanalFrioVigia({ semanalDelivered: 0, semanalComplained: 0, gmailOpenRatesBefore: [0.4, 0.4], gmailOpenRatesAfter: [0.1, 0.1, 0.1] });
    assert.equal(ok.pause, false, "amostra insuficiente não pausa");
  });
  it("gmailOpenRate e estado de pausa ilegível (fail-safe = pausada)", () => {
    assert.equal(gmailOpenRate(["a@gmail.com", "b@gmail.com", "c@uol.com.br"], ["a@gmail.com", "c@uol.com.br"]), 0.5);
    assert.equal(parseSemanalFrioPauseState("{lixo").paused, true);
    assert.equal(parseSemanalFrioPauseState(null).paused, false);
  });
});

function frioDeps(overrides: Partial<KitFrioDeps> & { calls: string[] }): KitFrioDeps {
  const { calls } = overrides;
  return {
    nowMs: NOW,
    log: () => {},
    readDiariaRegistry: () => registry,
    readSemanalRegistry: () => [],
    listKitActive: async () => [cand("velho@x.com", 60), cand("volta@x.com", 60, ["frio"])],
    fetchEngagement: async (id) => ({ broadcastId: id, delivered: [], opens: id === 99 ? ["volta@x.com"] : [], clicks: [] }),
    findTagId: async (name) => (name === "frio" ? 900 : 901),
    tag: async (t, id) => void calls.push(`tag ${t} ${id}`),
    untag: async (t, id) => void calls.push(`untag ${t} ${id}`),
    listComplainedEmails: async () => [],
    readPause: () => ({ paused: false }),
    writePause: () => void calls.push("pause"),
    raiseAlarm: () => void calls.push("alarm"),
    appendLog: () => {},
    ...overrides,
  };
}

describe("runKitFrioSync (#11221)", () => {
  const cfgOn = {
    kit: { frio: { enabled: true, segmento_exclui_frio_confirmado: true }, diaria_exclusion_segment: { enabled: true, segment_id: 599796 } },
  };
  it("desligado ⇒ nada roda", async () => {
    const calls: string[] = [];
    const r = await runKitFrioSync({}, { push: true }, frioDeps({ calls }));
    assert.equal(r.disabled, true);
    assert.deepEqual(calls, []);
  });
  it("segmento não confirmado como excluindo frio ⇒ --push vira dry-run", async () => {
    const calls: string[] = [];
    const r = await runKitFrioSync(
      { kit: { frio: { enabled: true }, diaria_exclusion_segment: { enabled: true, segment_id: 599796 } } },
      { push: true },
      frioDeps({ calls }),
    );
    assert.equal(r.dryRun, true);
    assert.deepEqual(calls, []);
    assert.equal(r.taggedFrio, 1);
  });
  it("com as flags: tagueia o frio novo e tira frio de quem voltou a abrir — só tags", async () => {
    const calls: string[] = [];
    const r = await runKitFrioSync(cfgOn, { push: true }, frioDeps({ calls }));
    assert.equal(r.code, 0);
    assert.deepEqual(calls.sort(), [`tag 900 ${"velho@x.com".length}`, `untag 900 ${"volta@x.com".length}`].sort());
  });
});

// ── broadcast semanal de frio ─────────────────────────────────────────────

function semanalDeps(over: Partial<SemanalFrioPublishDeps> & { log2?: string[] } = {}): SemanalFrioPublishDeps & { created: unknown[]; deleted: number[]; written: unknown[] } {
  const created: unknown[] = [];
  const deleted: number[] = [];
  const written: unknown[] = [];
  return {
    created,
    deleted,
    written,
    log: () => {},
    nowIso: () => "2026-11-01T22:00:00Z",
    readMainState: () => ({ broadcast_id: 10, subject: "S", preview_text: "P", status: "scheduled", scheduled_at: "2026-11-02T09:00:00.000Z" }),
    readOwnState: () => null,
    writeOwnState: (_d, s) => void written.push(s),
    readPause: () => ({ paused: false }),
    findTagId: async () => 900,
    countTagMembers: async () => 5,
    getBroadcast: async (id) =>
      ({
        id,
        subject: "S",
        preview_text: "P",
        content: "<p>edição</p>",
        email_address: "oi@news.diar.ia.br",
        email_template: { id: 3, name: "t" },
        subscriber_filter: id === 10 ? undefined : buildTagFilter(900),
      }) as never,
    createBroadcast: async (input) => {
      created.push(input);
      return { id: 11 } as never;
    },
    deleteBroadcast: async (id) => void deleted.push(id),
    ...over,
  };
}
const cfgSemanal = { kit: { frio: { semanal_enabled: true } } };

describe("publishKitSemanalFrio (#11221)", () => {
  it("segunda: cria com tag frio, mesmo send_at, intro + botão, public:false; grava o estado", async () => {
    const d = semanalDeps();
    const r = await publishKitSemanalFrio("/x/2611/261102", cfgSemanal, { push: true }, d);
    assert.equal(r.status, "scheduled");
    const input = d.created[0] as { subscriber_filter: unknown; send_at: string; content: string; public: boolean };
    assert.deepEqual(input.subscriber_filter, buildTagFilter(900));
    assert.equal(input.send_at, "2026-11-02T09:00:00.000Z");
    assert.equal(input.public, false);
    assert.ok(input.content.includes(KIT_SEMANAL_FRIO_INTRO_TEXT.slice(0, 40)));
    assert.ok(input.content.includes(KIT_SEMANAL_FRIO_BUTTON_LABEL));
    assert.equal(d.written.length, 1);
  });
  it("terça não cria; tag vazia não cria; pausada não cria", async () => {
    assert.equal((await publishKitSemanalFrio("/x/2611/261103", cfgSemanal, { push: true }, semanalDeps())).status, "not_monday");
    assert.equal((await publishKitSemanalFrio("/x/2611/261102", cfgSemanal, { push: true }, semanalDeps({ countTagMembers: async () => 0 }))).status, "empty_tag");
    assert.equal((await publishKitSemanalFrio("/x/2611/261102", cfgSemanal, { push: true }, semanalDeps({ readPause: () => ({ paused: true }) }))).status, "paused");
  });
  it("tag inexistente ⇒ recusa (filtro não resolvido = base inteira)", async () => {
    const r = await publishKitSemanalFrio("/x/2611/261102", cfgSemanal, { push: true }, semanalDeps({ findTagId: async () => null }));
    assert.equal(r.code, 2);
  });
  it("filtro relido diverge ⇒ apaga o broadcast recém-criado, exit 1", async () => {
    const d = semanalDeps({
      getBroadcast: async (id) => ({ id, subject: "S", preview_text: "P", content: "<p>x</p>", email_address: "e", email_template: { id: 3, name: "t" }, subscriber_filter: [] }) as never,
    });
    const r = await publishKitSemanalFrio("/x/2611/261102", cfgSemanal, { push: true }, d);
    assert.equal(r.code, 1);
    assert.deepEqual(d.deleted, [11]);
    assert.equal(d.written.length, 0);
  });
  it("intro entra logo depois do <body> quando há documento completo", () => {
    const out = injectSemanalFrioIntro("<html><body class=x><p>a</p></body></html>", "<i>INTRO</i>");
    assert.equal(out, "<html><body class=x><i>INTRO</i><p>a</p></body></html>");
  });
});

// ── scripts de transição (dry-run por padrão) ────────────────────────────

describe("restore-kit-sem-abertura-frio (#11221)", () => {
  it("alvos: kit_unsubscribed+suppress do log (dedup, linha ruim ignorada) + kit-sem-abertura in_brevo", () => {
    const log =
      JSON.stringify({ event: "kit_unsubscribed", brevo_exit: "suppress", email: "A@x.com", kit_subscriber_id: 1 }) +
      "\n{lixo\n" +
      JSON.stringify({ event: "kit_unsubscribed", brevo_exit: "native_unsubscribe", email: "b@x.com", kit_subscriber_id: 2 }) +
      "\n";
    const { targets, badLines } = collectRestoreTargets([log, log], [contact("c@x.com", "kit-sem-abertura:3"), contact("d@x.com", "kit:4")]);
    assert.equal(badLines, 2);
    assert.deepEqual(targets.map((t) => `${t.email}:${t.source}`).sort(), ["a@x.com:descadastrado_2510", "c@x.com:in_brevo"]);
  });
  it("cancelled vai pro painel (a API não reativa); active ganha as tags", () => {
    assert.equal(decideKitRestore("cancelled", []), "painel");
    assert.equal(decideKitRestore("active", ["envio-brevo"]), "tags");
    assert.equal(decideKitRestore("active", ["frio"]), "ja_ok");
  });
  it("--apply: frio antes de tirar envio-brevo; in_brevo desvinculado e convertido; cancelled só listado", async () => {
    const ops: string[] = [];
    let store = { contacts: [contact("c@x.com", "kit-sem-abertura:3")] };
    const panel: unknown[] = [];
    const r = await runKitSemAberturaRestore(
      [
        { email: "a@x.com", kitSubscriberId: 1, source: "descadastrado_2510" },
        { email: "c@x.com", kitSubscriberId: 3, source: "in_brevo" },
      ],
      { apply: true },
      {
        log: () => {},
        getKit: async (id) => (id === 1 ? { state: "cancelled", tagNames: ["envio-brevo"] } : { state: "active", tagNames: ["envio-brevo"] }),
        findTagId: async (n) => (n === "frio" ? 900 : 555),
        tag: async (t, id) => void ops.push(`tag ${t} ${id}`),
        untag: async (t, id) => void ops.push(`untag ${t} ${id}`),
        unlinkBrevo: async (e) => void ops.push(`unlink ${e}`),
        readStore: () => store,
        writeStore: (s) => {
          store = s;
        },
        writePanelList: (rows) => void panel.push(...rows),
        appendLog: () => {},
        nowIso: () => "2026-10-28T00:00:00Z",
      },
    );
    assert.deepEqual(ops, ["tag 900 3", "untag 555 3", "unlink c@x.com"]);
    assert.equal(panel.length, 1);
    assert.equal(r.counts.painel, 1);
    assert.equal(findContact(store, "c@x.com")!.resolution_reason, "kit_sem_abertura_frio");
  });
});

describe("restore-brevo-semanal-suppressed (#11226)", () => {
  it("candidatos: suprimido por score com >= 1 abertura, fora kit-sem-abertura", () => {
    const sup = (email: string, origin: string, opens: number): BrevoDiariaContact => ({
      ...contact(email, origin),
      status: "suppressed",
      resolution_reason: "score_threshold",
      opens_count: opens,
    });
    const got = selectRestoreCandidates([sup("a@x.com", "kit:1", 1), sup("b@x.com", "kit:2", 0), sup("c@x.com", "kit-sem-abertura:3", 4)]);
    assert.deepEqual(got.map((c) => c.email), ["a@x.com"]);
  });
  it("descadastro/spam/bounce da pessoa nunca volta; já ativo no Kit fica de fora", () => {
    const opened = [{ campaignId: 1 }];
    assert.deepEqual(decideRestore({ brevoFound: true, statistics: { opened }, kitActive: false }), { restore: true });
    assert.equal(decideRestore({ brevoFound: true, statistics: { opened, unsubscriptions: { userUnsubscription: [{}] } }, kitActive: false }).restore, false);
    assert.equal(decideRestore({ brevoFound: true, statistics: { opened, complaints: [{}] }, kitActive: false }).restore, false);
    assert.equal(decideRestore({ brevoFound: true, statistics: { opened, hardBounces: [{}] }, kitActive: false }).restore, false);
    assert.equal(decideRestore({ brevoFound: true, statistics: { opened }, kitActive: true }).restore, false);
  });
  it("--apply sem o regime semanal ligado é recusado (voltariam a receber a diária)", async () => {
    const r = await runRestoreSemanal({ apply: true, listId: 7, semanalEnabled: false }, {
      log: () => {},
      readStore: () => ({ contacts: [] }),
      writeStore: () => {},
      getBrevoContact: async () => ({ status: 200 }),
      putBrevoContact: async () => {},
      kitState: async () => "inactive",
      appendLog: () => {},
      nowIso: () => "x",
    });
    assert.equal(r.code, 2);
  });
});

// ── integração com o fluxo agendado ──────────────────────────────────────

describe("Stage 5 Brevo no regime semanal (#11226)", () => {
  function deps(edition: string, calls: string[], contacts: BrevoDiariaContact[] = []): Stage5BrevoDeps {
    return {
      rootDir: "/fake",
      exec: (script) => {
        calls.push(script);
        return { code: 0, stdout: JSON.stringify({ warnings: [] }), stderr: "" };
      },
      storeExists: () => true,
      readContacts: () => contacts,
      readPlatformConfig: () => ({ brevo_diaria: { stage5_target_total: 290, semanal: { enabled: true, desde: "2026-11-02" } } }),
      readPublished: () => (calls.includes("scripts/publish-daily-brevo.ts") ? { campaign_id: 5 } : null),
    };
  }
  it("terça: contatos rodam, campanha não", () => {
    const calls: string[] = [];
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261103", deps("261103", calls));
    assert.equal(r.status, "skipped");
    assert.deepEqual(calls, ["scripts/brevo-diaria-run.ts"]);
  });
  it("segunda: campanha sai", () => {
    const calls: string[] = [];
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261102", deps("261102", calls));
    assert.equal(r.status, "ok");
    assert.ok(calls.includes("scripts/publish-daily-brevo.ts"));
  });
});

describe("brevo-diaria-run — Passo 3d sync-kit-frio (#11221)", () => {
  it("só com kit.frio ligado, e --push no apply", () => {
    const calls: string[] = [];
    const exec: ExecFn = (s) => {
      calls.push(s);
      return { code: 0, stdout: "", stderr: "" };
    };
    runBrevoDiaria(["--apply"], { rootDir: "/f", exec });
    assert.ok(!calls.includes("scripts/sync-kit-frio.ts"));
    const r = runBrevoDiaria(["--apply"], { rootDir: "/f", exec, kitFrioEnabled: () => true });
    assert.equal(r.steps.at(-1)!.args.join(" "), "--push");
    assert.ok(calls.includes("scripts/sync-kit-frio.ts"));
  });
});

describe("intro da semanal (#11226)", () => {
  it("regime semanal ligado sem o snippet ⇒ lança (nunca sai sem explicar a semanal)", () => {
    assert.throws(
      () => resolveDailyBrevoIntro(undefined, undefined, undefined, 0, { enabled: true, render: () => null }),
      /brevo-diaria-semanal-intro\.md/,
    );
    assert.equal(resolveDailyBrevoIntro(undefined, undefined, undefined, 0, { enabled: true, render: () => "<SEMANAL>" }), "<SEMANAL>");
  });
});
