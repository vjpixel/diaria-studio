/**
 * test/merge-grant-guard-alignment-13603.test.ts (#13603)
 *
 * Follow-up do review da PR #13601 (#13596). Quatro ajustes no guard #5716:
 *
 *   1. hook e TS decidem igual quando a concedente tem um registro overnight
 *      vivo e um continuo não encerrado da MESMA sessão: o TS deduplicava por
 *      `(machineTag, sessionId)` e concedia; o hook recusava. Agora o TS
 *      confere registro a registro, antes da deduplicação (fail-closed);
 *   2. presença no D1 com a tag desta máquina sem registro aqui tem motivo
 *      próprio (`grantor-presence-local-without-record`), cuja mensagem não
 *      manda repetir o grant-merge (o que não resolveria);
 *   3. o GC não apaga a presença de coordenadora parada (90 min a 24 h) nem a
 *      de coordenadora de outra máquina;
 *   4. o aviso alarmista da presença ("linha forjada") sai do `systemMessage`
 *      no caminho normal entre máquinas.
 *
 * Os casos ponta a ponta (runGuard, CLIs `register` e `gc`) estão em
 * `test/merge-grant-d1-presence-13577.test.ts`.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as ts from "../scripts/lib/d1-locks.ts";
import {
  clearPresenceForGcRemovals,
  d1GrantRejectionMessage,
  findLiveMergeGrantInD1,
  hasNonAuthorityCoordinatorRecord,
  machineTag,
  MERGE_GRANT_TTL_MS,
  sessionsDir,
  type SessionGcResult,
} from "../scripts/lib/session-registry.ts";
import { createFakeD1 } from "./_helpers/fake-d1.ts";

type Scan = { ids: Set<string>; kinds: Map<string, string>; knownIds?: Set<string>; nonAuthorityIds?: Set<string> };
const guard = (await import(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url).href)) as {
  acceptD1MergeGrant: (g: unknown, s: string, scan: Scan, l: Map<string, string> | null, now?: number, p?: unknown, tag?: string) => unknown;
  d1MergeGrantRejectReason: (g: unknown, s: string, scan: Scan, l: Map<string, string> | null, now?: number, p?: unknown, tag?: string) => string | null;
  d1PresenceGrantSystemNotice: (grantedBy: string, presence: unknown, localTag?: string) => string | null;
  readActiveCoordinatorScan: (root: string, now?: number, opts?: { crossMachine?: boolean }) => Scan;
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
  const root = mkdtempSync(join(tmpdir(), "grant-d1-13603-"));
  roots.push(root);
  mkdirSync(sessionsDir(root), { recursive: true });
  return root;
}

function writeSession(root: string, kind: string, id: string, tag: string, heartbeatAgoMs: number, extra: Record<string, unknown> = {}) {
  const hb = new Date(Date.now() - heartbeatAgoMs).toISOString();
  writeFileSync(
    join(sessionsDir(root), `${kind}-${tag}-${id}.json`),
    JSON.stringify({ kind, sessionId: id, machineTag: tag, startedAt: hb, lastHeartbeat: hb, ...extra }),
  );
}

const grantRow = (now: number) => ({ grantedTo: NEO, grantedBy: COORD, grantedAt: new Date(now - 60_000).toISOString(), pr: 13601 });

describe("#13603 item 1: overnight vivo + continuo não encerrado da mesma sessão recusa no TS e no hook", () => {
  it("cenário da issue: os dois lados recusam", async () => {
    const root = freshRoot();
    writeSession(root, "overnight", COORD, OTHER, 60_000);
    writeSession(root, "continuo", COORD, OTHER, 30 * 60_000);
    const d1 = createFakeD1();
    const now = Date.now();
    await ts.d1WriteMergeGrant(d1, grantRow(now), MERGE_GRANT_TTL_MS);

    const found = await findLiveMergeGrantInD1(root, NEO, undefined, { d1 });
    assert.ok(found && "rejected" in found && found.rejected.reason === "grantor-not-coordinator", JSON.stringify(found));

    const scan = guard.readActiveCoordinatorScan(root, now, { crossMachine: true });
    assert.equal(guard.acceptD1MergeGrant(grantRow(now), NEO, scan, new Map(), now, null, LOCAL), null);
    assert.equal(guard.d1MergeGrantRejectReason(grantRow(now), NEO, scan, new Map(), now, null, LOCAL), "grantor-not-coordinator");
  });

  it("continuo encerrado (promoção com endedAt, #7028) não recusa", async () => {
    const root = freshRoot();
    writeSession(root, "overnight", COORD, OTHER, 60_000);
    writeSession(root, "continuo", COORD, OTHER, 30 * 60_000, { endedAt: new Date().toISOString() });
    const d1 = createFakeD1();
    await ts.d1WriteMergeGrant(d1, grantRow(Date.now()), MERGE_GRANT_TTL_MS);
    const found = await findLiveMergeGrantInD1(root, NEO, undefined, { d1 });
    assert.ok(found && "grant" in found, JSON.stringify(found));
  });

  it("hasNonAuthorityCoordinatorRecord: janela de 24h, kinds e endedAt", () => {
    const now = Date.now();
    const at = (ms: number) => new Date(now - ms).toISOString();
    const rec = (kind: string, ago: number, extra = {}) => ({ sessionId: COORD, kind: kind as never, lastHeartbeat: at(ago), startedAt: at(ago), ...extra });
    assert.equal(hasNonAuthorityCoordinatorRecord([rec("continuo", 3 * 3_600_000)], COORD, now), true, "parado conta");
    assert.equal(hasNonAuthorityCoordinatorRecord([rec("continuo", 25 * 3_600_000)], COORD, now), false, "fora de 24h");
    assert.equal(hasNonAuthorityCoordinatorRecord([rec("overnight", 60_000)], COORD, now), false);
    assert.equal(hasNonAuthorityCoordinatorRecord([rec("interactive", 60_000)], COORD, now), false);
    assert.equal(hasNonAuthorityCoordinatorRecord([rec("continuo", 60_000, { endedAt: at(0) })], COORD, now), false);
    assert.equal(hasNonAuthorityCoordinatorRecord([rec("continuo", 60_000)], "outra", now), false);
  });
});

describe("#13603 item 2: motivo próprio para presença local sem registro", () => {
  it("hook e TS usam o mesmo nome do motivo", () => {
    const now = Date.now();
    const empty: Scan = { ids: new Set(), kinds: new Map(), knownIds: new Set(), nonAuthorityIds: new Set() };
    const presence = { sessionId: COORD, kind: "overnight", machineTag: LOCAL };
    assert.equal(
      guard.d1MergeGrantRejectReason(grantRow(now), NEO, empty, new Map(), now, presence, LOCAL),
      "grantor-presence-local-without-record",
    );
    assert.equal(guard.d1MergeGrantRejectReason(grantRow(now), NEO, empty, new Map(), now, null, LOCAL), "grantor-unknown");
    assert.equal(
      guard.d1MergeGrantRejectReason(grantRow(now), NEO, empty, new Map(), now, { ...presence, machineTag: OTHER }, LOCAL),
      null,
    );
  });

  it("a mensagem não manda repetir o grant-merge; a de grantor-unknown segue mandando", () => {
    const local = d1GrantRejectionMessage({ grantedBy: COORD, grantedAt: "2026-11-18T20:00:00Z", reason: "grantor-presence-local-without-record" });
    assert.match(local, /diz ser DESTA máquina/);
    assert.match(local, /Repetir o grant-merge não resolve/);
    assert.doesNotMatch(local, /Peça à concedente para repetir/);
    const unknown = d1GrantRejectionMessage({ grantedBy: COORD, grantedAt: "2026-11-18T20:00:00Z", reason: "grantor-unknown" });
    assert.match(unknown, /repetir o grant-merge/);
  });
});

describe("#13603 item 3: GC não apaga presença de sessão viva nem de outra máquina", () => {
  const removed = (id: string, tag?: string): SessionGcResult => ({
    identity: `overnight-${tag}-${id}`, files: [], action: "removed", reason: "", sessionId: id, kind: "overnight",
    ...(tag !== undefined ? { machineTag: tag } : {}),
  });

  it("coordenadora parada (3 h, < 24 h) em outro registro mantém a presença", async () => {
    const d1 = createFakeD1();
    const root = freshRoot();
    writeSession(root, "develop", "parada", LOCAL, 3 * 3_600_000);
    await ts.d1WriteCoordinatorPresence(d1, { sessionId: "parada", kind: "develop", machineTag: LOCAL });
    assert.equal(await clearPresenceForGcRemovals(root, [removed("parada", LOCAL)], { d1, ...silent }), 0);
    const p = await ts.d1ReadCoordinatorPresence(d1, "parada");
    assert.ok(p.ok && p.value, "presença intacta");
  });

  it("registro de outra máquina (ou sem machineTag) recolhido não apaga a presença", async () => {
    const d1 = createFakeD1();
    const root = freshRoot();
    for (const id of ["remota", "sem-tag"]) {
      await ts.d1WriteCoordinatorPresence(d1, { sessionId: id, kind: "overnight", machineTag: OTHER });
    }
    assert.equal(
      await clearPresenceForGcRemovals(root, [removed("remota", OTHER), removed("sem-tag")], { d1, ...silent }),
      0,
    );
    for (const id of ["remota", "sem-tag"]) {
      const p = await ts.d1ReadCoordinatorPresence(d1, id);
      assert.ok(p.ok && p.value, `presença de ${id} intacta`);
    }
  });

  it("registro desta máquina recolhido, sem outro registro vivo, apaga", async () => {
    const d1 = createFakeD1();
    const root = freshRoot();
    await ts.d1WriteCoordinatorPresence(d1, { sessionId: "morta", kind: "overnight", machineTag: LOCAL });
    assert.equal(await clearPresenceForGcRemovals(root, [removed("morta", LOCAL)], { d1, ...silent }), 1);
  });
});

describe("#13603 item 4: systemMessage neutro, ausente no caminho normal entre máquinas", () => {
  it("presença de outra máquina: sem systemMessage", () => {
    assert.equal(guard.d1PresenceGrantSystemNotice(COORD, { sessionId: COORD, kind: "overnight", machineTag: OTHER }, LOCAL), null);
  });

  it("máquina não declarada ou desta máquina: texto neutro, sem falar em linha forjada", () => {
    for (const presence of [{ sessionId: COORD, kind: "overnight" }, { sessionId: COORD, kind: "overnight", machineTag: LOCAL }]) {
      const m = guard.d1PresenceGrantSystemNotice(COORD, presence, LOCAL);
      assert.ok(m, JSON.stringify(presence));
      assert.match(m!, new RegExp(COORD));
      assert.doesNotMatch(m!, /forjada/);
    }
  });
});
