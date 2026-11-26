/**
 * test/stage5-concurrent-dispatch-14037.test.ts (#14037)
 *
 * Etapa 5: os 4 publishers sociais rodam concorrentes num só Bash
 * (`publish-social-concurrent.ts`) e o Brevo diária roda em background, com o
 * resultado juntado antes do sentinel (`brevo-diaria-stage5-join.ts`).
 * Cobre: concorrência real, isolamento de falha por canal, JSON de cada
 * publisher preservado (e ausência dele como falha), consent por canal, pid
 * de cada filho no progresso, recusa de re-rodar canal vivo, merge do retry,
 * repasse de sinal, registro por lançamento do Brevo (busy, falha de gravação,
 * pid do worker), decisões do join (done, processo morto, timeout, não
 * lançado, outros lançamentos), lock do registro de rotação e wiring do
 * playbook.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SOCIAL_CHANNELS,
  busyChannels,
  carriedResults,
  mergeProgressResults,
  channelCommand,
  concurrentExitCode,
  forwardSignalToChildren,
  isFailedResult,
  planChannels,
  readConsent,
  realRunChild,
  runConcurrent,
  splitTrailingJson,
  waitForChildrenExit,
  type ChildRun,
  type ConcurrentProgress,
  type SocialChannel,
} from "../scripts/publish-social-concurrent.ts";
import { buildExecArgs, runStage5BrevoDispatchWithRecord, type RecordIo } from "../scripts/brevo-diaria-stage5-dispatch.ts";
import { MISSING_GRACE_MS, buildJoinOutput, runJoin } from "../scripts/brevo-diaria-stage5-join.ts";
import {
  BUSY_EXIT_CODE,
  OTHER_ACTIVE_EXIT_CODE,
  brevoStage5WorkerPidPath,
  currentHost,
  removeWorkerPidFile,
  brevoStage5RecordPath,
  decideJoin,
  findActiveLaunch,
  joinExitCode,
  listBrevoStage5Records,
  parseBrevoStage5Record,
  readBrevoStage5Record,
  writeBrevoStage5Record,
  type BrevoStage5Record,
  type ReadRecordOutcome,
} from "../scripts/lib/brevo-stage5-background.ts";
import { recordRotationRows } from "../scripts/lib/social-schedule-rotation-record.ts";
import { acquireLock, lockHostId, releaseLock } from "../scripts/lib/file-lock.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ALL_AUTO = { facebook: "auto", linkedin: "auto", instagram: "auto", threads: "auto" };
const okJson = (o: unknown = { summary: { scheduled: 3 } }) => JSON.stringify(o, null, 2);

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
      assert.equal(readConsent(dir).ok, false);
      writeFileSync(resolve(dir, "_internal", "05-publish-consent.json"), JSON.stringify(ALL_AUTO));
      assert.deepEqual(readConsent(dir), { ok: true, modes: ALL_AUTO });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--channels com canal sem consent auto: não roda e o exit sai ≠ 0 (pedido não atendido)", async () => {
    const plan = planChannels({ ...ALL_AUTO, threads: "manual" }, ["facebook", "threads"]);
    const result = await runConcurrent(plan, "ed/", async () => ({ code: 0, stdout: okJson() }));
    assert.deepEqual(result.requested_not_dispatched, ["threads"]);
    assert.deepEqual(result.failed_channels, []);
    assert.equal(concurrentExitCode(result), 1);
  });

  it("sem --channels, canal com consent manual fica de fora sem mexer no exit", async () => {
    const result = await runConcurrent(planChannels({ ...ALL_AUTO, threads: "manual" }), "ed/", async () => ({ code: 0, stdout: okJson() }));
    assert.equal(concurrentExitCode(result), 0);
    assert.deepEqual(result.results.find((r) => r.channel === "threads"), {
      channel: "threads",
      dispatched: false,
      reason: 'consent threads="manual" (só "auto" despacha)',
    });
  });
});

describe("#14037 publish-social-concurrent: JSON final do publisher", () => {
  it("separa as linhas de log do JSON pretty-printed final", () => {
    const out = { out_path: "x", summary: { total: 3 }, posts: [{ destaque: "d1" }] };
    const stdout = `OK facebook/d1 — scheduled\n{ linha de log que parece JSON\n${JSON.stringify(out, null, 2)}\n`;
    const split = splitTrailingJson(stdout);
    assert.deepEqual(split.output, out);
    assert.match(split.log, /OK facebook\/d1/);
    assert.ok(!("error" in split));
  });

  it("canal que sai 0 sem JSON parseável conta como falha e deixa o exit ≠ 0", async () => {
    const result = await runConcurrent(planChannels(ALL_AUTO, ["facebook", "linkedin"]), "ed/", async (ch) =>
      ch === "facebook" ? { code: 0, stdout: "OK sem json\n" } : { code: 0, stdout: okJson() },
    );
    assert.deepEqual(result.failed_channels, ["facebook"]);
    assert.equal(concurrentExitCode(result), 1);
    assert.ok(isFailedResult(result.results[0]));
    assert.ok(!isFailedResult(result.results[1]));
  });
});

describe("#14037 publish-social-concurrent: concorrência, pid e isolamento de falha", () => {
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
    releases.get("facebook")!({ code: 0, stdout: okJson() });
    releases.get("linkedin")!({ code: 1, stdout: "Fatal error: x\n" });
    releases.get("instagram")!({ code: 2, stdout: "" });
    releases.get("threads")!({ code: 0, stdout: `OK\n${okJson({ summary: { scheduled: 2 } })}` });
    const result = await p;
    assert.deepEqual(result.failed_channels, ["linkedin", "instagram"]);
    assert.equal(concurrentExitCode(result), 1);
    const byCh = Object.fromEntries(result.results.map((r) => [r.channel, r]));
    assert.deepEqual((byCh.facebook as { output: unknown }).output, { summary: { scheduled: 3 } });
    assert.equal((byCh.instagram as { exit_code: number }).exit_code, 2, "exit 2 do publisher preservado");
  });

  it("o pid de cada filho entra no progresso assim que ele inicia, e no resultado", async () => {
    const snaps: ConcurrentProgress[] = [];
    let releaseSlow!: (r: ChildRun) => void;
    const p = runConcurrent(
      planChannels(ALL_AUTO, ["facebook", "threads"]),
      "ed/",
      (ch, _s, _a, onSpawn) => {
        onSpawn?.(ch === "facebook" ? 101 : 202);
        return ch === "facebook" ? Promise.resolve({ code: 0, stdout: okJson() }) : new Promise<ChildRun>((r) => (releaseSlow = r));
      },
      { onProgress: (s) => snaps.push(structuredClone(s)), host: "neo", runId: "R2" },
    );
    await new Promise((r) => setImmediate(r));
    const mid = snaps.at(-1)!;
    assert.equal(mid.state, "running");
    assert.deepEqual(mid.running, [{ channel: "threads", pid: 202 }]);
    assert.deepEqual(mid.pending, ["threads"]);
    assert.equal((mid.results[0] as { pid?: number }).pid, 101);
    releaseSlow({ code: 0, stdout: "{}" });
    const result = await p;
    assert.equal(snaps.at(-1)!.state, "done");
    assert.deepEqual(snaps.at(-1)!.running, []);
    assert.equal(result.run_id, "R2");
  });

  it("retry com --channels faz merge: mantém o resultado dos canais fora da rodada", async () => {
    const previous: ConcurrentProgress = {
      run_id: "R1",
      host: "neo",
      state: "done",
      started_at: "t",
      updated_at: "t",
      results: [
        { channel: "facebook", dispatched: true, run_id: "R1", pid: 1, exit_code: 0, duration_ms: 1, output: { ok: 1 }, log: "" },
        { channel: "threads", dispatched: true, run_id: "R1", pid: 2, exit_code: 1, duration_ms: 1, output: null, log: "", output_error: "x" },
      ],
      running: [],
      pending: [],
      failed_channels: ["threads"],
    };
    const snaps: ConcurrentProgress[] = [];
    await runConcurrent(planChannels(ALL_AUTO, ["threads"]), "ed/", async () => ({ code: 0, stdout: okJson() }), {
      previous,
      runId: "R2",
      onProgress: (s) => snaps.push(structuredClone(s)),
    });
    const final = snaps.at(-1)!;
    assert.deepEqual(final.results.map((r) => [r.channel, (r as { run_id: string }).run_id]), [
      ["facebook", "R1"],
      ["threads", "R2"],
    ]);
    assert.deepEqual(final.failed_channels, []);
  });

  it("canal com pid vivo de rodada anterior é recusado (mesmo host); morto ou fora da rodada passa", () => {
    const previous = {
      run_id: "R1",
      host: "neo",
      state: "running",
      started_at: "t",
      updated_at: new Date(0).toISOString(),
      results: [],
      running: [
        { channel: "threads", pid: 11 },
        { channel: "facebook", pid: 12 },
      ],
      pending: ["threads", "facebook"],
      failed_channels: [],
    } as ConcurrentProgress;
    const alive = (pid: number) => pid === 11;
    assert.deepEqual(busyChannels(previous, planChannels(ALL_AUTO, ["threads"]), { host: "neo", isPidAlive: alive, nowEpochMs: 0 }), [
      { channel: "threads", pid: 11, host: "neo" },
    ]);
    assert.deepEqual(busyChannels(previous, planChannels(ALL_AUTO, ["facebook"]), { host: "neo", isPidAlive: alive, nowEpochMs: 0 }), []);
    assert.deepEqual(busyChannels(previous, planChannels(ALL_AUTO, ["linkedin"]), { host: "neo", isPidAlive: alive, nowEpochMs: 0 }), []);
    // Outro host: vale enquanto o progresso estiver fresco.
    const foreign = { ...previous, host: "300", updated_at: new Date(1_000).toISOString() };
    assert.equal(busyChannels(foreign, planChannels(ALL_AUTO, ["facebook"]), { host: "neo", isPidAlive: () => false, nowEpochMs: 2_000 }).length, 1);
    assert.equal(
      busyChannels(foreign, planChannels(ALL_AUTO, ["facebook"]), { host: "neo", isPidAlive: () => false, nowEpochMs: 1_000 + 16 * 60_000 }).length,
      0,
    );
  });

  it("teto de frescor também no mesmo host: pid vivo em progresso velho não bloqueia", () => {
    const previous = {
      run_id: "R1",
      host: "neo",
      state: "running",
      started_at: "t",
      updated_at: new Date(0).toISOString(),
      results: [],
      running: [{ channel: "threads", pid: 11 }],
      pending: ["threads"],
      failed_channels: [],
    } as ConcurrentProgress;
    assert.deepEqual(
      busyChannels(previous, planChannels(ALL_AUTO, ["threads"]), { host: "neo", isPidAlive: () => true, nowEpochMs: 16 * 60_000 }),
      [],
    );
  });

  it("merge: running/pending sem resultado e rodada interrupted viram falha pendente; consent não apaga falha", () => {
    const previous: ConcurrentProgress = {
      run_id: "R1",
      host: "neo",
      state: "interrupted",
      started_at: "t",
      updated_at: "t",
      results: [{ channel: "facebook", dispatched: true, run_id: "R1", pid: 1, exit_code: 0, duration_ms: 1, output: { ok: 1 }, log: "" }],
      running: [{ channel: "linkedin", pid: 2 }],
      pending: ["linkedin", "threads"],
      failed_channels: [],
    };
    const carried = carriedResults(previous);
    assert.ok(isFailedResult(carried.get("linkedin")!), "linkedin estava rodando");
    assert.ok(isFailedResult(carried.get("threads")!), "threads estava pendente");
    assert.match((carried.get("threads") as { output_error: string }).output_error, /interrompida/);
    assert.ok(!isFailedResult(carried.get("facebook")!));
    // Retry só do threads, agora sem consent: não apaga a falha pendente dele.
    const current = new Map([["threads", { channel: "threads", dispatched: false, reason: "consent", requested: true }]]) as Map<
      SocialChannel,
      import("../scripts/publish-social-concurrent.ts").ChannelResult
    >;
    const merged = mergeProgressResults(previous, planChannels({ ...ALL_AUTO, threads: "manual" }, ["threads"]), current);
    const byCh = Object.fromEntries(merged.map((r) => [r.channel, r]));
    assert.ok(isFailedResult(byCh.threads), "falha anterior preservada");
    assert.ok(isFailedResult(byCh.linkedin), "linkedin fora da rodada segue como falha pendente");
    assert.ok(!isFailedResult(byCh.facebook));
  });

  it("os spawns e o progresso com os pids acontecem de forma síncrona (dentro do lock do CLI)", () => {
    const snaps: ConcurrentProgress[] = [];
    let n = 100;
    void runConcurrent(
      planChannels(ALL_AUTO),
      "ed/",
      (_ch, _s, _a, onSpawn) => {
        onSpawn?.(n++);
        return new Promise<ChildRun>(() => {});
      },
      { onProgress: (s) => snaps.push(structuredClone(s)) },
    );
    // Sem nenhum await: o último progresso já lista os 4 pids.
    assert.deepEqual(snaps.at(-1)!.running.map((r) => r.pid).sort(), [100, 101, 102, 103]);
  });

  it("runner que lança vira canal falho com spawn_error, sem perder os demais", async () => {
    const result = await runConcurrent(planChannels(ALL_AUTO, ["facebook", "threads"]), "ed/", async (ch) => {
      if (ch === "facebook") throw new Error("spawn EACCES");
      return { code: 0, stdout: "{}" };
    });
    assert.deepEqual(result.failed_channels, ["facebook"]);
    assert.match((result.results[0] as { spawn_error?: string }).spawn_error ?? "", /EACCES/);
  });

  it("SIGINT/SIGTERM é repassado a cada filho vivo pelo PID; ESRCH calado, EPERM logado", () => {
    const calls: Array<[number, string]> = [];
    const warns: string[] = [];
    const killed = forwardSignalToChildren(
      [{ pid: 11 }, { pid: undefined }, { pid: 12 }, { pid: 13 }],
      "SIGTERM",
      (pid, s) => {
        if (pid === 12) throw Object.assign(new Error("x"), { code: "ESRCH" });
        if (pid === 13) throw Object.assign(new Error("x"), { code: "EPERM" });
        calls.push([pid, s]);
      },
      (m) => warns.push(m),
    );
    assert.deepEqual(calls, [[11, "SIGTERM"]]);
    assert.deepEqual(killed, [11]);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /pid 13 \(EPERM\)/);
  });

  it("depois do sinal o wrapper espera os filhos saírem, com teto", async () => {
    const live = new Set([1, 2]);
    let ticks = 0;
    const left = await waitForChildrenExit(live, 1_000, async () => {
      ticks++;
      if (ticks === 2) live.clear();
    }, 100);
    assert.equal(left, 0);
    const stuck = await waitForChildrenExit(new Set([1]), 300, async () => {}, 100);
    assert.equal(stuck, 1);
  });

  it("realRunChild captura stdout, exit code e pid de um processo de verdade", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "child-14037-"));
    try {
      const fixture = resolve(dir, "fake-publisher.mjs");
      writeFileSync(
        fixture,
        'console.log("OK fake/d1");\nconsole.error("aviso no stderr");\nconsole.log(JSON.stringify({ summary: { total: 1 } }, null, 2));\nprocess.exitCode = 3;\n',
      );
      let spawnedPid: number | undefined;
      const run = await realRunChild(ROOT)("threads", fixture.replace(/\\/g, "/"), [], (pid) => (spawnedPid = pid));
      assert.equal(run.code, 3);
      assert.equal(typeof spawnedPid, "number");
      assert.deepEqual(splitTrailingJson(run.stdout).output, { summary: { total: 1 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#14037 Brevo em background: registro por lançamento", () => {
  const io = (writes: BrevoStage5Record[], opts: { failWrite?: "running" | "done"; active?: BrevoStage5Record | null } = {}) => {
    const warns: string[] = [];
    const rio: RecordIo = {
      write: (r: BrevoStage5Record) => {
        if (opts.failWrite === r.state) throw new Error("EACCES");
        writes.push(r);
      },
      warn: (m: string) => warns.push(m),
      now: () => "2026-11-25T10:00:00.000Z",
      pid: 4242,
      host: "neo",
      launchId: "L1",
      findActive: () => opts.active ?? null,
    };
    return { warns, io: rio };
  };

  it("grava running antes e done depois com o mesmo JSON do stdout, com o launch_id", () => {
    const writes: BrevoStage5Record[] = [];
    let stateDuringRun: string | undefined;
    const { result, exitCode } = runStage5BrevoDispatchWithRecord(() => {
      stateDuringRun = writes.at(-1)?.state;
      return { status: "already_done", campaignId: 77 };
    }, io(writes).io);
    assert.equal(stateDuringRun, "running");
    assert.equal(exitCode, 0);
    assert.deepEqual(writes.map((w) => w.launch_id), ["L1", "L1"]);
    const done = writes.at(-1)!;
    assert.deepEqual(done.state === "done" && done.result, result);
  });

  it("outro lançamento ativo: recusa iniciar com exit dedicado, sem rodar nem gravar", () => {
    const writes: BrevoStage5Record[] = [];
    let ran = false;
    const active: BrevoStage5Record = { state: "running", launch_id: "L0", pid: 7, host: "neo", started_at: "2026-11-25T09:55:00Z" };
    const { result, exitCode } = runStage5BrevoDispatchWithRecord(() => {
      ran = true;
      return { status: "already_done", campaignId: 1 };
    }, io(writes, { active }).io);
    assert.equal(exitCode, BUSY_EXIT_CODE);
    assert.equal(result.status, "busy");
    assert.equal((result as { active_launch_id: string }).active_launch_id, "L0");
    assert.equal(ran, false);
    assert.equal(writes.length, 0);
  });

  it("falha ao gravar o running aborta o dispatch (exit ≠ 0), sem rodar o trabalho", () => {
    const writes: BrevoStage5Record[] = [];
    let ran = false;
    const { result, exitCode } = runStage5BrevoDispatchWithRecord(() => {
      ran = true;
      return { status: "already_done", campaignId: 1 };
    }, io(writes, { failWrite: "running" }).io);
    assert.equal(exitCode, 1);
    assert.equal(result.status, "failed");
    assert.equal((result as { step: string }).step, "record");
    assert.equal(ran, false);
  });

  it("falha ao gravar o done só avisa: o trabalho já foi feito e o resultado sai igual", () => {
    const writes: BrevoStage5Record[] = [];
    const h = io(writes, { failWrite: "done" });
    const { result } = runStage5BrevoDispatchWithRecord(() => ({ status: "skipped", reason: "semanal" }), h.io);
    assert.equal(result.status, "skipped");
    assert.match(h.warns[0], /registro done não gravado/);
  });

  it("exceção do dispatch vira failed/crash no registro e no retorno, nunca some", () => {
    const writes: BrevoStage5Record[] = [];
    const { result, exitCode } = runStage5BrevoDispatchWithRecord(() => {
      throw new Error("store corrompido");
    }, io(writes).io);
    assert.equal(exitCode, 1);
    assert.deepEqual(result, { status: "failed", step: "crash", reason: "store corrompido" });
  });

  it("um arquivo por lançamento: o registro de um não sobrescreve o de outro", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "brevo-rec-14037-"));
    try {
      assert.deepEqual(readBrevoStage5Record(dir, "brevo-2026-11-25T10:00:00.000Z"), { kind: "missing" });
      const a: BrevoStage5Record = { state: "running", launch_id: "brevo-2026-11-25T10:00:00.000Z", pid: 1, host: "h", started_at: "t" };
      const b: BrevoStage5Record = { state: "running", launch_id: "brevo-2026-11-25T11:00:00.000Z", pid: 2, host: "h", started_at: "t" };
      writeBrevoStage5Record(dir, a);
      writeBrevoStage5Record(dir, b);
      assert.ok(!brevoStage5RecordPath(dir, a.launch_id).includes(":0"), "nome de arquivo sem ':'");
      assert.ok(existsSync(brevoStage5RecordPath(dir, a.launch_id)));
      assert.deepEqual(readBrevoStage5Record(dir, a.launch_id), { kind: "ok", record: a });
      assert.equal(listBrevoStage5Records(dir).length, 2);
      assert.equal(parseBrevoStage5Record('{"state":"running","pid":1,"host":"h","started_at":"t"}').kind, "invalid", "sem launch_id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("findActiveLaunch: dispatch OU worker vivo no mesmo host; outro host dentro do teto", () => {
    const now = Date.parse("2026-11-25T10:10:00Z");
    const rec = (over: Partial<BrevoStage5Record>): BrevoStage5Record =>
      ({ state: "running", launch_id: "L0", pid: 7, host: "neo", started_at: "2026-11-25T10:00:00Z", ...over }) as BrevoStage5Record;
    const ctx = { host: "neo", isPidAlive: (p: number) => p === 99, workerPidOf: () => undefined, nowEpochMs: now, maxTotalMs: 30 * 60_000 };
    assert.equal(findActiveLaunch([rec({})], ctx), null, "dispatch morto, sem worker");
    assert.ok(findActiveLaunch([rec({})], { ...ctx, workerPidOf: () => 99 }), "worker vivo mantém ativo");
    assert.ok(findActiveLaunch([rec({ pid: 99 })], ctx));
    assert.ok(findActiveLaunch([rec({ host: "300" })], ctx), "outro host dentro do teto");
    // #14096: além do teto, outro host só desarma com --force (fail-closed).
    assert.ok(findActiveLaunch([rec({ host: "300", started_at: "2026-11-25T09:00:00Z" })], ctx), "outro host além do teto sem --force");
    assert.equal(findActiveLaunch([rec({ host: "300", started_at: "2026-11-25T09:00:00Z" })], { ...ctx, force: true }), null, "outro host além do teto com --force");
    assert.equal(findActiveLaunch([{ ...rec({}), state: "done", finished_at: "t", exit_code: 0, result: { status: "ok" } }], ctx), null);
    // Teto também no mesmo host: pid reciclado (vivo, outro programa) não bloqueia para sempre (#14096: só com o comando provando).
    assert.equal(
      findActiveLaunch([rec({ pid: 99, started_at: "2026-11-25T09:00:00Z" })], { ...ctx, processCommandOf: () => "/usr/bin/sshd -D" }),
      null,
    );
  });

  it("o mesmo launch-id com o processo anterior vivo também recusa iniciar", () => {
    const writes: BrevoStage5Record[] = [];
    const same: BrevoStage5Record = { state: "running", launch_id: "L1", pid: 8, host: "neo", started_at: "2026-11-25T09:58:00Z" };
    const { result, exitCode } = runStage5BrevoDispatchWithRecord(() => ({ status: "already_done", campaignId: 1 }), io(writes, { active: same }).io);
    assert.equal(exitCode, BUSY_EXIT_CODE);
    assert.equal((result as { active_launch_id: string }).active_launch_id, "L1");
    assert.equal(writes.length, 0);
  });

  it("o .worker.json é removido ao fim do lançamento", () => {
    const writes: BrevoStage5Record[] = [];
    let cleaned = 0;
    const h = io(writes);
    runStage5BrevoDispatchWithRecord(() => ({ status: "already_done", campaignId: 1 }), { ...h.io, cleanup: () => void cleaned++ });
    assert.equal(cleaned, 1);
    const dir = mkdtempSync(resolve(tmpdir(), "worker-rm-14037-"));
    try {
      const p = brevoStage5WorkerPidPath(dir, "L1");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, '{"pid":1}');
      removeWorkerPidFile(dir, "L1");
      assert.equal(existsSync(p), false);
      assert.doesNotThrow(() => removeWorkerPidFile(dir, "L1"), "ausente não lança");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("host de liveness é o lockHostId (hostname + namespace de PID), igual nos dois scripts", () => {
    assert.equal(currentHost(), lockHostId());
  });

  it("os sub-scripts recebem o preload que grava o pid do worker", () => {
    const args = buildExecArgs(ROOT, "C:/x/scripts/brevo-diaria-run.ts", ["--apply"], "C:/ed/_internal/05-brevo-stage5/L1.worker.json");
    assert.equal(args[0], "--import");
    assert.equal(args[1], "tsx");
    assert.equal(args[2], "--import");
    assert.match(args[3], /^file:.*record-worker-pid\.mjs$/);
    assert.deepEqual(args.slice(4), ["C:/x/scripts/brevo-diaria-run.ts", "--apply"]);
    assert.deepEqual(buildExecArgs(ROOT, "s.ts", []), ["--import", "tsx", "s.ts"]);
  });

  it("o preload grava o pid do processo que roda o sub-script", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "worker-pid-14037-"));
    try {
      const pidFile = resolve(dir, "sub", "L1.worker.json");
      const script = resolve(dir, "work.mjs");
      writeFileSync(script, "console.log(process.pid);\n");
      const args = buildExecArgs(ROOT, script, [], pidFile).filter((a, i, all) => !(a === "tsx" || (a === "--import" && all[i + 1] === "tsx")));
      const r = spawnSync(process.execPath, args, { env: { ...process.env, DIARIA_WORKER_PID_FILE: pidFile }, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      const recorded = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number };
      assert.equal(recorded.pid, Number(r.stdout.trim()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#14037 join do Brevo", () => {
  const STARTED = "2026-11-25T10:00:00Z";
  const T0 = Date.parse(STARTED);
  const running: BrevoStage5Record = { state: "running", launch_id: "L1", pid: 99, host: "neo", started_at: STARTED };
  const done = (status: string, launchId = "L1"): BrevoStage5Record => ({
    ...running,
    launch_id: launchId,
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
    workerPidOf: () => undefined,
    launchId: "L1",
    nowEpochMs: T0 + 60_000,
    maxTotalMs: 30 * 60_000,
    others: [] as BrevoStage5Record[],
  };

  it("decideJoin: done, espera, processo morto, outro host e ausente", () => {
    assert.equal(decideJoin({ kind: "ok", record: done("ok") }, ctx).kind, "done");
    assert.equal(decideJoin({ kind: "ok", record: running }, ctx).kind, "wait");
    assert.equal(decideJoin({ kind: "ok", record: running }, { ...ctx, isPidAlive: () => false }).kind, "process_died");
    assert.equal(decideJoin({ kind: "ok", record: { ...running, host: "300" } }, { ...ctx, isPidAlive: () => false }).kind, "wait");
    assert.equal(decideJoin({ kind: "missing" }, ctx).kind, "wait");
    assert.equal(decideJoin({ kind: "missing" }, { ...ctx, elapsedMs: 30_000 }).kind, "not_launched");
  });

  it("processo morto só quando dispatch E worker estão mortos", () => {
    const workerAlive = { ...ctx, isPidAlive: (p: number) => p === 555, workerPidOf: () => 555 };
    assert.equal(decideJoin({ kind: "ok", record: running }, workerAlive).kind, "wait");
    const bothDead = { ...ctx, isPidAlive: () => false, workerPidOf: () => 555 };
    const d = decideJoin({ kind: "ok", record: running }, bothDead);
    assert.equal(d.kind, "process_died");
    assert.match(buildJoinOutput(d).reason as string, /worker pid 555/);
  });

  it("registro deste lançamento ausente e exatamente um outro running: exit dedicado com active_launch_id", () => {
    const d = decideJoin({ kind: "missing" }, { ...ctx, elapsedMs: 30_000, others: [done("ok", "L0"), { ...running, launch_id: "L2" }] });
    assert.equal(d.kind, "other_active");
    assert.equal(joinExitCode(d), OTHER_ACTIVE_EXIT_CODE);
    const out = buildJoinOutput(d);
    assert.equal(out.active_launch_id, "L2");
    assert.notEqual(out.status, "ok");
    assert.notEqual(out.status, "failed", "não é falha para seguir: é juntar o outro");
  });

  it("registro deste lançamento ausente com outros lançamentos só done (ou 2+ running): not_launched, os outros só no relato", () => {
    const d = decideJoin({ kind: "missing" }, { ...ctx, elapsedMs: 30_000, others: [done("ok", "L0"), done("failed", "L2")] });
    assert.equal(d.kind, "not_launched");
    assert.equal(joinExitCode(d), 3);
    const out = buildJoinOutput(d);
    assert.equal(out.status, "failed");
    assert.deepEqual(out.other_launches, [
      { launch_id: "L0", state: "done" },
      { launch_id: "L2", state: "done" },
    ]);
    const two = decideJoin({ kind: "missing" }, { ...ctx, elapsedMs: 30_000, others: [{ ...running, launch_id: "L2" }, { ...running, launch_id: "L3" }] });
    assert.equal(two.kind, "not_launched");
  });

  it("running acima do teto total desde o started_at vira timeout/failed, mesmo com o processo vivo", () => {
    const d = decideJoin({ kind: "ok", record: running }, { ...ctx, nowEpochMs: T0 + 30 * 60_000 });
    assert.equal(d.kind, "timeout");
    assert.equal(joinExitCode(d), 1);
    assert.equal(decideJoin({ kind: "ok", record: running }, { ...ctx, nowEpochMs: T0 + 29 * 60_000 }).kind, "wait");
  });

  const fakeDeps = (seq: ReadRecordOutcome[], alive = true, startAt = T0 + 60_000, others: BrevoStage5Record[] = []) => {
    let t = startAt;
    let i = 0;
    return {
      read: () => seq[Math.min(i++, seq.length - 1)],
      listAll: () => others,
      workerPidOf: () => undefined,
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
    const { output, exitCode } = await runJoin(
      fakeDeps([{ kind: "ok", record: running }, { kind: "ok", record: running }, { kind: "ok", record: done("ok") }]),
      { waitMs: 540_000, pollMs: 5_000 },
    );
    assert.equal(exitCode, 0);
    assert.equal(output.join, "done");
    assert.equal(output.campaignId, 5);
  });

  it("processo morto com running no disco vira failed explícito", async () => {
    const { output, exitCode } = await runJoin(fakeDeps([{ kind: "ok", record: running }], false), { waitMs: 540_000, pollMs: 5_000 });
    assert.equal(exitCode, 1);
    assert.equal(output.join, "process_died");
  });

  it("tempo esgotado com o processo vivo sai 4 (re-rodar o join), nunca sucesso", async () => {
    const { output, exitCode } = await runJoin(fakeDeps([{ kind: "ok", record: running }]), { waitMs: 20_000, pollMs: 5_000 });
    assert.equal(exitCode, 4);
    assert.equal(output.join, "still_running");
  });

  it("re-rodar o join não vira loop: acima do teto a chamada sai timeout (exit 1)", async () => {
    const first = await runJoin(fakeDeps([{ kind: "ok", record: running }], true, T0 + 25 * 60_000), { waitMs: 240_000, pollMs: 5_000 });
    assert.equal(first.exitCode, 4);
    const second = await runJoin(fakeDeps([{ kind: "ok", record: running }], true, T0 + 29 * 60_000 + 30_000), { waitMs: 540_000, pollMs: 5_000 });
    assert.equal(second.exitCode, 1);
    assert.equal(second.output.join, "timeout");
  });

  it("--wait-seconds 0 mantém a tolerância mínima de registro ausente", async () => {
    // Registro aparece 10 s depois: com wait 0 o join ainda o encontra.
    const deps = fakeDeps([{ kind: "missing" }, { kind: "missing" }, { kind: "ok", record: done("ok") }]);
    const { output, exitCode } = await runJoin(deps, { waitMs: 0, pollMs: 5_000 });
    assert.equal(output.join, "done");
    assert.equal(exitCode, 0);
    // Sem registro nenhum, só desiste depois da tolerância inteira.
    let elapsed = 0;
    const never = fakeDeps([{ kind: "missing" }]);
    const t0 = never.nowMs();
    const r = await runJoin(never, { waitMs: 0, pollMs: 5_000 });
    elapsed = never.nowMs() - t0;
    assert.equal(r.output.join, "not_launched");
    assert.ok(elapsed >= MISSING_GRACE_MS, `esperou ${elapsed} ms`);
  });

  it("leitura ilegível isolada é tratada como transitória; repetida vira falha", async () => {
    const bad: ReadRecordOutcome = { kind: "invalid", error: "EBUSY" };
    const ok = await runJoin(fakeDeps([bad, { kind: "ok", record: done("ok") }]), { waitMs: 540_000, pollMs: 5_000 });
    assert.equal(ok.output.join, "done");
    const ko = await runJoin(fakeDeps([bad]), { waitMs: 540_000, pollMs: 5_000 });
    assert.equal(ko.exitCode, 1);
    assert.equal(ko.output.join, "invalid");
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
    assert.match(stage5, /_internal\/05-social-concurrent\.json/, "playbook documenta a recuperação pelo arquivo de progresso");
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
    assert.match(launchSection, /npx tsx scripts\/brevo-diaria-stage5-dispatch\.ts --edition-dir \{EDITION_DIR\}\/ --launch-id \{BREVO_LAUNCH_ID\}/);
    assert.match(launchSection, /consent\.brevo === "auto"/);
    assert.match(launchSection, /antes de QUALQUER halt/i, "join antes de todo halt posterior ao lançamento");
    const joinSection = stage5.slice(join, sentinel);
    assert.match(joinSection, /npx tsx scripts\/brevo-diaria-stage5-join\.ts --edition-dir \{EDITION_DIR\}\/ --launch-id \{BREVO_LAUNCH_ID\}/);
    assert.match(joinSection, /join: "timeout"[\s\S]*render-halt-banner\.ts/);
  });
});
