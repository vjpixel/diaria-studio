/**
 * test/ads-test-watch-main.test.ts (#5845, DI migrada pro portão
 * notifyEditor em #7960)
 *
 * I/O de `scripts/ads-test-watch.ts::main` — todas as dependências reais
 * (notificação ao editor, gh, build-origem-map/cac-report, checagem de
 * snapshot) são INJETADAS via `AdsTestWatchDeps`, então este teste nunca
 * toca rede, `gh`, nem `data/` real. `notify` substitui o antigo
 * `sendEmail` (que chamava `sendGmailMessage` direto) — a decisão de
 * mandar e-mail (vs. só abrir/atualizar issue) agora é do PORTÃO
 * (`scripts/lib/editor-notify.ts`), testado à parte; aqui só verificamos
 * que `main` invoca `notify` com o finding certo, na hora certa. Cobre o
 * critério de pronto: "apuração roda os 2 comandos na ordem e recusa
 * snapshot inutilizável".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  main,
  DEFAULT_PLANNED_D0,
  realResolveBrevoTaskEnabled,
  BREVO_DIARIA_TASK_NAME,
  loadApuracaoCohortGuard,
  realIsStoreFresh,
  type AdsTestWatchDeps,
} from "../scripts/ads-test-watch.ts";
import type { CacReport } from "../scripts/lib/cac.ts";
import { buildAdsTestRunState } from "../scripts/lib/ads-test-run-state.ts";
import { unitBaseName } from "../scripts/lib/systemd-units.ts";
import type { QueryUnitStateResult } from "../scripts/lib/systemd-unit-state.ts";
import { planAdsTestWatchActions, emptyAdsTestWatchState } from "../scripts/lib/ads-test-watch.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";
import type { NotifyEditorFinding, NotifyEditorResult } from "../scripts/lib/editor-notify.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "ads-test-watch-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseDeps(dir: string, overrides: Partial<AdsTestWatchDeps> = {}): Partial<AdsTestWatchDeps> {
  const calls: string[] = [];
  return {
    runStatePath: join(dir, "run-state.json"),
    watchStatePath: join(dir, "watch-state.json"),
    clicksCsvPath: join(dir, "clicks-2608.csv"),
    plannedD0: DEFAULT_PLANNED_D0,
    plannedDailyBudgetBRL: 100,
    now: () => new Date("2026-08-26T06:30:00.000Z"),
    notify: async () => fakeNotifyResult(),
    runBuildOrigemMap: () => {
      calls.push("origem");
      return true;
    },
    runCacReport: async () => {
      calls.push("cac");
      return { ok: true, zeroCadastrosArms: [] };
    },
    isStoreFresh: () => ({ usable: true, reason: null }),
    commentOnReligarBrevoIssue: () => ({ status: 0, stdout: "", stderr: "" }),
    execMode: () => "local",
    // #8853 — default do teste simula a task AINDA desarmada (o cenário
    // legado, pré-#8853, onde o alarme sempre dispara); os testes dedicados
    // de #8853 abaixo sobrescrevem para `true`/`null`.
    resolveBrevoTaskEnabled: () => false,
    ...overrides,
  } satisfies Partial<AdsTestWatchDeps>;
}

describe("#5845 — ads-test-watch main (I/O): apuração", () => {
  it("#8238 — store DESATUALIZADO → NÃO roda build-origem-map nem cac-report, alarma, watch-state intacto", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      // Religamento já disparado numa run anterior — isola este teste na
      // ação de apuração (senão D+21 também dispara no mesmo dia, já que
      // apuracao_snapshot > religar_brevo sempre).
      writeFileSync(
        join(dir, "watch-state.json"),
        JSON.stringify({ religarBrevoTriggeredAt: "2026-09-16T06:30:00.000Z", apuracaoCompletedAt: null, apuracaoReportPath: null }),
      );
      const notifyCalls: NotifyEditorFinding[] = [];
      const origemCalls: string[] = [];
      const cacCalls: string[] = [];

      await main(
        [],
        baseDeps(dir, {
          now: () => new Date(runState.apuracao_snapshot + "T06:30:00.000Z"),
          isStoreFresh: () => ({ usable: false, reason: "última ingestão do Kit no store foi há 50h" }),
          runBuildOrigemMap: () => {
            origemCalls.push("origem");
            return true;
          },
          runCacReport: async () => {
            cacCalls.push("cac");
            return { ok: true, zeroCadastrosArms: [] };
          },
          notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()),
        }),
      );

      assert.equal(origemCalls.length, 0, "build-origem-map NUNCA deve rodar sobre store desatualizado");
      assert.equal(cacCalls.length, 0, "cac-report NUNCA deve rodar sobre store desatualizado");
      assert.equal(notifyCalls.length, 1);
      assert.equal(notifyCalls[0].severity, "urgente");
      assert.match(notifyCalls[0].subject, /NÃO rodou — store desatualizado/);
      const watchState = JSON.parse(readFileSync(join(dir, "watch-state.json"), "utf8"));
      assert.equal(watchState.apuracaoCompletedAt, null, "watch-state não deve marcar apuração como completa");
    });
  });

  it("snapshot utilizável → build-origem-map roda ANTES de cac-report, sempre nessa ordem, e marca apuração completa", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      writeFileSync(
        join(dir, "watch-state.json"),
        JSON.stringify({ religarBrevoTriggeredAt: "2026-09-16T06:30:00.000Z", apuracaoCompletedAt: null, apuracaoReportPath: null }),
      );
      const callOrder: string[] = [];
      const notifyCalls: NotifyEditorFinding[] = [];

      await main(
        [],
        baseDeps(dir, {
          now: () => new Date(runState.apuracao_snapshot + "T06:30:00.000Z"),
          runBuildOrigemMap: () => {
            callOrder.push("origem");
            return true;
          },
          runCacReport: async () => {
            callOrder.push("cac");
            return { ok: true, zeroCadastrosArms: [] };
          },
          notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()),
        }),
      );

      assert.deepEqual(callOrder, ["origem", "cac"], "build-origem-map SEMPRE imediatamente antes de cac-report (§7.2)");
      assert.equal(notifyCalls.length, 1);
      assert.match(notifyCalls[0].subject, /apuração congelada rodou/);

      const watchState = JSON.parse(readFileSync(join(dir, "watch-state.json"), "utf8"));
      assert.ok(watchState.apuracaoCompletedAt);
      // #8238: realCacReport sempre roda com --fonte store — o id do
      // relatório carrega o sufixo "--store" (cacReportSnapshotId).
      assert.equal(watchState.apuracaoReportPath, `data/aquisicao/cac-reports/cac-${runState.apuracao_snapshot}--store.md`);
    });
  });

  it("#8238 — TODOS os braços com 0 cadastros → NÃO marca completa, alarma em vez de 'sucesso' (fonte de dados provavelmente errada)", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      writeFileSync(
        join(dir, "watch-state.json"),
        JSON.stringify({ religarBrevoTriggeredAt: "2026-09-16T06:30:00.000Z", apuracaoCompletedAt: null, apuracaoReportPath: null }),
      );
      const notifyCalls: NotifyEditorFinding[] = [];

      await main(
        [],
        baseDeps(dir, {
          now: () => new Date(runState.apuracao_snapshot + "T06:30:00.000Z"),
          runBuildOrigemMap: () => true,
          // Simula exatamente o defeito do #8238: cac-report.ts "rodou com
          // sucesso" (ok: true) mas os 3 braços saíram com 0 cadastros —
          // sinal de coorte na fonte errada, não de teste sem tração.
          runCacReport: async (_snapshotDate, bracos) => ({ ok: true, zeroCadastrosArms: bracos }),
          notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()),
        }),
      );

      assert.equal(notifyCalls.length, 1, "deveria alarmar 1x (zero-cadastros), nunca o e-mail de sucesso");
      assert.match(notifyCalls[0].subject, /0 cadastros/);
      assert.match(notifyCalls[0].subject, /NÃO congelada/);
      assert.doesNotMatch(notifyCalls[0].subject, /apuração congelada rodou/);

      const watchState = JSON.parse(readFileSync(join(dir, "watch-state.json"), "utf8"));
      assert.equal(watchState.apuracaoCompletedAt, null, "guard de zero-cadastros nunca marca a apuração como concluída");
      assert.equal(watchState.apuracaoReportPath, null);
    });
  });

  it("#8238 — só 1 dos 3 braços com 0 cadastros (sinal parcial, não os 3) → segue o caminho de SUCESSO normal", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      writeFileSync(
        join(dir, "watch-state.json"),
        JSON.stringify({ religarBrevoTriggeredAt: "2026-09-16T06:30:00.000Z", apuracaoCompletedAt: null, apuracaoReportPath: null }),
      );
      const notifyCalls: NotifyEditorFinding[] = [];

      await main(
        [],
        baseDeps(dir, {
          now: () => new Date(runState.apuracao_snapshot + "T06:30:00.000Z"),
          runBuildOrigemMap: () => true,
          runCacReport: async (_snapshotDate, bracos) => ({ ok: true, zeroCadastrosArms: [bracos[0]] }),
          notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()),
        }),
      );

      assert.equal(notifyCalls.length, 1);
      assert.match(notifyCalls[0].subject, /apuração congelada rodou/, "guard só dispara com TODOS os braços zerados");

      const watchState = JSON.parse(readFileSync(join(dir, "watch-state.json"), "utf8"));
      assert.ok(watchState.apuracaoCompletedAt);
    });
  });

  it("#8238 (5a/5b) — guard de coorte com problema → NÃO marca completa, alarma 'coorte suspeita', nunca o e-mail de sucesso", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      writeFileSync(
        join(dir, "watch-state.json"),
        JSON.stringify({ religarBrevoTriggeredAt: "2026-09-16T06:30:00.000Z", apuracaoCompletedAt: null, apuracaoReportPath: null }),
      );
      const notifyCalls: NotifyEditorFinding[] = [];

      await main(
        [],
        baseDeps(dir, {
          now: () => new Date(runState.apuracao_snapshot + "T06:30:00.000Z"),
          runBuildOrigemMap: () => true,
          runCacReport: async () => ({
            ok: true,
            zeroCadastrosArms: [],
            cohortProblems: ["Cobertura de entrega da coorte: só 1 de 203 ativos (0.5%) têm >=1 entrega ligada no store"],
            coverageLines: ["Cobertura da coorte no store (Emenda 17/09, #8249 item 5):"],
          }),
          notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()),
        }),
      );

      assert.equal(notifyCalls.length, 1);
      assert.match(notifyCalls[0].subject, /coorte suspeita/);
      assert.match(notifyCalls[0].body, /só 1 de 203 ativos/);
      assert.doesNotMatch(notifyCalls[0].subject, /apuração congelada rodou/);
      const watchState = JSON.parse(readFileSync(join(dir, "watch-state.json"), "utf8"));
      assert.equal(watchState.apuracaoCompletedAt, null, "guard de coorte nunca marca a apuração como concluída");
    });
  });

  it("#8238 — sucesso leva as linhas de cobertura da coorte (fração >=20 recebidas, Emenda 17/09) no corpo do e-mail", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      writeFileSync(
        join(dir, "watch-state.json"),
        JSON.stringify({ religarBrevoTriggeredAt: "2026-09-16T06:30:00.000Z", apuracaoCompletedAt: null, apuracaoReportPath: null }),
      );
      const notifyCalls: NotifyEditorFinding[] = [];

      await main(
        [],
        baseDeps(dir, {
          now: () => new Date(runState.apuracao_snapshot + "T06:30:00.000Z"),
          runBuildOrigemMap: () => true,
          runCacReport: async () => ({
            ok: true,
            zeroCadastrosArms: [],
            cohortProblems: [],
            coverageLines: ["- Total: 203 ativo(s), 97.0% com >=1 entrega, 88.2% com >=20 recebidas"],
          }),
          notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()),
        }),
      );

      assert.equal(notifyCalls.length, 1);
      assert.match(notifyCalls[0].subject, /apuração congelada rodou/);
      assert.match(notifyCalls[0].body, /88\.2% com >=20 recebidas/);
      const watchState = JSON.parse(readFileSync(join(dir, "watch-state.json"), "utf8"));
      assert.ok(watchState.apuracaoCompletedAt);
    });
  });

  it("#8238 — main() AGUARDA runCacReport (bug do await faltante): resolver a Promise depois de main() já ter decidido não teria efeito nenhum se o await estivesse ausente", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      writeFileSync(
        join(dir, "watch-state.json"),
        JSON.stringify({ religarBrevoTriggeredAt: "2026-09-16T06:30:00.000Z", apuracaoCompletedAt: null, apuracaoReportPath: null }),
      );
      const notifyCalls: NotifyEditorFinding[] = [];
      let resolveCac: (v: { ok: boolean; zeroCadastrosArms: readonly string[] }) => void;
      const cacPromise = new Promise<{ ok: boolean; zeroCadastrosArms: readonly string[] }>((resolve) => {
        resolveCac = resolve;
      });

      const mainPromise = main(
        [],
        baseDeps(dir, {
          now: () => new Date(runState.apuracao_snapshot + "T06:30:00.000Z"),
          runBuildOrigemMap: () => true,
          // Resolve só depois de um `setTimeout` — se `main()` não desse
          // `await` nesta chamada (o bug original), ele já teria decidido
          // "sucesso" com um valor `undefined`/incompleto antes daqui.
          runCacReport: () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ ok: true, zeroCadastrosArms: [] }), 10);
            }),
          notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()),
        }),
      );

      await mainPromise;

      assert.equal(notifyCalls.length, 1, "main() deveria ter esperado a Promise de runCacReport resolver antes de agir");
      assert.match(notifyCalls[0].subject, /apuração congelada rodou/);
      const watchState = JSON.parse(readFileSync(join(dir, "watch-state.json"), "utf8"));
      assert.ok(watchState.apuracaoCompletedAt, "apuração completa só é marcada depois do await resolver");
    });
  });

  it("apuração JÁ completada (idempotência) → não roda de novo mesmo se invocado outra vez no mesmo dia", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      writeFileSync(
        join(dir, "watch-state.json"),
        JSON.stringify({
          religarBrevoTriggeredAt: null,
          apuracaoCompletedAt: "2026-10-11T06:30:00.000Z",
          apuracaoReportPath: "data/aquisicao/cac-reports/cac-2026-10-11.md",
        }),
      );
      const callOrder: string[] = [];

      await main(
        [],
        baseDeps(dir, {
          now: () => new Date(runState.apuracao_snapshot + "T06:30:00.000Z"),
          runBuildOrigemMap: () => {
            callOrder.push("origem");
            return true;
          },
          runCacReport: async () => {
            callOrder.push("cac");
            return { ok: true, zeroCadastrosArms: [] };
          },
        }),
      );

      assert.deepEqual(callOrder, [], "apuração já feita não deve rodar de novo — re-rodar sobrescreveria o relatório congelado");
    });
  });
});

describe("#5845 — ads-test-watch main (I/O): religar-brevo", () => {
  it("D+21 chegou → comenta em #5838 e marca disparado (idempotente depois)", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      const ghCalls: string[] = [];

      await main(
        [],
        baseDeps(dir, {
          now: () => new Date(runState.religar_brevo + "T06:30:00.000Z"),
          commentOnReligarBrevoIssue: (body) => {
            ghCalls.push(body);
            return { status: 0, stdout: "", stderr: "" };
          },
        }),
      );

      assert.equal(ghCalls.length, 1);
      assert.match(ghCalls[0], /D\+21/);
      const watchState = JSON.parse(readFileSync(join(dir, "watch-state.json"), "utf8"));
      assert.ok(watchState.religarBrevoTriggeredAt);
    });
  });

  // #8853 — o alarme não pode disparar (nem comentar em #5838) quando a task
  // já está `enabled: true` de verdade: caso real do #8851, onde a task
  // estava religada desde 21/08 (#5838) e o alarme mandou "reverter
  // `enabled: false`" sem que isso existisse mais.
  it("#8853 — task JÁ enabled:true → sem alarme, sem comentário, cursor marcado direto", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      const ghCalls: string[] = [];
      const notifyCalls: string[] = [];

      await main(
        [],
        baseDeps(dir, {
          now: () => new Date(runState.religar_brevo + "T06:30:00.000Z"),
          resolveBrevoTaskEnabled: () => true,
          commentOnReligarBrevoIssue: (body) => {
            ghCalls.push(body);
            return { status: 0, stdout: "", stderr: "" };
          },
          notify: async (finding) => {
            notifyCalls.push(finding.check);
            return fakeNotifyResult();
          },
        }),
      );

      assert.equal(ghCalls.length, 0, "não deve comentar em #5838 — já religada, nada a fazer");
      assert.ok(!notifyCalls.includes("ads-test-watch-religar-brevo"), "não deve alarmar — já religada");
      const watchState = JSON.parse(readFileSync(join(dir, "watch-state.json"), "utf8"));
      assert.ok(watchState.religarBrevoTriggeredAt, "cursor deve avançar mesmo sem alarme, pra não reavaliar todo dia");
    });
  });

  it("#8853 — task enabled:false (desarmada de propósito) → alarme dispara normalmente", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      const ghCalls: string[] = [];

      await main(
        [],
        baseDeps(dir, {
          now: () => new Date(runState.religar_brevo + "T06:30:00.000Z"),
          resolveBrevoTaskEnabled: () => false,
          commentOnReligarBrevoIssue: (body) => {
            ghCalls.push(body);
            return { status: 0, stdout: "", stderr: "" };
          },
        }),
      );

      assert.equal(ghCalls.length, 1, "task realmente desarmada — o alarme continua útil");
      const watchState = JSON.parse(readFileSync(join(dir, "watch-state.json"), "utf8"));
      assert.ok(watchState.religarBrevoTriggeredAt);
    });
  });

  it("#8853 — estado indeterminado (task não encontrada no registro) → fail-safe, alarme dispara", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      const ghCalls: string[] = [];

      await main(
        [],
        baseDeps(dir, {
          now: () => new Date(runState.religar_brevo + "T06:30:00.000Z"),
          resolveBrevoTaskEnabled: () => null,
          commentOnReligarBrevoIssue: (body) => {
            ghCalls.push(body);
            return { status: 0, stdout: "", stderr: "" };
          },
        }),
      );

      assert.equal(ghCalls.length, 1, "indeterminado é fail-safe pro lado de alarmar, nunca de silenciar");
    });
  });

  // #8855 — regressão do achado: `realResolveBrevoTaskEnabled` não pode
  // confiar só no flag DECLARADO `enabled` do registro (scheduled-tasks.ts)
  // pra concluir que a task está religada — precisa confirmar contra o
  // timer systemd REAL. Cenário do #8855: registro `enabled: true` (a task
  // FOI religada em algum momento) mas o timer foi desarmado no `300`
  // (`systemctl --user disable`) sem que ninguém tocasse o registro.
  describe("#8855 — realResolveBrevoTaskEnabled confirma contra o timer systemd real, não só o flag do registro", () => {
    const registryTask = getScheduledTaskByName(BREVO_DIARIA_TASK_NAME);
    const timerUnit = `${unitBaseName(BREVO_DIARIA_TASK_NAME)}.timer`;

    it("precondição: o registro declara a task enabled (ausente ou true) nesta suíte", () => {
      // Se esta precondição falhar, o cenário abaixo deixou de exercitar o
      // caminho real do #8855 (registro enabled + timer inativo) — o teste
      // pararia de provar o que promete provar.
      assert.ok(registryTask, "Diaria-Brevo-Diaria-Evaluate precisa existir no registro");
      assert.notEqual(registryTask!.enabled, false, "registro precisa declarar enabled (não false) para este cenário");
    });

    it("registro enabled:true + timer systemd INATIVO -> false, nunca o atalho de 'já religada' (cenário real da issue)", () => {
      const inactiveState: QueryUnitStateResult = {
        state: { loadState: "loaded", activeState: "inactive" },
        error: null,
      };
      let queriedUnit: string | null = null;
      const result = realResolveBrevoTaskEnabled((unit) => {
        queriedUnit = unit;
        return inactiveState;
      });

      assert.equal(queriedUnit, timerUnit, "deve consultar o timer real da task, não outro unit");
      assert.notEqual(result, true, "timer inativo nunca pode resolver 'true' mesmo com enabled:true no registro");

      // O ponto de verificação da issue: alimentado de volta em
      // planAdsTestWatchActions, este resultado precisa manter o alarme de
      // religamento vivo — nunca tomar o atalho de idempotência silenciosa.
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      const plan = planAdsTestWatchActions(runState.religar_brevo, runState, DEFAULT_PLANNED_D0, emptyAdsTestWatchState(), result);
      assert.equal(plan.triggerReligarBrevo, true, "triggerReligarBrevo precisa continuar true — o achado do #8855 é exatamente ele virar false por engano");
    });

    it("registro enabled:true + timer systemd ATIVO -> true (religamento real confirmado)", () => {
      const activeState: QueryUnitStateResult = {
        state: { loadState: "loaded", activeState: "active" },
        error: null,
      };
      const result = realResolveBrevoTaskEnabled(() => activeState);
      assert.equal(result, true);
    });

    it("consulta ao timer real falha (SSH/systemctl indisponível) -> null indeterminado, nunca assume religada", () => {
      const failed: QueryUnitStateResult = { state: null, error: "systemctl indisponível (ENOENT) nesta consulta." };
      const result = realResolveBrevoTaskEnabled(() => failed);
      assert.equal(result, null, "estado indeterminado nunca pode virar 'true' por default");
    });
  });
});

describe("#8262 P1 (achado 2) — ads-test-watch main (I/O): fetchAutoSpend/resolveArmSpend/evalRows wiring dentro de main()", () => {
  it("#8240 item 3 — fonte automática COMPLEMENTA o CSV e empurra um braço pra condição de morte que o CSV sozinho não alcançaria", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      const braco = runState.bracos[0];
      const header = "canal,data_apuracao,gasto_acumulado,cliques,impressoes,cpc_medio,conversoes,custo_por_conversao,perda_orcamento,perda_ranking,fonte\n";
      // Baseline no CSV: 100 em 01/09. Sozinho, contra o planejado até essa
      // data (10 dias × R$100 = R$1.000, limiar de morte R$2.000), não
      // dispara nada — é a fonte automática dos dias 02-04/09 (R$700/dia,
      // #8240 item 3) que empurra o acumulado pra R$2.200 e cruza o limiar.
      const csv = header + runState.bracos.map((b) => `${b},2026-09-01,100,,,,,,,,\n`).join("");
      writeFileSync(join(dir, "clicks-2608.csv"), csv);

      const fetchCalls: string[] = [];
      const notifyCalls: NotifyEditorFinding[] = [];

      await main(
        [],
        baseDeps(dir, {
          now: () => new Date("2026-09-05T06:30:00.000Z"), // dentro da janela, "ontem" = 04/09
          fetchAutoSpend: async () => {
            fetchCalls.push("fetch");
            const perDay = new Map<string, number>([
              ["2026-09-02", 700],
              ["2026-09-03", 700],
              ["2026-09-04", 700],
            ]);
            return new Map([[braco, perDay]]);
          },
          notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()),
        }),
      );

      assert.equal(fetchCalls.length, 1, "deps.fetchAutoSpend() deveria ter sido chamado exatamente 1x");
      const deathFinding = notifyCalls.find((f) => /condição de morte disparada/.test(f.subject));
      assert.ok(deathFinding, "o gasto complementado pela fonte automática deveria disparar a condição de morte");
      assert.match(deathFinding!.body, new RegExp(braco.replace(/[()]/g, "\\$&")));
      assert.match(deathFinding!.body, /R\$ 2200[.,]00/, "gasto acumulado deveria ser 100 (CSV) + 700×3 (automático) = 2200");
    });
  });

  it("#8240 item 4 — aviso (1,25x-2x) e projeção vão pro console (buildSpendWatchDigestSection), NUNCA notificação própria", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      const braco = runState.bracos[0];
      const header = "canal,data_apuracao,gasto_acumulado,cliques,impressoes,cpc_medio,conversoes,custo_por_conversao,perda_orcamento,perda_ranking,fonte\n";
      // Planejado até 01/09 (10 dias × R$100) = R$1.000. Gasto 1.400 -> razão
      // 1,4x: dentro da faixa de aviso (1,25x-2x), abaixo do limiar de morte.
      const csv = header + runState.bracos.map((b) => `${b},2026-09-01,1400,,,,,,,,\n`).join("");
      writeFileSync(join(dir, "clicks-2608.csv"), csv);

      const notifyCalls: NotifyEditorFinding[] = [];
      const logged: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
      try {
        await main(
          [],
          baseDeps(dir, {
            now: () => new Date("2026-09-02T06:30:00.000Z"),
            fetchAutoSpend: async () => new Map(),
            notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()),
          }),
        );
      } finally {
        console.log = originalLog;
      }

      assert.ok(
        !notifyCalls.some((f) => /morte|aviso/i.test(f.subject)),
        "aviso/projeção NUNCA deveriam gerar notificação própria (#8240 item 4)",
      );
      assert.ok(
        logged.some((l) => l.includes("avisos de gasto")),
        "a seção de aviso deveria aparecer no console (buildSpendWatchDigestSection), mesmo sem notificação",
      );
      assert.ok(logged.some((l) => l.includes(braco)), "console deveria nomear o braço no aviso");
    });
  });
});

describe("#5845 — ads-test-watch main (I/O): D0 ausente/reconciliação/guard de data/", () => {
  it("sem run-state.json, D0 planejado já passou → alarma, sem tentar ler clicks-2608.csv", async () => {
    await withTmpDir(async (dir) => {
      const notifyCalls: NotifyEditorFinding[] = [];
      await main(
        [],
        baseDeps(dir, {
          plannedD0: "2026-08-01",
          now: () => new Date("2026-08-05T06:30:00.000Z"),
          notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()),
        }),
      );
      assert.equal(notifyCalls.length, 1);
      assert.match(notifyCalls[0].subject, /D0 planejado/);
    });
  });

  it("dentro da janela, faltando linha de ontem para 1 braço → alarma cobertura", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      const header = "canal,data_apuracao,gasto_acumulado,cliques,impressoes,cpc_medio,conversoes,custo_por_conversao,perda_orcamento,perda_ranking,fonte\n";
      const csv =
        header +
        `${runState.bracos[0]},2026-08-27,150,,,,,,,,\n` +
        `${runState.bracos[1]},2026-08-27,10,,,,,,,,\n`; // falta o 3º braço
      writeFileSync(join(dir, "clicks-2608.csv"), csv);
      const notifyCalls: NotifyEditorFinding[] = [];

      await main(
        [],
        baseDeps(dir, {
          now: () => new Date("2026-08-28T06:30:00.000Z"), // checa ontem = 2026-08-27
          notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()),
        }),
      );

      const coverageFinding = notifyCalls.find((f) => /reconciliação de gasto faltando/.test(f.subject));
      assert.ok(coverageFinding, "deveria alarmar cobertura faltante");
      assert.match(coverageFinding!.body, new RegExp(runState.bracos[2].replace(/[()]/g, "\\$&")));
    });
  });
});

describe("#8432 — cursor de idempotência não avança quando notifyEditor falha", () => {
  it("religar-brevo: comentário postado + notify falha (issue action=failed) → cursor NÃO persistido, retry na próxima execução", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      // Pré-existe (nulo) pra distinguir "nunca escreveu" de "escreveu nulo" —
      // se main() persistisse incondicionalmente, este arquivo seria
      // reescrito com religarBrevoTriggeredAt preenchido.
      writeFileSync(
        join(dir, "watch-state.json"),
        JSON.stringify({ religarBrevoTriggeredAt: null, apuracaoCompletedAt: null, apuracaoReportPath: null }),
      );
      const ghCalls: string[] = [];

      await main(
        [],
        baseDeps(dir, {
          now: () => new Date(runState.religar_brevo + "T06:30:00.000Z"),
          commentOnReligarBrevoIssue: (body) => {
            ghCalls.push(body);
            return { status: 0, stdout: "", stderr: "" };
          },
          // Simula notifyEditor falhando completamente — ensureAlarmIssue não
          // conseguiu criar/atualizar a issue (gh indisponível, por exemplo).
          notify: async () => fakeNotifyResult({ issue: { issueNumber: null, url: null, action: "failed", error: "gh indisponível" }, emailSent: false }),
        }),
      );

      assert.equal(ghCalls.length, 1, "o comentário no #5838 ainda deve ser postado (side effect independente do cursor)");
      const watchState = JSON.parse(readFileSync(join(dir, "watch-state.json"), "utf8"));
      assert.equal(
        watchState.religarBrevoTriggeredAt,
        null,
        "cursor NÃO deve avançar quando a notificação não chegou ao editor — senão o alarme se perde pra sempre",
      );
    });
  });

  it("apuração: cac-report roda + notify falha (issue action=failed) → cursor NÃO persistido, relatório congelado é refeito na próxima execução", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      writeFileSync(
        join(dir, "watch-state.json"),
        JSON.stringify({ religarBrevoTriggeredAt: "2026-09-16T06:30:00.000Z", apuracaoCompletedAt: null, apuracaoReportPath: null }),
      );
      const callOrder: string[] = [];

      await main(
        [],
        baseDeps(dir, {
          now: () => new Date(runState.apuracao_snapshot + "T06:30:00.000Z"),
          runBuildOrigemMap: () => {
            callOrder.push("origem");
            return true;
          },
          runCacReport: async () => {
            callOrder.push("cac");
            return { ok: true, zeroCadastrosArms: [] };
          },
          notify: async () => fakeNotifyResult({ issue: { issueNumber: null, url: null, action: "failed", error: "gh indisponível" }, emailSent: false }),
        }),
      );

      assert.deepEqual(callOrder, ["origem", "cac"], "os 2 comandos ainda devem rodar (side effect independente do cursor)");
      const watchState = JSON.parse(readFileSync(join(dir, "watch-state.json"), "utf8"));
      assert.equal(
        watchState.apuracaoCompletedAt,
        null,
        "cursor NÃO deve avançar quando a notificação não chegou ao editor — senão o alarme se perde pra sempre",
      );
    });
  });

  it("religar-brevo: notify tem sucesso (issue reused, e-mail suprimido pela política) → cursor persiste normalmente", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));

      await main(
        [],
        baseDeps(dir, {
          now: () => new Date(runState.religar_brevo + "T06:30:00.000Z"),
          commentOnReligarBrevoIssue: () => ({ status: 0, stdout: "", stderr: "" }),
          // Issue já existia (reused) e a política suprimiu o e-mail de
          // propósito — isso conta como "chegou ao editor" (a issue já era
          // conhecida), não como falha.
          notify: async () => fakeNotifyResult({ issue: { action: "reused", issueNumber: 5838, url: "x" }, emailSent: false }),
        }),
      );

      const watchState = JSON.parse(readFileSync(join(dir, "watch-state.json"), "utf8"));
      assert.ok(watchState.religarBrevoTriggeredAt, "cursor deve persistir quando o achado foi tratado com sucesso pelo gh, mesmo sem e-mail");
    });
  });
});

describe("#7960 — ads-test-watch main (I/O): --dry-run nunca notifica o editor", () => {
  it("D0 vencido + --dry-run → NÃO chama notify, watch-state intacto", async () => {
    await withTmpDir(async (dir) => {
      const notifyCalls: unknown[] = [];
      await main(
        ["--dry-run"],
        baseDeps(dir, {
          plannedD0: "2026-08-01",
          now: () => new Date("2026-08-05T06:30:00.000Z"),
          notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()),
        }),
      );
      assert.equal(notifyCalls.length, 0, "--dry-run nunca notifica o editor de verdade");
    });
  });

  it("portão devolve emailSent=false (política suprimiu o e-mail) → main não trata como erro", async () => {
    await withTmpDir(async (dir) => {
      await main(
        [],
        baseDeps(dir, {
          plannedD0: "2026-08-01",
          now: () => new Date("2026-08-05T06:30:00.000Z"),
          notify: async () => fakeNotifyResult({ emailSent: false, issue: { action: "reused", issueNumber: 3, url: "x" } }),
        }),
      );
      assert.notEqual(process.exitCode, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// #8238 (resíduo do #8481) — guard de coorte e gate de frescor sobre um
// store REAL em arquivo temporário (nunca o `data/` de produção).
// ---------------------------------------------------------------------------

describe("#8238 — loadApuracaoCohortGuard / realIsStoreFresh sobre store fixture", () => {
  const NOW = "2026-10-25T06:30:00.000Z";
  const GOOGLE = "Google Ads (teste 2608)";

  async function seedStore(dir: string, opts: { linkDelivered: boolean; kitUpdatedAt?: string }): Promise<string> {
    const { openDiariaSubscribersDb, ensureSubscriber, upsertSubscription, recordEvent } = await import(
      "../scripts/lib/diaria-subscribers-db.ts"
    );
    const storePath = join(dir, "diaria-subscribers.db");
    const db = openDiariaSubscribersDb(storePath);
    const updatedAt = opts.kitUpdatedAt ?? NOW;
    for (let i = 0; i < 4; i++) {
      const id = ensureSubscriber(db, "kit", `kit-${i}`, `leitor${i}@example.com`, "2026-09-10T00:00:00.000Z");
      upsertSubscription(
        db,
        id,
        "kit",
        { status: "active", enteredAt: "2026-09-10T00:00:00.000Z", exitedAt: null, source: "kit", utmSource: "google-ads" },
        updatedAt,
      );
      // Identidade partida (#8236): a entrega existe, mas ligada a OUTRO
      // subscriber_id (alias órfão), não ao cadastro da coorte.
      const target = opts.linkDelivered ? id : ensureSubscriber(db, "kit", `orfao-${i}`, `orfao${i}@example.com`, NOW);
      for (let e = 0; e < 21; e++) {
        // 1 edição por dia (a dedup por edição canônica colapsa broadcasts do mesmo dia).
        const ts = new Date(Date.parse("2026-09-15T09:00:00.000Z") + e * 86_400_000).toISOString();
        recordEvent(db, { subscriberId: target, platform: "kit", type: "delivered", externalEventId: `d-${i}-${e}`, edicao: `b${e}`, ts });
      }
    }
    db.close();
    return storePath;
  }

  function reportWith(cadastros: number): CacReport {
    return { rows: [{ kind: "measured", canal: GOOGLE, cadastros }] } as unknown as CacReport;
  }

  it("coorte do Kit SEM delivered ligado ao próprio subscriber → guard dispara (leitor-v1 sairia 0 por defeito de dado)", async () => {
    await withTmpDir(async (dir) => {
      const storePath = await seedStore(dir, { linkDelivered: false });
      const guard = loadApuracaoCohortGuard(reportWith(4), [GOOGLE], storePath);
      assert.equal(guard.problems.length, 1, guard.problems.join("\n"));
      assert.match(guard.problems[0], /Cobertura de entrega da coorte: só 0 de 4 ativos/);
    });
  });

  it("coorte com delivered ligado → sem problema; linha informativa traz a fração com >=20 recebidas", async () => {
    await withTmpDir(async (dir) => {
      const storePath = await seedStore(dir, { linkDelivered: true });
      const guard = loadApuracaoCohortGuard(reportWith(4), [GOOGLE], storePath);
      assert.deepEqual(guard.problems, []);
      assert.ok(guard.coverageLines.some((l) => /100\.0% com >=20 recebidas/.test(l)), guard.coverageLines.join("\n"));
    });
  });

  it("braço com cadastros no store mas 0 no relatório → guard dispara (coorte perdida no caminho)", async () => {
    await withTmpDir(async (dir) => {
      const storePath = await seedStore(dir, { linkDelivered: true });
      const guard = loadApuracaoCohortGuard(reportWith(0), [GOOGLE], storePath);
      assert.ok(guard.problems.some((p) => /0 cadastros, mas o store tem 4/.test(p)), guard.problems.join("\n"));
    });
  });

  it("#10595: e-mail reatribuído pelo mapa de origem não conta no braço do store (sem alarme falso)", async () => {
    await withTmpDir(async (dir) => {
      const storePath = await seedStore(dir, { linkDelivered: true });
      // build-origem-map reatribuiu os 4 cadastros "google-ads" a outra origem
      // (e-mail em caixa diferente: o índice normaliza) — o cac-report --fonte
      // store aplica esse mapa e sai com 0 no braço; o guard precisa ver o mesmo.
      const origemPath = join(dir, "origem-original.json");
      const origem: Record<string, { utm_source: string; referring_site: string }> = {};
      for (let i = 0; i < 4; i++) origem[`Leitor${i}@Example.com`] = { utm_source: "linkedin-organico", referring_site: "" };
      writeFileSync(origemPath, JSON.stringify({ origem }));
      const guard = loadApuracaoCohortGuard(reportWith(0), [GOOGLE], storePath, origemPath);
      assert.deepEqual(guard.problems, [], guard.problems.join("\n"));
      assert.ok(guard.coverageLines.some((l) => /0 cadastro\(s\) no store, 0 no relatório/.test(l)), guard.coverageLines.join("\n"));
    });
  });

  it("#10595: mapa de origem ausente → cai na UTM crua (mesmo comportamento do relatório)", async () => {
    await withTmpDir(async (dir) => {
      const storePath = await seedStore(dir, { linkDelivered: true });
      const guard = loadApuracaoCohortGuard(reportWith(0), [GOOGLE], storePath, join(dir, "sem-mapa.json"));
      assert.ok(guard.problems.some((p) => /0 cadastros, mas o store tem 4/.test(p)), guard.problems.join("\n"));
    });
  });

  it("store ilegível → problema, nunca 'passa'", async () => {
    await withTmpDir(async (dir) => {
      const guard = loadApuracaoCohortGuard(reportWith(4), [GOOGLE], join(dir, "nao-existe.db"));
      assert.equal(guard.problems.length, 1);
      assert.match(guard.problems[0], /store ilegível/);
    });
  });

  it("realIsStoreFresh: ingestão Kit de 2h atrás → usável; de 3 dias atrás → inutilizável; store ausente → inutilizável", async () => {
    await withTmpDir(async (dir) => {
      const fresh = await seedStore(dir, { linkDelivered: true, kitUpdatedAt: "2026-10-25T04:25:00.000Z" });
      assert.deepEqual(realIsStoreFresh(new Date(NOW), fresh), { usable: true, reason: null });
    });
    await withTmpDir(async (dir) => {
      const stale = await seedStore(dir, { linkDelivered: true, kitUpdatedAt: "2026-10-22T04:25:00.000Z" });
      const r = realIsStoreFresh(new Date(NOW), stale);
      assert.equal(r.usable, false);
      assert.match(r.reason ?? "", /Diaria-Kit-Roster-Ingest parada/);
    });
    await withTmpDir(async (dir) => {
      assert.equal(realIsStoreFresh(new Date(NOW), join(dir, "nao-existe.db")).usable, false);
    });
  });
});
