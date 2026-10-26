#!/usr/bin/env node
/**
 * scripts/onedrive-skip-file-config.ts (#10957)
 *
 * Gera e (só com `--apply`) grava a linha `skip_file` da config do cliente
 * Linux do OneDrive com os padrões que o projeto mantém fora do sync —
 * `*.mp4` (#10957) e os transitórios do #5548. Idempotente: rodar de novo
 * com tudo já presente não muda nada (`changed: false`). Lógica pura em
 * `scripts/lib/onedrive-skip-file.ts`.
 *
 * **GUARD:** este script só lê/escreve o arquivo de config. Nunca chama
 * `systemctl`, nunca roda o binário `onedrive` (`--resync` inclusive) e
 * nunca apaga nada no OneDrive. Reiniciar o daemon pra pegar a config nova
 * é passo manual do editor (`docs/onedrive-sync-setup.md`, item 6).
 *
 * Uso:
 *   npx tsx scripts/onedrive-skip-file-config.ts                 # dry-run: mostra o plano
 *   npx tsx scripts/onedrive-skip-file-config.ts --apply         # grava (backup .bak-{timestamp} ao lado)
 *   npx tsx scripts/onedrive-skip-file-config.ts --config PATH   # outra config (default ~/.config/onedrive/config)
 *   npx tsx scripts/onedrive-skip-file-config.ts --print         # só imprime a linha skip_file recomendada
 *
 * Exit: 0 = ok (inclusive "nada a mudar"); 1 = erro de leitura/escrita.
 */
import { existsSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hasFlag, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { planSkipFileConfig, ONEDRIVE_CLIENT_DEFAULT_SKIP_FILE, REQUIRED_SKIP_FILE_PATTERNS } from "./lib/onedrive-skip-file.ts";

const LOG_PREFIX = "[onedrive-skip-file]";

export function defaultOnedriveConfigPath(): string {
  return join(homedir(), ".config", "onedrive", "config");
}

function main(): void {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "print")) {
    const all = [...ONEDRIVE_CLIENT_DEFAULT_SKIP_FILE];
    for (const p of REQUIRED_SKIP_FILE_PATTERNS) if (!all.includes(p)) all.push(p);
    console.log(`skip_file = "${all.join("|")}"`);
    return;
  }
  const apply = hasFlag(argv, "apply");
  const configPath = getStringArg(argv, "config", { example: "~/.config/onedrive/config" }) ?? defaultOnedriveConfigPath();

  // Config ausente é caso real (cliente instalado sem config própria): o
  // plano cria a linha do zero, e `--apply` cria o arquivo.
  const before = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const plan = planSkipFileConfig(before);

  console.log(`${LOG_PREFIX} config: ${configPath}${existsSync(configPath) ? "" : " (ausente)"}`);
  console.log(`${LOG_PREFIX} skip_file efetivo depois do plano: ${plan.effective.join("|")}`);
  if (!plan.changed) {
    console.log(`${LOG_PREFIX} nada a mudar — todos os padrões exigidos já estão na config.`);
    return;
  }
  console.log(`${LOG_PREFIX} faltam: ${plan.added.join(", ")}`);

  if (!apply) {
    console.log(`${LOG_PREFIX} dry-run (default): nada gravado. Rode com --apply para gravar.`);
    return;
  }

  if (existsSync(configPath)) {
    const backup = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(configPath, backup);
    console.log(`${LOG_PREFIX} backup: ${backup}`);
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileAtomic(configPath, plan.text);
  console.log(`${LOG_PREFIX} gravado. Próximo passo (manual): systemctl --user restart onedrive — ver docs/onedrive-sync-setup.md item 6.`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`${LOG_PREFIX} erro: ${(e as Error).message}`);
    process.exit(1);
  }
}
