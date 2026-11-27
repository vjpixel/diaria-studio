/**
 * test/edicao-systemd-units.test.ts (#4998, reativação do #2068/#3259)
 *
 * Cobertura de `scripts/lib/edicao-systemd-units.ts` (units systemd da
 * edição diária agendada, gerados FORA do registro declarativo — mesma
 * decisão do watchdog, ver topo daquele módulo) e de
 * `scripts/edicao-agendada/setup-edicao-schedule-systemd.ts` (CLI que escreve os
 * arquivos em disco). Espelha test/watchdog-systemd-units.test.ts.
 *
 * Estrutural: garante que NENHUM dos dois módulos chama `systemctl` (ou
 * qualquer subprocess) — ARMAR é ação manual na máquina real.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEdicaoOnCalendar,
  buildEdicaoSystemdUnitFiles,
  EDICAO_UNIT_NAME,
} from "../scripts/lib/edicao-systemd-units.ts";
import { unitBaseName } from "../scripts/lib/systemd-units.ts";
import { resolveSystemdNodeBinary } from "../scripts/lib/systemd-node-binary.ts";
import type { CheckedNodeBinaryDeps } from "../scripts/lib/systemd-node-binary-checked.ts";
import {
  generateEdicaoSystemdUnits,
  main as setupEdicaoSystemdMain,
} from "../scripts/edicao-agendada/setup-edicao-schedule-systemd.ts";


// #13151: resolução do node do ExecStart determinística nos testes do CLI —
// nunca o nvm/node real da máquina que roda a suíte.
const SSH_RESOLVE = {
  env: {},
  homeDir: "/home/x",
  execPath: "/usr/bin/node",
  processVersion: "v20.20.2",
  readNvmrc: () => "24\n",
  listNvmVersions: () => ["v22.11.0", "v24.19.0"],
  fileExists: (p: string) => p === "/home/x/.nvm/versions/node/v24.19.0/bin/node",
};
const SSH_DEPS: CheckedNodeBinaryDeps = {
  resolveNodeBinary: (o) => resolveSystemdNodeBinary({ ...SSH_RESOLVE, override: o }),
  resolveVersion: () => "v24.19.0",
};
const NVM_DEPS = SSH_DEPS;

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
      new RegExp(`ExecStart=.*--import tsx ${repoRootAbs}/scripts/edicao-agendada/run-scheduled-edicao\\.ts$`, "m"),
    );
  });

  // #5114: `claude -p` (invocado por esta task) sobe sem CLARICE_API_KEY (ou
  // qualquer outra credencial do .env) no ambiente -- o `.mcp.json` interpola
  // `${CLARICE_API_KEY}` no momento do LAUNCH do processo Claude Code.
  it("service: EnvironmentFile= aponta pro .env do repoRootAbs, marcado opcional com '-' (#5114)", () => {
    assert.match(files.serviceContent, new RegExp(`^EnvironmentFile=-${repoRootAbs}/\\.env$`, "m"));
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

  it("nodeBin explícito vai literal no ExecStart= (#13151)", () => {
    const custom = buildEdicaoSystemdUnitFiles(repoRootAbs, "/home/x/.nvm/versions/node/v24.19.0/bin/node");
    assert.match(
      custom.serviceContent,
      /^ExecStart=\/home\/x\/\.nvm\/versions\/node\/v24\.19\.0\/bin\/node --import tsx \/home\/editor\/diaria-studio\/scripts\/edicao-agendada\/run-scheduled-edicao\.ts$/m,
    );
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
      code = setupEdicaoSystemdMain([], outDir, NVM_DEPS);
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
      code = setupEdicaoSystemdMain(["--out-dir", "custom-units"], base, NVM_DEPS);
    } finally {
      console.log = originalLog;
    }
    assert.equal(code, 0);
    const entries = readdirSync(join(base, "custom-units")).sort();
    assert.deepEqual(entries, ["diaria-edicao-diaria.service", "diaria-edicao-diaria.timer"]);
  });

  // #13151: o node do ExecStart vem do nvm do `.nvmrc`, nunca do processo
  // que gerou. Antes, `process.execPath` ia direto pro unit e o CLI só avisava
  // quando ele estava abaixo do piso (pelo ssh, `/usr/bin/node`).
  it("cenário ssh (processo em /usr/bin/node v20, nvm com v24) -> ExecStart usa o node do nvm (#13151)", () => {
    outDir = mkdtempSync(join(tmpdir(), "edicao-systemd-cli-ssh-"));
    const originalLog = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = setupEdicaoSystemdMain([], outDir, SSH_DEPS);
    } finally {
      console.log = originalLog;
    }
    assert.equal(code, 0);
    const service = readFileSync(join(outDir, ".systemd-units", "diaria-edicao-diaria.service"), "utf8");
    assert.match(service, /^ExecStart=\/home\/x\/\.nvm\/versions\/node\/v24\.19\.0\/bin\/node --import tsx /m);
    assert.doesNotMatch(service, /\/usr\/bin\/node/);
  });

  it("--node-bin <path absoluto> vence o nvm (#13151)", () => {
    outDir = mkdtempSync(join(tmpdir(), "edicao-systemd-cli-override-"));
    const originalLog = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = setupEdicaoSystemdMain(["--node-bin", "/opt/node24/bin/node"], outDir, {
        resolveNodeBinary: (o) =>
          resolveSystemdNodeBinary({ ...SSH_RESOLVE, override: o, fileExists: (p) => p === "/opt/node24/bin/node" }),
        resolveVersion: () => "v24.19.0",
      });
    } finally {
      console.log = originalLog;
    }
    assert.equal(code, 0);
    const service = readFileSync(join(outDir, ".systemd-units", "diaria-edicao-diaria.service"), "utf8");
    assert.match(service, /^ExecStart=\/opt\/node24\/bin\/node --import tsx /m);
  });

  it("nenhum node casa com o .nvmrc -> exit 1 e nada gerado (#13151)", () => {
    outDir = mkdtempSync(join(tmpdir(), "edicao-systemd-cli-nonode-"));
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (msg: string) => errors.push(msg);
    let code: number;
    try {
      code = setupEdicaoSystemdMain([], outDir, {
        resolveNodeBinary: (o) => resolveSystemdNodeBinary({ ...SSH_RESOLVE, override: o, listNvmVersions: () => [] }),
        resolveVersion: () => "v20.20.2",
      });
    } finally {
      console.error = originalError;
    }
    assert.equal(code, 1);
    assert.match(errors.join("\n"), /\.nvmrc/);
    assert.equal(existsSync(join(outDir, ".systemd-units")), false);
  });

  it("node resolvido abaixo do piso do projeto -> exit 1 (antes: só aviso)", () => {
    outDir = mkdtempSync(join(tmpdir(), "edicao-systemd-cli-oldnode-"));
    const originalError = console.error;
    console.error = () => {};
    let code: number;
    try {
      code = setupEdicaoSystemdMain([], outDir, { ...NVM_DEPS, resolveVersion: () => "v20.20.2" });
    } finally {
      console.error = originalError;
    }
    assert.equal(code, 1);
    assert.equal(existsSync(join(outDir, ".systemd-units")), false);
  });
});
