/**
 * test/schedule-daily-brevo-5772.test.ts (#5772)
 *
 * Cobre `scripts/schedule-daily-brevo.ts` — agendamento da campanha Brevo
 * diária no Stage 6 (mesma divisão 5/6 do Beehiiv: rascunho na 5,
 * agendamento na 6). `putSchedule`/`getCampaign`/`readPublished`/
 * `writePublished` injetados — nenhuma chamada de rede/I/O real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scheduleDailyBrevo, type ScheduleDailyBrevoDeps } from "../scripts/schedule-daily-brevo.ts";
import type { BrevoDiariaPublished } from "../scripts/publish-daily-brevo.ts";

const EDITION_DIR = "/fake/root/data/editions/2608/260820";
const SCHEDULED_AT = "2026-08-21T09:00:00.000Z";

function draftState(overrides: Partial<BrevoDiariaPublished> = {}): BrevoDiariaPublished {
  return {
    campaign_id: 42,
    subject: "Assunto da edição",
    preview_text: "Preview",
    status: "draft",
    list_id: 7,
    created_at: "2026-08-20T12:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ScheduleDailyBrevoDeps> = {}): ScheduleDailyBrevoDeps {
  return {
    readPublished: overrides.readPublished ?? (() => draftState()),
    writePublished: overrides.writePublished ?? (() => {}),
    putSchedule: overrides.putSchedule ?? (async () => ({})),
    getCampaign: overrides.getCampaign ?? (async () => ({ status: "queued", scheduledAt: SCHEDULED_AT })),
  };
}

describe("scheduleDailyBrevo (#5772)", () => {
  it("campanha ausente (Etapa 5 pulou/falhou, ou --skip brevo) → code 2, nunca chama PUT/GET", async () => {
    let putCalled = false;
    let getCalled = false;
    const deps = makeDeps({
      readPublished: () => null,
      putSchedule: async () => {
        putCalled = true;
        return {};
      },
      getCampaign: async () => {
        getCalled = true;
        return { status: "queued" };
      },
    });
    const result = await scheduleDailyBrevo(EDITION_DIR, SCHEDULED_AT, deps);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 2);
    assert.equal(putCalled, false);
    assert.equal(getCalled, false);
  });

  it("campanha sem campaign_id numérico → code 2", async () => {
    const deps = makeDeps({ readPublished: () => draftState({ campaign_id: undefined as unknown as number }) });
    const result = await scheduleDailyBrevo(EDITION_DIR, SCHEDULED_AT, deps);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 2);
  });

  it("PUT falha → code 3, mensagem inclui o motivo", async () => {
    const deps = makeDeps({
      putSchedule: async () => {
        throw new Error("Brevo API PUT /emailCampaigns/42 falhou (400): bad request");
      },
    });
    const result = await scheduleDailyBrevo(EDITION_DIR, SCHEDULED_AT, deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 3);
      assert.match(result.reason, /400/);
    }
  });

  it("GET pós-PUT falha (rede) → code 4", async () => {
    const deps = makeDeps({
      getCampaign: async () => {
        throw new Error("timeout");
      },
    });
    const result = await scheduleDailyBrevo(EDITION_DIR, SCHEDULED_AT, deps);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 4);
  });

  it("GET pós-PUT não confirma o scheduledAt esperado → code 4 (nunca reporta sucesso a partir só do PUT)", async () => {
    const deps = makeDeps({ getCampaign: async () => ({ status: "draft", scheduledAt: null }) });
    const result = await scheduleDailyBrevo(EDITION_DIR, SCHEDULED_AT, deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 4);
      assert.match(result.reason, /não confirma/);
    }
  });

  it("PUT + GET confirmam → ok com campaignId/scheduledAt/status", async () => {
    const deps = makeDeps();
    const result = await scheduleDailyBrevo(EDITION_DIR, SCHEDULED_AT, deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.campaignId, 42);
      assert.equal(result.scheduledAt, SCHEDULED_AT);
      assert.equal(result.status, "queued");
    }
  });

  it("putSchedule é chamado com campaignId + scheduledAt corretos", async () => {
    let calledWith: [number, string] | null = null;
    const deps = makeDeps({
      putSchedule: async (campaignId, scheduledAt) => {
        calledWith = [campaignId, scheduledAt];
        return {};
      },
    });
    await scheduleDailyBrevo(EDITION_DIR, SCHEDULED_AT, deps);
    assert.deepEqual(calledWith, [42, SCHEDULED_AT]);
  });

  it("sucesso → persiste status 'scheduled' + scheduled_at, preservando o resto do estado (#5772)", async () => {
    let written: BrevoDiariaPublished | null = null;
    const deps = makeDeps({
      readPublished: () => draftState({ subject: "Assunto original" }),
      writePublished: (_editionDir, state) => {
        written = state;
      },
    });
    await scheduleDailyBrevo(EDITION_DIR, SCHEDULED_AT, deps);
    assert.ok(written);
    assert.equal((written as unknown as BrevoDiariaPublished).status, "scheduled");
    assert.equal((written as unknown as BrevoDiariaPublished).scheduled_at, SCHEDULED_AT);
    assert.equal((written as unknown as BrevoDiariaPublished).subject, "Assunto original");
    assert.equal((written as unknown as BrevoDiariaPublished).campaign_id, 42);
  });

  it("falha (GET não confirma) → NUNCA persiste estado 'scheduled'", async () => {
    let writeCalled = false;
    const deps = makeDeps({
      getCampaign: async () => ({ status: "draft", scheduledAt: null }),
      writePublished: () => {
        writeCalled = true;
      },
    });
    await scheduleDailyBrevo(EDITION_DIR, SCHEDULED_AT, deps);
    assert.equal(writeCalled, false);
  });
});
