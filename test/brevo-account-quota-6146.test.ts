/**
 * test/brevo-account-quota-6146.test.ts (#6146)
 *
 * Regressão do incidente 260825: a campanha diária foi criada e agendada
 * normalmente e a Brevo a marcou `suspended` no horário, porque o backlog
 * transacional do #6042 já tinha consumido os 300 e-mails/dia do plano free.
 * Nenhum guard do repo olhava a cota da CONTA — só o tamanho da LISTA.
 */
import { describe, it, mock, after } from "node:test";
import assert from "node:assert/strict";

import {
  BREVO_FREE_DAILY_SEND_LIMIT,
  checkAccountSendQuota,
  describeQuotaWarnings,
  toStatsDay,
  fetchTransactionalRequests,
  fetchAccountQuotaSnapshot,
} from "../scripts/lib/brevo-account-quota.ts";
import {
  emptyRolloutGuardrailState,
  selectUnalarmedSuspended,
  readRolloutGuardrailState,
  writeRolloutGuardrailState,
} from "../scripts/lib/brevo-diaria-guardrail.ts";
import { scheduleDailyBrevo, type ScheduleDailyBrevoDeps } from "../scripts/schedule-daily-brevo.ts";
import { readBrevoDiariaPublished } from "../scripts/publish-daily-brevo.ts";
import {
  handleSuspendedCampaigns,
  type SuspendedCampaignsDeps,
} from "../scripts/check-brevo-diaria-guardrail.ts";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/** Convenção do test/brevo-diaria-guardrail-4476.test.ts: nenhum tmpdir
 * sobrevive à rodada. Registrado aqui e limpo no `after` global. */
const TMP_DIRS: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(resolve(tmpdir(), prefix));
  TMP_DIRS.push(d);
  return d;
}
after(() => {
  for (const d of TMP_DIRS) rmSync(d, { recursive: true, force: true });
});

describe("checkAccountSendQuota (#6146)", () => {
  it("reprova o cenário EXATO de 260825: 300 transacionais já consumidos, campanha de 140", () => {
    const r = checkAccountSendQuota({
      dailyLimit: BREVO_FREE_DAILY_SEND_LIMIT,
      transactionalRequestsOnSendDay: 300,
      recipients: 140,
    });
    assert.equal(r.ok, false);
    assert.equal(r.available, 0);
    assert.match(r.ok === false ? r.reason : "", /cota da CONTA Brevo esgotada/);
    // O operador precisa ver os 3 números, não só "deu ruim".
    assert.match(r.ok === false ? r.reason : "", /300/);
    assert.match(r.ok === false ? r.reason : "", /140/);
  });

  it("aprova o dia normal: zero transacional, campanha de 140 em 300", () => {
    const r = checkAccountSendQuota({
      dailyLimit: BREVO_FREE_DAILY_SEND_LIMIT,
      transactionalRequestsOnSendDay: 0,
      recipients: 140,
    });
    assert.equal(r.ok, true);
    assert.equal(r.available, 300);
    assert.equal(r.consumed, 0);
  });

  it("aprova no limite exato (recipients === available) — não é off-by-one", () => {
    const r = checkAccountSendQuota({
      dailyLimit: 300,
      transactionalRequestsOnSendDay: 160,
      recipients: 140,
    });
    assert.equal(r.ok, true);
  });

  it("reprova 1 acima do limite exato", () => {
    const r = checkAccountSendQuota({
      dailyLimit: 300,
      transactionalRequestsOnSendDay: 160,
      recipients: 141,
    });
    assert.equal(r.ok, false);
  });

  it("consumo acima do teto não vira `available` negativo (que passaria trivialmente)", () => {
    const r = checkAccountSendQuota({
      dailyLimit: 300,
      transactionalRequestsOnSendDay: 585, // o mass-send do #6042, inteiro
      recipients: 1,
    });
    assert.equal(r.ok, false);
    assert.equal(r.available, 0);
  });

  it("leitura corrompida é hard-stop, nunca permissão de envio", () => {
    for (const bad of [NaN, -1, Infinity]) {
      const r = checkAccountSendQuota({
        dailyLimit: 300,
        transactionalRequestsOnSendDay: bad,
        recipients: 140,
      });
      assert.equal(r.ok, false, `${bad} deveria reprovar`);
      assert.match(r.ok === false ? r.reason : "", /corrompida|inválido/);
    }
  });
});

