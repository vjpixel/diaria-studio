/**
 * gc-data-dir-9725.test.ts (#9725)
 *
 * Regressão das 3 mudanças da #9725 sobre `scripts/gc-data-dir.ts`:
 *   1. agendamento semanal (`Diaria-Gc-Data-Dir-Weekly`) com `--apply` e SEM
 *      `--include-bucket` — o mv-cache fica fora da task agendada;
 *   2. `mv-cache` OPT-IN no `--apply` (pode guardar resultado MillionVerifier
 *      já pago ainda não persistido nos CSVs — caso de 260728);
 *   3. bucket `db-backup` (`diaria-subscribers/*.db.backup-*`, mantém os N
 *      mais recentes) + relatório SÓ-LEITURA de `beehiiv-backup/`.
 *
 * Tudo contra tmpdir fixture — NUNCA o `data/` real (junction do OneDrive).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { collectCandidates, collectBeehiivBackupReport, main } from "../scripts/gc-data-dir.ts";
import {
  ALL_GC_BUCKETS,
  OPT_IN_BUCKETS,
  resolveEnabledBuckets,
  parseDbBackupFilename,
  classifyDbBackups,
  dbBackupStampToMs,
  DB_BACKUP_MIN_AGE_DAYS_DEFAULT,
  planBeehiivSnapshotReport,
  isBeehiivSnapshotDirName,
  type AgedFile,
} from "../scripts/lib/data-dir-gc-policy.ts";
import { SCHEDULED_TASKS, getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

const DAY_MS = 86_400_000;

function writeAged(path: string, content: string, ageDays: number): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content);
  const t = (Date.now() - ageDays * DAY_MS) / 1000;
  utimesSync(path, t, t);
}

/** Roda `main()` capturando stdout/stderr e preservando `process.exitCode`. */
function runMain(argv: string[]): { out: string[]; err: string[]; exitCode: number | string | undefined } {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exitCode;
  process.exitCode = undefined;
  console.log = (msg: unknown) => out.push(String(msg));
  console.error = (msg: unknown) => err.push(String(msg));
  let exitCode: number | string | undefined;
  try {
    main(argv);
  } finally {
    exitCode = process.exitCode;
    process.exitCode = originalExit;
    console.log = originalLog;
    console.error = originalError;
  }
  return { out, err, exitCode };
}

const STAMPS = [
  "2026-09-05T01-24-38-264Z",
  "2026-09-05T02-15-19-215Z",
  "2026-09-18T02-25-23-918Z",
  "2026-09-28T04-26-22-117Z",
  "2026-10-04T03-00-00-000Z",
];

/** "Agora" das asserções puras — longe o bastante dos STAMPS pra todos
 *  passarem do piso de idade, salvo quando o teste quer o contrário. */
const NOW_FAR = Date.parse("2027-01-01T00:00:00Z");

/** Stamp no formato de `backupFileSuffix` para `daysAgo` dias atrás (a
 *  idade do bucket db-backup vem do NOME, então fixture de disco precisa de
 *  stamps relativos ao relógio real, nunca datas fixas). */
function stampDaysAgo(daysAgo: number, offsetMs = 0): string {
  return new Date(Date.now() - daysAgo * DAY_MS + offsetMs).toISOString().replace(/[:.]/g, "-");
}

// ---------------------------------------------------------------------------
// Política pura
// ---------------------------------------------------------------------------

describe("#9725 — resolveEnabledBuckets: mv-cache é opt-in", () => {
  it("default habilita todo bucket MENOS mv-cache", () => {
    const enabled = resolveEnabledBuckets();
    assert.equal(enabled.has("mv-cache"), false, "mv-cache fora do default do --apply");
    for (const b of ALL_GC_BUCKETS.filter((x) => !OPT_IN_BUCKETS.includes(x))) {
      assert.equal(enabled.has(b), true, `${b} deveria estar no default`);
    }
    assert.equal(enabled.has("db-backup"), true);
  });

  it("--include-bucket mv-cache adiciona o bucket opt-in", () => {
    assert.equal(resolveEnabledBuckets(["mv-cache"]).has("mv-cache"), true);
    assert.equal(resolveEnabledBuckets([" mv-cache ", ""]).has("mv-cache"), true);
  });

  it("nome desconhecido LANÇA (typo nunca vira 'nada incluído' em silêncio)", () => {
    assert.throws(() => resolveEnabledBuckets(["mvcache"]), /bucket desconhecido "mvcache"/);
  });
});

