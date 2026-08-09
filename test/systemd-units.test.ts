/**
 * test/systemd-units.test.ts (#4805 Fase 3)
 *
 * Cobertura de `scripts/lib/systemd-units.ts` (funções puras de tradução
 * schedule -> OnCalendar / task -> unit files) e de
 * `scripts/setup-systemd-timers.ts` (geração dos arquivos em disco).
 *
 * Estrutural: garante que NENHUM dos dois módulos chama `systemctl` (ou
 * qualquer subprocess) — ARMAR é a issue filha #4807, fora de escopo.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemdUnitFiles, scheduleToOnCalendar, unitBaseName } from "../scripts/lib/systemd-units.ts";
import { generateSystemdUnits, main as setupSystemdTimersMain } from "../scripts/setup-systemd-timers.ts";
import { SCHEDULED_TASKS, getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("unitBaseName", () => {
  it("kebab-case, minúsculo, sem caracteres não-alfanuméricos", () => {
    assert.equal(unitBaseName("Diaria-Apoios-Diff-Alarm"), "diaria-apoios-diff-alarm");
  });
});

describe("scheduleToOnCalendar", () => {
  it("daily -> *-*-* HH:MM:00, com zero-padding", () => {
    assert.equal(scheduleToOnCalendar({ kind: "daily", hour: 8, minute: 5 }), "*-*-* 08:05:00");
    assert.equal(scheduleToOnCalendar({ kind: "daily", hour: 23, minute: 59 }), "*-*-* 23:59:00");
  });

  it("weekly -> <Weekday abreviado> *-*-* HH:MM:00", () => {
    assert.equal(
      scheduleToOnCalendar({ kind: "weekly", dayOfWeek: "Monday", hour: 10, minute: 30 }),
      "Mon *-*-* 10:30:00",
    );
    assert.equal(
      scheduleToOnCalendar({ kind: "weekly", dayOfWeek: "Sunday", hour: 0, minute: 0 }),
      "Sun *-*-* 00:00:00",
    );
  });

  it("interval -> *-*-* 0/N:00:00", () => {
    assert.equal(scheduleToOnCalendar({ kind: "interval", hours: 4 }), "*-*-* 0/4:00:00");
    assert.equal(scheduleToOnCalendar({ kind: "interval", hours: 12 }), "*-*-* 0/12:00:00");
  });
});

describe("buildSystemdUnitFiles", () => {
  const task = getScheduledTaskByName("Diaria-Apoios-Diff-Alarm")!;
  const repoRootAbs = "/home/editor/diaria-studio";
  const files = buildSystemdUnitFiles(task, repoRootAbs);

  it("nomes de arquivo derivados do TaskName", () => {
    assert.equal(files.unitName, "diaria-apoios-diff-alarm");
    assert.equal(files.serviceFileName, "diaria-apoios-diff-alarm.service");
    assert.equal(files.timerFileName, "diaria-apoios-diff-alarm.timer");
  });

  it("service: WorkingDirectory + ExecStart apontam pro repoRootAbs e run-task.ts --task <nome>", () => {
    assert.match(files.serviceContent, /^\[Unit\]/);
    assert.match(files.serviceContent, /Type=oneshot/);
    assert.match(files.serviceContent, new RegExp(`WorkingDirectory=${repoRootAbs}`));
    assert.match(
      files.serviceContent,
      new RegExp(`ExecStart=.*--import tsx ${repoRootAbs}/scripts/run-task\\.ts --task ${task.name}`),
    );
  });

  it("timer: OnCalendar + Persistent=true + Unit aponta pro .service + WantedBy=timers.target", () => {
    assert.match(files.timerContent, /OnCalendar=\*-\*-\* 09:45:00/);
    assert.match(files.timerContent, /Persistent=true/);
    assert.match(files.timerContent, /Unit=diaria-apoios-diff-alarm\.service/);
    assert.match(files.timerContent, /WantedBy=timers\.target/);
  });

  it("todo SCHEDULED_TASKS gera um par de units sem lançar", () => {
    for (const t of SCHEDULED_TASKS) {
      assert.doesNotThrow(() => buildSystemdUnitFiles(t, repoRootAbs));
    }
  });
});

describe("generateSystemdUnits — escreve arquivos em disco, nunca chama systemctl", () => {
  let outDir: string;

  after(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("escreve 1 .service + 1 .timer por task, com conteúdo correspondente", () => {
    outDir = mkdtempSync(join(tmpdir(), "systemd-units-test-"));
    const task = getScheduledTaskByName("Diaria-Worker-Drift-Check")!;
    const written = generateSystemdUnits([task], "/repo/abs", outDir);

    assert.equal(written.length, 2);
    const entries = readdirSync(outDir).sort();
    assert.deepEqual(entries, ["diaria-worker-drift-check.service", "diaria-worker-drift-check.timer"]);

    const serviceContent = readFileSync(join(outDir, "diaria-worker-drift-check.service"), "utf8");
    assert.match(serviceContent, /ExecStart=.*run-task\.ts --task Diaria-Worker-Drift-Check/);
  });

  it("gera todas as SCHEDULED_TASKS quando nenhum filtro é passado -> 2× arquivos por task", () => {
    outDir = mkdtempSync(join(tmpdir(), "systemd-units-test-all-"));
    const written = generateSystemdUnits(SCHEDULED_TASKS, ROOT, outDir);
    assert.equal(written.length, SCHEDULED_TASKS.length * 2);
  });
});

describe("setup-systemd-timers.ts main() — CLI", () => {
  let outDir: string;

  after(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("--task desconhecido -> retorna 1, não escreve nada", () => {
    outDir = mkdtempSync(join(tmpdir(), "systemd-units-cli-unknown-"));
    const originalError = console.error;
    console.error = () => {};
    try {
      const code = setupSystemdTimersMain(["--task", "Diaria-Nao-Existe-4805", "--out-dir", outDir], ROOT);
      assert.equal(code, 1);
    } finally {
      console.error = originalError;
    }
  });

  it("--task <nome válido> + --out-dir <dir> -> retorna 0, escreve só aquela task", () => {
    outDir = mkdtempSync(join(tmpdir(), "systemd-units-cli-one-"));
    const originalLog = console.log;
    console.log = () => {};
    try {
      const code = setupSystemdTimersMain(["--task", "Diaria-Hub-Drift-Check", "--out-dir", outDir], ROOT);
      assert.equal(code, 0);
    } finally {
      console.log = originalLog;
    }
    const entries = readdirSync(outDir).sort();
    assert.deepEqual(entries, ["diaria-hub-drift-check.service", "diaria-hub-drift-check.timer"]);
  });

  it("sem --task -> gera todas as SCHEDULED_TASKS no --out-dir informado", () => {
    outDir = mkdtempSync(join(tmpdir(), "systemd-units-cli-all-"));
    const originalLog = console.log;
    console.log = () => {};
    try {
      const code = setupSystemdTimersMain(["--out-dir", outDir], ROOT);
      assert.equal(code, 0);
    } finally {
      console.log = originalLog;
    }
    const entries = readdirSync(outDir);
    assert.equal(entries.length, SCHEDULED_TASKS.length * 2);
  });
});

describe("#4807: nenhum dos dois módulos executa systemctl (ARMAR é issue filha, fora de escopo)", () => {
  it("scripts/lib/systemd-units.ts não importa node:child_process (sem capacidade de subprocess)", () => {
    // "systemctl" pode aparecer em prosa de docstring aqui (explicando o que
    // NÃO é chamado) — o que importa é a ausência estrutural de qualquer
    // import capaz de spawnar processo.
    const source = readFileSync(resolve(ROOT, "scripts", "lib", "systemd-units.ts"), "utf8");
    assert.doesNotMatch(source, /node:child_process/);
  });

  it("scripts/setup-systemd-timers.ts não importa node:child_process (sem capacidade de subprocess)", () => {
    const source = readFileSync(resolve(ROOT, "scripts", "setup-systemd-timers.ts"), "utf8");
    // Nenhum import de child_process => estruturalmente impossível chamar
    // systemctl (ou qualquer outro comando) a partir deste módulo — a única
    // menção a "systemctl" no arquivo é texto impresso em console.log
    // (instruções pro editor rodar manualmente).
    assert.doesNotMatch(source, /node:child_process/);
    assert.ok(source.includes("systemctl"), "esperava as instruções de ARMAR mencionando systemctl (como texto)");
  });
});
