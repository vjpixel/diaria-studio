#!/usr/bin/env node
/**
 * scripts/voto-tema-close.ts (#8371)
 *
 * Fecha um ciclo de votação: apura o resultado final e grava
 * `tema:result:{aamm}` no KV + `data/artigo-especial/votacao/{aamm}/result.json`
 * (espelho local, legível sem precisar de credencial Cloudflare).
 *
 * Depois de fechado, o worker (`voto-tema.ts`) passa a servir o placar a
 * partir do `tema:result:*` gravado aqui (congelado) em vez de recalcular a
 * cada request, e `POST /votacao/{ciclo}/{n}` passa a recusar novos votos
 * (409 "closed").
 *
 * EMPATE NÃO É RESOLVIDO AUTOMATICAMENTE (decisão do editor, ver corpo da
 * #8371) — o script recusa gravar `tema:result` quando `apuracao.empate` é
 * `true` e sai com exit 3 (distinto de erro de config/uso), reportando o
 * empate pra decisão editorial. Rodar de novo com `--forcar-vencedor N`
 * depois que o editor decidir.
 *
 * Uso:
 *   npx tsx scripts/voto-tema-close.ts --ciclo 2610 --dry-run
 *   npx tsx scripts/voto-tema-close.ts --ciclo 2610 --push
 *   npx tsx scripts/voto-tema-close.ts --ciclo 2610 --push --forcar-vencedor 2   # após decisão editorial de empate
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { hasFlag, isMainModule, getStringArg } from "./lib/cli-args.ts";
import { parseCicloVotacao } from "../workers/artigos/src/voto-tema-core.ts";
import { VotoTemaGuardError, resolveVotoTemaKvConfig, writeResultToKv, type ResultadoFinal } from "./lib/voto-tema-channel.ts";
import { computeStats } from "./voto-tema-stats.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[voto-tema-close]";

export function resultLocalPath(dataDir: string, ciclo: string): string {
  return resolve(dataDir, "artigo-especial", "votacao", ciclo, "result.json");
}

/** Empate de votação — sinaliza pro CLI usar `exit 3` (nem erro de uso/config
 *  como as demais `VotoTemaGuardError`, nem erro fatal — é um estado válido
 *  que exige decisão humana antes de prosseguir). */
export class VotoTemaEmpateError extends Error {}

export interface RunOptions {
  ciclo: string;
  dataDir: string;
  dryRun: boolean;
  forcarVencedor: number | null;
  log: (msg: string) => void;
}

export async function run(options: RunOptions): Promise<void> {
  const { ciclo: rawCiclo, dataDir, dryRun, forcarVencedor, log } = options;
  const ciclo = parseCicloVotacao(rawCiclo);
  if (!ciclo) throw new VotoTemaGuardError(`--ciclo "${rawCiclo}" inválido — precisa ser AAMM.`);

  const stats = await computeStats(ciclo);
  if (stats.fechado) {
    log(`ciclo ${ciclo} já está fechado (vencedor: ${stats.vencedor ?? "empate"}). Nada a fazer.`);
    return;
  }

  let vencedor = stats.vencedor;
  if (stats.empate) {
    if (forcarVencedor === null) {
      log(`EMPATE — opções no topo: ${stats.opcoes.filter((o) => o.votos === Math.max(...stats.opcoes.map((x) => x.votos))).map((o) => `${o.n} (${o.titulo})`).join(", ")}.`);
      throw new VotoTemaEmpateError(
        `empate na votação (ciclo ${ciclo}) — decisão editorial necessária. Rode de novo com ` +
          "--forcar-vencedor N depois de decidir.",
      );
    }
    if (!stats.opcoes.some((o) => o.n === forcarVencedor)) {
      throw new VotoTemaGuardError(`--forcar-vencedor ${forcarVencedor} não é uma opção válida desta cédula.`);
    }
    vencedor = forcarVencedor;
  }

  const resultado: ResultadoFinal = {
    vencedor,
    empate: stats.empate && forcarVencedor === null,
    contagem: stats.opcoes.map(({ n, titulo, votos }) => ({ n, titulo, votos })),
    total: stats.total,
    fechado_em: new Date().toISOString(),
  };

  if (dryRun) {
    log(`[DRY RUN] fecharia o ciclo ${ciclo} com vencedor=${vencedor ?? "null"} (${stats.total} votos).`);
    return;
  }

  const kvConfig = resolveVotoTemaKvConfig();
  await writeResultToKv(ciclo, resultado, kvConfig);
  writeFileAtomic(resultLocalPath(dataDir, ciclo), JSON.stringify(resultado, null, 2) + "\n");
  log(`ciclo ${ciclo} fechado. Vencedor: opção ${vencedor} (${stats.total} votos totais).`);
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const ciclo = getStringArg(argv, "ciclo", { example: "2610" });
  if (!ciclo) {
    process.stderr.write("Uso: npx tsx scripts/voto-tema-close.ts --ciclo AAMM [--dry-run|--push] [--forcar-vencedor N]\n");
    process.exit(2);
  }
  const forcarRaw = getStringArg(argv, "forcar-vencedor");
  const forcarVencedor = forcarRaw ? Number(forcarRaw) : null;
  try {
    await run({
      ciclo,
      dataDir: resolve(ROOT, "data"),
      dryRun: !hasFlag(argv, "push"),
      forcarVencedor: Number.isInteger(forcarVencedor) ? forcarVencedor : null,
      log: (msg) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`),
    });
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} ${(e as Error).message}\n`);
    if (e instanceof VotoTemaEmpateError) process.exit(3);
    process.exit(e instanceof VotoTemaGuardError ? 2 : 1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
