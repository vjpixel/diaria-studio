/**
 * test/session-registry-merge-grant-d1-13242-13238.test.ts
 *
 * #13242 — a concessão de merge também vai para o D1. Cenário real (16/11/2026):
 * a overnight do `300` concedeu a janela da PR #13213 à interativa do Neo, mas
 * o registro da overnight no Neo estava parado na versão de 00:47 (sem o
 * `merge_grant`), e o TTL de 10 min venceu antes de o sync trazer a concessão.
 * Com o D1, o Neo enxerga a concessão na hora — com as mesmas regras do arquivo.
 *
 * #13238 — `claim-issue --kind develop` numa sessão interativa sem registro
 * auto-registrava a sessão como coordenadora develop.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import * as ts from "../scripts/lib/d1-locks.ts";
import * as hookLib from "../.claude/hooks/lib/d1-locks.mjs";
import {
  autoRegisterKindFor,
  claimIssueAutoRegistering,
  claimIssuesAutoRegistering,
  findLiveMergeGrant,
  findLiveMergeGrantInD1,
  grantMergeWindowShared,
  listActiveSessions,
  machineTag,
  MERGE_GRANT_TTL_MS,
  registerSession,
  sessionFilePath,
  sessionsDir,
  staleGrantorRegistrations,
  unclaimIssues,
  type ActiveSessionRecord,
} from "../scripts/lib/session-registry.ts";
import { createFakeD1, failingD1, type FakeD1 } from "./_helpers/fake-d1.ts";
import { withIsolatedGhConfig } from "./helpers/isolated-gh-config.ts";

const guard = (await import(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url).href)) as {
  acceptD1MergeGrant: (
    g: unknown,
    sessionId: string,
    scan: { ids: Set<string>; kinds: Map<string, string> },
    ledger: Map<string, string> | null,
    now?: number,
  ) => unknown;
};

const COORD = "072c4e96-overnight-300";
const NEO = "b2d3fdd8-interativa-neo";
const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "grant-d1-13242-"));
  roots.push(root);
  mkdirSync(sessionsDir(root), { recursive: true });
  return root;
}

/**
 * Registro da overnight do `300` como o Neo o vê: versão sem a concessão. A
 * tag nunca é a desta máquina (o teste pode rodar no próprio `300`).
 */
const GRANTOR_TAG = machineTag() === "srv300" ? "srv300b" : "srv300";
function grantorFile(kind = "overnight"): string {
  return `${kind}-${GRANTOR_TAG}-${COORD}.json`;
}
function writeGrantorAsSeenFromNeo(root: string, kind = "overnight", heartbeatAgoMs = 3 * 60_000): void {
  const hb = new Date(Date.now() - heartbeatAgoMs).toISOString();
  writeFileSync(
    join(sessionsDir(root), grantorFile(kind)),
    JSON.stringify({ kind, sessionId: COORD, machineTag: GRANTOR_TAG, startedAt: hb, lastHeartbeat: hb }),
  );
}

const silent = { warn: () => {} };

// ─── #13242: escrita ────────────────────────────────────────────────────────

