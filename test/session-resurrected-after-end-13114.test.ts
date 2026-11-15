/**
 * test/session-resurrected-after-end-13114.test.ts (#13114)
 *
 * O tick do contínuo de 15/11/2026 chamou `end` (evento `ended` no log de
 * ciclo de vida), e o bisync do Drive trouxe o arquivo real de volta numa
 * versão anterior, com a claim #13093 e sem `endedAt`. O carimbo do `end`
 * sobreviveu só na `.conflict1`. O read-path descartava a cópia carimbada e
 * seguia lendo o real velho como sessão viva: a claim ficou presa e o
 * watchdog abriu a #13114 culpando a higiene do tick.
 *
 * Fixtures copiadas dos arquivos reais de `data/sessions/` daquele dia.
 * Isolado em tmpdir, nunca toca `data/` real.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claimIssue,
  endSession,
  endedAfterLastHeartbeat,
  garbageCollectSessions,
  isIssueClaimedByOther,
  listActiveSessions,
  planSessionGc,
  registerSession,
  sessionFilePath,
  sessionsDir,
  type SessionRecord,
} from "../scripts/lib/session-registry.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = join(tmpdir(), `session-resurrected-13114-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  mkdirSync(sessionsDir(root), { recursive: true });
  return root;
}

function writeRaw(root: string, name: string, record: SessionRecord): string {
  const p = join(sessionsDir(root), name);
  writeFileSync(p, JSON.stringify(record), "utf8");
  return p;
}

const SID = "hermes-cron-5d791ef6fc2c-20261115T145542Z";
const STEM = `continuo-300-${SID}`;

/** Arquivo real como o bisync o deixou (mtime 15:06, sem `endedAt`). */
const RESURRECTED_REAL: SessionRecord = {
  kind: "continuo",
  machineTag: "300",
  sessionId: SID,
  startedAt: "2026-11-15T14:55:43.994Z",
  lastHeartbeat: "2026-11-15T15:06:51.360Z",
  claimed_issues: [13093],
  attended: false,
  claimed_issues_at: { "13093": "2026-11-15T14:57:01.309Z" },
  claimed_issues_ever: [13093],
};

/** Cópia de conflito carimbada pelo `end` das 15:10:24. */
const ENDED_CONFLICT: SessionRecord = {
  ...RESURRECTED_REAL,
  lastHeartbeat: "2026-11-15T15:03:18.746Z",
  endedAt: "2026-11-15T15:10:24.405Z",
};

/** Hora em que o watchdog rodou e abriu a issue. */
const WATCH_NOW = Date.parse("2026-11-15T16:34:33Z");

