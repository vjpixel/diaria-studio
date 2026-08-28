/**
 * test/session-registry-reconcile-claims.test.ts (#6581)
 *
 * Cobre `planClaimReconciliation`/`reconcileClaims`/`decideClaimReconciliation`
 * (`scripts/lib/session-registry.ts`) — reconciliação one-shot do estoque de
 * claims presos em cópias de conflito `-safeBackup-*` do OneDrive que o
 * write-path do #6567 não alcança (sessão já encerrada, nunca chama
 * `unclaimIssue`). Isolado em tmpdir — nunca toca `data/` real do repo.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  sessionsDir,
  sessionFilePath,
  registerSession,
  claimIssueCheckAndSet,
  planClaimReconciliation,
  reconcileClaims,
  decideClaimReconciliation,
  type SessionRecord,
} from "../scripts/lib/session-registry.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = join(tmpdir(), `session-registry-reconcile-claims-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  return root;
}

/** Escreve um arquivo de sessão bruto sob `data/sessions/{name}` — mesmo
 * helper usado por `test/session-registry.test.ts` pra simular cópias de
 * conflito do OneDrive (`-safeBackup-NNNN`), que `registerSession`/
 * `claimIssueCheckAndSet` nunca produzem sozinhos (essas sempre escrevem o
 * nome "real"). */
function writeRawSessionFile(root: string, name: string, record: Partial<SessionRecord>): void {
  mkdirSync(sessionsDir(root), { recursive: true });
  writeFileSync(join(sessionsDir(root), name), JSON.stringify(record), "utf8");
}

function readRealRecord(root: string, path: string): SessionRecord {
  return JSON.parse(readFileSync(path, "utf8")) as SessionRecord;
}

// ─── decideClaimReconciliation (pura) ──────────────────────────────────────

describe("decideClaimReconciliation (#6581) — pura, sem I/O", () => {
  it("adiciona issues presentes só nos backups, nunca remove issue já no real", () => {
    const real: SessionRecord = {
      kind: "develop",
      machineTag: "Neo",
      sessionId: "s1",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [100],
    };
    const backup: SessionRecord = { ...real, claimed_issues: [100, 200, 300] };

    const decision = decideClaimReconciliation(real, [backup]);
    assert.deepEqual(decision.addedIssues, [200, 300]);
  });

  it("sem backups legíveis, não adiciona nada", () => {
    const real: SessionRecord = {
      kind: "develop",
      machineTag: "Neo",
      sessionId: "s1",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [100],
    };
    assert.deepEqual(decideClaimReconciliation(real, []), { addedIssues: [], addedClaimedIssuesAt: {} });
  });

  it("real já tem TODAS as issues do backup — nenhuma adição (idempotência no nível puro)", () => {
    const real: SessionRecord = {
      kind: "develop",
      machineTag: "Neo",
      sessionId: "s1",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [100, 200],
    };
    const backup: SessionRecord = { ...real, claimed_issues: [100] };
    assert.deepEqual(decideClaimReconciliation(real, [backup]).addedIssues, []);
  });

  it("carrega claimed_issues_at só para as issues adicionadas", () => {
    const real: SessionRecord = {
      kind: "develop",
      machineTag: "Neo",
      sessionId: "s1",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [100],
      claimed_issues_at: { "100": "2026-08-01T00:00:00.000Z" },
    };
    const backup: SessionRecord = {
      ...real,
      claimed_issues: [100, 200],
      claimed_issues_at: { "100": "2026-08-05T00:00:00.000Z", "200": "2026-08-02T00:00:00.000Z" },
    };
    const decision = decideClaimReconciliation(real, [backup]);
    assert.deepEqual(decision.addedIssues, [200]);
    assert.deepEqual(decision.addedClaimedIssuesAt, { "200": "2026-08-02T00:00:00.000Z" });
  });
});

// ─── planClaimReconciliation / reconcileClaims (integração, tmpdir) ────────

