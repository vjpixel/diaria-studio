#!/usr/bin/env node
/**
 * scripts/overnight/setup-edicao-schedule-systemd.ts (#4998, reativação do #2068/#3259)
 *
 * Gera o par `.service`/`.timer` (systemd "user units") da edição diária
 * agendada — par Linux do `scripts/overnight/setup-edicao-schedule.ps1`
 * (Windows Task Scheduler), no mesmo espírito de
 * `scripts/overnight/setup-watchdog-schedule-systemd.ts` (fora do registry,
 * ver decisão documentada em `scripts/lib/edicao-systemd-units.ts`).
 *
 * Este script SÓ ESCREVE ARQUIVOS EM DISCO — nunca chama `systemctl` nem
 * qualquer outro subprocess. ARMAR (copiar pra `~/.config/systemd/user/` +
 * `systemctl --user enable --now`) é ação humana explícita na máquina real.
 *
 * Uso:
 *   npx tsx scripts/overnight/setup-edicao-schedule-systemd.ts [--out-dir <dir>]
 *
 * --out-dir: relativo à raiz do repo (default: ".systemd-units/" — mesmo
 *            diretório usado pelas outras gerações de unit, git-ignorado).
 *
 * Mesmo achado ao vivo do #4857 pro watchdog: `buildEdicaoSystemdUnitFiles`
 * embute `process.execPath` (o Node que RODOU este comando) literalmente no
 * `ExecStart=` gerado — rodar com `nvm use`/`fnm use` do `.nvmrc` ativado
 * ANTES de gerar, senão o unit fica preso a um Node desatualizado/errado.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNodeVersion } from "../lib/check-node-version.ts";
import { getStringArg, isMainModule } from "../lib/cli-args.ts";
import { buildEdicaoSystemdUnitFiles, EDICAO_UNIT_NAME } from "../lib/edicao-systemd-units.ts";

const DEFAULT_OUT_DIR = ".systemd-units";

/**
 * Escreve o par `.service`/`.timer` da edição diária em `outDirAbs` (criado
 * se necessário). Retorna os paths absolutos escritos, `[service, timer]`.
 * Nunca chama `systemctl` — só filesystem.
 */
export function generateEdicaoSystemdUnits(repoRootAbs: string, outDirAbs: string): string[] {
  mkdirSync(outDirAbs, { recursive: true });
  const { serviceFileName, timerFileName, serviceContent, timerContent } = buildEdicaoSystemdUnitFiles(repoRootAbs);
  const servicePath = join(outDirAbs, serviceFileName);
  const timerPath = join(outDirAbs, timerFileName);
  writeFileSync(servicePath, serviceContent, "utf8");
  writeFileSync(timerPath, timerContent, "utf8");
  return [servicePath, timerPath];
}

export function main(argv: string[], repoRootAbs: string, execNodeVersion: string = process.version): number {
  let outDirArg: string | undefined;
  try {
    outDirArg = getStringArg(argv, "out-dir", { example: DEFAULT_OUT_DIR });
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }

  const outDirAbs = resolve(repoRootAbs, outDirArg ?? DEFAULT_OUT_DIR);
  const written = generateEdicaoSystemdUnits(repoRootAbs, outDirAbs);

  console.log(`Edição diária agendada (#2068) -> ${written.length} arquivo(s) gerado(s) em ${outDirAbs}:\n`);
  for (const p of written) console.log(`  ${p}`);
  console.log(
    "\nARMAR (ação manual na máquina real, fora do escopo desta geração):\n" +
      "  mkdir -p ~/.config/systemd/user\n" +
      `  cp ${outDirAbs}/${EDICAO_UNIT_NAME}.service ${outDirAbs}/${EDICAO_UNIT_NAME}.timer ~/.config/systemd/user/\n` +
      "  systemctl --user daemon-reload\n" +
      `  systemctl --user enable --now ${EDICAO_UNIT_NAME}.timer\n` +
      "\nVerificar depois de armado:\n" +
      `  systemctl --user list-timers ${EDICAO_UNIT_NAME}.timer\n`,
  );

  const nodeCheck = checkNodeVersion(execNodeVersion);
  if (!nodeCheck.ok) {
    console.warn(
      `\n[aviso] ExecStart= foi gerado com o Node deste shell (${execNodeVersion}, ` +
        `process.execPath=${process.execPath}) — esse caminho fica EMBUTIDO literalmente ` +
        "no unit, não se atualiza sozinho depois. " +
        `${nodeCheck.message} ` +
        "Se este não for o Node que o projeto usa (nvm use / fnm use no .nvmrc), " +
        "reative a versão correta e gere de novo ANTES de copiar pra ~/.config/systemd/user/.\n",
    );
  }

  return 0;
}

if (isMainModule(import.meta.url)) {
  const repoRootAbs = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  process.exit(main(process.argv.slice(2), repoRootAbs));
}