describe("#13114 — real ressuscitado pelo sync depois do end", () => {
  it("o caso medido: a sessão não aparece como ativa e a #13093 fica livre", () => {
    const root = freshRoot();
    writeRaw(root, `${STEM}.json`, RESURRECTED_REAL);
    writeRaw(root, `${STEM}.json.conflict1`, ENDED_CONFLICT);

    const active = listActiveSessions(root, WATCH_NOW);
    assert.deepEqual(
      active.map((s) => s.sessionId),
      [],
      "sessão que chamou end não pode voltar a contar como ativa só porque o real ressuscitou",
    );
    assert.equal(isIssueClaimedByOther(root, 13093, "outra-sessao", WATCH_NOW), null);
  });

  it("mesmo cenário montado pela API: register, claim, conflito, end e ressurreição", () => {
    const root = freshRoot();
    registerSession(root, "continuo", SID, { tag: "300", startedAt: "2026-11-15T14:55:43.994Z" });
    claimIssue(root, "continuo", SID, 13093, "300", "2026-11-15T14:57:01.309Z");
    const realPath = sessionFilePath(root, "continuo", "300", SID);
    const snapshot = readFileSync(realPath, "utf8");
    // Cópia de conflito existente no instante do end (o bisync já tinha brigado com o arquivo).
    writeFileSync(`${realPath}.conflict1`, snapshot, "utf8");

    assert.equal(endSession(root, "continuo", SID, "300"), true);
    assert.equal(existsSync(realPath), false);
    assert.ok(JSON.parse(readFileSync(`${realPath}.conflict1`, "utf8")).endedAt, "end carimba a cópia");

    // O sync devolve o real na versão anterior ao end.
    writeFileSync(realPath, snapshot, "utf8");

    const now = Date.now() + 60 * 60 * 1000;
    assert.deepEqual(listActiveSessions(root, now).map((s) => s.sessionId), []);
    assert.equal(isIssueClaimedByOther(root, 13093, "outra-sessao", now), null);
  });

  it("heartbeat posterior ao carimbo continua sendo sessão viva (re-register com o mesmo id)", () => {
    const root = freshRoot();
    writeRaw(root, `${STEM}.json`, { ...RESURRECTED_REAL, lastHeartbeat: "2026-11-15T15:20:00.000Z" });
    writeRaw(root, `${STEM}.json.conflict1`, ENDED_CONFLICT);

    const active = listActiveSessions(root, Date.parse("2026-11-15T15:30:00Z"));
    assert.deepEqual(active.map((s) => s.sessionId), [SID]);
    assert.deepEqual(active[0]!.claimed_issues_effective, [13093]);
  });

  it("sem carimbo nenhum no grupo o comportamento não muda", () => {
    const root = freshRoot();
    writeRaw(root, `${STEM}.json`, RESURRECTED_REAL);
    const { endedAt: _e, ...conflictWithoutStamp } = ENDED_CONFLICT;
    writeRaw(root, `${STEM}.json.conflict1`, conflictWithoutStamp as SessionRecord);

    const active = listActiveSessions(root, WATCH_NOW);
    assert.deepEqual(active.map((s) => s.sessionId), [SID]);
    assert.deepEqual(active[0]!.claimed_issues_effective, [13093]);
  });

  it("GC recolhe o grupo e não registra gc-removed-without-end (o ended já está no log)", () => {
    const root = freshRoot();
    const real = writeRaw(root, `${STEM}.json`, RESURRECTED_REAL);
    const copy = writeRaw(root, `${STEM}.json.conflict1`, ENDED_CONFLICT);

    const plan = planSessionGc(root, { now: WATCH_NOW, localMachineTag: "300", isPidAlive: () => false });
    const entry = plan.find((e) => e.files.includes(real));
    assert.equal(entry?.action, "removed");
    assert.equal(entry?.endedAt, ENDED_CONFLICT.endedAt);

    garbageCollectSessions(root, { now: WATCH_NOW, localMachineTag: "300", isPidAlive: () => false });
    assert.equal(existsSync(real), false);
    assert.equal(existsSync(copy), false);
    const logPath = join(root, "data", "session-lifecycle.jsonl");
    const events = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    assert.doesNotMatch(events, /gc-removed-without-end/);
  });
});

describe("endedAfterLastHeartbeat (#13114)", () => {
  const base: SessionRecord = { kind: "continuo", machineTag: "300", sessionId: "s", startedAt: "2026-11-15T10:00:00Z", lastHeartbeat: "2026-11-15T10:00:00Z" };

  it("null sem nenhum endedAt", () => {
    assert.equal(endedAfterLastHeartbeat([{ ...base, lastHeartbeat: "2026-11-15T11:00:00Z" }]), null);
  });

  it("carimbo mais novo que todo heartbeat vivo vence", () => {
    assert.equal(
      endedAfterLastHeartbeat([
        { ...base, lastHeartbeat: "2026-11-15T11:00:00Z" },
        { ...base, lastHeartbeat: "2026-11-15T10:30:00Z", endedAt: "2026-11-15T11:05:00Z" },
      ]),
      "2026-11-15T11:05:00Z",
    );
  });

  it("heartbeat vivo mais novo que o carimbo: null", () => {
    assert.equal(
      endedAfterLastHeartbeat([
        { ...base, lastHeartbeat: "2026-11-15T11:10:00Z" },
        { ...base, lastHeartbeat: "2026-11-15T10:30:00Z", endedAt: "2026-11-15T11:05:00Z" },
      ]),
      null,
    );
  });

  it("carimbo ilegível não conta como fim", () => {
    assert.equal(
      endedAfterLastHeartbeat([
        { ...base, lastHeartbeat: "2026-11-15T11:00:00Z" },
        { ...base, endedAt: "não é data" },
      ]),
      null,
    );
  });
});
