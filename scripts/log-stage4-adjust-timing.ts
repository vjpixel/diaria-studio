#!/usr/bin/env npx tsx
/**
 * log-stage4-adjust-timing.ts (#8123 Fatia 5)
 *
 * CLI fino sobre `scripts/lib/stage4-adjust-timing.ts` (cálculo puro) +
 * `scripts/lib/run-log.ts#logEvent` (persistência). Chamado pelo
 * orchestrator no loop "ajustar" do Stage 4 (§4d.1 de
 * `.claude/agents/orchestrator-stage-4.md`) uma vez por ajuste concluído —
 * seja pelo fast path (Fatia 2) ou pelo fluxo completo — logo depois que o
 * preview foi re-servido, pra medir pedido→edição-em-disco,
 * edição→preview-servido e o nº de chamadas de ferramenta até lá.
 *
 * Uso:
 *   npx tsx scripts/log-stage4-adjust-timing.ts \
 *     --edition 260418 \
 *     --requested-at 2026-09-17T12:00:00.000Z \
 *     --edited-at 2026-09-17T12:00:02.500Z \
 *     --preview-served-at 2026-09-17T12:00:07.000Z \
 *     --calls 3 \
 *     [--description "troca título D2"]
 *
 * `--root-dir` (opcional) sobrepõe o `rootDir` passado a `logEvent` —
 * existe pra tests apontarem o run-log pra um tmpdir isolado (mesmo
 * parâmetro que `scripts/lib/run-log.ts#logEvent` já expõe pra esse fim);
 * em produção o orchestrator nunca passa essa flag e o CLI usa `process.cwd()`.
 *
 * Nunca lança pro caller: logging não pode bloquear o loop do gate. Erro de
 * parsing/validação sai em stderr com exit 2 (o orchestrator decide se
 * ignora — a instrumentação é best-effort, não gate-blocking); falha na
 * escrita do log em si (I/O) já é engolida por `logEvent` (mesmo contrato
 * do resto do projeto). Sempre imprime o JSON das métricas em stdout
 * quando o cálculo teve sucesso, pra o orchestrator poder citar o número
 * na resposta ao editor sem reabrir o run-log.
 */

import { computeAdjustTimingMetrics } from "./lib/stage4-adjust-timing.ts";
import { logEvent } from "./lib/run-log.ts";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        out[key] = "true";
      } else {
        out[key] = val;
        i++;
      }
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!args.edition) {
    console.error("--edition é obrigatório");
    process.exitCode = 2;
    return;
  }
  if (!args["requested-at"] || !args["edited-at"] || !args["preview-served-at"]) {
    console.error("--requested-at, --edited-at e --preview-served-at são obrigatórios");
    process.exitCode = 2;
    return;
  }
  if (args.calls === undefined) {
    console.error("--calls é obrigatório");
    process.exitCode = 2;
    return;
  }
  const calls = Number(args.calls);
  if (!Number.isInteger(calls) || calls < 0) {
    console.error(`--calls deve ser um inteiro ≥ 0 (recebeu ${JSON.stringify(args.calls)})`);
    process.exitCode = 2;
    return;
  }

  let metrics;
  try {
    metrics = computeAdjustTimingMetrics({
      requestedAt: args["requested-at"],
      editedAt: args["edited-at"],
      previewServedAt: args["preview-served-at"],
      toolCalls: calls,
    });
  } catch (err) {
    console.error(`stage4-adjust-timing: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }

  logEvent(
    {
      edition: args.edition,
      stage: 4,
      agent: "orchestrator",
      level: metrics.withinTarget10s ? "info" : "warn",
      message: `gate revisao: timing do ajustar (${args.description ?? "sem descrição"})`,
      details: {
        description: args.description ?? null,
        ...metrics,
      },
    },
    args["root-dir"] ?? process.cwd(),
  );

  console.log(JSON.stringify(metrics));
}

main();
