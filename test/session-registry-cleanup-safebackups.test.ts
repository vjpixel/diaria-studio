/**
 * test/session-registry-cleanup-safebackups.test.ts (#6970)
 *
 * Cobre `planSafeBackupCleanup`/`cleanupReconciledSafeBackups`
 * (`scripts/lib/session-registry.ts`) — recolhimento de cópias de conflito
 * `-safeBackup-*` já reconciliadas (claims fundidas no arquivo real,
 * `reconcileClaims`/#6581) que `planSessionGc` nunca alcança porque a sessão
 * continua VIVA. Isolado em tmpdir — nunca toca `data/` real do repo.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  sessionsDir,
  planSafeBackupCleanup,
  cleanupReconciledSafeBackups,
  type SessionRecord,
} from "../scripts/lib/session-registry.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = join(tmpdir(), `session-registry-cleanup-safebackups-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  return root;
}

function writeRawSessionFile(root: string, name: string, record: Partial<SessionRecord>): void {
  mkdirSync(sessionsDir(root), { recursive: true });
  writeFileSync(join(sessionsDir(root), name), JSON.stringify(record), "utf8");
}

const BASE: SessionRecord = {
  kind: "develop",
  machineTag: "Neo",
  sessionId: "s1",
  startedAt: "2026-08-01T00:00:00.000Z",
  lastHeartbeat: "2026-08-01T00:00:00.000Z",
};

describe("planSafeBackupCleanup (#6970)", () => {
  it("grupo sem backup nenhum não aparece no plano (nada a fazer)", () => {
    const root = freshRoot();
    writeRawSessionFile(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1] });
    const plan = planSafeBackupCleanup(root);
    assert.deepEqual(plan, []);
  });

  it("backup já totalmente refletido no real, sem merge_grant → removable", () => {
    const root = freshRoot();
    writeRawSessionFile(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1, 2] });
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", { ...BASE, claimed_issues: [1, 2] });
    const plan = planSafeBackupCleanup(root);
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.action, "removable");
    assert.equal(plan[0]!.backupPaths.length, 1);
  });

  it("backup carrega claim ausente do real → pending-reconciliation (nunca removable)", () => {
    const root = freshRoot();
    writeRawSessionFile(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1] });
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", { ...BASE, claimed_issues: [1, 2] });
    const plan = planSafeBackupCleanup(root);
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.action, "pending-reconciliation");
  });

  it("claims reconciliadas mas backup carrega merge_grant → has-merge-grant, NUNCA removable (#6952 em aberto)", () => {
    const root = freshRoot();
    writeRawSessionFile(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1] });
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", {
      ...BASE,
      claimed_issues: [1],
      merge_grant: { grantedTo: "outra-sessao", grantedBy: "s1", grantedAt: "2026-08-01T00:00:00.000Z" },
    });
    const plan = planSafeBackupCleanup(root);
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.action, "has-merge-grant");
  });

  it("merge_grant CONSUMIDO/expirado no backup ainda preserva (conservador — não distingue consumido de vivo)", () => {
    const root = freshRoot();
    writeRawSessionFile(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1] });
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", {
      ...BASE,
      claimed_issues: [1],
      merge_grant: {
        grantedTo: "outra-sessao",
        grantedBy: "s1",
        grantedAt: "2026-01-01T00:00:00.000Z",
        consumedAt: "2026-01-01T00:05:00.000Z",
      },
    });
    const plan = planSafeBackupCleanup(root);
    assert.equal(plan[0]!.action, "has-merge-grant");
  });

  it("backups ÓRFÃOS (real desapareceu por completo, claims+grant vivos só nos backups) NUNCA são REMOVIDOS por este módulo, mas SÃO reportados como orphan-backups-only (#7002 incidente ao vivo 01/09/2026; observabilidade adicionada em resposta ao self-review finding 2 do #7005)", () => {
    // Reprodução do incidente real relatado pela coordenadora durante esta
    // rodada: o arquivo REAL overnight-helios-{sessionId}.json sumiu do
    // disco (lost-update, vizinho de #6952/#6573) enquanto a sessão seguia
    // viva; só sobraram 2 cópias -safeBackup- carregando 10 claims + um
    // merge_grant íntegros. planSafeBackupCleanup itera os REAIS existentes
    // pra decidir remoção — um grupo sem real correspondente é ÓRFÃO e NUNCA
    // tem seus backups tocados/removidos por este módulo (quem decide o
    // destino é o GC, pela liveness dele) — mas, diferente do comportamento
    // original, agora aparece no plano com `action: "orphan-backups-only"`
    // em vez de ficar invisível: um operador rodando `--dry-run` precisa ver
    // que há estado órfão a revisar, não concluir "nada a fazer".
    const root = freshRoot();
    writeRawSessionFile(root, "overnight-helios-sessXYZ-safeBackup-0001.json", {
      kind: "overnight",
      machineTag: "helios",
      sessionId: "sessXYZ",
      startedAt: "2026-09-01T10:00:00.000Z",
      lastHeartbeat: "2026-09-01T10:55:00.000Z",
      claimed_issues: [6947, 6970, 6972, 6621, 6623, 6624],
      merge_grant: { grantedTo: "outra-sessao", grantedBy: "sessXYZ", grantedAt: "2026-09-01T10:50:00.000Z" },
    });
    writeRawSessionFile(root, "overnight-helios-sessXYZ-safeBackup-0002.json", {
      kind: "overnight",
      machineTag: "helios",
      sessionId: "sessXYZ",
      startedAt: "2026-09-01T10:00:00.000Z",
      lastHeartbeat: "2026-09-01T11:00:00.000Z",
      claimed_issues: [6947, 6970, 6972, 6621, 6623, 6624],
    });
    // O beacon recria um registro `interactive` pra mesma sessionId — este
    // arquivo É um "real" (não tem -safeBackup- no nome), mas de kind
    // diferente e sem as claims: não muda o fato de que os 2 backups acima
    // continuam órfãos (nenhum deles bate o stem "interactive-helios-sessXYZ").
    writeRawSessionFile(root, "interactive-helios-sessXYZ.json", {
      kind: "interactive",
      machineTag: "helios",
      sessionId: "sessXYZ",
      startedAt: "2026-09-01T10:00:00.000Z",
      lastHeartbeat: "2026-09-01T11:05:00.000Z",
      claimed_issues: [],
    });

    const plan = planSafeBackupCleanup(root);
    // Os 2 backups órfãos aparecem no plano — mas SEMPRE com action
    // "orphan-backups-only", nunca "removable" (eles não batem o stem de
    // NENHUM real existente: "interactive-helios-sessXYZ" tem no próprio
    // nome "sessXYZ" mas kind diferente de "overnight", e o agrupamento é
    // por STEM completo do arquivo, não só sessionId).
    const orphanEntries = plan.filter((e) => e.backupPaths.some((p) => p.includes("overnight-helios-sessXYZ")));
    assert.equal(orphanEntries.length, 2, "cada backup órfão vira 1 entrada própria no plano");
    for (const e of orphanEntries) {
      assert.equal(e.action, "orphan-backups-only");
      assert.equal(e.realPath, null, "órfão não tem arquivo real — realPath é null");
    }
  });

  it("real ilegível → skipped-unreadable-real, nunca remove o backup", () => {
    const root = freshRoot();
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(join(sessionsDir(root), "develop-Neo-s1.json"), "{not valid json", "utf8");
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", { ...BASE, claimed_issues: [1] });
    const plan = planSafeBackupCleanup(root);
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.action, "skipped-unreadable-real");
  });

  it("múltiplos backups: só remove o grupo inteiro quando TODOS estão cobertos e nenhum tem grant", () => {
    const root = freshRoot();
    writeRawSessionFile(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1, 2, 3] });
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", { ...BASE, claimed_issues: [1] });
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0002.json", { ...BASE, claimed_issues: [2, 3] });
    const plan = planSafeBackupCleanup(root);
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.action, "removable");
    assert.equal(plan[0]!.backupPaths.length, 2);
  });

  it("diretório ausente → plano vazio, nunca lança", () => {
    assert.deepEqual(planSafeBackupCleanup(freshRoot()), []);
  });
});

describe("cleanupReconciledSafeBackups (#6970) — execução real, isolada em tmpdir", () => {
  it("remove de fato os backups de um grupo 'removable'", () => {
    const root = freshRoot();
    writeRawSessionFile(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1, 2] });
    const backupPath = join(sessionsDir(root), "develop-Neo-s1-safeBackup-0001.json");
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", { ...BASE, claimed_issues: [1, 2] });
    assert.ok(existsSync(backupPath));

    const plan = cleanupReconciledSafeBackups(root);
    assert.equal(plan[0]!.action, "removable");
    assert.ok(!existsSync(backupPath), "backup deveria ter sido removido");
  });

  it("NUNCA remove backup com merge_grant, mesmo com claims já reconciliadas", () => {
    const root = freshRoot();
    writeRawSessionFile(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1] });
    const backupPath = join(sessionsDir(root), "develop-Neo-s1-safeBackup-0001.json");
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", {
      ...BASE,
      claimed_issues: [1],
      merge_grant: { grantedTo: "outra-sessao", grantedBy: "s1", grantedAt: "2026-08-01T00:00:00.000Z" },
    });

    const plan = cleanupReconciledSafeBackups(root);
    assert.equal(plan[0]!.action, "has-merge-grant");
    assert.ok(existsSync(backupPath), "backup com merge_grant NUNCA pode ser removido enquanto #6952 estiver aberta");
  });

  it("grupo pending-reconciliation nunca remove nada", () => {
    const root = freshRoot();
    writeRawSessionFile(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1] });
    const backupPath = join(sessionsDir(root), "develop-Neo-s1-safeBackup-0001.json");
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", { ...BASE, claimed_issues: [1, 2] });

    const plan = cleanupReconciledSafeBackups(root);
    assert.equal(plan[0]!.action, "pending-reconciliation");
    assert.ok(existsSync(backupPath));
  });

  it("idempotente: rodar 2x não lança e a 2ª vez não encontra mais nada a remover", () => {
    const root = freshRoot();
    writeRawSessionFile(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1] });
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", { ...BASE, claimed_issues: [1] });

    const first = cleanupReconciledSafeBackups(root);
    assert.equal(first[0]!.action, "removable");

    const second = cleanupReconciledSafeBackups(root);
    assert.deepEqual(second, [], "sem backup restante, o grupo nem aparece mais no plano");
  });

  it("real fica ilegível entre plano e remoção → skipped-unreadable-real, backup preservado", () => {
    const root = freshRoot();
    writeRawSessionFile(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1] });
    const backupPath = join(sessionsDir(root), "develop-Neo-s1-safeBackup-0001.json");
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", { ...BASE, claimed_issues: [1] });

    // Simula a corrida: corrompe o real depois do plano ter sido calculado
    // internamente por cleanupReconciledSafeBackups (a função relê o real
    // no momento da remoção, então corrompê-lo ANTES da chamada já cobre o
    // caminho "ilegível no momento da escrita").
    writeFileSync(join(sessionsDir(root), "develop-Neo-s1.json"), "{not valid json", "utf8");

    const plan = cleanupReconciledSafeBackups(root);
    assert.equal(plan[0]!.action, "skipped-unreadable-real");
    assert.ok(existsSync(backupPath), "backup nunca é removido quando o real não pôde ser relido");
  });
});