describe("describeQuotaWarnings (#6146)", () => {
  const sameDay = {
    sendDay: "2026-08-25",
    sendDayIsFuture: false,
    transactionalRequestsOnSendDay: 0,
    transactionalRequestsToday: null,
  };

  it("avisa sobre plano free com credits 0, sem bloquear", () => {
    const w = describeQuotaWarnings({ ...sameDay, planType: "free", planSendCredits: 0 }, 300);
    assert.equal(w.length, 1);
    assert.match(w[0], /credits: 0/);
  });

  it("cala num plano pago com créditos, quando o envio é hoje", () => {
    const w = describeQuotaWarnings({ ...sameDay, planType: "subscription", planSendCredits: 38212 }, 300);
    assert.deepEqual(w, []);
  });

  it("envio em dia UTC futuro: avisa que a checagem é limite inferior", () => {
    const w = describeQuotaWarnings(
      {
        sendDay: "2026-08-26",
        sendDayIsFuture: true,
        transactionalRequestsOnSendDay: 0,
        transactionalRequestsToday: 10,
        planType: "subscription",
        planSendCredits: 999,
      },
      300,
    );
    assert.equal(w.length, 1);
    assert.match(w[0], /ainda não começou/);
  });

  it("transbordo: hoje no teto + envio amanhã → avisa que a fila pode comer o balde do envio", () => {
    // O mecanismo EXATO de 260825: 24/08 estoura, a Brevo drena em 25/08.
    const w = describeQuotaWarnings(
      {
        sendDay: "2026-08-25",
        sendDayIsFuture: true,
        transactionalRequestsOnSendDay: 0,
        transactionalRequestsToday: 585,
        planType: "free",
        planSendCredits: 0,
      },
      300,
    );
    assert.equal(w.length, 3, "limite inferior + transbordo + credits 0");
    assert.ok(w.some((x) => /TRANSBORDO PROVÁVEL/.test(x)));
    assert.ok(w.some((x) => /585/.test(x)));
  });

  it("hoje abaixo do teto com envio amanhã: avisa limite inferior, mas NÃO transbordo", () => {
    const w = describeQuotaWarnings(
      {
        sendDay: "2026-08-26",
        sendDayIsFuture: true,
        transactionalRequestsOnSendDay: 0,
        transactionalRequestsToday: 299,
        planType: "subscription",
        planSendCredits: 999,
      },
      300,
    );
    assert.equal(w.length, 1);
    assert.ok(!w.some((x) => /TRANSBORDO/.test(x)));
  });
});

describe("toStatsDay (#6146)", () => {
  it("formata YYYY-MM-DD em UTC", () => {
    assert.equal(toStatsDay(new Date("2026-08-25T01:26:44.000Z")), "2026-08-25");
  });
});

describe("selectUnalarmedSuspended (#6146)", () => {
  it("na 1ª vez todas são novas; na 2ª, nenhuma (dedup a cada 4h)", () => {
    const s0 = emptyRolloutGuardrailState();
    const first = selectUnalarmedSuspended(s0, [29]);
    assert.deepEqual(first.fresh, [29]);

    const second = selectUnalarmedSuspended(first.next, [29]);
    assert.deepEqual(second.fresh, [], "campanha suspensa fica suspensa pra sempre — não realarmar");
  });

  it("uma campanha suspensa NOVA alarma mesmo com outra já conhecida", () => {
    const s0 = { ...emptyRolloutGuardrailState(), alarmed_suspended_campaign_ids: [29] };
    const r = selectUnalarmedSuspended(s0, [30, 29]);
    assert.deepEqual(r.fresh, [30]);
  });

  it("não muda o latch rollout_paused — suspensão é cota, não entregabilidade", () => {
    const s0 = { ...emptyRolloutGuardrailState(), rollout_paused: false };
    const r = selectUnalarmedSuspended(s0, [29]);
    assert.equal(r.next.rollout_paused, false);
  });
});

