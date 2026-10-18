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
 *
 * Também falha ALTA (exit 1, nada persistido, inclusive em `--dry-run`)
 * quando `--base` não é ancestral de `--head` (#10422) — o diff sairia
 * invertido. Ver o comentário no ponto da checagem.
 */
import { resolve } from "node:path";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { checkIsAncestor, getDiffLineStats } from "./lib/diff-line-stats.ts";
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

  // #10422: `base` precisa ser ancestral de `head`. Se o checkout local está
  // ATRÁS da base (ex: `git pull` falhou por sujeira de outra sessão), o
  // `git diff base..head` não erra — devolve o diff INVERTIDO, e persistir
  // isso contamina a série de 7d. Escolhido checar ancestralidade em vez de
  // medir contra `origin/master`: `origin/master` local também pode estar
  // defasado (sem fetch) e não é o HEAD que a rodada de fato produziu —
  // a ancestralidade é o invariante que torna `base..head` uma medida válida
  // em qualquer cenário, e recusar é melhor que adivinhar outra ref.
  const cwd = resolve(process.cwd());
  const ancestry = checkIsAncestor(base, head, { cwd });
  if (ancestry.verdict !== "ancestor") {
    const why =
      ancestry.verdict === "not-ancestor"
        ? `--base ${base} não é ancestral de ${head} — o checkout está atrás da base (ou divergiu); ` +
          `o diff sairia invertido. Atualize o checkout (git fetch && git merge --ff-only) ou passe --head origin/master.`
        : `não foi possível verificar se ${base} é ancestral de ${head}: ${ancestry.detail}`;
    console.error(`${LOG_PREFIX} recusado, nada persistido: ${why}`);
    process.exit(1);
    return;
  }

  let stats;
  try {
    stats = getDiffLineStats(base, head, { cwd });
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
