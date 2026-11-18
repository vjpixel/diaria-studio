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
 * Sem `--head`, faz `git fetch origin` e mede contra `origin/master` quando
 * HEAD está atrás dele (#13425 — senão a rodada vira `+0/-0` falso); se o
 * fetch falha e HEAD está atrás do `origin/master` local, recusa.
 *
 * Também falha ALTA (exit 1, nada persistido, inclusive em `--dry-run`)
 * quando `--base` não é ancestral de `--head` (#10422) — o diff sairia
 * invertido. Ver o comentário no ponto da checagem.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { checkIsAncestor, getDiffLineStats } from "./lib/diff-line-stats.ts";
import { logEvent } from "./lib/run-log.ts";
import {
  buildRoundDiffStatsRecord,
  buildRoundDiffStatsRunLogEvent,
  isValidRoundSessionKind,
  VALID_ROUND_SESSION_KINDS,
} from "./lib/round-diff-stats.ts";

const LOG_PREFIX = "[measure-round-diff-stats]";
const REMOTE_HEAD = "origin/master";

/**
 * #13425: sem `--head` explícito, o HEAD do checkout pode estar parado na
 * própria base (ff recusado por sujeira de outra sessão) ou atrás do que a
 * rodada mergeou — `base..HEAD` daria `+0/-0` falso. Faz `git fetch origin`
 * e, se HEAD é ancestral ESTRITO de `origin/master`, mede contra ele. Se o
 * fetch falha e o `origin/master` local (possivelmente defasado) está à
 * frente de HEAD, recusa em vez de gravar zero falso; fetch falho sem nada à
 * frente só avisa.
 */
export function resolveDefaultHead(cwd: string): { head: string; error?: string } {
  const git = (args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
  const fetch = git(["fetch", "--quiet", "origin"]);
  const fetchOk = fetch.status === 0;
  if (git(["rev-parse", "--verify", "--quiet", REMOTE_HEAD]).status !== 0) {
    if (!fetchOk) console.warn(`${LOG_PREFIX} aviso: git fetch origin falhou e ${REMOTE_HEAD} não existe; medindo contra HEAD.`);
    return { head: "HEAD" };
  }
  const same = git(["rev-parse", "HEAD"]).stdout.trim() === git(["rev-parse", REMOTE_HEAD]).stdout.trim();
  const behind = !same && git(["merge-base", "--is-ancestor", "HEAD", REMOTE_HEAD]).status === 0;
  if (behind && fetchOk) {
    console.warn(`${LOG_PREFIX} aviso: HEAD está atrás de ${REMOTE_HEAD}; medindo contra ${REMOTE_HEAD}.`);
    return { head: REMOTE_HEAD };
  }
  if (behind) {
    return {
      head: "HEAD",
      error: `git fetch origin falhou (${String(fetch.stderr ?? "").trim() || `exit ${fetch.status}`}) e HEAD está atrás de ${REMOTE_HEAD} (local, possivelmente defasado); ` +
        `o diff subestimaria a rodada. Corrija o acesso ao remoto ou passe --head explícito.`,
    };
  }
  if (!fetchOk) console.warn(`${LOG_PREFIX} aviso: git fetch origin falhou; ${REMOTE_HEAD} local pode estar defasado.`);
  return { head: "HEAD" };
}

async function main(): Promise<number | void> {
  const argv = process.argv.slice(2);
  const base = getArg(argv, "base");
  const explicitHead = getArg(argv, "head");
  const sessionKind = getArg(argv, "session-kind");
  const edition = getArg(argv, "edition") || null;
  const dryRun = hasFlag(argv, "dry-run");

  if (!base || !sessionKind) {
    console.error(`${LOG_PREFIX} uso: --base <sha> --session-kind ${VALID_ROUND_SESSION_KINDS.join("|")} [--head <sha>] [--edition AAMMDD] [--dry-run]`);
    return 1;
  }
  if (!isValidRoundSessionKind(sessionKind)) {
    console.error(`${LOG_PREFIX} --session-kind inválido: '${sessionKind}' (esperado: ${VALID_ROUND_SESSION_KINDS.join(", ")})`);
    return 1;
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
  let head = explicitHead || "HEAD";
  if (!explicitHead) {
    const resolved = resolveDefaultHead(cwd);
    if (resolved.error) {
      console.error(`${LOG_PREFIX} recusado, nada persistido: ${resolved.error}`);
      return 1;
    }
    head = resolved.head;
  }
  const ancestry = checkIsAncestor(base, head, { cwd });
  if (ancestry.verdict !== "ancestor") {
    const why =
      ancestry.verdict === "not-ancestor"
        ? `--base ${base} não é ancestral de ${head} — o checkout está atrás da base (ou divergiu); ` +
          `o diff sairia invertido. Atualize o checkout (git fetch && git merge --ff-only) ou passe --head origin/master.`
        : `não foi possível verificar se ${base} é ancestral de ${head}: ${ancestry.detail}`;
    console.error(`${LOG_PREFIX} recusado, nada persistido: ${why}`);
    return 1;
  }

  let stats;
  try {
    stats = getDiffLineStats(base, head, { cwd });
  } catch (e) {
    console.error(`${LOG_PREFIX} ${(e as Error).message}`);
    return 1;
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
  runCli(main, { onError: (e) => console.error(`${LOG_PREFIX} erro inesperado: ${(e as Error).message}`) });
}