describe("grantMergeWindowShared (#13242)", () => {
  it("coordenadora concede: grava no arquivo E no D1 (meta = a concessão)", async () => {
    const root = freshRoot();
    const d1 = createFakeD1();
    registerSession(root, "overnight", COORD, { tag: "300" });
    const r = await grantMergeWindowShared(root, "overnight", COORD, NEO, { pr: 13213, tag: "300" }, { d1, ...silent });
    assert.equal(r.ok, true);
    assert.equal(r.backend, "d1");
    const row = await ts.d1ReadMergeGrant(d1, NEO);
    assert.ok(row.ok && row.value, "linha da concessão no D1");
    assert.equal(row.value.grantedBy, COORD);
    assert.equal(row.value.pr, 13213);
    assert.equal(row.value.grantedAt, r.grant?.grantedAt, "mesma identidade do arquivo (a marca de consumo é a mesma)");
  });

  it("recusas do arquivo nunca chegam ao D1: interativa não concede, ninguém concede a si mesmo", async () => {
    const root = freshRoot();
    const d1 = createFakeD1();
    registerSession(root, "interactive", "sess-i", { tag: "300" });
    const notCoord = await grantMergeWindowShared(root, "interactive", "sess-i", NEO, {}, { d1, ...silent });
    assert.equal(notCoord.reason, "not-a-coordinator");
    registerSession(root, "overnight", COORD, { tag: "300" });
    const self = await grantMergeWindowShared(root, "overnight", COORD, COORD, {}, { d1, ...silent });
    assert.equal(self.reason, "self-grant-refused");
    assert.equal(d1.db.prepare("SELECT COUNT(*) AS n FROM locks").get()?.n, 0, "nenhuma linha gravada");
  });

  it("D1 fora do ar: a concessão local vale, com aviso de que só chega pelo sync", async () => {
    const root = freshRoot();
    registerSession(root, "overnight", COORD, { tag: "300" });
    const warns: string[] = [];
    const r = await grantMergeWindowShared(root, "overnight", COORD, NEO, { tag: "300" }, {
      d1: failingD1(),
      warn: (m) => warns.push(m),
    });
    assert.equal(r.ok, true);
    assert.equal(r.backend, "local-fallback");
    assert.match(warns.join(""), /só no arquivo/);
  });

  it("linha viva de OUTRA concedente para a mesma beneficiária: não sobrescreve sem --force", async () => {
    const root = freshRoot();
    const d1 = createFakeD1();
    const other = { grantedTo: NEO, grantedBy: "outra-coord", grantedAt: new Date().toISOString() };
    await ts.d1WriteMergeGrant(d1, other, MERGE_GRANT_TTL_MS);
    registerSession(root, "overnight", COORD, { tag: "300" });
    const warns: string[] = [];
    const r = await grantMergeWindowShared(root, "overnight", COORD, NEO, { tag: "300" }, { d1, warn: (m) => warns.push(m) });
    assert.equal(r.backend, "local-fallback");
    assert.match(warns.join(""), /outra-coord/);
    const row = await ts.d1ReadMergeGrant(d1, NEO);
    assert.ok(row.ok && row.value?.grantedBy === "outra-coord", "a linha da outra concedente ficou");
  });

  it("linha de outra concedente já CONSUMIDA é substituída", async () => {
    const root = freshRoot();
    const d1 = createFakeD1();
    const other = { grantedTo: NEO, grantedBy: "outra-coord", grantedAt: new Date().toISOString() };
    await ts.d1WriteMergeGrant(d1, other, MERGE_GRANT_TTL_MS);
    await ts.d1AcquireLock(d1, ts.mergeGrantConsumedD1Name(other), NEO, ts.MERGE_GRANT_CONSUMED_D1_TTL_MS);
    registerSession(root, "overnight", COORD, { tag: "300" });
    const r = await grantMergeWindowShared(root, "overnight", COORD, NEO, { tag: "300" }, { d1, ...silent });
    assert.equal(r.backend, "d1");
    const row = await ts.d1ReadMergeGrant(d1, NEO);
    assert.ok(row.ok && row.value?.grantedBy === COORD);
  });
});

// ─── #13242: leitura no Neo ─────────────────────────────────────────────────