describe("estado do guardrail: campo novo é retrocompatível (#6146)", () => {
  it("estado gravado ANTES do campo existir lê como lista vazia, sem lançar", () => {
    const dir = tmp("brevo-guardrail-6146-");
    const path = resolve(dir, "guardrail-state.json");
    // Shape real de data/brevo-diaria/guardrail-state.json em 25/08/2026.
    writeFileSync(
      path,
      JSON.stringify({
        rollout_paused: false,
        paused_at: null,
        paused_reason: null,
        last_checked_at: "2026-08-25T15:00:28.242Z",
        last_campaign_count: 17,
        unpaused_at: null,
      }),
    );
    const state = readRolloutGuardrailState(path);
    assert.deepEqual(state.alarmed_suspended_campaign_ids, []);
    assert.equal(state.last_campaign_count, 17, "campos preexistentes preservados");
  });

  it("round-trip preserva os ids alarmados", () => {
    const dir = tmp("brevo-guardrail-6146-rt-");
    const path = resolve(dir, "guardrail-state.json");
    writeRolloutGuardrailState(
      { ...emptyRolloutGuardrailState(), alarmed_suspended_campaign_ids: [29, 30] },
      path,
    );
    assert.deepEqual(readRolloutGuardrailState(path).alarmed_suspended_campaign_ids, [29, 30]);
  });
});

// ── Etapa 6: o agendamento recusa comprometer uma campanha sem cota ────────

function editionDirWithDraft(campaignId = 29, listId = 7): string {
  const dir = tmp("edicao-6146-");
  mkdirSync(resolve(dir, "_internal"), { recursive: true });
  writeFileSync(
    resolve(dir, "_internal", "brevo-diaria-published.json"),
    JSON.stringify({
      campaign_id: campaignId,
      subject: "Brasil investe R$ 2,3 bi em infraestrutura de IA",
      preview_text: "…",
      status: "draft",
      list_id: listId,
      created_at: "2026-08-25T02:37:28.679Z",
    }),
  );
  return dir;
}

function depsWith(overrides: Partial<ScheduleDailyBrevoDeps> = {}): ScheduleDailyBrevoDeps {
  return {
    // leitor REAL de propósito: se o shape do state file mudar, este teste
    // quebra junto — é o mesmo caminho que a Etapa 6 usa em produção.
    readPublished: readBrevoDiariaPublished,
    writePublished: () => {},
    putSchedule: mock.fn(async () => ({})),
    getCampaign: mock.fn(async () => ({ status: "queued", scheduledAt: "2026-08-26T06:00:00.000-03:00" })),
    checkQuota: async () => ({
      check: { ok: true as const, consumed: 0, available: 300 },
      warnings: [],
    }),
    ...overrides,
  };
}

describe("scheduleDailyBrevo × cota da conta (#6146)", () => {
  it("NÃO faz o PUT quando a cota do dia não cobre a campanha", async () => {
    const dir = editionDirWithDraft();
    const putSchedule = mock.fn(async () => ({}));
    const r = await scheduleDailyBrevo(dir, "2026-08-26T09:00:00.000Z", depsWith({
      putSchedule,
      checkQuota: async () => ({
        check: {
          ok: false as const,
          consumed: 300,
          available: 0,
          reason: "cota da CONTA Brevo esgotada para hoje: …",
        },
        warnings: [],
      }),
    }));

    assert.equal(r.ok, false);
    assert.equal(r.ok === false ? r.code : null, 5);
    assert.equal(putSchedule.mock.callCount(), 0, "o PUT é o ponto de não-retorno — não pode acontecer");
  });

  it("cota ilegível também bloqueia (nunca vira permissão)", async () => {
    const dir = editionDirWithDraft();
    const putSchedule = mock.fn(async () => ({}));
    const r = await scheduleDailyBrevo(dir, "2026-08-26T09:00:00.000Z", depsWith({
      putSchedule,
      checkQuota: async () => {
        throw new Error("Brevo GET /smtp/statistics/aggregatedReport HTTP 429");
      },
    }));

    assert.equal(r.ok, false);
    assert.equal(r.ok === false ? r.code : null, 5);
    assert.match(r.ok === false ? r.reason : "", /429/);
    assert.equal(putSchedule.mock.callCount(), 0);
  });

  it("com cota sobrando, agenda normalmente", async () => {
    const dir = editionDirWithDraft();
    const putSchedule = mock.fn(async () => ({}));
    // O `getCampaign` mockado devolve `-03:00`; o PUT manda `Z`. Mesmo
    // instante, formatos diferentes — o #5851 já cobre essa comparação.
    const r = await scheduleDailyBrevo(dir, "2026-08-26T09:00:00.000Z", depsWith({ putSchedule }));
    assert.equal(r.ok, true);
    assert.equal(putSchedule.mock.callCount(), 1);
  });

  it("campanha JÁ agendada não é reprovada por cota (compromisso imutável já feito)", async () => {
    const dir = tmp("edicao-6146-sched-");
    mkdirSync(resolve(dir, "_internal"), { recursive: true });
    writeFileSync(
      resolve(dir, "_internal", "brevo-diaria-published.json"),
      JSON.stringify({
        campaign_id: 29,
        subject: "s",
        preview_text: "p",
        status: "scheduled",
        list_id: 7,
        scheduled_at: "2026-08-26T06:00:00.000-03:00",
        created_at: "2026-08-25T02:37:28.679Z",
      }),
    );
    const checkQuota = mock.fn(async () => ({
      check: { ok: false as const, consumed: 300, available: 0, reason: "esgotada" },
      warnings: [],
    }));
    const r = await scheduleDailyBrevo(dir, "2026-08-26T09:00:00.000Z", depsWith({ checkQuota }));
    assert.equal(r.ok, true);
    assert.equal(r.ok === true ? r.alreadyScheduled : false, true);
    assert.equal(checkQuota.mock.callCount(), 0, "idempotência vem antes da cota");
  });
});

