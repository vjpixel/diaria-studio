/**
 * test/ads-test-watch-main.test.ts (#5845)
 *
 * I/O de `scripts/ads-test-watch.ts::main` — todas as dependências reais
 * (e-mail, gh, build-origem-map/cac-report, checagem de snapshot) são
 * INJETADAS via `AdsTestWatchDeps`, então este teste nunca toca rede,
 * `gh`, nem `data/` real. Cobre o critério de pronto: "apuração roda os 2
 * comandos na ordem e recusa snapshot inutilizável".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, DEFAULT_PLANNED_D0, type AdsTestWatchDeps } from "../scripts/ads-test-watch.ts";
import { buildAdsTestRunState } from "../scripts/lib/ads-test-run-state.ts";

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
    sendEmail: async () => ({ id: "fake" }) as never,
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
      const sentEmails: Array<{ subject: string; body: string }> = [];
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
          sendEmail: async (_to, subject, body) => {
            sentEmails.push({ subject, body });
            return { id: "x" } as never;
          },
        }),
      );

      assert.equal(origemCalls.length, 0, "build-origem-map NUNCA deve rodar sobre snapshot inutilizável");
      assert.equal(cacCalls.length, 0, "cac-report NUNCA deve rodar sobre snapshot inutilizável");
      assert.equal(sentEmails.length, 1);
      assert.match(sentEmails[0].subject, /NÃO rodou/);
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
      const sentEmails: Array<{ subject: string }> = [];

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
          sendEmail: async (_to, subject) => {
            sentEmails.push({ subject });
            return { id: "x" } as never;
          },
        }),
      );

      assert.deepEqual(callOrder, ["origem", "cac"], "build-origem-map SEMPRE imediatamente antes de cac-report (§7.2)");
      assert.equal(sentEmails.length, 1);
      assert.match(sentEmails[0].subject, /apuração congelada rodou/);

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
      const sentEmails: Array<{ subject: string; body: string }> = [];

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
          sendEmail: async (_to, subject, body) => {
            sentEmails.push({ subject, body });
            return { id: "x" } as never;
          },
        }),
      );

      assert.equal(fetchCalls.length, 1, "deps.fetchAutoSpend() deveria ter sido chamado exatamente 1x");
      const deathEmail = sentEmails.find((e) => /condição de morte disparada/.test(e.subject));
      assert.ok(deathEmail, "o gasto complementado pela fonte automática deveria disparar a condição de morte");
      assert.match(deathEmail!.body, new RegExp(braco.replace(/[()]/g, "\\$&")));
      assert.match(deathEmail!.body, /R\$ 2200[.,]00/, "gasto acumulado deveria ser 100 (CSV) + 700×3 (automático) = 2200");
    });
  });

  it("#8240 item 4 — aviso (1,25x-2x) e projeção vão pro console (buildSpendWatchDigestSection), NUNCA um e-mail próprio", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      const braco = runState.bracos[0];
      const header = "canal,data_apuracao,gasto_acumulado,cliques,impressoes,cpc_medio,conversoes,custo_por_conversao,perda_orcamento,perda_ranking,fonte\n";
      // Planejado até 01/09 (10 dias × R$100) = R$1.000. Gasto 1.400 -> razão
      // 1,4x: dentro da faixa de aviso (1,25x-2x), abaixo do limiar de morte.
      const csv = header + runState.bracos.map((b) => `${b},2026-09-01,1400,,,,,,,,\n`).join("");
      writeFileSync(join(dir, "clicks-2608.csv"), csv);

      const sentEmails: Array<{ subject: string }> = [];
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
            sendEmail: async (_to, subject) => {
              sentEmails.push({ subject });
              return { id: "x" } as never;
            },
          }),
        );
      } finally {
        console.log = originalLog;
      }

      assert.ok(
        !sentEmails.some((e) => /morte|aviso/i.test(e.subject)),
        "aviso/projeção NUNCA deveriam gerar e-mail próprio (#8240 item 4)",
      );
      assert.ok(
        logged.some((l) => l.includes("avisos de gasto")),
        "a seção de aviso deveria aparecer no console (buildSpendWatchDigestSection), mesmo sem e-mail",
      );
      assert.ok(logged.some((l) => l.includes(braco)), "console deveria nomear o braço no aviso");
    });
  });
});

describe("#5845 — ads-test-watch main (I/O): D0 ausente/reconciliação/guard de data/", () => {
  it("sem run-state.json, D0 planejado já passou → alarma, sem tentar ler clicks-2608.csv", async () => {
    await withTmpDir(async (dir) => {
      const sentEmails: Array<{ subject: string }> = [];
      await main(
        [],
        baseDeps(dir, {
          plannedD0: "2026-08-01",
          now: () => new Date("2026-08-05T06:30:00.000Z"),
          sendEmail: async (_to, subject) => {
            sentEmails.push({ subject });
            return { id: "x" } as never;
          },
        }),
      );
      assert.equal(sentEmails.length, 1);
      assert.match(sentEmails[0].subject, /D0 planejado/);
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
      const sentEmails: Array<{ subject: string; body: string }> = [];

      await main(
        [],
        baseDeps(dir, {
          now: () => new Date("2026-08-28T06:30:00.000Z"), // checa ontem = 2026-08-27
          sendEmail: async (_to, subject, body) => {
            sentEmails.push({ subject, body });
            return { id: "x" } as never;
          },
        }),
      );

      const coverageEmail = sentEmails.find((e) => /reconciliação de gasto faltando/.test(e.subject));
      assert.ok(coverageEmail, "deveria alarmar cobertura faltante");
      assert.match(coverageEmail!.body, new RegExp(runState.bracos[2].replace(/[()]/g, "\\$&")));
    });
  });
});
