/**
 * test/schedule-newsletter-kit.test.ts (#464)
 *
 * Cobre `scripts/schedule-newsletter-kit.ts` — agendamento do broadcast
 * Kit de PRODUÇÃO no Stage 6 (mesma divisão 5/6 do Beehiiv/Brevo: rascunho
 * na 5, agendamento na 6). `patchSchedule`/`getBroadcastStatus`/
 * `readPublished`/`writePublished` injetados — nenhuma chamada de rede/I/O
 * real. Mesmo padrão de `test/schedule-daily-brevo-5772.test.ts`.
 *
 * `describe("main() — integração")` (achado do review, PR #6096 —
 * pr-test-analyzer): fecha a assimetria de cobertura de CLI com o script
 * irmão `publish-newsletter-kit.ts` (que já testava seu próprio guard de
 * backend) — mesmo padrão de fixtures em disco + `fetch` mockado.
 */
import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleNewsletterKit, main, type ScheduleNewsletterKitDeps } from "../scripts/schedule-newsletter-kit.ts";
import { readPublishedState, writePublishedState, type KitNewsletterPublished } from "../scripts/publish-newsletter-kit.ts";

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

describe("main() — integração (guard de CLI)", () => {
  let originalArgv: string[];
  let originalFetch: typeof fetch;
  const API_KEY_ENV_ORIG = process.env.KIT_API_KEY;

  beforeEach(() => {
    process.env.KIT_API_KEY = "kit_test_key_464_schedule";
    originalArgv = process.argv;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    process.argv = originalArgv;
    globalThis.fetch = originalFetch;
  });

  after(() => {
    if (API_KEY_ENV_ORIG === undefined) delete process.env.KIT_API_KEY;
    else process.env.KIT_API_KEY = API_KEY_ENV_ORIG;
  });

  function writePlatformConfig(root: string, backend: string): void {
    writeFileSync(join(root, "platform.config.json"), JSON.stringify({ publishing: { newsletter: { backend } } }), "utf8");
  }

  it("--edition-dir/--scheduled-at ausentes: exitCode 1, nenhuma chamada de rede", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-schedule-main-"));
    try {
      writePlatformConfig(root, "kit");
      globalThis.fetch = (async () => {
        throw new Error("não deveria chamar fetch");
      }) as typeof fetch;
      process.argv = ["node", "schedule-newsletter-kit.ts"];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("backend != kit: exitCode 2, nenhuma chamada de rede (mesmo guard do script irmão publish-newsletter-kit.ts)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-schedule-main-"));
    try {
      writePlatformConfig(root, "beehiiv");
      globalThis.fetch = (async () => {
        throw new Error("não deveria chamar fetch");
      }) as typeof fetch;
      process.argv = ["node", "schedule-newsletter-kit.ts", "--edition-dir", root, "--scheduled-at", "2026-08-26T09:00:00.000Z"];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, 2);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("draft ausente: exitCode 3, sem chamada de rede (backend kit confirmado, mas nada pra agendar)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-schedule-main-"));
    try {
      writePlatformConfig(root, "kit");
      globalThis.fetch = (async () => {
        throw new Error("não deveria chamar fetch");
      }) as typeof fetch;
      process.argv = ["node", "schedule-newsletter-kit.ts", "--edition-dir", root, "--scheduled-at", "2026-08-26T09:00:00.000Z"];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, 3);
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("caminho feliz de ponta a ponta: PATCH + GET mockados confirmam, exitCode 0, estado persistido", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-schedule-main-"));
    try {
      writePlatformConfig(root, "kit");
      mkdirSync(join(root, "_internal"), { recursive: true });
      writePublishedState(root, {
        broadcast_id: 555,
        subject: "Assunto",
        preview_text: "Preview",
        status: "draft",
        test_broadcast_ids: [],
      });
      const calls: { method: string; pathname: string }[] = [];
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        calls.push({ method: init?.method ?? "GET", pathname: u.pathname });
        if (u.pathname === "/v4/broadcasts/555" && (init?.method === "PATCH" || !init?.method || init.method === "GET")) {
          const body = JSON.stringify({ broadcast: { id: 555, status: "scheduled", send_at: "2026-08-26T09:00:00.000Z" } });
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            text: async () => body,
          } as unknown as Response;
        }
        throw new Error(`chamada inesperada: ${init?.method ?? "GET"} ${u.pathname}`);
      }) as typeof fetch;
      process.argv = ["node", "schedule-newsletter-kit.ts", "--edition-dir", root, "--scheduled-at", "2026-08-26T09:00:00.000Z"];
      process.exitCode = undefined;
      await main(root);
      assert.equal(process.exitCode, 0);
      assert.equal(calls.length, 2, "1 PATCH + 1 GET de verificação");
      const state = readPublishedState(root);
      assert.equal(state?.status, "scheduled");
      assert.equal(state?.scheduled_at, "2026-08-26T09:00:00.000Z");
    } finally {
      process.exitCode = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
