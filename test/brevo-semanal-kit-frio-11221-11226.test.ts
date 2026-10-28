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
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  isMondayBrt,
  parseBrevoDiariaSemanal,
  semanalSplitGroup,
  stableEmailHash,
} from "../scripts/lib/brevo-diaria-semanal.ts";
import { evaluateSemanalDesdeMs, returnKitSemAberturaToFrio, runEvaluation, type KitFrioTagDeps, type KitEnvioBrevoTagDeps } from "../scripts/evaluate-brevo-diaria.ts";
import { findContact, type BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";
import {
  KIT_FRIO_RETURN_WINDOW_DAYS,
  KIT_FRIO_SUPPRESS_AFTER_SEMANAIS,
  KIT_FRIO_WINDOW_NEW_DAYS,
  buildDeliveryIndex,
  frioDeliveryCoversWindow,
  parseKitFrio,
  type KitSemanalFrioPublished,
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
import {
  publishKitSemanalFrio,
  runSemanalFrioAfterSchedule,
  summarizeSemanalFrioForSchedule,
  type SemanalFrioPublishDeps,
} from "../scripts/publish-kit-semanal-frio.ts";
import { collectRestoreTargets, decideKitRestore, runKitSemAberturaRestore } from "../scripts/restore-kit-sem-abertura-frio.ts";
import { decideRestore, runRestoreSemanal, selectRestoreCandidates, type RestoreDeps } from "../scripts/restore-brevo-semanal-suppressed.ts";
import { runStage5BrevoDispatch, type Stage5BrevoDeps } from "../scripts/brevo-diaria-stage5-dispatch.ts";
import { runBrevoDiaria, type ExecFn } from "../scripts/brevo-diaria-run.ts";
import { resolveDailyBrevoIntro } from "../scripts/publish-daily-brevo.ts";
import { buildTagFilter, type CreateBroadcastInput } from "../scripts/lib/kit-broadcasts.ts";
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
      assert.equal(classifyBrevoDiariaSemanalAction({ semanais: weekly(n), everOpened: true, clickedSinceDesde: false }), "keep", `n=${n}`);
    }
    assert.equal(classifyBrevoDiariaSemanalAction({ semanais: weekly(12), everOpened: true, clickedSinceDesde: false }), "suppress");
  });

  it("abertura numa semanal zera a sequência (abriu na 3ª de 14: só 11 seguidas depois ⇒ mantém)", () => {
    const s = weekly(14, { openedAt: [2] });
    assert.equal(trailingSemanaisSemSinal(s), 11);
    assert.equal(classifyBrevoDiariaSemanalAction({ semanais: s, everOpened: false, clickedSinceDesde: false }), "keep");
  });

  it("nunca abriu nem clicou: 4 semanais ⇒ suprime; 3 ⇒ mantém", () => {
    assert.equal(classifyBrevoDiariaSemanalAction({ semanais: weekly(3), everOpened: false, clickedSinceDesde: false }), "keep");
    assert.equal(classifyBrevoDiariaSemanalAction({ semanais: weekly(4), everOpened: false, clickedSinceDesde: false }), "suppress");
  });

  it("semanal imatura (<48h) não entra na sequência", () => {
    const s = weekly(4, { immatureLast: true });
    assert.equal(trailingSemanaisSemSinal(s), 3);
    assert.equal(classifyBrevoDiariaSemanalAction({ semanais: s, everOpened: false, clickedSinceDesde: false }), "keep");
  });

  it("clique em campanha a partir do corte ⇒ promote_by_click, antes de tudo", () => {
    assert.equal(classifyBrevoDiariaSemanalAction({ semanais: weekly(20), everOpened: false, clickedSinceDesde: true }), "promote_by_click");
    assert.equal(classifyBrevoDiariaSemanalAction({ semanais: weekly(2, { clickedAt: [1] }), everOpened: false, clickedSinceDesde: false }), "promote_by_click");
  });

  it("abertura > 51% em >= 3 semanais promove; 2 de 2 não (piso de amostra contado em semanais)", () => {
    assert.equal(classifyBrevoDiariaSemanalAction({ semanais: weekly(3, { openedAt: [0, 1] }), everOpened: true, clickedSinceDesde: false }), "promote_to_beehiiv");
    assert.equal(classifyBrevoDiariaSemanalAction({ semanais: weekly(2, { openedAt: [0, 1] }), everOpened: true, clickedSinceDesde: false }), "keep");
  });
});

describe("buildSemanalEvaluationInput (#11226)", () => {
  const desde = Date.parse("2026-11-02T00:00:00-03:00");
  it("só campanhas de segunda a partir do corte contam como semanal; clique só a partir do corte", () => {
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
    assert.equal(input.clickedSinceDesde, true);
    assert.equal(input.semanais.find((s) => s.clicked)?.mature, false, "envio de 09/11 09:00 tem < 48h em 10/11 12:00");
  });
});

