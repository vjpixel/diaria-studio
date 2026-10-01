/**
 * test/hook-registry-lock-delete-pending-9280.test.ts (#9280)
 *
 * Regressão: `tryAcquireOwnedLock` (`.claude/hooks/lib/registry-lock.mjs`)
 * disputa o MESMO `.lock` que `scripts/lib/file-lock.ts`, mas só tratava
 * EEXIST como contenção. No Windows, o unlink do dono com outro processo
 * segurando o arquivo aberto deixa o nome em delete-pending e o `open(wx)`
 * lança EPERM/EACCES — o hook tratava como falha dura. O lado TS foi corrigido
 * no #9194; este teste trava a mesma política no hook e a paridade das
 * constantes/predicado com a fonte canônica.
 *
 * Determinístico: injeta plataforma e `open(wx)` — não depende de corrida.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tryAcquireOwnedLock,
  isDeletePendingWxError as isDeletePendingMjs,
  DELETE_PENDING_MAX_STREAK as STREAK_MJS,
  DELETE_PENDING_WAIT_MS as WAIT_MJS,
  isDeletePendingExhausted,
} from "../.claude/hooks/lib/registry-lock.mjs";
import { isDeletePendingWxError, DELETE_PENDING_MAX_STREAK, DELETE_PENDING_WAIT_MS } from "../scripts/lib/file-lock.ts";
import { grantMergeWindow, machineTag, registerSession } from "../scripts/lib/session-registry.ts";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Os dois hooks não têm `.d.mts`; um import estático deles seria TS7016 (o
// ratchet de typecheck reprova chave nova). Carrega por especificador não
// literal e tipa só a superfície que este teste usa.
const HOOKS_DIR = join(import.meta.dirname, "..", ".claude", "hooks");
const BEACON_HOOK = join(HOOKS_DIR, "session-beacon.mjs");
interface ConsumerHook {
  classifyConsumeError(e: unknown): string;
  consumeGrantUnderLock(
    repoRoot: string, sessionId: string, nowIso?: string, attempts?: number, lockTimeoutMs?: number,
    targetPr?: number, opts?: { acquire?: (lockPath: string) => boolean },
  ): boolean;
  findLiveMergeGrantFile(repoRoot: string, sessionId: string): unknown;
}
interface BeaconHook {
  logBeaconLockErrorOnce(repoRoot: string, sessionId: string, err: unknown, deps?: { markerDir?: string }): boolean;
}
const consumerUrl: string = pathToFileURL(join(HOOKS_DIR, "consume-merge-grant-on-merge.mjs")).href;
const beaconUrl: string = pathToFileURL(BEACON_HOOK).href;
const { classifyConsumeError, consumeGrantUnderLock, findLiveMergeGrantFile } = (await import(consumerUrl)) as ConsumerHook;
const { logBeaconLockErrorOnce } = (await import(beaconUrl)) as BeaconHook;

const dir = mkdtempSync(join(tmpdir(), "reglock-9280-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated, open`), { code });
}

/** `open(wx)` que falha com `codes` em sequência e depois abre de verdade. */
function failingThenReal(codes: string[]) {
  let calls = 0;
  return {
    get calls() { return calls; },
    openWx: (p: string) => {
      const c = codes[calls++];
      if (c) throw errno(c);
      return openSync(p, "wx");
    },
  };
}

