#!/usr/bin/env node
/**
 * scripts/voto-tema-marcar-revisado.ts (#11199)
 *
 * Grava em `data/artigo-especial/votacao/{aamm}/ballot.json` o marcador
 * `revisado: { humanizador, clarice, em, hash }` que
 * `publish-voto-tema-kit.ts --push` exige antes de criar o rascunho no Kit.
 * Rodar DEPOIS de passar Humanizador (skill `humanizador`, rubric completo) e
 * Clarice (`mcp__clarice__correct_text`, aceitando as sugestões) no texto da
 * cédula e gravar o resultado em `ballot.json`.
 *
 * As duas flags são obrigatórias e funcionam como atestado explícito de cada
 * passada — o script não roda Humanizador nem Clarice. O hash cobre o texto
 * que chega ao leitor, então qualquer edição da cédula depois deste comando
 * invalida o marcador (ver `scripts/lib/voto-tema-revisao.ts`).
 *
 * Uso:
 *   npx tsx scripts/voto-tema-marcar-revisado.ts --ciclo 2611 --humanizador --clarice
 *   npx tsx scripts/voto-tema-marcar-revisado.ts --ciclo 2611 --check   # só confere, não grava
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasFlag, isMainModule, getStringArg } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { parseCicloVotacao, validarCedula } from "../workers/artigos/src/voto-tema-core.ts";
import { VotoTemaGuardError } from "./lib/voto-tema-channel.ts";
import { buildRevisaoMarker, checkRevisao, type CedulaTexto } from "./lib/voto-tema-revisao.ts";
import { ballotInputPath } from "./voto-tema-open.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[voto-tema-marcar-revisado]";

export interface MarcarOptions {
  ciclo: string;
  dataDir: string;
  humanizador: boolean;
  clarice: boolean;
  checkOnly: boolean;
  now: Date;
  log: (msg: string) => void;
}

export function marcarRevisado(options: MarcarOptions): void {
  const { ciclo: rawCiclo, dataDir, humanizador, clarice, checkOnly, now, log } = options;
  const ciclo = parseCicloVotacao(rawCiclo);
  if (!ciclo) throw new VotoTemaGuardError(`--ciclo "${rawCiclo}" inválido — precisa ser AAMM.`);
  const path = ballotInputPath(dataDir, ciclo);
  if (!existsSync(path)) throw new VotoTemaGuardError(`${path} ausente — escreva a cédula antes de marcá-la como revisada.`);
  const ballot = JSON.parse(readFileSync(path, "utf8")) as CedulaTexto & Record<string, unknown>;

  if (checkOnly) {
    const r = checkRevisao(ballot, null);
    if (!r.ok) throw new VotoTemaGuardError(r.reason);
    log(`ciclo ${ciclo}: cédula revisada em ${r.marker.em} (hash confere com ballot.json).`);
    return;
  }

  if (!humanizador || !clarice) {
    throw new VotoTemaGuardError(
      "passe --humanizador E --clarice — cada flag atesta que a passada correspondente foi feita no texto atual da cédula.",
    );
  }
  const validation = validarCedula(ballot, { exigirPrazo: true });
  if (!validation.ok) throw new VotoTemaGuardError(`cédula inválida (${path}): ${validation.reason}`);

  const marker = buildRevisaoMarker(ballot, now);
  writeFileAtomic(path, JSON.stringify({ ...ballot, revisado: marker }, null, 2) + "\n");
  log(`ciclo ${ciclo}: marcador "revisado" gravado (em ${marker.em}, hash ${marker.hash.slice(0, 12)}…).`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const ciclo = getStringArg(argv, "ciclo", { example: "2611" });
  if (!ciclo) {
    process.stderr.write("Uso: npx tsx scripts/voto-tema-marcar-revisado.ts --ciclo AAMM --humanizador --clarice | --check\n");
    process.exit(2);
  }
  try {
    marcarRevisado({
      ciclo,
      dataDir: resolve(ROOT, "data"),
      humanizador: hasFlag(argv, "humanizador"),
      clarice: hasFlag(argv, "clarice"),
      checkOnly: hasFlag(argv, "check"),
      now: new Date(),
      log: (msg) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`),
    });
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} ${(e as Error).message}\n`);
    process.exit(e instanceof VotoTemaGuardError ? 2 : 1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
