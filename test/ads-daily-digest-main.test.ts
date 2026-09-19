/**
 * test/ads-daily-digest-main.test.ts (#8262 P1, achado 1)
 *
 * I/O de `scripts/ads-daily-digest.ts::main` — cobre a ponta que
 * `test/ads-daily-digest.test.ts` (lógica pura) não alcança: o script
 * REALMENTE lê `clicks-2608.csv` do disco e injeta a seção de aviso/projeção
 * de gasto (`computeSpendWatchDigestLines`) no digest que sai todo dia. Todas
 * as dependências (registro de relatório, portão de notificação, relógio,
 * execMode) são injetadas via `AdsDailyDigestDeps` — nunca toca rede nem
 * `data/` real.
 *
 * #7960 (item 4 da #7957): o canal deixou de ser e-mail (`sendEmail`) e
 * passou a ser a superfície de Relatórios do Studio (`registerReportFn`) —
 * as asserções abaixo passaram a ler o markdown REGISTRADO, não o corpo do
 * e-mail. O que se afirma é o mesmo: o digest SEMPRE sai.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type AdsDailyDigestDeps } from "../scripts/ads-daily-digest.ts";
import { buildAdsTestRunState } from "../scripts/lib/ads-test-run-state.ts";
import type { RegisterReportResult, ReportRegistryInput } from "../scripts/studio-ui/studio-reports.ts";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ads-daily-digest-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Caminho feliz do `registerReport` real (file-based, fail-soft, nunca
 * dispara e-mail desde que `notify` fique no default `false`). */
function okRegisterResult(): RegisterReportResult {
  return {
    ok: true,
    entry: null,
    error: null,
    emailDispatch: Promise.resolve({ sent: false, skipped: "notify-disabled" }),
  } as unknown as RegisterReportResult;
}

/** Coletor do que o digest REGISTROU nesta execução (#7960) — substitui o
 * antigo coletor de e-mails enviados. Lê do disco o markdown que `main`
 * acabou de gravar, provando que o arquivo apontado por `htmlPath` existe
 * de verdade (um registro apontando pra arquivo inexistente seria um
 * relatório vazio no Studio). */
function reportCollector(): {
  registered: Array<{ input: ReportRegistryInput; body: string }>;
  registerReportFn: AdsDailyDigestDeps["registerReportFn"];
} {
  const registered: Array<{ input: ReportRegistryInput; body: string }> = [];
  return {
    registered,
    registerReportFn: (rootDir, input) => {
      registered.push({ input, body: readFileSync(join(rootDir, input.htmlPath), "utf8") });
      return okRegisterResult();
    },
  };
}

function baseDeps(dir: string, overrides: Partial<AdsDailyDigestDeps> = {}): Partial<AdsDailyDigestDeps> {
  return {
    spendCsvPath: join(dir, "spend.csv"),
    historyPath: join(dir, ".ads-daily-digest-history.json"),
    runStatePath: join(dir, "run-state.json"),
    clicksCsvPath: join(dir, "clicks-2608.csv"),
    backupRoot: join(dir, "beehiiv-backup"),
    now: () => new Date("2026-09-01T13:00:00.000Z"),
    rootDir: dir,
    registerReportFn: () => okRegisterResult(),
    // `severity: "info"` já é um no-op de e-mail/issue no portão real; o stub
    // existe só pra não escrever em `data/run-log.jsonl` de verdade.
    notify: (async () => ({ severity: "info", emailPolicy: "legacy", emailSent: false })) as AdsDailyDigestDeps["notify"],
    execMode: () => "local",
    ...overrides,
  } satisfies Partial<AdsDailyDigestDeps>;
}

const CLICKS_HEADER = "canal,data_apuracao,gasto_acumulado,cliques,impressoes,cpc_medio,conversoes,custo_por_conversao,perda_orcamento,perda_ranking,fonte\n";

