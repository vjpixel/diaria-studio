/**
 * test/stage5-concurrent-dispatch-14037.test.ts (#14037)
 *
 * Etapa 5: os 4 publishers sociais rodam concorrentes num só Bash
 * (`publish-social-concurrent.ts`) e o Brevo diária roda em background, com o
 * resultado juntado antes do sentinel (`brevo-diaria-stage5-join.ts`).
 * Cobre: concorrência real (todos iniciam antes de qualquer um terminar),
 * isolamento de falha por canal, preservação do JSON de cada publisher,
 * consent por canal, registro running/done do Brevo, decisões do join
 * (done, processo morto, timeout, não lançado), o lock do registro de rotação
 * que os 4 publishers passam a disputar, e o wiring do playbook.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SOCIAL_CHANNELS,
  channelCommand,
  concurrentExitCode,
  planChannels,
  readConsent,
  realRunChild,
  runConcurrent,
  splitTrailingJson,
  forwardSignalToChildren,
  type ConcurrentProgress,
  type ChildRun,
  type SocialChannel,
} from "../scripts/publish-social-concurrent.ts";
import { runStage5BrevoDispatchWithRecord } from "../scripts/brevo-diaria-stage5-dispatch.ts";
import { buildJoinOutput, runJoin } from "../scripts/brevo-diaria-stage5-join.ts";
import {
  decideJoin,
  joinExitCode,
  parseBrevoStage5Record,
  readBrevoStage5Record,
  writeBrevoStage5Record,
  type BrevoStage5Record,
  type ReadRecordOutcome,
} from "../scripts/lib/brevo-stage5-background.ts";
import { recordRotationRows } from "../scripts/lib/social-schedule-rotation-record.ts";
import { acquireLock, releaseLock } from "../scripts/lib/file-lock.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ALL_AUTO = { facebook: "auto", linkedin: "auto", instagram: "auto", threads: "auto" };

describe("#14037 publish-social-concurrent: plano por consent", () => {
  it("só canal com consent auto despacha; manual/ausente fica de fora com motivo", () => {
    const plan = planChannels({ facebook: "auto", linkedin: "manual", instagram: "auto" });
    assert.deepEqual(
      plan.map((p) => [p.channel, p.dispatch]),
      [
        ["facebook", true],
        ["linkedin", false],
        ["instagram", true],
        ["threads", false],
      ],
    );
    assert.match(plan[1].reason ?? "", /linkedin="manual"/);
    assert.match(plan[3].reason ?? "", /ausente/);
  });

  it("--channels restringe a um subconjunto e recusa canal desconhecido", () => {
    assert.deepEqual(planChannels(ALL_AUTO, ["threads"]).map((p) => p.channel), ["threads"]);
    assert.throws(() => planChannels(ALL_AUTO, ["tiktok"]), /canal desconhecido: tiktok/);
  });

  it("cada canal roda o mesmo comando do §5c-3, sempre com --schedule", () => {
    for (const ch of SOCIAL_CHANNELS) {
      assert.deepEqual(channelCommand(ch, "data/editions/2611/261125/"), {
        script: `scripts/publish-${ch}.ts`,
        args: ["--edition-dir", "data/editions/2611/261125/", "--schedule"],
      });
    }
  });

  it("consent ausente ou ilegível não despacha nada (readConsent falha)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "consent-14037-"));
    try {
      assert.equal(readConsent(dir).ok, false);
      mkdirSync(resolve(dir, "_internal"));
      writeFileSync(resolve(dir, "_internal", "05-publish-consent.json"), "{nao json");
      const r = readConsent(dir);
      assert.equal(r.ok, false);
      writeFileSync(resolve(dir, "_internal", "05-publish-consent.json"), JSON.stringify(ALL_AUTO));
      assert.deepEqual(readConsent(dir), { ok: true, modes: ALL_AUTO });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#14037 publish-social-concurrent: JSON final do publisher preservado", () => {
  it("separa as linhas de log do JSON pretty-printed final", () => {
    const out = { out_path: "x", summary: { total: 3 }, posts: [{ destaque: "d1" }] };
    const stdout = `OK facebook/d1 — scheduled\n{ linha de log que parece JSON\n${JSON.stringify(out, null, 2)}\n`;
    const split = splitTrailingJson(stdout);
    assert.deepEqual(split.output, out);
    assert.match(split.log, /OK facebook\/d1/);
    assert.ok(!("error" in split));
  });

  it("stdout sem JSON vira output null com erro explícito, nunca sucesso presumido", () => {
    const split = splitTrailingJson("Fatal error: boom\n");
    assert.equal(split.output, null);
    assert.ok("error" in split);
  });
});

describe("#14037 publish-social-concurrent: concorrência e isolamento de falha", () => {
  it("os 4 canais iniciam antes de qualquer um terminar; um que falha não derruba os outros", async () => {
    const started: SocialChannel[] = [];
    const releases = new Map<SocialChannel, (r: ChildRun) => void>();
    let allStarted!: () => void;
    const allStartedP = new Promise<void>((r) => (allStarted = r));
    const runChild = (channel: SocialChannel) =>
      new Promise<ChildRun>((res) => {
        started.push(channel);
        releases.set(channel, res);
        if (started.length === 4) allStarted();
      });
    const p = runConcurrent(planChannels(ALL_AUTO), "ed/", runChild);
    await allStartedP;
    assert.equal(started.length, 4, "todos os 4 começaram sem que nenhum tivesse terminado");
    releases.get("facebook")!({ code: 0, stdout: JSON.stringify({ summary: { scheduled: 3 } }, null, 2) });
    releases.get("linkedin")!({ code: 1, stdout: "Fatal error: x\n" });
    releases.get("instagram")!({ code: 2, stdout: "" });
    releases.get("threads")!({ code: 0, stdout: `OK\n${JSON.stringify({ summary: { scheduled: 2 } }, null, 2)}` });
    const result = await p;
    assert.deepEqual(result.failed_channels, ["linkedin", "instagram"]);
    assert.equal(concurrentExitCode(result), 1);
    const byCh = Object.fromEntries(result.results.map((r) => [r.channel, r]));
    assert.deepEqual((byCh.facebook as { output: unknown }).output, { summary: { scheduled: 3 } });
    assert.equal((byCh.instagram as { exit_code: number }).exit_code, 2, "exit 2 do publisher preservado");
    assert.deepEqual((byCh.threads as { output: unknown }).output, { summary: { scheduled: 2 } });
  });

  it("grava o progresso a cada canal que termina: o JSON do concluído já está lá enquanto o outro roda", async () => {
    const snaps: ConcurrentProgress[] = [];
    let releaseSlow!: (r: ChildRun) => void;
    const p = runConcurrent(
      planChannels(ALL_AUTO, ["facebook", "threads"]),
      "ed/",
      (ch) =>
        ch === "facebook"
          ? Promise.resolve({ code: 0, stdout: JSON.stringify({ summary: { scheduled: 3 } }) })
          : new Promise<ChildRun>((r) => (releaseSlow = r)),
      Date.now,
      (s) => snaps.push(structuredClone(s)),
    );
    await new Promise((r) => setImmediate(r));
    const mid = snaps.at(-1)!;
    assert.equal(mid.state, "running");
    assert.deepEqual(mid.pending, ["threads"]);
    assert.deepEqual((mid.results[0] as { output: unknown }).output, { summary: { scheduled: 3 } });
    releaseSlow({ code: 0, stdout: "{}" });
    await p;
    assert.equal(snaps.at(-1)!.state, "done");
    assert.deepEqual(snaps.at(-1)!.pending, []);
  });

  it("SIGINT/SIGTERM é repassado a cada filho vivo pelo PID", () => {
    const calls: Array<[number, string]> = [];
    const killed = forwardSignalToChildren([{ pid: 11 }, { pid: undefined }, { pid: 12 }], "SIGTERM", (pid, s) => {
      if (pid === 12) throw new Error("ESRCH");
      calls.push([pid, s]);
    });
    assert.deepEqual(calls, [[11, "SIGTERM"]]);
    assert.deepEqual(killed, [11]);
  });

  it("runner que lança vira canal falho com spawn_error, sem perder os demais", async () => {
    const result = await runConcurrent(planChannels(ALL_AUTO, ["facebook", "threads"]), "ed/", async (ch) => {
      if (ch === "facebook") throw new Error("spawn EACCES");
      return { code: 0, stdout: "{}" };
    });
    assert.deepEqual(result.failed_channels, ["facebook"]);
    const fb = result.results[0] as { spawn_error?: string };
    assert.match(fb.spawn_error ?? "", /EACCES/);
  });

  it("canal sem consent auto não roda e não conta como falha", async () => {
    let calls = 0;
    const result = await runConcurrent(planChannels({ ...ALL_AUTO, threads: "manual" }), "ed/", async () => {
      calls++;
      return { code: 0, stdout: "{}" };
    });
    assert.equal(calls, 3);
    assert.equal(concurrentExitCode(result), 0);
    assert.deepEqual(result.results.find((r) => r.channel === "threads"), {
      channel: "threads",
      dispatched: false,
      reason: 'consent threads="manual" (só "auto" despacha)',
    });
  });

  it("realRunChild captura stdout e exit code de um processo de verdade", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "child-14037-"));
    try {
      const fixture = resolve(dir, "fake-publisher.mjs");
      writeFileSync(
        fixture,
        'console.log("OK fake/d1");\nconsole.error("aviso no stderr");\nconsole.log(JSON.stringify({ summary: { total: 1 } }, null, 2));\nprocess.exitCode = 3;\n',
      );
      const run = await realRunChild(ROOT)("threads", fixture.replace(/\\/g, "/"), []);
      assert.equal(run.code, 3);
      assert.deepEqual(splitTrailingJson(run.stdout).output, { summary: { total: 1 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#14037 Brevo em background: registro running/done", () => {
  const io = (writes: BrevoStage5Record[], opts: { failWrite?: boolean } = {}) => {
    const warns: string[] = [];
    return {
      warns,
      io: {
        write: (r: BrevoStage5Record) => {
          if (opts.failWrite) throw new Error("EACCES");
          writes.push(r);
        },
        warn: (m: string) => warns.push(m),
        now: () => "2026-11-25T10:00:00.000Z",
        pid: 4242,
        host: "neo",
        launchId: "L1",
      },
    };
  };

  it("o registro leva o launch_id do lançamento", () => {
    const writes: BrevoStage5Record[] = [];
    runStage5BrevoDispatchWithRecord(() => ({ status: "already_done", campaignId: 1 }), io(writes).io);
    assert.deepEqual(writes.map((w) => w.launch_id), ["L1", "L1"]);
  });

  it("grava running antes e done depois com o mesmo JSON do stdout", () => {
    const writes: BrevoStage5Record[] = [];
    let stateDuringRun: string | undefined;
    const { io: rio } = io(writes);
    const { result, exitCode } = runStage5BrevoDispatchWithRecord(() => {
      stateDuringRun = writes.at(-1)?.state;
      return { status: "already_done", campaignId: 77 };
    }, rio);
    assert.equal(stateDuringRun, "running");
    assert.equal(exitCode, 0);
    const done = writes.at(-1)!;
    assert.equal(done.state, "done");
    assert.deepEqual(done.state === "done" && done.result, result);
  });

  it("exceção do dispatch vira failed/crash no registro e no retorno, nunca some", () => {
    const writes: BrevoStage5Record[] = [];
    const { result, exitCode } = runStage5BrevoDispatchWithRecord(() => {
      throw new Error("store corrompido");
    }, io(writes).io);
    assert.equal(exitCode, 1);
    assert.deepEqual(result, { status: "failed", step: "crash", reason: "store corrompido" });
    const done = writes.at(-1)!;
    assert.ok(done.state === "done" && done.exit_code === 1);
  });

  it("falha ao gravar o registro avisa no stderr e não perde o resultado do canal", () => {
    const writes: BrevoStage5Record[] = [];
    const h = io(writes, { failWrite: true });
    const { result } = runStage5BrevoDispatchWithRecord(() => ({ status: "skipped", reason: "semanal" }), h.io);
    assert.equal(result.status, "skipped");
    assert.equal(h.warns.length, 2);
    assert.match(h.warns[0], /registro running não gravado/);
  });

  it("registro grava e relê pelo caminho canônico da edição", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "brevo-rec-14037-"));
    try {
      assert.deepEqual(readBrevoStage5Record(dir), { kind: "missing" });
      const rec: BrevoStage5Record = { state: "running", launch_id: "L1", pid: 1, host: "h", started_at: "t" };
      writeBrevoStage5Record(dir, rec);
      assert.ok(existsSync(resolve(dir, "_internal", "05-brevo-stage5-dispatch.json")));
      assert.deepEqual(readBrevoStage5Record(dir), { kind: "ok", record: rec });
      assert.equal(parseBrevoStage5Record('{"state":"done","launch_id":"L1","pid":1,"host":"h","started_at":"t"}').kind, "invalid");
      assert.equal(parseBrevoStage5Record('{"state":"running","pid":1,"host":"h","started_at":"t"}').kind, "invalid", "sem launch_id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#14037 join do Brevo", () => {
  const STARTED = "2026-11-25T10:00:00Z";
  const T0 = Date.parse(STARTED);
  const running: BrevoStage5Record = { state: "running", launch_id: "L1", pid: 99, host: "neo", started_at: STARTED };
  const done = (status: string): BrevoStage5Record => ({
    ...running,
    state: "done",
    finished_at: "2026-11-25T10:07:00Z",
    exit_code: status === "failed" ? 1 : 0,
    result: { status, campaignId: 5 },
  });
  const ctx = {
    elapsedMs: 0,
    missingGraceMs: 30_000,
    host: "neo",
    isPidAlive: () => true,
    launchId: "L1",
    nowEpochMs: T0 + 60_000,
    maxTotalMs: 30 * 60_000,
  };

  it("done de OUTRO lançamento não é sucesso: conta como ausente e vira not_launched", () => {
    const stale = { ...done("ok"), launch_id: "L0" } as BrevoStage5Record;
    assert.equal(decideJoin({ kind: "ok", record: stale }, ctx).kind, "wait", "dentro da tolerância espera o registro novo");
    const d = decideJoin({ kind: "ok", record: stale }, { ...ctx, elapsedMs: 30_000 });
    assert.equal(d.kind, "not_launched");
    assert.equal(joinExitCode(d), 3);
    const out = buildJoinOutput(d);
    assert.equal(out.status, "failed");
    assert.equal(out.stale_launch_id, "L0");
  });

  it("running acima do teto total desde o started_at vira timeout/failed, mesmo com o processo vivo", () => {
    const d = decideJoin({ kind: "ok", record: running }, { ...ctx, nowEpochMs: T0 + 30 * 60_000 });
    assert.equal(d.kind, "timeout");
    assert.equal(joinExitCode(d), 1);
    assert.equal(buildJoinOutput(d).status, "failed");
    assert.equal(decideJoin({ kind: "ok", record: running }, { ...ctx, nowEpochMs: T0 + 29 * 60_000 }).kind, "wait");
  });

  it("decideJoin: done, espera, processo morto, outro host e ausente", () => {
    assert.equal(decideJoin({ kind: "ok", record: done("ok") }, ctx).kind, "done");
    assert.equal(decideJoin({ kind: "ok", record: running }, ctx).kind, "wait");
    assert.equal(decideJoin({ kind: "ok", record: running }, { ...ctx, isPidAlive: () => false }).kind, "process_died");
    assert.equal(
      decideJoin({ kind: "ok", record: { ...running, host: "300" } }, { ...ctx, isPidAlive: () => false }).kind,
      "wait",
      "pid de outro host não se confere daqui",
    );
    assert.equal(decideJoin({ kind: "missing" }, ctx).kind, "wait");
    assert.equal(decideJoin({ kind: "missing" }, { ...ctx, elapsedMs: 30_000 }).kind, "not_launched");
  });

  it("exit codes alinhados ao dispatch: failed = 1, skipped = 0, não lançado = 3, rodando = 4", () => {
    assert.equal(joinExitCode({ kind: "done", record: done("ok") as Extract<BrevoStage5Record, { state: "done" }> }), 0);
    assert.equal(joinExitCode({ kind: "done", record: done("skipped") as Extract<BrevoStage5Record, { state: "done" }> }), 0);
    assert.equal(joinExitCode({ kind: "done", record: done("failed") as Extract<BrevoStage5Record, { state: "done" }> }), 1);
    assert.equal(joinExitCode({ kind: "not_launched" }), 3);
    assert.equal(joinExitCode({ kind: "still_running" }), 4);
  });

  const fakeDeps = (seq: ReadRecordOutcome[], alive = true, startAt = T0 + 60_000) => {
    let t = startAt;
    let i = 0;
    return {
      read: () => seq[Math.min(i++, seq.length - 1)],
      host: "neo",
      launchId: "L1",
      isPidAlive: () => alive,
      nowMs: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  };

  it("espera o running virar done e devolve o JSON do dispatch com join=done", async () => {
    const deps = fakeDeps([{ kind: "ok", record: running }, { kind: "ok", record: running }, { kind: "ok", record: done("ok") }]);
    const { output, exitCode } = await runJoin(deps, { waitMs: 540_000, pollMs: 5_000 });
    assert.equal(exitCode, 0);
    assert.equal(output.join, "done");
    assert.equal(output.status, "ok");
    assert.equal(output.campaignId, 5);
  });

  it("processo morto com running no disco vira failed explícito", async () => {
    const { output, exitCode } = await runJoin(fakeDeps([{ kind: "ok", record: running }], false), { waitMs: 540_000, pollMs: 5_000 });
    assert.equal(exitCode, 1);
    assert.equal(output.join, "process_died");
    assert.equal(output.status, "failed");
  });

  it("tempo esgotado com o processo vivo sai 4 (re-rodar o join), nunca sucesso", async () => {
    const { output, exitCode } = await runJoin(fakeDeps([{ kind: "ok", record: running }]), { waitMs: 20_000, pollMs: 5_000 });
    assert.equal(exitCode, 4);
    assert.equal(output.join, "still_running");
    assert.notEqual(output.status, "ok");
  });

  it("re-rodar o join não vira loop: perto do teto, a chamada seguinte sai timeout (exit 1)", async () => {
    // 1ª chamada: 25 min desde o launch, espera 540 s e sai 4.
    const first = await runJoin(fakeDeps([{ kind: "ok", record: running }], true, T0 + 25 * 60_000), { waitMs: 240_000, pollMs: 5_000 });
    assert.equal(first.exitCode, 4);
    // Re-execução já acima dos 30 min: falha do canal, nunca outro 4.
    const second = await runJoin(fakeDeps([{ kind: "ok", record: running }], true, T0 + 29 * 60_000 + 30_000), { waitMs: 540_000, pollMs: 5_000 });
    assert.equal(second.exitCode, 1);
    assert.equal(second.output.join, "timeout");
  });

  it("leitura ilegível isolada é tratada como transitória; repetida vira falha", async () => {
    const bad: ReadRecordOutcome = { kind: "invalid", error: "EBUSY" };
    const ok = await runJoin(fakeDeps([bad, { kind: "ok", record: done("ok") }]), { waitMs: 540_000, pollMs: 5_000 });
    assert.equal(ok.output.join, "done");
    const ko = await runJoin(fakeDeps([bad]), { waitMs: 540_000, pollMs: 5_000 });
    assert.equal(ko.exitCode, 1);
    assert.equal(ko.output.join, "invalid");
  });

  it("registro ausente além da tolerância sai 3 (não lançado)", async () => {
    const { output, exitCode } = await runJoin(fakeDeps([{ kind: "missing" }]), { waitMs: 540_000, pollMs: 5_000 });
    assert.equal(exitCode, 3);
    assert.equal(output.join, "not_launched");
    assert.equal(buildJoinOutput({ kind: "invalid", error: "x" }).status, "failed");
  });
});

describe("#14037 registro de rotação: lock contra os 4 publishers concorrentes", () => {
  it("com o lock tomado, recordRotationRows espera e não grava por fora do lock", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "rot-lock-14037-"));
    const log = resolve(dir, "rot.jsonl");
    const row = { kind: "weekday", date: "2026-11-25", type: "d1", time: "09:45", source: "rotation" } as unknown as Parameters<
      typeof recordRotationRows
    >[1][number];
    try {
      acquireLock(log + ".lock");
      try {
        assert.throws(() => recordRotationRows(log, [row], "2026-11-25T00:00:00Z", 200), /lock timeout/);
        assert.equal(existsSync(log), false, "nada gravado sem o lock");
      } finally {
        releaseLock(log + ".lock");
      }
      assert.equal(recordRotationRows(log, [row], "2026-11-25T00:00:00Z", 200), 1);
      assert.equal(recordRotationRows(log, [row], "2026-11-25T00:00:00Z", 200), 0);
      assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#14037 wiring do playbook do Stage 5", () => {
  const stage5 = readFileSync(resolve(ROOT, ".claude/agents/orchestrator-stage-5.md"), "utf8");

  it("o dispatch social roda pelo wrapper concorrente, não por várias chamadas Bash na mesma mensagem", () => {
    assert.ok(!stage5.includes("Em uma unica mensagem, disparar simultaneamente"));
    const start = stage5.indexOf("**Rodar os 4 publishers sociais concorrentes num so Bash**");
    const end = stage5.indexOf("Aguardar todos retornarem", start);
    assert.ok(start > 0 && end > start);
    const block = stage5.slice(start, end);
    assert.match(block, /npx tsx scripts\/publish-social-concurrent\.ts --edition-dir \{EDITION_DIR\}\//);
    assert.doesNotMatch(block, /Bash\("npx tsx scripts\/(publish-|brevo-diaria-stage5-dispatch)/);
  });

  it("Brevo é lançado em background depois do §5c-pre e antes do §5c, e juntado antes do §5h", () => {
    const pre = stage5.indexOf("### 5c-pre. ");
    const launch = stage5.indexOf("### 5c-pre-brevo.");
    const newsletter = stage5.indexOf("### 5c. ");
    const join = stage5.indexOf("### 5g-ter.");
    const sentinel = stage5.indexOf("### 5h.");
    assert.ok(pre < launch && launch < newsletter, "ordem 5c-pre < 5c-pre-brevo < 5c");
    assert.ok(join > 0 && join < sentinel, "join antes do sentinel");
    const launchSection = stage5.slice(launch, newsletter);
    assert.match(launchSection, /run_in_background: true/);
    assert.match(launchSection, /npx tsx scripts\/brevo-diaria-stage5-dispatch\.ts --edition-dir \{EDITION_DIR\}\//);
    assert.match(launchSection, /consent\.brevo === "auto"/);
    assert.match(launchSection, /--launch-id \{BREVO_LAUNCH_ID\}/);
    const joinSection = stage5.slice(join, sentinel);
    assert.match(joinSection, /npx tsx scripts\/brevo-diaria-stage5-join\.ts --edition-dir \{EDITION_DIR\}\/ --launch-id \{BREVO_LAUNCH_ID\}/);
    assert.match(joinSection, /join: "timeout"[\s\S]*render-halt-banner\.ts/, "timeout do join é halt banner, nunca re-rodar para sempre");
    assert.match(stage5, /_internal\/05-social-concurrent\.json/, "playbook documenta a recuperação pelo arquivo de progresso");
  });
});
