/**
 * test/merge-grant-d1-presence-13577.test.ts
 *
 * #13577 — a concessão do D1 (#13242) ainda dependia do sync do Drive. Em
 * 18/11/2026 a overnight do `300` concedeu janela à interativa do Neo (PR
 * #13561): a linha `merge-grant:vjpixel/diaria-studio|{neo}` estava no D1, com
 * a chave que o Neo consulta, e mesmo assim `check-merge-grant` no Neo voltou
 * `granted: false` sem aviso — o leitor exigia o REGISTRO da concedente em
 * `data/sessions/` do Neo, e esse registro só chegou 5 min depois, pelo mesmo
 * sync que a concessão do D1 existe para contornar.
 *
 * Fix: a coordenadora grava a própria presença no D1 (`coordinator:{id}`) no
 * `register` e a cada `grant-merge`, e a apaga no `end`; o leitor (CLI e guard)
 * aceita a concedente pela presença quando o registro local não a mostra ativa.
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
import * as hookLib from "../.claude/hooks/lib/d1-locks.mjs";
import {
  clearCoordinatorPresenceShared,
  d1GrantRejectionMessage,
  findLiveMergeGrantInD1,
  grantMergeWindowShared,
  grantVisibilitySuffix,
  machineTag,
  MERGE_GRANT_TTL_MS,
  registerCoordinatorPresenceShared,
  registerSession,
  sessionsDir,
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
    d1Presence?: unknown,
  ) => unknown;
};

const COORD = "e333a546-overnight-300";
const NEO = "8aa9ee7e-interativa-neo";
const GRANTOR_TAG = machineTag() === "srv300" ? "srv300b" : "srv300";
const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "grant-d1-13577-"));
  roots.push(root);
  mkdirSync(sessionsDir(root), { recursive: true });
  return root;
}

function writeSession(root: string, kind: string, id: string, tag: string, heartbeatAgoMs = 60_000): void {
  const hb = new Date(Date.now() - heartbeatAgoMs).toISOString();
  writeFileSync(
    join(sessionsDir(root), `${kind}-${tag}-${id}.json`),
    JSON.stringify({ kind, sessionId: id, machineTag: tag, startedAt: hb, lastHeartbeat: hb }),
  );
}

const silent = { warn: () => {} };

/** A overnight do `300` concede pela rota real (`grant-merge`): arquivo + presença + linha do D1. */
async function grantFrom300(d1: FakeD1) {
  const root300 = freshRoot();
  registerSession(root300, "overnight", COORD, { tag: GRANTOR_TAG });
  const r = await grantMergeWindowShared(root300, "overnight", COORD, NEO, { pr: 13561, tag: GRANTOR_TAG }, { d1, ...silent });
  assert.equal(r.backend, "d1");
  return r;
}

// ─── escrita ────────────────────────────────────────────────────────────────

