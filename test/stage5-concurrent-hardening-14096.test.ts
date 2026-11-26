/**
 * test/stage5-concurrent-hardening-14096.test.ts (#14096)
 *
 * Duas brechas do Stage 5 concorrente (#14037):
 * 1. Brevo: acima do teto de 30 min, um `running` com o pid ainda rodando o
 *    dispatch não pode liberar um 2º lançamento (sairia um 2º rascunho). O
 *    teto só desarma o que se prova terminado ou pid reciclado; o que não se
 *    verifica (outro host, comando ilegível) exige `--force`.
 * 2. Wrapper social: falha do lock/progresso sai com JSON de erro e exit 2
 *    ("nada despachado"), nunca stack trace + exit 1.
 * Relógio injetado, pids e comandos fake, sem rede nem envio.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  activeLaunchReason,
  commandMatchesBrevoStage5,
  findActiveLaunch,
  findActiveLaunchWithReason,
  readProcessCommand,
  type ActiveLaunchContext,
  type BrevoStage5Record,
} from "../scripts/lib/brevo-stage5-background.ts";
import { runStage5BrevoDispatchWithRecord, type RecordIo } from "../scripts/brevo-diaria-stage5-dispatch.ts";
import {
  SOCIAL_NOTHING_DISPATCHED_EXIT_CODE,
  awaitConcurrentRun,
  startUnderLock,
} from "../scripts/publish-social-concurrent.ts";
import { withFileLock } from "../scripts/lib/file-lock.ts";

const NOW = Date.parse("2026-11-25T11:00:00Z");
const CAP = 30 * 60_000;
const OLD = "2026-11-25T10:00:00Z"; // 60 min antes: acima do teto
const FRESH = "2026-11-25T10:50:00Z"; // 10 min antes: dentro do teto

const rec = (over: Partial<BrevoStage5Record>): BrevoStage5Record =>
  ({ state: "running", launch_id: "L-old", pid: 4242, host: "300", started_at: OLD, ...over }) as BrevoStage5Record;

const ctx = (over: Partial<ActiveLaunchContext> = {}): ActiveLaunchContext => ({
  host: "300",
  isPidAlive: (p) => p === 4242,
  workerPidOf: () => undefined,
  nowEpochMs: NOW,
  maxTotalMs: CAP,
  ...over,
});

describe("#14096 Brevo: 2º dispatch acima do teto de 30 min", () => {
  it("cenário da issue: pid vivo ainda rodando o dispatch acima do teto continua busy, mesmo com --force", () => {
    const c = ctx({ processCommandOf: () => "/usr/bin/node --import tsx /repo/scripts/brevo-diaria-stage5-dispatch.ts --edition-dir x" });
    const found = findActiveLaunchWithReason([rec({})], c);
    assert.ok(found, "barra o 2º lançamento");
    assert.equal(found.record.launch_id, "L-old");
    assert.match(found.reason, /ainda roda o dispatch Brevo/);
    assert.ok(findActiveLaunch([rec({})], { ...c, force: true }), "--force não desarma o dispatch provadamente vivo");
  });

  it("worker vivo (publish-daily-brevo) acima do teto também barra", () => {
    const c = ctx({
      isPidAlive: (p) => p === 5151,
      workerPidOf: () => 5151,
      processCommandOf: (p) => (p === 5151 ? "node --import tsx scripts/publish-daily-brevo.ts dir --i-reviewed-the-copy" : undefined),
    });
    assert.ok(findActiveLaunch([rec({})], c));
  });

  it("acima do teto, dispatch e worker mortos neste host: prova de fim, libera", () => {
    assert.equal(findActiveLaunch([rec({})], ctx({ isPidAlive: () => false })), null);
  });

  it("acima do teto, pid vivo de outro programa (pid reciclado): libera", () => {
    assert.equal(findActiveLaunch([rec({})], ctx({ processCommandOf: () => "/usr/lib/systemd/systemd-journald" })), null);
  });

  it("acima do teto, comando ilegível (Windows): fail-closed até --force, com o motivo", () => {
    const c = ctx({ processCommandOf: () => undefined });
    const reason = activeLaunchReason(rec({}), c);
    assert.ok(reason);
    assert.match(reason, /--force/);
    assert.equal(activeLaunchReason(rec({}), { ...c, force: true }), null);
  });

  it("acima do teto, outro host: não dá para provar daqui → busy até --force", () => {
    const reason = activeLaunchReason(rec({ host: "neo" }), ctx());
    assert.ok(reason);
    assert.match(reason, /outro host \(neo\)/);
    assert.equal(activeLaunchReason(rec({ host: "neo" }), ctx({ force: true })), null);
  });

  it("dentro do teto nada muda: --force não desarma processo vivo nem outro host", () => {
    assert.ok(findActiveLaunch([rec({ started_at: FRESH })], ctx({ force: true })));
    assert.ok(findActiveLaunch([rec({ started_at: FRESH, host: "neo" })], ctx({ force: true })));
    assert.equal(findActiveLaunch([rec({ started_at: FRESH })], ctx({ isPidAlive: () => false })), null);
  });

  it("commandMatchesBrevoStage5: dispatch e sub-scripts batem; outro script não; ilegível = undefined", () => {
    assert.equal(commandMatchesBrevoStage5("node scripts/brevo-diaria-run.ts --apply"), true);
    assert.equal(commandMatchesBrevoStage5("node scripts/publish-social-concurrent.ts"), false);
    assert.equal(commandMatchesBrevoStage5(undefined), undefined);
  });

  it("readProcessCommand lê o comando do próprio processo no Linux", { skip: process.platform !== "linux" }, () => {
    const cmd = readProcessCommand(process.pid);
    assert.ok(cmd && cmd.length > 0);
  });

  it("o motivo entra no JSON busy do dispatch (active_reason), sem rodar nem gravar", () => {
    const writes: BrevoStage5Record[] = [];
    let ran = false;
    const io: RecordIo = {
      write: (r) => writes.push(r),
      warn: () => {},
      now: () => "2026-11-25T11:00:00Z",
      pid: 9000,
      host: "300",
      launchId: "L-new",
      findActive: () => ({ record: rec({}), reason: "pid 4242 ainda roda o dispatch Brevo" }),
    };
    const { result, exitCode } = runStage5BrevoDispatchWithRecord(() => {
      ran = true;
      return { status: "ok", campaignId: 1 } as never;
    }, io);
    assert.equal(exitCode, 5);
    assert.equal(ran, false);
    assert.equal(writes.length, 0);
    const busy = result as { status: string; active_launch_id: string; active_reason?: string; reason: string };
    assert.equal(busy.status, "busy");
    assert.equal(busy.active_launch_id, "L-old");
    assert.equal(busy.active_reason, "pid 4242 ainda roda o dispatch Brevo");
    assert.match(busy.reason, /ainda roda o dispatch Brevo/);
  });

  it("lock do registro que não sai vira failed/lock (exit 1), sem rodar o trabalho nem gravar running", () => {
    const writes: BrevoStage5Record[] = [];
    let ran = false;
    const io: RecordIo = {
      write: (r) => writes.push(r),
      warn: () => {},
      now: () => "t",
      pid: 9000,
      host: "300",
      launchId: "L-new",
      findActive: () => null,
      withLaunchLock: () => {
        throw new Error("timeout acquiring lock");
      },
    };
    const { result, exitCode } = runStage5BrevoDispatchWithRecord(() => {
      ran = true;
      return { status: "ok", campaignId: 1 } as never;
    }, io);
    assert.equal(exitCode, 1);
    assert.equal(ran, false);
    assert.equal(writes.length, 0);
    assert.equal((result as { step: string }).step, "lock");
  });
});

describe("#14096 wrapper social: falha do lock sai com JSON, nunca stack trace", () => {
  it("exceção do lock vira erro estruturado 'nada despachado', sem rodar o corpo", () => {
    let bodyRan = false;
    const out = startUnderLock(
      () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
      () => {
        bodyRan = true;
        return 1;
      },
      "/x/_internal/05-social-concurrent.json",
    );
    assert.equal(bodyRan, false);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.error.status, "failed");
    assert.equal(out.error.step, "lock");
    assert.equal(out.error.dispatched, false);
    assert.match(out.error.reason, /EACCES/);
    assert.match(out.error.reason, /nenhum canal despachado/);
    assert.equal(SOCIAL_NOTHING_DISPATCHED_EXIT_CODE, 2);
  });

  it("lock de verdade tomado por outro host (sync do data/): timeout vira erro estruturado", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "s14096-"));
    try {
      const progress = resolve(dir, "05-social-concurrent.json");
      // `.lock` de outra máquina chegando pela sync: o file-lock não rouba lock de outro host.
      writeFileSync(progress + ".lock", JSON.stringify({ pid: 1, host: "outra-maquina", ts: Date.now(), token: "t-14096" }));
      let bodyRan = false;
      const out = startUnderLock(
        <T>(fn: () => T) => withFileLock(progress + ".lock", fn, 300),
        () => {
          bodyRan = true;
          return 1;
        },
        progress,
      );
      assert.equal(bodyRan, false);
      assert.equal(out.ok, false);
      if (!out.ok) assert.equal(out.error.dispatched, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem erro, devolve o valor do corpo", () => {
    const out = startUnderLock(<T>(fn: () => T) => fn(), () => 42, "/x");
    assert.deepEqual(out, { ok: true, value: 42 });
  });

  it("rejeição depois dos spawns vira step 'run' com dispatched null (não dá para saber)", async () => {
    const out = await awaitConcurrentRun(Promise.reject(new Error("boom")), "/x/p.json");
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.error.step, "run");
    assert.equal(out.error.dispatched, null);
    assert.match(out.error.reason, /boom/);
  });
});
