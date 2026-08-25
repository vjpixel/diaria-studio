/**
 * test/brevo-account-quota-6146.test.ts (#6146)
 *
 * Regressão do incidente 260825: a campanha diária foi criada e agendada
 * normalmente e a Brevo a marcou `suspended` no horário, porque o backlog
 * transacional do #6042 já tinha consumido os 300 e-mails/dia do plano free.
 * Nenhum guard do repo olhava a cota da CONTA — só o tamanho da LISTA.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import {
  BREVO_FREE_DAILY_SEND_LIMIT,
  checkAccountSendQuota,
  describeQuotaWarnings,
  toStatsDay,
} from "../scripts/lib/brevo-account-quota.ts";
import {
  emptyRolloutGuardrailState,
  selectUnalarmedSuspended,
  readRolloutGuardrailState,
  writeRolloutGuardrailState,
} from "../scripts/lib/brevo-diaria-guardrail.ts";
import { scheduleDailyBrevo } from "../scripts/schedule-daily-brevo.ts";
import { readBrevoDiariaPublished } from "../scripts/publish-daily-brevo.ts";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

describe("checkAccountSendQuota (#6146)", () => {
  it("reprova o cenário EXATO de 260825: 300 transacionais já consumidos, campanha de 140", () => {
    const r = checkAccountSendQuota({
      dailyLimit: BREVO_FREE_DAILY_SEND_LIMIT,
      transactionalRequestsToday: 300,
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
      transactionalRequestsToday: 0,
      recipients: 140,
    });
    assert.equal(r.ok, true);
    assert.equal(r.available, 300);
    assert.equal(r.consumed, 0);
  });

  it("aprova no limite exato (recipients === available) — não é off-by-one", () => {
    const r = checkAccountSendQuota({
      dailyLimit: 300,
      transactionalRequestsToday: 160,
      recipients: 140,
    });
    assert.equal(r.ok, true);
  });

  it("reprova 1 acima do limite exato", () => {
    const r = checkAccountSendQuota({
      dailyLimit: 300,
      transactionalRequestsToday: 160,
      recipients: 141,
    });
    assert.equal(r.ok, false);
  });

  it("consumo acima do teto não vira `available` negativo (que passaria trivialmente)", () => {
    const r = checkAccountSendQuota({
      dailyLimit: 300,
      transactionalRequestsToday: 585, // o mass-send do #6042, inteiro
      recipients: 1,
    });
    assert.equal(r.ok, false);
    assert.equal(r.available, 0);
  });

  it("leitura corrompida é hard-stop, nunca permissão de envio", () => {
    for (const bad of [NaN, -1, Infinity]) {
      const r = checkAccountSendQuota({
        dailyLimit: 300,
        transactionalRequestsToday: bad,
        recipients: 140,
      });
      assert.equal(r.ok, false, `${bad} deveria reprovar`);
      assert.match(r.ok === false ? r.reason : "", /corrompida|inválido/);
    }
  });
});

describe("describeQuotaWarnings (#6146)", () => {
  it("avisa sobre plano free com credits 0, sem bloquear", () => {
    const w = describeQuotaWarnings({
      transactionalRequestsToday: 0,
      planType: "free",
      planSendCredits: 0,
    });
    assert.equal(w.length, 1);
    assert.match(w[0], /credits: 0/);
  });

  it("cala num plano pago com créditos", () => {
    const w = describeQuotaWarnings({
      transactionalRequestsToday: 0,
      planType: "subscription",
      planSendCredits: 38212,
    });
    assert.deepEqual(w, []);
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
    const dir = mkdtempSync(resolve(tmpdir(), "brevo-guardrail-6146-"));
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
    const dir = mkdtempSync(resolve(tmpdir(), "brevo-guardrail-6146-rt-"));
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
  const dir = mkdtempSync(resolve(tmpdir(), "edicao-6146-"));
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

function depsWith(overrides: Partial<Parameters<typeof scheduleDailyBrevo>[2]> = {}) {
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
    }) as never);

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
    }) as never);

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
    const r = await scheduleDailyBrevo(dir, "2026-08-26T09:00:00.000Z", depsWith({ putSchedule }) as never);
    assert.equal(r.ok, true);
    assert.equal(putSchedule.mock.callCount(), 1);
  });

  it("campanha JÁ agendada não é reprovada por cota (compromisso imutável já feito)", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "edicao-6146-sched-"));
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
    const r = await scheduleDailyBrevo(dir, "2026-08-26T09:00:00.000Z", depsWith({ checkQuota }) as never);
    assert.equal(r.ok, true);
    assert.equal(r.ok === true ? r.alreadyScheduled : false, true);
    assert.equal(checkQuota.mock.callCount(), 0, "idempotência vem antes da cota");
  });
});