describe("grant-merge grava a presença da concedente (#13577)", () => {
  it("grant-merge: presença + concessão no D1, com a chave que a beneficiária consulta", async () => {
    const d1 = createFakeD1();
    const r = await grantFrom300(d1);
    assert.equal(r.presence, true);
    const presence = await ts.d1ReadCoordinatorPresence(d1, COORD);
    assert.ok(presence.ok && presence.value, "presença no D1");
    assert.equal(presence.value.kind, "overnight");
    assert.equal(presence.value.machineTag, GRANTOR_TAG);
    // A chave gravada pelo grant-merge é a mesma que o leitor monta para o
    // mesmo repo/PR (hipótese 2 da issue, descartada com teste).
    const rows = d1.db.prepare("SELECT name FROM locks WHERE name LIKE 'merge-grant:%'").all() as Array<{ name: string }>;
    assert.deepEqual(
      rows.map((x) => x.name),
      [ts.mergeGrantD1Name(NEO, "vjpixel/diaria-studio")],
    );
    assert.equal(hookLib.mergeGrantD1Name(NEO), rows[0]!.name, "o hook lê a mesma chave");
  });

  it("presença só para kind com autoridade de merge; nunca sobrescreve linha de outro holder", async () => {
    const root = freshRoot();
    const d1 = createFakeD1();
    assert.equal(await registerCoordinatorPresenceShared(root, "continuo", "c-1", {}, { d1, ...silent }), null);
    assert.equal(await registerCoordinatorPresenceShared(root, "interactive", "i-1", {}, { d1, ...silent }), null);
    assert.equal(d1.db.prepare("SELECT COUNT(*) AS n FROM locks").get()?.n, 0);
    // Linha forjada com o nome da coordenadora e outro holder: não vira presença
    // e o register não a sobrescreve.
    await ts.d1AcquireLock(d1, ts.coordinatorPresenceD1Name(COORD), "intrusa", 60_000, {
      meta: JSON.stringify({ sessionId: COORD, kind: "overnight" }),
    });
    const warns: string[] = [];
    assert.equal(await registerCoordinatorPresenceShared(root, "overnight", COORD, {}, { d1, warn: (m) => warns.push(m) }), false);
    assert.match(warns.join(""), /OUTRO holder/);
    const p = await ts.d1ReadCoordinatorPresence(d1, COORD);
    assert.ok(p.ok && p.value === null, "linha de outro holder não atesta a coordenadora");
  });

  it("D1 fora do ar: presença false, com aviso; a concessão local vale", async () => {
    const root = freshRoot();
    registerSession(root, "overnight", COORD, { tag: "300" });
    const warns: string[] = [];
    const r = await grantMergeWindowShared(root, "overnight", COORD, NEO, { tag: "300" }, {
      d1: failingD1(),
      warn: (m) => warns.push(m),
    });
    assert.equal(r.ok, true);
    assert.equal(r.presence, false);
    assert.match(warns.join(""), /presença desta coordenadora não foi gravada/);
  });

  it("grantVisibilitySuffix: o stdout do grant-merge sempre diz onde a concessão ficou", () => {
    assert.match(grantVisibilitySuffix({ backend: "d1", presence: true }), /visível em todas as máquinas/);
    assert.match(grantVisibilitySuffix({ backend: "d1", presence: false }), /SEM a presença/);
    assert.match(grantVisibilitySuffix({ backend: "local-fallback" }), /o D1 NÃO gravou/);
    assert.match(grantVisibilitySuffix({ backend: "local" }), /D1 não configurado/);
  });
});

// ─── leitura na outra máquina ───────────────────────────────────────────────

describe("findLiveMergeGrantInD1 com a presença do D1 (#13577)", () => {
  it("cenário do incidente: registro da concedente AUSENTE no Neo, concessão + presença no D1 — granted", async () => {
    const d1 = createFakeD1();
    const r = await grantFrom300(d1);
    const neo = freshRoot();
    const found = await findLiveMergeGrantInD1(neo, NEO, undefined, { d1 });
    assert.ok(found && "grant" in found, `antes do #13577 isto voltava null: ${JSON.stringify(found)}`);
    assert.equal(found.grant.grantedAt, r.grant?.grantedAt);
    assert.equal(found.grantedBy.sessionId, COORD);
    assert.equal((found.grantedBy as { via?: string }).via, "d1-presence");
  });

  it("registro da concedente PARADO no sync (stale) no Neo: a presença do D1 a atesta", async () => {
    const d1 = createFakeD1();
    await grantFrom300(d1);
    const neo = freshRoot();
    writeSession(neo, "overnight", COORD, GRANTOR_TAG, 3 * 60 * 60_000);
    const found = await findLiveMergeGrantInD1(neo, NEO, undefined, { d1 });
    assert.ok(found && "grant" in found);
  });

  it("presença NÃO abre: TTL vencido, consumo, ou concedente que o registro local diz continuo", async () => {
    const d1 = createFakeD1();
    const r = await grantFrom300(d1);
    const neo = freshRoot();
    assert.equal(
      await findLiveMergeGrantInD1(neo, NEO, undefined, { d1, now: Date.now() + MERGE_GRANT_TTL_MS + 120_000 }),
      null,
      "TTL de grantedAt",
    );
    const neoContinuo = freshRoot();
    writeSession(neoContinuo, "continuo", COORD, GRANTOR_TAG);
    const c = await findLiveMergeGrantInD1(neoContinuo, NEO, undefined, { d1 });
    assert.ok(c && "rejected" in c && c.rejected.reason === "grantor-not-coordinator");
    await ts.d1AcquireLock(d1, ts.mergeGrantConsumedD1Name(r.grant!), NEO, ts.MERGE_GRANT_CONSUMED_D1_TTL_MS);
    assert.equal(await findLiveMergeGrantInD1(neo, NEO, undefined, { d1 }), null, "uso único");
  });

  it("end apaga a presença: a concessão do D1 deixa de valer onde o registro não chegou", async () => {
    const d1 = createFakeD1();
    await grantFrom300(d1);
    await clearCoordinatorPresenceShared(freshRoot(), "overnight", COORD, { d1, ...silent });
    const found = await findLiveMergeGrantInD1(freshRoot(), NEO, undefined, { d1 });
    assert.ok(found && "rejected" in found && found.rejected.reason === "grantor-unknown");
    assert.match(d1GrantRejectionMessage(found.rejected), /NÃO vale aqui/);
  });

  it("presença de kind sem autoridade (linha da própria sessão dizendo continuo) não vale", async () => {
    const d1 = createFakeD1();
    await grantFrom300(d1);
    await ts.d1WriteCoordinatorPresence(d1, { sessionId: COORD, kind: "continuo" });
    const found = await findLiveMergeGrantInD1(freshRoot(), NEO, undefined, { d1 });
    assert.ok(found && "rejected" in found && found.rejected.reason === "grantor-not-coordinator");
  });
});