describe("#8262 P1 (achado 1) — ads-daily-digest main (I/O): seção de aviso de gasto do teste 2608", () => {
  it("clicks-2608.csv com braço em faixa de aviso (1,25x-2x) → seção aparece no relatório registrado", async () => {
    await withTmpDir(async (dir) => {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      writeFileSync(join(dir, "run-state.json"), JSON.stringify(runState));
      writeFileSync(join(dir, "spend.csv"), "canal,mes,moeda,valor,fonte\n");
      // periodDate (ontem, 2026-09-01 UTC-3h → "2026-08-31") não precisa ter
      // linha — o digest usa a linha mais recente <= todayIso (2026-09-01),
      // e o alarme é sobre HOJE, não sobre o período do delta de spend.csv.
      const braco = runState.bracos[0];
      writeFileSync(join(dir, "clicks-2608.csv"), CLICKS_HEADER + `${braco},2026-09-01,1000,,,,,,,,\n`);

      const { registered, registerReportFn } = reportCollector();
      // #7960: o `notifyEditor({severity: "info"})` é o que mantém o digest
      // visível em `data/run-log.jsonl` (`/diaria-log`) agora que ele não
      // e-mailia mais. Sem esta asserção, uma regressão que simplesmente
      // apagasse a chamada passaria em todos os testes deste arquivo.
      const notified: Array<{ check: string; severity: string; fingerprint: string }> = [];
      await main(
        [],
        baseDeps(dir, {
          registerReportFn,
          notify: (async (finding) => {
            notified.push({ check: finding.check, severity: finding.severity, fingerprint: finding.fingerprint });
            return { severity: finding.severity, emailPolicy: "legacy", emailSent: false };
          }) as AdsDailyDigestDeps["notify"],
        }),
      );

      assert.deepEqual(notified, [{ check: "ads-daily-digest", severity: "info", fingerprint: "2026-08-31" }]);
      assert.equal(registered.length, 1);
      assert.equal(registered[0].input.kind, "ads-digest");
      assert.equal(registered[0].input.sessionId, "2026-08-31", "sessionId é o periodDate (dia anterior)");
      assert.match(registered[0].body, /avisos de gasto/, "a seção de aviso do #8240 item 4 deveria estar no corpo do digest diário");
      assert.match(registered[0].body, new RegExp(braco.replace(/[()]/g, "\\$&")));
    });
  });

  it("sem clicks-2608.csv (arquivo ausente) → digest sai normalmente, sem seção de gasto, sem erro", async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(join(dir, "spend.csv"), "canal,mes,moeda,valor,fonte\n");
      const { registered, registerReportFn } = reportCollector();
      await main([], baseDeps(dir, { registerReportFn }));
      assert.equal(registered.length, 1);
      assert.doesNotMatch(registered[0].body, /avisos de gasto/);
    });
  });

  it("--to (flag do canal de e-mail, removida no #7960) aborta em vez de ser ignorada em silêncio", async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(join(dir, "spend.csv"), "canal,mes,moeda,valor,fonte\n");
      const { registered, registerReportFn } = reportCollector();
      const previousExitCode = process.exitCode;
      try {
        await main(["--to", "outro@exemplo.com"], baseDeps(dir, { registerReportFn }));
        // Aceitar e ignorar deixaria um runbook/task antiga achando que
        // mandou o digest pra outro endereço — daí o abort ser duro.
        assert.equal(process.exitCode, 2);
        assert.deepEqual(registered, [], "nada é registrado quando a invocação está errada");
      } finally {
        process.exitCode = previousExitCode;
      }
    });
  });

  it("clicks-2608.csv com erro de parsing → seção omitida, mas o digest ainda sai (nunca aborta a task por causa disso)", async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(join(dir, "spend.csv"), "canal,mes,moeda,valor,fonte\n");
      // header sem coluna obrigatória `gasto_acumulado` -> parseClicksCsv lança
      writeFileSync(join(dir, "clicks-2608.csv"), "canal,data_apuracao\nx,2026-09-01\n");
      const { registered, registerReportFn } = reportCollector();
      await main([], baseDeps(dir, { registerReportFn }));
      assert.equal(registered.length, 1, "o digest SEMPRE sai, mesmo com o CSV do teste 2608 quebrado");
      assert.doesNotMatch(registered[0].body, /avisos de gasto/);
    });
  });
});
