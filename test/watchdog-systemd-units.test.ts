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
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildWatchdogOnCalendar,
  buildWatchdogSystemdUnitFiles,
  WATCHDOG_UNIT_NAME,
} from "../scripts/lib/watchdog-systemd-units.ts";
import { unitBaseName } from "../scripts/lib/systemd-units.ts";
import { WATCHDOG_TASK_NAME } from "../scripts/lib/check-watchdog-armed.ts";
import {
  generateWatchdogSystemdUnits,
  main as setupWatchdogSystemdMain,
} from "../scripts/overnight/setup-watchdog-schedule-systemd.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("WATCHDOG_UNIT_NAME (#4857)", () => {
  it("bate com unitBaseName(WATCHDOG_TASK_NAME) — nunca diverge em silêncio do literal fixado", () => {
    assert.equal(WATCHDOG_UNIT_NAME, unitBaseName(WATCHDOG_TASK_NAME));
    assert.equal(WATCHDOG_UNIT_NAME, "diaria-overnight-watchdog");
  });
});

describe("buildWatchdogOnCalendar (#4857)", () => {
  it("defaults (18:00->09:00 BRT, a cada 10 min) reproduzem a expressão validada AO VIVO no arme manual de 260810", () => {
    assert.equal(buildWatchdogOnCalendar(), "*-*-* 00..08,18..23:00/10:00 America/Sao_Paulo");
  });

  it("é parametrizável (janela/intervalo diferentes) sem duplicar o literal mágico", () => {
    assert.equal(buildWatchdogOnCalendar(20, 6, 15), "*-*-* 00..05,20..23:00/15:00 America/Sao_Paulo");
  });

  it("sempre inclui America/Sao_Paulo explícito — mesmo achado ao vivo do #4807 pro resto do registry", () => {
    assert.match(buildWatchdogOnCalendar(), /\bAmerica\/Sao_Paulo$/);
  });
});