// ── A regressão do dia consultado (achado do review da #6147) ─────────────
//
// A 1ª versão do guard consultava `toStatsDay(new Date())` — o dia em que o
// script RODA. Mas a cota da Brevo zera por dia UTC, e a Etapa 6 às vezes
// roda antes da virada (campanha 27: criada 20/08 23:57 UTC pra enviar 21/08
// 09:00 UTC). Consultar "hoje" ali media um balde que não é o que despacha a
// campanha — o guard parecia proteger e não protegia.

describe("scheduleDailyBrevo consulta o dia do ENVIO, não o de hoje (#6146)", () => {
  it("passa pro checkQuota o dia UTC derivado de scheduledAt", async () => {
    const dir = editionDirWithDraft();
    const seen: string[] = [];
    await scheduleDailyBrevo(dir, "2026-08-26T09:00:00.000Z", depsWith({
      checkQuota: async (_listId, sendDay) => {
        seen.push(sendDay);
        return { check: { ok: true as const, consumed: 0, available: 300 }, warnings: [] };
      },
    }));
    assert.deepEqual(seen, ["2026-08-26"]);
  });

  it("agendamento à noite BRT (já no dia UTC seguinte) usa o dia do envio, não o da véspera", async () => {
    // Cenário real da campanha 27: PUT em 20/08 23:57 UTC, envio 21/08 09:00 UTC.
    const dir = editionDirWithDraft();
    const seen: string[] = [];
    await scheduleDailyBrevo(dir, "2026-08-21T09:00:00.000Z", depsWith({
      getCampaign: async () => ({ status: "queued", scheduledAt: "2026-08-21T09:00:00.000Z" }),
      checkQuota: async (_listId, sendDay) => {
        seen.push(sendDay);
        return { check: { ok: true as const, consumed: 0, available: 300 }, warnings: [] };
      },
    }));
    assert.deepEqual(seen, ["2026-08-21"], "nunca 2026-08-20");
  });

  it("recebe o list_id do state file, não um hardcode", async () => {
    const dir = editionDirWithDraft(29, 7);
    const seen: number[] = [];
    await scheduleDailyBrevo(dir, "2026-08-26T09:00:00.000Z", depsWith({
      checkQuota: async (listId, _sendDay) => {
        seen.push(listId);
        return { check: { ok: true as const, consumed: 0, available: 300 }, warnings: [] };
      },
    }));
    assert.deepEqual(seen, [7]);
  });
});

// ── I/O: leitura ilegível nunca vira "zero consumido" ─────────────────────

