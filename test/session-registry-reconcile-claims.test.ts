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
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  sessionsDir,
  sessionFilePath,
  registerSession,
  claimIssueCheckAndSet,
  unclaimIssue,
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

  // ── #6698 — nunca ressuscita claim removida por unclaimIssue PRÉ-#6567 ──

  it("cenário (a) — claim válida só no backup, com claimed_issues_at POSTERIOR ao heartbeat do real → adiciona (#6698)", () => {
    const real: SessionRecord = {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s10",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [],
    };
    // A claim aconteceu DEPOIS do último heartbeat conhecido do real — sinal
    // de que o real ficou pra trás (não teve chance de refletir a escrita).
    const backup: SessionRecord = {
      ...real,
      claimed_issues: [100],
      claimed_issues_at: { "100": "2026-08-02T00:00:00.000Z" },
    };
    const decision = decideClaimReconciliation(real, [backup]);
    assert.deepEqual(decision.addedIssues, [100], "claim genuína (backup mais novo que o real) deve ser ressuscitada");
  });

  it("cenário (b) — claim removida por unclaimIssue pré-#6567 (claimed_issues_at ANTERIOR/igual ao heartbeat do real) → NÃO ressuscita (#6698)", () => {
    const real: SessionRecord = {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s11",
      // O real já bateu heartbeat DEPOIS da claim original (ex: um
      // `unclaimIssue` pré-#6567 que só tocou o real) — teve chance de
      // refletir a issue e genuinamente não a tem.
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-10T00:00:00.000Z",
      claimed_issues: [],
    };
    // Backup é um resíduo — a claim original é mais ANTIGA que o heartbeat
    // atual do real.
    const backup: SessionRecord = {
      ...real,
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [100],
      claimed_issues_at: { "100": "2026-08-01T00:00:00.000Z" },
    };
    const decision = decideClaimReconciliation(real, [backup]);
    assert.deepEqual(decision.addedIssues, [], "claim já removida deliberadamente não deve ser ressuscitada");
    assert.deepEqual(decision.addedClaimedIssuesAt, {});
  });

  it("cenário (b), timestamp EXATAMENTE igual ao heartbeat do real → também não ressuscita (limite inclusivo, #6698)", () => {
    const real: SessionRecord = {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s12",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-05T00:00:00.000Z",
      claimed_issues: [],
    };
    const backup: SessionRecord = {
      ...real,
      claimed_issues: [100],
      claimed_issues_at: { "100": "2026-08-05T00:00:00.000Z" },
    };
    assert.deepEqual(decideClaimReconciliation(real, [backup]).addedIssues, []);
  });

  it("sem claimed_issues_at (claim pré-#6436) → sem evidência, preserva o comportamento anterior (adiciona, #6698)", () => {
    const real: SessionRecord = {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s13",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-10T00:00:00.000Z",
      claimed_issues: [],
    };
    // Backup sem claimed_issues_at nenhum — impossível provar remoção
    // deliberada, então o fallback é o comportamento pré-#6698 (adiciona).
    const backup: SessionRecord = { ...real, lastHeartbeat: "2026-08-01T00:00:00.000Z", claimed_issues: [100] };
    assert.deepEqual(decideClaimReconciliation(real, [backup]).addedIssues, [100]);
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
    assert.deepEqual((readRealRecord(root, realPath).claimed_issues ?? []).sort((a, b) => a - b), [100, 200, 300]);
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

  it("preserva claimed_issues_at PRÉ-EXISTENTE do real — só acrescenta entradas novas, nunca sobrescreve (#6583 fleet review)", () => {
    const root = freshRoot();
    registerSession(root, "develop", "s6", { tag: "Neo" });
    claimIssueCheckAndSet(root, "develop", "s6", 100, "Neo", "2026-08-01T00:00:00.000Z");
    const realPath = sessionFilePath(root, "develop", "Neo", "s6");

    writeRawSessionFile(root, "develop-Neo-s6-Neo-safeBackup-0001.json", {
      kind: "develop",
      machineTag: "Neo",
      sessionId: "s6",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [100, 200],
      // timestamp DIFERENTE do que o real já tem pra 100 — não deveria vencer.
      claimed_issues_at: { "100": "2026-08-05T00:00:00.000Z", "200": "2026-08-02T00:00:00.000Z" },
    });

    const before = readRealRecord(root, realPath);
    const originalAt100 = before.claimed_issues_at!["100"];

    reconcileClaims(root);
    const after = readRealRecord(root, realPath);
    assert.deepEqual(after.claimed_issues, [100, 200]);
    assert.equal(after.claimed_issues_at!["100"], originalAt100, "timestamp da claim 100 (já existente no real) não muda");
    assert.equal(after.claimed_issues_at!["200"], "2026-08-02T00:00:00.000Z", "timestamp da claim 200 (nova) vem do backup");
  });

  it("nunca ressuscita uma claim legitimamente removida via unclaimIssue entre o plano e a escrita (#6583 fleet review — 3 revisores independentes)", () => {
    const root = freshRoot();
    registerSession(root, "continuo", "s7", { tag: "predator" });
    claimIssueCheckAndSet(root, "continuo", "s7", 10, "predator");
    const realPath = sessionFilePath(root, "continuo", "predator", "s7");

    // Backup mostra 10, 20 e 30 — 20 e 30 são "novidade" do ponto de vista do
    // plano (real só tem 10 até aqui).
    writeRawSessionFile(root, "continuo-predator-s7-predator-safeBackup-0001.json", {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "s7",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [10, 20, 30],
    });

    // Plano "congela" addedIssues=[20,30] — é exatamente esse array que uma
    // implementação ingênua reaplicaria cegamente na escrita.
    const plan = planClaimReconciliation(root);
    const group = plan.find((e) => e.realPath === realPath)!;
    assert.deepEqual(group.addedIssues, [20, 30]);

    // Simula a corrida: entre o "plano" e a "escrita" real, a issue 20 é
    // LEGITIMAMENTE liberada. unclaimIssue funciona mesmo a claim só
    // existindo num backup (merge-antes-de-checar, #6481) e propaga a
    // remoção a TODO backup do grupo (#6567) — com isso, o PRÓPRIO backup
    // deixa de listar 20 (e ganha 30 como efeito colateral da escrita
    // mesclada de unclaimIssue): passa a valer [10, 30] nos dois arquivos.
    const unclaimResult = unclaimIssue(root, "continuo", "s7", 20, "predator");
    assert.equal(unclaimResult.ok, true);
    assert.deepEqual(readRealRecord(root, realPath).claimed_issues, [10, 30]);

    // reconcileClaims RECOMPUTA contra o estado fresco em vez de reaplicar
    // o addedIssues=[20,30] congelado do plano — 20 não deve reaparecer.
    const applied = reconcileClaims(root);
    const appliedGroup = applied.find((e) => e.realPath === realPath)!;
    assert.equal(appliedGroup.action, "no-change", "nada de novo contra o estado fresco — já convergido pelo próprio unclaimIssue");
    assert.deepEqual(appliedGroup.addedIssues, [], "20 não reaparece — foi legitimamente removida");
    assert.deepEqual(readRealRecord(root, realPath).claimed_issues, [10, 30], "20 permanece fora, nada além do que unclaimIssue já tinha convergido");
  });

  it("action write-failed é distinta de no-change quando a escrita falha (não colapsa as duas semânticas)", () => {
    const root = freshRoot();
    registerSession(root, "develop", "s8", { tag: "Neo" });
    writeRawSessionFile(root, "develop-Neo-s8-Neo-safeBackup-0001.json", {
      kind: "develop",
      machineTag: "Neo",
      sessionId: "s8",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [999],
    });

    // Tira a permissão de ESCRITA do diretório (mantém leitura+execução) —
    // `writeFileAtomic` cria um tmp file novo no mesmo dir antes do rename,
    // então essa escrita falha (EACCES) sem afetar a LEITURA do real/backup
    // já existentes (mesmo padrão de sondar o efeito do chmod usado em
    // `test/session-registry.test.ts` "checkSessionsScanHealth" — root e o
    // NTFS do Windows não respeitam bits POSIX, então pula sem assert se o
    // chmod não morder de fato neste ambiente).
    const dir = sessionsDir(root);
    chmodSync(dir, 0o555);
    try {
      let bites = true;
      try {
        writeFileSync(join(dir, "__write_probe__"), "x");
        rmSync(join(dir, "__write_probe__"));
        bites = false;
      } catch {
        // escrita bloqueada como esperado — chmod mordeu, segue pro teste real.
      }
      if (!bites) return;

      const applied = reconcileClaims(root);
      const group = applied.find((e) => e.identity === "develop-Neo-s8")!;
      assert.equal(group.action, "write-failed");
      assert.match(group.reason, /escrita falhou/);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it("aggrega unreadableBackupCount por grupo — backup corrompido não vira issue silenciosamente perdida sem sinal", () => {
    const root = freshRoot();
    registerSession(root, "develop", "s9", { tag: "Neo" });
    const realPath = sessionFilePath(root, "develop", "Neo", "s9");
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(join(sessionsDir(root), "develop-Neo-s9-Neo-safeBackup-0001.json"), "{not valid json", "utf8");
    writeRawSessionFile(root, "develop-Neo-s9-Neo-safeBackup-0002.json", {
      kind: "develop",
      machineTag: "Neo",
      sessionId: "s9",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [55],
    });

    const plan = planClaimReconciliation(root);
    const group = plan.find((e) => e.realPath === realPath)!;
    assert.equal(group.unreadableBackupCount, 1);
    assert.equal(group.addedIssues.length, 1, "backup legível continua contribuindo mesmo com um irmão corrompido");
  });
});

// ─── CLI (scripts/session-registry-reconcile-claims.ts) ────────────────────

describe("CLI session-registry-reconcile-claims (#6583 fleet review — cobertura ausente apontada por 2 revisores)", () => {
  const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "session-registry-reconcile-claims.ts");

  function runCli(root: string, extraArgs: string[] = []): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--root", root, ...extraArgs], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      encoding: "utf8",
      timeout: 30_000,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  it("dry-run (default, sem --push) nunca escreve no disco", () => {
    const root = freshRoot();
    registerSession(root, "continuo", "cli-s1", { tag: "predator" });
    claimIssueCheckAndSet(root, "continuo", "cli-s1", 1, "predator");
    const realPath = sessionFilePath(root, "continuo", "predator", "cli-s1");
    writeRawSessionFile(root, "continuo-predator-cli-s1-predator-safeBackup-0001.json", {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "cli-s1",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [1, 2],
    });

    const before = readRealRecord(root, realPath);
    const res = runCli(root);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /would-reconcile/);
    const after = readRealRecord(root, realPath);
    assert.deepEqual(after, before, "CLI sem --push não grava nada");
  });

  it("--push grava de verdade a união no arquivo real", () => {
    const root = freshRoot();
    registerSession(root, "continuo", "cli-s2", { tag: "predator" });
    claimIssueCheckAndSet(root, "continuo", "cli-s2", 1, "predator");
    const realPath = sessionFilePath(root, "continuo", "predator", "cli-s2");
    writeRawSessionFile(root, "continuo-predator-cli-s2-predator-safeBackup-0001.json", {
      kind: "continuo",
      machineTag: "predator",
      sessionId: "cli-s2",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [1, 2],
    });

    const res = runCli(root, ["--push"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /reconciled/);
    assert.doesNotMatch(res.stdout, /would-reconcile/);
    assert.deepEqual(readRealRecord(root, realPath).claimed_issues, [1, 2]);
  });

  it("exit code 1 quando algum grupo termina skipped-unreadable-real", () => {
    const root = freshRoot();
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(join(sessionsDir(root), "develop-Neo-cli-corrompido.json"), "{not valid json", "utf8");
    writeRawSessionFile(root, "develop-Neo-cli-corrompido-Neo-safeBackup-0001.json", {
      kind: "develop",
      machineTag: "Neo",
      sessionId: "cli-corrompido",
      startedAt: "2026-08-01T00:00:00.000Z",
      lastHeartbeat: "2026-08-01T00:00:00.000Z",
      claimed_issues: [7],
    });

    const res = runCli(root, ["--push"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /skipped-unreadable-real/);
  });

  it("exit code 0 quando só há grupos saudáveis (sem backup ilegível, sem falha de escrita)", () => {
    const root = freshRoot();
    registerSession(root, "develop", "cli-s3", { tag: "Neo" });
    const res = runCli(root, ["--push"]);
    assert.equal(res.status, 0);
  });

  it("data/ ausente: exit 0, mensagem clara, nunca lança", () => {
    const root = freshRoot();
    const res = runCli(root);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /data\/ ausente/);
  });
});