describe("buildWatchdogOnCalendar — validação real via systemd-analyze (quando disponível)", () => {
  // Complementa os testes de string acima com a validação AUTORITATIVA: o
  // próprio parser do systemd aceita o valor gerado, e ele dispara DENTRO da
  // janela 18:00->09:00 BRT esperada, nunca fora dela. `systemd-analyze
  // calendar` é uma consulta PURAMENTE de parsing/cálculo — não toca nenhuma
  // unit registrada nem o daemon `--user`, então rodar isto aqui não conta
  // como "tocar o systemd real desta máquina" (não muda nenhum estado,
  // mesma disciplina de `test/systemd-units.test.ts`).
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

  it("toda ocorrência calculada cai dentro da janela 18:00-23:59 ou 00:00-08:59 BRT, nunca das 09:00 às 17:59", {
    skip: !hasSystemdAnalyze,
  }, () => {
    const onCalendar = buildWatchdogOnCalendar();
    // #6974: `TZ=UTC` explícito, pelo mesmo motivo de
    // `test/systemd-units.test.ts` — o `systemd-analyze` renderiza no TZ DO
    // PROCESSO, e o horário só sai com sufixo `UTC` na linha `Next elapse:`
    // quando o processo já está em UTC; fora disso ele vai pra uma linha
    // `(in UTC):` separada.
    //
    // Este teste sobrevivia às duas formas por CONSTRUÇÃO (o regex abaixo
    // procura o literal `UTC` em qualquer linha, e a linha `(in UTC):`
    // aparece em toda iteração) — medido: 20 horários extraídos tanto em
    // `TZ=UTC` quanto em `TZ=America/Sao_Paulo`. Mas isso é depender de um
    // detalhe de formatação que não é contrato: bastaria o systemd omitir
    // `(in UTC):` numa iteração pra `times` encolher em silêncio, e o
    // `times.length > 0` abaixo passaria feliz validando 1 ocorrência em vez
    // de 20. Forçar o TZ remove a dependência em vez de confiar nela.
    //
    // O comentário anterior justificava isto dizendo que "`helios` roda em
    // Etc/UTC". O TZ do SISTEMA é mesmo `Etc/UTC`, mas o do PROCESSO não
    // precisa ser (a sessão que achou o #6974 rodava em `America/Sao_Paulo`
    // por herança do shell) — a premissa era falsa e é justamente a que
    // deixou o teste irmão vermelho.
    const out = execFileSync("systemd-analyze", ["calendar", "--iterations=20", onCalendar], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC" },
    });
    // BRT = UTC-3, então a janela 18:00-08:59 BRT corresponde a 21:00-11:59
    // UTC. Extrai todos os HH:MM de cada linha e confirma que nenhum cai
    // fora dessa faixa.
    const times = [...out.matchAll(/\b(\d{2}):(\d{2}):\d{2} UTC\b/g)].map(
      (m) => Number(m[1]) * 60 + Number(m[2]),
    );
    assert.ok(times.length > 0, `nenhum horário extraído da saída: ${out}`);
    const windowStartUtcMin = 21 * 60; // 21:00 UTC = 18:00 BRT
    const windowEndUtcMin = 11 * 60 + 59; // 11:59 UTC = 08:59 BRT
    for (const t of times) {
      const inWindow = t >= windowStartUtcMin || t <= windowEndUtcMin;
      assert.ok(inWindow, `horário ${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")} UTC caiu fora da janela 21:00-11:59 UTC (18:00-08:59 BRT)`);
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
    assert.match(files.timerContent, /OnCalendar=\*-\*-\* 00\.\.08,18\.\.23:00\/10:00 America\/Sao_Paulo/);
    assert.match(files.timerContent, /Persistent=true/);
    assert.match(files.timerContent, /Unit=diaria-overnight-watchdog\.service/);
    assert.match(files.timerContent, /WantedBy=timers\.target/);
  });

  it("nunca emite uma chave 'Timezone=' separada — não existe em systemd.timer", () => {
    assert.doesNotMatch(files.timerContent, /^Timezone=/m);
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
      code = setupWatchdogSystemdMain([], outDir);
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
      code = setupWatchdogSystemdMain(["--out-dir", "custom-units"], base);
    } finally {
      console.log = originalLog;
    }
    assert.equal(code, 0);
    const entries = readdirSync(join(base, "custom-units")).sort();
    assert.deepEqual(entries, ["diaria-overnight-watchdog.service", "diaria-overnight-watchdog.timer"]);
  });

  // #4857 reconciliação 260810: ExecStart= baka process.execPath — Node do
  // shell que gerou o unit, não um valor descoberto/pinado. Achado ao vivo
  // nesta máquina: um shell sem `~/.local/node/bin` no PATH gera com o Node
  // 20.20.2 do sistema (mesmo binário do incidente #4823) em vez do Node 24
  // do `.nvmrc` já armado manualmente. main() nunca BLOQUEIA nesse caso
  // (fail-soft) — só avisa alto em stderr antes do editor copiar pra
  // ~/.config/systemd/user/.
  it("Node do shell abaixo do mínimo do projeto -> ainda retorna 0, mas avisa em console.warn", () => {
    outDir = mkdtempSync(join(tmpdir(), "watchdog-systemd-cli-oldnode-"));
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    const warnCalls: string[] = [];
    console.warn = (msg: string) => warnCalls.push(msg);
    let code: number;
    try {
      code = setupWatchdogSystemdMain([], outDir, "v20.20.2");
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
    outDir = mkdtempSync(join(tmpdir(), "watchdog-systemd-cli-okvernode-"));
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    const warnCalls: string[] = [];
    console.warn = (msg: string) => warnCalls.push(msg);
    let code: number;
    try {
      code = setupWatchdogSystemdMain([], outDir, "v24.19.0");
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
    assert.equal(code, 0);
    assert.equal(warnCalls.length, 0);
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