// ─── paridade e regra pura do guard ─────────────────────────────────────────

describe("paridade TS × hook da presença (#13577)", () => {
  it("mesmo nome e mesma regra de linha", () => {
    assert.equal(hookLib.coordinatorPresenceD1Name(COORD), ts.coordinatorPresenceD1Name(COORD));
    const rows = [
      { holder: COORD, meta: JSON.stringify({ sessionId: COORD, kind: "overnight", machineTag: "300" }) },
      { holder: COORD, meta: JSON.stringify({ sessionId: COORD, kind: "develop" }) },
      { holder: "outra", meta: JSON.stringify({ sessionId: COORD, kind: "overnight" }) },
      { holder: COORD, meta: JSON.stringify({ sessionId: "outra", kind: "overnight" }) },
      { holder: COORD, meta: JSON.stringify({ sessionId: COORD }) },
      { holder: COORD, meta: "{quebrado" },
      { holder: COORD, meta: null },
    ];
    for (const row of rows) {
      assert.deepEqual(hookLib.presenceFromD1Row(row, COORD), ts.presenceFromD1Row(row, COORD), String(row.meta));
    }
    assert.equal(ts.presenceFromD1Row(rows[2], COORD), null, "holder diferente da sessão");
    assert.equal(ts.presenceFromD1Row(rows[3], COORD), null, "meta de outra sessão");
  });

  it("guard: acceptD1MergeGrant aceita a concedente fora da varredura só com presença de autoridade", () => {
    const now = Date.now();
    const g = { grantedTo: NEO, grantedBy: COORD, grantedAt: new Date(now - 60_000).toISOString(), pr: 13561 };
    const empty = { ids: new Set<string>(), kinds: new Map<string, string>() };
    const overnight = { sessionId: COORD, kind: "overnight" };
    assert.equal(guard.acceptD1MergeGrant(g, NEO, empty, new Map(), now), null, "sem presença: como antes");
    assert.deepEqual(guard.acceptD1MergeGrant(g, NEO, empty, new Map(), now, overnight), g, "o caso do incidente");
    assert.equal(
      guard.acceptD1MergeGrant(g, NEO, empty, new Map(), now, { sessionId: COORD, kind: "continuo" }),
      null,
      "presença sem autoridade",
    );
    assert.equal(
      guard.acceptD1MergeGrant(g, NEO, empty, new Map(), now, { sessionId: "outra", kind: "overnight" }),
      null,
      "presença de outra sessão",
    );
    const scanContinuo = { ids: new Set([COORD]), kinds: new Map([[COORD, "continuo"]]) };
    assert.equal(
      guard.acceptD1MergeGrant(g, NEO, scanContinuo, new Map(), now, overnight),
      null,
      "a varredura decide quando tem a concedente",
    );
    assert.equal(
      guard.acceptD1MergeGrant(g, NEO, empty, new Map(), now + MERGE_GRANT_TTL_MS + 120_000, overnight),
      null,
      "TTL",
    );
    assert.equal(
      guard.acceptD1MergeGrant({ ...g, grantedTo: COORD }, COORD, empty, new Map(), now, overnight),
      null,
      "auto-concessão",
    );
  });
});

