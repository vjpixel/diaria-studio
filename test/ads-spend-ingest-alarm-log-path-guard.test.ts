/**
 * test/ads-spend-ingest-alarm-log-path-guard.test.ts (#7518 item 3)
 *
 * Guard contra a REPETIÇÃO da classe de bug desta issue: o alarme
 * `Diaria-Ads-Spend-Ingest-Alarm` (`scripts/ads-spend-ingest-alarm.ts`)
 * apontava pra um `logPath` (`data/aquisicao/.ads-spend-ingest.log`) que
 * NENHUMA task do registro grava — a convenção original assumia uma task
 * unificada (`Diaria-Ads-Spend-Ingest`) que nunca chegou a existir. O
 * alarme nunca leu run nenhum, sempre reportou `alarm-no-run` pelo motivo
 * errado, e nunca detectou um defeito real em produção.
 *
 * Este teste garante que os 2 paths que o alarme lê hoje
 * (`DEFAULT_GOOGLE_LOG_PATH`/`DEFAULT_MICROSOFT_LOG_PATH`, exportados de
 * `scripts/ads-spend-ingest-alarm.ts`) correspondem EXATAMENTE ao
 * `logPath` das 2 tasks reais que gravam esses logs
 * (`Diaria-Google-Ads-Spend-Ingest`/`Diaria-Microsoft-Ads-Spend-Ingest` em
 * `scripts/lib/scheduled-tasks.ts`) — se algum dos dois arquivos mudar o
 * path sem o outro acompanhar, este teste falha ANTES do alarme voltar a
 * ler silenciosamente um arquivo fantasma.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";
import { DEFAULT_GOOGLE_LOG_PATH, DEFAULT_MICROSOFT_LOG_PATH } from "../scripts/ads-spend-ingest-alarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Mesma resolução que `scripts/lib/task-runner.ts` usa pra transformar
 *  `ScheduledTaskDefinition.logPath` (relativo a `data/`, sem `data/`
 *  embutido) num path absoluto — `join(rootDir, "data", ...logPath.split("/"))`. */
function resolveTaskLogPath(logPath: string): string {
  return join(ROOT, "data", ...logPath.split("/"));
}

function findTask(name: string) {
  const task = SCHEDULED_TASKS.find((t) => t.name === name);
  assert.ok(task, `task ${name} não encontrada em SCHEDULED_TASKS — renomeada ou removida?`);
  return task!;
}

describe("ads-spend-ingest-alarm — path guard (#7518)", () => {
  it("DEFAULT_GOOGLE_LOG_PATH bate com o logPath real de Diaria-Google-Ads-Spend-Ingest", () => {
    const task = findTask("Diaria-Google-Ads-Spend-Ingest");
    assert.equal(DEFAULT_GOOGLE_LOG_PATH, resolveTaskLogPath(task.logPath));
  });

  it("DEFAULT_MICROSOFT_LOG_PATH bate com o logPath real de Diaria-Microsoft-Ads-Spend-Ingest", () => {
    const task = findTask("Diaria-Microsoft-Ads-Spend-Ingest");
    assert.equal(DEFAULT_MICROSOFT_LOG_PATH, resolveTaskLogPath(task.logPath));
  });

  it("os 2 paths são DIFERENTES entre si — nunca colapsam pro mesmo arquivo (cada plataforma tem log próprio)", () => {
    assert.notEqual(DEFAULT_GOOGLE_LOG_PATH, DEFAULT_MICROSOFT_LOG_PATH);
  });

  it("nenhum dos 2 paths é o log unificado fantasma que causou o bug original (.ads-spend-ingest.log)", () => {
    assert.doesNotMatch(DEFAULT_GOOGLE_LOG_PATH, /\.ads-spend-ingest\.log$/);
    assert.doesNotMatch(DEFAULT_MICROSOFT_LOG_PATH, /\.ads-spend-ingest\.log$/);
  });
});
