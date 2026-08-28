#!/usr/bin/env npx tsx
/**
 * scripts/token-usage-summary.ts (#6445)
 *
 * CLI fina sobre `scripts/lib/token-usage-summary.ts` — responde "quem
 * comeu a janela de assinatura hoje?" agregando as 3 fontes de custo em
 * token que hoje vivem isoladas (`aggregate-costs.ts` pra edições,
 * `data/run-log.jsonl` pra overnight/develop/continuo, `session-transcript.ts`
 * pro resto) por DIA e por TIPO de sessão, últimos N dias.
 *
 * Uso:
 *   npx tsx scripts/token-usage-summary.ts
 *   npx tsx scripts/token-usage-summary.ts --days 7
 *   npx tsx scripts/token-usage-summary.ts --threshold-pct 60
 *   npx tsx scripts/token-usage-summary.ts --json
 *   npx tsx scripts/token-usage-summary.ts --register   # grava e registra no Studio (/relatorios)
 *
 * Sem `--register`, o comando só imprime — nunca escreve nada em disco.
 * Com `--register`, grava o markdown em
 * `data/token-usage/reports/{YYYY-MM-DD}.md` e registra via
 * `registerReport` (kind `"token-usage"`, #3714) — mesmo padrão de
 * `cac-report.ts`. Fail-soft: falha de registro nunca derruba a impressão
 * do resumo, só avisa em stderr (mesma disciplina de `register-report.ts`).
 *
 * @see scripts/lib/token-usage-summary.ts (núcleo puro + limitações documentadas)
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { computeTokenUsageSummary, formatTokenUsageSummary } from "./lib/token-usage-summary.ts";
import { registerReport, reportId } from "./studio-ui/studio-reports.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const days = values.days ? parseInt(values.days, 10) : 14;
  const thresholdPct = values["threshold-pct"] ? parseInt(values["threshold-pct"], 10) : 50;

  const result = computeTokenUsageSummary(ROOT, days, { thresholdPct });

  if (flags.has("json")) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatTokenUsageSummary(result) + "\n");
  }

  if (flags.has("register")) {
    const id = result.generatedAt.slice(0, 10); // YYYY-MM-DD — 1 relatório por dia de geração, upsert em re-runs do mesmo dia
    const dir = resolve(ROOT, "data", "token-usage", "reports");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const relPath = `data/token-usage/reports/${id}.md`;
    const absPath = resolve(ROOT, relPath);
    writeFileSync(absPath, formatTokenUsageSummary(result), "utf8");

    const alarmDays = result.days.filter((d) => d.alarm);
    const title =
      alarmDays.length > 0
        ? `Monitoramento de tokens ${id} — ${alarmDays.length} dia(s) com alarme`
        : `Monitoramento de tokens ${id}`;

    const registerResult = registerReport(ROOT, {
      kind: "token-usage",
      sessionId: id,
      title,
      htmlPath: relPath,
    });
    if (!registerResult.ok) {
      console.error(`[token-usage-summary] aviso: registro do relatório falhou (fail-soft, #3714): ${registerResult.error}`);
    } else {
      console.error(`[token-usage-summary] registrado: ${reportId("token-usage", id)} → /relatorios/${reportId("token-usage", id)}`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
