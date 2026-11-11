/**
 * test/apoiadores-sent-from-esp-12739.test.ts (#12739)
 *
 * Regressão do ciclo 2609-10: o state local marcou a Retrospectiva de setembro
 * como enviada (`status: "sent"`, `email: done`) com o broadcast Kit 26211180
 * em rascunho (`draft`, `send_at: null`). Travas:
 *
 *   1. `confirmKitBroadcastSent` (pura): só `scheduled` (com send_at),
 *      `sending` ou `completed` contam como envio.
 *   2. `runMarkSent` (`send-monthly-apoiadores.ts --mark-sent`): relê o Kit e
 *      recusa rascunho, releitura falha e credencial ausente SEM gravar.
 *   3. Publisher com agendamento: o `sent` exige o agendamento confirmado na
 *      releitura, não só o `send_at` mandado no POST.
 *   4. `deriveEmailChannelState`/`--sync-email`: rascunho é `pending` e
 *      sobrescreve um `done` antigo.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmKitBroadcastSent } from "../scripts/lib/mensal/apoiadores-kit-sent-confirmation.ts";
import { runMarkSent, type MarkSentDeps } from "../scripts/send-monthly-apoiadores.ts";
import type { ApoiadoresState } from "../scripts/lib/mensal/monthly-apoiadores-state.ts";
import { main as publishMain, type ApoiadoresKitDeps } from "../scripts/publish-monthly-apoiadores-kit.ts";
import type { CreateBroadcastInput } from "../scripts/lib/kit-broadcasts.ts";
import { runSyncEmailChannel } from "../scripts/mark-retrospectiva-channel.ts";
import {
  readRetrospectivaDivulgacaoState,
  retrospectivaDivulgacaoStatePath,
  writeRetrospectivaDivulgacaoState,
} from "../scripts/lib/mensal/retrospectiva-divulgacao.ts";

/** O state real do 2609-10 antes da correção, como estava no rascunho. */
function draftState(over: Partial<ApoiadoresState> = {}): ApoiadoresState {
  return {
    cycle: "2609-10",
    status: "draft_prepared",
    preparedAt: "2026-10-02T17:25:42.846Z",
    sentAt: null,
    htmlPath: "x.html",
    subject: "Retrospectiva de setembro: Agentes saem do teste e invadem governos e empresas",
    segments: ["Apoio — Mantenedor", "Apoio — Patrono"],
    brevoCampaignId: null,
    kitBroadcastId: 26211180,
    kitAudienceVerified: true,
    ...over,
  } as ApoiadoresState;
}

describe("#12739 — confirmKitBroadcastSent", () => {
  it("draft (o 26211180 real) recusa", () => {
    const r = confirmKitBroadcastSent({ status: "draft", send_at: null }, 26211180);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /"draft"/);
  });
  it("aborted e status ausente recusam", () => {
    assert.equal(confirmKitBroadcastSent({ status: "aborted" }, 1).ok, false);
    assert.equal(confirmKitBroadcastSent({}, 1).ok, false);
  });
  it("scheduled sem send_at recusa (agendamento zerado não dispara)", () => {
    assert.equal(confirmKitBroadcastSent({ status: "scheduled", send_at: null }, 1).ok, false);
  });
  it("scheduled com send_at, sending e completed confirmam", () => {
    assert.deepEqual(confirmKitBroadcastSent({ status: "scheduled", send_at: "2026-11-07T09:00:00Z" }, 1), {
      ok: true,
      status: "scheduled",
      sendAt: "2026-11-07T09:00:00Z",
    });
    assert.equal(confirmKitBroadcastSent({ status: "sending" }, 1).ok, true);
    assert.equal(confirmKitBroadcastSent({ status: "completed", send_at: "2026-11-02T09:00:00Z" }, 1).ok, true);
  });
});

