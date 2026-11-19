/**
 * test/gdrive-data-bisync-continuous-writers-13642.test.ts (#13642, #13649)
 *
 * O bisync de `data/` aborta ("md5 hashes differ", "source file is being
 * updated") quando copia um arquivo que cresce durante a cópia, e o aborto
 * arma o `.conflictN` da rodada seguinte (#13545, #13614). Duas frentes:
 *
 *   1. Todo arquivo de `data/` escrito AOS POUCOS por um processo longo sai do
 *      filtro (`CONTINUOUS_WRITERS`, abaixo, com o escritor de cada um).
 *   2. Os logs das tasks do registro (`logPath` de `scheduled-tasks.ts`) NÃO
 *      precisam sair: o task-runner escreve a run num log temporário fora de
 *      `data/` e anexa ao `logPath` de uma vez, no fim. Esta suíte deriva a
 *      lista de `SCHEDULED_TASKS` (task nova entra sozinha) e trava o
 *      contrato do runner que torna isso verdade. Se um dia uma task passar a
 *      escrever o `logPath` durante a run, o teste do contrato quebra e o
 *      `logPath` dela precisa entrar no filtro.
 *
 * A semântica real do filtro roda com o rclone instalado (no `300`); sem o
 * binário (CI), a parte estrutural continua valendo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { SCHEDULED_TASKS, type ScheduledTaskDefinition } from "../scripts/lib/scheduled-tasks.ts";
import { runScheduledTask } from "../scripts/lib/task-runner.ts";
import type { GitSyncResult } from "../scripts/lib/git-sync.ts";
import { LIVE_LOG_REL, LIVE_LOG_PREV_SUFFIX } from "../scripts/overnight/run-nightly-chain.ts";

const ROOT = join(import.meta.dirname, "..");
const DATA_FILTERS = join(ROOT, "scripts", "systemd", "gdrive-data-bisync-filters.txt");

/**
 * Arquivos de `data/` que um processo longo escreve aos poucos, relativos a
 * `data/`, com quem escreve. Ao criar um escritor assim (stdout de processo
 * longo apontado para `data/`, `appendFileSync` em laço durante minutos),
 * acrescentar aqui e no filtro.
 */
const CONTINUOUS_WRITERS: { path: string; writer: string }[] = [
  // run-nightly-chain.ts, spawnWithPersistentOutput: stdout/stderr das fases (horas)
  { path: "overnight/.nightly-chain-last-overnight.json", writer: "run-nightly-chain.ts (stdout stream-json)" },
  { path: "overnight/.nightly-chain-last-overnight.json.prev", writer: "run-nightly-chain.ts (rotação)" },
  { path: "overnight/.nightly-chain-last-overnight.stderr.log", writer: "run-nightly-chain.ts (stderr)" },
  { path: "overnight/.nightly-chain-last-review.log", writer: "run-nightly-chain.ts (stdout do review)" },
  { path: "overnight/.nightly-chain-last-review.log.prev", writer: "run-nightly-chain.ts (rotação)" },
  { path: "overnight/.nightly-chain-last-review.stderr.log", writer: "run-nightly-chain.ts (stderr do review)" },
  // run-nightly-chain.ts, log incremental derivado do logPath da task (#10672)
  { path: LIVE_LOG_REL, writer: "run-nightly-chain.ts (live log)" },
  { path: `${LIVE_LOG_REL}${LIVE_LOG_PREV_SUFFIX}`, writer: "run-nightly-chain.ts (rotação do live log)" },
  // opus-daily-diff-review.sh: tee do stream-json do review
  { path: "continuo/last-daily-review-output.jsonl", writer: "opus-daily-diff-review.sh (tee)" },
  // publish-edition-site-page.ts: waiter destacado, até 35 min (#13649)
  {
    path: "editions/2611/261119/_internal/site-page-merge-waiter.log",
    writer: "publish-edition-site-page.ts (defaultMergeWaiterSpawner)",
  },
];

