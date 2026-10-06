/**
 * gc-data-dir-9732.test.ts (#9732)
 *
 * Regressão do bucket `backup-sibling` (cópias de conflito do OneDrive):
 *   1. OPT-IN no `--apply` — o default (e a task semanal agendada) não remove
 *      nenhuma cópia-irmã; o dry-run continua listando;
 *   2. mesmo com `--include-bucket backup-sibling`, store (`*.db*`,
 *      `*.sqlite*`) e arquivo editorial (`0N-*.md`, `*.md` sob `editions/`)
 *      nunca saem;
 *   3. agrupamento por FAMÍLIA (nome canônico), não por diretório;
 *   4. cópia sem canônico ao lado nunca sai, e falsos positivos de nome
 *      (`coletar-do-zenbook.ps1`, `aplicar-no-zenbook.ps1`, `run-Zenbook.log`);
 *   5. idade conservadora (mais recente entre mtime/ctime/birthtime) e
 *      retenção de 28 dias.
 *
 * Tudo contra tmpdir fixture — NUNCA o `data/` real (junction do OneDrive).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, statSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { collectCandidates, conservativeTimestampMs, main } from "../scripts/gc-data-dir.ts";
import {
  OPT_IN_BUCKETS,
  BACKUP_SIBLING_RETENTION_DAYS,
  resolveEnabledBuckets,
  isBackupSiblingFilename,
  isBackupSiblingProtected,
  backupSiblingCanonicalName,
  classifyBackupSiblings,
  type AgedFile,
} from "../scripts/lib/data-dir-gc-policy.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-10-06T12:00:00Z");
const MTIME = (st: Stats): number => st.mtimeMs;
const ALL_EXIST = { canonicalExists: () => true };

function aged(relPath: string, ageDays: number): AgedFile {
  return { relPath, sizeBytes: 10, ageDays, mtimeMs: NOW - ageDays * DAY_MS };
}

function writeAged(path: string, content: string, ageDays: number): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content);
  const t = (Date.now() - ageDays * DAY_MS) / 1000;
  utimesSync(path, t, t);
}

function runMain(argv: string[], siblingTs: (st: Stats) => number = MTIME): string[] {
  const out: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exitCode;
  console.log = (msg: unknown) => out.push(String(msg));
  console.error = (msg: unknown) => out.push(String(msg));
  try {
    main(argv, undefined, siblingTs);
  } finally {
    process.exitCode = originalExit;
    console.log = originalLog;
    console.error = originalError;
  }
  return out;
}

describe("#9732 — backup-sibling é OPT-IN", () => {
  it("está em OPT_IN_BUCKETS e fora do default de resolveEnabledBuckets", () => {
    assert.ok(OPT_IN_BUCKETS.includes("backup-sibling"));
    assert.equal(resolveEnabledBuckets().has("backup-sibling"), false);
    assert.equal(resolveEnabledBuckets(["backup-sibling"]).has("backup-sibling"), true);
  });

  it("a task agendada Diaria-Gc-Data-Dir-Weekly não passa --include-bucket (nem backup-sibling, nem mv-cache)", () => {
    const task = getScheduledTaskByName("Diaria-Gc-Data-Dir-Weekly");
    assert.ok(task, "task registrada");
    for (const step of task!.steps ?? []) {
      const args = (step.args ?? []).join(" ");
      assert.equal(args.includes("--include-bucket"), false, `step ${step.key}: ${args}`);
      assert.equal(args.includes("backup-sibling"), false, `step ${step.key}: ${args}`);
    }
  });

  it("--apply default NÃO remove nenhuma cópia-irmã — e o dry-run ainda a lista", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gc-9732-default-"));
    const old = resolve(tmp, "logs/run-log-predator-safeBackup-0001.jsonl");
    const newer = resolve(tmp, "logs/run-log-Neo.jsonl");
    writeAged(resolve(tmp, "logs/run-log.jsonl"), "canônico", 400);
    writeAged(old, "velho", 400);
    writeAged(newer, "recente", 1);

    const dry = runMain(["--data-root", tmp]);
    assert.ok(
      dry.some((l) => l.includes("[backup-sibling]") && l.includes("run-log-predator-safeBackup-0001.jsonl")),
      "dry-run inventaria a cópia elegível como opt-in",
    );
    assert.ok(dry.some((l) => l.includes("--include-bucket") && l.includes("backup-sibling")));

    runMain(["--data-root", tmp, "--apply"]);
    assert.equal(existsSync(old), true, "default do --apply preserva toda cópia-irmã");
    assert.equal(existsSync(newer), true);

    runMain(["--data-root", tmp, "--apply", "--include-bucket", "backup-sibling"]);
    assert.equal(existsSync(old), false, "só o opt-in explícito remove");
    assert.equal(existsSync(newer), true, "a mais recente da família fica");
  });
});

describe("#9732 — store e arquivo editorial nunca saem, nem com opt-in", () => {
  it("cópia -Neo.db de store com >14d, dividindo o diretório com outra mais nova, NÃO sai no default nem no opt-in", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gc-9732-store-"));
    const dir = resolve(tmp, "diaria-subscribers");
    const canonical = resolve(dir, "diaria-subscribers.db");
    const oldCopy = resolve(dir, "diaria-subscribers-Neo.db");
    const newerCopy = resolve(dir, "diaria-subscribers-predator-safeBackup-0001.db");
    const oldClarice = resolve(tmp, "clarice-subscribers/clarice-users-Neo.db");
    const newerClarice = resolve(tmp, "clarice-subscribers/clarice-users-Zenbook.db");
    writeAged(canonical, "canônico", 1);
    writeAged(oldCopy, "única cópia das escritas do Neo", 60);
    writeAged(newerCopy, "mais nova", 2);
    writeAged(resolve(tmp, "clarice-subscribers/clarice-users.db"), "canônico", 1);
    writeAged(oldClarice, "velha", 60);
    writeAged(newerClarice, "nova", 2);

    const { candidates } = collectCandidates(tmp, Date.now(), { siblingTimestamp: MTIME });
    assert.equal(candidates.some((c) => c.relPath.endsWith(".db")), false, "store nunca é candidato");

    runMain(["--data-root", tmp, "--apply"]);
    runMain(["--data-root", tmp, "--apply", "--include-bucket", "backup-sibling,mv-cache"]);
    for (const f of [canonical, oldCopy, newerCopy, oldClarice, newerClarice]) {
      assert.equal(existsSync(f), true, `${f} preservado`);
    }
  });

  it("02-reviewed-Neo.md de edição (e qualquer .md sob editions/) não sai com opt-in", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gc-9732-editorial-"));
    const ed = resolve(tmp, "editions/2610/261007");
    const old = resolve(ed, "02-reviewed-Neo.md");
    const oldSocial = resolve(ed, "notas-Neo.md");
    writeAged(resolve(ed, "02-reviewed.md"), "canônico", 1);
    writeAged(old, "revisão do editor no Neo", 60);
    writeAged(resolve(ed, "02-reviewed-Zenbook.md"), "outra", 2);
    writeAged(resolve(ed, "notas.md"), "canônico", 1);
    writeAged(oldSocial, "velho", 60);
    writeAged(resolve(ed, "notas-Zenbook.md"), "novo", 2);

    runMain(["--data-root", tmp, "--apply", "--include-bucket", "backup-sibling"]);
    assert.equal(existsSync(old), true);
    assert.equal(existsSync(oldSocial), true);
  });

  it("isBackupSiblingProtected: db/sqlite/sidecars/.bak de store, 0N-*.md, *.md sob editions/", () => {
    for (const p of [
      "diaria-subscribers/diaria-subscribers-Neo.db",
      "clarice-subscribers/clarice-users.db.bak-260728-pre-build",
      "x/store-Neo.db-wal",
      "x/cache-300.sqlite",
      "x/cache.sqlite3-Neo.bak",
      "drafts/03-social-Neo.md",
      "editions/2610/261007/notas-Neo.md",
    ]) {
      assert.equal(isBackupSiblingProtected(p), true, p);
    }
    for (const p of ["logs/run-log-Neo.jsonl", "brevo-rate-state-300-safeBackup-0003.json", "docs/notas-Neo.md"]) {
      assert.equal(isBackupSiblingProtected(p), false, p);
    }
  });
});

describe("#9732 — agrupamento por família (nome canônico), não por diretório", () => {
  it("backupSiblingCanonicalName remove os sufixos de conflito até estabilizar", () => {
    assert.equal(backupSiblingCanonicalName("clarice-users-predator-safeBackup-0001.db"), "clarice-users.db");
    assert.equal(backupSiblingCanonicalName("run-log-Neo-2.jsonl"), "run-log.jsonl");
    assert.equal(backupSiblingCanonicalName("clarice-users.db.bak-260728-pre-build"), "clarice-users.db");
    assert.equal(backupSiblingCanonicalName("x-fromWindows-260817-0146.db.bak"), "x.db");
    assert.equal(
      backupSiblingCanonicalName("overnight-300-5955c9a5-300-safeBackup-0001.json"),
      "overnight-300-5955c9a5.json",
      "só o sufixo do FIM sai — o `300` do meio do nome fica",
    );
    assert.equal(backupSiblingCanonicalName("run-log.jsonl"), null);
  });

  it("2 canônicos no mesmo diretório: a cópia mais recente de CADA um sobrevive", () => {
    const files = [
      aged("d/a-Neo.json", 60),
      aged("d/a-Neo-2.json", 40),
      aged("d/b-Neo.json", 50), // única de b — mais nova de b mesmo sendo mais velha que a-Neo-2
    ];
    const out = classifyBackupSiblings(files, 28, ALL_EXIST).map((c) => c.relPath);
    assert.deepEqual(out, ["d/a-Neo.json"], "b-Neo é a mais recente da família b — nunca candidata");
  });

  it("cópia cujo canônico não existe nunca sai (pode ser a única cópia)", () => {
    const files = [aged("d/a-Neo.json", 60), aged("d/a-Neo-2.json", 40)];
    assert.deepEqual(classifyBackupSiblings(files, 28), [], "default canonicalExists = false (fail-closed)");
    assert.deepEqual(classifyBackupSiblings(files, 28, { canonicalExists: (r) => r !== "d/a.json" }), []);
    assert.deepEqual(
      classifyBackupSiblings(files, 28, { canonicalExists: (r) => r === "d/a.json" }).map((c) => c.relPath),
      ["d/a-Neo.json"],
    );
  });
});

describe("#9732 — falsos positivos de nome", () => {
  it("`-do-zenbook`/`-no-zenbook` é prosa, não sufixo de conflito", () => {
    assert.equal(isBackupSiblingFilename("coletar-do-zenbook.ps1"), false);
    assert.equal(isBackupSiblingFilename("aplicar-no-zenbook.ps1"), false);
    assert.equal(isBackupSiblingFilename("run-log-Zenbook.jsonl"), true, "sufixo real continua casando");
  });

  it("run-Zenbook.log sem run.log ao lado nunca sai, nem velho e acompanhado de outro arquivo", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gc-9732-fp-"));
    const dir = resolve(tmp, "clarice-subscribers/cohorts");
    const log = resolve(dir, "run-Zenbook.log");
    writeAged(log, "log da rodada no Zenbook", 90);
    writeAged(resolve(dir, "run-Neo.log"), "log da rodada no Neo", 5);
    const sync = resolve(tmp, "_memory-sync-260906");
    writeAged(resolve(sync, "coletar-do-zenbook.ps1"), "script", 90);
    writeAged(resolve(sync, "aplicar-no-zenbook.ps1"), "script", 5);

    const { candidates } = collectCandidates(tmp, Date.now(), { siblingTimestamp: MTIME });
    assert.deepEqual(candidates.filter((c) => c.bucket === "backup-sibling"), []);
    runMain(["--data-root", tmp, "--apply", "--include-bucket", "backup-sibling"]);
    assert.equal(existsSync(log), true);
  });
});

describe("#9732 — idade conservadora e retenção de 28 dias", () => {
  it("retenção dobrada: 28 dias", () => {
    assert.equal(BACKUP_SIBLING_RETENTION_DAYS, 28);
    const files = [aged("d/a-Neo.json", 1), aged("d/a-Neo-2.json", 20)];
    assert.deepEqual(classifyBackupSiblings(files, undefined, ALL_EXIST), [], "20d < 28d");
  });

  it("conservativeTimestampMs pega o mais recente entre mtime, ctime e birthtime", () => {
    const st = { mtimeMs: 1000, ctimeMs: 5000, birthtimeMs: 3000 } as Stats;
    assert.equal(conservativeTimestampMs(st), 5000);
    assert.equal(conservativeTimestampMs({ mtimeMs: 9000, ctimeMs: 5000, birthtimeMs: NaN } as Stats), 9000);
  });

  it("mtime recuado (rename de conflito herda o mtime do original) NÃO envelhece a cópia pelo critério default", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gc-9732-age-"));
    const old = resolve(tmp, "logs/run-log-Neo.jsonl");
    writeAged(resolve(tmp, "logs/run-log.jsonl"), "canônico", 1);
    writeAged(old, "cópia recém-criada com mtime herdado", 400);
    writeAged(resolve(tmp, "logs/run-log-Zenbook.jsonl"), "nova", 1);
    assert.ok(statSync(old).ctimeMs > Date.now() - DAY_MS, "fixture: ctime é de agora");

    const { candidates } = collectCandidates(tmp); // idade de produção
    assert.deepEqual(candidates.filter((c) => c.bucket === "backup-sibling"), []);
    runMain(["--data-root", tmp, "--apply", "--include-bucket", "backup-sibling"], conservativeTimestampMs);
    assert.equal(existsSync(old), true);
  });
});
