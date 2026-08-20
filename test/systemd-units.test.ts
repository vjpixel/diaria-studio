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
import { execFileSync } from "node:child_process";
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
  it("daily -> *-*-* HH:MM:00 <fuso>, com zero-padding", () => {
    assert.equal(scheduleToOnCalendar({ kind: "daily", hour: 8, minute: 5 }), "*-*-* 08:05:00 America/Sao_Paulo");
    assert.equal(scheduleToOnCalendar({ kind: "daily", hour: 23, minute: 59 }), "*-*-* 23:59:00 America/Sao_Paulo");
  });

  it("weekly -> <Weekday abreviado> *-*-* HH:MM:00 <fuso>", () => {
    assert.equal(
      scheduleToOnCalendar({ kind: "weekly", dayOfWeek: "Monday", hour: 10, minute: 30 }),
      "Mon *-*-* 10:30:00 America/Sao_Paulo",
    );
    assert.equal(
      scheduleToOnCalendar({ kind: "weekly", dayOfWeek: "Sunday", hour: 0, minute: 0 }),
      "Sun *-*-* 00:00:00 America/Sao_Paulo",
    );
  });

  it("interval -> *-*-* 0/N:00:00 <fuso>", () => {
    assert.equal(scheduleToOnCalendar({ kind: "interval", hours: 4 }), "*-*-* 0/4:00:00 America/Sao_Paulo");
    assert.equal(scheduleToOnCalendar({ kind: "interval", hours: 12 }), "*-*-* 0/12:00:00 America/Sao_Paulo");
  });

  it("monthly (#5128/#5130) -> *-*-DD HH:MM:00 <fuso>, com zero-padding", () => {
    assert.equal(
      scheduleToOnCalendar({ kind: "monthly", day: 1, hour: 9, minute: 0 }),
      "*-*-01 09:00:00 America/Sao_Paulo",
    );
    assert.equal(
      scheduleToOnCalendar({ kind: "monthly", day: 28, hour: 23, minute: 5 }),
      "*-*-28 23:05:00 America/Sao_Paulo",
    );
  });

  // Achado ao vivo (#4807, 260810, cross-session): helios roda em Etc/UTC.
  // Sem fuso explícito no OnCalendar=, systemd interpreta as horas do
  // registry (pensadas em BRT) como se já fossem UTC -- Diaria-Clarice-Sync
  // (registry: 08:30) disparava às 08:30 UTC = 05:30 BRT, 30min ANTES do
  // envio canônico das 06:00 BRT, reintroduzindo em silêncio a regressão do
  // #2932 (onda do dia invisível pro store, --group repete gente). Mesmo
  // problema quebraria Diaria-Brevo-Diaria-Evaluate (precisa rodar ANTES das
  // 06:00 BRT -- a Brevo congela destinatários no agendamento).
  it("achado ao vivo #4807: toda variante inclui America/Sao_Paulo explícito, nunca depende do fuso do sistema", () => {
    assert.match(scheduleToOnCalendar({ kind: "daily", hour: 8, minute: 30 }), /\bAmerica\/Sao_Paulo$/);
    assert.match(
      scheduleToOnCalendar({ kind: "weekly", dayOfWeek: "Monday", hour: 4, minute: 10 }),
      /\bAmerica\/Sao_Paulo$/,
    );
    assert.match(scheduleToOnCalendar({ kind: "interval", hours: 6 }), /\bAmerica\/Sao_Paulo$/);
  });

  // Primeira tentativa de correção (mesma sessão) tentou uma chave
  // `Timezone=` separada em [Timer] -- não existe em systemd.timer;
  // systemd 259 ignora silenciosamente com warning no journal ("Unknown
  // key 'Timezone' in section [Timer]"). O fuso tem que estar embutido no
  // próprio valor de OnCalendar=, nunca numa chave à parte.
  it("nunca emite uma chave 'Timezone=' -- não existe em systemd.timer, é ignorada em silêncio", () => {
    for (const t of SCHEDULED_TASKS) {
      const { timerContent } = buildSystemdUnitFiles(t, "/home/editor/diaria-studio");
      assert.doesNotMatch(timerContent, /^Timezone=/m, `${t.name}: chave Timezone= inválida encontrada`);
    }
  });
});

