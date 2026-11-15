/**
 * test/watchdog-systemd-units.test.ts (#4857)
 *
 * Cobertura de `scripts/lib/watchdog-systemd-units.ts` (units systemd do
 * watchdog overnight, gerados FORA do registro declarativo — ver decisão no
 * topo daquele módulo) e de
 * `scripts/overnight/setup-watchdog-schedule-systemd.ts` (CLI que escreve os
 * arquivos em disco).
 *
 * Estrutural: garante que NENHUM dos dois módulos chama `systemctl` (ou
 * qualquer subprocess) — ARMAR é ação manual na máquina real, fora de
 * escopo desta unidade (mesma disciplina de `test/systemd-units.test.ts`
 * pro par de módulos do registry, #4805/#4807).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildWatchdogOnCalendar,
  buildWatchdogSystemdUnitFiles,
  WATCHDOG_UNIT_NAME,
} from "../scripts/lib/watchdog-systemd-units.ts";
import { unitBaseName } from "../scripts/lib/systemd-units.ts";
import { resolveSystemdNodeBinary } from "../scripts/lib/systemd-node-binary.ts";
import type { CheckedNodeBinaryDeps } from "../scripts/lib/systemd-node-binary-checked.ts";
import { WATCHDOG_TASK_NAME } from "../scripts/lib/check-watchdog-armed.ts";
import {
  generateWatchdogSystemdUnits,
  main as setupWatchdogSystemdMain,
} from "../scripts/overnight/setup-watchdog-schedule-systemd.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");


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

describe("WATCHDOG_UNIT_NAME (#4857)", () => {
  it("bate com unitBaseName(WATCHDOG_TASK_NAME) — nunca diverge em silêncio do literal fixado", () => {
    assert.equal(WATCHDOG_UNIT_NAME, unitBaseName(WATCHDOG_TASK_NAME));
    assert.equal(WATCHDOG_UNIT_NAME, "diaria-overnight-watchdog");
  });
});

describe("buildWatchdogOnCalendar (#4857, #10565)", () => {
  it("default: a cada 10 min, 24h por dia (#10565, sem a janela 18:00->09:00 antiga)", () => {
    assert.equal(buildWatchdogOnCalendar(), "*-*-* *:00/10:00 America/Sao_Paulo");
  });

  it("regressão #10565: nenhuma restrição de hora, nunca volta à janela 00..08,18..23", () => {
    // A janela antiga deixava a rodada agendada da cadeia noturna (#10552,
    // sem teto de horário) sem detecção externa de stall entre 09:00 e 18:00.
    assert.doesNotMatch(buildWatchdogOnCalendar(), /\d{2}\.\.\d{2}/);
  });

  it("é parametrizável (intervalo diferente) sem duplicar o literal mágico", () => {
    assert.equal(buildWatchdogOnCalendar(15), "*-*-* *:00/15:00 America/Sao_Paulo");
  });

  it("sempre inclui America/Sao_Paulo explícito — mesmo achado ao vivo do #4807 pro resto do registry", () => {
    assert.match(buildWatchdogOnCalendar(), /\bAmerica\/Sao_Paulo$/);
  });
});

describe("buildWatchdogOnCalendar — validação real via systemd-analyze (quando disponível)", () => {
  // Complementa os testes de string acima com a validação AUTORITATIVA: o
  // próprio parser do systemd aceita o valor gerado e ele dispara também
  // entre 09:00 e 17:59 BRT (#10565). `systemd-analyze calendar` é consulta
  // PURAMENTE de parsing/cálculo — não toca nenhuma unit registrada nem o
  // daemon `--user` (mesma disciplina de `test/systemd-units.test.ts`).
  let hasSystemdAnalyze = false;
  try {
    execFileSync("systemd-analyze", ["--version"], { stdio: "ignore" });
    hasSystemdAnalyze = true;
  } catch {
    hasSystemdAnalyze = false;
  }

  it("o parser do systemd aceita a expressão gerada, sem lançar", { skip: !hasSystemdAnalyze }, () => {
    const onCalendar = buildWatchdogOnCalendar();
    assert.doesNotThrow(() => execFileSync("systemd-analyze", ["calendar", onCalendar], { stdio: "pipe" }));
  });

  it("regressão #10565: dispara a cada 10 min, inclusive das 09:00 às 17:59 BRT", {
    skip: !hasSystemdAnalyze,
  }, () => {
    const onCalendar = buildWatchdogOnCalendar();
    // #6974: `TZ=UTC` explícito — o `systemd-analyze` renderiza no TZ DO
    // PROCESSO, e o horário só sai com sufixo `UTC` na linha `Next elapse:`
    // quando o processo já está em UTC.
    //
    // --base-time fixo às 08:55 BRT (11:55 UTC): as 60 ocorrências seguintes
    // cobrem 09:00..18:50 BRT, exatamente o trecho que a janela antiga
    // deixava descoberto.
    const out = execFileSync(
      "systemd-analyze",
      ["calendar", "--iterations=60", "--base-time=2026-10-19 11:55:00 UTC", onCalendar],
      { encoding: "utf8", env: { ...process.env, TZ: "UTC" } },
    );
    const times = [...out.matchAll(/\b(\d{2}):(\d{2}):\d{2} UTC\b/g)].map(
      (m) => Number(m[1]) * 60 + Number(m[2]),
    );
    const unique = [...new Set(times)].sort((x, y) => x - y);
    assert.equal(unique.length, 60, `esperava 60 horários distintos na saída: ${out}`);
    // 12:00 UTC = 09:00 BRT; 20:59 UTC = 17:59 BRT.
    const daytime = unique.filter((t) => t >= 12 * 60 && t <= 20 * 60 + 59);
    assert.equal(daytime.length, 54, `esperava 54 disparos entre 09:00 e 17:59 BRT, veio ${daytime.length}: ${out}`);
    for (let i = 1; i < unique.length; i++) {
      assert.equal(unique[i] - unique[i - 1], 10, `intervalo != 10 min entre ocorrências consecutivas: ${out}`);
    }
  });
});

describe("buildWatchdogSystemdUnitFiles (#4857)", () => {
  const repoRootAbs = "/home/editor/diaria-studio";
  const files = buildWatchdogSystemdUnitFiles(repoRootAbs);

  it("nomes de arquivo derivados de WATCHDOG_UNIT_NAME", () => {
    assert.equal(files.unitName, "diaria-overnight-watchdog");
    assert.equal(files.serviceFileName, "diaria-overnight-watchdog.service");
    assert.equal(files.timerFileName, "diaria-overnight-watchdog.timer");
  });

  it("service: WorkingDirectory + ExecStart chamam overnight-watchdog.ts DIRETO (sem run-task.ts)", () => {
    assert.match(files.serviceContent, /^\[Unit\]/);
    assert.match(files.serviceContent, /Type=oneshot/);
    assert.match(files.serviceContent, new RegExp(`WorkingDirectory=${repoRootAbs}`));
    assert.match(
      files.serviceContent,
      new RegExp(`ExecStart=.*--import tsx ${repoRootAbs}/scripts/overnight-watchdog\\.ts$`, "m"),
    );
    assert.doesNotMatch(files.serviceContent, /run-task\.ts/);
  });

  // #5114: consistência com os outros 2 geradores -- nenhum unit deste repo
  // passava ambiente algum antes deste fix.
  it("service: EnvironmentFile= aponta pro .env do repoRootAbs, marcado opcional com '-' (#5114)", () => {
    assert.match(files.serviceContent, new RegExp(`^EnvironmentFile=-${repoRootAbs}/\\.env$`, "m"));
  });

  it("timer: OnCalendar com fuso + Persistent=true + Unit aponta pro .service + WantedBy=timers.target", () => {
    assert.match(files.timerContent, /^OnCalendar=\*-\*-\* \*:00\/10:00 America\/Sao_Paulo$/m);
    assert.match(files.timerContent, /Persistent=true/);
    assert.match(files.timerContent, /Unit=diaria-overnight-watchdog\.service/);
    assert.match(files.timerContent, /WantedBy=timers\.target/);
  });

  it("nunca emite uma chave 'Timezone=' separada — não existe em systemd.timer", () => {
    assert.doesNotMatch(files.timerContent, /^Timezone=/m);
  });

  it("nodeBin explícito vai literal no ExecStart= (#13151)", () => {
    const custom = buildWatchdogSystemdUnitFiles(repoRootAbs, "/home/x/.nvm/versions/node/v24.19.0/bin/node");
    assert.match(
      custom.serviceContent,
      /^ExecStart=\/home\/x\/\.nvm\/versions\/node\/v24\.19\.0\/bin\/node --import tsx \/home\/editor\/diaria-studio\/scripts\/overnight-watchdog\.ts$/m,
    );
  });
});

describe("generateWatchdogSystemdUnits — escreve arquivos em disco, nunca chama systemctl", () => {
  let outDir: string;

  after(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("escreve 1 .service + 1 .timer com conteúdo correspondente", () => {
    outDir = mkdtempSync(join(tmpdir(), "watchdog-systemd-units-test-"));
    const written = generateWatchdogSystemdUnits("/repo/abs", outDir);

    assert.equal(written.length, 2);
    const entries = readdirSync(outDir).sort();
    assert.deepEqual(entries, ["diaria-overnight-watchdog.service", "diaria-overnight-watchdog.timer"]);

    const serviceContent = readFileSync(join(outDir, "diaria-overnight-watchdog.service"), "utf8");
    assert.match(serviceContent, /ExecStart=.*overnight-watchdog\.ts$/m);
  });
});

describe("setup-watchdog-schedule-systemd.ts main() — CLI", () => {
  let outDir: string;

  after(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("sem --out-dir -> usa .systemd-units/ relativo ao repoRootAbs informado, retorna 0", () => {
    outDir = mkdtempSync(join(tmpdir(), "watchdog-systemd-cli-default-"));
    const originalLog = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = setupWatchdogSystemdMain([], outDir, NVM_DEPS);
    } finally {
      console.log = originalLog;
    }
    assert.equal(code, 0);
    const entries = readdirSync(join(outDir, ".systemd-units")).sort();
    assert.deepEqual(entries, ["diaria-overnight-watchdog.service", "diaria-overnight-watchdog.timer"]);
  });

  it("--out-dir <dir> -> escreve lá, retorna 0", () => {
    const base = mkdtempSync(join(tmpdir(), "watchdog-systemd-cli-outdir-"));
    outDir = base;
    const originalLog = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = setupWatchdogSystemdMain(["--out-dir", "custom-units"], base, NVM_DEPS);
    } finally {
      console.log = originalLog;
    }
    assert.equal(code, 0);
    const entries = readdirSync(join(base, "custom-units")).sort();
    assert.deepEqual(entries, ["diaria-overnight-watchdog.service", "diaria-overnight-watchdog.timer"]);
  });

  // #13151: o node do ExecStart vem do nvm do `.nvmrc`, nunca do processo
  // que gerou. Antes, `process.execPath` ia direto pro unit e o CLI só avisava
  // quando ele estava abaixo do piso (pelo ssh, `/usr/bin/node`).
  it("cenário ssh (processo em /usr/bin/node v20, nvm com v24) -> ExecStart usa o node do nvm (#13151)", () => {
    outDir = mkdtempSync(join(tmpdir(), "watchdog-systemd-cli-ssh-"));
    const originalLog = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = setupWatchdogSystemdMain([], outDir, SSH_DEPS);
    } finally {
      console.log = originalLog;
    }
    assert.equal(code, 0);
    const service = readFileSync(join(outDir, ".systemd-units", "diaria-overnight-watchdog.service"), "utf8");
    assert.match(service, /^ExecStart=\/home\/x\/\.nvm\/versions\/node\/v24\.19\.0\/bin\/node --import tsx /m);
    assert.doesNotMatch(service, /\/usr\/bin\/node/);
  });

  it("--node-bin <path absoluto> vence o nvm (#13151)", () => {
    outDir = mkdtempSync(join(tmpdir(), "watchdog-systemd-cli-override-"));
    const originalLog = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = setupWatchdogSystemdMain(["--node-bin", "/opt/node24/bin/node"], outDir, {
        resolveNodeBinary: (o) =>
          resolveSystemdNodeBinary({ ...SSH_RESOLVE, override: o, fileExists: (p) => p === "/opt/node24/bin/node" }),
        resolveVersion: () => "v24.19.0",
      });
    } finally {
      console.log = originalLog;
    }
    assert.equal(code, 0);
    const service = readFileSync(join(outDir, ".systemd-units", "diaria-overnight-watchdog.service"), "utf8");
    assert.match(service, /^ExecStart=\/opt\/node24\/bin\/node --import tsx /m);
  });

  it("nenhum node casa com o .nvmrc -> exit 1 e nada gerado (#13151)", () => {
    outDir = mkdtempSync(join(tmpdir(), "watchdog-systemd-cli-nonode-"));
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (msg: string) => errors.push(msg);
    let code: number;
    try {
      code = setupWatchdogSystemdMain([], outDir, {
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
    outDir = mkdtempSync(join(tmpdir(), "watchdog-systemd-cli-oldnode-"));
    const originalError = console.error;
    console.error = () => {};
    let code: number;
    try {
      code = setupWatchdogSystemdMain([], outDir, { ...NVM_DEPS, resolveVersion: () => "v20.20.2" });
    } finally {
      console.error = originalError;
    }
    assert.equal(code, 1);
    assert.equal(existsSync(join(outDir, ".systemd-units")), false);
  });
});

describe("#4857: nenhum dos dois módulos executa systemctl (ARMAR é ação manual, fora de escopo)", () => {
  it("scripts/lib/watchdog-systemd-units.ts não importa node:child_process", () => {
    const source = readFileSync(resolve(ROOT, "scripts", "lib", "watchdog-systemd-units.ts"), "utf8");
    assert.doesNotMatch(source, /node:child_process/);
  });

  it("scripts/overnight/setup-watchdog-schedule-systemd.ts não importa node:child_process", () => {
    const source = readFileSync(resolve(ROOT, "scripts", "overnight", "setup-watchdog-schedule-systemd.ts"), "utf8");
    assert.doesNotMatch(source, /node:child_process/);
    assert.ok(source.includes("systemctl"), "esperava as instruções de ARMAR mencionando systemctl (como texto)");
  });
});