describe("P1-1 — diárias pós-corte NÃO contam como semanal (#11226 review)", () => {
  const desde = Date.parse("2026-11-02T00:00:00-03:00");
  // 12 diárias consecutivas a partir de terça 03/11 (06:00 BRT): só 2 caem numa segunda (09/11 e 16/11 ficam fora: 03..14/11).
  const diarias = Array.from({ length: 12 }, (_, i) => ({ campaignId: 200 + i, eventTime: new Date(desde + DAY + 9 * 3600 * 1000 + i * DAY).toISOString() }));
  it("REGRESSÃO: 12 diárias consecutivas pós-corte pra quem abriu uma vez ⇒ keep (não são 12 semanais)", () => {
    const stats = { messagesSent: [{ campaignId: 1, eventTime: "2026-10-20T09:00:00Z" }, ...diarias], opened: [{ campaignId: 1 }] };
    const input = buildSemanalEvaluationInput(stats, desde, desde + 20 * DAY);
    assert.ok(input.semanais.length <= 2, `só segundas contam (veio ${input.semanais.length})`);
    assert.equal(classifyBrevoDiariaSemanalAction(input), "keep");
  });
  it("isMondayBrt: segunda 06:00 BRT sim; segunda 01:00 UTC (domingo 22:00 BRT) não", () => {
    assert.equal(isMondayBrt(Date.parse("2026-11-02T09:00:00Z")), true);
    assert.equal(isMondayBrt(Date.parse("2026-11-02T01:00:00Z")), false);
  });
  it("clique em campanha ANTERIOR ao corte não promove (premissa A: nunca clique histórico)", () => {
    const stats = {
      messagesSent: [{ campaignId: 1, eventTime: "2026-10-20T09:00:00Z" }],
      clicked: [{ campaignId: 1, links: [{ eventTime: "2026-11-05T11:00:00Z" }] }],
    };
    const input = buildSemanalEvaluationInput(stats, desde, desde + 10 * DAY);
    assert.equal(input.clickedSinceDesde, false);
    assert.notEqual(classifyBrevoDiariaSemanalAction(input), "promote_by_click");
  });
  it("evaluate só pontua por semanal com o modo EFETIVO semanal (resíduo kit-sem-abertura in_brevo ⇒ diária)", () => {
    const on = parseBrevoDiariaSemanal({ enabled: true, desde: "2026-11-02" });
    const residuo = [{ ...contact("m@x.com", "kit-sem-abertura:1") }];
    assert.equal(evaluateSemanalDesdeMs(on, residuo), undefined);
    assert.equal(evaluateSemanalDesdeMs(on, [contact("a@x.com", "kit:2")]), desde);
    assert.equal(evaluateSemanalDesdeMs(parseBrevoDiariaSemanal(undefined), []), undefined);
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
  it("config ligada sem desde válido é erro; desde fora de segunda é erro", () => {
    assert.ok("error" in parseBrevoDiariaSemanal({ enabled: true }));
    assert.ok("error" in parseBrevoDiariaSemanal({ enabled: true, desde: "2026-11-03" }));
  });
  it("divisão fixa por pessoa (hash estável, insensível a caixa) e aviso de capacidade", () => {
    assert.equal(semanalSplitGroup("A@x.com"), semanalSplitGroup(" a@x.com "));
    // Valor de referência fixo: o grupo de cada pessoa não pode mudar entre versões.
    assert.equal(stableEmailHash("leitor@diar.ia.br"), 2397817964);
    assert.equal(semanalSplitGroup("leitor@diar.ia.br"), "segunda");
    assert.equal(stableEmailHash("a@x.com"), 2201822783);
    assert.equal(semanalSplitGroup("a@x.com"), "terca");
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
          kitFrioFullyOn: true,
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
          kitFrioFullyOn: true,
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

describe("runEvaluation — premissa B: frio NÃO plenamente ligado (#11221 review)", () => {
  it("REGRESSÃO: kit-sem-abertura suprimido sai SÓ da lista Brevo; nada de frio, unsubscribe ou blacklist; store aguardando_frio", async () => {
    let unsubscribeCalls = 0;
    const kitTagOps: string[] = [];
    const brevoPuts: string[] = [];
    const sent = Array.from({ length: 6 }, (_, i) => ({ campaignId: i + 1, eventTime: "2026-10-01T09:00:00Z" }));
    const r = await withFetch(
      (url, init) => {
        if (url.includes("api.kit.com")) throw new Error(`Kit não deveria ser chamado: ${url}`);
        if (init?.method === "PUT") {
          brevoPuts.push(String(init.body));
          return jsonRes(200, {});
        }
        // #11294 item 3: a releitura pós-unlink precisa mostrar o contato fora da lista.
        const unlinked = brevoPuts.some((b) => b.includes("unlinkListIds"));
        return jsonRes(200, { emailBlacklisted: false, listIds: unlinked ? [] : [7], statistics: { messagesSent: sent, opened: [] } });
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
          unsubscribeKitSemAberturaDeps: { unsubscribe: async () => void unsubscribeCalls++, getState: async () => "active" },
          kitFrioTagDeps: { findTagId: async () => 900, tag: async (t, id) => void kitTagOps.push(`tag ${t} ${id}`), listTags: async () => [] },
          kitEnvioBrevoTagDeps: { findTagId: async () => 555, untag: async (t, id) => void kitTagOps.push(`untag ${t} ${id}`), listTags: async () => [] },
          // kitFrioFullyOn ausente ⇒ premissa B
        });
      },
    );
    assert.equal(unsubscribeCalls, 0, "nunca descadastra no Kit");
    assert.deepEqual(kitTagOps, [], "sem frio e sem tirar envio-brevo (fica fora da diária pelo segmento)");
    assert.ok(brevoPuts.some((b) => b.includes("unlinkListIds")), "sai da lista Brevo");
    assert.ok(!brevoPuts.some((b) => b.includes("emailBlacklisted")), "sem blacklist (o Passo 0 leria como saída)");
    const stored = findContact(r.store, "frio@x.com")!;
    assert.equal(stored.status, "suppressed");
    assert.equal(stored.resolution_reason, "kit_sem_abertura_aguardando_frio");
    assert.equal(r.kitSemAberturaAwaitingFrio, 1);
    assert.equal(r.kitSemAberturaReturnedToFrio, 0);
    // E o restore do frio o reconhece depois.
    const { targets } = collectRestoreTargets([], r.store.contacts);
    assert.deepEqual(targets, [{ email: "frio@x.com", kitSubscriberId: 42, source: "suprimido_aguardando_frio" }]);
  });

  it("returnKitSemAberturaToFrio sem frioFullyOn nunca toca o Kit", async () => {
    let touched = 0;
    const r = await returnKitSemAberturaToFrio({
      subscriberId: 42,
      kitApiKey: "k",
      frioFullyOn: false,
      frioDeps: { findTagId: async () => (touched++, 900), tag: async () => void touched++, listTags: async () => [] },
      removeEnvioBrevoTag: async () => (touched++, { ok: true }),
    });
    assert.equal(r.ok, false);
    assert.equal(touched, 0);
  });
});

describe("runEvaluation — clique na Brevo: guards da ativação no Kit (#11226 review)", () => {
  const desde = Date.parse("2026-11-02T00:00:00-03:00");
  const sentAt = new Date(desde + 9 * 3600 * 1000).toISOString();
  async function clickRun(opts: {
    kitState: string;
    confirms?: boolean;
    activateFormId?: string;
    doiFormId?: string;
    emails?: string[];
  }) {
    const activateCalls: string[] = [];
    const kitPosts: string[] = [];
    const logs: string[] = [];
    let activated = false;
    const emails = opts.emails ?? ["clicou@x.com"];
    const sub = (email: string) => ({
      id: 77,
      email_address: email,
      state: activated && opts.confirms !== false ? "active" : opts.kitState,
      created_at: "2026-10-01T00:00:00Z",
      fields: {},
    });
    const r = await withFetch(
      (url, init) => {
        if (url.includes("api.kit.com")) {
          if (init?.method === "POST") {
            kitPosts.push(url);
            return jsonRes(201, { subscriber: sub(emails[0]!) });
          }
          if (url.includes("/forms/")) return jsonRes(200, { subscribers: [], pagination: { has_next_page: false } });
          const m = /email_address=([^&]+)/.exec(url);
          const email = m ? decodeURIComponent(m[1]!) : emails[0]!;
          if (url.includes("/subscribers?")) {
            return jsonRes(200, {
              subscribers: [sub(email)],
              pagination: { has_next_page: false, has_previous_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
            });
          }
          if (/\/subscribers\/77/.test(url)) return jsonRes(200, { subscriber: sub(email) });
          throw new Error(`Kit inesperado: ${init?.method ?? "GET"} ${url}`);
        }
        if (init?.method === "PUT") return jsonRes(200, {});
        return jsonRes(200, {
          emailBlacklisted: false,
          listIds: [7],
          statistics: { messagesSent: [{ campaignId: 1, eventTime: sentAt }], clicked: [{ campaignId: 1, links: [{ eventTime: sentAt }] }] },
        });
      },
      () => {
        const contacts = emails.map((e) => contact(e, "kit:77"));
        return runEvaluation({
          contacts,
          store: { contacts },
          push: true,
          publicationId: "pub",
          beehiivApiKey: "b",
          brevoApiKey: "br",
          kitApiKey: "k",
          listId: 7,
          log: (m) => void logs.push(m),
          newsletterBackend: "kit",
          semanalDesdeMs: desde,
          nowMs: desde + DAY,
          kitActivateFormId: opts.activateFormId,
          kitDoiFormId: opts.doiFormId,
          activateKitViaForm: async (formId, id) => {
            activateCalls.push(`${formId}/${id}`);
            activated = true;
          },
        });
      },
    );
    return { r, activateCalls, kitPosts, logs };
  }

  for (const state of ["cancelled", "bounced", "complained"]) {
    it(`clique NUNCA ativa quem está ${state} no Kit pelo form de sistema`, async () => {
      const { r, activateCalls } = await clickRun({ kitState: state, activateFormId: "9839463" });
      assert.deepEqual(activateCalls, []);
      assert.equal(r.promotedByClick, 1, "a decisão foi clique, mas o destino não reativa");
      assert.equal(findContact(r.store, "clicou@x.com")!.status, "in_brevo");
    });
  }

  it("ativação não confirmada na releitura ⇒ keep + failed", async () => {
    const { r, activateCalls } = await clickRun({ kitState: "inactive", activateFormId: "9839463", confirms: false });
    assert.deepEqual(activateCalls, ["9839463/77"]);
    assert.equal(r.failed, 1);
    assert.equal(findContact(r.store, "clicou@x.com")!.status, "in_brevo");
  });

  it("kitActivateFormId ausente ⇒ aviso ÚNICO na rodada e cai no reenvio do DOI", async () => {
    const { activateCalls, kitPosts, logs } = await clickRun({ kitState: "inactive", doiFormId: "9897918", emails: ["c1@x.com", "c2@x.com"] });
    assert.deepEqual(activateCalls, []);
    assert.equal(logs.filter((l) => /kit\.activateFormId ausente/.test(l)).length, 1);
    assert.ok(kitPosts.some((u) => u.includes("/forms/9897918/subscribers/77")), `reenvio do DOI pelo form de DOI (posts: ${kitPosts.join(", ")})`);
  });

  it("kitActivateFormId igual ao form de DOI ⇒ ignorado (nunca ativa por ele)", async () => {
    const { activateCalls, logs } = await clickRun({ kitState: "inactive", activateFormId: "9897918", doiFormId: "9897918" });
    assert.deepEqual(activateCalls, []);
    assert.ok(logs.some((l) => /igual a um form de DOI/.test(l)));
  });

  it("config real: kit.activateFormId distinto de doiFormId e doiResendFormId", () => {
    const cfg = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "platform.config.json"), "utf8")) as {
      kit: { activateFormId: string; doiFormId: string; doiResendFormId: string };
    };
    assert.match(cfg.kit.activateFormId, /^[0-9]+$/);
    assert.notEqual(cfg.kit.activateFormId, cfg.kit.doiFormId);
    assert.notEqual(cfg.kit.activateFormId, cfg.kit.doiResendFormId);
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
/** Todo e-mail recebeu todas as diárias do registro (janela inteira coberta). */
const allDeliveries = { get: () => registry.map((r) => Date.parse(r.sentAt)) } as unknown as ReadonlyMap<string, readonly number[]>;
const ctxBase = {
  nowMs: NOW,
  silentStreaks: new Map<string, number>(),
  diariaRecords: registry,
  diariaDeliveries: allDeliveries,
  seedEmails: new Set<string>(),
};

describe("parseKitFrio (#11221 review — leitor único das flags)", () => {
  const seg = { enabled: true, segment_id: 599796 };
  it("ausente ⇒ desligado; enabled + semanal + segmento confirmado + segmento ligado ⇒ fullyOn", () => {
    assert.deepEqual(parseKitFrio(undefined), { enabled: false, segmentoConfirmado: false, fullyOn: false });
    assert.deepEqual(parseKitFrio({ frio: { enabled: true, semanal_enabled: true, segmento_exclui_frio_confirmado: true }, diaria_exclusion_segment: seg }), {
      enabled: true,
      segmentoConfirmado: true,
      fullyOn: true,
    });
  });
  it("sem o segmento confirmado ou com o segmento desligado ⇒ ligado mas NÃO fullyOn", () => {
    const a = parseKitFrio({ frio: { enabled: true, semanal_enabled: true }, diaria_exclusion_segment: seg });
    assert.ok(!("error" in a) && a.enabled && !a.fullyOn);
    const b = parseKitFrio({ frio: { enabled: true, semanal_enabled: true, segmento_exclui_frio_confirmado: true } });
    assert.ok(!("error" in b) && !b.fullyOn);
  });
  it("enabled != semanal_enabled é erro (frio sem semanal deixa a pessoa sem edição)", () => {
    assert.ok("error" in parseKitFrio({ frio: { enabled: true } }));
    assert.ok("error" in parseKitFrio({ frio: { semanal_enabled: true } }));
  });
  it("booleano não-booleano é erro", () => {
    assert.ok("error" in parseKitFrio({ frio: { enabled: "true", semanal_enabled: "true" } }));
    assert.ok("error" in parseKitFrio({ frio: { enabled: false, semanal_enabled: false, segmento_exclui_frio_confirmado: 1 } }));
    assert.ok("error" in parseKitFrio({ frio: "sim" }));
  });
  it("config real do repo parseia (e está desligada no merge)", () => {
    const cfg = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "platform.config.json"), "utf8")) as { kit: unknown };
    const p = parseKitFrio(cfg.kit);
    assert.ok(!("error" in p));
    assert.equal(p.enabled, false);
  });
  it("janela de volta <= menor janela de esfriar (regra sem estado)", () => {
    assert.ok(KIT_FRIO_RETURN_WINDOW_DAYS <= KIT_FRIO_WINDOW_NEW_DAYS);
  });
});

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
  it("REGRESSÃO P1-4: cadastro antigo que nunca recebeu a diária no Kit (ou só há poucos dias) NÃO esfria", () => {
    const none = decideKitFrio(cand("novo@x.com", 400), { ...ctxBase, diariaDeliveries: new Map(), lastSignal: new Map() });
    assert.deepEqual(none, { action: "skip", reason: "sem_entrega_da_diaria_na_janela" });
    const recent = new Map([["novo@x.com", [NOW - 3 * DAY, NOW - 2 * DAY]]]);
    assert.deepEqual(decideKitFrio(cand("novo@x.com", 400), { ...ctxBase, diariaDeliveries: recent, lastSignal: new Map() }), {
      action: "skip",
      reason: "sem_entrega_da_diaria_na_janela",
    });
  });
  it("frioDeliveryCoversWindow: precisa de entrega desde o começo da janela (folga de 7 dias)", () => {
    const since = NOW - 30 * DAY;
    assert.equal(frioDeliveryCoversWindow([since + 6 * DAY, NOW - DAY], since), true);
    assert.equal(frioDeliveryCoversWindow([since + 8 * DAY], since), false);
    assert.equal(frioDeliveryCoversWindow(undefined, since), false);
    const idx = buildDeliveryIndex([{ sentAt: "2026-10-01T09:00:00Z", delivered: ["A@x.com", "a@x.com"] }]);
    assert.deepEqual(idx.get("a@x.com"), [Date.parse("2026-10-01T09:00:00Z")]);
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
  it("supressão que caiu no meio (suprimido + frio) ⇒ termina tirando frio (o filtro do Kit não exclui suprimido)", () => {
    assert.deepEqual(decideKitFrio(cand("h@x.com", 60, ["suprimido", "frio"]), { ...ctxBase, lastSignal: new Map() }), { action: "finish_suppress" });
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
  it("gmailOpenRate e estado de pausa ilegível ou com formato inválido (fail-safe = pausada)", () => {
    assert.equal(gmailOpenRate(["a@gmail.com", "b@gmail.com", "c@uol.com.br"], ["a@gmail.com", "c@uol.com.br"]), 0.5);
    assert.equal(parseSemanalFrioPauseState("{lixo").paused, true);
    assert.equal(parseSemanalFrioPauseState(null).paused, false);
    for (const bad of ["[]", "\"x\"", "{}", "{\"paused\":\"no\"}", "null", "1"]) {
      assert.equal(parseSemanalFrioPauseState(bad).paused, true, `formato inválido ${bad} ⇒ pausada`);
    }
    assert.equal(parseSemanalFrioPauseState("{\"paused\": false}").paused, false);
  });
});

const cfgFrioOn = {
  kit: {
    frio: { enabled: true, semanal_enabled: true, segmento_exclui_frio_confirmado: true },
    diaria_exclusion_segment: { enabled: true, segment_id: 599796 },
  },
};

function frioDeps(overrides: Partial<KitFrioDeps> & { calls: string[] }): KitFrioDeps {
  const { calls } = overrides;
  return {
    nowMs: NOW,
    log: () => {},
    readDiariaRegistry: () => registry,
    readSemanalRegistry: () => [],
    listKitActive: async () => [cand("velho@x.com", 60), cand("volta@x.com", 60, ["frio"])],
    fetchEngagement: async (id) => ({ broadcastId: id, delivered: ["velho@x.com", "volta@x.com"], opens: id === 99 ? ["volta@x.com"] : [], clicks: [] }),
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
  it("desligado ⇒ nada roda", async () => {
    const calls: string[] = [];
    const r = await runKitFrioSync({}, { push: true }, frioDeps({ calls }));
    assert.equal(r.disabled, true);
    assert.deepEqual(calls, []);
  });
  it("flags inválidas (enabled sem semanal_enabled) ⇒ exit 2, nada aplicado", async () => {
    const calls: string[] = [];
    const r = await runKitFrioSync({ kit: { frio: { enabled: true } } }, { push: true }, frioDeps({ calls }));
    assert.equal(r.code, 2);
    assert.deepEqual(calls, []);
  });
  it("segmento não confirmado como excluindo frio ⇒ --push vira dry-run", async () => {
    const calls: string[] = [];
    const r = await runKitFrioSync(
      { kit: { frio: { enabled: true, semanal_enabled: true }, diaria_exclusion_segment: { enabled: true, segment_id: 599796 } } },
      { push: true },
      frioDeps({ calls }),
    );
    assert.equal(r.dryRun, true);
    assert.deepEqual(calls, []);
    assert.equal(r.taggedFrio, 1);
  });
  it("com as flags: tagueia o frio novo e tira frio de quem voltou a abrir — só tags", async () => {
    const calls: string[] = [];
    const r = await runKitFrioSync(cfgFrioOn, { push: true }, frioDeps({ calls }));
    assert.equal(r.code, 0);
    assert.deepEqual(calls.sort(), [`tag 900 ${"velho@x.com".length}`, `untag 900 ${"volta@x.com".length}`].sort());
  });
  it("REGRESSÃO P1-3: vigia pausada ⇒ ninguém novo recebe frio; a volta à diária segue", async () => {
    const calls: string[] = [];
    const r = await runKitFrioSync(cfgFrioOn, { push: true }, frioDeps({ calls, readPause: () => ({ paused: true }) }));
    assert.deepEqual(calls, [`untag 900 ${"volta@x.com".length}`]);
    assert.equal(r.frioHeldByPause, 1);
    assert.equal(r.taggedFrio, 0);
  });
  it("suprimido + frio ⇒ tira frio (retentativa da supressão incompleta)", async () => {
    const calls: string[] = [];
    const r = await runKitFrioSync(cfgFrioOn, { push: true }, frioDeps({ calls, listKitActive: async () => [cand("meio@x.com", 60, ["suprimido", "frio"])] }));
    assert.deepEqual(calls, [`untag 900 ${"meio@x.com".length}`]);
    assert.equal(r.finishedSuppress, 1);
  });

  // Vigia disparada: 1 semanal madura, 10 entregues, 1 complained (10% > 0,1%).
  const semanalReg = [{ broadcastId: 500, sentAt: new Date(NOW - 10 * DAY).toISOString(), edition: "s1" }];
  const vigiaDeps = (calls: string[], over: Partial<KitFrioDeps> = {}) =>
    frioDeps({
      calls,
      listKitActive: async () => [],
      readSemanalRegistry: () => semanalReg,
      fetchEngagement: async (id) => ({
        broadcastId: id,
        delivered: id === 500 ? Array.from({ length: 10 }, (_, i) => `p${i}@x.com`) : [],
        opens: [],
        clicks: [],
      }),
      listComplainedEmails: async () => ["p0@x.com"],
      ...over,
    });
  it("vigia em dry-run REBAIXADO (sem segmento confirmado) não grava pausa nem alarma", async () => {
    const calls: string[] = [];
    const r = await runKitFrioSync(
      { kit: { frio: { enabled: true, semanal_enabled: true }, diaria_exclusion_segment: { enabled: true, segment_id: 599796 } } },
      { push: true },
      vigiaDeps(calls),
    );
    assert.equal(r.vigia?.pause, true);
    assert.deepEqual(calls, []);
  });
  it("vigia com push: grava a pausa e alarma; se a gravação falhar, alarma mesmo assim", async () => {
    const calls: string[] = [];
    await runKitFrioSync(cfgFrioOn, { push: true }, vigiaDeps(calls));
    assert.deepEqual(calls, ["pause", "alarm"]);
    const calls2: string[] = [];
    let alarmReasons: string[] = [];
    await runKitFrioSync(
      cfgFrioOn,
      { push: true },
      vigiaDeps(calls2, {
        writePause: () => {
          throw new Error("EACCES");
        },
        raiseAlarm: (r) => {
          alarmReasons = r;
          calls2.push("alarm");
        },
      }),
    );
    assert.deepEqual(calls2, ["alarm"]);
    assert.ok(alarmReasons.some((r) => /NÃO foi gravada/.test(r)));
  });
});

// ── broadcast semanal de frio ─────────────────────────────────────────────

type SemanalTestDeps = SemanalFrioPublishDeps & { created: CreateBroadcastInput[]; deleted: number[]; written: KitSemanalFrioPublished[]; scheduled: string[]; alarms: string[] };
function semanalDeps(over: Partial<SemanalFrioPublishDeps> = {}, opts: { rereadFilter?: unknown } = {}): SemanalTestDeps {
  const created: CreateBroadcastInput[] = [];
  const deleted: number[] = [];
  const written: KitSemanalFrioPublished[] = [];
  const scheduled: string[] = [];
  const alarms: string[] = [];
  const sendAt = new Map<number, string>();
  return {
    created,
    deleted,
    written,
    scheduled,
    alarms,
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
        status: sendAt.has(id) ? "scheduled" : "draft",
        send_at: sendAt.get(id) ?? null,
        subscriber_filter: id === 10 ? undefined : "rereadFilter" in opts ? opts.rereadFilter : buildTagFilter(900),
      }) as never,
    createBroadcast: async (input) => {
      created.push(input);
      return { id: 11 } as never;
    },
    scheduleBroadcast: async (id, at) => {
      scheduled.push(`${id}@${at}`);
      if (at === null) sendAt.delete(id); // #11294: `null` desagenda
      else sendAt.set(id, at);
    },
    updateBroadcastContent: async () => {
      throw new Error("não deveria re-sincronizar conteúdo");
    },
    deleteBroadcast: async (id) => void deleted.push(id),
    raiseAlarm: (title) => void alarms.push(title),
    ...over,
  };
}

describe("publishKitSemanalFrio (#11221)", () => {
  it("segunda: cria RASCUNHO, grava created_unverified ANTES de reler, confere o filtro e só então agenda", async () => {
    const d = semanalDeps();
    const r = await publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: true }, d);
    assert.equal(r.status, "scheduled");
    const input = d.created[0]!;
    assert.deepEqual(input.subscriber_filter, buildTagFilter(900));
    assert.equal(input.send_at, null, "criado sem send_at (rascunho)");
    assert.equal(input.public, false);
    assert.ok(input.content.includes(KIT_SEMANAL_FRIO_INTRO_TEXT.slice(0, 40)));
    assert.ok(input.content.includes(KIT_SEMANAL_FRIO_BUTTON_LABEL));
    assert.deepEqual(d.scheduled, ["11@2026-11-02T09:00:00.000Z"]);
    assert.deepEqual(d.written.map((w) => w.status), ["created_unverified", "scheduled"]);
  });
  it("terça não cria; tag vazia não cria; pausada não cria", async () => {
    assert.equal((await publishKitSemanalFrio("/x/2611/261103", cfgFrioOn, { push: true }, semanalDeps())).status, "not_monday");
    assert.equal((await publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: true }, semanalDeps({ countTagMembers: async () => 0 }))).status, "empty_tag");
    assert.equal((await publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: true }, semanalDeps({ readPause: () => ({ paused: true }) }))).status, "paused");
  });
  it("REGRESSÃO P1-2: flags parciais (sem segmento confirmado) ⇒ recusa exit 2, nada criado", async () => {
    const d = semanalDeps();
    const partial = { kit: { frio: { enabled: true, semanal_enabled: true }, diaria_exclusion_segment: { enabled: true, segment_id: 1 } } };
    const r = await publishKitSemanalFrio("/x/2611/261102", partial, { push: true }, d);
    assert.equal(r.code, 2);
    assert.equal(d.created.length, 0);
    const noSeg = { kit: { frio: { enabled: true, semanal_enabled: true, segmento_exclui_frio_confirmado: true } } };
    assert.equal((await publishKitSemanalFrio("/x/2611/261102", noSeg, { push: true }, semanalDeps())).code, 2);
    assert.equal((await publishKitSemanalFrio("/x/2611/261102", {}, { push: true }, semanalDeps())).status, "disabled");
  });
  it("tag inexistente ⇒ recusa (filtro não resolvido = base inteira)", async () => {
    const r = await publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: true }, semanalDeps({ findTagId: async () => null }));
    assert.equal(r.code, 2);
  });
  it("filtro relido diverge ⇒ apaga o rascunho, nunca agenda, exit 1, estado 'deleted'", async () => {
    const d = semanalDeps({}, { rereadFilter: [] });
    const r = await publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: true }, d);
    assert.equal(r.code, 1);
    assert.deepEqual(d.deleted, [11]);
    assert.deepEqual(d.scheduled, []);
    assert.deepEqual(d.written.map((w) => w.status), ["created_unverified", "deleted"]);
  });
  it("REGRESSÃO P1-5: filtro diverge e o DELETE falha ⇒ alarme + failed com o id (estado created_unverified mantido)", async () => {
    const d = semanalDeps(
      {
        deleteBroadcast: async () => {
          throw new Error("HTTP 500");
        },
      },
      { rereadFilter: [] },
    );
    const r = await publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: true }, d);
    assert.equal(r.code, 1);
    assert.equal(r.status, "failed");
    assert.equal(r.broadcastId, 11);
    assert.equal(d.alarms.length, 1);
    assert.deepEqual(d.written.map((w) => w.status), ["created_unverified"]);
    assert.deepEqual(d.scheduled, []);
  });
  it("REGRESSÃO P1-5: releitura lança depois do POST ⇒ o id já está gravado; a rodada seguinte RETOMA sem criar outro", async () => {
    let state: KitSemanalFrioPublished | null = null;
    let fail = true;
    const base = semanalDeps();
    const d1 = semanalDeps({
      writeOwnState: (_d, s) => void (state = s),
      readOwnState: () => state,
      getBroadcast: async (id) => {
        if (id === 11 && fail) throw new Error("rede caiu");
        return base.getBroadcast(id);
      },
    });
    await assert.rejects(publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: true }, d1), /rede caiu/);
    assert.equal(state!.status, "created_unverified");
    assert.equal(state!.broadcast_id, 11);
    fail = false;
    const d2 = semanalDeps({ writeOwnState: (_d, s) => void (state = s), readOwnState: () => state });
    const r = await publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: true }, d2);
    assert.equal(r.status, "scheduled");
    assert.equal(d2.created.length, 0, "não cria uma 2ª semanal");
    assert.deepEqual(d2.scheduled, ["11@2026-11-02T09:00:00.000Z"]);
    assert.equal(state!.status, "scheduled");
  });
  it("REGRESSÃO P1-5: writeOwnState falha logo após o POST ⇒ apaga o rascunho (sem registro, rerun duplicaria)", async () => {
    const d = semanalDeps({
      writeOwnState: () => {
        throw new Error("disco cheio");
      },
    });
    const r = await publishKitSemanalFrio("/x/2611/261102", cfgFrioOn, { push: true }, d);
    assert.equal(r.code, 1);
    assert.deepEqual(d.deleted, [11]);
    assert.deepEqual(d.scheduled, []);
  });
  it("schedule-newsletter-kit: o desfecho vai no JSON (semanal_frio) sem lançar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "semanal-frio-"));
    writeFileSync(join(dir, "platform.config.json"), JSON.stringify(cfgFrioOn));
    const failed = await runSemanalFrioAfterSchedule("/x/2611/261102", () => {}, dir, semanalDeps({ deleteBroadcast: async () => { throw new Error("x"); } }, { rereadFilter: [] }));
    assert.deepEqual(summarizeSemanalFrioForSchedule(failed).status, "failed");
    assert.equal(summarizeSemanalFrioForSchedule(failed).broadcast_id, 11);
    assert.ok(summarizeSemanalFrioForSchedule(failed).reason);
    writeFileSync(join(dir, "platform.config.json"), JSON.stringify({}));
    assert.equal((await runSemanalFrioAfterSchedule("/x/2611/261102", () => {}, dir, semanalDeps())).status, "disabled");
  });
  it("intro entra logo depois do <body> quando há documento completo", () => {
    const out = injectSemanalFrioIntro("<html><body class=x><p>a</p></body></html>", "<i>INTRO</i>");
    assert.equal(out, "<html><body class=x><i>INTRO</i><p>a</p></body></html>");
  });
});

