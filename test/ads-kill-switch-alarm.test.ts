/**
 * test/ads-kill-switch-alarm.test.ts (#5239, DI migrada pro portão
 * notifyEditor em #7960)
 *
 * I/O de `scripts/ads-kill-switch-alarm.ts::main` — todas as dependências
 * reais (notificação ao editor, executor de pausa, gravação do log de
 * eventos) são INJETADAS via `AdsKillSwitchAlarmDeps`, então este teste
 * NUNCA toca rede, `gh` nem `data/` real. `notify` substitui o antigo
 * `sendEmail` (que chamava `sendGmailMessage` direto) — a decisão de
 * mandar e-mail (vs. só abrir/atualizar issue) agora é do PORTÃO
 * (`scripts/lib/editor-notify.ts`), testado à parte em
 * `test/editor-notify.test.ts`; aqui só verificamos que `main` invoca
 * `notify` com o finding certo, na hora certa (respeitando os fail-softs e
 * `--dry-run`), e reage corretamente ao `NotifyEditorResult` devolvido.
 * Cobre o critério de pronto da issue: alarme sempre que há achado (pausado
 * ou não), pausa só com as DUAS travas (toggle + `--execute-pause`),
 * `--dry-run` nunca escreve nada, e o executor default nunca é chamado sem
 * a dupla trava.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type AdsKillSwitchAlarmDeps } from "../scripts/ads-kill-switch-alarm.ts";
import { buildAdsTestRunState } from "../scripts/lib/ads-test-run-state.ts";
import { notWiredPauseExecutor, DEFAULT_KILL_SWITCH_GUARDRAILS } from "../scripts/lib/ads-kill-switch.ts";
import type { NotifyEditorFinding, NotifyEditorResult } from "../scripts/lib/editor-notify.ts";

const HEADER = "canal,data_apuracao,gasto_acumulado,leitores_acumulado\n";

/** `NotifyEditorResult` "de sucesso, e-mail enviado" — o formato que a
 *  maioria dos testes injeta como resposta padrão do `notify` mockado. */
function fakeNotifyResult(overrides: Partial<NotifyEditorResult> = {}): NotifyEditorResult {
  return {
    severity: "urgente",
    emailPolicy: "legacy",
    issue: { action: "created", issueNumber: 1, url: "https://github.com/x/y/issues/1" },
    emailSent: true,
    ...overrides,
  };
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ads-kill-switch-alarm-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseDeps(dir: string, overrides: Partial<AdsKillSwitchAlarmDeps> = {}): Partial<AdsKillSwitchAlarmDeps> {
  return {
    runStatePath: join(dir, "run-state.json"),
    clicksCsvPath: join(dir, "clicks-2608.csv"),
    pauseEventsLogPath: join(dir, "pause-events.jsonl"),
    guardrails: DEFAULT_KILL_SWITCH_GUARDRAILS,
    now: () => new Date("2026-09-05T06:30:00.000Z"),
    isKillSwitchEnabled: () => false,
    pauseExecutor: notWiredPauseExecutor,
    notify: async () => fakeNotifyResult(),
    appendPauseEvent: () => {},
    execMode: () => "local",
    ...overrides,
  } satisfies Partial<AdsKillSwitchAlarmDeps>;
}

// Cenário base: 3 braços, D0=2026-08-26 (bem fora da janela de
// assentamento em 2026-09-04, "ontem" quando now=2026-09-05), Google
// degradado contra os dois irmãos.
function writeDegradedFixture(dir: string, runState: ReturnType<typeof buildAdsTestRunState>): void {
  writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
  const csv =
    HEADER +
    `${runState.bracos[0]},2026-09-04,1000,20\n` + // custoPorLeitor=50
    `${runState.bracos[1]},2026-09-04,400,20\n` + // custoPorLeitor=20
    `${runState.bracos[2]},2026-09-04,440,20\n`; // custoPorLeitor=22
  writeFileSync(join(dir, "clicks-2608.csv"), csv);
}

describe("#5239 — ads-kill-switch-alarm main (I/O): sem dado ainda → fail-soft, nada de I/O", () => {
  it("sem run-state.json → não notifica o editor", async () => {
    await withTmpDir(async (dir) => {
      const notifyCalls: NotifyEditorFinding[] = [];
      await main([], baseDeps(dir, { notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()) }));
      assert.equal(notifyCalls.length, 0);
    });
  });

  it("run-state existe, clicks-2608.csv ausente → não notifica o editor", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      const notifyCalls: NotifyEditorFinding[] = [];
      await main([], baseDeps(dir, { notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()) }));
      assert.equal(notifyCalls.length, 0);
    });
  });

  it("modo cloud (execMode) → aborta graciosamente, nunca tenta ler nada", async () => {
    await withTmpDir(async (dir) => {
      const notifyCalls: NotifyEditorFinding[] = [];
      await main(
        [],
        baseDeps(dir, {
          execMode: () => "cloud",
          notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()),
        }),
      );
      assert.equal(notifyCalls.length, 0);
    });
  });
});