describe("#9725 — parseDbBackupFilename", () => {
  it("reconhece backup e sidecars, que compartilham o mesmo stamp", () => {
    const stamp = "2026-09-18T02-25-23-918Z";
    for (const suffix of ["", "-shm", "-wal", "-journal"]) {
      assert.deepEqual(parseDbBackupFilename(`diaria-subscribers.db.backup-${stamp}${suffix}`), {
        base: "diaria-subscribers.db",
        stamp,
      });
    }
  });

  it("o .db canônico e arquivos sem o sufixo .backup- nunca são backup", () => {
    assert.equal(parseDbBackupFilename("diaria-subscribers.db"), null);
    assert.equal(parseDbBackupFilename("diaria-subscribers.db-wal"), null);
    assert.equal(parseDbBackupFilename("kit-ingest-manifest.json"), null);
    assert.equal(parseDbBackupFilename("diaria-subscribers.db.backup-"), null);
    // stamp fora do formato de backupFileSuffix: idade indeterminável → não é backup deste bucket
    assert.equal(parseDbBackupFilename("diaria-subscribers.db.backup-manual"), null);
  });

  it("cópia de conflito do OneDrive entra no conjunto de ORIGEM (mesmo stamp), não num conjunto próprio (#9730)", () => {
    const stamp = "2026-09-05T01-24-38-264Z";
    for (const conflict of ["-Neo", "-neo-2", "-predator-safeBackup-0001", "-safeBackup-0003", "-300", "-fromWindows-260817-0146"]) {
      for (const sidecar of ["", "-wal"]) {
        assert.deepEqual(parseDbBackupFilename(`diaria-subscribers.db.backup-${stamp}${sidecar}${conflict}`), {
          base: "diaria-subscribers.db",
          stamp,
          conflictSuffix: conflict,
        });
      }
    }
  });

  it("dbBackupStampToMs converte o stamp de volta pro instante ISO", () => {
    assert.equal(dbBackupStampToMs("2026-09-05T01-24-38-264Z"), Date.parse("2026-09-05T01:24:38.264Z"));
    assert.equal(dbBackupStampToMs("2026-09-05"), null);
  });
});

