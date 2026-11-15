#!/usr/bin/env node
/**
 * scripts/overnight/setup-watchdog-schedule-systemd.ts (#4857, épica #4798)
 *
 * Gera o par `.service`/`.timer` (systemd "user units") do watchdog overnight
 * (#2688) — par Linux do `scripts/overnight/setup-watchdog-schedule.ps1`
 * (Windows Task Scheduler), no mesmo espírito de
 * `scripts/setup-systemd-timers.ts` (#4805 Fase 3) mas fora do registry (ver
 * decisão documentada em `scripts/lib/watchdog-systemd-units.ts`).
 *
 * Este script SÓ ESCREVE ARQUIVOS EM DISCO — nunca chama `systemctl` (mesma
 * garantia de `scripts/setup-systemd-timers.ts`, verificada em
 * `test/watchdog-systemd-units.test.ts`). O único subprocesso é
 * `<node> --version`, para conferir o node do `ExecStart=` (#13151). ARMAR (copiar pra `~/.config/systemd/user/` +
 * `systemctl --user enable --now`) é ação humana na máquina real — esta
 * unidade (worktree isolado, #4857) não toca o systemd real de `300`,
 * onde o watchdog já foi armado manualmente em 260810 (ver comentário de
 * fechamento da issue).
 *
 * Uso:
 *   npx tsx scripts/overnight/setup-watchdog-schedule-systemd.ts [--out-dir <dir>] [--node-bin <path>]
 *
 * --out-dir: relativo à raiz do repo (default: ".systemd-units/" — MESMO
 *            diretório que `scripts/setup-systemd-timers.ts` usa pras 14
 *            tasks do registry, git-ignorado — permite copiar tudo de uma
 *            vez pra `~/.config/systemd/user/`).
 *
 * --node-bin: node absoluto do `ExecStart=` (também `DIARIA_SYSTEMD_NODE_BIN`).
 *
 * **Node do `ExecStart=` (#13151; achado ao vivo #4857, reconciliação 260810).**
 * Até o #13151 o gerador embutia `process.execPath`, o Node que RODOU este
 * comando: um shell de agente sem o Node do projeto no PATH gerou
 * `ExecStart=/usr/bin/node` (Node 20, mesmo binário do incidente #4823), e o
 * CLI só avisava. Agora o node vem de `resolveCheckedSystemdNodeBinary`
 * (`--node-bin` → nvm do `.nvmrc` → processo, se ele casar com o `.nvmrc`), o
 * mesmo caminho de `setup-systemd-timers.ts` desde o #13136; sem node que
 * case, ou abaixo do piso, o CLI recusa (exit 1) em vez de gerar.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, isMainModule } from "../lib/cli-args.ts";
import { resolveCheckedSystemdNodeBinary, type CheckedNodeBinaryDeps } from "../lib/systemd-node-binary-checked.ts";
import { buildWatchdogSystemdUnitFiles, WATCHDOG_UNIT_NAME } from "../lib/watchdog-systemd-units.ts";

const DEFAULT_OUT_DIR = ".systemd-units";

/**
 * Escreve o par `.service`/`.timer` do watchdog em `outDirAbs` (criado se
 * necessário). Retorna os paths absolutos escritos, `[service, timer]`.
 * Nunca chama `systemctl` — só filesystem.
 */
export function generateWatchdogSystemdUnits(
  repoRootAbs: string,
  outDirAbs: string,
  nodeBin: string = process.execPath,
): string[] {
  mkdirSync(outDirAbs, { recursive: true });
  const { serviceFileName, timerFileName, serviceContent, timerContent } = buildWatchdogSystemdUnitFiles(
    repoRootAbs,
    nodeBin,
  );
  const servicePath = join(outDirAbs, serviceFileName);
  const timerPath = join(outDirAbs, timerFileName);
  writeFileSync(servicePath, serviceContent, "utf8");
  writeFileSync(timerPath, timerContent, "utf8");
  return [servicePath, timerPath];
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
  const written = generateWatchdogSystemdUnits(repoRootAbs, outDirAbs, nodeBin);

  console.log(`Watchdog overnight (#2688) -> ${written.length} arquivo(s) gerado(s) em ${outDirAbs}:\n`);
  for (const p of written) console.log(`  ${p}`);
  console.log(
    "\nARMAR (ação manual na máquina real, fora do escopo desta geração):\n" +
      "  mkdir -p ~/.config/systemd/user\n" +
      `  cp ${outDirAbs}/${WATCHDOG_UNIT_NAME}.service ${outDirAbs}/${WATCHDOG_UNIT_NAME}.timer ~/.config/systemd/user/\n` +
      "  systemctl --user daemon-reload\n" +
      `  systemctl --user enable --now ${WATCHDOG_UNIT_NAME}.timer\n` +
      "\nVerificar depois de armado:\n" +
      `  systemctl --user list-timers ${WATCHDOG_UNIT_NAME}.timer\n` +
      `  npx tsx scripts/lib/check-watchdog-armed.ts\n`,
  );

  return 0;
}

if (isMainModule(import.meta.url)) {
  const repoRootAbs = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  process.exit(main(process.argv.slice(2), repoRootAbs));
}
