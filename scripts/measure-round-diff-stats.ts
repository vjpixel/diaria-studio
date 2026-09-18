#!/usr/bin/env npx tsx
/**
 * scripts/measure-round-diff-stats.ts (#7113)
 *
 * @one-off-validity: permanente motivo="métrica operacional contínua — mede o diff de CADA rodada autônoma pra sempre, não uma sonda pontual; nome bate com o padrão measure-* por coincidência de vocabulário, não por ser efêmero (ver #7114)"
 *
 * Roda no fim de toda rodada `/diaria-overnight`/`/diaria-develop`/
 * `/diaria-continuo` (Fase 2 — compilação do relatório, mesmo ponto onde
 * `check-overnight-token-instrumentation.ts` já roda): calcula o diff
 * `git diff --numstat {base}..{head}` da rodada inteira e persiste o
 * resultado em `data/run-log.jsonl` (evento `round_diff_stats`, ver
 * `scripts/lib/round-diff-stats.ts`).
 *
 * `{base}` é o commit-base da rodada — o coordenador grava isso no início
 * da Fase 0/1 (ex: `git rev-parse HEAD` antes do 1º dispatch); `{head}` é o
 * HEAD atual no momento da medição (default). Não é o diff de 1 PR — é o
 * diff acumulado de TODOS os merges da rodada.
 *
 * `--session-kind` aceita `overnight`, `develop`, `continuo` ou `interactive`
 * (#7292, defeito 1 — sessão interativa coordenada, protocolo de
 * `docs/coordenacao-merges.md`, passou a poder se declarar; antes só as 3
 * skills automatizadas emitiam, e a série de 7d media só metade do
 * trabalho real do repo).
 *
 * Uso:
 *   npx tsx scripts/measure-round-diff-stats.ts --base <sha> --session-kind overnight
 *   npx tsx scripts/measure-round-diff-stats.ts --base <sha> --head <sha> --session-kind develop --edition 260902
 *   npx tsx scripts/measure-round-diff-stats.ts --base <sha> --session-kind continuo --dry-run
 *   npx tsx scripts/measure-round-diff-stats.ts --base <sha> --session-kind interactive
 *
 * `--dry-run` calcula e imprime, mas NÃO grava no run-log.
 *
 * Falha ALTA (exit 1) se `--base`/`--session-kind` faltarem ou o `git diff`
 * falhar — refs de rodada são sempre locais (nunca dependem de rede/API
 * externa), então não há degradação fail-soft aqui: se não dá pra calcular,
 * é um erro real de uso do comando, não uma condição externa indisponível.
 */
import { resolve } from "node:path";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { getDiffLineStats } from "./lib/diff-line-stats.ts";
import { logEvent } from "./lib/run-log.ts";
import {
  buildRoundDiffStatsRecord,
  buildRoundDiffStatsRunLogEvent,
  isValidRoundSessionKind,
  VALID_ROUND_SESSION_KINDS,
} from "./lib/round-diff-stats.ts";

const LOG_PREFIX = "[measure-round-diff-stats]";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const base = getArg(argv, "base");
  const head = getArg(argv, "head") || "HEAD";
  const sessionKind = getArg(argv, "session-kind");
  const edition = getArg(argv, "edition") || null;
  const dryRun = hasFlag(argv, "dry-run");

  if (!base || !sessionKind) {
    console.error(`${LOG_PREFIX} uso: --base <sha> --session-kind ${VALID_ROUND_SESSION_KINDS.join("|")} [--head <sha>] [--edition AAMMDD] [--dry-run]`);
    process.exit(1);
  }
  if (!isValidRoundSessionKind(sessionKind)) {
    console.error(`${LOG_PREFIX} --session-kind inválido: '${sessionKind}' (esperado: ${VALID_ROUND_SESSION_KINDS.join(", ")})`);
    process.exit(1);
  }

  let stats;
  try {
    stats = getDiffLineStats(base, head, { cwd: resolve(process.cwd()) });
  } catch (e) {
    console.error(`${LOG_PREFIX} ${(e as Error).message}`);
    process.exit(1);
    return;
  }

  const record = buildRoundDiffStatsRecord({ sessionKind, base, head, stats });
  const ratioLabel = record.ratio === null ? "sem remoções" : `${record.ratio.toFixed(1)}:1`;
  console.log(
    `${LOG_PREFIX} ${sessionKind} ${base}..${head}: +${record.added}/-${record.removed} ` +
      `(${record.files} arquivo(s), razão ${ratioLabel}, líquido ${record.net >= 0 ? "+" : ""}${record.net})`,
  );

  if (dryRun) {
    console.log(`${LOG_PREFIX} --dry-run: nada persistido.`);
    return;
  }

  logEvent(buildRoundDiffStatsRunLogEvent(record, edition));
  console.log(`${LOG_PREFIX} evento round_diff_stats persistido em data/run-log.jsonl.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro inesperado: ${(e as Error).message}`);
    process.exit(1);
  });
}
