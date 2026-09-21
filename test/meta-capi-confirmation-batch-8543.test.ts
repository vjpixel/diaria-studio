/**
 * Testes (#8543, lado Meta): lote de confirmação DOI -> Meta CAPI.
 * Nenhum teste toca a Meta: `fetchImpl` é sempre mock; índice em dir temporário.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertConfirmationEventName,
  classifyClickId,
  loadMetaConfirmationIndex,
  runMetaConfirmationBatch,
  type RunMetaConfirmationBatchDeps,
} from "../scripts/lib/meta-capi-confirmation-batch.ts";
import type { ConfirmationRosterEntry } from "../scripts/lib/google-ads-confirmation-batch.ts";
import type { SubscriberStateRecord } from "../scripts/lib/subscriber-state-snapshot.ts";
import {
  META_CAPI_CONFIRMATION_EVENT_NAME,
  computeCompleteRegistrationEventId,
  computeConfirmationEventId,
  hashEmailForMeta,
} from "../scripts/lib/shared/meta-capi.ts";

const NOW = new Date("2026-09-20T15:00:00Z");
const BASE_DATE = "2026-09-18";

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "meta-confirm-8543-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function sub(id: number, over: Partial<ConfirmationRosterEntry> = {}): ConfirmationRosterEntry {
  return { id, email_address: `leitor${id}@example.com`, state: "active", created_at: "2026-09-18T12:00:00Z", ...over };
}
const base = (id: number, state = "inactive"): SubscriberStateRecord => ({ id, state, created_at: "2026-09-18T12:00:00Z" });

interface Call {
  body: { data: Array<Record<string, any>> };
}
function mockFetch(status = 200): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    calls.push({ body: JSON.parse(init.body) });
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function deps(dir: string, over: Partial<RunMetaConfirmationBatchDeps>): RunMetaConfirmationBatchDeps {
  return {
    roster: [],
    baseSnapshot: [],
    baseDate: BASE_DATE,
    indexPath: join(dir, "idx.json"),
    dryRun: false,
    accessToken: "tok",
    now: NOW,
    log: () => {},
    ...over,
  };
}

describe("#8543 Meta — event_name da confirmação", () => {
  it("o nome padrão NÃO é CompleteRegistration e o nome do cadastro é recusado", () => {
    assert.notEqual(META_CAPI_CONFIRMATION_EVENT_NAME, "CompleteRegistration");
    assert.throws(() => assertConfirmationEventName("CompleteRegistration"), /OTIMIZAÇÃO/);
    assert.throws(() => assertConfirmationEventName("completeregistration"), /OTIMIZAÇÃO/);
    assert.throws(() => assertConfirmationEventName("com espaço"), /inválido/);
    assert.equal(assertConfirmationEventName("MinhaConfirmacao"), "MinhaConfirmacao");
  });

  it("payload enviado usa SubscriptionConfirmed, event_id próprio (distinto do cadastro), e-mail só em hash", () =>
    withTmp(async (dir) => {
      const { fetchImpl, calls } = mockFetch();
      const s = await runMetaConfirmationBatch(
        deps(dir, { roster: [sub(1, { fields: { origem_click_id: "fbclid:ABC123" } })], baseSnapshot: [base(1)], fetchImpl }),
      );
      assert.equal(s.sent, 1);
      assert.equal(calls.length, 1);
      const ev = calls[0].body.data[0];
      assert.equal(ev.event_name, "SubscriptionConfirmed");
      assert.notEqual(ev.event_name, "CompleteRegistration");
      assert.equal(ev.event_id, await computeConfirmationEventId(1));
      assert.notEqual(ev.event_id, await computeCompleteRegistrationEventId("leitor1@example.com", ev.event_time));
      assert.deepEqual(ev.user_data.em, [await hashEmailForMeta("leitor1@example.com")]);
      assert.equal(ev.user_data.fbc, `fb.1.${Date.parse("2026-09-18T12:00:00Z")}.ABC123`);
      assert.ok(!JSON.stringify(calls[0].body).includes("leitor1@example.com"));
    }));

  it("--event-name customizado é respeitado", () =>
    withTmp(async (dir) => {
      const { fetchImpl, calls } = mockFetch();
      await runMetaConfirmationBatch(deps(dir, { roster: [sub(1)], baseSnapshot: [base(1)], fetchImpl, eventName: "Confirmada" }));
      assert.equal(calls[0].body.data[0].event_name, "Confirmada");
    }));
});

describe("#8543 Meta — click id", () => {
  it("classifyClickId separa meta/outro/nenhum", () => {
    assert.equal(classifyClickId("fbclid:x"), "meta");
    assert.equal(classifyClickId("gclid:x"), "other");
    assert.equal(classifyClickId("  "), "none");
    assert.equal(classifyClickId(undefined), "none");
  });

  it("confirmação SEM click_id sobe só com hash de e-mail (sem fbc), contada em withoutClickId", () =>
    withTmp(async (dir) => {
      const { fetchImpl, calls } = mockFetch();
      const s = await runMetaConfirmationBatch(deps(dir, { roster: [sub(1)], baseSnapshot: [base(1)], fetchImpl }));
      assert.equal(s.sent, 1);
      assert.equal(s.withoutClickId, 1);
      assert.equal(s.withFbc, 0);
      assert.equal(calls[0].body.data[0].user_data.fbc, undefined);
      assert.ok(calls[0].body.data[0].user_data.em);
    }));

  it("--require-click-id: sem click_id NÃO sobe e fica registrado", () =>
    withTmp(async (dir) => {
      const { fetchImpl, calls } = mockFetch();
      const s = await runMetaConfirmationBatch(
        deps(dir, { roster: [sub(1)], baseSnapshot: [base(1)], fetchImpl, requireClickId: true }),
      );
      assert.equal(calls.length, 0);
      assert.equal(s.skippedNoClickId, 1);
      assert.equal(loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"].status, "skipped-no-click-id");
    }));

  it("click_id de outro canal (gclid) não sobe pra Meta e é registrado", () =>
    withTmp(async (dir) => {
      const { fetchImpl, calls } = mockFetch();
      const s = await runMetaConfirmationBatch(
        deps(dir, { roster: [sub(1, { fields: { origem_click_id: "gclid:G1" } })], baseSnapshot: [base(1)], fetchImpl }),
      );
      assert.equal(calls.length, 0);
      assert.equal(s.skippedOtherChannel, 1);
      assert.equal(loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"].status, "skipped-other-channel");
    }));
});

describe("#8543 Meta — idempotência e janela", () => {
  it("já enviada não reenvia (2ª rodada não chama a Meta)", () =>
    withTmp(async (dir) => {
      const { fetchImpl, calls } = mockFetch();
      const d = deps(dir, { roster: [sub(1)], baseSnapshot: [base(1)], fetchImpl });
      assert.equal((await runMetaConfirmationBatch(d)).sent, 1);
      const second = await runMetaConfirmationBatch(d);
      assert.equal(second.sent, 0);
      assert.equal(second.alreadyIndexed, 1);
      assert.equal(calls.length, 1);
      const raw = readFileSync(join(dir, "idx.json"), "utf8");
      assert.ok(!raw.includes("@"), "índice nunca guarda e-mail em claro");
    }));

  it("fora do prazo (cadastro > 7 dias) é registrado e pulado, não some em silêncio", () =>
    withTmp(async (dir) => {
      const { fetchImpl, calls } = mockFetch();
      const old = sub(1, { created_at: "2026-09-10T12:00:00Z" });
      const s = await runMetaConfirmationBatch(deps(dir, { roster: [old], baseSnapshot: [base(1)], fetchImpl }));
      assert.equal(calls.length, 0);
      assert.equal(s.outOfWindow, 1);
      assert.deepEqual(s.outOfWindowIds, [1]);
      assert.equal(loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"].status, "skipped-out-of-window");
      const again = await runMetaConfirmationBatch(deps(dir, { roster: [old], baseSnapshot: [base(1)], fetchImpl }));
      assert.equal(again.alreadyIndexed, 1);
      assert.equal(again.outOfWindow, 0);
    }));

  it("dry-run e ausência de token não enviam nem tocam o índice", () =>
    withTmp(async (dir) => {
      const { fetchImpl, calls } = mockFetch();
      const roster = [sub(1), sub(2, { created_at: "2026-09-01T00:00:00Z" })];
      const snap = [base(1), base(2)];
      const a = await runMetaConfirmationBatch(deps(dir, { roster, baseSnapshot: snap, fetchImpl, dryRun: true }));
      assert.equal(a.effectiveDryRun, true);
      const prev = process.env.META_CAPI_ACCESS_TOKEN;
      delete process.env.META_CAPI_ACCESS_TOKEN;
      try {
        const b = await runMetaConfirmationBatch(deps(dir, { roster, baseSnapshot: snap, fetchImpl, accessToken: undefined }));
        assert.equal(b.effectiveDryRun, true);
        assert.equal(b.toSend, 1);
      } finally {
        if (prev !== undefined) process.env.META_CAPI_ACCESS_TOKEN = prev;
      }
      assert.equal(calls.length, 0);
      assert.equal(existsSync(join(dir, "idx.json")), false);
    }));

  it("recusa da Meta conta tentativa e vira permanente na 3ª; índice corrompido lança", () =>
    withTmp(async (dir) => {
      const { fetchImpl } = mockFetch(400);
      const d = deps(dir, { roster: [sub(1)], baseSnapshot: [base(1)], fetchImpl });
      const r1 = await runMetaConfirmationBatch(d);
      assert.equal(r1.failed, 1);
      await runMetaConfirmationBatch(d);
      const r3 = await runMetaConfirmationBatch(d);
      assert.equal(r3.failedPermanent, 1);
      assert.equal(loadMetaConfirmationIndex(join(dir, "idx.json"))["kit-1"].status, "skipped-failed-permanent");
      writeFileSync(join(dir, "idx.json"), "{corrompido");
      await assert.rejects(() => runMetaConfirmationBatch(d), /ilegível/);
    }));
});

import { SCHEDULED_TASKS, getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

describe("#8543 — Diaria-Meta-Capi-Confirmations-Send registrada, diária, script próprio", () => {
  it("presente, diária 07:25, --send, script exclusivo (não reusa o do batch semanal)", () => {
    const t = getScheduledTaskByName("Diaria-Meta-Capi-Confirmations-Send");
    assert.ok(t);
    assert.deepEqual(t!.steps.map((s) => s.script), ["scripts/meta-capi-confirmations-send.ts"]);
    assert.deepEqual(t!.steps[0].args, ["--send"]);
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 7, minute: 25 });
    const others = SCHEDULED_TASKS.filter((o) => o.name !== t!.name && o.steps.some((s) => s.script === t!.steps[0].script));
    assert.deepEqual(others, []);
    const collisions = SCHEDULED_TASKS.filter(
      (o) => o.name !== t!.name && o.schedule.kind === "daily" && o.schedule.hour === 7 && o.schedule.minute === 25,
    );
    assert.deepEqual(collisions, []);
  });
});
