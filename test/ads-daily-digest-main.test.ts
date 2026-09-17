/**
 * test/ads-daily-digest-main.test.ts (#8262 P1, achado 1)
 *
 * I/O de `scripts/ads-daily-digest.ts::main` — cobre a ponta que
 * `test/ads-daily-digest.test.ts` (lógica pura) não alcança: o script
 * REALMENTE lê `clicks-2608.csv` do disco e injeta a seção de aviso/projeção
 * de gasto (`computeSpendWatchDigestLines`) no e-mail que sai todo dia. Todas
 * as dependências (e-mail, relógio, execMode) são injetadas via
 * `AdsDailyDigestDeps` — nunca toca rede nem `data/` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type AdsDailyDigestDeps } from "../scripts/ads-daily-digest.ts";
import { buildAdsTestRunState } from "../scripts/lib/ads-test-run-state.ts";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ads-daily-digest-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseDeps(dir: string, overrides: Partial<AdsDailyDigestDeps> = {}): Partial<AdsDailyDigestDeps> {
  return {
    spendCsvPath: join(dir, "spend.csv"),
    historyPath: join(dir, ".ads-daily-digest-history.json"),
    runStatePath: join(dir, "run-state.json"),
    clicksCsvPath: join(dir, "clicks-2608.csv"),
    backupRoot: join(dir, "beehiiv-backup"),
    now: () => new Date("2026-09-01T13:00:00.000Z"),
    sendEmail: async () => ({ id: "fake" }) as never,
    execMode: () => "local",
    ...overrides,
  } satisfies Partial<AdsDailyDigestDeps>;
}

const CLICKS_HEADER = "canal,data_apuracao,gasto_acumulado,cliques,impressoes,cpc_medio,conversoes,custo_por_conversao,perda_orcamento,perda_ranking,fonte\n";

describe("#8262 P1 (achado 1) — ads-daily-digest main (I/O): seção de aviso de gasto do teste 2608", () => {
  it("clicks-2608.csv com braço em faixa de aviso (1,25x-2x) → seção aparece no e-mail enviado", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      writeFileSync(join(dir, "spend.csv"), "canal,mes,moeda,valor,fonte\n");
      // periodDate (ontem, 2026-09-01 UTC-3h → "2026-08-31") não precisa ter
      // linha — o digest usa a linha mais recente <= todayIso (2026-09-01),
      // e o alarme é sobre HOJE, não sobre o período do delta de spend.csv.
      const braco = runState.bracos[0];
      writeFileSync(join(dir, "clicks-2608.csv"), CLICKS_HEADER + `${braco},2026-09-01,1000,,,,,,,,\n`);

      const sentEmails: Array<{ subject: string; body: string }> = [];
      await main(
        [],
        baseDeps(dir, {
          sendEmail: async (_to, subject, body) => {
            sentEmails.push({ subject, body });
            return { id: "x" } as never;
          },
        }),
      );

      assert.equal(sentEmails.length, 1);
      assert.match(sentEmails[0].body, /avisos de gasto/, "a seção de aviso do #8240 item 4 deveria estar no corpo do digest diário");
      assert.match(sentEmails[0].body, new RegExp(braco.replace(/[()]/g, "\\$&")));
    });
  });

  it("sem clicks-2608.csv (arquivo ausente) → digest sai normalmente, sem seção de gasto, sem erro", async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(join(dir, "spend.csv"), "canal,mes,moeda,valor,fonte\n");
      const sentEmails: Array<{ subject: string; body: string }> = [];
      await main(
        [],
        baseDeps(dir, {
          sendEmail: async (_to, subject, body) => {
            sentEmails.push({ subject, body });
            return { id: "x" } as never;
          },
        }),
      );
      assert.equal(sentEmails.length, 1);
      assert.doesNotMatch(sentEmails[0].body, /avisos de gasto/);
    });
  });

  it("clicks-2608.csv com erro de parsing → seção omitida, mas o digest ainda sai (nunca aborta a task por causa disso)", async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(join(dir, "spend.csv"), "canal,mes,moeda,valor,fonte\n");
      // header sem coluna obrigatória `gasto_acumulado` -> parseClicksCsv lança
      writeFileSync(join(dir, "clicks-2608.csv"), "canal,data_apuracao\nx,2026-09-01\n");
      const sentEmails: Array<{ subject: string; body: string }> = [];
      await main(
        [],
        baseDeps(dir, {
          sendEmail: async (_to, subject, body) => {
            sentEmails.push({ subject, body });
            return { id: "x" } as never;
          },
        }),
      );
      assert.equal(sentEmails.length, 1, "o digest SEMPRE sai, mesmo com o CSV do teste 2608 quebrado");
      assert.doesNotMatch(sentEmails[0].body, /avisos de gasto/);
    });
  });
});