describe("#5239 — ads-kill-switch-alarm main (I/O): alarme sempre, tenha pausado ou não", () => {
  it("degradação detectada, kill switch DESLIGADO (default) → notifica o editor (severidade urgente), NUNCA chama o executor de pausa", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeDegradedFixture(dir, runState);
      const notifyCalls: NotifyEditorFinding[] = [];
      const pauseCalls: string[] = [];
      const loggedEvents: unknown[] = [];

      await main(
        [],
        baseDeps(dir, {
          isKillSwitchEnabled: () => false,
          pauseExecutor: async (braco) => {
            pauseCalls.push(braco);
            return { ok: false, detail: "não deveria ter sido chamado" };
          },
          appendPauseEvent: (event) => loggedEvents.push(event),
          notify: async (f) => {
            notifyCalls.push(f);
            return fakeNotifyResult();
          },
        }),
      );

      assert.equal(notifyCalls.length, 1, "notifica o editor sempre que há achado — checklist #5239");
      assert.equal(notifyCalls[0].severity, "urgente");
      assert.equal(notifyCalls[0].check, "ads-kill-switch");
      assert.ok(notifyCalls[0].fingerprint.includes(runState.bracos[0]));
      assert.match(notifyCalls[0].subject, /degradação detectada/);
      assert.equal(pauseCalls.length, 0, "kill switch desligado NUNCA chama o executor, mesmo achado disparado");
      assert.equal(loggedEvents.length, 1, "registra o evento de PAUSA PULADA — log auditável mesmo sem executar");
      assert.equal((loggedEvents[0] as { executionAttempted: boolean }).executionAttempted, false);
    });
  });

  it("degradação detectada, kill switch LIGADO mas SEM --execute-pause → ainda NÃO tenta pausa (2ª trava por invocação)", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeDegradedFixture(dir, runState);
      const pauseCalls: string[] = [];

      await main(
        [], // sem --execute-pause
        baseDeps(dir, {
          isKillSwitchEnabled: () => true,
          pauseExecutor: async (braco) => {
            pauseCalls.push(braco);
            return { ok: false, detail: "x" };
          },
        }),
      );

      assert.equal(pauseCalls.length, 0, "toggle ligado sozinho não basta — precisa da flag --execute-pause também");
    });
  });

  it("degradação detectada, kill switch LIGADO + --execute-pause → chama o executor (o default NUNCA toca API real) e loga o evento", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeDegradedFixture(dir, runState);
      const pauseCalls: string[] = [];
      const loggedEvents: unknown[] = [];

      await main(
        ["--execute-pause"],
        baseDeps(dir, {
          isKillSwitchEnabled: () => true,
          pauseExecutor: async (braco, ev) => {
            pauseCalls.push(braco);
            assert.equal(ev.triggered, true);
            return { ok: false, detail: "sempre false por design — sem executor real conectado" };
          },
          appendPauseEvent: (event) => loggedEvents.push(event),
        }),
      );

      assert.equal(pauseCalls.length, 1);
      assert.equal(pauseCalls[0], runState.bracos[0]);
      assert.equal(loggedEvents.length, 1);
      const event = loggedEvents[0] as { executionAttempted: boolean; executionOk: boolean | null };
      assert.equal(event.executionAttempted, true);
      assert.equal(event.executionOk, false, "evento registra o resultado REAL do executor — nunca fabrica sucesso");
    });
  });

  it("sem degradação (custos parelhos) → nenhuma notificação, nenhum evento de pausa", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      const csv =
        HEADER +
        `${runState.bracos[0]},2026-09-04,400,20\n` +
        `${runState.bracos[1]},2026-09-04,420,20\n` +
        `${runState.bracos[2]},2026-09-04,440,20\n`;
      writeFileSync(join(dir, "clicks-2608.csv"), csv);
      const notifyCalls: unknown[] = [];
      const loggedEvents: unknown[] = [];

      await main(
        [],
        baseDeps(dir, {
          notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()),
          appendPauseEvent: (event) => loggedEvents.push(event),
        }),
      );

      assert.equal(notifyCalls.length, 0);
      assert.equal(loggedEvents.length, 0);
    });
  });

  it("portão devolve emailSent=false (política suprimiu o e-mail) → main não trata como erro, só loga a issue", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeDegradedFixture(dir, runState);

      // Não deve lançar nem sinalizar exitCode de erro quando o portão
      // decide não mandar e-mail (ex: urgent_only + issue reused).
      await main(
        [],
        baseDeps(dir, {
          notify: async () => fakeNotifyResult({ emailSent: false, issue: { action: "reused", issueNumber: 3, url: "x" } }),
        }),
      );
      assert.notEqual(process.exitCode, 1);
    });
  });
});