describe("#12739 — runMarkSent (--mark-sent relê o Kit)", () => {
  function deps(state: ApoiadoresState | null, getBroadcast: MarkSentDeps["getBroadcast"]) {
    const written: ApoiadoresState[] = [];
    const d: MarkSentDeps = {
      readState: () => state,
      writeState: (_dir, s) => written.push(s),
      getBroadcast,
      now: () => new Date("2026-10-02T17:25:57.342Z"),
    };
    return { d, written };
  }

  it("cenário real: rascunho no Kit → erro, state NÃO gravado", async () => {
    const { d, written } = deps(draftState(), async () => ({ status: "draft", send_at: null }));
    const r = await runMarkSent({ cycle: "2609-10", monthlyDir: "/x", deps: d });
    assert.equal(r.action, "error");
    assert.match((r as { reason: string }).reason, /draft/);
    assert.equal(written.length, 0, "rascunho nunca pode virar 'sent'");
  });

  it("releitura que lança → erro, nada gravado (fail-closed)", async () => {
    const { d, written } = deps(draftState(), async () => {
      throw new Error("ECONNRESET");
    });
    const r = await runMarkSent({ cycle: "2609-10", monthlyDir: "/x", deps: d });
    assert.equal(r.action, "error");
    assert.match((r as { reason: string }).reason, /ECONNRESET/);
    assert.equal(written.length, 0);
  });

  it("sem KIT_API_KEY (getBroadcast null) com broadcast Kit → erro, nada gravado", async () => {
    const { d, written } = deps(draftState(), null);
    const r = await runMarkSent({ cycle: "2609-10", monthlyDir: "/x", deps: d });
    assert.equal(r.action, "error");
    assert.match((r as { reason: string }).reason, /KIT_API_KEY/);
    assert.equal(written.length, 0);
  });

  it("completed no Kit → grava sent com o send_at relido (não o relógio)", async () => {
    const { d, written } = deps(draftState(), async () => ({ status: "completed", send_at: "2026-10-03T09:00:00Z" }));
    const r = await runMarkSent({ cycle: "2609-10", monthlyDir: "/x", deps: d });
    assert.equal(r.action, "written");
    assert.equal(written.length, 1);
    assert.equal(written[0].status, "sent");
    assert.equal(written[0].sentAt, "2026-10-03T09:00:00Z");
    assert.equal(written[0].kitBroadcastId, 26211180);
  });

  it("state legado sem broadcast Kit: confirmação manual segue, sem consultar o Kit", async () => {
    let called = false;
    const { d, written } = deps(draftState({ kitBroadcastId: null }), async () => {
      called = true;
      return {};
    });
    const r = await runMarkSent({ cycle: "2607-08", monthlyDir: "/x", deps: d });
    assert.equal(r.action, "written");
    assert.match((r as { message: string }).message, /não conferida no ESP/);
    assert.equal(called, false);
    assert.equal(written[0].sentAt, "2026-10-02T17:25:57.342Z");
  });

  it("já sent → noop, sem reler", async () => {
    const { d, written } = deps(draftState({ status: "sent", sentAt: "2026-10-03T09:00:00Z" }), null);
    assert.equal((await runMarkSent({ cycle: "2609-10", monthlyDir: "/x", deps: d })).action, "noop");
    assert.equal(written.length, 0);
  });
});

describe("#12739 — publisher: 'sent' só com agendamento confirmado na releitura", () => {
  const originalExit = process.exit;
  const originalArgv = process.argv;
  afterEach(() => {
    process.exit = originalExit;
    process.argv = originalArgv;
    delete process.env.KIT_API_KEY;
  });

  async function run(reread: Record<string, unknown>): Promise<ApoiadoresState[]> {
    const root = mkdtempSync(join(tmpdir(), "apoiadores-12739-"));
    const realErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const written: ApoiadoresState[] = [];
    const created: CreateBroadcastInput[] = [];
    try {
      writeFileSync(join(root, "platform.config.json"), JSON.stringify({ kit_apoiadores: { audience_tag: "apoio-mensal" } }));
      process.env.KIT_API_KEY = "fake_key";
      process.argv = ["node", "publish-monthly-apoiadores-kit.ts", "--cycle", "2609-10", "--schedule", "2026-10-03T06:00:00-03:00"];
      process.exit = ((code?: number) => {
        throw new Error(`__exit_${code}__`);
      }) as typeof process.exit;
      const deps: ApoiadoresKitDeps = {
        renderEmail: () => ({ subject: "s", previewText: "p", html: "<p>x</p>", htmlPath: "x.html", yymm: "2609" }) as never,
        readState: () => null,
        writeState: (_dir, s) => written.push(s),
        findTagId: async () => 42,
        countTagMembers: async () => 9,
        createBroadcast: async (input) => {
          created.push(input);
          return { id: 26211180 };
        },
        getBroadcast: async () => ({ subscriber_filter: [{ all: [{ type: "tag", ids: [42] }] }], ...reread }),
        updateBroadcast: async () => {
          throw new Error("não deveria atualizar");
        },
        now: () => new Date("2026-09-20T00:00:00Z"),
      };
      await publishMain(root, deps);
      assert.equal(created[0].send_at, "2026-10-03T06:00:00-03:00");
      return written;
    } finally {
      process.stderr.write = realErr;
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("Kit devolve draft (agendamento não pegou) → draft_prepared, nunca sent", async () => {
    const written = await run({ status: "draft", send_at: null });
    assert.equal(written.length, 1);
    assert.equal(written[0].status, "draft_prepared");
    assert.equal(written[0].sentAt, null);
  });

  it("releitura sem status → draft_prepared", async () => {
    const written = await run({});
    assert.equal(written[0].status, "draft_prepared");
  });

  it("Kit devolve scheduled com send_at → sent", async () => {
    const written = await run({ status: "scheduled", send_at: "2026-10-03T09:00:00Z" });
    assert.equal(written[0].status, "sent");
  });
});

describe("#12739 — --sync-email: rascunho vira pending e apaga o done antigo", () => {
  it("state do publisher em rascunho + canal email done → pending", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-email-12739-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "beehiiv-apoiadores-state.json"), JSON.stringify(draftState()));
      const path = retrospectivaDivulgacaoStatePath(dir);
      writeRetrospectivaDivulgacaoState(path, {
        cycle: "2609-10",
        channels: { email: { status: "done", attemptedAt: "2026-10-02T17:25:57.342Z", url: null, reason: null } },
      } as never);
      const r = runSyncEmailChannel("2609-10", dir);
      assert.equal(r.action, "written");
      assert.equal((r as { status: string }).status, "pending");
      assert.equal(readRetrospectivaDivulgacaoState(path, "2609-10").channels.email?.status, "pending");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
