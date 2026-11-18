/**
 * test/merge-grant-d1-presence-hardening-13596.test.ts
 *
 * #13596 — follow-up do review da #13594 (#13577, presença da coordenadora no
 * D1). Três endurecimentos do guard #5716, todos fail-closed:
 *
 *   1. paridade TS × hook: registro da concedente como continuo PARADO (stale)
 *      recusa nos dois lados. Antes, o TS recusava e o hook descartava o
 *      registro stale e aceitava pela presença no D1;
 *   2. a presença sai do D1 também no rebaixamento de kind (`register`) e no
 *      GC, não só no `end`;
 *   3. presença autodeclarada: a que se diz DESTA máquina sem registro aqui
 *      não atesta nada, e o aceite pela presença sempre avisa
 *      (`grantorVia: d1-presence`).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as ts from "../scripts/lib/d1-locks.ts";
import {
  clearPresenceForGcRemovals,
  d1PresenceGrantNotice,
  findLiveMergeGrantInD1,
  garbageCollectSessions,
  grantMergeWindowShared,
  machineTag,
  presenceMachineConsistent,
  reconcileCoordinatorPresenceOnRegister,
  registerSession,
  sessionsDir,
  type SessionGcResult,
} from "../scripts/lib/session-registry.ts";
import { createFakeD1, failingD1, type FakeD1 } from "./_helpers/fake-d1.ts";

type Scan = {
  ids: Set<string>;
  kinds: Map<string, string>;
  knownIds?: Set<string>;
  nonAuthorityIds?: Set<string>;
};
const guard = (await import(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url).href)) as {
  acceptD1MergeGrant: (
    g: unknown,
    sessionId: string,
    scan: Scan,
    ledger: Map<string, string> | null,
    now?: number,
    d1Presence?: unknown,
    localTag?: string,
  ) => unknown;
  readActiveCoordinatorScan: (root: string, now?: number, opts?: { crossMachine?: boolean }) => Scan;
  presenceMachineConsistent: (presence: unknown, scan: Scan, localTag: string) => boolean;
  d1PresenceGrantNotice: (grantedBy: string, presence: unknown) => string;
};

const COORD = "e333a546-overnight-300";
const NEO = "8aa9ee7e-interativa-neo";
const LOCAL = machineTag();
const OTHER = LOCAL === "srv300" ? "srv300b" : "srv300";
const silent = { warn: () => {} };
const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "grant-d1-13596-"));
  roots.push(root);
  mkdirSync(sessionsDir(root), { recursive: true });
  return root;
}

function writeSession(
  root: string,
  kind: string,
  id: string,
  tag: string,
  heartbeatAgoMs = 60_000,
  extra: Record<string, unknown> = {},
): void {
  const hb = new Date(Date.now() - heartbeatAgoMs).toISOString();
  writeFileSync(
    join(sessionsDir(root), `${kind}-${tag}-${id}.json`),
    JSON.stringify({ kind, sessionId: id, machineTag: tag, startedAt: hb, lastHeartbeat: hb, ...extra }),
  );
}

/** Concessão de COORD (overnight, máquina `tag`) para NEO pela rota real: presença + linha do D1. */
async function grantFrom(d1: FakeD1, tag: string) {
  const root = freshRoot();
  registerSession(root, "overnight", COORD, { tag });
  const r = await grantMergeWindowShared(root, "overnight", COORD, NEO, { pr: 13561, tag }, { d1, ...silent });
  assert.equal(r.backend, "d1");
  assert.equal(r.presence, true);
  return r;
}

const grantRow = (now: number) => ({
  grantedTo: NEO,
  grantedBy: COORD,
  grantedAt: new Date(now - 60_000).toISOString(),
  pr: 13561,
});

// ─── item 1: continuo parado recusa nos dois lados ──────────────────────────

