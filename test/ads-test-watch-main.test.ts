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
import { main, DEFAULT_PLANNED_D0, type AdsTestWatchDeps } from "../scripts/ads-test-watch.ts";
import { buildAdsTestRunState } from "../scripts/lib/ads-test-run-state.ts";
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
    backupRoot: join(dir, "beehiiv-backup"),
    plannedD0: DEFAULT_PLANNED_D0,
    plannedDailyBudgetBRL: 100,
    now: () => new Date("2026-08-26T06:30:00.000Z"),
    notify: async () => fakeNotifyResult(),
    runBuildOrigemMap: () => {
      calls.push("origem");
      return true;
    },
    runCacReport: () => {
      calls.push("cac");
      return true;
    },
    isSnapshotUsable: () => ({ usable: true, reason: null }),
    commentOnReligarBrevoIssue: () => ({ status: 0, stdout: "", stderr: "" }),
    execMode: () => "local",
    ...overrides,
  } satisfies Partial<AdsTestWatchDeps>;
}

describe("#5845 — ads-test-watch main (I/O): apuração", () => {
  it("snapshot INUTILIZÁVEL → NÃO roda build-origem-map nem cac-report, alarma, watch-state intacto", async () => {
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
          isSnapshotUsable: () => ({ usable: false, reason: "manifest.json reporta erro no endpoint subscribers" }),
          runBuildOrigemMap: () => {
            origemCalls.push("origem");
            return true;
          },
          runCacReport: () => {
            cacCalls.push("cac");
            return true;
          },
          notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()),
        }),
      );

      assert.equal(origemCalls.length, 0, "build-origem-map NUNCA deve rodar sobre snapshot inutilizável");
      assert.equal(cacCalls.length, 0, "cac-report NUNCA deve rodar sobre snapshot inutilizável");
      assert.equal(notifyCalls.length, 1);
      assert.equal(notifyCalls[0].severity, "urgente");
      assert.match(notifyCalls[0].subject, /NÃO rodou/);
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
          runCacReport: () => {
            callOrder.push("cac");
            return true;
          },
          notify: async (f) => (notifyCalls.push(f), fakeNotifyResult()),
        }),
      );

      assert.deepEqual(callOrder, ["origem", "cac"], "build-origem-map SEMPRE imediatamente antes de cac-report (§7.2)");
      assert.equal(notifyCalls.length, 1);
      assert.match(notifyCalls[0].subject, /apuração congelada rodou/);

      const watchState = JSON.parse(readFileSync(join(dir, "watch-state.json"), "utf8"));
      assert.ok(watchState.apuracaoCompletedAt);
      assert.equal(watchState.apuracaoReportPath, `data/aquisicao/cac-reports/cac-${runState.apuracao_snapshot}.md`);
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
          runCacReport: () => {
            callOrder.push("cac");
            return true;
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
          runCacReport: () => {
            callOrder.push("cac");
            return true;
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