describe("#9725 — classifyDbBackups: mantém os N conjuntos mais recentes", () => {
  function aged(name: string, idx: number): AgedFile {
    return { relPath: `diaria-subscribers/${name}`, sizeBytes: 100, ageDays: 40 - idx, mtimeMs: idx * 1000 };
  }

  it("5 conjuntos, keep 3 → os 2 mais antigos saem, com sidecars junto", () => {
    const files: AgedFile[] = [];
    STAMPS.forEach((s, i) => files.push(aged(`diaria-subscribers.db.backup-${s}`, i)));
    // sidecar do 2º mais antigo — sai junto com o conjunto, nunca fica órfão
    files.push(aged(`diaria-subscribers.db.backup-${STAMPS[1]}-shm`, 1));
    files.push(aged(`diaria-subscribers.db.backup-${STAMPS[1]}-wal`, 1));
    // sidecar de conjunto preservado — nunca sai
    files.push(aged(`diaria-subscribers.db.backup-${STAMPS[2]}-shm`, 2));

    const out = classifyDbBackups(files, 3, { nowMs: NOW_FAR });
    assert.deepEqual(
      out.map((c) => c.relPath).sort(),
      [
        `diaria-subscribers/diaria-subscribers.db.backup-${STAMPS[0]}`,
        `diaria-subscribers/diaria-subscribers.db.backup-${STAMPS[1]}`,
        `diaria-subscribers/diaria-subscribers.db.backup-${STAMPS[1]}-shm`,
        `diaria-subscribers/diaria-subscribers.db.backup-${STAMPS[1]}-wal`,
      ].sort(),
    );
    assert.ok(out.every((c) => c.bucket === "db-backup"));
  });

  it("ordem é por stamp, não por mtime (OneDrive reescreve mtime entre máquinas)", () => {
    // mtime invertido: o stamp mais NOVO tem o mtime mais VELHO
    const files = STAMPS.map((s, i) => ({
      relPath: `diaria-subscribers/x.db.backup-${s}`,
      sizeBytes: 1,
      ageDays: 1,
      mtimeMs: (STAMPS.length - i) * 1000,
    }));
    const out = classifyDbBackups(files, 1, { nowMs: NOW_FAR });
    assert.equal(out.some((c) => c.relPath.endsWith(STAMPS[4])), false, "stamp mais novo sempre preservado");
    assert.equal(out.length, 4);
  });

  it("menos conjuntos que N → nada sai; .db diferentes têm retenção independente", () => {
    const files = [
      aged(`a.db.backup-${STAMPS[0]}`, 0),
      aged(`a.db.backup-${STAMPS[1]}`, 1),
      aged(`b.db.backup-${STAMPS[0]}`, 0),
    ];
    assert.deepEqual(classifyDbBackups(files, 3, { nowMs: NOW_FAR }), []);
    assert.deepEqual(
      classifyDbBackups(files, 1, { nowMs: NOW_FAR }).map((c) => c.relPath),
      [`diaria-subscribers/a.db.backup-${STAMPS[0]}`],
    );
  });

  it("keep < 1 ou não-inteiro LANÇA (nunca apaga todos os backups)", () => {
    assert.throws(() => classifyDbBackups([], 0, { nowMs: NOW_FAR }));
    assert.throws(() => classifyDbBackups([], 1.5, { nowMs: NOW_FAR }));
    assert.throws(() => classifyDbBackups([], 1, { nowMs: NOW_FAR, minAgeDays: 0 }));
    assert.throws(() => classifyDbBackups([], 1, { nowMs: Number.NaN }));
  });

  it("regressão #9730: N+1 backups TODOS recentes (< piso de idade) → nada é apagado", () => {
    assert.equal(DB_BACKUP_MIN_AGE_DAYS_DEFAULT, 14);
    const now = Date.parse("2026-10-06T12:00:00Z");
    // 4 backups numa mesma sessão de manutenção, 1 dia atrás; keep 3
    const files = ["T01-00-00-000Z", "T02-00-00-000Z", "T03-00-00-000Z", "T04-00-00-000Z"].map((t, i) => ({
      relPath: `diaria-subscribers/diaria-subscribers.db.backup-2026-10-05${t}`,
      sizeBytes: 1,
      ageDays: 400, // mtime velho (OneDrive) — irrelevante: a idade vem do NOME
      mtimeMs: i,
    }));
    assert.deepEqual(classifyDbBackups(files, 3, { nowMs: now }), []);
  });

  it("piso de idade usa o stamp: fora do top N só sai quem tem ≥ minAgeDays", () => {
    const now = Date.parse("2026-10-06T12:00:00Z");
    const mk = (stamp: string) => ({ relPath: `diaria-subscribers/x.db.backup-${stamp}`, sizeBytes: 1, ageDays: 0, mtimeMs: 0 });
    const files = [
      mk("2026-09-01T00-00-00-000Z"), // 35d — sai
      mk("2026-09-30T00-00-00-000Z"), // 6d — fica (piso 14)
      mk("2026-10-04T00-00-00-000Z"), // top 1
    ];
    assert.deepEqual(
      classifyDbBackups(files, 1, { nowMs: now }).map((c) => c.relPath),
      ["diaria-subscribers/x.db.backup-2026-09-01T00-00-00-000Z"],
    );
    // piso configurável: com 5d, o de 6d também sai
    assert.equal(classifyDbBackups(files, 1, { nowMs: now, minAgeDays: 5 }).length, 2);
  });

  it("cópia de conflito do OneDrive não empurra backup real pra fora do top N (#9730)", () => {
    const mk = (name: string) => ({ relPath: `diaria-subscribers/${name}`, sizeBytes: 1, ageDays: 0, mtimeMs: 0 });
    const files = [
      mk(`d.db.backup-${STAMPS[0]}`),
      mk(`d.db.backup-${STAMPS[1]}`),
      mk(`d.db.backup-${STAMPS[1]}-Neo`), // cópia de conflito do 2º — mesmo conjunto
      mk(`d.db.backup-${STAMPS[2]}`),
    ];
    const out = classifyDbBackups(files, 2, { nowMs: NOW_FAR }).map((c) => c.relPath);
    // keep 2 → preserva STAMPS[2] e STAMPS[1] (com a cópia); só STAMPS[0] sai
    assert.deepEqual(out, [`diaria-subscribers/d.db.backup-${STAMPS[0]}`]);
    // e quando o conjunto de origem sai, a cópia sai junto (nunca fica órfã)
    const out1 = classifyDbBackups(files, 1, { nowMs: NOW_FAR }).map((c) => c.relPath).sort();
    assert.deepEqual(
      out1,
      [`d.db.backup-${STAMPS[0]}`, `d.db.backup-${STAMPS[1]}`, `d.db.backup-${STAMPS[1]}-Neo`].map((n) => `diaria-subscribers/${n}`).sort(),
    );
  });
});