describe("findLiveMergeGrantInD1 (#13242) — o Neo com o registro da concedente defasado", () => {
  async function grantIn300(d1: FakeD1, meta: { pr?: number; repo?: string } = { pr: 13213 }) {
    const root300 = freshRoot();
    registerSession(root300, "overnight", COORD, { tag: "300" });
    const r = await grantMergeWindowShared(root300, "overnight", COORD, NEO, { ...meta, tag: "300" }, { d1, ...silent });
    assert.equal(r.backend, "d1");
    return r.grant!;
  }

  it("cenário do incidente: o arquivo não tem a concessão, o D1 tem — granted", async () => {
    const d1 = createFakeD1();
    const grant = await grantIn300(d1);
    const neo = freshRoot();
    writeGrantorAsSeenFromNeo(neo);
    assert.equal(findLiveMergeGrant(neo, NEO), null, "pelo arquivo, o Neo não vê nada (o bug)");
    const found = await findLiveMergeGrantInD1(neo, NEO, undefined, { d1 });
    assert.ok(found && "grant" in found, "o D1 resolve");
    assert.equal(found.grant.grantedAt, grant.grantedAt);
    assert.equal(found.grantedBy.sessionId, COORD);
  });

  // #13577: o `grant-merge` grava também a presença da concedente no D1; aqui
  // ela é apagada para isolar a regra "sem registro E sem presença não vale".
  const dropPresence = (d1: FakeD1) => d1.db.exec("DELETE FROM locks WHERE name LIKE 'coordinator:%'");

  it("concedente desconhecida nesta máquina e sem presença no D1: não vale (#13577: diz por quê)", async () => {
    const d1 = createFakeD1();
    await grantIn300(d1);
    dropPresence(d1);
    const neo = freshRoot();
    const r = await findLiveMergeGrantInD1(neo, NEO, undefined, { d1 });
    assert.ok(r && "rejected" in r, "não vale, e o motivo volta para o aviso");
    assert.equal(r.rejected.reason, "grantor-unknown");
  });

  it("concedente sem autoridade de merge (continuo), ou stale sem presença: não vale", async () => {
    const d1 = createFakeD1();
    await grantIn300(d1);
    const neoContinuo = freshRoot();
    writeGrantorAsSeenFromNeo(neoContinuo, "continuo");
    const c = await findLiveMergeGrantInD1(neoContinuo, NEO, undefined, { d1 });
    assert.ok(c && "rejected" in c && c.rejected.reason === "grantor-not-coordinator", "continuo: nem a presença a promove");
    dropPresence(d1);
    const neoStale = freshRoot();
    writeGrantorAsSeenFromNeo(neoStale, "overnight", 3 * 60 * 60_000);
    const s = await findLiveMergeGrantInD1(neoStale, NEO, undefined, { d1 });
    assert.ok(s && "rejected" in s && s.rejected.reason === "grantor-unknown");
  });

  it("consumida no D1, vencida pelo TTL, ou de outro repo: não vale", async () => {
    const d1 = createFakeD1();
    const grant = await grantIn300(d1);
    const neo = freshRoot();
    writeGrantorAsSeenFromNeo(neo);
    assert.equal(await findLiveMergeGrantInD1(neo, NEO, "vjpixel/diaria-design", { d1 }), null, "outro repo");
    assert.equal(
      await findLiveMergeGrantInD1(neo, NEO, undefined, { d1, now: Date.now() + MERGE_GRANT_TTL_MS + 120_000 }),
      null,
      "TTL de grantedAt",
    );
    await ts.d1AcquireLock(d1, ts.mergeGrantConsumedD1Name(grant), NEO, ts.MERGE_GRANT_CONSUMED_D1_TTL_MS);
    assert.equal(await findLiveMergeGrantInD1(neo, NEO, undefined, { d1 }), null, "consumida");
  });

  it("linha forjada: JSON que diz outra concedente que a holder, ou auto-concessão, nunca vale", async () => {
    const d1 = createFakeD1();
    const neo = freshRoot();
    writeGrantorAsSeenFromNeo(neo);
    const at = new Date().toISOString();
    const forged = { grantedTo: NEO, grantedBy: COORD, grantedAt: at };
    await ts.d1AcquireLock(d1, ts.mergeGrantD1Name(NEO), "outra-holder", MERGE_GRANT_TTL_MS, { meta: JSON.stringify(forged) });
    assert.equal(await findLiveMergeGrantInD1(neo, NEO, undefined, { d1 }), null);
    assert.equal(ts.grantFromD1Row({ holder: NEO, meta: JSON.stringify({ grantedTo: NEO, grantedBy: NEO, grantedAt: at }) }, NEO), null);
    assert.equal(ts.grantFromD1Row({ holder: COORD, meta: "{quebrado" }, NEO), null);
  });
});

describe("staleGrantorRegistrations (#13242)", () => {
  it("lista só coordenadoras com autoridade de merge de OUTRA máquina, com o atraso em minutos", () => {
    const now = Date.parse("2026-11-16T04:00:00.000Z");
    const mk = (kind: string, tag: string, agoMin: number): ActiveSessionRecord =>
      ({
        kind,
        sessionId: `${kind}-${tag}`,
        machineTag: tag,
        startedAt: new Date(now - agoMin * 60_000).toISOString(),
        lastHeartbeat: new Date(now - agoMin * 60_000).toISOString(),
        stale: false,
        claimed_issues_effective: [],
      }) as unknown as ActiveSessionRecord;
    const out = staleGrantorRegistrations(
      [mk("overnight", "300", 13), mk("develop", "neo", 30), mk("continuo", "300", 40), mk("develop", "300", 0)],
      "neo",
      now,
    );
    assert.deepEqual(
      out.map((s) => [s.kind, s.machineTag, s.ageMinutes]),
      [["overnight", "300", 13]],
    );
  });
});