describe("#5239 — ads-kill-switch-alarm main (I/O): --dry-run nunca grava nem notifica", () => {
  it("degradação detectada + kill switch ligado + --execute-pause + --dry-run → NÃO chama executor, NÃO grava log, NÃO notifica o editor", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeDegradedFixture(dir, runState);
      const pauseCalls: string[] = [];
      const loggedEvents: unknown[] = [];
      const notifyCalls: unknown[] = [];

      await main(
        ["--dry-run", "--execute-pause"],
        baseDeps(dir, {
          isKillSwitchEnabled: () => true,
          pauseExecutor: async (braco) => {
            pauseCalls.push(braco);
            return { ok: false, detail: "x" };
          },
          appendPauseEvent: (event) => loggedEvents.push(event),
          notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()),
        }),
      );

      assert.equal(pauseCalls.length, 0, "--dry-run nunca chama o executor de verdade");
      assert.equal(loggedEvents.length, 0, "--dry-run nunca grava o log de eventos");
      assert.equal(notifyCalls.length, 0, "--dry-run nunca notifica o editor de verdade");
    });
  });
});

describe("#5239 — ads-kill-switch-alarm main (I/O): guardrails de entrada respeitados de ponta a ponta", () => {
  it("braço recém-lançado (dentro da janela de assentamento) nunca dispara, mesmo com custo altíssimo", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-09-04", "2026-09-04T09:00:00.000Z"); // D0 = ontem
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      const csv =
        HEADER +
        `${runState.bracos[0]},2026-09-04,10000,20\n` + // custo altíssimo, mas dentro da janela de assentamento
        `${runState.bracos[1]},2026-09-04,400,20\n` +
        `${runState.bracos[2]},2026-09-04,440,20\n`;
      writeFileSync(join(dir, "clicks-2608.csv"), csv);
      const notifyCalls: unknown[] = [];

      await main([], baseDeps(dir, { notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()) }));

      assert.equal(notifyCalls.length, 0, "janela de assentamento (minDaysSinceD0) protege contra falso-positivo de custo inicial");
    });
  });

  it("--as-of-date permite reprocessar/testar uma data específica em vez de 'ontem'", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      const csv =
        HEADER +
        `${runState.bracos[0]},2026-09-02,1000,20\n` +
        `${runState.bracos[1]},2026-09-02,400,20\n` +
        `${runState.bracos[2]},2026-09-02,440,20\n`;
      writeFileSync(join(dir, "clicks-2608.csv"), csv);
      const notifyCalls: unknown[] = [];

      await main(
        ["--as-of-date", "2026-09-02"],
        baseDeps(dir, {
          now: () => new Date("2026-09-10T06:30:00.000Z"), // "ontem" seria 09-09, sem dado — --as-of-date corrige
          notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()),
        }),
      );

      assert.equal(notifyCalls.length, 1);
    });
  });
});

describe("#5239 — ads-kill-switch-alarm main (I/O): log de pausa nunca chama nada real quando não injetado", () => {
  it("com o executor REAL (notWiredPauseExecutor) e as duas travas ligadas → resultado sempre ok:false, nunca lança", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeDegradedFixture(dir, runState);
      const loggedEvents: Array<{ executionOk: boolean | null; executionDetail: string | null }> = [];

      await main(
        ["--execute-pause"],
        baseDeps(dir, {
          isKillSwitchEnabled: () => true,
          // pauseExecutor NÃO sobrescrito — usa o default injetado por baseDeps (notWiredPauseExecutor)
          appendPauseEvent: (event) => loggedEvents.push(event as never),
        }),
      );

      assert.equal(loggedEvents.length, 1);
      assert.equal(loggedEvents[0].executionOk, false);
      assert.match(loggedEvents[0].executionDetail ?? "", /ação manual/);
    });
  });
});

describe("#5239 — ads-kill-switch-alarm main (I/O): appendPauseEvent REAL grava JSONL append-only", () => {
  it("sem sobrescrever appendPauseEvent (usa o default real do módulo) grava 1 linha JSON válida por evento", async () => {
    // Deliberadamente NÃO usa baseDeps() aqui — baseDeps sempre injeta um
    // appendPauseEvent stub; para exercitar o default REAL do módulo
    // (realAppendPauseEvent), a chave precisa estar AUSENTE do objeto de
    // overrides (uma chave presente com valor `undefined` sobrescreveria o
    // default com `undefined` no spread de `main`, quebrando a chamada).
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeDegradedFixture(dir, runState);
      const logPath = join(dir, "nested", "pause-events.jsonl");

      await main(["--execute-pause"], {
        runStatePath: join(dir, "run-state.json"),
        clicksCsvPath: join(dir, "clicks-2608.csv"),
        pauseEventsLogPath: logPath,
        guardrails: DEFAULT_KILL_SWITCH_GUARDRAILS,
        now: () => new Date("2026-09-05T06:30:00.000Z"),
        isKillSwitchEnabled: () => true,
        pauseExecutor: notWiredPauseExecutor,
        notify: async () => fakeNotifyResult(),
        execMode: () => "local",
        // appendPauseEvent OMITIDO de propósito — usa realAppendPauseEvent.
      });

      assert.ok(existsSync(logPath));
      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      const parsed = JSON.parse(lines[0]);
      assert.equal(parsed.braco, runState.bracos[0]);
    });
  });
});