describe("#13596 item 1: registro continuo PARADO da concedente recusa no TS e no hook", () => {
  it("varredura do hook: continuo stale entra em nonAuthorityIds (fora de ids); encerrado não entra", () => {
    const root = freshRoot();
    writeSession(root, "continuo", COORD, OTHER, 3 * 60 * 60_000);
    writeSession(root, "continuo", "ended-c", OTHER, 3 * 60 * 60_000, { endedAt: new Date().toISOString() });
    writeSession(root, "continuo", "old-c", OTHER, 25 * 60 * 60_000);
    writeSession(root, "overnight", "stale-o", OTHER, 3 * 60 * 60_000);
    const scan = guard.readActiveCoordinatorScan(root, Date.now(), { crossMachine: true });
    assert.equal(scan.ids.has(COORD), false, "stale não é coordenadora ativa");
    assert.equal(scan.nonAuthorityIds?.has(COORD), true, "o registro parado segue contando como continuo");
    assert.equal(scan.nonAuthorityIds?.has("ended-c"), false, "registro encerrado (promovido, #7028) não conta");
    assert.equal(scan.nonAuthorityIds?.has("old-c"), false, "fora da janela de 24h");
    assert.equal(scan.nonAuthorityIds?.has("stale-o"), false, "overnight tem autoridade");
    assert.equal(scan.knownIds?.has("stale-o"), true);
  });

  it("acceptD1MergeGrant: continuo em nonAuthorityIds recusa mesmo com presença overnight no D1", () => {
    const now = Date.now();
    const presence = { sessionId: COORD, kind: "overnight", machineTag: OTHER };
    const base = { ids: new Set<string>(), kinds: new Map<string, string>(), knownIds: new Set<string>(), nonAuthorityIds: new Set<string>() };
    assert.ok(guard.acceptD1MergeGrant(grantRow(now), NEO, base, new Map(), now, presence, LOCAL), "sem continuo: aceita");
    const withContinuo = { ...base, knownIds: new Set([COORD]), nonAuthorityIds: new Set([COORD]) };
    assert.equal(guard.acceptD1MergeGrant(grantRow(now), NEO, withContinuo, new Map(), now, presence, LOCAL), null);
    // Também quando a varredura tem a concedente viva como overnight E um registro continuo.
    const both = { ...withContinuo, ids: new Set([COORD]), kinds: new Map([[COORD, "overnight"]]) };
    assert.equal(guard.acceptD1MergeGrant(grantRow(now), NEO, both, new Map(), now, presence, LOCAL), null);
  });

  it("paridade no mesmo diretório: TS e hook recusam a concessão do caso do review", async () => {
    const d1 = createFakeD1();
    await grantFrom(d1, OTHER);
    const neo = freshRoot();
    writeSession(neo, "continuo", COORD, OTHER, 3 * 60 * 60_000);
    const tsResult = await findLiveMergeGrantInD1(neo, NEO, undefined, { d1 });
    assert.ok(tsResult && "rejected" in tsResult && tsResult.rejected.reason === "grantor-not-coordinator");
    const g = await ts.d1ReadMergeGrant(d1, NEO, "vjpixel/diaria-studio");
    const p = await ts.d1ReadCoordinatorPresence(d1, COORD);
    assert.ok(g.ok && g.value && p.ok && p.value);
    const scan = guard.readActiveCoordinatorScan(neo, Date.now(), { crossMachine: true });
    assert.equal(
      guard.acceptD1MergeGrant(g.value, NEO, scan, new Map(), Date.now(), p.value, LOCAL),
      null,
      "antes do #13596 o hook aceitava aqui",
    );
  });
});

// ─── item 2: a presença sai no rebaixamento e no GC ─────────────────────────

