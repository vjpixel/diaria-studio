#!/usr/bin/env node
/**
 * scripts/setup-systemd-timers.ts (#4805 Fase 3, épica #4798)
 *
 * Gera os pares `.service`/`.timer` (systemd "user units") pra cada task do
 * registro declarativo (`scripts/lib/scheduled-tasks.ts`) — espelha o papel
 * dos `scripts/setup-*-schedule.ps1` do Windows (Task Scheduler) pro Linux
 * (systemd). Este script SÓ ESCREVE ARQUIVOS EM DISCO — nunca chama
 * `systemctl` nem qualquer outro subprocess. ARMAR (copiar/linkar pra
 * `~/.config/systemd/user/` + `systemctl --user enable --now`) é a issue
 * filha #4807, deliberadamente fora deste escopo (fatia de CÓDIGO, sem
 * máquina do editor disponível nesta sessão).
 *
 * Uso:
 *   npx tsx scripts/setup-systemd-timers.ts [--task <Nome>] [--out-dir <dir>]
 *
 * --task:    gera só a task nomeada (default: todas as SCHEDULED_TASKS).
 * --out-dir: relativo à raiz do repo (default: ".systemd-units/" — git-
 *            ignorado, ver .gitignore; nunca dentro de data/, que é o
 *            junction do OneDrive e não é lugar pra artefato de infra
 *            local).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { getScheduledTaskByName, SCHEDULED_TASKS, type ScheduledTaskDefinition } from "./lib/scheduled-tasks.ts";
import { buildSystemdUnitFiles } from "./lib/systemd-units.ts";

const DEFAULT_OUT_DIR = ".systemd-units";

/**
 * Escreve os pares `.service`/`.timer` de cada task em `outDirAbs` (criado se
 * necessário). Retorna os paths absolutos escritos, na ordem
 * `[service, timer, service, timer, ...]`. Pura o suficiente pra testar sem
 * mockar nada além do filesystem real num diretório temporário — não chama
 * `systemctl`.
 */
export function generateSystemdUnits(
  tasks: ScheduledTaskDefinition[],
  repoRootAbs: string,
  outDirAbs: string,
): string[] {
  mkdirSync(outDirAbs, { recursive: true });
  const written: string[] = [];
  for (const task of tasks) {
    const { serviceFileName, timerFileName, serviceContent, timerContent } = buildSystemdUnitFiles(
      task,
      repoRootAbs,
    );
    const servicePath = join(outDirAbs, serviceFileName);
    const timerPath = join(outDirAbs, timerFileName);
    writeFileSync(servicePath, serviceContent, "utf8");
    writeFileSync(timerPath, timerContent, "utf8");
    written.push(servicePath, timerPath);
  }
  return written;
}

export function main(argv: string[], repoRootAbs: string): number {
  let taskName: string | undefined;
  let outDirArg: string | undefined;
  try {
    taskName = getStringArg(argv, "task", { example: "Diaria-Apoios-Diff-Alarm" });
    outDirArg = getStringArg(argv, "out-dir", { example: DEFAULT_OUT_DIR });
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }

  let tasks = SCHEDULED_TASKS;
  if (taskName) {
    const found = getScheduledTaskByName(taskName);
    if (!found) {
      console.error(`Task desconhecida: "${taskName}".`);
      return 1;
    }
    tasks = [found];
  }

  // #5639 — filtrar tasks desabilitadas (enabled: false)
  tasks = tasks.filter((t) => t.enabled !== false);

  const outDirAbs = resolve(repoRootAbs, outDirArg ?? DEFAULT_OUT_DIR);
  const written = generateSystemdUnits(tasks, repoRootAbs, outDirAbs);

  console.log(`${tasks.length} task(s) -> ${written.length} arquivo(s) gerado(s) em ${outDirAbs}:\n`);
  for (const p of written) console.log(`  ${p}`);
  console.log(
    "\nARMAR (fora do escopo desta task, #4807): por unit gerado, copiar/linkar pra " +
      "~/.config/systemd/user/ e rodar:\n" +
      "  systemctl --user daemon-reload\n" +
      "  systemctl --user enable --now <nome>.timer\n" +
      "\n⚠️  MUDOU O HORÁRIO DE UMA TASK? Os units usam Persistent=true, e o systemd\n" +
      "   dispara NA HORA se existe uma ocorrência do OnCalendar entre o último\n" +
      "   disparo e agora. Para task que manda e-mail ou gasta crédito de API isso\n" +
      "   é um envio REAL, não ensaio (aconteceu ao vivo no #5140).\n" +
      "\n" +
      "   O que manda é o CARIMBO em ~/.local/share/systemd/timers/stamp-<unit>.timer\n" +
      "   (mtime = último disparo), não o relógio do re-arme. Consequências:\n" +
      "     - `stop` NÃO consome o carimbo. Adiar o `start` não evita nada: a\n" +
      "       ocorrência perdida continua devida e dispara na hora do start.\n" +
      "     - Rearmar mais tarde no dia é justamente o caso RUIM.\n" +
      "\n" +
      "   Saídas que funcionam:\n" +
      "     1. Rearmar ANTES de a próxima ocorrência do horário novo acontecer\n" +
      "        (janela entre o último disparo e o horário novo).\n" +
      "     2. Task com kill switch (ex: Diaria-Clarice-Novos): desligar o switch,\n" +
      "        rearmar, deixar o catch-up sair no vazio, religar.\n" +
      "     3. `touch` no arquivo de carimbo antes do start — declara \"já disparou\n" +
      "        agora\" e não sobra ocorrência devida.\n",
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  const repoRootAbs = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.exit(main(process.argv.slice(2), repoRootAbs));
}
