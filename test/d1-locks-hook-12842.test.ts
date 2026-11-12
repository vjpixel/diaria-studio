/**
 * test/d1-locks-hook-12842.test.ts — lado hook dos locks em D1 (#12842).
 *
 * 1. Paridade: o SQL do hook (`.claude/hooks/lib/d1-locks.mjs`) é o MESMO
 *    texto do `scripts/lib/d1-locks.ts`.
 * 2. Biblioteca do hook contra o D1 falso (SQLite em memória).
 * 3. Guard de merge ponta a ponta: o hook roda como subprocesso contra um D1
 *    falso servido em 127.0.0.1 (`DIARIA_D1_API_BASE`, só loopback) e decide
 *    pelo holder do D1, pela marca de consumo da concessão, e cai no lock
 *    local quando o D1 não responde.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import * as ts from "../scripts/lib/d1-locks.ts";
import * as hook from "../.claude/hooks/lib/d1-locks.mjs";
import { machineTag, sessionsDir } from "../scripts/lib/session-registry.ts";
import { withIsolatedGhConfig } from "./helpers/isolated-gh-config.ts";
import { createFakeD1, type FakeD1 } from "./_helpers/fake-d1.ts";

const HOOK_PATH = fileURLToPath(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url));
const CONSUME_HOOK_PATH = fileURLToPath(new URL("../.claude/hooks/consume-merge-grant-on-merge.mjs", import.meta.url));
const SESSION_REGISTRY_CLI = fileURLToPath(new URL("../scripts/lib/session-registry.ts", import.meta.url));
const { combineWithD1LockHolders } = hook;
type Holder = string | null | undefined;
// Hook sem `.d.mts`: import por URL computada (evita TS7016 na catraca).
const guard = (await import(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url).href)) as {
  combineMergeLockHoldersWithD1: (local: Holder[], d1ByRepo: Array<Array<string | null>>, caller: string) => Holder;
};

describe("combineWithD1LockHolders", () => {
  it("holder de outra sessão no D1 vence o arquivo", () => {
    assert.equal(combineWithD1LockHolders(null, ["outra"], "eu"), "outra");
    assert.equal(combineWithD1LockHolders("eu", ["outra"], "eu"), "outra");
  });
  it("D1 livre nunca apaga o hold do arquivo (lock tomado no fallback)", () => {
    assert.equal(combineWithD1LockHolders("eu", [null], "eu"), "eu");
    assert.equal(combineWithD1LockHolders("outra", [null], "eu"), "outra");
  });
  it("D1 da própria chamadora vale (o D1 é a autoridade quando responde)", () => {
    assert.equal(combineWithD1LockHolders(null, ["eu"], "eu"), "eu");
    assert.equal(combineWithD1LockHolders(undefined, ["eu"], "eu"), "eu");
    assert.equal(combineWithD1LockHolders("outra", ["eu"], "eu"), "eu", "arquivo defasado não veta o D1");
  });
  it("sem resposta do D1 = só o arquivo", () => {
    assert.equal(combineWithD1LockHolders(null, [], "eu"), null);
    assert.equal(combineWithD1LockHolders(undefined, [], "eu"), undefined);
  });
});

describe("combineMergeLockHoldersWithD1 (guard, N repos) — #12842 review P1-b", () => {
  it("lock do 1º repo não cobre o 2º: arquivo [eu, livre] + D1 [eu, livre] = sem lock (bloqueia)", () => {
    assert.equal(guard.combineMergeLockHoldersWithD1(["eu", null], [["eu"], [null]], "eu"), null);
  });
  it("leitura do D1 que falhou num repo não desloca os outros (posição por repo)", () => {
    // repo 1: D1 falhou (`[]`), arquivo livre; repo 2: D1 diz eu. Sem posição, o
    // "eu" do repo 2 cobriria o repo 1.
    assert.equal(guard.combineMergeLockHoldersWithD1([null, null], [[], ["eu"]], "eu"), null);
  });
  it("os dois repos com o lock da chamadora (arquivo ou D1) = chamadora", () => {
    assert.equal(guard.combineMergeLockHoldersWithD1(["eu", null], [["eu"], ["eu"]], "eu"), "eu");
  });
  it("outra sessão em qualquer repo vence", () => {
    assert.equal(guard.combineMergeLockHoldersWithD1(["eu", "eu"], [["eu"], ["outra"]], "eu"), "outra");
  });
});

describe("paridade TS × hook", () => {
  it("mesmo SQL e mesmos nomes", () => {
    assert.equal(hook.ACQUIRE_SQL, ts.ACQUIRE_SQL);
    assert.equal(hook.READ_SQL, ts.READ_SQL);
    assert.equal(hook.NOW_MS_SQL, ts.NOW_MS_SQL);
    assert.equal(hook.MERGE_GRANT_CONSUMED_D1_TTL_MS, ts.MERGE_GRANT_CONSUMED_D1_TTL_MS);
    assert.equal(hook.mergeLockD1Name("A/B"), ts.mergeLockD1Name("A/B"));
    const g = { grantedBy: "c", grantedTo: "b", grantedAt: "2026-11-11T00:00:00.000Z" };
    assert.equal(hook.mergeGrantConsumedD1Name(g), ts.mergeGrantConsumedD1Name(g));
    assert.equal(hook.loopbackApiBase({ DIARIA_D1_API_BASE: "http://127.0.0.1:1" }), ts.loopbackApiBase({ DIARIA_D1_API_BASE: "http://127.0.0.1:1" }));
    for (const e of [new Error("fetch failed"), new ts.D1HttpError("x", 403), new ts.D1HttpError("x", 503), new Error("no such table: locks")]) {
      assert.equal(hook.isPermanentD1Error(e), ts.isPermanentD1Error(e), e.message);
    }
  });
});

describe("biblioteca do hook", () => {
  it("lê holder vivo e ignora vencido; marca de uso único", async () => {
    const d1 = createFakeD1();
    await ts.d1AcquireLock(d1, "n", "A", 60_000);
    assert.deepEqual(await hook.d1ReadLockHolder(d1, "n"), { ok: true, value: "A" });
    d1.db.prepare("UPDATE locks SET expires_at = 1 WHERE name = 'n'").run();
    assert.deepEqual(await hook.d1ReadLockHolder(d1, "n"), { ok: true, value: null });
    assert.deepEqual(await hook.d1ClaimOnce(d1, "m", "S", 60_000), { ok: true, value: "claimed" });
    assert.deepEqual(await hook.d1ClaimOnce(d1, "m", "S", 60_000), { ok: true, value: "already" });
    const down = { query: async () => Promise.reject(new Error("offline")) };
    const r = await hook.d1ReadLockHolder(down, "n");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.permanent, false);
  });

  it("timeout: fetch pendurado que honra o signal falha em tempo limitado (transitório)", async () => {
    const client = hook.createD1RestClient({
      accountId: "a",
      token: "t",
      databaseId: "d",
      timeoutMs: 50,
      fetchFn: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    });
    const t0 = Date.now();
    const r = await hook.d1ReadLockHolder(client, "n");
    assert.ok(Date.now() - t0 < 2000);
    assert.ok(!r.ok && !r.permanent);
  });

  it("platform.config.json ilegível: motivo explícito (nunca desliga o D1 em silêncio)", () => {
    const root = mkdtempSync(join(tmpdir(), "d1-hook-badcfg-"));
    try {
      writeFileSync(join(root, "platform.config.json"), "{ quebrado");
      const r = hook.d1LocksClientForHook(root, {}, async () => new Response("{}"));
      assert.equal(r.client, null);
      assert.match(r.reason, /platform\.config\.json ilegível/);
      const tsReasons: string[] = [];
      assert.equal(ts.d1LocksClientFromRepo(root, { DIARIA_D1_API_BASE: "http://127.0.0.1:1" }, (m) => tsReasons.push(m)), null);
      assert.match(tsReasons[0] ?? "", /platform\.config\.json ilegível/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolução: sem banco = silencioso; banco sem credencial = motivo; .env completa o ambiente", () => {
    const root = mkdtempSync(join(tmpdir(), "d1-hook-cfg-"));
    try {
      const fetchFn = async () => new Response("{}");
      assert.deepEqual(hook.d1LocksClientForHook(root, {}, fetchFn), { client: null, reason: "" });
      writeFileSync(join(root, "platform.config.json"), JSON.stringify({ d1_locks: { database_id: "db" } }));
      const missing = hook.d1LocksClientForHook(root, {}, fetchFn);
      assert.equal(missing.client, null);
      assert.match(missing.reason, /credenciais/);
      writeFileSync(join(root, ".env"), 'CLOUDFLARE_ACCOUNT_ID=acc\nCLOUDFLARE_API_TOKEN="tok"\n');
      assert.ok(hook.d1LocksClientForHook(root, {}, fetchFn).client);
      assert.equal(hook.d1LocksClientForHook(root, { DIARIA_D1_LOCKS: "off" }, fetchFn).client, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("DIARIA_D1_API_BASE só aceita loopback", () => {
    assert.equal(hook.loopbackApiBase({ DIARIA_D1_API_BASE: "http://127.0.0.1:8787" }), "http://127.0.0.1:8787");
    assert.equal(hook.loopbackApiBase({ DIARIA_D1_API_BASE: "https://evil.example" }), null);
    assert.equal(hook.loopbackApiBase({ DIARIA_D1_API_BASE: "http://127.0.0.1.evil.example" }), null);
  });
});

// ─── guard ponta a ponta ────────────────────────────────────────────────────

interface FakeServer {
  base: string;
  d1: FakeD1;
  mode: { fail: boolean; hang: boolean };
  server: Server;
}

async function startFakeD1Server(): Promise<FakeServer> {
  const d1 = createFakeD1();
  const mode = { fail: false, hang: false };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      // Pendura a requisição: o cliente decide pelo timeout dele.
      if (mode.hang) return;
      if (mode.fail) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: false, errors: [{ code: 7500, message: "simulado" }] }));
        return;
      }
      try {
        const { sql, params } = JSON.parse(body) as { sql: string; params: string[] };
        const r = await d1.query(sql, params);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, result: [{ success: true, results: r.results, meta: { served_by_primary: true } }] }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: false, errors: [{ code: 1, message: String(e) }] }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, d1, mode, server };
}

describe("guard de merge com D1 (ponta a ponta)", () => {
  const roots: string[] = [];
  let srv: FakeServer;

  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    srv?.server.closeAllConnections();
    srv?.server.close();
  });

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "d1-guard-e2e-"));
    roots.push(root);
    mkdirSync(sessionsDir(root), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "platform.config.json"), JSON.stringify({ d1_locks: { database_id: "fake-db" } }));
    const tag = machineTag();
    const now = new Date().toISOString();
    // Coordenadora ativa (é ela quem chama o merge) segurando o lock LOCAL.
    writeFileSync(
      join(sessionsDir(root), `overnight-${tag}-coord-1.json`),
      JSON.stringify({ kind: "overnight", sessionId: "coord-1", machineTag: tag, lastHeartbeat: now, startedAt: now }),
    );
    writeFileSync(join(sessionsDir(root), ".merge-lock.json"), JSON.stringify({ heldBy: "coord-1", acquiredAt: now }));
    return root;
  }

  function hookEnv(): NodeJS.ProcessEnv {
    return {
      ...withIsolatedGhConfig(),
      DIARIA_D1_API_BASE: srv.base,
      CLOUDFLARE_ACCOUNT_ID: "acc",
      CLOUDFLARE_API_TOKEN: "tok",
    };
  }

  function runNode(
    args: string[],
    root: string,
    input: string,
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, args, { cwd: root, env: hookEnv() });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(input);
    });
  }

  const MERGE_CMD = "gh pr merge 12842 --squash -R vjpixel/diaria-studio";

  function runConsumeHook(root: string, sessionId: string) {
    return runNode([CONSUME_HOOK_PATH], root, JSON.stringify({ session_id: sessionId, tool_name: "Bash", tool_input: { command: MERGE_CMD } }));
  }

  function runRegistryCli(root: string, args: string[]) {
    // cwd é o checkout falso (tmp): o loader do tsx vai por URL absoluta.
    return runNode(["--import", import.meta.resolve("tsx"), SESSION_REGISTRY_CLI, ...args], root, "");
  }

  /** Coordenadora coord-1 concede a sess-x (sem PR); sess-x segura o lock local. */
  function writeGrant(root: string, grant: { grantedBy: string; grantedTo: string; grantedAt: string }): void {
    const tag = machineTag();
    const now = new Date().toISOString();
    writeFileSync(
      join(sessionsDir(root), `overnight-${tag}-coord-1.json`),
      JSON.stringify({ kind: "overnight", sessionId: "coord-1", machineTag: tag, lastHeartbeat: now, startedAt: now, merge_grant: grant }),
    );
    writeFileSync(
      join(sessionsDir(root), `interactive-${tag}-sess-x.json`),
      JSON.stringify({ kind: "interactive", sessionId: "sess-x", machineTag: tag, lastHeartbeat: now, startedAt: now }),
    );
    writeFileSync(join(sessionsDir(root), ".merge-lock.json"), JSON.stringify({ heldBy: "sess-x", acquiredAt: now }));
  }

  function runHook(root: string, sessionId: string): Promise<{ status: number | null; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [HOOK_PATH], {
        cwd: root,
        env: {
          ...withIsolatedGhConfig(),
          DIARIA_D1_API_BASE: srv.base,
          CLOUDFLARE_ACCOUNT_ID: "acc",
          CLOUDFLARE_API_TOKEN: "tok",
        },
      });
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.on("close", (status) => resolve({ status, stdout }));
      child.stdin.end(
        JSON.stringify({ session_id: sessionId, tool_name: "Bash", tool_input: { command: "gh pr merge 12842 --squash -R vjpixel/diaria-studio" } }),
      );
    });
  }

  it("sem linha no D1: decide o lock local (coordenadora com o próprio lock → permite)", async () => {
    srv = await startFakeD1Server();
    const root = makeRoot();
    const res = await runHook(root, "coord-1");
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "", `esperava permitir, veio: ${res.stdout}`);
  });

  it("lock vivo de OUTRA máquina no D1 → bloqueia (o arquivo local não enxergava)", async () => {
    srv.d1.db.exec("DELETE FROM locks");
    await ts.d1AcquireLock(srv.d1, ts.mergeLockD1Name("vjpixel/diaria-studio"), "coord-de-outra-maquina", 120_000);
    const root = makeRoot();
    const res = await runHook(root, "coord-1");
    assert.equal(res.status, 0);
    assert.ok(res.stdout.trim() !== "", "esperava bloqueio");
    assert.equal(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, "deny");
  });

  it("D1 fora do ar → fallback local (permite), aviso visível (systemMessage) e rastro no run-log", async () => {
    srv.mode.fail = true;
    try {
      const root = makeRoot();
      const res = await runHook(root, "coord-1");
      const out = res.stdout.trim() === "" ? {} : JSON.parse(res.stdout);
      assert.equal(out.hookSpecificOutput, undefined, `D1 fora do ar não pode bloquear: ${res.stdout}`);
      assert.match(String(out.systemMessage), /D1 sem resposta/);
      const log = readFileSync(join(root, "data", "run-log.jsonl"), "utf8");
      assert.match(log, /d1_lock_read_failed/);
    } finally {
      srv.mode.fail = false;
    }
  });

  it("D1 pendurado → decide pelo arquivo dentro do timeout e loga d1_lock_read_failed", async () => {
    srv.mode.hang = true;
    try {
      const root = makeRoot();
      const t0 = Date.now();
      const res = await runHook(root, "coord-1");
      assert.ok(Date.now() - t0 < 9000, `o hook tem 10 s no settings; levou ${Date.now() - t0} ms`);
      const out = res.stdout.trim() === "" ? {} : JSON.parse(res.stdout);
      assert.equal(out.hookSpecificOutput, undefined, `timeout do D1 não pode bloquear: ${res.stdout}`);
      const log = readFileSync(join(root, "data", "run-log.jsonl"), "utf8");
      assert.match(log, /d1_lock_read_failed/);
    } finally {
      srv.mode.hang = false;
    }
  });

  it("consume hook (máquina A) + guard (máquina B): mesma marca no D1, 2ª tentativa bloqueada; consumo duplo alarma", async () => {
    srv.d1.db.exec("DELETE FROM locks");
    const grant = { grantedBy: "coord-1", grantedTo: "sess-x", grantedAt: new Date().toISOString() };
    const a = makeRoot();
    const b = makeRoot();
    writeGrant(a, grant);
    writeGrant(b, grant); // cópia de B ainda sem o consumo (sync atrasado)

    const before = await runHook(b, "sess-x");
    assert.equal(before.stdout.trim(), "", `antes do consumo B permite: ${before.stdout}`);

    await runConsumeHook(a, "sess-x");
    const marker = await ts.d1ReadLock(srv.d1, ts.mergeGrantConsumedD1Name(grant));
    assert.ok(marker.ok && marker.value?.holder === "sess-x", "o consume hook gravou a marca com o MESMO nome que o guard lê");

    const after2 = await runHook(b, "sess-x");
    assert.ok(after2.stdout.trim() !== "", "consumida em A: B tem de bloquear");
    assert.equal(JSON.parse(after2.stdout).hookSpecificOutput.permissionDecision, "deny");

    // B consome a cópia local da mesma concessão: o D1 já tinha a marca → consumo duplo.
    const dup = await runConsumeHook(b, "sess-x");
    assert.match(dup.stderr, /consumo duplo/);
    assert.match(readFileSync(join(b, "data", "run-log.jsonl"), "utf8"), /merge_grant_double_consumed/);
  });

  it("CLI session-registry: consume-merge-grant na máquina A → check-merge-grant na B diz granted:false", async () => {
    srv.d1.db.exec("DELETE FROM locks");
    const grant = { grantedBy: "coord-1", grantedTo: "sess-x", grantedAt: new Date().toISOString() };
    const a = makeRoot();
    const b = makeRoot();
    writeGrant(a, grant);
    writeGrant(b, grant);

    const checkBefore = await runRegistryCli(b, ["check-merge-grant", "--session-id", "sess-x"]);
    assert.equal(JSON.parse(checkBefore.stdout).granted, true, `${checkBefore.stdout}${checkBefore.stderr}`);

    const consumed = await runRegistryCli(a, ["consume-merge-grant", "--session-id", "sess-x"]);
    assert.equal(consumed.status, 0, consumed.stderr);
    const marker = await ts.d1ReadLock(srv.d1, ts.mergeGrantConsumedD1Name(grant));
    assert.ok(marker.ok && marker.value !== null, `marca no D1 não gravada: ${consumed.stderr}`);

    const checkAfter = await runRegistryCli(b, ["check-merge-grant", "--session-id", "sess-x"]);
    assert.equal(JSON.parse(checkAfter.stdout).granted, false, `${checkAfter.stdout}${checkAfter.stderr}`);
    assert.match(checkAfter.stderr, /D1 registra o consumo/);
  });

  it("concessão viva no arquivo mas consumida no D1 → tratada como consumida (bloqueia)", async () => {
    srv.d1.db.exec("DELETE FROM locks");
    const root = makeRoot();
    const tag = machineTag();
    const now = new Date().toISOString();
    const grant = { grantedBy: "coord-1", grantedTo: "sess-x", grantedAt: now };
    // coord-1 concede a sess-x; sess-x segura o lock local.
    writeFileSync(
      join(sessionsDir(root), `overnight-${tag}-coord-1.json`),
      JSON.stringify({ kind: "overnight", sessionId: "coord-1", machineTag: tag, lastHeartbeat: now, startedAt: now, merge_grant: grant }),
    );
    writeFileSync(
      join(sessionsDir(root), `interactive-${tag}-sess-x.json`),
      JSON.stringify({ kind: "interactive", sessionId: "sess-x", machineTag: tag, lastHeartbeat: now, startedAt: now }),
    );
    writeFileSync(join(sessionsDir(root), ".merge-lock.json"), JSON.stringify({ heldBy: "sess-x", acquiredAt: now }));

    const before = await runHook(root, "sess-x");
    assert.equal(
      before.stdout.trim(),
      "",
      `concessão viva + lock: esperava permitir; ${before.stdout.slice(-400)} run-log: ${readFileSync(join(root, "data", "run-log.jsonl"), "utf8").slice(-900)}`,
    );

    await ts.d1AcquireLock(srv.d1, ts.mergeGrantConsumedD1Name(grant), "sess-x", ts.MERGE_GRANT_CONSUMED_D1_TTL_MS);
    const after = await runHook(root, "sess-x");
    assert.ok(after.stdout.trim() !== "", "consumida no D1: esperava bloqueio");
    assert.equal(JSON.parse(after.stdout).hookSpecificOutput.permissionDecision, "deny");
  });
});
