/**
 * test/microsoft-ads-encerramento-10755.test.ts (#10755)
 *
 * Decisão do editor (21/10/2026): o canal Microsoft Ads foi encerrado. O
 * código do canal sai; o log de atividades fica. Este arquivo trava as duas
 * metades do critério de pronto da issue:
 *
 *   1. Nenhuma task, script ou módulo de ingestão do Microsoft Ads no repo,
 *      e o nome da task em `RETIRED_TASK_NAMES` (o timer ainda armado na
 *      `300` vira no-op até o editor desarmar).
 *   2. O histórico continua sendo lido: uma linha de gasto do braço
 *      Microsoft em `spend.csv` segue atribuída no relatório de CAC
 *      (`buildCacReport`) e somada na apuração do teste 2608
 *      (`sumTeste2608Spend`), e um cadastro vindo de link antigo
 *      (`utm_source=microsoft-ads` ou `msclkid:`) segue classificado no braço.
 *
 * Nunca chama API — só constantes, funções puras e um `run-task` no-op.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getScheduledTaskByName,
  isRetiredTaskName,
  SCHEDULED_TASKS,
} from "../scripts/lib/scheduled-tasks.ts";
import { main as runTaskMain } from "../scripts/run-task.ts";
import { CHANNEL_KEY_SPECS } from "../scripts/lib/shared/channel-key-specs.ts";
import { ADS_TEST_2608_BRACOS } from "../scripts/lib/ads-test-run-state.ts";
import { parseSpendCsv } from "../scripts/lib/aquisicao-spend.ts";
import { sumTeste2608Spend } from "../scripts/lib/ads-daily-digest.ts";
import { buildCacReport, type CacMeasuredRow } from "../scripts/lib/cac.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";
import { resolveOrigemPagaWithClickIdFallback } from "../scripts/lib/shared/client-utm-allowlist.ts";
import { classifyAcquisition } from "../scripts/lib/metrics/acquisition-class.ts";
import { MICROSOFT_ADS_TESTE_CANAL } from "../scripts/lib/ads-campaign-economics-fetch.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TASK = "Diaria-Microsoft-Ads-Spend-Ingest";
const MS = "Microsoft Ads (teste 2608)";

const REMOVED_FILES = [
  "scripts/microsoft-ads-ingest-spend.ts",
  "scripts/lib/microsoft-ads-ingest.ts",
  "scripts/microsoft-ads-editorial-reasons.ts",
  "scripts/lib/microsoft-ads-editorial-reasons.ts",
  "docs/microsoft-ads-api-setup.md",
];

describe("#10755 — código do canal Microsoft Ads removido", () => {
  it("a task de ingestão saiu do registro e está em RETIRED_TASK_NAMES", () => {
    assert.equal(getScheduledTaskByName(TASK), undefined);
    assert.equal(isRetiredTaskName(TASK), true);
  });

  it("nenhuma task agendada roda script ou grava log do Microsoft Ads", () => {
    const offenders = SCHEDULED_TASKS.filter(
      (t) => /microsoft-ads/i.test(t.logPath) || t.steps.some((s) => /microsoft-ads/i.test(s.script)),
    ).map((t) => t.name);
    assert.deepEqual(offenders, []);
  });

  for (const file of REMOVED_FILES) {
    it(`${file} não existe mais`, () => {
      assert.equal(existsSync(join(ROOT, file)), false);
    });
  }

  it("o registro de encerramento existe em docs/", () => {
    assert.equal(existsSync(join(ROOT, "docs/microsoft-ads-encerramento.md")), true);
  });

  it("run-task.ts com o nome retirado -> exit 0, no-op (o timer ainda armado na 300 não vira unit failed)", () => {
    const originalLog = console.log;
    const originalError = console.error;
    const logLines: string[] = [];
    const errorLines: string[] = [];
    console.log = (msg: string) => logLines.push(msg);
    console.error = (msg: string) => errorLines.push(msg);
    try {
      const code = runTaskMain(["--task", TASK], ROOT);
      assert.equal(code, 0);
      assert.match(logLines.join("\n"), /retirada do registro/);
      assert.doesNotMatch(errorLines.join("\n"), /Task desconhecida/);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });
});

describe("#10755 — o histórico do braço Microsoft continua sendo lido", () => {
  it("o braço segue com spec em CHANNEL_KEY_SPECS e em ADS_TEST_2608_BRACOS, com o mesmo nome do /ads", () => {
    const spec = CHANNEL_KEY_SPECS.find((s) => s.canal === MS);
    assert.ok(spec, "sem spec, o gasto histórico vira 'canal desconhecido' no cac-report");
    assert.deepEqual(spec!.keys, ["microsoft-ads"]);
    assert.ok((ADS_TEST_2608_BRACOS as readonly string[]).includes(MS));
    assert.equal(MICROSOFT_ADS_TESTE_CANAL, MS);
  });

  // Mesma forma das linhas que a ingestão gravou em setembro (teste 2608).
  const SPEND_CSV = [
    "canal,mes,moeda,valor,fonte",
    "Google Ads (teste 2608),2026-09,BRL,900.00,google-ads-api",
    `${MS},2026-09,BRL,835.97,microsoft-ads-api`,
    "Meta Ads (teste 2608),2026-09,BRL,1435.51,meta-ads-api",
  ].join("\n");

  it("parseSpendCsv lê a linha histórica do Microsoft sem erro", () => {
    const { rows, errors } = parseSpendCsv(SPEND_CSV);
    assert.deepEqual(errors, []);
    assert.equal(rows.find((r) => r.canal === MS)?.valor, 835.97);
  });

  it("sumTeste2608Spend (apuração do teste) ainda soma o gasto do braço Microsoft", () => {
    const { rows } = parseSpendCsv(SPEND_CSV);
    assert.equal(sumTeste2608Spend(rows), 3171.48);
  });

  it("buildCacReport (relatório de CAC) atribui a linha Microsoft como 'measured', nunca como canal desconhecido", () => {
    const { rows } = parseSpendCsv(SPEND_CSV);
    const sub: BeehiivBackupSubscriber = {
      email: "leitor-ms@example.com",
      status: "active",
      created: Date.parse("2026-09-10T12:00:00Z") / 1000,
      utm_source: "microsoft-ads",
      utm_medium: "cpc",
      utm_campaign: "ads-microsoft-2608",
      referring_site: "",
      stats: { total_received: 30, total_unique_clicked: 2, total_unique_opened: 20 },
    };
    const report = buildCacReport(rows.filter((r) => r.canal === MS), [sub]);
    assert.deepEqual(report.unmappedChannels, []);
    const row = report.rows.find((r) => r.canal === MS) as CacMeasuredRow | undefined;
    assert.ok(row, "linha do braço Microsoft sumiu do relatório");
    assert.equal(row!.kind, "measured");
    assert.equal(row!.spend.valor, 835.97);
    assert.equal(row!.cadastros, 1);
  });

  it("cadastro por link antigo com msclkid continua atribuído ao Microsoft Ads", () => {
    assert.equal(resolveOrigemPagaWithClickIdFallback("", "msclkid:abc123"), "microsoft-ads");
    assert.equal(resolveOrigemPagaWithClickIdFallback("diaria-apex", "msclkid:abc123"), "microsoft-ads");
  });

  it("utm_source=microsoft-ads continua classificado como aquisição paga", () => {
    const created = Math.floor(Date.parse("2026-10-21T12:00:00Z") / 1000);
    assert.equal(classifyAcquisition({ utm_source: "microsoft-ads", utm_medium: "cpc", created }), "pago");
  });
});