function ruleLines(): string[] {
  return readFileSync(DATA_FILTERS, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

const NOOP_SYNC = (): GitSyncResult => ({
  outcome: "already_up_to_date",
  message: "syncCode de teste (no-op), ver #7736",
  branch_before: "master",
  warnings: [],
  proceed: true,
  up_to_date: true,
  commits_behind: 0,
  preserved_stash: null,
  stale_autostash_count: -1,
});

describe("filtro do bisync de data/: escritores contínuos (#13642, #13649)", () => {
  it("o waiter do merge da página do site sai, com as rotações", () => {
    const rules = ruleLines();
    for (const r of ["- *-merge-waiter.log", "- *-merge-waiter.log.*"]) {
      assert.ok(rules.includes(r), `falta '${r}' no gdrive-data-bisync-filters.txt`);
    }
  });

  it("o waiter ainda grava onde o filtro espera (editions/.../_internal/site-page-merge-waiter.log)", () => {
    const src = readFileSync(join(ROOT, "scripts", "publish-edition-site-page.ts"), "utf8");
    assert.match(src, /join\(editionDir, "_internal", "site-page-merge-waiter\.log"\), "a"\)/);
  });

  it("o live log da cadeia continua sob overnight/ com extensão .log (casado por /overnight/*.log)", () => {
    assert.match(LIVE_LOG_REL, /^overnight\/[^/]+\.log$/);
  });
});

describe("logs das tasks do registro: escritos de uma vez, no fim da run (#13642)", () => {
  it("todo logPath do registro é relativo a data/, sem prefixo data/ e sem caminho absoluto", () => {
    assert.ok(SCHEDULED_TASKS.length > 10);
    for (const t of SCHEDULED_TASKS) {
      assert.ok(!t.logPath.startsWith("/") && !t.logPath.startsWith("data/"), `${t.name}: logPath ${t.logPath}`);
    }
  });

  it("o runner só toca o logPath depois do último passo, numa única escrita", () => {
    const work = mkdtempSync(join(tmpdir(), "task-runner-13642-"));
    try {
      const events: string[] = [];
      const def: ScheduledTaskDefinition = {
        name: "Diaria-Teste-13642",
        description: "fixture #13642",
        steps: [
          { key: "a", script: "x.ts" },
          { key: "b", script: "y.ts" },
          { key: "c", script: "z.ts" },
        ],
        logPath: "t-13642/.fixture.log",
        schedule: { kind: "daily", hour: 9, minute: 0 },
        issue: "#13642 (teste)",
      };
      const logPath = join(work, "final.log");
      const tempLogPath = join(work, "temp.log");
      const r = runScheduledTask(def, {
        rootDir: work,
        logPathOverride: logPath,
        tempLogPathOverride: tempLogPath,
        syncCode: NOOP_SYNC,
        execStep: (script) => {
          events.push(`step:${script.split(/[\\/]/).pop()}`);
          assert.ok(!existsSync(logPath), "o logPath não pode existir enquanto um passo roda");
          return { code: 0, output: "linha do passo\n" };
        },
        appendLog: (p, content) => {
          events.push("append");
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, content, { flag: "a" });
        },
      });
      assert.equal(r.code, 0);
      assert.deepEqual(events, ["step:x.ts", "step:y.ts", "step:z.ts", "append"]);
      assert.match(readFileSync(logPath, "utf8"), /linha do passo/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("o log temporário default da run fica em os.tmpdir(), fora de data/", () => {
    const src = readFileSync(join(ROOT, "scripts", "lib", "task-runner.ts"), "utf8");
    assert.match(src, /opts\.tempLogPathOverride \?\? join\(tmpdir\(\), `diaria-/);
  });
});

// Semântica real do filtro, com o rclone instalado (no `300`, em ~/.local/bin/rclone).
const RCLONE = process.env.RCLONE_BIN ?? join(homedir(), ".local", "bin", "rclone");
describe("filtro real do rclone: escritores contínuos e logs do registro (#13642)", { skip: existsSync(RCLONE) ? false : "rclone ausente nesta máquina" }, () => {
  it("exclui cada escritor contínuo; os logPath do registro só saem sob overnight/ e continuo/", () => {
    const sb = mkdtempSync(join(tmpdir(), "gdrive-data-filters-13642-"));
    try {
      const taskLogs = [...new Set(SCHEDULED_TASKS.map((t) => t.logPath))];
      const files = [...new Set([...CONTINUOUS_WRITERS.map((w) => w.path), ...taskLogs])];
      for (const f of files) {
        mkdirSync(join(sb, "t", dirname(f)), { recursive: true });
        writeFileSync(join(sb, "t", f), "x");
      }
      const r = spawnSync(RCLONE, ["lsf", "-R", "--files-only", "--ignore-case", "--filter-from", DATA_FILTERS, join(sb, "t")], {
        encoding: "utf8",
        env: { ...process.env, RCLONE_CONFIG: "/dev/null" },
      });
      assert.equal(r.status, 0, r.stderr);
      const listed = new Set(r.stdout.split("\n").filter(Boolean));
      const leaked = CONTINUOUS_WRITERS.filter((w) => listed.has(w.path)).map((w) => `${w.path} (${w.writer})`);
      assert.deepEqual(leaked, [], "escritor contínuo atravessando o bisync de data/");
      // Os logs das tasks sincronizam (escrita única, no fim da run), exceto os
      // de overnight/ e continuo/, que o #13614 tirou junto com os logs da cadeia.
      const expectedSynced = taskLogs.filter((p) => !/^(overnight|continuo)\//.test(p)).sort();
      assert.deepEqual(
        taskLogs.filter((p) => listed.has(p)).sort(),
        expectedSynced,
        "logPath de task do registro com tratamento inesperado no filtro",
      );
    } finally {
      rmSync(sb, { recursive: true, force: true });
    }
  });
});