// ─── paridade e regra pura do hook ──────────────────────────────────────────

describe("paridade TS × hook (#13242)", () => {
  it("mesmo SQL, mesmo nome e mesma regra de linha", () => {
    assert.equal(hookLib.READ_META_SQL, ts.READ_META_SQL);
    assert.equal(hookLib.mergeGrantD1Name(NEO), ts.mergeGrantD1Name(NEO));
    assert.equal(hookLib.mergeGrantD1Name(NEO, "VJPixel/Diaria-Design"), ts.mergeGrantD1Name(NEO, "VJPixel/Diaria-Design"));
    const at = "2026-11-16T03:50:00.000Z";
    const rows = [
      { holder: COORD, meta: JSON.stringify({ grantedTo: NEO, grantedBy: COORD, grantedAt: at, pr: 13213 }) },
      { holder: COORD, meta: JSON.stringify({ grantedTo: NEO, grantedBy: COORD, grantedAt: at, repo: "vjpixel/diaria-design" }) },
      { holder: "x", meta: JSON.stringify({ grantedTo: NEO, grantedBy: COORD, grantedAt: at }) },
      { holder: NEO, meta: JSON.stringify({ grantedTo: NEO, grantedBy: NEO, grantedAt: at }) },
      { holder: COORD, meta: "nada" },
    ];
    for (const row of rows) {
      for (const repo of ["vjpixel/diaria-studio", "vjpixel/diaria-design"]) {
        assert.deepEqual(hookLib.grantFromD1Row(row, NEO, repo), ts.grantFromD1Row(row, NEO, repo), `${row.meta} @ ${repo}`);
      }
    }
  });

  it("guard: acceptD1MergeGrant exige concedente com autoridade de merge na varredura, TTL e ledger", () => {
    const now = Date.now();
    const g = { grantedTo: NEO, grantedBy: COORD, grantedAt: new Date(now - 60_000).toISOString(), pr: 13213 };
    const scan = { ids: new Set([COORD]), kinds: new Map([[COORD, "overnight"]]) };
    assert.deepEqual(guard.acceptD1MergeGrant(g, NEO, scan, new Map(), now), g);
    assert.equal(guard.acceptD1MergeGrant(g, "outra", scan, new Map(), now), null, "beneficiária errada");
    assert.equal(guard.acceptD1MergeGrant(g, NEO, { ids: new Set(), kinds: new Map() }, new Map(), now), null, "concedente fora da varredura");
    assert.equal(
      guard.acceptD1MergeGrant(g, NEO, { ids: new Set([COORD]), kinds: new Map([[COORD, "continuo"]]) }, new Map(), now),
      null,
      "continuo não decide merge",
    );
    assert.equal(guard.acceptD1MergeGrant(g, NEO, scan, new Map(), now + MERGE_GRANT_TTL_MS + 120_000), null, "TTL");
    const ledger = new Map([[`${g.grantedBy}\u0000${g.grantedTo}\u0000${g.grantedAt}`, new Date(now).toISOString()]]);
    assert.equal(guard.acceptD1MergeGrant(g, NEO, scan, ledger, now), null, "consumida no registro da beneficiária");
    assert.equal(guard.acceptD1MergeGrant({ ...g, grantedTo: COORD }, COORD, scan, new Map(), now), null, "auto-concessão");
  });
});

// ─── guard e consumo ponta a ponta (D1 falso em 127.0.0.1) ──────────────────

const HOOK_PATH = fileURLToPath(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url));
const CONSUME_HOOK_PATH = fileURLToPath(new URL("../.claude/hooks/consume-merge-grant-on-merge.mjs", import.meta.url));
const SESSION_REGISTRY_CLI = fileURLToPath(new URL("../scripts/lib/session-registry.ts", import.meta.url));

async function startFakeD1Server(): Promise<{ base: string; d1: FakeD1; server: Server }> {
  const d1 = createFakeD1();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
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
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, d1, server };
}