describe("#13596 item 2: presença apagada no rebaixamento de kind e no GC", () => {
  it("register: overnight rebaixada a interactive leva previousKind e apaga a presença", async () => {
    const d1 = createFakeD1();
    const root = freshRoot();
    const first = registerSession(root, "overnight", COORD);
    assert.equal(await reconcileCoordinatorPresenceOnRegister(root, "overnight", COORD, first, { d1, ...silent }), true);
    const before = await ts.d1ReadCoordinatorPresence(d1, COORD);
    assert.ok(before.ok && before.value, "presença gravada");
    const demoted = registerSession(root, "interactive", COORD);
    assert.equal(demoted.outcome, "promoted");
    assert.equal(demoted.previousKind, "overnight");
    assert.equal(await reconcileCoordinatorPresenceOnRegister(root, "interactive", COORD, demoted, { d1, ...silent }), true);
    const after = await ts.d1ReadCoordinatorPresence(d1, COORD);
    assert.ok(after.ok && after.value === null, "presença apagada no rebaixamento");
  });

  it("register: kind sem autoridade que não veio de um com autoridade não toca o D1", async () => {
    const d1 = createFakeD1();
    const root = freshRoot();
    const r = registerSession(root, "interactive", "i-1");
    assert.equal(await reconcileCoordinatorPresenceOnRegister(root, "interactive", "i-1", r, { d1, ...silent }), null);
    const promoted = registerSession(root, "continuo", "i-1");
    assert.equal(promoted.previousKind, "interactive");
    assert.equal(await reconcileCoordinatorPresenceOnRegister(root, "continuo", "i-1", promoted, { d1, ...silent }), null);
  });

  it("register: D1 fora do ar no rebaixamento vira aviso (false), nunca exceção", async () => {
    const root = freshRoot();
    registerSession(root, "develop", COORD);
    const demoted = registerSession(root, "continuo", COORD);
    const warns: string[] = [];
    assert.equal(
      await reconcileCoordinatorPresenceOnRegister(root, "continuo", COORD, demoted, { d1: failingD1(), warn: (m) => warns.push(m) }),
      false,
    );
    assert.ok(warns.length > 0, "falha do D1 avisada");
  });

  it("GC: registro overnight removido leva sessionId/kind no plano e a presença sai do D1", async () => {
    const d1 = createFakeD1();
    const root = freshRoot();
    writeSession(root, "overnight", COORD, OTHER, 8 * 24 * 60 * 60_000);
    await ts.d1WriteCoordinatorPresence(d1, { sessionId: COORD, kind: "overnight", machineTag: OTHER });
    await ts.d1WriteCoordinatorPresence(d1, { sessionId: "vivo", kind: "overnight", machineTag: OTHER });
    const plan = garbageCollectSessions(root);
    const removed = plan.find((e) => e.action === "removed");
    assert.ok(removed, JSON.stringify(plan));
    assert.equal(removed.sessionId, COORD);
    assert.equal(removed.kind, "overnight");
    assert.equal(await clearPresenceForGcRemovals(root, plan, { d1, ...silent }), 1);
    const gone = await ts.d1ReadCoordinatorPresence(d1, COORD);
    assert.ok(gone.ok && gone.value === null, "presença da coordenadora recolhida apagada");
    const other = await ts.d1ReadCoordinatorPresence(d1, "vivo");
    assert.ok(other.ok && other.value, "presença de outra sessão intacta");
  });

  it("GC: não apaga presença de kind sem autoridade, de entrada mantida, nem de sessão viva noutro registro", async () => {
    const d1 = createFakeD1();
    const root = freshRoot();
    writeSession(root, "overnight", "viva", OTHER, 60_000);
    for (const id of ["viva", "kept"]) {
      await ts.d1WriteCoordinatorPresence(d1, { sessionId: id, kind: "overnight", machineTag: OTHER });
    }
    const plan: SessionGcResult[] = [
      { identity: "a", files: [], action: "removed", reason: "", sessionId: "c-1", kind: "continuo" },
      { identity: "b", files: [], action: "kept", reason: "", sessionId: "kept", kind: "overnight" },
      { identity: "orphan-backup:x", files: [], action: "removed", reason: "", sessionId: "viva", kind: "overnight" },
    ];
    assert.equal(await clearPresenceForGcRemovals(root, plan, { d1, ...silent }), 0);
    for (const id of ["viva", "kept"]) {
      const p = await ts.d1ReadCoordinatorPresence(d1, id);
      assert.ok(p.ok && p.value, `presença de ${id} intacta`);
    }
  });
});