describe("#9725 — planBeehiivSnapshotReport (só relatório)", () => {
  it("mantém os N mais recentes por data ISO e soma o que liberaria", () => {
    const snaps = ["2026-08-30", "2026-10-04", "2026-09-06", "2026-09-27", "2026-09-13", "2026-09-20"].map((d) => ({
      relPath: `beehiiv-backup/${d}`,
      sizeBytes: 10,
    }));
    const r = planBeehiivSnapshotReport(snaps, 4);
    assert.deepEqual(
      r.kept.map((s) => s.relPath),
      ["beehiiv-backup/2026-10-04", "beehiiv-backup/2026-09-27", "beehiiv-backup/2026-09-20", "beehiiv-backup/2026-09-13"],
    );
    assert.deepEqual(r.wouldRemove.map((s) => s.relPath), ["beehiiv-backup/2026-09-06", "beehiiv-backup/2026-08-30"]);
    assert.equal(r.wouldRemoveBytes, 20);
    assert.equal(r.totalBytes, 60);
    assert.throws(() => planBeehiivSnapshotReport(snaps, 0));
  });

  it("isBeehiivSnapshotDirName só casa YYYY-MM-DD", () => {
    assert.equal(isBeehiivSnapshotDirName("2026-09-06"), true);
    assert.equal(isBeehiivSnapshotDirName("subscriber-engagement"), false);
    assert.equal(isBeehiivSnapshotDirName("click-subscribers"), false);
  });
});

// ---------------------------------------------------------------------------
// Integração contra fixture de disco
// ---------------------------------------------------------------------------