describe("registry-lock.mjs — delete-pending no Windows (#9280)", () => {
  it("paridade com file-lock.ts: mesmo teto de sequência, mesma espera e mesmo predicado", () => {
    assert.equal(STREAK_MJS, DELETE_PENDING_MAX_STREAK);
    assert.equal(WAIT_MJS, DELETE_PENDING_WAIT_MS);
    for (const platform of ["win32", "linux", "darwin"] as NodeJS.Platform[]) {
      for (const code of ["EPERM", "EACCES", "EEXIST", "ENOENT", "ENOSPC", undefined]) {
        assert.equal(isDeletePendingMjs(code, platform), isDeletePendingWxError(code, platform), `${platform}/${code}`);
      }
    }
  });

  it("win32: EPERM/EACCES transitório é contenção — adquire e grava o dono", () => {
    const lock = join(dir, "a.lock");
    const fake = failingThenReal(["EPERM", "EACCES", "EPERM"]);
    assert.equal(tryAcquireOwnedLock(lock, { platform: "win32", openWx: fake.openWx }), true);
    assert.equal(fake.calls, 4);
    const owner = JSON.parse(readFileSync(lock, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.equal(typeof owner.token, "string");
    unlinkSync(lock);
  });

  it("win32: exatamente DELETE_PENDING_MAX_STREAK EPERMs seguidos ainda adquire (limite inclusivo)", () => {
    const lock = join(dir, "b.lock");
    const fake = failingThenReal(Array(DELETE_PENDING_MAX_STREAK).fill("EPERM"));
    assert.equal(tryAcquireOwnedLock(lock, { platform: "win32", openWx: fake.openWx }), true);
    assert.equal(fake.calls, DELETE_PENDING_MAX_STREAK + 1);
    unlinkSync(lock);
  });

  it("win32: EPERM persistente propaga rápido com code e cause", () => {
    const lock = join(dir, "c.lock");
    const fake = failingThenReal(Array(1000).fill("EPERM"));
    const t0 = Date.now();
    assert.throws(
      () => tryAcquireOwnedLock(lock, { platform: "win32", openWx: fake.openWx }),
      (e: NodeJS.ErrnoException) =>
        e.code === "EPERM" &&
        /EPERM persistiu por \d+ tentativas seguidas em .*c\.lock — provável permissão real, não delete-pending \(#9194\)/.test(e.message) &&
        (e.cause as NodeJS.ErrnoException)?.code === "EPERM" &&
        isDeletePendingExhausted(e),
    );
    assert.equal(fake.calls, DELETE_PENDING_MAX_STREAK + 1);
    assert.ok(Date.now() - t0 < 3_000);
    assert.ok(!existsSync(lock));
  });

  it("win32: EEXIST no meio da sequência devolve false (contenção normal)", () => {
    const lock = join(dir, "d.lock");
    const fake = failingThenReal(["EPERM", "EPERM", "EEXIST"]);
    assert.equal(tryAcquireOwnedLock(lock, { platform: "win32", openWx: fake.openWx }), false);
    assert.equal(fake.calls, 3);
    assert.ok(!existsSync(lock));
  });

  it("fora do win32: EPERM/EACCES propaga na hora (#6952 inalterado)", () => {
    for (const code of ["EPERM", "EACCES"]) {
      const fake = failingThenReal([code]);
      assert.throws(
        () => tryAcquireOwnedLock(join(dir, "e.lock"), { platform: "linux", openWx: fake.openWx }),
        (e: NodeJS.ErrnoException) => e.code === code && !/persistiu/.test(e.message) && !isDeletePendingExhausted(e),
      );
      assert.equal(fake.calls, 1);
    }
  });

  it("win32: erro que não é delete-pending (ENOENT) propaga na hora", () => {
    const fake = failingThenReal(["ENOENT"]);
    assert.throws(
      () => tryAcquireOwnedLock(join(dir, "f.lock"), { platform: "win32", openWx: fake.openWx }),
      (e: NodeJS.ErrnoException) => e.code === "ENOENT",
    );
    assert.equal(fake.calls, 1);
  });

  it("sem deps (produção): EEXIST real devolve false", () => {
    const lock = join(dir, "g.lock");
    assert.equal(tryAcquireOwnedLock(lock), true);
    assert.equal(tryAcquireOwnedLock(lock), false);
    unlinkSync(lock);
  });
});

// ── Rastro quando a concessão de merge não é consumida (#9280) ─────────────
// Antes, qualquer falha do lock/CAS em `consumeOneUnderLock` caía num
// `catch {}` vazio: o grant ficava vivo até o TTL sem sinal nenhum.

function readRunLog(root: string): Array<Record<string, any>> {
  const p = join(root, "data", "run-log.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function makeGrantRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "grant-9280-"));
  mkdirSync(join(root, "data", "sessions"), { recursive: true });
  registerSession(root, "overnight", "coord", { tag: machineTag() });
  grantMergeWindow(root, "overnight", "coord", "interativa", {});
  return root;
}

describe("consume-merge-grant — rastro de concessão não consumida (#9280)", () => {
  it("EACCES no lock: devolve false, grant segue vivo e o run-log recebe UM aviso com o code", () => {
    const root = makeGrantRepo();
    try {
      let calls = 0;
      const acquire = () => { calls++; throw errno("EACCES"); };
      const nowIso = new Date().toISOString();
      assert.equal(consumeGrantUnderLock(root, "interativa", nowIso, 3, 50, undefined, { acquire }), false);
      assert.equal(calls, 3, "uma tentativa por volta de CAS");
      assert.ok(findLiveMergeGrantFile(root, "interativa"), "grant não consumido continua vivo");
      const events = readRunLog(root).filter((e) => e.agent === "consume-merge-grant");
      assert.equal(events.length, 1, "um único aviso, depois do laço");
      assert.equal(events[0].level, "warn");
      assert.equal(events[0].message, "merge_grant_not_consumed");
      assert.equal(events[0].details.code, "EACCES");
      assert.equal(events[0].details.attempts, 3);
      assert.ok(!JSON.stringify(events[0]).includes(root), "sem path absoluto no rastro");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifica delete-pending esgotado, timeout, CAS e JSON corrompido por propriedade estruturada", () => {
    const exhausted = Object.assign(new Error("x"), { code: "EPERM", deletePendingExhausted: true });
    assert.equal(classifyConsumeError(exhausted), "DELETE_PENDING_EXHAUSTED");
    assert.equal(classifyConsumeError(Object.assign(new Error("x"), { code: "LOCK_TIMEOUT" })), "LOCK_TIMEOUT");
    assert.equal(classifyConsumeError(Object.assign(new Error("x"), { code: "CAS_VERIFY_FAILED" })), "CAS_VERIFY_FAILED");
    assert.equal(classifyConsumeError(new SyntaxError("bad json")), "JSON_PARSE");
    assert.equal(classifyConsumeError(new Error("sem code")), "UNKNOWN");
    assert.equal(classifyConsumeError(null), "UNKNOWN");
  });

  it("lock sempre ocupado: o aviso sai com LOCK_TIMEOUT", () => {
    const root = makeGrantRepo();
    try {
      const nowIso = new Date().toISOString();
      assert.equal(consumeGrantUnderLock(root, "interativa", nowIso, 2, 20, undefined, { acquire: () => false }), false);
      const events = readRunLog(root).filter((e) => e.agent === "consume-merge-grant");
      assert.equal(events.length, 1);
      assert.equal(events[0].details.code, "LOCK_TIMEOUT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("session-beacon — rastro de EPERM/EACCES no lock (#9280)", () => {
  it("registra uma vez por sessão, só para EPERM/EACCES; falha ao criar o marcador = não loga", () => {
    const root = mkdtempSync(join(tmpdir(), "beacon-9280-"));
    try {
      const markerDir = join(root, "markers");
      mkdirSync(markerDir);
      const sid = `sess-9280-${process.pid}-${Date.now()}`;
      assert.equal(logBeaconLockErrorOnce(root, sid, Object.assign(new Error("x"), { code: "ENOENT" }), { markerDir }), false);
      assert.equal(logBeaconLockErrorOnce(root, sid, Object.assign(new Error("x"), { code: "EACCES" }), { markerDir }), true);
      assert.equal(logBeaconLockErrorOnce(root, sid, Object.assign(new Error("x"), { code: "EPERM" }), { markerDir }), false, "segunda vez na mesma sessão não repete");
      // Diretório do marcador inexistente: não consegue criar → não loga.
      assert.equal(logBeaconLockErrorOnce(root, "outra", Object.assign(new Error("x"), { code: "EPERM" }), { markerDir: join(root, "nao-existe") }), false);
      const events = readRunLog(root).filter((e) => e.agent === "session-beacon");
      assert.equal(events.length, 1);
      assert.equal(events[0].level, "warn");
      assert.equal(events[0].details.code, "EACCES");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("o marcador vale entre PROCESSOS: a 2ª invocação não registra; details traz syscall/path da origem", () => {
    // Cada chamada de ferramenta roda o hook num processo node novo — um
    // marcador em memória registraria a cada chamada (re-review do #9297).
    const root = mkdtempSync(join(tmpdir(), "beacon-9280-proc-"));
    try {
      const markerDir = join(root, "tmp");
      mkdirSync(markerDir);
      const sid = `sess-9280-proc-${process.pid}-${Date.now()}`;
      const code = [
        `const { logBeaconLockErrorOnce } = await import(${JSON.stringify(beaconUrl)});`,
        `const origin = Object.assign(new Error("raw"), { code: "EPERM", syscall: "rename", path: "/x/sessions/a.json" });`,
        `const err = Object.assign(new Error("wrapper", { cause: origin }), { code: "EPERM" });`,
        `process.stdout.write(String(logBeaconLockErrorOnce(process.env.BEACON_ROOT, process.env.BEACON_SID, err)));`,
      ].join("\n");
      // os.tmpdir() do filho aponta pro diretório isolado do teste.
      const env = { ...process.env, TMP: markerDir, TEMP: markerDir, TMPDIR: markerDir, BEACON_ROOT: root, BEACON_SID: sid };
      const run = () => spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8" });
      const first = run();
      assert.equal(first.status, 0, first.stderr);
      assert.equal(first.stdout, "true");
      assert.match(first.stderr, /EPERM ao gravar o registro/);
      const second = run();
      assert.equal(second.status, 0, second.stderr);
      assert.equal(second.stdout, "false", "2º processo da mesma sessão não registra");
      assert.equal(second.stderr, "");
      const events = readRunLog(root).filter((e) => e.agent === "session-beacon");
      assert.equal(events.length, 1);
      assert.equal(events[0].message, "beacon_registry_write_error");
      assert.deepEqual(events[0].details, { code: "EPERM", syscall: "rename", path: "/x/sessions/a.json" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
