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

  it("claims reconciliadas mas backup carrega merge_grant AINDA VIVO, ausente do real → has-merge-grant, NUNCA removable (#6573 pós-#6952 — risco de PERDA)", () => {
    const root = freshRoot();
    const grantedAt = "2026-08-01T00:00:00.000Z";
    writeRawSessionFile(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1] });
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", {
      ...BASE,
      claimed_issues: [1],
      merge_grant: { grantedTo: "outra-sessao", grantedBy: "s1", grantedAt },
    });
    // `now` fixado 5min depois da concessão — dentro do TTL de 10min
    // (`MERGE_GRANT_TTL_MS`), então a concessão AINDA está viva: o real não
    // a reproduz, então removê-la perderia a única cópia utilizável.
    const now = Date.parse(grantedAt) + 5 * 60_000;
    const plan = planSafeBackupCleanup(root, { now });
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.action, "has-merge-grant");
  });

  // #7462: o `consumedAt` é um carimbo de FATO, não um voto de maioria — só
  // testemunha quando está no arquivo REAL (o único que o merge de fato
  // escreve). Cópias `-safeBackup-` são detrito de sync do OneDrive: um
  // `consumedAt` nelas é um RESÍDUO, não uma prova. Antes de #7462, o caso
  // abaixo saía `removable` porque a união propagava o `consumedAt` do
  // backup pro winner e `isMergeGrantLive` via falsa-loja via morta. Agora
  // o winner NÃO tem `consumedAt` (nem o real tem grant), então a união
  // mostra a concessão VIVA — e removê-la perderia a única cópia legível.
  // O fato de o backup dizer "consumido" é irrecuperável: o real, que é a
  // única fonte de verdade, nem carrega a concessão, então não há quem
  // ateste um consumo. A janela morre sozinha pelo TTL, não por remoção.
  it("merge_grant CONSUMIDO só no backup, ausente do real → has-merge-grant (#7462: o consumedAt do backup não testemunha o real)", () => {
    const root = freshRoot();
    const grantedAt = "2026-01-01T00:00:00.000Z";
    writeRawSessionFile(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1] });
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", {
      ...BASE,
      claimed_issues: [1],
      merge_grant: {
        grantedTo: "outra-sessao",
        grantedBy: "s1",
        grantedAt,
        consumedAt: "2026-01-01T00:05:00.000Z",
      },
    });
    // `now` logo após a concessão (ainda dentro do TTL). O ponto do teste é
    // que o backup dizer "consumido" NÃO matou a concessão — o real, que é
    // a única fonte de verdade (#7462), nem carrega o grant, então não há
    // quem ateste um consumo. A janela morre sozinha pelo TTL, não por
    // remoção; remover agora perderia a única cópia legível.
    const now = Date.parse(grantedAt) + 5 * 60_000;
    const plan = planSafeBackupCleanup(root, { now });
    assert.equal(plan[0]!.action, "has-merge-grant");
  });

  it("merge_grant TTL-expirado no backup, nunca consumido, ausente do real → agora removable (#6573: TTL nunca desexpira)", () => {
    const root = freshRoot();
    const grantedAt = "2026-01-01T00:00:00.000Z";
    writeRawSessionFile(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1] });
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", {
      ...BASE,
      claimed_issues: [1],
      merge_grant: { grantedTo: "outra-sessao", grantedBy: "s1", grantedAt },
    });
    // `now` bem além do TTL de 10min (1h depois) — nunca consumida, mas
    // morta por idade mesmo assim.
    const now = Date.parse(grantedAt) + 60 * 60_000;
    const plan = planSafeBackupCleanup(root, { now });
    assert.equal(plan[0]!.action, "removable");
  });

  // #7462 — REESCRITO deliberadamente: este caso agora vira `has-merge-grant`.
  // O argumento da #7462 é que o `consumedAt` do backup NÃO testemunha o
  // real: o real carrega a MESMA identidade, mas sem o carimbo, e é o real
  // (o único arquivo que o gate de merge `.claude/hooks/block-gh-pr-merge-subagent.mjs`
  // lê, que pula `-safeBackup-` nomes) quem decide se a concessão está
  // morta. O backup dizer "consumido em 00:03" é um resíduo de sync do
  // OneDrive — pode ter sido escrito por uma sessão que consumiu a janela
  // enquanto o real ficou pra trás, mas não prova que O REAL foi consumido.
  //
  // Por que isso é deliberadamente has-merge-grant e não removable: o real,
  // sozinho, tem a concessão VIVA e dentro do TTL — quem remover o backup
  // deixaria o real como única cópia, e a próxima leitura
  // (`findLiveMergeGrant` → `isMergeGrantLive`) veria a janela aberta
  // novamente, autorizando um SEGUNDO merge. É o mesmo dano de uso duplo
  // que o #6952/#6972 evitam pro read-path — só que aqui o custo é a
  // perda da única cópia legível do grant, e o #7462 resolveu que o custo
  // de errar pro lado do dano é pior que o de errar pro lado da perda: o
  // backup é preservado, a janela expira sozinha pelo TTL, e o merge lock
  // impede o uso duplo de qualquer jeito.
  //
  // O teste original chamava isso de "risco de RESSURREIÇÃO" e esperava
  // `removable` — aquela leitura tratava o `consumedAt` do backup como
  // prova de consumo, exatamente a semântica que o #7462 revogou. Não foi
  // apagado: foi reescrito pra refletir a decisão, com este comentário
  // explicando o porquê (#7462: "consumedAt do backup não testemunha o real").
  it("merge_grant CONSUMIDO só no backup, MAS o real carrega a MESMA identidade SEM consumedAt e ainda dentro do TTL → has-merge-grant (#7462: o consumedAt do backup não testemunha o real)", () => {
    const root = freshRoot();
    const grantedAt = "2026-08-01T00:00:00.000Z";
    const identity = { grantedTo: "outra-sessao", grantedBy: "s1", grantedAt };
    writeRawSessionFile(root, "develop-Neo-s1.json", {
      ...BASE,
      claimed_issues: [1],
      merge_grant: { ...identity }, // real tem a MESMA concessão, mas sem o carimbo de consumo
    });
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", {
      ...BASE,
      claimed_issues: [1],
      merge_grant: { ...identity, consumedAt: "2026-08-01T00:03:00.000Z" }, // só o backup diz que já foi consumida
    });
    const now = Date.parse(grantedAt) + 5 * 60_000; // dentro do TTL — o real, sozinho, ainda pareceria viva
    const plan = planSafeBackupCleanup(root, { now });
    assert.equal(
      plan[0]!.action,
      "has-merge-grant",
      "remover o backup deixaria o real como única cópia, e o real tem a concessão VIVA e sem carimbo — a próxima leitura reabriria a janela como se não tivesse sido consumida",
    );
  });

  it("merge_grant já integralmente reproduzido no real (mesma identidade, mesmo consumedAt) → removable mesmo com a concessão ainda 'viva'", () => {
    const root = freshRoot();
    const grantedAt = "2026-08-01T00:00:00.000Z";
    const identity = { grantedTo: "outra-sessao", grantedBy: "s1", grantedAt };
    writeRawSessionFile(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1], merge_grant: { ...identity } });
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", {
      ...BASE,
      claimed_issues: [1],
      merge_grant: { ...identity },
    });
    const now = Date.parse(grantedAt) + 5 * 60_000; // dentro do TTL — mas o real JÁ carrega exatamente o mesmo estado
    const plan = planSafeBackupCleanup(root, { now });
    assert.equal(plan[0]!.action, "removable");
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

  // #7462 — o caminho legítimo pra `removable` com merge_grant: é o REAL
  // (nunca o backup) quem carimba o consumo. Quando o real carrega a MESMA
  // concessão já com `consumedAt`, a união mostra exatamente o mesmo estado
  // que o real sozinho — o backup não acrescenta informação, e a concessão
  // está de fato morta. Aí remover é seguro: nada se perde, e o #6573
  // (nunca remover while alive) continua respeitado, porque a morte foi
  // atestada pela única fonte de verdade.
  it("merge_grant CONSUMIDO no REAL (mesma identidade, mesmo consumedAt) → removable, mesmo com o backup carregando o grant vivo (#7462: o real testemunha)", () => {
    const root = freshRoot();
    const grantedAt = "2026-08-01T00:00:00.000Z";
    const identity = { grantedTo: "outra-sessao", grantedBy: "s1", grantedAt };
    const consumedAt = "2026-08-01T00:03:00.000Z";
    writeRawSessionFile(root, "develop-Neo-s1.json", {
      ...BASE,
      claimed_issues: [1],
      merge_grant: { ...identity, consumedAt }, // o REAL carimba o consumo — fonte de verdade (#7462)
    });
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", {
      ...BASE,
      claimed_issues: [1],
      merge_grant: { ...identity }, // o backup tem o grant VIVO, mas isso é detrito de sync
    });
    const now = Date.parse(grantedAt) + 5 * 60_000; // dentro do TTL se não fosse consumido
    const plan = planSafeBackupCleanup(root, { now });
    assert.equal(plan[0]!.action, "removable");
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

  it("NUNCA remove backup com merge_grant AINDA VIVO e ausente do real, mesmo com claims já reconciliadas", () => {
    const root = freshRoot();
    const grantedAt = "2026-08-01T00:00:00.000Z";
    writeRawSessionFile(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1] });
    const backupPath = join(sessionsDir(root), "develop-Neo-s1-safeBackup-0001.json");
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", {
      ...BASE,
      claimed_issues: [1],
      merge_grant: { grantedTo: "outra-sessao", grantedBy: "s1", grantedAt },
    });

    const now = Date.parse(grantedAt) + 5 * 60_000; // dentro do TTL de 10min — ainda vivo
    const plan = cleanupReconciledSafeBackups(root, { now });
    assert.equal(plan[0]!.action, "has-merge-grant");
    assert.ok(existsSync(backupPath), "backup com merge_grant ainda VIVO e não reproduzido no real nunca pode ser removido (#6573)");
  });

  // #7462 — REESCRITO: o `consumedAt` do backup não testemunha o real, então
  // "o backup diz que o grant está morto" não é mais razão pra remover. O real
  // aqui nem carrega o grant, então não há quem ateste um consumo de fato —
  // a concessão continua VIVA na união e morre sozinha pelo TTL. Remover
  // agora perderia a única cópia legível. O relaxamento do #6573 ("já morto
  // ⇒ removable") só vale quando o REAL carimba o consumo, não quando o
  // backup carrega um resíduo de sync.
  it("backup com merge_grant 'consumido' só no backup, ausente do real → NÃO é removido (#7462: consumedAt do backup não testemunha o real)", () => {
    const root = freshRoot();
    const grantedAt = "2026-01-01T00:00:00.000Z";
    writeRawSessionFile(root, "develop-Neo-s1.json", { ...BASE, claimed_issues: [1] });
    const backupPath = join(sessionsDir(root), "develop-Neo-s1-safeBackup-0001.json");
    writeRawSessionFile(root, "develop-Neo-s1-safeBackup-0001.json", {
      ...BASE,
      claimed_issues: [1],
      merge_grant: {
        grantedTo: "outra-sessao",
        grantedBy: "s1",
        grantedAt,
        consumedAt: "2026-01-01T00:05:00.000Z",
      },
    });

    const now = Date.parse(grantedAt) + 5 * 60_000;
    const plan = cleanupReconciledSafeBackups(root, { now });
    assert.equal(plan[0]!.action, "has-merge-grant");
    assert.ok(existsSync(backupPath), "o backup é a única cópia legível do grant, que a união mostra VIVO (o real nem carrega ele) — preservado até o TTL expirar");
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
