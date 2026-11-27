#!/usr/bin/env node
/**
 * scripts/edicao-agendada/setup-edicao-schedule-systemd.ts (#4998, reativação do #2068/#3259)
 *
 * Gera o par `.service`/`.timer` (systemd "user units") da edição diária
 * agendada — par Linux do `scripts/edicao-agendada/setup-edicao-schedule.ps1`
 * (Windows Task Scheduler), no mesmo espírito de
 * `scripts/overnight/setup-watchdog-schedule-systemd.ts` (fora do registry,
 * ver decisão documentada em `scripts/lib/edicao-systemd-units.ts`).
 *
 * Este script SÓ ESCREVE ARQUIVOS EM DISCO — nunca chama `systemctl`. O único
 * subprocesso é `<node> --version`, para conferir o node do `ExecStart=`
 * (#13151). ARMAR (copiar pra `~/.config/systemd/user/` +
 * `systemctl --user enable --now`) é ação humana explícita na máquina real.
 *
 * **Armar/desarmar: `scripts/edicao-agendada/arm-edicao-schedule-systemd.ts
 * --arm|--disarm` (#7036), nunca `systemctl` direto.** Este gerador não vê o
 * momento em que o timer é armado; o wrapper roda o `systemctl --user
 * enable|disable --now` E publica a atestação cross-machine
 * (`scripts/lib/edicao-schedule-attestation.ts`) que o alarme
 * `edicao-diaria-staleness-alarm.ts` lê. `systemctl` digitado à mão arma
 * sem publicar nada — o alarme de outra máquina não fica sabendo.
 *
 * Uso:
 *   npx tsx scripts/edicao-agendada/setup-edicao-schedule-systemd.ts [--out-dir <dir>] [--node-bin <path>]
 *
 * --out-dir: relativo à raiz do repo (default: ".systemd-units/" — mesmo
 *            diretório usado pelas outras gerações de unit, git-ignorado).
 *
 * --node-bin: node absoluto do `ExecStart=` (também `DIARIA_SYSTEMD_NODE_BIN`).
 *
 * Node do `ExecStart=` (#13151): até aqui o gerador embutia `process.execPath`
 * (o Node que RODOU este comando) e só avisava quando ele estava abaixo do
 * piso — por `ssh` não-interativo isso dá `/usr/bin/node`. Agora o node vem de
 * `resolveCheckedSystemdNodeBinary` (`--node-bin` → nvm do `.nvmrc` → processo,
 * se ele casar com o `.nvmrc`), o mesmo caminho de `setup-systemd-timers.ts`
 * desde o #13136; sem node que case, ou abaixo do piso, o CLI recusa (exit 1).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, isMainModule } from "../lib/cli-args.ts";
import { resolveCheckedSystemdNodeBinary, type CheckedNodeBinaryDeps } from "../lib/systemd-node-binary-checked.ts";
import { buildEdicaoSystemdUnitFiles, EDICAO_UNIT_NAME } from "../lib/edicao-systemd-units.ts";

const DEFAULT_OUT_DIR = ".systemd-units";

/**
 * Escreve o par `.service`/`.timer` da edição diária em `outDirAbs` (criado
 * se necessário). Retorna os paths absolutos escritos, `[service, timer]`.
 * Nunca chama `systemctl` — só filesystem.
 */
export function generateEdicaoSystemdUnits(
  repoRootAbs: string,
  outDirAbs: string,
  nodeBin: string = process.execPath,
): string[] {
  mkdirSync(outDirAbs, { recursive: true });
  const { serviceFileName, timerFileName, serviceContent, timerContent } = buildEdicaoSystemdUnitFiles(
    repoRootAbs,
    nodeBin,
  );
  const servicePath = join(outDirAbs, serviceFileName);
  const timerPath = join(outDirAbs, timerFileName);
  writeFileSync(servicePath, serviceContent, "utf8");
  writeFileSync(timerPath, timerContent, "utf8");
  return [servicePath, timerPath];
}

/**
 * Instruções de armamento impressas após gerar. Armar passa pelo wrapper
 * `arm-edicao-schedule-systemd.ts` (#7036) — `systemctl --user enable --now`
 * direto arma sem publicar a atestação cross-machine.
 */
export function buildEdicaoArmInstructions(outDirAbs: string): string {
  return (
    "\nARMAR (ação manual na máquina real, fora do escopo desta geração):\n" +
    "  mkdir -p ~/.config/systemd/user\n" +
    `  cp ${outDirAbs}/${EDICAO_UNIT_NAME}.service ${outDirAbs}/${EDICAO_UNIT_NAME}.timer ~/.config/systemd/user/\n` +
    "  systemctl --user daemon-reload\n" +
    "  npx tsx scripts/edicao-agendada/arm-edicao-schedule-systemd.ts --arm   # nunca `systemctl enable` direto (#7036)\n" +
    "\nVerificar depois de armado:\n" +
    `  systemctl --user list-timers ${EDICAO_UNIT_NAME}.timer\n`
  );
}

export function main(argv: string[], repoRootAbs: string, deps: CheckedNodeBinaryDeps = {}): number {
  let outDirArg: string | undefined;
  let nodeBinArg: string | undefined;
  try {
    outDirArg = getStringArg(argv, "out-dir", { example: DEFAULT_OUT_DIR });
    nodeBinArg = getStringArg(argv, "node-bin", { example: "/home/vjpixel/.nvm/versions/node/v24.19.0/bin/node" });
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }

  // #13151: node do ExecStart determinístico (nvm do .nvmrc), como em
  // setup-systemd-timers.ts desde o #13136. Sem node que case, recusa.
  let nodeBin: string;
  try {
    const resolved = resolveCheckedSystemdNodeBinary(nodeBinArg, deps);
    nodeBin = resolved.path;
    console.log(`node do ExecStart: ${resolved.path} (${resolved.version}, origem: ${resolved.source})`);
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }

  const outDirAbs = resolve(repoRootAbs, outDirArg ?? DEFAULT_OUT_DIR);
  const written = generateEdicaoSystemdUnits(repoRootAbs, outDirAbs, nodeBin);

  console.log(`Edição diária agendada (#2068) -> ${written.length} arquivo(s) gerado(s) em ${outDirAbs}:\n`);
  for (const p of written) console.log(`  ${p}`);
  console.log(buildEdicaoArmInstructions(outDirAbs));

  return 0;
}

/** Entrada de CLI. Exportada para o shim do caminho antigo
 * (`scripts/overnight/setup-edicao-schedule-systemd.ts`, #14121). */
export function runCli(): never {
  const repoRootAbs = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  process.exit(main(process.argv.slice(2), repoRootAbs));
}

if (isMainModule(import.meta.url)) runCli();
