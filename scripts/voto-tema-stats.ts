#!/usr/bin/env node
/**
 * scripts/voto-tema-stats.ts (#8371)
 *
 * Placar da votação a qualquer momento — lê `tema:ballot:{aamm}` +
 * apura contra `tema:vote:{aamm}:*` (ou lê `tema:result:{aamm}` se a
 * votação já foi fechada). Só leitura, nenhum guard de publicação se aplica.
 *
 * Uso:
 *   npx tsx scripts/voto-tema-stats.ts --ciclo 2610
 *   npx tsx scripts/voto-tema-stats.ts --ciclo 2610 --json
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule, getStringArg } from "./lib/cli-args.ts";
import { apurar, parseCicloVotacao } from "../workers/artigos/src/voto-tema-core.ts";
import {
  VotoTemaGuardError,
  listVotosFromKv,
  readBallotFromKv,
  readResultFromKv,
  resolveVotoTemaKvConfig,
} from "./lib/voto-tema-channel.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[voto-tema-stats]";

export interface VotoTemaStats {
  ciclo: string;
  fechado: boolean;
  total: number;
  eleitorado: number;
  opcoes: { n: number; titulo: string; votos: number; pct: number }[];
  vencedor: number | null;
  empate: boolean;
}

export async function computeStats(ciclo: string): Promise<VotoTemaStats> {
  const kvConfig = resolveVotoTemaKvConfig();
  const ballot = await readBallotFromKv(ciclo, kvConfig);
  if (!ballot) throw new VotoTemaGuardError(`ciclo ${ciclo}: nenhuma cédula gravada (tema:ballot:${ciclo} ausente).`);

  const resultado = await readResultFromKv(ciclo, kvConfig);
  const apuracao = resultado
    ? { opcoes: resultado.contagem, total: resultado.total, vencedor: resultado.vencedor, empate: resultado.empate }
    : apurar(ballot, await listVotosFromKv(ciclo, kvConfig));

  return {
    ciclo,
    fechado: !!resultado,
    total: apuracao.total,
    eleitorado: ballot.eleitores.length,
    opcoes: apuracao.opcoes.map((o) => ({
      ...o,
      pct: apuracao.total > 0 ? Math.round((o.votos / apuracao.total) * 100) : 0,
    })),
    vencedor: apuracao.vencedor,
    empate: apuracao.empate,
  };
}

function printHuman(stats: VotoTemaStats, log: (m: string) => void): void {
  log(`ciclo ${stats.ciclo} — ${stats.fechado ? "FECHADA" : "aberta"}`);
  log(`${stats.total} de ${stats.eleitorado} apoiador(es) votaram.`);
  for (const o of stats.opcoes) log(`  opção ${o.n} — ${o.titulo}: ${o.votos} voto(s) (${o.pct}%)`);
  if (stats.empate) log("EMPATE — sem vencedor automático.");
  else if (stats.vencedor !== null) log(`vencedor atual: opção ${stats.vencedor}`);
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const cicloRaw = getStringArg(argv, "ciclo", { example: "2610" });
  if (!cicloRaw) {
    process.stderr.write("Uso: npx tsx scripts/voto-tema-stats.ts --ciclo AAMM [--json]\n");
    process.exit(2);
  }
  const ciclo = parseCicloVotacao(cicloRaw);
  if (!ciclo) {
    process.stderr.write(`${LOG_PREFIX} --ciclo "${cicloRaw}" inválido — precisa ser AAMM (4 dígitos).\n`);
    process.exit(2);
  }
  try {
    const stats = await computeStats(ciclo as string);
    if (hasFlag(argv, "json")) {
      process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
    } else {
      printHuman(stats, (m) => process.stderr.write(`${LOG_PREFIX} ${m}\n`));
    }
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} ${(e as Error).message}\n`);
    process.exit(e instanceof VotoTemaGuardError ? 2 : 1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