describe("planClaimReconciliation / reconcileClaims (#6581)", () => {
  it("união correta entre real + N backups — issues exclusivas de cada backup são somadas", () => {
    const root = freshRoot();
    registerSession(root, "continuo", "s1", { tag: "predator" });
    claimIssueCheckAndSet(root, "continuo", "s1", 100, "predator");
    const realPath = sessionFilePath(root, "continuo", "predator", "s1");

    writeRawSessionFile(root, "continuo-predator-s1-predator-safeBackup-0001.json", {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s1",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [100, 200],
    });
    writeRawSessionFile(root, "continuo-predator-s1-predator-safeBackup-0002.json", {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s1",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [100, 300],
    });

    const plan = planClaimReconciliation(root);
    const group = plan.find((e) => e.realPath === realPath);
    assert.ok(group, "grupo ancorado no arquivo real deve aparecer no plano");
    assert.equal(group!.action, "reconciled");
    assert.deepEqual(group!.addedIssues, [200, 300]);

    // plan sozinho nunca escreve
    assert.deepEqual(readRealRecord(root, realPath).claimed_issues, [100]);

    const applied = reconcileClaims(root);
    const appliedGroup = applied.find((e) => e.realPath === realPath);
    assert.equal(appliedGroup!.action, "reconciled");
    assert.deepEqual(readRealRecord(root, realPath).claimed_issues.sort((a, b) => a - b), [100, 200, 300]);
  });

  it("nunca remove uma claim que só existe no arquivo real (direção fail-safe)", () => {
    const root = freshRoot();
    registerSession(root, "develop", "s2", { tag: "Neo" });
    claimIssueCheckAndSet(root, "develop", "s2", 500, "Neo");
    const realPath = sessionFilePath(root, "develop", "Neo", "s2");

    // backup SEM a issue 500 — nunca deveria remover
    writeRawSessionFile(root, "develop-Neo-s2-Neo-safeBackup-0001.json", {
      kind: "develop",
      machineTag: "Neo",
      sessionId: "s2",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [],
    });

    reconcileClaims(root);
    assert.deepEqual(readRealRecord(root, realPath).claimed_issues, [500]);
  });

  it("idempotente: rodar reconcileClaims 2× não muda nada na 2ª", () => {
    const root = freshRoot();
    registerSession(root, "continuo", "s3", { tag: "predator" });
    claimIssueCheckAndSet(root, "continuo", "s3", 10, "predator");
    const realPath = sessionFilePath(root, "continuo", "predator", "s3");
    writeRawSessionFile(root, "continuo-predator-s3-predator-safeBackup-0001.json", {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s3",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [10, 20],
    });

    const first = reconcileClaims(root);
    assert.equal(first.find((e) => e.realPath === realPath)!.action, "reconciled");
    const stateAfterFirst = readRealRecord(root, realPath);
    assert.deepEqual(stateAfterFirst.claimed_issues, [10, 20]);

    const second = reconcileClaims(root);
    assert.equal(second.find((e) => e.realPath === realPath)!.action, "no-change", "2ª rodada não encontra mais nada a adicionar");
    const stateAfterSecond = readRealRecord(root, realPath);
    assert.deepEqual(stateAfterSecond, stateAfterFirst, "conteúdo do arquivo real idêntico após a 2ª rodada");
  });

  it("grupo SEM arquivo real (só backups órfãos) — reporta, nunca cria arquivo real", () => {
    const root = freshRoot();
    writeRawSessionFile(root, "develop-Neo-s-encerrada-Neo-safeBackup-0001.json", {
      kind: "develop",
      machineTag: "Neo",
      sessionId: "s-encerrada",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [999],
    });

    const plan = planClaimReconciliation(root);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, "orphan-backups-only");
    assert.equal(plan[0].realPath, null);
    assert.equal(plan[0].identity, "orphan-backup:develop-Neo-s-encerrada-Neo-safeBackup-0001.json");

    const realPath = sessionFilePath(root, "develop", "Neo", "s-encerrada");
    reconcileClaims(root);
    // Nenhum arquivo real foi criado do zero para o grupo órfão.
    assert.throws(() => readRealRecord(root, realPath));
  });

  it("JSON corrompido no arquivo real — pula o grupo, nunca lança", () => {
    const root = freshRoot();
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(join(sessionsDir(root), "develop-Neo-corrompido.json"), "{not valid json", "utf8");
    writeRawSessionFile(root, "develop-Neo-corrompido-Neo-safeBackup-0001.json", {
      kind: "develop",
      machineTag: "Neo",
      sessionId: "corrompido",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [7],
    });

    assert.doesNotThrow(() => planClaimReconciliation(root));
    const plan = planClaimReconciliation(root);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, "skipped-unreadable-real");

    assert.doesNotThrow(() => reconcileClaims(root));
  });

  it("JSON corrompido num BACKUP não bloqueia o resto do grupo", () => {
    const root = freshRoot();
    registerSession(root, "develop", "s4", { tag: "Neo" });
    const realPath = sessionFilePath(root, "develop", "Neo", "s4");
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(join(sessionsDir(root), "develop-Neo-s4-Neo-safeBackup-0001.json"), "{not valid json", "utf8");
    writeRawSessionFile(root, "develop-Neo-s4-Neo-safeBackup-0002.json", {
      kind: "develop",
      machineTag: "Neo",
      sessionId: "s4",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [42],
    });

    const applied = reconcileClaims(root);
    const group = applied.find((e) => e.realPath === realPath);
    assert.equal(group!.action, "reconciled");
    assert.deepEqual(readRealRecord(root, realPath).claimed_issues, [42]);
  });

  it("dry-run (planClaimReconciliation) não escreve nada no disco", () => {
    const root = freshRoot();
    registerSession(root, "continuo", "s5", { tag: "predator" });
    const realPath = sessionFilePath(root, "continuo", "predator", "s5");
    writeRawSessionFile(root, "continuo-predator-s5-predator-safeBackup-0001.json", {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s5",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [1, 2, 3],
    });

    const before = readRealRecord(root, realPath);
    const plan = planClaimReconciliation(root);
    assert.equal(plan.find((e) => e.realPath === realPath)!.action, "reconciled");
    const after = readRealRecord(root, realPath);
    assert.deepEqual(after, before, "planClaimReconciliation nunca toca o disco");
  });

  it("diretório ausente → plano vazio, nunca lança", () => {
    assert.deepEqual(planClaimReconciliation(freshRoot()), []);
  });
});
