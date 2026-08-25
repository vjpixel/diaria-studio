/**
 * test/schedule-newsletter-kit.test.ts (#464)
 *
 * Cobre `scripts/schedule-newsletter-kit.ts` — agendamento do broadcast
 * Kit de PRODUÇÃO no Stage 6 (mesma divisão 5/6 do Beehiiv/Brevo: rascunho
 * na 5, agendamento na 6). `patchSchedule`/`getBroadcastStatus`/
 * `readPublished`/`writePublished` injetados — nenhuma chamada de rede/I/O
 * real. Mesmo padrão de `test/schedule-daily-brevo-5772.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scheduleNewsletterKit, type ScheduleNewsletterKitDeps } from "../scripts/schedule-newsletter-kit.ts";
import type { KitNewsletterPublished } from "../scripts/publish-newsletter-kit.ts";

const EDITION_DIR = "/fake/root/data/editions/2608/260825";
const SCHEDULED_AT = "2026-08-26T09:00:00.000Z";

function draftState(overrides: Partial<KitNewsletterPublished> = {}): KitNewsletterPublished {
  return {
    broadcast_id: 42,
    subject: "Assunto da edição",
    preview_text: "Preview",
    status: "draft",
    test_broadcast_ids: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ScheduleNewsletterKitDeps> = {}): ScheduleNewsletterKitDeps {
  return {
    readPublished: overrides.readPublished ?? (() => draftState()),
    writePublished: overrides.writePublished ?? (() => {}),
    patchSchedule: overrides.patchSchedule ?? (async () => ({})),
    getBroadcastStatus: overrides.getBroadcastStatus ?? (async () => ({ status: "scheduled", sendAt: SCHEDULED_AT })),
  };
}

describe("scheduleNewsletterKit (#464)", () => {
  it("draft ausente (Etapa 5 não rodou o publisher Kit) → code 3, nunca chama PATCH/GET", async () => {
    let patchCalled = false;
    let getCalled = false;
    const deps = makeDeps({
      readPublished: () => null,
      patchSchedule: async () => {
        patchCalled = true;
        return {};
      },
      getBroadcastStatus: async () => {
        getCalled = true;
        return { status: "scheduled", sendAt: null };
      },
    });
    const result = await scheduleNewsletterKit(EDITION_DIR, SCHEDULED_AT, deps);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 3);
    assert.equal(patchCalled, false);
    assert.equal(getCalled, false);
  });

  it("draft sem broadcast_id numérico → code 3", async () => {
    const deps = makeDeps({ readPublished: () => draftState({ broadcast_id: undefined as unknown as number }) });
    const result = await scheduleNewsletterKit(EDITION_DIR, SCHEDULED_AT, deps);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 3);
  });

  it("PATCH falha → code 4, mensagem inclui o motivo", async () => {
    const deps = makeDeps({
      patchSchedule: async () => {
        throw new Error("Kit API PATCH /broadcasts/42 falhou (422): Broadcast has already been sent.");
      },
    });
    const result = await scheduleNewsletterKit(EDITION_DIR, SCHEDULED_AT, deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 4);
      assert.match(result.reason, /422/);
    }
  });

  it("GET pós-PATCH falha (rede) → code 5", async () => {
    const deps = makeDeps({
      getBroadcastStatus: async () => {
        throw new Error("timeout");
      },
    });
    const result = await scheduleNewsletterKit(EDITION_DIR, SCHEDULED_AT, deps);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 5);
  });

  it("GET pós-PATCH não confirma o send_at esperado → code 5 (nunca reporta sucesso a partir só do PATCH)", async () => {
    const deps = makeDeps({ getBroadcastStatus: async () => ({ status: "draft", sendAt: null }) });
    const result = await scheduleNewsletterKit(EDITION_DIR, SCHEDULED_AT, deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 5);
      assert.match(result.reason, /não confirma/);
    }
  });

  it("PATCH + GET confirmam → ok com broadcastId/scheduledAt/status", async () => {
    const deps = makeDeps();
    const result = await scheduleNewsletterKit(EDITION_DIR, SCHEDULED_AT, deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.broadcastId, 42);
      assert.equal(result.scheduledAt, SCHEDULED_AT);
      assert.equal(result.status, "scheduled");
    }
  });

  it("patchSchedule é chamado com broadcastId + scheduledAt corretos", async () => {
    let calledWith: [number, string] | null = null;
    const deps = makeDeps({
      patchSchedule: async (broadcastId, sendAt) => {
        calledWith = [broadcastId, sendAt];
        return {};
      },
    });
    await scheduleNewsletterKit(EDITION_DIR, SCHEDULED_AT, deps);
    assert.deepEqual(calledWith, [42, SCHEDULED_AT]);
  });

  it("sucesso → persiste status 'scheduled' + scheduled_at, preservando o resto do estado", async () => {
    let written: KitNewsletterPublished | null = null;
    const deps = makeDeps({
      readPublished: () => draftState({ subject: "Assunto original", test_broadcast_ids: [99] }),
      writePublished: (_editionDir, state) => {
        written = state;
      },
    });
    await scheduleNewsletterKit(EDITION_DIR, SCHEDULED_AT, deps);
    assert.ok(written);
    assert.equal((written as unknown as KitNewsletterPublished).status, "scheduled");
    assert.equal((written as unknown as KitNewsletterPublished).scheduled_at, SCHEDULED_AT);
    assert.equal((written as unknown as KitNewsletterPublished).subject, "Assunto original");
    assert.equal((written as unknown as KitNewsletterPublished).broadcast_id, 42);
    assert.deepEqual((written as unknown as KitNewsletterPublished).test_broadcast_ids, [99]);
  });

  it("falha (GET não confirma) → NUNCA persiste estado 'scheduled'", async () => {
    let writeCalled = false;
    const deps = makeDeps({
      getBroadcastStatus: async () => ({ status: "draft", sendAt: null }),
      writePublished: () => {
        writeCalled = true;
      },
    });
    await scheduleNewsletterKit(EDITION_DIR, SCHEDULED_AT, deps);
    assert.equal(writeCalled, false);
  });

  it("status já 'scheduled' → retorna ok cedo sem chamar PATCH/GET/writePublished de novo (broadcast Kit completed é imutável)", async () => {
    let patchCalled = false;
    let getCalled = false;
    let writeCalled = false;
    const deps = makeDeps({
      readPublished: () => draftState({ status: "scheduled", scheduled_at: SCHEDULED_AT }),
      patchSchedule: async () => {
        patchCalled = true;
        return {};
      },
      getBroadcastStatus: async () => {
        getCalled = true;
        return { status: "scheduled", sendAt: SCHEDULED_AT };
      },
      writePublished: () => {
        writeCalled = true;
      },
    });
    const result = await scheduleNewsletterKit(EDITION_DIR, SCHEDULED_AT, deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.broadcastId, 42);
      assert.equal(result.scheduledAt, SCHEDULED_AT);
      assert.equal(result.status, "already_scheduled");
      assert.equal(result.alreadyScheduled, true);
    }
    assert.equal(patchCalled, false, "PATCH nunca deveria ser chamado — broadcast Kit já agendado/completed é imutável");
    assert.equal(getCalled, false);
    assert.equal(writeCalled, false);
  });

  it("scheduledAt recebido em offset diferente representando o MESMO instante enviado → ok, nunca code 5", async () => {
    const deps = makeDeps({
      getBroadcastStatus: async () => ({ status: "scheduled", sendAt: "2026-08-26T06:00:00.000-03:00" }),
    });
    const result = await scheduleNewsletterKit(EDITION_DIR, SCHEDULED_AT, deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.scheduledAt, "2026-08-26T06:00:00.000-03:00");
      assert.equal(result.status, "scheduled");
    }
  });

  it("send_at em instante DIFERENTE (mesmo formato Z) → code 5, comparação de instante pega divergência real", async () => {
    const deps = makeDeps({
      getBroadcastStatus: async () => ({ status: "scheduled", sendAt: "2026-08-26T10:00:00.000Z" }),
    });
    const result = await scheduleNewsletterKit(EDITION_DIR, SCHEDULED_AT, deps);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 5);
  });

  it("send_at malformado/NaN → code 5, nunca confirma sucesso por acidente", async () => {
    const deps = makeDeps({
      getBroadcastStatus: async () => ({ status: "draft", sendAt: "não-é-uma-data" }),
    });
    const result = await scheduleNewsletterKit(EDITION_DIR, SCHEDULED_AT, deps);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 5);
  });

  it("status 'draft'/'test_sent' (ainda não agendado) → segue fluxo normal, chama PATCH", async () => {
    for (const status of ["draft", "test_sent"] as const) {
      let patchCalled = false;
      const deps = makeDeps({
        readPublished: () => draftState({ status }),
        patchSchedule: async () => {
          patchCalled = true;
          return {};
        },
      });
      const result = await scheduleNewsletterKit(EDITION_DIR, SCHEDULED_AT, deps);
      assert.equal(patchCalled, true, `status=${status} deveria seguir o fluxo normal e chamar PATCH`);
      assert.equal(result.ok, true);
    }
  });
});
