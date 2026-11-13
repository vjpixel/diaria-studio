#!/usr/bin/env tsx
/**
 * scripts/d1-video-invite-status.ts (#12946)
 *
 * Imprime a linha do gate 4 que diz se o D1 da newsletter sai com o convite
 * "Clique para assistir meus comentários" e oferece "sem vídeo" no próprio
 * gate. Lógica em `scripts/lib/diaria/d1-video-invite-status.ts`.
 *
 * Uso:
 *   npx tsx scripts/d1-video-invite-status.ts --edition-dir DIR          # linha do gate
 *   npx tsx scripts/d1-video-invite-status.ts --edition-dir DIR --json   # estado + passos do "sem vídeo"
 *
 * Só leitura. Exit: 0 ok · 1 diretório ausente · 2 uso inválido.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  formatD1VideoInviteLine,
  noVideoGateSteps,
  readD1VideoInviteStatus,
} from "./lib/diaria/d1-video-invite-status.ts";

export function main(argv: string[] = process.argv.slice(2)): number {
  const { flags, values } = parseArgs(argv);
  const raw = values["edition-dir"];
  if (!raw) {
    console.error("uso: d1-video-invite-status.ts --edition-dir DIR [--json]");
    return 2;
  }
  const dir = resolve(raw);
  if (!existsSync(dir)) {
    console.error(`d1-video-invite-status: ${dir} não existe`);
    return 1;
  }
  const status = readD1VideoInviteStatus(dir);
  const line = formatD1VideoInviteLine(status, raw);
  if (flags.has("json")) {
    console.log(JSON.stringify({ ...status, line, no_video_steps: status.state === "no-video" ? [] : noVideoGateSteps(raw) }, null, 2));
  } else {
    console.log(line);
  }
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main();
