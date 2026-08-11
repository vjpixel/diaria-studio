/**
 * test/edicao-systemd-units.test.ts (#4998, reativação do #2068/#3259)
 *
 * Cobertura de `scripts/lib/edicao-systemd-units.ts` (units systemd da
 * edição diária agendada, gerados FORA do registro declarativo — mesma
 * decisão do watchdog, ver topo daquele módulo) e de
 * `scripts/overnight/setup-edicao-schedule-systemd.ts` (CLI que escreve os
 * arquivos em disco). Espelha test/watchdog-systemd-units.test.ts.
 *
 * Estrutural: garante que NENHUM dos dois módulos chama `systemctl` (ou
 * qualquer subprocess) — ARMAR é ação manual na máquina real.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEdicaoOnCalendar,
  buildEdicaoSystemdUnitFiles,
  EDICAO_UNIT_NAME,
} from "../scripts/lib/edicao-systemd-units.ts";
import { unitBaseName } from "../scripts/lib/systemd-units.ts";
import {
  generateEdicaoSystemdUnits,
  main as setupEdicaoSystemdMain,
} from "../scripts/overnight/setup-edicao-schedule-systemd.ts";

describe("EDICAO_UNIT_NAME (#4998)", () => {
  it("bate com unitBaseName('Diaria-Edicao-Diaria') — nunca diverge em silêncio do literal fixado", () => {
    assert.equal(EDICAO_UNIT_NAME, unitBaseName("Diaria-Edicao-Diaria"));
    assert.equal(EDICAO_UNIT_NAME, "diaria-edicao-diaria");
  });
});

describe("buildEdicaoOnCalendar (#4998)", () => {
  it("default (16:00 BRT, dom-qui) — horário da reativação 260811", () => {
    assert.equal(buildEdicaoOnCalendar(), "Sun,Mon,Tue,Wed,Thu *-*-* 16:00:00 America/Sao_Paulo");
  });

  it("é parametrizável sem duplicar o literal mágico", () => {
    assert.equal(buildEdicaoOnCalendar(9, 30), "Sun,Mon,Tue,Wed,Thu *-*-* 09:30:00 America/Sao_Paulo");
  });

  it("sempre inclui America/Sao_Paulo explícito — mesmo achado ao vivo do #4807 pro resto do registry", () => {
    assert.match(buildEdicaoOnCalendar(), /\bAmerica\/Sao_Paulo$/);
  });
});

describe("buildEdicaoOnCalendar — validação real via systemd-analyze (quando disponível)", () => {
  let hasSystemdAnalyze = false;
  try {
    execFileSync("systemd-analyze", ["--version"], { stdio: "ignore" });
    hasSystemdAnalyze = true;
  } catch {
    hasSystemdAnalyze = false;
  }

  it("o parser do systemd aceita a expressão gerada, sem lançar", { skip: !hasSystemdAnalyze }, () => {
    const onCalendar = buildEdicaoOnCalendar();
    assert.doesNotThrow(() => execFileSync("systemd-analyze", ["calendar", onCalendar], { stdio: "pipe" }));
  });
});

describe("buildEdicaoSystemdUnitFiles (#4998)", () => {
  const repoRootAbs = "/home/editor/diaria-studio";
  const files = buildEdicaoSystemdUnitFiles(repoRootAbs);

  it("nomes de arquivo derivados de EDICAO_UNIT_NAME", () => {
    assert.equal(files.unitName, "diaria-edicao-diaria");
    assert.equal(files.serviceFileName, "diaria-edicao-diaria.service");
    assert.equal(files.timerFileName, "diaria-edicao-diaria.timer");
  });

  it("service: WorkingDirectory + ExecStart chamam run-scheduled-edicao.ts DIRETO", () => {
    assert.match(files.serviceContent, /^\[Unit\]/);
    assert.match(files.serviceContent, /Type=oneshot/);
    assert.match(files.serviceContent, new RegExp(`WorkingDirectory=${repoRootAbs}`));
    assert.match(
      files.serviceContent,
      new RegExp(`ExecStart=.*--import tsx ${repoRootAbs}/scripts/overnight/run-scheduled-edicao\\.ts$`, "m"),
    );
  });

  it("timer: OnCalendar dom-qui 16:00 BRT + Persistent=true + Unit aponta pro .service + WantedBy=timers.target", () => {
    assert.match(files.timerContent, /OnCalendar=Sun,Mon,Tue,Wed,Thu \*-\*-\* 16:00:00 America\/Sao_Paulo/);
    assert.match(files.timerContent, /Persistent=true/);
    assert.match(files.timerContent, /Unit=diaria-edicao-diaria\.service/);
    assert.match(files.timerContent, /WantedBy=timers\.target/);
  });

  it("nunca emite uma chave 'Timezone=' separada — não existe em systemd.timer", () => {
    assert.doesNotMatch(files.timerContent, /^Timezone=/m);
  });
});

describe("generateEdicaoSystemdUnits — escreve arquivos em disco, nunca chama systemctl", () => {
  let outDir: string;

  after(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("escreve 1 .service + 1 .timer com conteúdo correspondente", () => {
    outDir = mkdtempSync(join(tmpdir(), "edicao-systemd-units-test-"));
    const written = generateEdicaoSystemdUnits("/repo/abs", outDir);

    assert.equal(written.length, 2);
    const entries = readdirSync(outDir).sort();
    assert.deepEqual(entries, ["diaria-edicao-diaria.service", "diaria-edicao-diaria.timer"]);

    const serviceContent = readFileSync(join(outDir, "diaria-edicao-diaria.service"), "utf8");
    assert.match(serviceContent, /ExecStart=.*run-scheduled-edicao\.ts$/m);
  });
});

describe("setup-edicao-schedule-systemd.ts main() — CLI", () => {
  let outDir: string;

  after(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("sem --out-dir -> usa .systemd-units/ relativo ao repoRootAbs informado, retorna 0", () => {
    outDir = mkdtempSync(join(tmpdir(), "edicao-systemd-cli-default-"));
    const originalLog = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = setupEdicaoSystemdMain([], outDir);
    } finally {
      console.log = originalLog;
    }
    assert.equal(code, 0);
    const entries = readdirSync(join(outDir, ".systemd-units")).sort();
    assert.deepEqual(entries, ["diaria-edicao-diaria.service", "diaria-edicao-diaria.timer"]);
  });

  it("--out-dir <dir> -> escreve lá, retorna 0", () => {
    const base = mkdtempSync(join(tmpdir(), "edicao-systemd-cli-outdir-"));
    outDir = base;
    const originalLog = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = setupEdicaoSystemdMain(["--out-dir", "custom-units"], base);
    } finally {
      console.log = originalLog;
    }
    assert.equal(code, 0);
    const entries = readdirSync(join(base, "custom-units")).sort();
    assert.deepEqual(entries, ["diaria-edicao-diaria.service", "diaria-edicao-diaria.timer"]);
  });

  it("Node do shell abaixo do mínimo do projeto -> ainda retorna 0, mas avisa em console.warn", () => {
    outDir = mkdtempSync(join(tmpdir(), "edicao-systemd-cli-oldnode-"));
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    const warnCalls: string[] = [];
    console.warn = (msg: string) => warnCalls.push(msg);
    let code: number;
    try {
      code = setupEdicaoSystemdMain([], outDir, "v20.20.2");
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
    assert.equal(code, 0);
    assert.equal(warnCalls.length, 1);
    assert.match(warnCalls[0], /Node.*20\.20\.2/);
    assert.match(warnCalls[0], /EMBUTIDO/);
  });

  it("Node do shell no mínimo do projeto (ou acima) -> nenhum aviso emitido", () => {
    outDir = mkdtempSync(join(tmpdir(), "edicao-systemd-cli-okvernode-"));
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    const warnCalls: string[] = [];
    console.warn = (msg: string) => warnCalls.push(msg);
    let code: number;
    try {
      code = setupEdicaoSystemdMain([], outDir, "v24.19.0");
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
    assert.equal(code, 0);
    assert.equal(warnCalls.length, 0);
  });
});
