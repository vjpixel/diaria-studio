/**
 * test/cac-report-store-10729-10730.test.ts
 *
 * Regressões do relatório de CAC com `--fonte store` (o caminho da apuração
 * do teste 2608):
 *
 * - #10730: o path que `ads-test-watch.ts` grava em `watch-state.json`
 *   (`apuracaoReportPath`) tem de ser o arquivo que `cac-report.ts` de fato
 *   escreve. Antes, o watch montava o path com o id do REGISTRY
 *   (`reportId("cac", …)`, prefixo `cac-`) e apontava para um arquivo que
 *   não existe.
 * - #10729: a coorte vinda do store (`buildCacCompatibleSubscribersFromStore`)
 *   não tem `total_unique_opened`; o relatório imprimia `0.0%` de abertura
 *   (canal e base) e `▲ 0.0%` no vs. base — um zero que parece medido e não
 *   é. Agora sai `—` / "sem dado de abertura".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  main as cacReportMain,
  cacReportRelPath,
  cacReportSnapshotId,
  formatCacReportMarkdown,
} from "../scripts/cac-report.ts";
import { main as adsTestWatchMain, DEFAULT_PLANNED_D0, type AdsTestWatchDeps } from "../scripts/ads-test-watch.ts";
import { buildAdsTestRunState } from "../scripts/lib/ads-test-run-state.ts";
import { buildCacReport, computeBaseMetrics, computeMeasuredRow, computeMonthBudgetUsage, hasOpenData } from "../scripts/lib/cac.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";
import type { SpendRow } from "../scripts/lib/aquisicao-spend.ts";
import type { NotifyEditorResult } from "../scripts/lib/editor-notify.ts";

function fakeNotifyResult(): NotifyEditorResult {
  return {
    severity: "urgente",
    emailPolicy: "legacy",
    issue: { action: "created", issueNumber: 1, url: "https://github.com/x/y/issues/1" },
    emailSent: true,
  };
}

describe("#10730 — apuracaoReportPath do watch == arquivo escrito pelo cac-report", () => {
  it("cacReportRelPath não carrega o prefixo cac- do id do registry", () => {
    const id = cacReportSnapshotId("2026-10-21", "store");
    assert.equal(cacReportRelPath(id), "data/aquisicao/cac-reports/2026-10-21--store.md");
  });

  it("o path que markApuracaoCompleted recebe existe depois que cac-report --fonte store --register roda", async () => {
    const { openDiariaSubscribersDb, ensureSubscriber, upsertSubscription } = await import("../scripts/lib/diaria-subscribers-db.ts");
    const root = mkdtempSync(join(tmpdir(), "cac-report-10730-"));
    try {
      const runState = buildAdsTestRunState("2026-08-26", "2026-08-26T09:00:00.000Z");
      const snapshot = runState.apuracao_snapshot;

      // 1) cac-report real, --fonte store, registrando (default) em `root`.
      const spendPath = join(root, "spend.csv");
      writeFileSync(spendPath, "canal,mes,moeda,valor,fonte\nGoogle Ads (teste 2608),2026-09,BRL,500.57,teste\n", "utf8");
      const storeDir = join(root, "data", "diaria-subscribers");
      mkdirSync(storeDir, { recursive: true });
      const storePath = join(storeDir, "diaria-subscribers.db");
      const db = openDiariaSubscribersDb(storePath);
      const subscriberId = ensureSubscriber(db, "kit", "kit-1", "leitor@example.com", "2026-09-10T00:00:00.000Z");
      upsertSubscription(
        db,
        subscriberId,
        "kit",
        { status: "active", enteredAt: "2026-09-10T00:00:00.000Z", exitedAt: null, source: "kit", utmSource: "google-ads" },
        "2026-09-10T00:00:00.000Z",
      );
      db.close();

      const exitBefore = process.exitCode;
      process.exitCode = undefined;
      const report = await cacReportMain(
        [
          "--fonte", "store",
          "--snapshot", snapshot,
          "--spend", spendPath,
          "--origem", join(root, "origem-inexistente.json"),
          "--store-db", storePath,
          "--no-kit",
          "--no-store-leitores",
        ],
        root,
      );
      process.exitCode = exitBefore;
      assert.ok(report, "cac-report --fonte store deveria ter rodado");

      // 2) ads-test-watch no dia da apuração, com o cac-report injetado como sucesso.
      const watchDir = join(root, "watch");
      mkdirSync(watchDir, { recursive: true });
      writeFileSync(join(watchDir, "run-state.json"), JSON.stringify(runState));
      writeFileSync(
        join(watchDir, "watch-state.json"),
        JSON.stringify({ religarBrevoTriggeredAt: "2026-09-16T06:30:00.000Z", apuracaoCompletedAt: null, apuracaoReportPath: null }),
      );
      const deps: Partial<AdsTestWatchDeps> = {
        runStatePath: join(watchDir, "run-state.json"),
        watchStatePath: join(watchDir, "watch-state.json"),
        clicksCsvPath: join(watchDir, "clicks-2608.csv"),
        plannedD0: DEFAULT_PLANNED_D0,
        plannedDailyBudgetBRL: 100,
        now: () => new Date(snapshot + "T06:30:00.000Z"),
        notify: async () => fakeNotifyResult(),
        runBuildOrigemMap: () => true,
        runCacReport: async () => ({ ok: true, zeroCadastrosArms: [] }),
        isStoreFresh: () => ({ usable: true, reason: null }),
        commentOnReligarBrevoIssue: () => ({ status: 0, stdout: "", stderr: "" }),
        execMode: () => "local",
        resolveBrevoTaskEnabled: () => false,
      };
      await adsTestWatchMain([], deps);

      const watchState = JSON.parse(readFileSync(join(watchDir, "watch-state.json"), "utf8"));
      assert.ok(watchState.apuracaoCompletedAt, "apuração deveria ter sido marcada como concluída");
      assert.equal(typeof watchState.apuracaoReportPath, "string");
      assert.ok(
        existsSync(join(root, watchState.apuracaoReportPath)),
        `apuracaoReportPath (${watchState.apuracaoReportPath}) não existe — o watch e o cac-report divergiram no nome do arquivo`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Shape exato que `buildCacCompatibleSubscribersFromStore` produz: stats só
// com recebidas/cliques, sem `total_unique_opened`.
function storeShapedSub(overrides: Partial<BeehiivBackupSubscriber> = {}): BeehiivBackupSubscriber {
  return {
    email: "leitor@example.com",
    status: "active",
    created: 1_788_000_000,
    utm_source: "google-ads",
    utm_medium: "cpc",
    utm_campaign: "",
    referring_site: "",
    stats: { total_received: 30, total_unique_clicked: 3 },
    ...overrides,
  } as BeehiivBackupSubscriber;
}

describe("#10729 — fonte store sem campo de abertura nunca imprime 0.0%", () => {
  const spend: SpendRow = { canal: "Google Ads (teste 2608)", mes: "2026-09", moeda: "BRL", valor: 500.57, fonte: "teste" };

  it("hasOpenData: false sem o campo, true com o campo (mesmo 0)", () => {
    assert.equal(hasOpenData([{ status: "active", stats: { total_received: 30, total_unique_clicked: 3 } }]), false);
    assert.equal(hasOpenData([{ status: "active", stats: { total_received: 30, total_unique_opened: 0 } }]), true);
  });

  it("computeMeasuredRow/computeBaseMetrics devolvem abertura null (não 0) quando o campo não existe", () => {
    const subs = [storeShapedSub(), storeShapedSub({ email: "b@example.com" })];
    const row = computeMeasuredRow(spend, subs, { previousChannelSubs: subs });
    assert.equal(row.aberturaAgregada, null);
    assert.equal(row.aberturaAgregadaAnterior, null);
    assert.equal(row.degradado, null);
    assert.ok(row.amostraConsiderada > 0, "sanity: há amostra — o null é falta de campo, não de gente");
    const base = computeBaseMetrics(subs);
    assert.equal(base.aberturaAgregada, null);
    assert.ok(base.amostraConsiderada > 0);
  });

  it("abertura medida de verdade = 0 continua 0 (o campo existe)", () => {
    const subs = [storeShapedSub({ stats: { total_received: 30, total_unique_clicked: 0, total_unique_opened: 0 } })];
    assert.equal(computeMeasuredRow(spend, subs).aberturaAgregada, 0);
  });

  it("markdown com coorte store: abertura e vs. base saem '—', base diz 'sem dado de abertura', nenhum 0.0%", () => {
    const subs = [storeShapedSub(), storeShapedSub({ email: "b@example.com" })];
    const report = buildCacReport([spend], subs);
    const md = formatCacReportMarkdown(report, computeMonthBudgetUsage([spend], "2026-09"), { fonte: "store" });
    const row = md.split("\n").find((l) => l.startsWith("| Google Ads (teste 2608) |"));
    assert.ok(row, `linha do canal ausente no markdown:\n${md}`);
    const cells = row!.split("|").map((c) => c.trim());
    // | Canal | Sub-canal | Custo/leitor | Leitores | Ativos | Cadastros | Abertura (canal) | vs. base | ...
    assert.equal(cells[7], "—", `abertura do canal deveria ser — (linha: ${row})`);
    assert.equal(cells[8], "—", `vs. base deveria ser — (linha: ${row})`);
    assert.doesNotMatch(row!, /0\.0%/);
    assert.match(md, /abertura agregada — \(sem dado de abertura nesta fonte\) \(n=2\)/);
    assert.doesNotMatch(md, /abertura agregada 0\.0%/);
  });
});
