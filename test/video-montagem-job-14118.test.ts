/**
 * #14118: build, preview, review e face do `/diaria-video-montagem` batiam no
 * teto de 600 s do Bash em primeiro plano. Rodam pelo wrapper
 * `video-montagem-job.ts` em background, com registro, status e retomada
 * idempotente: rodar de novo com o job vivo nunca lança um segundo.
 * Nenhum teste lança o `video-montagem.ts` de verdade (spawn falso).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_COMMANDS,
  JOB_BUSY_EXIT_CODE,
  JOB_NONE_EXIT_CODE,
  JOB_RUNNING_EXIT_CODE,
  classifyJob,
  decideLaunch,
  jobName,
  jobRecordPath,
  parseJobRecord,
  readJobRecord,
  writeJobRecord,
  type JobRecord,
} from "../scripts/lib/diaria/video-montagem-job.ts";
import { main } from "../scripts/video-montagem-job.ts";
import { SUBCOMMANDS } from "../scripts/video-montagem.ts";

const HOST = "maquina-teste";
const ctx = (alive: number[] = [], nowMs = Date.parse("2026-11-26T10:00:00Z")) => ({ host: HOST, isPidAlive: (p: number) => alive.includes(p), nowMs });

function rec(over: Partial<JobRecord> = {}): JobRecord {
  return {
    job: "build",
    cmd: "build",
    edition: "261126",
    argv: ["build", "261126"],
    pid: 100,
    host: HOST,
    started_at: "2026-11-26T09:50:00.000Z",
    state: "running",
    log_path: "/nao/existe.log",
    ...over,
  };
}

function sandbox(): { base: string; done: () => void } {
  const base = mkdtempSync(join(tmpdir(), "vm-job-14118-"));
  return { base, done: () => rmSync(base, { recursive: true, force: true }) };
}

/** Filho falso: emite a saída e fecha com `code` no próximo tick. */
function fakeChild(code: number, stdout = "", pid = 4242): { child: ChildProcess; finish: () => void } {
  const ee = new EventEmitter() as unknown as ChildProcess & EventEmitter;
  const so = new PassThrough();
  const se = new PassThrough();
  Object.assign(ee, { stdout: so, stderr: se, pid, kill: () => true });
  const finish = () => {
    if (stdout) so.write(stdout);
    setImmediate(() => (ee as EventEmitter).emit("close", code, null));
  };
  return { child: ee, finish };
}

