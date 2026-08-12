/**
 * test/scheduled-task-status.test.ts (#4799)
 *
 * Cobertura de `scripts/lib/scheduled-task-status.ts`:
 *   - `queryTaskArmed` (Windows via mock de `schtasks`, Linux via mock de
 *     `systemctl --user is-enabled`, e o caso `cannot_verify` quando nenhum
 *     agendador é reconhecido) — nunca chama subprocesso real.
 *   - `parseTaskLogRuns`/`classifyTaskRunResult` contra fixtures REAIS do
 *     formato de log compartilhado (`task-runner.ts` e, historicamente até
 *     o #5115, `Invoke-DiariaScheduledWrapper.psm1` do `.ps1` legado —
 *     incluindo a divergência de literal de guard-abort entre os dois —
 *     `"guard=skip"` vs `"<key>=skip-guard"`).
 *   - `sanitizeLogExcerpt` (secrets nunca vazam).
 *   - `readTaskLastRun` fail-soft com fixtures em tmpdir.
 *   - `computeMostRecentScheduledOccurrence`/`computeNextRunAtOrAfter`/
 *     `isTaskOverdue` (schedule math puro, BRT fixo UTC-3).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  queryTaskArmed,
  parseTaskLogRuns,
  classifyTaskRunResult,
  sanitizeLogExcerpt,
  readTaskLastRun,
  computeMostRecentScheduledOccurrence,
  computeNextRunAtOrAfter,
  isTaskOverdue,
  type TaskLogRun,
} from "../scripts/lib/scheduled-task-status.ts";
import type { ScheduledTaskDefinition } from "../scripts/lib/scheduled-tasks.ts";

let root: string | null = null;
afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), "scheduled-task-status-"));
  return root;
}

function fakeDef(overrides: Partial<ScheduledTaskDefinition> = {}): ScheduledTaskDefinition {
  return {
    name: "Diaria-Fake-Task",
    description: "task fake pra teste",
    steps: [{ key: "run", script: "scripts/fake.ts" }],
    logPath: "fake/.fake.log",
    schedule: { kind: "daily", hour: 9, minute: 0 },
    issue: "#0000",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// queryTaskArmed
// ---------------------------------------------------------------------------

describe("queryTaskArmed (#4799)", () => {
  it("Windows: task presente e habilitada -> armed", () => {
    const exec = ((cmd: string, args: string[]) => {
      if (args.includes("/v")) {
        return "Scheduled Task State:                 Enabled\nLast Result:                          0\nLast Run Time:                        8/9/2026 9:00:00 AM\n";
      }
      return ""; // /query sem /v -> sucesso (exit 0, sem lançar)
    }) as unknown as typeof import("node:child_process").execFileSync;
    const result = queryTaskArmed("Diaria-Clarice-Sync", {
      execFn: exec,
      taskSchedulerFn: () => "windows-task-scheduler",
    });
    assert.equal(result.scheduler, "windows-task-scheduler");
    assert.equal(result.state, "armed");
  });

  it("Windows: task presente e desabilitada -> disabled", () => {
    const exec = ((cmd: string, args: string[]) => {
      if (args.includes("/v")) return "Scheduled Task State:                 Disabled\n";
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;
    const result = queryTaskArmed("Diaria-Clarice-Sync", {
      execFn: exec,
      taskSchedulerFn: () => "windows-task-scheduler",
    });
    assert.equal(result.state, "disabled");
  });

  it("Windows: task ausente (exit != 0) -> not_armed", () => {
    const exec = (() => {
      const err: { status: number } = { status: 1 };
      throw err;
    }) as unknown as typeof import("node:child_process").execFileSync;
    const result = queryTaskArmed("Diaria-Clarice-Sync", {
      execFn: exec,
      taskSchedulerFn: () => "windows-task-scheduler",
    });
    assert.equal(result.state, "not_armed");
  });

  it("Windows: schtasks indisponível (ENOENT) -> cannot_verify", () => {
    const exec = (() => {
      const err: { code: string } = { code: "ENOENT" };
      throw err;
    }) as unknown as typeof import("node:child_process").execFileSync;
    const result = queryTaskArmed("Diaria-Clarice-Sync", {
      execFn: exec,
      taskSchedulerFn: () => "windows-task-scheduler",
    });
    assert.equal(result.state, "cannot_verify");
    assert.match(result.note ?? "", /schtasks indisponível/);
  });

  it("Windows: task presente (schtasks /query ok) mas consulta verbose falha -> cannot_verify, NUNCA armed (#4833 achado 1)", () => {
    const exec = ((cmd: string, args: string[]) => {
      if (args.includes("/v")) {
        const err: { code: string } = { code: "ENOENT" };
        throw err;
      }
      return ""; // /query sem /v -> sucesso (exit 0, sem lançar) — task existe
    }) as unknown as typeof import("node:child_process").execFileSync;
    const result = queryTaskArmed("Diaria-Clarice-Sync", {
      execFn: exec,
      taskSchedulerFn: () => "windows-task-scheduler",
    });
    // Regressão do incidente #2944: presença sozinha NUNCA vira "armed" —
    // sem a consulta verbose não há como saber se está habilitada.
    assert.equal(result.state, "cannot_verify");
    assert.match(result.note ?? "", /verbose/i);
  });

  it("Linux/systemd: is-enabled 'enabled' -> armed", () => {
    const exec = (() => "enabled\n") as unknown as typeof import("node:child_process").execFileSync;
    const result = queryTaskArmed("Diaria-Apoios-Diff-Alarm", { execFn: exec, taskSchedulerFn: () => "systemd" });
    assert.equal(result.scheduler, "systemd");
    assert.equal(result.state, "armed");
  });

  it("Linux/systemd: is-enabled 'disabled' (exit 0, decisão real do systemctl) -> disabled", () => {
    const exec = (() => "disabled\n") as unknown as typeof import("node:child_process").execFileSync;
    const result = queryTaskArmed("Diaria-Apoios-Diff-Alarm", { execFn: exec, taskSchedulerFn: () => "systemd" });
    assert.equal(result.state, "disabled");
  });

  it("Linux/systemd: is-enabled sai != 0 com stdout 'disabled' (comportamento real observado) -> disabled", () => {
    const exec = (() => {
      const err: { status: number; stdout: string } = { status: 1, stdout: "disabled\n" };
      throw err;
    }) as unknown as typeof import("node:child_process").execFileSync;
    const result = queryTaskArmed("Diaria-Apoios-Diff-Alarm", { execFn: exec, taskSchedulerFn: () => "systemd" });
    assert.equal(result.state, "disabled");
  });

  it("Linux/systemd: unit não encontrada (exit != 0, sem stdout reconhecido) -> cannot_verify (#4833 achado 2 — não é mais um not_armed assumido)", () => {
    const exec = (() => {
      const err: { status: number; stdout: string; stderr: string } = {
        status: 1,
        stdout: "",
        stderr: "Failed to get unit file state for diaria-apoios-diff-alarm.timer: No such file or directory\n",
      };
      throw err;
    }) as unknown as typeof import("node:child_process").execFileSync;
    const result = queryTaskArmed("Diaria-Apoios-Diff-Alarm", { execFn: exec, taskSchedulerFn: () => "systemd" });
    assert.equal(result.state, "cannot_verify");
  });

  it("Linux/systemd: unit ausente via exceção com stdout 'not-found' (comportamento REAL observado ao vivo, #4857) -> not_armed, NÃO cannot_verify", () => {
    // Achado ao vivo desta unidade (#4857, validado contra `systemctl` real
    // — não a fixture especulativa do teste acima): `systemctl --user
    // is-enabled <unit ausente>.timer` sai != 0 (4, nesta máquina) E stdout
    // "not-found\n", stderr vazio — DIFERENTE do fixture "Failed to get unit
    // file state..." do teste anterior (#4833 achado 2), que pode
    // representar outro caminho de erro (ex: `systemctl status`/`show`) mas
    // não é o que `is-enabled` reporta pra unit ausente nesta versão real do
    // systemd (259). Sem este branch, o caso MAIS COMUM (unit simplesmente
    // nunca armada) virava `cannot_verify` — um falso "não deu pra
    // verificar" bem no caso central que esta função existe pra responder.
    const exec = (() => {
      const err: { status: number; stdout: string; stderr: string } = {
        status: 4,
        stdout: "not-found\n",
        stderr: "",
      };
      throw err;
    }) as unknown as typeof import("node:child_process").execFileSync;
    const result = queryTaskArmed("Diaria-Apoios-Diff-Alarm", { execFn: exec, taskSchedulerFn: () => "systemd" });
    assert.equal(result.state, "not_armed");
  });

  it("Linux/systemd: exceção genuinamente não reconhecida do systemctl (ex: permissão) -> cannot_verify, NUNCA not_armed (#4833 achado 2)", () => {
    const exec = (() => {
      const err: { status: number; stdout: string; stderr: string } = {
        status: 1,
        stdout: "",
        stderr: "Permission denied while talking to systemd\n",
      };
      throw err;
    }) as unknown as typeof import("node:child_process").execFileSync;
    const result = queryTaskArmed("Diaria-Apoios-Diff-Alarm", { execFn: exec, taskSchedulerFn: () => "systemd" });
    // Erro inesperado não é fato verificado de "não armada" — é honesto
    // reportar "não sei", não uma afirmação positiva inventada.
    assert.equal(result.state, "cannot_verify");
    assert.match(result.note ?? "", /erro inesperado/i);
  });

  it("Linux/systemd: sem bus de sessão -> cannot_verify (não confundir com not_armed)", () => {
    const exec = (() => {
      const err: { status: number; stdout: string; stderr: string } = {
        status: 1,
        stdout: "",
        stderr: "Failed to connect to bus: No such file or directory\n",
      };
      throw err;
    }) as unknown as typeof import("node:child_process").execFileSync;
    const result = queryTaskArmed("Diaria-Apoios-Diff-Alarm", { execFn: exec, taskSchedulerFn: () => "systemd" });
    assert.equal(result.state, "cannot_verify");
  });

  it("Linux/systemd: systemctl indisponível (ENOENT) -> cannot_verify", () => {
    const exec = (() => {
      const err: { code: string } = { code: "ENOENT" };
      throw err;
    }) as unknown as typeof import("node:child_process").execFileSync;
    const result = queryTaskArmed("Diaria-Apoios-Diff-Alarm", { execFn: exec, taskSchedulerFn: () => "systemd" });
    assert.equal(result.state, "cannot_verify");
  });

  it("nenhum agendador reconhecido ('none') -> cannot_verify, nunca not_armed", () => {
    const result = queryTaskArmed("Diaria-Apoios-Diff-Alarm", { taskSchedulerFn: () => "none" });
    assert.equal(result.scheduler, "none");
    assert.equal(result.state, "cannot_verify");
  });
});

// ---------------------------------------------------------------------------
// parseTaskLogRuns / classifyTaskRunResult
// ---------------------------------------------------------------------------

describe("parseTaskLogRuns (#4799)", () => {
  it("parseia um log com 2 runs no formato do task-runner.ts (trailer 'key=code')", () => {
    const content = [
      "",
      "===== 2026-08-09T08:30:00.000Z - sync incremental diario do store Clarice =====",
      "----- sync -----",
      "ok",
      "----- extract -----",
      "ok",
      "----- summary -----",
      "ok",
      "===== fim (sync=0 extract=0 summary=0) =====",
      "",
      "===== 2026-08-10T08:30:05.000Z - sync incremental diario do store Clarice =====",
      "----- sync -----",
      "ERRO: falhou",
      "===== fim (sync=1 extract=0 summary=0) =====",
    ].join("\n");
    const runs = parseTaskLogRuns(content);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].startedAt, "2026-08-09T08:30:00.000Z");
    assert.deepEqual(
      runs[0].steps.map((s) => [s.key, s.code]),
      [
        ["sync", 0],
        ["extract", 0],
        ["summary", 0],
      ],
    );
    assert.equal(runs[1].steps[0].code, 1);
    assert.equal(runs[1].guardAborted, false);
  });

  it("reconhece guard-abort do runner TS ('guard=skip')", () => {
    const content = [
      "===== 2026-08-09T05:30:00.000Z - evaluate diario do canal brevo_diaria (--push) =====",
      "AVISO: contacts.json nao encontrado",
      "===== fim (guard=skip) =====",
    ].join("\n");
    const [run] = parseTaskLogRuns(content);
    assert.equal(run.guardAborted, true);
    assert.equal(run.steps.length, 0);
  });

  it("reconhece guard-abort do .ps1 legado ('<key>=skip-guard', Invoke-DiariaScheduledWrapper.psm1)", () => {
    const content = [
      "===== 2026-08-09T05:30:00.000Z - evaluate diario do canal brevo_diaria =====",
      "AVISO: contacts.json nao encontrado",
      "===== fim (evaluate=skip-guard) =====",
    ].join("\n");
    const [run] = parseTaskLogRuns(content);
    assert.equal(run.guardAborted, true);
  });

  it("trailer 'noop' -> guardAborted false, steps vazio", () => {
    const content = ["===== 2026-08-09T05:30:00.000Z - desc =====", "===== fim (noop) ====="].join("\n");
    const [run] = parseTaskLogRuns(content);
    assert.equal(run.guardAborted, false);
    assert.equal(run.steps.length, 0);
  });

  it("descarta bloco truncado (header sem trailer correspondente)", () => {
    const content = [
      "===== 2026-08-09T05:30:00.000Z - desc =====",
      "----- run -----",
      "saida truncada aqui, sem fechar",
    ].join("\n");
    const runs = parseTaskLogRuns(content);
    assert.equal(runs.length, 0);
  });

  it("conteúdo vazio -> lista vazia", () => {
    assert.deepEqual(parseTaskLogRuns(""), []);
  });
});

describe("classifyTaskRunResult (#4799)", () => {
  const def = fakeDef({
    steps: [
      { key: "sync", script: "s.ts" },
      { key: "extract", script: "e.ts", bestEffort: true },
    ],
  });

  function run(overrides: Partial<TaskLogRun>): TaskLogRun {
    return { startedAt: "2026-08-09T08:30:00.000Z", description: "d", guardAborted: false, steps: [], raw: "", ...overrides };
  }

  it("todos os passos ok -> 'ok'", () => {
    const r = run({ steps: [{ key: "sync", code: 0, raw: "0" }, { key: "extract", code: 0, raw: "0" }] });
    assert.equal(classifyTaskRunResult(r, def), "ok");
  });

  it("passo NÃO best-effort falhou -> 'failed'", () => {
    const r = run({ steps: [{ key: "sync", code: 1, raw: "1" }] });
    assert.equal(classifyTaskRunResult(r, def), "failed");
  });

  it("passo best-effort falhou mas os demais ok -> 'ok' (best-effort nunca reprova)", () => {
    const r = run({ steps: [{ key: "sync", code: 0, raw: "0" }, { key: "extract", code: 1, raw: "1" }] });
    assert.equal(classifyTaskRunResult(r, def), "ok");
  });

  it("key ausente do registro (trailer legado desalinhado) tratada como NÃO best-effort -> 'failed'", () => {
    const r = run({ steps: [{ key: "chave-desconhecida", code: 1, raw: "1" }] });
    assert.equal(classifyTaskRunResult(r, def), "failed");
  });

  it("guardAborted -> 'guard_skip'", () => {
    const r = run({ guardAborted: true });
    assert.equal(classifyTaskRunResult(r, def), "guard_skip");
  });

  it("sem passos e sem guard (noop) -> 'unknown'", () => {
    const r = run({ steps: [] });
    assert.equal(classifyTaskRunResult(r, def), "unknown");
  });
});

// ---------------------------------------------------------------------------
// sanitizeLogExcerpt
// ---------------------------------------------------------------------------

describe("sanitizeLogExcerpt (#4799)", () => {
  it("redige Authorization: Bearer", () => {
    const out = sanitizeLogExcerpt("Authorization: Bearer sk-abc123def456ghi789jkl012mno345", 10_000);
    assert.doesNotMatch(out, /sk-abc123def456ghi789jkl012mno345/);
    assert.match(out, /\[REDACTED\]/);
  });

  it("redige pares api_key=/token: óbvios", () => {
    const out = sanitizeLogExcerpt('{"api_key": "AbCdEf123456"}', 10_000);
    assert.doesNotMatch(out, /AbCdEf123456/);
  });

  it("redige token opaco longo (32+ chars) mesmo sem prefixo reconhecido", () => {
    const out = sanitizeLogExcerpt("resposta: " + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6", 10_000);
    assert.doesNotMatch(out, /a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6/);
  });

  it("trunca mantendo o TRECHO FINAL quando excede maxChars", () => {
    const raw = "linha de log normal repetida\n".repeat(20) + "FINAL_MARKER";
    const out = sanitizeLogExcerpt(raw, 20);
    assert.match(out, /FINAL_MARKER/);
    assert.match(out, /truncado/);
  });

  it("texto curto sem secret passa intocado (modulo trim)", () => {
    const out = sanitizeLogExcerpt("sync ok\nsummary ok", 10_000);
    assert.equal(out, "sync ok\nsummary ok");
  });
});

// ---------------------------------------------------------------------------
// readTaskLastRun (fail-soft, tmpdir)
// ---------------------------------------------------------------------------

describe("readTaskLastRun (#4799)", () => {
  it("log ausente -> tudo null, nunca lança", () => {
    const rootDir = makeRoot();
    const def = fakeDef({ logPath: "fake/.fake.log" });
    const info = readTaskLastRun(rootDir, def);
    assert.equal(info.startedAt, null);
    assert.equal(info.finishedAt, null);
    assert.equal(info.outcome, null);
  });

  it("log com 1 run bem-sucedida -> outcome ok, duração derivada do mtime", () => {
    const rootDir = makeRoot();
    const logDir = join(rootDir, "data", "fake");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, ".fake.log");
    const content = [
      "===== 2026-08-09T08:30:00.000Z - task fake pra teste =====",
      "----- run -----",
      "tudo ok",
      "===== fim (run=0) =====",
      "",
    ].join("\n");
    writeFileSync(logPath, content, "utf8");
    // mtime determinístico -> duração previsível no teste.
    const finishedAt = new Date("2026-08-09T08:30:07.000Z");
    utimesSync(logPath, finishedAt, finishedAt);

    const def = fakeDef({ logPath: "fake/.fake.log" });
    const info = readTaskLastRun(rootDir, def);
    assert.equal(info.startedAt?.toISOString(), "2026-08-09T08:30:00.000Z");
    assert.equal(info.finishedAt?.toISOString(), "2026-08-09T08:30:07.000Z");
    assert.equal(info.durationMs, 7000);
    assert.equal(info.outcome, "ok");
    assert.match(info.excerpt ?? "", /tudo ok/);
  });

  it("log com passo falho (não best-effort) -> outcome failed", () => {
    const rootDir = makeRoot();
    const logDir = join(rootDir, "data", "fake");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, ".fake.log");
    writeFileSync(
      logPath,
      ["===== 2026-08-09T08:30:00.000Z - task fake pra teste =====", "===== fim (run=1) ====="].join("\n"),
      "utf8",
    );
    const def = fakeDef({ logPath: "fake/.fake.log" });
    assert.equal(readTaskLastRun(rootDir, def).outcome, "failed");
  });
});

// ---------------------------------------------------------------------------
// Schedule math (BRT fixo UTC-3)
// ---------------------------------------------------------------------------

describe("computeMostRecentScheduledOccurrence (#4799)", () => {
  it("daily 08:30 BRT: 'agora' 2026-08-10T14:00:00Z (11:00 BRT, já passou do horário) -> hoje 11:30Z", () => {
    const now = new Date("2026-08-10T14:00:00.000Z");
    const occ = computeMostRecentScheduledOccurrence({ kind: "daily", hour: 8, minute: 30 }, now);
    assert.equal(occ.toISOString(), "2026-08-10T11:30:00.000Z"); // 08:30 BRT = 11:30 UTC
  });

  it("daily 08:30 BRT: 'agora' antes do horário de hoje -> ocorrência de ONTEM", () => {
    const now = new Date("2026-08-10T10:00:00.000Z"); // 07:00 BRT, antes das 08:30
    const occ = computeMostRecentScheduledOccurrence({ kind: "daily", hour: 8, minute: 30 }, now);
    assert.equal(occ.toISOString(), "2026-08-09T11:30:00.000Z");
  });

  it("weekly Monday 10:30 BRT: 'agora' é segunda após o horário -> hoje", () => {
    // 2026-08-10 é segunda-feira.
    const now = new Date("2026-08-10T15:00:00.000Z"); // 12:00 BRT segunda
    const occ = computeMostRecentScheduledOccurrence({ kind: "weekly", dayOfWeek: "Monday", hour: 10, minute: 30 }, now);
    assert.equal(occ.toISOString(), "2026-08-10T13:30:00.000Z");
  });

  it("weekly Monday 10:30 BRT: 'agora' é quarta -> segunda anterior", () => {
    const now = new Date("2026-08-12T15:00:00.000Z"); // quarta
    const occ = computeMostRecentScheduledOccurrence({ kind: "weekly", dayOfWeek: "Monday", hour: 10, minute: 30 }, now);
    assert.equal(occ.toISOString(), "2026-08-10T13:30:00.000Z");
  });

  it("kind 'interval' lança (sem âncora de calendário)", () => {
    assert.throws(() => computeMostRecentScheduledOccurrence({ kind: "interval", hours: 4 }, new Date()));
  });

  it("monthly dia 1, 09:00 BRT (#5128/#5130): 'agora' é meio do mês, depois do dia 1 -> ocorrência DESTE mês", () => {
    const now = new Date("2026-08-10T14:00:00.000Z");
    const occ = computeMostRecentScheduledOccurrence({ kind: "monthly", day: 1, hour: 9, minute: 0 }, now);
    assert.equal(occ.toISOString(), "2026-08-01T12:00:00.000Z"); // 09:00 BRT = 12:00 UTC
  });

  it("monthly dia 1, 09:00 BRT: 'agora' é dia 1 ANTES do horário -> ocorrência do mês ANTERIOR", () => {
    const now = new Date("2026-08-01T10:00:00.000Z"); // 07:00 BRT, antes das 09:00
    const occ = computeMostRecentScheduledOccurrence({ kind: "monthly", day: 1, hour: 9, minute: 0 }, now);
    assert.equal(occ.toISOString(), "2026-07-01T12:00:00.000Z");
  });

  it("monthly: rollover de ano (janeiro 'agora' antes do dia 1 -> dezembro do ano anterior)", () => {
    const now = new Date("2027-01-01T10:00:00.000Z"); // antes das 09:00 BRT do dia 1/jan
    const occ = computeMostRecentScheduledOccurrence({ kind: "monthly", day: 1, hour: 9, minute: 0 }, now);
    assert.equal(occ.toISOString(), "2026-12-01T12:00:00.000Z");
  });
});

describe("computeNextRunAtOrAfter (#4799)", () => {
  it("daily: próxima ocorrência é amanhã quando já passou hoje", () => {
    const after = new Date("2026-08-10T14:00:00.000Z"); // 11:00 BRT, já passou das 08:30
    const next = computeNextRunAtOrAfter({ kind: "daily", hour: 8, minute: 30 }, after);
    assert.equal(next?.toISOString(), "2026-08-11T11:30:00.000Z");
  });

  it("interval -> null (sem âncora)", () => {
    assert.equal(computeNextRunAtOrAfter({ kind: "interval", hours: 4 }, new Date()), null);
  });

  it("monthly (#5128/#5130): próxima ocorrência é dia 1 do MÊS SEGUINTE", () => {
    const after = new Date("2026-08-10T14:00:00.000Z");
    const next = computeNextRunAtOrAfter({ kind: "monthly", day: 1, hour: 9, minute: 0 }, after);
    assert.equal(next?.toISOString(), "2026-09-01T12:00:00.000Z");
  });

  it("monthly: rollover de ano (dezembro -> janeiro do ano seguinte)", () => {
    const after = new Date("2026-12-15T14:00:00.000Z");
    const next = computeNextRunAtOrAfter({ kind: "monthly", day: 1, hour: 9, minute: 0 }, after);
    assert.equal(next?.toISOString(), "2027-01-01T12:00:00.000Z");
  });
});

describe("isTaskOverdue (#4799)", () => {
  const dailySchedule = { kind: "daily" as const, hour: 8, minute: 30 };

  it("daily: nunca rodou e já passou o horário + grace -> overdue", () => {
    const now = new Date("2026-08-10T14:00:00.000Z");
    assert.equal(isTaskOverdue(dailySchedule, null, now), true);
  });

  it("daily: nunca rodou mas ainda dentro do grace period -> não overdue", () => {
    // 08:30 BRT = 11:30Z; +5min de grace ainda não passou às 11:34Z.
    const now = new Date("2026-08-10T11:34:00.000Z");
    assert.equal(isTaskOverdue(dailySchedule, null, now, 60), false);
  });

  it("daily: rodou hoje na janela -> não overdue", () => {
    const lastRunAt = new Date("2026-08-10T11:30:05.000Z");
    const now = new Date("2026-08-10T20:00:00.000Z");
    assert.equal(isTaskOverdue(dailySchedule, lastRunAt, now), false);
  });

  it("daily: último run foi ONTEM, hoje já passou do horário + grace -> overdue", () => {
    const lastRunAt = new Date("2026-08-09T11:30:00.000Z");
    const now = new Date("2026-08-10T13:00:00.000Z");
    assert.equal(isTaskOverdue(dailySchedule, lastRunAt, now), true);
  });

  it("interval: nunca rodou -> overdue", () => {
    assert.equal(isTaskOverdue({ kind: "interval", hours: 4 }, null, new Date()), true);
  });

  it("interval: rodou há 3h (dentro de 4h + grace) -> não overdue", () => {
    const now = new Date("2026-08-10T12:00:00.000Z");
    const lastRunAt = new Date("2026-08-10T09:00:00.000Z");
    assert.equal(isTaskOverdue({ kind: "interval", hours: 4 }, lastRunAt, now), false);
  });

  it("interval: rodou há 6h (excede 4h + 60min grace) -> overdue", () => {
    const now = new Date("2026-08-10T15:00:00.000Z");
    const lastRunAt = new Date("2026-08-10T09:00:00.000Z");
    assert.equal(isTaskOverdue({ kind: "interval", hours: 4 }, lastRunAt, now), true);
  });

  const monthlySchedule = { kind: "monthly" as const, day: 1, hour: 9, minute: 0 };

  it("monthly (#5128/#5130): rodou no dia 1 deste mês, dentro da janela -> não overdue", () => {
    const lastRunAt = new Date("2026-08-01T12:00:05.000Z");
    const now = new Date("2026-08-20T00:00:00.000Z");
    assert.equal(isTaskOverdue(monthlySchedule, lastRunAt, now), false);
  });

  it("monthly: último run foi no mês PASSADO, já passou do dia 1 deste mês + grace -> overdue", () => {
    const lastRunAt = new Date("2026-07-01T12:00:00.000Z");
    const now = new Date("2026-08-01T13:00:00.000Z"); // 1h depois da ocorrência de agosto
    assert.equal(isTaskOverdue(monthlySchedule, lastRunAt, now), true);
  });

  it("monthly: nunca rodou -> overdue assim que o grace do mês corrente passa", () => {
    const now = new Date("2026-08-01T13:00:00.000Z");
    assert.equal(isTaskOverdue(monthlySchedule, null, now), true);
  });
});