describe("guard + consumo com a concessão só no D1 (#13242, ponta a ponta)", () => {
  let srv: Awaited<ReturnType<typeof startFakeD1Server>>;
  after(() => {
    srv?.server.closeAllConnections();
    srv?.server.close();
  });

  const MERGE_CMD = "gh pr merge 13213 --squash -R vjpixel/diaria-studio";

  function neoRoot(): string {
    const root = freshRoot();
    spawnSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "platform.config.json"), JSON.stringify({ d1_locks: { database_id: "fake-db" } }));
    writeGrantorAsSeenFromNeo(root);
    const now = new Date().toISOString();
    const tag = machineTag();
    writeFileSync(
      join(sessionsDir(root), `interactive-${tag}-${NEO}.json`),
      JSON.stringify({ kind: "interactive", sessionId: NEO, machineTag: tag, startedAt: now, lastHeartbeat: now }),
    );
    // A interativa segura o merge lock (o lock continua obrigatório).
    writeFileSync(join(sessionsDir(root), ".merge-lock.json"), JSON.stringify({ heldBy: NEO, acquiredAt: now }));
    return root;
  }

  function run(args: string[], root: string, input: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: root,
        env: { ...withIsolatedGhConfig(), DIARIA_D1_API_BASE: srv.base, CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "tok" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(input);
    });
  }
  const payload = JSON.stringify({ session_id: NEO, tool_name: "Bash", tool_input: { command: MERGE_CMD } });
  const runGuard = (root: string) => run([HOOK_PATH], root, payload);
  const runConsume = (root: string) => run([CONSUME_HOOK_PATH], root, payload);
  const runCli = (root: string, args: string[]) =>
    run(["--import", import.meta.resolve("tsx"), SESSION_REGISTRY_CLI, ...args], root, "");

  it("sem a concessão no D1 o guard bloqueia; com ela, permite; consumida, volta a bloquear", async () => {
    srv = await startFakeD1Server();
    const root = neoRoot();

    const before = await runGuard(root);
    assert.equal(JSON.parse(before.stdout).hookSpecificOutput.permissionDecision, "deny", "sem concessão: bloqueia");

    const grant = { grantedTo: NEO, grantedBy: COORD, grantedAt: new Date().toISOString(), pr: 13213 };
    await ts.d1WriteMergeGrant(srv.d1, grant, MERGE_GRANT_TTL_MS);

    const check = await runCli(root, ["check-merge-grant", "--session-id", NEO]);
    const checked = JSON.parse(check.stdout);
    assert.equal(checked.granted, true, check.stderr);
    assert.equal(checked.source, "d1");
    assert.equal(checked.visible_to_merge_gate, true);

    const allowed = await runGuard(root);
    assert.equal(allowed.stdout.trim(), "", `concessão do D1 + lock: permite. ${allowed.stdout}`);

    // O merge "aconteceu" (concessão escopada sem estado consultável → fail-open consome).
    await runConsume(root);
    const marker = await ts.d1ReadLock(srv.d1, ts.mergeGrantConsumedD1Name(grant));
    assert.ok(marker.ok && marker.value !== null, "o consumo da concessão do D1 deixou a marca de uso único");

    const after2 = await runGuard(root);
    assert.equal(JSON.parse(after2.stdout).hookSpecificOutput.permissionDecision, "deny", "uso único");
  });

  it("concedente que esta máquina não conhece: a linha do D1 não abre o merge", async () => {
    srv.d1.db.exec("DELETE FROM locks");
    const root = neoRoot();
    rmSync(join(sessionsDir(root), grantorFile()));
    await ts.d1WriteMergeGrant(
      srv.d1,
      { grantedTo: NEO, grantedBy: COORD, grantedAt: new Date().toISOString(), pr: 13213 },
      MERGE_GRANT_TTL_MS,
    );
    const res = await runGuard(root);
    // Sem coordenadora ativa nenhuma o guard nem arma (sessão interativa comum):
    // o que importa é que a concessão não foi aceita.
    const log = readFileSync(join(root, "data", "run-log.jsonl"), "utf8");
    assert.match(log, /"accepted":false/);
    assert.ok(res.status === 0);
  });

  it("check-merge-grant sem concessão avisa o atraso do registro da concedente de outra máquina", async () => {
    srv.d1.db.exec("DELETE FROM locks");
    const root = neoRoot();
    writeGrantorAsSeenFromNeo(root, "overnight", 13 * 60_000);
    const res = await runCli(root, ["check-merge-grant", "--session-id", NEO]);
    assert.equal(JSON.parse(res.stdout).granted, false);
    assert.match(res.stderr, /13 min de atraso/);
  });
});