// ── scripts de transição (dry-run por padrão) ────────────────────────────

describe("restore-kit-sem-abertura-frio (#11221)", () => {
  const frioOn = parseKitFrio(cfgFrioOn.kit);
  it("alvos: kit_unsubscribed+suppress do log (dedup, linha ruim ignorada) + kit-sem-abertura in_brevo + suprimidos aguardando frio", () => {
    const log =
      JSON.stringify({ event: "kit_unsubscribed", brevo_exit: "suppress", email: "A@x.com", kit_subscriber_id: 1 }) +
      "\n{lixo\n" +
      JSON.stringify({ event: "kit_unsubscribed", brevo_exit: "native_unsubscribe", email: "b@x.com", kit_subscriber_id: 2 }) +
      "\n";
    const aguardando: BrevoDiariaContact = { ...contact("e@x.com", "kit-sem-abertura:5"), status: "suppressed", resolution_reason: "kit_sem_abertura_aguardando_frio" };
    const scoreSup: BrevoDiariaContact = { ...contact("f@x.com", "kit-sem-abertura:6"), status: "suppressed", resolution_reason: "score_threshold" };
    const { targets, badLines } = collectRestoreTargets([log, log], [contact("c@x.com", "kit-sem-abertura:3"), contact("d@x.com", "kit:4"), aguardando, scoreSup]);
    assert.equal(badLines, 2);
    assert.deepEqual(targets.map((t) => `${t.email}:${t.source}`).sort(), [
      "a@x.com:descadastrado_por_supressao",
      "c@x.com:in_brevo",
      "e@x.com:suprimido_aguardando_frio",
    ]);
  });
  it("cancelled vai pro painel (a API não reativa); active ganha as tags", () => {
    assert.equal(decideKitRestore("cancelled", [], "descadastrado_por_supressao"), "painel");
    assert.equal(decideKitRestore("active", ["envio-brevo"], "in_brevo"), "tags");
    assert.equal(decideKitRestore("active", ["frio"], "suprimido_aguardando_frio"), "ja_ok");
  });
  it("REGRESSÃO #11430: cancelled de origem in_brevo/suprimido_aguardando_frio é opt-out próprio, nunca vai pro painel", () => {
    assert.equal(decideKitRestore("cancelled", [], "in_brevo"), "descadastro_proprio");
    assert.equal(decideKitRestore("cancelled", ["envio-brevo"], "suprimido_aguardando_frio"), "descadastro_proprio");
  });
  function restoreDeps(ops: string[], storeRef: { store: { contacts: BrevoDiariaContact[] } }, panel: unknown[]) {
    return {
      log: () => {},
      getKit: async (id: number) => (id === 1 ? { state: "cancelled", tagNames: ["envio-brevo"] } : { state: "active", tagNames: ["envio-brevo"] }),
      findTagId: async (n: string) => (n === "frio" ? 900 : 555),
      tag: async (t: number, id: number) => void ops.push(`tag ${t} ${id}`),
      untag: async (t: number, id: number) => void ops.push(`untag ${t} ${id}`),
      unlinkBrevo: async (e: string) => void ops.push(`unlink ${e}`),
      readStore: () => storeRef.store,
      writeStore: (s: { contacts: BrevoDiariaContact[] }) => {
        storeRef.store = s;
      },
      writePanelList: (rows: unknown[]) => void panel.push(...rows),
      appendLog: () => {},
      nowIso: () => "2026-10-28T00:00:00Z",
    };
  }
  it("--apply: frio antes de tirar envio-brevo; in_brevo desvinculado e convertido; aguardando frio convertido sem unlink; cancelled só listado", async () => {
    const ops: string[] = [];
    const aguardando: BrevoDiariaContact = { ...contact("e@x.com", "kit-sem-abertura:5"), status: "suppressed", resolution_reason: "kit_sem_abertura_aguardando_frio" };
    const ref = { store: { contacts: [contact("c@x.com", "kit-sem-abertura:3"), aguardando] } };
    const panel: unknown[] = [];
    const r = await runKitSemAberturaRestore(
      [
        { email: "a@x.com", kitSubscriberId: 1, source: "descadastrado_por_supressao" },
        { email: "c@x.com", kitSubscriberId: 3, source: "in_brevo" },
        { email: "e@x.com", kitSubscriberId: 5, source: "suprimido_aguardando_frio" },
      ],
      { apply: true, frio: frioOn },
      restoreDeps(ops, ref, panel),
    );
    assert.deepEqual(ops, ["tag 900 3", "untag 555 3", "unlink c@x.com", "tag 900 5", "untag 555 5"]);
    assert.equal(panel.length, 1);
    assert.equal(r.counts.painel, 1);
    assert.equal(findContact(ref.store, "c@x.com")!.resolution_reason, "kit_sem_abertura_frio");
    const e = findContact(ref.store, "e@x.com")!;
    assert.equal(e.status, "converted_to_kit");
    assert.equal(e.resolution_reason, "kit_sem_abertura_frio");
  });
  it("REGRESSÃO #11430: --apply com cancelled in_brevo + cancelled por supressão ⇒ CSV só com o descadastrado por nós, sem tag/unlink/store", async () => {
    const ops: string[] = [];
    const ref = { store: { contacts: [contact("c@x.com", "kit-sem-abertura:3")] } };
    const panel: { email: string }[] = [];
    const deps = { ...restoreDeps(ops, ref, panel as unknown[]), getKit: async () => ({ state: "cancelled", tagNames: ["envio-brevo"] }) };
    const r = await runKitSemAberturaRestore(
      [
        { email: "a@x.com", kitSubscriberId: 1, source: "descadastrado_por_supressao" },
        { email: "c@x.com", kitSubscriberId: 3, source: "in_brevo" },
        { email: "e@x.com", kitSubscriberId: 5, source: "suprimido_aguardando_frio" },
      ],
      { apply: true, frio: frioOn },
      deps,
    );
    assert.deepEqual(panel.map((p) => p.email), ["a@x.com"]);
    assert.equal(r.counts.painel, 1);
    assert.equal(r.counts.descadastro_proprio, 2);
    assert.deepEqual(ops, []);
    assert.equal(findContact(ref.store, "c@x.com")!.status, "in_brevo");
  });
  it("REGRESSÃO P1-6: --apply sem kit.frio plenamente ligado ⇒ exit 2, nenhuma tag", async () => {
    const ops: string[] = [];
    const ref = { store: { contacts: [contact("c@x.com", "kit-sem-abertura:3")] } };
    for (const frio of [parseKitFrio(undefined), parseKitFrio({ frio: { enabled: true, semanal_enabled: true } })]) {
      const r = await runKitSemAberturaRestore([{ email: "c@x.com", kitSubscriberId: 3, source: "in_brevo" }], { apply: true, frio }, restoreDeps(ops, ref, []));
      assert.equal(r.code, 2);
    }
    assert.deepEqual(ops, []);
    // dry-run segue permitido
    const dry = await runKitSemAberturaRestore([{ email: "c@x.com", kitSubscriberId: 3, source: "in_brevo" }], { apply: false, frio: parseKitFrio(undefined) }, restoreDeps(ops, ref, []));
    assert.equal(dry.code, 0);
    assert.deepEqual(ops, []);
  });
});