// ─── item 3: presença autodeclarada ─────────────────────────────────────────

describe("#13596 item 3: presença desta máquina sem registro aqui não atesta; aceite avisa", () => {
  it("presenceMachineConsistent: TS e hook decidem igual", () => {
    const cases: Array<{ presence: { sessionId: string; machineTag?: string }; known: string[]; expected: boolean }> = [
      { presence: { sessionId: COORD, machineTag: OTHER }, known: [], expected: true },
      { presence: { sessionId: COORD }, known: [], expected: true },
      { presence: { sessionId: COORD, machineTag: LOCAL }, known: [], expected: false },
      { presence: { sessionId: COORD, machineTag: LOCAL }, known: [COORD], expected: true },
      { presence: { sessionId: COORD, machineTag: LOCAL }, known: ["outra"], expected: false },
    ];
    for (const c of cases) {
      const sessions = c.known.map((id) => ({ sessionId: id, kind: "overnight" as const }));
      const scan = { ids: new Set<string>(), kinds: new Map<string, string>(), knownIds: new Set(c.known) };
      assert.equal(presenceMachineConsistent(c.presence, sessions, LOCAL), c.expected, JSON.stringify(c));
      assert.equal(guard.presenceMachineConsistent(c.presence, scan, LOCAL), c.expected, JSON.stringify(c));
    }
    assert.equal(
      presenceMachineConsistent({ sessionId: COORD, machineTag: LOCAL }, [{ sessionId: COORD, kind: "interactive" }], LOCAL),
      false,
      "registro não coordenador não conta",
    );
  });

  it("findLiveMergeGrantInD1: presença com a tag desta máquina e sem registro aqui é rejeitada", async () => {
    const d1 = createFakeD1();
    await grantFrom(d1, LOCAL);
    const neo = freshRoot();
    const found = await findLiveMergeGrantInD1(neo, NEO, undefined, { d1 });
    assert.ok(found && "rejected" in found && found.rejected.reason === "grantor-unknown", JSON.stringify(found));
    // Com o registro (mesmo parado) desta máquina, vale.
    writeSession(neo, "overnight", COORD, LOCAL, 3 * 60 * 60_000);
    const ok = await findLiveMergeGrantInD1(neo, NEO, undefined, { d1 });
    assert.ok(ok && "grant" in ok, JSON.stringify(ok));
  });

  it("hook: mesma recusa para a presença local sem registro", () => {
    const now = Date.now();
    const empty = { ids: new Set<string>(), kinds: new Map<string, string>(), knownIds: new Set<string>(), nonAuthorityIds: new Set<string>() };
    const local = { sessionId: COORD, kind: "overnight", machineTag: LOCAL };
    assert.equal(guard.acceptD1MergeGrant(grantRow(now), NEO, empty, new Map(), now, local, LOCAL), null);
    const known = { ...empty, knownIds: new Set([COORD]) };
    assert.ok(guard.acceptD1MergeGrant(grantRow(now), NEO, known, new Map(), now, local, LOCAL));
  });

  it("aviso grantorVia: d1-presence no TS e no hook", () => {
    const tsMsg = d1PresenceGrantNotice({ sessionId: COORD, kind: "overnight", machineTag: OTHER, via: "d1-presence" });
    const hookMsg = guard.d1PresenceGrantNotice(COORD, { sessionId: COORD, kind: "overnight", machineTag: OTHER });
    for (const m of [tsMsg, hookMsg]) {
      assert.match(m, /grantorVia: d1-presence/);
      assert.match(m, new RegExp(COORD));
      assert.match(m, new RegExp(`máquina ${OTHER}`));
    }
    assert.match(d1PresenceGrantNotice({ sessionId: COORD, kind: "develop", via: "d1-presence" }), /máquina não declarada/);
  });
});
