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
 *
 * **Achado ao vivo (#4857, reconciliação 260810):** `buildWatchdogSystemdUnitFiles`
 * embute `process.execPath` — o Node que RODOU este comando — literalmente no
 * `ExecStart=` gerado. Isso é reproduzível (mesmo binário sempre que a mesma
 * versão gerar) mas silenciosamente frágil: rodar este gerador de um shell
 * sem o Node correto do projeto ativado (nvm/fnm apontando pro `.nvmrc`) baka
 * o Node ERRADO no unit — sem sinal nenhum no output normal. Reproduzido ao
 * vivo nesta máquina: um shell de agente sem `~/.local/node/bin` no PATH gerou
 * `ExecStart=` apontando pro Node 20.20.2 do sistema (`/usr/bin/node`, mesmo
 * binário do incidente #4823), enquanto o arme manual original (260810, feito
 * do shell correto do editor) usa o Node 24 do `.nvmrc`
 * (`/home/vjpixel/.local/node/bin/node`). `overnight-watchdog.ts` em si não
 * importa `node:sqlite` (não quebraria no Node 20), mas diverge da política
 * do projeto (Node ≥22.5/24, CLAUDE.md item 1a) — daí o warning abaixo, que
 * NUNCA bloqueia a geração (fail-soft, mesma disciplina de
 * `checkNodeVersion`), só avisa alto antes do editor copiar pra
 * `~/.config/systemd/user/`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, isMainModule } from "../lib/cli-args.ts";
import { checkNodeVersion } from "../lib/check-node-version.ts";
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

export function main(argv: string[], repoRootAbs: string, execNodeVersion: string = process.version): number {
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