describe("restore-brevo-semanal-suppressed (#11226)", () => {
  const on = parseBrevoDiariaSemanal({ enabled: true, desde: "2026-11-02" });
  const sup = (email: string, origin: string, opens: number): BrevoDiariaContact => ({
    ...contact(email, origin),
    status: "suppressed",
    resolution_reason: "score_threshold",
    opens_count: opens,
  });
  it("candidatos: suprimido por score com >= 1 abertura (ou ever_opened), fora kit-sem-abertura", () => {
    const got = selectRestoreCandidates([
      sup("a@x.com", "kit:1", 1),
      sup("b@x.com", "kit:2", 0),
      sup("c@x.com", "kit-sem-abertura:3", 4),
      { ...sup("d@x.com", "curated:d", 0), ever_opened: true },
    ]);
    assert.deepEqual(got.map((c) => c.email), ["a@x.com", "d@x.com"]);
  });
  it("descadastro/spam/bounce da pessoa nunca volta; só inactive ou ausente no Kit volta", () => {
    const opened = [{ campaignId: 1 }];
    assert.deepEqual(decideRestore({ brevoFound: true, statistics: { opened }, kitState: null }), { restore: true });
    assert.deepEqual(decideRestore({ brevoFound: true, statistics: { opened }, kitState: "inactive" }), { restore: true });
    assert.equal(decideRestore({ brevoFound: true, statistics: { opened, unsubscriptions: { userUnsubscription: [{}] } }, kitState: null }).restore, false);
    assert.equal(decideRestore({ brevoFound: true, statistics: { opened, complaints: [{}] }, kitState: null }).restore, false);
    assert.equal(decideRestore({ brevoFound: true, statistics: { opened, hardBounces: [{}] }, kitState: null }).restore, false);
    assert.deepEqual(decideRestore({ brevoFound: true, statistics: { opened }, kitState: "active" }), { restore: false, reason: "ativo_no_kit" });
    assert.deepEqual(decideRestore({ brevoFound: true, statistics: { opened }, kitState: "cancelled" }), { restore: false, reason: "saiu_do_kit" });
  });
  it("abertura há mais de 90 dias (fora da estatística da Brevo) conta pelo store", () => {
    assert.deepEqual(decideRestore({ brevoFound: true, statistics: { opened: [] }, openedInStore: true, kitState: null }), { restore: true });
    assert.equal(decideRestore({ brevoFound: true, statistics: { opened: [] }, openedInStore: false, kitState: null }).restore, false);
  });
  function deps(over: Partial<RestoreDeps> = {}, contacts: BrevoDiariaContact[] = []): RestoreDeps {
    return {
      log: () => {},
      readStore: () => ({ contacts }),
      writeStore: () => {},
      getBrevoContact: async () => ({ status: 200, body: { statistics: { opened: [{ campaignId: 1 }] } } }),
      putBrevoContact: async () => {},
      kitStateByEmail: async () => "inactive",
      appendLog: () => {},
      nowIso: () => "x",
      ...over,
    };
  }
  it("--apply sem o regime semanal ligado é recusado (voltariam a receber a diária)", async () => {
    const r = await runRestoreSemanal({ apply: true, listId: 7, semanal: parseBrevoDiariaSemanal(undefined) }, deps());
    assert.equal(r.code, 2);
  });
  it("REGRESSÃO P1-1: --apply recusado enquanto houver kit-sem-abertura: in_brevo (a Brevo segue diária)", async () => {
    let puts = 0;
    const r = await runRestoreSemanal(
      { apply: true, listId: 7, semanal: on },
      deps({ putBrevoContact: async () => void puts++ }, [contact("m@x.com", "kit-sem-abertura:1"), sup("a@x.com", "kit:1", 1)]),
    );
    assert.equal(r.code, 2);
    assert.equal(puts, 0);
  });
  it("origem não-Kit já ATIVA no Kit não volta pra Brevo (canal duplo); 404 na Brevo ⇒ contato_ausente_na_brevo", async () => {
    const r = await runRestoreSemanal(
      { apply: false, listId: 7, semanal: on },
      deps(
        {
          kitStateByEmail: async (e) => (e === "a@x.com" ? "active" : null),
          getBrevoContact: async (e) => (e === "b@x.com" ? { status: 404 } : { status: 200, body: { statistics: { opened: [{ campaignId: 1 }] } } }),
        },
        [sup("a@x.com", "curated:a", 1), sup("b@x.com", "curated:b", 1)],
      ),
    );
    assert.deepEqual(r.skipped, { ativo_no_kit: 1, contato_ausente_na_brevo: 1 });
    assert.equal(r.failed, 0);
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
  it("config semanal inválida ⇒ failed (não skipped), antes de qualquer passo", () => {
    const calls: string[] = [];
    const d = deps("261102", calls);
    const r = runStage5BrevoDispatch("/fake/data/editions/2611/261102", {
      ...d,
      readPlatformConfig: () => ({ brevo_diaria: { stage5_target_total: 290, semanal: { enabled: true, desde: "2026-11-03" } } }),
    });
    assert.equal(r.status, "failed");
    assert.deepEqual(calls, []);
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