describe("#14118 lib: nome do job, parse e liveness", () => {
  it("os subcomandos do wrapper existem no video-montagem.ts (nome errado sairia exit 2 em silêncio na skill)", () => {
    for (const c of BACKGROUND_COMMANDS) assert.ok((SUBCOMMANDS as readonly string[]).includes(c), c);
    for (const c of ["build", "preview", "review", "face"]) assert.ok(BACKGROUND_COMMANDS.includes(c), c);
  });
  it("job = subcomando + --seq: prévia padrão e prévia do horizontal são jobs distintos", () => {
    assert.equal(jobName("preview", ["preview", "261126"]), "preview");
    assert.equal(jobName("preview", ["preview", "261126", "--seq", "youtube"]), "preview-youtube");
    assert.equal(jobName("build", ["build", "261126", "--seq=instagram"]), "build-instagram");
  });
  it("registro ilegível ou incompleto = null (nunca vira job vivo)", () => {
    assert.equal(parseJobRecord("{"), null);
    assert.equal(parseJobRecord(JSON.stringify({ job: "build" })), null);
    assert.equal(parseJobRecord(JSON.stringify(rec({ state: "done" }))), null, "done sem exit_code");
    assert.deepEqual(parseJobRecord(JSON.stringify(rec())), rec());
  });
  it("running só com o wrapper ou o filho vivos nesta máquina; senão stale", () => {
    assert.equal(classifyJob(rec(), ctx([100])), "running");
    assert.equal(classifyJob(rec({ child_pid: 200 }), ctx([200])), "running", "filho sobrevive ao wrapper");
    assert.equal(classifyJob(rec({ child_pid: 200 }), ctx([])), "stale");
    assert.equal(classifyJob(rec({ state: "done", exit_code: 0 }), ctx()), "done-ok");
    assert.equal(classifyJob(rec({ state: "done", exit_code: 3 }), ctx()), "done-fail");
  });
  it("registro de outra máquina: vivo por até 3 h, depois stale", () => {
    const other = rec({ host: "outra" });
    assert.equal(classifyJob(other, ctx([], Date.parse("2026-11-26T12:00:00Z"))), "running");
    assert.equal(classifyJob(other, ctx([], Date.parse("2026-11-26T13:00:00Z"))), "stale");
  });
  it("decideLaunch: vivo + mesmos args = attach; vivo + outros = busy; morto/terminado/ausente = launch", () => {
    assert.deepEqual(decideLaunch(null, ["build", "261126"], ctx()), { action: "launch", previous: "none" });
    assert.equal(decideLaunch(rec(), ["build", "261126"], ctx([100])).action, "attach");
    assert.equal(decideLaunch(rec(), ["build", "261126", "--no-audio-gain"], ctx([100])).action, "busy");
    assert.deepEqual(decideLaunch(rec(), ["build", "261126"], ctx([])), { action: "launch", previous: "stale" });
    assert.deepEqual(decideLaunch(rec({ state: "done", exit_code: 1 }), ["build", "261126"], ctx([100])), { action: "launch", previous: "done-fail" });
  });
});