describe("#9725 — mv-cache opt-in no --apply (ponta a ponta)", () => {
  function fixture(): { tmp: string; mvCache: string } {
    const tmp = mkdtempSync(join(tmpdir(), "gc-9725-mv-"));
    const mvCache = resolve(tmp, "clarice-subscribers/2608-09/.mv-cache-t01.json");
    writeAged(mvCache, "{\"pago\":true}", 90);
    return { tmp, mvCache };
  }

  it("collectCandidates ainda inventaria o mv-cache (dry-run enxerga)", () => {
    const { tmp } = fixture();
    const { candidates } = collectCandidates(tmp);
    assert.equal(candidates.some((c) => c.bucket === "mv-cache"), true);
  });

  it("--apply SEM --include-bucket NÃO remove o mv-cache (regressão #9725)", () => {
    const { tmp, mvCache } = fixture();
    const { out, exitCode } = runMain(["--data-root", tmp, "--apply"]);
    assert.equal(existsSync(mvCache), true, "cache MV com resultado pago potencial preservado no default");
    assert.equal(exitCode, undefined);
    assert.ok(out.some((l) => l.includes("--include-bucket mv-cache")), "output explica como incluir");
  });

  it("cópia-irmã de conflito DO mv-cache (-safeBackup-) não vaza pelo bucket backup-sibling (achado no dry-run real)", () => {
    const { tmp } = fixture();
    const dir = resolve(tmp, "clarice-subscribers/2607-08");
    const old = resolve(dir, ".mv-cache-mv-export-leads-2024h1-predator-safeBackup-0001.json");
    const newer = resolve(dir, ".mv-cache-mv-export-leads-2024h1-predator-safeBackup-0002.json");
    writeAged(old, "{\"pago\":true}", 90);
    writeAged(newer, "{\"pago\":true}", 60);

    const { candidates } = collectCandidates(tmp);
    assert.equal(
      candidates.some((c) => c.bucket === "backup-sibling" && c.relPath.includes(".mv-cache-")),
      false,
      "arquivo .mv-cache-* só pode cair no bucket mv-cache",
    );
    runMain(["--data-root", tmp, "--apply"]);
    assert.equal(existsSync(old), true, "default do --apply preserva também as cópias-irmãs do cache MV");
    assert.equal(existsSync(newer), true);
  });

  it("--apply --include-bucket mv-cache remove", () => {
    const { tmp, mvCache } = fixture();
    runMain(["--data-root", tmp, "--apply", "--include-bucket", "mv-cache"]);
    assert.equal(existsSync(mvCache), false);
  });

  it("--json separa candidates (o que o --apply remove) de opt_in_skipped", () => {
    const { tmp } = fixture();
    const { out } = runMain(["--data-root", tmp, "--json"]);
    const parsed = JSON.parse(out[out.length - 1]);
    assert.equal(parsed.candidates.some((c: { bucket: string }) => c.bucket === "mv-cache"), false);
    assert.equal(parsed.opt_in_skipped.length, 1);
    assert.equal(parsed.opt_in_skipped[0].bucket, "mv-cache");
    assert.equal(parsed.enabled_buckets.includes("mv-cache"), false);
  });

  it("--include-bucket com typo aborta com exit 2 e não remove nada", () => {
    const { tmp, mvCache } = fixture();
    writeAged(resolve(tmp, "clarice-subscribers/clarice-users-predator-safeBackup-0001.db"), "velho", 400);
    writeAged(resolve(tmp, "clarice-subscribers/clarice-users-Neo.db"), "recente", 1);
    const { err, exitCode } = runMain(["--data-root", tmp, "--apply", "--include-bucket", "mvcache"]);
    assert.equal(exitCode, 2);
    assert.ok(err.some((l) => l.includes("bucket desconhecido")));
    assert.equal(existsSync(mvCache), true);
    assert.equal(existsSync(resolve(tmp, "clarice-subscribers/clarice-users-predator-safeBackup-0001.db")), true);
  });
});