describe("fetchTransactionalRequests / fetchAccountQuotaSnapshot (#6146)", () => {
  const realFetch = globalThis.fetch;
  function route(handler: (url: URL) => { status: number; body: unknown }) {
    globalThis.fetch = (async (input: string | URL) => {
      const url = new URL(String(input));
      const { status, body } = handler(url);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }
  after(() => {
    globalThis.fetch = realFetch;
  });

  it("lê `requests` do dia pedido", async () => {
    route((url) => {
      assert.equal(url.searchParams.get("startDate"), "2026-08-25");
      assert.equal(url.searchParams.get("endDate"), "2026-08-25");
      return { status: 200, body: { requests: 300 } };
    });
    assert.equal(await fetchTransactionalRequests("k", "2026-08-25"), 300);
  });

  it("resposta sem `requests` LANÇA — nunca devolve 0 (que viraria '300 disponíveis')", async () => {
    route(() => ({ status: 200, body: {} }));
    await assert.rejects(
      () => fetchTransactionalRequests("k", "2026-08-25"),
      /cota da conta ilegível/,
    );
  });

  it("`requests` não numérico LANÇA", async () => {
    route(() => ({ status: 200, body: { requests: "300" } }));
    await assert.rejects(() => fetchTransactionalRequests("k", "2026-08-25"), /ilegível/);
  });

  it("snapshot com envio HOJE não consulta um 2º dia e deixa transactionalRequestsToday null", async () => {
    const days: string[] = [];
    route((url) => {
      if (url.pathname.endsWith("/aggregatedReport")) {
        days.push(url.searchParams.get("startDate")!);
        return { status: 200, body: { requests: 42 } };
      }
      return { status: 200, body: { plan: [{ type: "free", credits: 0, creditsType: "sendLimit" }] } };
    });
    const snap = await fetchAccountQuotaSnapshot("k", "2026-08-25", "2026-08-25");
    assert.deepEqual(days, ["2026-08-25"]);
    assert.equal(snap.transactionalRequestsOnSendDay, 42);
    assert.equal(snap.transactionalRequestsToday, null);
    assert.equal(snap.planType, "free");
  });

  it("REGRESSÃO: dia de envio FUTURO nunca é consultado — a Brevo devolve 400 pra data futura", async () => {
    // Medido ao vivo em 25/08/2026: `startDate=2026-08-26` →
    // 400 {"code":"invalid_parameter","message":"Start/End date should not be
    // greater than current date"}. Consultar o sendDay cegamente fazia o
    // checkQuota lançar e a Etapa 6 recusar TODO agendamento feito na véspera.
    const days: string[] = [];
    route((url) => {
      if (url.pathname.endsWith("/aggregatedReport")) {
        const d = url.searchParams.get("startDate")!;
        days.push(d);
        if (d > "2026-08-25") {
          return {
            status: 400,
            body: { code: "invalid_parameter", message: "Start/End date should not be greater than current date" },
          };
        }
        return { status: 200, body: { requests: 585 } };
      }
      return { status: 200, body: { plan: [] } };
    });
    const snap = await fetchAccountQuotaSnapshot("k", "2026-08-26", "2026-08-25");
    assert.deepEqual(days, ["2026-08-25"], "só o dia de hoje pode ser consultado");
    assert.equal(snap.sendDayIsFuture, true);
    assert.equal(snap.transactionalRequestsOnSendDay, 0, "balde do dia futuro está intacto por definição");
    assert.equal(snap.transactionalRequestsToday, 585, "hoje é lido, pro aviso de transbordo");
  });

  it("dia futuro passa no gate — e o aviso deixa explícito que não é verificação", async () => {
    route((url) =>
      url.pathname.endsWith("/aggregatedReport")
        ? { status: 200, body: { requests: 585 } }
        : { status: 200, body: { plan: [] } },
    );
    const snap = await fetchAccountQuotaSnapshot("k", "2026-08-26", "2026-08-25");
    const r = checkAccountSendQuota({
      dailyLimit: 300,
      transactionalRequestsOnSendDay: snap.transactionalRequestsOnSendDay,
      recipients: 140,
    });
    assert.equal(r.ok, true, "não pode bloquear o agendamento da véspera");
    const w = describeQuotaWarnings(snap, 300);
    assert.ok(w.some((x) => /ainda não começou/.test(x)));
    assert.ok(w.some((x) => /TRANSBORDO PROVÁVEL/.test(x)));
  });

  it("falha do GET /account não derruba o snapshot (best-effort), mas o gate segue legível", async () => {
    route((url) => {
      if (url.pathname.endsWith("/aggregatedReport")) return { status: 200, body: { requests: 7 } };
      return { status: 403, body: { message: "forbidden" } };
    });
    const snap = await fetchAccountQuotaSnapshot("k", "2026-08-25", "2026-08-25");
    assert.equal(snap.transactionalRequestsOnSendDay, 7, "o dado do GATE sobreviveu");
    assert.equal(snap.planType, null);
    assert.equal(snap.planSendCredits, null);
  });

  it("falha do dia do ENVIO propaga (é o dado do gate, não best-effort)", async () => {
    route((url) => {
      if (url.pathname.endsWith("/aggregatedReport")) return { status: 403, body: { message: "forbidden" } };
      return { status: 200, body: { plan: [] } };
    });
    await assert.rejects(() => fetchAccountQuotaSnapshot("k", "2026-08-25", "2026-08-25"));
  });
});

// ── O alarme de campanha suspensa: a ordem É o comportamento ──────────────

describe("handleSuspendedCampaigns (#6146)", () => {
  function deps(over: Partial<SuspendedCampaignsDeps> = {}): SuspendedCampaignsDeps {
    return {
      fetchSuspended: async () => [{ id: 29, name: "diar.ia.br diária", scheduledAt: "2026-08-25T06:00:00-03:00" }],
      readState: () => emptyRolloutGuardrailState(),
      writeState: () => {},
      alarm: async () => {},
      isDryRun: false,
      log: () => {},
      ...over,
    };
  }

  it("nenhuma suspensa: não lê estado, não alarma", async () => {
    const alarm = mock.fn(async () => {});
    const readState = mock.fn(() => emptyRolloutGuardrailState());
    await handleSuspendedCampaigns(deps({ fetchSuspended: async () => [], alarm, readState }));
    assert.equal(alarm.mock.callCount(), 0);
    assert.equal(readState.mock.callCount(), 0);
  });

  it("suspensa nova: alarma e SÓ ENTÃO persiste o dedup", async () => {
    const order: string[] = [];
    let persisted: number[] | null = null;
    await handleSuspendedCampaigns(deps({
      alarm: async () => { order.push("alarm"); },
      writeState: (st) => { order.push("write"); persisted = st.alarmed_suspended_campaign_ids; },
    }));
    assert.deepEqual(order, ["alarm", "write"], "persistir antes do e-mail perderia o alarme");
    assert.deepEqual(persisted, [29]);
  });

  it("e-mail falhou: NÃO persiste — a próxima rodada tenta de novo", async () => {
    const writeState = mock.fn(() => {});
    const logs: string[] = [];
    await handleSuspendedCampaigns(deps({
      alarm: async () => { throw new Error("gmail 401"); },
      writeState,
      log: (m) => logs.push(m),
    }));
    assert.equal(writeState.mock.callCount(), 0, "gravar aqui marcaria o id como alarmado pra sempre");
    assert.ok(logs.some((l) => /falha ao alarmar/.test(l) && /gmail 401/.test(l)));
  });

  it("id já alarmado: não reenvia e-mail (dedup das rodadas de 4h)", async () => {
    const alarm = mock.fn(async () => {});
    await handleSuspendedCampaigns(deps({
      readState: () => ({ ...emptyRolloutGuardrailState(), alarmed_suspended_campaign_ids: [29] }),
      alarm,
    }));
    assert.equal(alarm.mock.callCount(), 0);
  });

  it("--dry-run: não alarma nem persiste", async () => {
    const alarm = mock.fn(async () => {});
    const writeState = mock.fn(() => {});
    await handleSuspendedCampaigns(deps({ isDryRun: true, alarm, writeState }));
    assert.equal(alarm.mock.callCount(), 0);
    assert.equal(writeState.mock.callCount(), 0);
  });

  it("falha ao LISTAR suspensas propaga — nunca vira 'nada suspenso'", async () => {
    await assert.rejects(
      () => handleSuspendedCampaigns(deps({
        fetchSuspended: async () => { throw new Error("campanhas suspensas ilegível"); },
      })),
      /ilegível/,
    );
  });
});