describe("scheduleToOnCalendar — validação real via systemd-analyze (quando disponível)", () => {
  // Complementa os testes de string acima com a validação AUTORITATIVA: o
  // próprio parser do systemd aceita o valor gerado, e o horário calculado
  // bate com a intenção do registry (não só "parece certo"). Achado ao vivo
  // #4807: string bem-formada não é garantia de comportamento certo -- a
  // primeira tentativa (chave `Timezone=` separada) também "parecia certa"
  // e passava despercebida sem essa checagem.
  let hasSystemdAnalyze = false;
  try {
    execFileSync("systemd-analyze", ["--version"], { stdio: "ignore" });
    hasSystemdAnalyze = true;
  } catch {
    hasSystemdAnalyze = false;
  }

  it("Diaria-Clarice-Sync (08:30 registry) calcula next-elapse em 08:30 BRT = 11:30 UTC, nunca 08:30 UTC", { skip: !hasSystemdAnalyze }, () => {
    const task = getScheduledTaskByName("Diaria-Clarice-Sync")!;
    const onCalendar = scheduleToOnCalendar(task.schedule);
    const out = execFileSync("systemd-analyze", ["calendar", "--iterations=1", onCalendar], { encoding: "utf8" });
    assert.match(out, /Next elapse: .* 11:30:00 UTC/, `saída completa: ${out}`);
  });

  it("todo SCHEDULED_TASKS gera um valor de OnCalendar= aceito pelo parser do systemd", { skip: !hasSystemdAnalyze }, () => {
    for (const t of SCHEDULED_TASKS) {
      const onCalendar = scheduleToOnCalendar(t.schedule);
      assert.doesNotThrow(
        () => execFileSync("systemd-analyze", ["calendar", onCalendar], { stdio: "pipe" }),
        `${t.name}: "${onCalendar}" rejeitado pelo systemd-analyze`,
      );
    }
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

  // #5114: CLARICE_API_KEY (e demais credenciais do .env) nunca chegava ao
  // ambiente de nenhum unit gerado -- o `.mcp.json` interpola `${CLARICE_API_KEY}`
  // no momento do LAUNCH do processo Claude Code, e nenhum loader TS roda a
  // tempo de consertar isso depois de o processo já ter subido.
  it("service: EnvironmentFile= aponta pro .env do repoRootAbs, marcado opcional com '-' (#5114)", () => {
    assert.match(files.serviceContent, new RegExp(`^EnvironmentFile=-${repoRootAbs}/\\.env$`, "m"));
  });

  it("EnvironmentFile= vem ANTES de ExecStart= (ordem não importa pro systemd, mas documenta a intenção)", () => {
    const envIdx = files.serviceContent.indexOf("EnvironmentFile=");
    const execIdx = files.serviceContent.indexOf("ExecStart=");
    assert.ok(envIdx >= 0 && execIdx >= 0 && envIdx < execIdx);
  });

  it("timer: OnCalendar (com fuso) + Persistent=true + Unit aponta pro .service + WantedBy=timers.target", () => {
    assert.match(files.timerContent, /OnCalendar=\*-\*-\* 09:45:00 America\/Sao_Paulo/);
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

describe("buildSystemdUnitFiles — SuccessExitStatus=", () => {
  const repoRootAbs = "/home/editor/diaria-studio";

  it("task SEM successExitCodes -> nenhuma linha SuccessExitStatus= no .service", () => {
    const task = getScheduledTaskByName("Diaria-Apoios-Diff-Alarm")!;
    assert.equal(task.successExitCodes, undefined);
    const files = buildSystemdUnitFiles(task, repoRootAbs);
    assert.doesNotMatch(files.serviceContent, /SuccessExitStatus=/);
  });

  it("Diaria-Clarice-Novos declara exit 3 esperado de novo, agora por #5743 (disparo incerto, não mais D4)", () => {
    const task = getScheduledTaskByName("Diaria-Clarice-Novos")!;
    assert.deepEqual(task.successExitCodes, [3]);
    const files = buildSystemdUnitFiles(task, repoRootAbs);
    assert.match(files.serviceContent, /^SuccessExitStatus=3$/m);
  });

  it("Diaria-Clarice-Novos-Tarde também declara exit 3 esperado (#5743)", () => {
    const task = getScheduledTaskByName("Diaria-Clarice-Novos-Tarde")!;
    assert.deepEqual(task.successExitCodes, [3]);
    const files = buildSystemdUnitFiles(task, repoRootAbs);
    assert.match(files.serviceContent, /^SuccessExitStatus=3$/m);
  });

  it("o alarme #5405 não é mais uma task registrada após a remoção do D4", () => {
    assert.equal(getScheduledTaskByName("Diaria-Clarice-Novos-Abort-Alarm"), undefined);
  });

  it("múltiplos códigos -> uma linha só, códigos separados por espaço", () => {
    const task = { ...getScheduledTaskByName("Diaria-Apoios-Diff-Alarm")!, successExitCodes: [3, 42] };
    const files = buildSystemdUnitFiles(task, repoRootAbs);
    assert.match(files.serviceContent, /^SuccessExitStatus=3 42$/m);
  });

  it("successExitCodes: [] (array vazio) -> tratado como ausente, nenhuma linha emitida", () => {
    const task = { ...getScheduledTaskByName("Diaria-Apoios-Diff-Alarm")!, successExitCodes: [] };
    const files = buildSystemdUnitFiles(task, repoRootAbs);
    assert.doesNotMatch(files.serviceContent, /SuccessExitStatus=/);
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
