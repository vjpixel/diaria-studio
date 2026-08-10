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
 * Este script SÓ ESCREVE ARQUIVOS EM DISCO — nunca chama `systemctl` nem
 * qualquer outro subprocess (mesma garantia estrutural de
 * `scripts/setup-systemd-timers.ts`, verificada em
 * `test/watchdog-systemd-units.test.ts` pela ausência de qualquer capacidade
 * de spawn de subprocesso). ARMAR (copiar pra `~/.config/systemd/user/` +
 * `systemctl --user enable --now`) é ação humana na máquina real — esta
 * unidade (worktree isolado, #4857) não toca o systemd real de `predator`,
 * onde o watchdog já foi armado manualmente em 260810 (ver comentário de
 * fechamento da issue).
 *
 * Uso:
 *   npx tsx scripts/overnight/setup-watchdog-schedule-systemd.ts [--out-dir <dir>]
 *
 * --out-dir: relativo à raiz do repo (default: ".systemd-units/" — MESMO
 *            diretório que `scripts/setup-systemd-timers.ts` usa pras 14
 *            tasks do registry, git-ignorado — permite copiar tudo de uma
 *            vez pra `~/.config/systemd/user/`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, isMainModule } from "../lib/cli-args.ts";
import { buildWatchdogSystemdUnitFiles, WATCHDOG_UNIT_NAME } from "../lib/watchdog-systemd-units.ts";

const DEFAULT_OUT_DIR = ".systemd-units";

/**
 * Escreve o par `.service`/`.timer` do watchdog em `outDirAbs` (criado se
 * necessário). Retorna os paths absolutos escritos, `[service, timer]`.
 * Nunca chama `systemctl` — só filesystem.
 */
export function generateWatchdogSystemdUnits(repoRootAbs: string, outDirAbs: string): string[] {
  mkdirSync(outDirAbs, { recursive: true });
  const { serviceFileName, timerFileName, serviceContent, timerContent } = buildWatchdogSystemdUnitFiles(repoRootAbs);
  const servicePath = join(outDirAbs, serviceFileName);
  const timerPath = join(outDirAbs, timerFileName);
  writeFileSync(servicePath, serviceContent, "utf8");
  writeFileSync(timerPath, timerContent, "utf8");
  return [servicePath, timerPath];
}

export function main(argv: string[], repoRootAbs: string): number {
  let outDirArg: string | undefined;
  try {
    outDirArg = getStringArg(argv, "out-dir", { example: DEFAULT_OUT_DIR });
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }

  const outDirAbs = resolve(repoRootAbs, outDirArg ?? DEFAULT_OUT_DIR);
  const written = generateWatchdogSystemdUnits(repoRootAbs, outDirAbs);

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