describe("#9725 — bucket db-backup (ponta a ponta)", () => {
  // Stamps relativos ao relógio real (40..36 dias atrás) — todos acima do
  // piso de idade (#9730), em ordem crescente como os STAMPS fixos.
  const E2E_STAMPS = [40, 39, 38, 37, 36].map((d) => stampDaysAgo(d));
  function fixture(): string {
    const tmp = mkdtempSync(join(tmpdir(), "gc-9725-db-"));
    const dir = resolve(tmp, "diaria-subscribers");
    writeAged(resolve(dir, "diaria-subscribers.db"), "canônico", 1);
    writeAged(resolve(dir, "kit-ingest-manifest.json"), "{}", 400);
    E2E_STAMPS.forEach((s, i) => writeAged(resolve(dir, `diaria-subscribers.db.backup-${s}`), "bkp", 40 - i));
    writeAged(resolve(dir, `diaria-subscribers.db.backup-${E2E_STAMPS[0]}-shm`), "", 40);
    writeAged(resolve(dir, `diaria-subscribers.db.backup-${E2E_STAMPS[0]}-wal`), "", 40);
    return tmp;
  }

  it("--apply mantém os 3 conjuntos mais recentes + o .db canônico, remove o resto com sidecars", () => {
    const tmp = fixture();
    runMain(["--data-root", tmp, "--apply"]);
    const left = readdirSync(resolve(tmp, "diaria-subscribers")).sort();
    assert.deepEqual(
      left,
      [
        "diaria-subscribers.db",
        ...E2E_STAMPS.slice(2).map((s) => `diaria-subscribers.db.backup-${s}`),
        "kit-ingest-manifest.json",
      ].sort(),
    );
  });

  it("--db-backup-keep 1 mantém só o mais recente", () => {
    const tmp = fixture();
    runMain(["--data-root", tmp, "--apply", "--db-backup-keep", "1"]);
    const backups = readdirSync(resolve(tmp, "diaria-subscribers")).filter((n) => n.includes(".backup-"));
    assert.deepEqual(backups, [`diaria-subscribers.db.backup-${E2E_STAMPS[4]}`]);
  });

  it("regressão #9730: --apply com N+1 backups recentes (sessão de manutenção) não apaga nenhum", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gc-9725-db-recent-"));
    const dir = resolve(tmp, "diaria-subscribers");
    const recent = [0, 1, 2, 3].map((i) => stampDaysAgo(1, i * 60_000));
    // mtime velho de propósito: a idade vem do nome, nunca do mtime
    recent.forEach((s) => writeAged(resolve(dir, `diaria-subscribers.db.backup-${s}`), "bkp", 400));
    runMain(["--data-root", tmp, "--apply"]);
    assert.equal(readdirSync(dir).length, 4, "os 4 backups de ontem sobrevivem, mesmo com keep 3");
    // piso configurável pela CLI
    const { exitCode } = runMain(["--data-root", tmp, "--apply", "--db-backup-min-age-days", "0"]);
    assert.equal(exitCode, 2, "piso < 1 aborta");
    assert.equal(readdirSync(dir).length, 4);
  });

  it("--db-backup-keep 0 aborta com exit 2 sem apagar nada", () => {
    const tmp = fixture();
    const { exitCode } = runMain(["--data-root", tmp, "--apply", "--db-backup-keep", "0"]);
    assert.equal(exitCode, 2);
    assert.equal(readdirSync(resolve(tmp, "diaria-subscribers")).filter((n) => n.includes(".backup-")).length, 7);
  });

  it("escopo é só diaria-subscribers/ — .db.backup-* em outro diretório nunca é candidato db-backup", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gc-9725-db-scope-"));
    STAMPS.forEach((s, i) => writeAged(resolve(tmp, `clarice-subscribers/clarice-users.db.backup-${s}`), "x", 40 - i));
    const { candidates } = collectCandidates(tmp);
    assert.equal(candidates.some((c) => c.bucket === "db-backup"), false);
  });
});