describe("#14118 CLI run/status (spawn falso)", () => {
  it("run lança uma vez, repassa a saída, grava done com o exit code e o status lê", async () => {
    const s = sandbox();
    try {
      const out: string[] = [];
      const spawned: string[][] = [];
      const code = await main(["run", "build", "261126", "--seq", "youtube"], {
        base: s.base,
        host: HOST,
        pid: 100,
        out: (x) => out.push(x),
        err: (x) => out.push(x),
        spawnMontagem: (argv) => {
          spawned.push(argv);
          const f = fakeChild(0, "XML gravado\n");
          f.finish();
          return f.child;
        },
      });
      assert.equal(code, 0);
      assert.deepEqual(spawned, [["build", "261126", "--seq", "youtube"]], "argumentos repassados como estão");
      assert.ok(out.join("").includes("XML gravado"));
      const r = readJobRecord(jobRecordPath("261126", "build-youtube", s.base));
      assert.equal(r?.state, "done");
      assert.equal(r?.exit_code, 0);
      assert.equal(r?.child_pid, 4242);
      assert.ok(readFileSync(r!.log_path, "utf8").includes("XML gravado"), "saída também no log do job");

      const st: string[] = [];
      assert.equal(await main(["status", "261126", "--cmd", "build", "--seq", "youtube"], { base: s.base, host: HOST, out: (x) => st.push(x) }), 0);
      assert.ok(st.join("").includes("done-ok"));
      assert.equal(await main(["status", "261126", "--cmd", "preview"], { base: s.base, host: HOST, out: () => {} }), JOB_NONE_EXIT_CODE);
    } finally {
      s.done();
    }
  });

  it("exit code do subcomando passa adiante (falha = done-fail, status 1)", async () => {
    const s = sandbox();
    try {
      const code = await main(["run", "face", "261126"], {
        base: s.base,
        host: HOST,
        out: () => {},
        err: () => {},
        spawnMontagem: () => {
          const f = fakeChild(3);
          f.finish();
          return f.child;
        },
      });
      assert.equal(code, 3);
      assert.equal(await main(["status", "261126", "--cmd", "face"], { base: s.base, host: HOST, out: () => {} }), 1);
    } finally {
      s.done();
    }
  });

  it("retomada: job vivo com os mesmos args NÃO lança outro; espera e devolve o exit code dele", async () => {
    const s = sandbox();
    try {
      const path = jobRecordPath("261126", "preview", s.base);
      const logPath = join(s.base, "preview.log");
      writeFileSync(logPath, "prévia 50%\nprévia gravada\n");
      writeJobRecord(path, rec({ job: "preview", cmd: "preview", argv: ["preview", "261126"], pid: 100, log_path: logPath }));
      let polls = 0;
      const out: string[] = [];
      const code = await main(["run", "preview", "261126"], {
        base: s.base,
        host: HOST,
        isPidAlive: (p) => p === 100,
        out: (x) => out.push(x),
        pollMs: 0,
        spawnMontagem: () => assert.fail("não pode lançar um segundo job"),
        sleep: async () => {
          polls++;
          // o job em andamento termina durante a espera
          const cur = readJobRecord(path)!;
          writeJobRecord(path, { ...cur, state: "done", exit_code: 0, finished_at: "2026-11-26T10:05:00.000Z" });
        },
      });
      assert.equal(code, 0);
      assert.equal(polls, 1);
      assert.ok(out.join("").includes("não lanço outro"));
      assert.ok(out.join("").includes("prévia gravada"), "mostra o fim do log do job");
    } finally {
      s.done();
    }
  });

  it("job vivo com outros args: recusa com exit 5, sem lançar; status sai 3 (rodando)", async () => {
    const s = sandbox();
    try {
      writeJobRecord(jobRecordPath("261126", "build", s.base), rec());
      const err: string[] = [];
      const code = await main(["run", "build", "261126", "--no-audio-gain"], {
        base: s.base,
        host: HOST,
        isPidAlive: (p) => p === 100,
        err: (x) => err.push(x),
        spawnMontagem: () => assert.fail("não pode lançar"),
      });
      assert.equal(code, JOB_BUSY_EXIT_CODE);
      assert.ok(err.join("").includes("outros argumentos"));
      assert.equal(await main(["status", "261126", "--cmd", "build"], { base: s.base, host: HOST, isPidAlive: (p) => p === 100, out: () => {} }), JOB_RUNNING_EXIT_CODE);
      assert.equal(await main(["status", "261126"], { base: s.base, host: HOST, isPidAlive: (p) => p === 100, out: () => {} }), JOB_RUNNING_EXIT_CODE);
    } finally {
      s.done();
    }
  });

  it("job morto sem fim gravado (sessão caiu): o próximo run relança", async () => {
    const s = sandbox();
    try {
      writeJobRecord(jobRecordPath("261126", "review", s.base), rec({ job: "review", cmd: "review", argv: ["review", "261126"] }));
      let launched = 0;
      const out: string[] = [];
      const code = await main(["run", "review", "261126"], {
        base: s.base,
        host: HOST,
        isPidAlive: () => false,
        out: (x) => out.push(x),
        err: () => {},
        spawnMontagem: () => {
          launched++;
          const f = fakeChild(0);
          f.finish();
          return f.child;
        },
      });
      assert.equal(code, 0);
      assert.equal(launched, 1);
      assert.ok(out.join("").includes("job morto"));
    } finally {
      s.done();
    }
  });

  it("uso inválido sai 2 sem gravar nada (subcomando fora da lista, edição ausente)", async () => {
    const s = sandbox();
    try {
      const quiet = { base: s.base, out: () => {}, err: () => {}, spawnMontagem: () => assert.fail("não lança") };
      assert.equal(await main(["run", "upload", "261126"], quiet), 2);
      assert.equal(await main(["run", "build"], quiet), 2);
      assert.equal(await main(["status"], quiet), 2);
      assert.equal(await main([], quiet), 2);
      assert.equal(existsSync(join(s.base, "diaria-video-montagem-jobs")), false);
    } finally {
      s.done();
    }
  });
});