// ─── #13238 ─────────────────────────────────────────────────────────────────

describe("claim-issue --kind develop numa sessão sem registro (#13238)", () => {
  const TAG = "300";
  const at = () => new Date().toISOString();

  it("autoRegisterKindFor: overnight/develop viram interactive; continuo segue continuo", () => {
    assert.equal(autoRegisterKindFor("develop"), "interactive");
    assert.equal(autoRegisterKindFor("overnight"), "interactive");
    assert.equal(autoRegisterKindFor("continuo"), "continuo");
    assert.equal(autoRegisterKindFor("interactive"), "interactive");
  });

  it("cenário da issue: a claim vale, mas nenhum registro develop nasce e a sessão não vira coordenadora", () => {
    const root = freshRoot();
    const r = claimIssueAutoRegistering(root, "develop", "8c8982b2", 13217, TAG, at());
    assert.equal(r.ok, true);
    assert.equal(r.reason, "claimed");
    assert.equal(r.registeredKind, "interactive");
    assert.equal(existsSync(sessionFilePath(root, "develop", TAG, "8c8982b2")), false);
    const active = listActiveSessions(root).filter((s) => s.sessionId === "8c8982b2");
    assert.deepEqual(active.map((s) => s.kind), ["interactive"]);
    assert.deepEqual(active[0]?.claimed_issues_effective, [13217]);
  });

  it("registro interactive do beacon já existe: a claim vai para ele, sem registrar nada", () => {
    const root = freshRoot();
    registerSession(root, "interactive", "sess-beacon", { tag: TAG });
    const r = claimIssueAutoRegistering(root, "develop", "sess-beacon", 13235, TAG, at());
    assert.equal(r.ok, true);
    assert.equal(r.autoRegistered, false);
    assert.equal(r.registeredKind, "interactive");
    const rec = JSON.parse(readFileSync(sessionFilePath(root, "interactive", TAG, "sess-beacon"), "utf8"));
    assert.deepEqual(rec.claimed_issues, [13235]);
  });

  it("rodada develop de verdade (registrou antes): a claim segue no registro develop", () => {
    const root = freshRoot();
    registerSession(root, "develop", "coord-dev", { tag: TAG });
    const r = claimIssueAutoRegistering(root, "develop", "coord-dev", 1, TAG, at());
    assert.equal(r.ok, true);
    assert.equal(r.registeredKind, undefined);
    const rec = JSON.parse(readFileSync(sessionFilePath(root, "develop", TAG, "coord-dev"), "utf8"));
    assert.deepEqual(rec.claimed_issues, [1]);
  });

  it("lote e unclaim simétrico: --kind overnight sem registro grava e solta no registro interactive", () => {
    const root = freshRoot();
    const r = claimIssuesAutoRegistering(root, "overnight", "sess-lote", [5, 6], TAG, at());
    assert.equal(r.ok, true);
    assert.equal(r.registeredKind, "interactive");
    assert.equal(existsSync(sessionFilePath(root, "overnight", TAG, "sess-lote")), false);
    const u = unclaimIssues(root, "overnight", "sess-lote", [5, 6], TAG, at());
    assert.equal(u.ok, true);
    const rec = JSON.parse(readFileSync(sessionFilePath(root, "interactive", TAG, "sess-lote"), "utf8"));
    assert.deepEqual(rec.claimed_issues ?? [], []);
  });

  it("CLI: a mensagem diz o kind registrado e avisa que nenhum registro develop foi criado", async () => {
    const root = freshRoot();
    spawnSync("git", ["init", "-q"], { cwd: root });
    const res = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), SESSION_REGISTRY_CLI, "claim-issue", "--kind", "develop", "--issue", "13217", "--session-id", "sess-cli"],
        { cwd: root, env: { ...withIsolatedGhConfig(), DIARIA_D1_LOCKS: "off" } },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("close", () => resolve({ stdout, stderr }));
      child.stdin.end("");
    });
    assert.match(res.stdout, /auto-registrada agora como interactive/);
    assert.match(res.stderr, /nenhum registro develop foi criado/);
  });
});