describe("#9725 — beehiiv-backup/: relatório no dry-run, NUNCA removido", () => {
  function fixture(): string {
    const tmp = mkdtempSync(join(tmpdir(), "gc-9725-bh-"));
    for (const d of ["2026-08-30", "2026-09-06", "2026-09-13", "2026-09-20", "2026-09-27", "2026-10-04"]) {
      writeAged(resolve(tmp, `beehiiv-backup/${d}/subscribers.jsonl`), "x".repeat(100), 400);
    }
    writeAged(resolve(tmp, "beehiiv-backup/subscriber-engagement/p1.jsonl"), "y", 400);
    return tmp;
  }

  it("collectBeehiivBackupReport lista os snapshots que uma retenção liberaria, sem dirs não-snapshot", () => {
    const tmp = fixture();
    const r = collectBeehiivBackupReport(tmp, 4);
    assert.ok(r);
    assert.deepEqual(r!.wouldRemove.map((s) => s.relPath), ["beehiiv-backup/2026-09-06", "beehiiv-backup/2026-08-30"]);
    assert.equal(r!.wouldRemoveBytes, 200);
    assert.equal(r!.kept.some((s) => s.relPath.includes("subscriber-engagement")), false);
  });

  it("dry-run --json carrega beehiiv_backup_report; candidates nunca têm beehiiv-backup/", () => {
    const tmp = fixture();
    const { out } = runMain(["--data-root", tmp, "--json", "--beehiiv-keep", "2"]);
    const parsed = JSON.parse(out[out.length - 1]);
    assert.equal(parsed.beehiiv_backup_report.keep, 2);
    assert.equal(parsed.beehiiv_backup_report.wouldRemove.length, 4);
    assert.equal(parsed.candidates.some((c: { relPath: string }) => c.relPath.startsWith("beehiiv-backup")), false);
  });

  it("--apply (com qualquer --include-bucket) não remove NENHUM arquivo de beehiiv-backup/", () => {
    const tmp = fixture();
    runMain(["--data-root", tmp, "--apply", "--include-bucket", "mv-cache", "--beehiiv-keep", "1"]);
    assert.equal(readdirSync(resolve(tmp, "beehiiv-backup")).length, 7, "6 snapshots + subscriber-engagement intactos");
  });

  it("texto do dry-run deixa claro que é só relatório", () => {
    const tmp = fixture();
    const { out } = runMain(["--data-root", tmp]);
    assert.ok(out.some((l) => l.includes("SÓ RELATÓRIO")));
  });
});

describe("#9725 — agendamento Diaria-Gc-Data-Dir-Weekly", () => {
  const task = getScheduledTaskByName("Diaria-Gc-Data-Dir-Weekly");

  it("registrado, semanal, rodando gc-data-dir.ts --apply", () => {
    assert.ok(task, "task presente em SCHEDULED_TASKS");
    assert.equal(task!.schedule.kind, "weekly");
    assert.equal(task!.steps[0].script, "scripts/gc-data-dir.ts");
    assert.ok(task!.steps[0].args?.includes("--apply"));
  });

  it("#9730: 2º passo best-effort é dry-run (relatório de beehiiv-backup/ no log), nunca --apply", () => {
    assert.equal(task!.steps.length, 2);
    const report = task!.steps[1];
    assert.equal(report.script, "scripts/gc-data-dir.ts");
    assert.equal(report.bestEffort, true);
    assert.equal((report.args ?? []).includes("--apply"), false);
  });

  it("a task agendada NUNCA inclui mv-cache nem troca --data-root", () => {
    for (const step of task!.steps) {
      const args = step.args ?? [];
      assert.equal(args.some((a) => a.startsWith("--include-bucket")), false);
      assert.equal(args.some((a) => a.startsWith("--data-root")), false);
    }
  });

  it("horário não colide com outra weekly do mesmo dia nem com daily no mesmo minuto", () => {
    const s = task!.schedule;
    assert.equal(s.kind, "weekly");
    if (s.kind !== "weekly") return;
    const clash = SCHEDULED_TASKS.filter((t) => t.name !== task!.name).filter((t) => {
      const o = t.schedule;
      if (o.kind === "weekly") return o.dayOfWeek === s.dayOfWeek && o.hour === s.hour && o.minute === s.minute;
      if (o.kind === "daily") return o.hour === s.hour && o.minute === s.minute;
      if (o.kind === "interval") return s.minute === 0 && s.hour % o.hours === 0;
      return false;
    });
    assert.deepEqual(clash.map((t) => t.name), []);
  });
});
