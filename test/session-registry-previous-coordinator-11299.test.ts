/**
 * #11299 — rodada overnight 261027b (Neo) apareceu para a 261027c como
 * `interactive` sem `claimed_issues`. Diagnóstico: o `register --kind overnight`
 * valeu (04:59Z, 10 issues reivindicadas) e o `end` rodou às 12:48:25Z; o beacon
 * criou o `interactive-*` da MESMA conversa 3s depois, e a 261027c só começou
 * às 12:50:39Z. Nada rebaixou registro vivo. O que faltava era o `list-active`
 * explicar a origem do registro — estes testes travam a nota
 * `previous_coordinator` e o cenário real fim a fim.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  annotatePreviousCoordinator,
  claimIssueCheckAndSet,
  endSession,
  listActiveSessions,
  readSessionLifecycleEvents,
  registerSession,
  type SessionLifecycleEvent,
} from "../scripts/lib/session-registry.ts";

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "sr-11299-"));
  mkdirSync(join(root, "data", "sessions"), { recursive: true });
  return root;
}

const SID = "150a0611-4c06-4005-bbf8-67bac4e78ee2";

function ev(partial: Partial<SessionLifecycleEvent>): SessionLifecycleEvent {
  return {
    event: "ended",
    kind: "overnight",
    machineTag: "Neo",
    sessionId: SID,
    ts: "2026-10-27T12:48:25.185Z",
    startedAt: "2026-10-27T04:59:00.921Z",
    claimed_issues: [],
    claimed_issues_ever: [9824, 11159, 11252],
    ...partial,
  };
}

const NOW = Date.parse("2026-10-27T12:51:00Z");
const interactive = { kind: "interactive" as const, sessionId: SID, startedAt: "2026-10-27T12:48:28.599Z" };

describe("annotatePreviousCoordinator (#11299)", () => {
  it("cenário 261027b: interactive nascido 3s depois do end do overnight ganha a nota", () => {
    const [out] = annotatePreviousCoordinator([interactive], [ev({})], NOW);
    assert.deepEqual(out.previous_coordinator, {
      kind: "overnight",
      event: "ended",
      endedAt: "2026-10-27T12:48:25.185Z",
      startedAt: "2026-10-27T04:59:00.921Z",
      claimed_issues_ever: [9824, 11159, 11252],
    });
  });

  it("outro sessionId não anota", () => {
    const [out] = annotatePreviousCoordinator([interactive], [ev({ sessionId: "outro" })], NOW);
    assert.equal(out.previous_coordinator, undefined);
  });

  it("registro coordenador nunca é anotado (a nota é só para interactive)", () => {
    const [out] = annotatePreviousCoordinator([{ ...interactive, kind: "overnight" as const }], [ev({})], NOW);
    assert.equal(out.previous_coordinator, undefined);
  });

  it("evento fora da janela de 24h não anota", () => {
    const [out] = annotatePreviousCoordinator(
      [{ ...interactive, startedAt: "2026-10-28T13:00:00Z" }],
      [ev({})],
      Date.parse("2026-10-28T13:00:30Z"),
    );
    assert.equal(out.previous_coordinator, undefined);
  });

  it("end POSTERIOR ao nascimento do interactive (além do skew) não o explica", () => {
    const [out] = annotatePreviousCoordinator([interactive], [ev({ ts: "2026-10-27T12:50:30Z" })], NOW);
    assert.equal(out.previous_coordinator, undefined);
  });

  it("vários eventos: vence o mais recente; kind não-coordenador é ignorado", () => {
    const [out] = annotatePreviousCoordinator(
      [interactive],
      [
        ev({ ts: "2026-10-27T03:00:00Z", kind: "develop" }),
        ev({}),
        ev({ ts: "2026-10-27T12:48:27Z", kind: "interactive" }),
      ],
      NOW,
    );
    assert.equal(out.previous_coordinator?.kind, "overnight");
    assert.equal(out.previous_coordinator?.endedAt, "2026-10-27T12:48:25.185Z");
  });
});

describe("readSessionLifecycleEvents (#11299)", () => {
  it("ausente → []; linha corrompida é pulada", () => {
    const root = tmpRepo();
    assert.deepEqual(readSessionLifecycleEvents(root), []);
    writeFileSync(
      join(root, "data", "session-lifecycle.jsonl"),
      `${JSON.stringify(ev({}))}\n{lixo\n\n${JSON.stringify(ev({ sessionId: "b" }))}\n`,
    );
    assert.deepEqual(
      readSessionLifecycleEvents(root).map((e) => e.sessionId),
      [SID, "b"],
    );
  });
});

describe("fim a fim: register overnight → claim → end → beacon interactive (#11299)", () => {
  it("o claim existe enquanto a rodada vive; depois do end o interactive aparece anotado", () => {
    const root = tmpRepo();
    registerSession(root, "overnight", SID, { tag: "Neo" });
    const claim = claimIssueCheckAndSet(root, "overnight", SID, 11252, "Neo");
    assert.equal(claim.ok, true);
    const alive = listActiveSessions(root);
    assert.equal(alive.length, 1);
    assert.equal(alive[0].kind, "overnight", "register --kind overnight vale: o registro é overnight, não interactive");
    assert.deepEqual(alive[0].claimed_issues, [11252]);

    assert.equal(endSession(root, "overnight", SID, "Neo"), true);
    // O beacon da mesma conversa, na chamada de ferramenta seguinte.
    registerSession(root, "interactive", SID, { tag: "Neo" });

    const after = annotatePreviousCoordinator(listActiveSessions(root), readSessionLifecycleEvents(root));
    assert.equal(after.length, 1);
    assert.equal(after[0].kind, "interactive");
    assert.deepEqual(after[0].claimed_issues, []);
    assert.equal(after[0].previous_coordinator?.kind, "overnight");
    assert.equal(after[0].previous_coordinator?.event, "ended");
    assert.deepEqual(after[0].previous_coordinator?.claimed_issues_ever, [11252]);
  });
});