// ─── guard e CLI ponta a ponta (D1 falso em 127.0.0.1) ──────────────────────

const HOOK_PATH = fileURLToPath(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url));
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

describe("guard + CLI com a concedente ausente no Neo (#13577, ponta a ponta)", () => {
  let srv: Awaited<ReturnType<typeof startFakeD1Server>>;
  after(() => {
    srv?.server.closeAllConnections();
    srv?.server.close();
  });

  const MERGE_CMD = "gh pr merge 13561 --squash -R vjpixel/diaria-studio";
  const OTHER_COORD = "f00d-develop-outra";

  /**
   * O Neo do incidente: o registro da overnight do `300` NÃO chegou, mas há
   * outra coordenadora ativa (o guard arma). A interativa segura o merge lock.
   */
  function neoRoot(): string {
    const root = freshRoot();
    spawnSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "platform.config.json"), JSON.stringify({ d1_locks: { database_id: "fake-db" } }));
    writeSession(root, "develop", OTHER_COORD, GRANTOR_TAG);
    const now = new Date().toISOString();
    const tag = machineTag();
    writeFileSync(
      join(sessionsDir(root), `interactive-${tag}-${NEO}.json`),
      JSON.stringify({ kind: "interactive", sessionId: NEO, machineTag: tag, startedAt: now, lastHeartbeat: now }),
    );
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
  const runCli = (root: string, args: string[]) =>
    run(["--import", import.meta.resolve("tsx"), SESSION_REGISTRY_CLI, ...args], root, "");
  const grantRow = () => ({ grantedTo: NEO, grantedBy: COORD, grantedAt: new Date().toISOString(), pr: 13561 });

  it("sem presença: guard bloqueia e check-merge-grant DIZ que a concessão existe e por que não vale", async () => {
    srv = await startFakeD1Server();
    const root = neoRoot();
    await ts.d1WriteMergeGrant(srv.d1, grantRow(), MERGE_GRANT_TTL_MS);
    const res = await runGuard(root);
    assert.equal(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, "deny");
    const log = readFileSync(join(root, "data", "run-log.jsonl"), "utf8");
    assert.match(log, /"accepted":false,"rejectReason":"grantor-unknown","grantorVia":"none"/);
    const check = await runCli(root, ["check-merge-grant", "--session-id", NEO]);
    assert.equal(JSON.parse(check.stdout).granted, false);
    assert.match(check.stderr, /o D1 tem concessão de e333a546-overnight-300/);
  });

  it("com a presença da concedente no D1: check-merge-grant granted e o guard permite", async () => {
    srv.d1.db.exec("DELETE FROM locks");
    const root = neoRoot();
    await ts.d1WriteCoordinatorPresence(srv.d1, { sessionId: COORD, kind: "overnight", machineTag: GRANTOR_TAG });
    await ts.d1WriteMergeGrant(srv.d1, grantRow(), MERGE_GRANT_TTL_MS);
    const check = await runCli(root, ["check-merge-grant", "--session-id", NEO]);
    const checked = JSON.parse(check.stdout);
    assert.equal(checked.granted, true, check.stderr);
    assert.equal(checked.source, "d1");
    assert.equal(checked.grantedBy.via, "d1-presence");
    // #13596: o aceite pela presença nunca passa calado (stderr do CLI).
    assert.match(check.stderr, /grantorVia: d1-presence/);
    const allowed = await runGuard(root);
    // #13596: permite (sem `deny`); o aviso da presença nunca passa calado.
    // #13603: presença de OUTRA máquina é o caminho normal: o texto completo
    // fica no stderr e no run-log, e o `systemMessage` não o repete.
    const out = allowed.stdout.trim() === "" ? {} : JSON.parse(allowed.stdout);
    assert.equal(out.hookSpecificOutput?.permissionDecision, undefined, `concessão do D1 + presença + lock: permite. ${allowed.stdout}`);
    assert.doesNotMatch(out.systemMessage ?? "", /forjada|grantorVia/);
    assert.match(allowed.stderr, /grantorVia: d1-presence/);
    const log = readFileSync(join(root, "data", "run-log.jsonl"), "utf8");
    assert.match(log, /"accepted":true,"grantorVia":"d1-presence"/);
    assert.match(log, /"notice":"merge-guard \(#13596\)/, "texto completo do aviso no run-log (#13603)");
  });

  it("#13603: presença com a tag DESTA máquina sem registro aqui: guard nega com rejectReason próprio e o CLI não manda repetir o grant-merge", async () => {
    srv.d1.db.exec("DELETE FROM locks");
    const root = neoRoot();
    await ts.d1WriteCoordinatorPresence(srv.d1, { sessionId: COORD, kind: "overnight", machineTag: machineTag() });
    await ts.d1WriteMergeGrant(srv.d1, grantRow(), MERGE_GRANT_TTL_MS);
    const res = await runGuard(root);
    assert.equal(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, "deny", res.stdout);
    const log = readFileSync(join(root, "data", "run-log.jsonl"), "utf8");
    assert.match(log, /"accepted":false,"rejectReason":"grantor-presence-local-without-record"/);
    const check = await runCli(root, ["check-merge-grant", "--session-id", NEO]);
    assert.equal(JSON.parse(check.stdout).granted, false);
    assert.match(check.stderr, /diz ser DESTA máquina/);
    assert.doesNotMatch(check.stderr, /Peça à concedente para repetir o grant-merge/);
  });

  it("#13603: CLI gc apaga a presença de coordenadora DESTA máquina recolhida e preserva a de outra máquina", async () => {
    srv.d1.db.exec("DELETE FROM locks");
    const root = neoRoot();
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    const local = machineTag();
    for (const [id, tag] of [["gc-local", local], ["gc-remota", GRANTOR_TAG]] as const) {
      writeFileSync(
        join(sessionsDir(root), `overnight-${tag}-${id}.json`),
        JSON.stringify({ kind: "overnight", sessionId: id, machineTag: tag, startedAt: old, lastHeartbeat: old }),
      );
      await ts.d1WriteCoordinatorPresence(srv.d1, { sessionId: id, kind: "overnight", machineTag: tag });
    }
    const gc = await runCli(root, ["gc"]);
    assert.equal(gc.status, 0, gc.stderr);
    const gone = await ts.d1ReadCoordinatorPresence(srv.d1, "gc-local");
    assert.ok(gone.ok && gone.value === null, `presença local recolhida apagada. ${gc.stdout}`);
    const kept = await ts.d1ReadCoordinatorPresence(srv.d1, "gc-remota");
    assert.ok(kept.ok && kept.value, "presença de outra máquina intacta (renovada e limpa pela máquina dela)");
  });

  it("#13603: CLI register com rebaixamento de kind apaga a presença", async () => {
    srv.d1.db.exec("DELETE FROM locks");
    const root = neoRoot();
    const id = "cafe-rebaixa-cli";
    const reg = await runCli(root, ["register", "--kind", "overnight", "--session-id", id]);
    assert.equal(reg.status, 0, reg.stderr);
    const p = await ts.d1ReadCoordinatorPresence(srv.d1, id);
    assert.ok(p.ok && p.value, "presença gravada");
    const demote = await runCli(root, ["register", "--kind", "continuo", "--session-id", id]);
    assert.equal(demote.status, 0, demote.stderr);
    const gone = await ts.d1ReadCoordinatorPresence(srv.d1, id);
    assert.ok(gone.ok && gone.value === null, `presença apagada no rebaixamento. ${demote.stderr}`);
  });

  it("CLI: register de overnight grava a presença e end a apaga", async () => {
    srv.d1.db.exec("DELETE FROM locks");
    const root = neoRoot();
    const id = "cafe-overnight-cli";
    const reg = await runCli(root, ["register", "--kind", "overnight", "--session-id", id]);
    assert.equal(reg.status, 0, reg.stderr);
    const p = await ts.d1ReadCoordinatorPresence(srv.d1, id);
    assert.ok(p.ok && p.value?.kind === "overnight", "presença gravada no register");
    const end = await runCli(root, ["end", "--kind", "overnight", "--session-id", id, "--allow-dirty"]);
    assert.match(end.stdout, /ended/, end.stderr);
    const gone = await ts.d1ReadCoordinatorPresence(srv.d1, id);
    assert.ok(gone.ok && gone.value === null, "presença apagada no end");
  });
});
