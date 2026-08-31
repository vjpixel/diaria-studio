#!/usr/bin/env npx tsx
/**
 * scripts/check-continuo-workdir.ts (#6817)
 *
 * CLI da allowlist de raízes do `hermes-diaria-continuo` — ver
 * `scripts/lib/continuo-workdir-allowlist.ts` pro critério puro/docs
 * completas. Resolve o path pedido (absolutiza `~`, normaliza `..`) e
 * chama `isPathAllowed` contra as raízes default.
 *
 * Uso:
 *   npx tsx scripts/check-continuo-workdir.ts --path /home/vjpixel/diaria-studio/scripts/x.ts --intent write
 *   npx tsx scripts/check-continuo-workdir.ts --path ~/hermes-agent/foo.py --intent read
 *   npx tsx scripts/check-continuo-workdir.ts --path ~/.hermes/auth.json --intent read
 *
 * Exit codes:
 *   0 = allowed
 *   1 = denied (allowlist recusou — raiz desabilitada, fora de qualquer
 *       raiz, sufixo hard-denied, ou mode incompatível com intent)
 *   2 = uso inválido (--path/--intent ausente ou --intent fora de
 *       "read"|"write")
 *
 * A resposta (motivo) sempre vai pro stdout/stderr — exit code sozinho não
 * diz PORQUE, e quem for barrado precisa saber (mesma disciplina de
 * `sensitive-path-guard.ts`).
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { defaultWorkdirRoots, isPathAllowed } from "./lib/continuo-workdir-allowlist.ts";

const LOG_PREFIX = "[check-continuo-workdir]";

/** Raiz do repo diaria-studio — 2 níveis acima de `scripts/`. */
const DIARIA_STUDIO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const rawPath = values.path;
  const intent = values.intent;

  if (!rawPath || (intent !== "read" && intent !== "write")) {
    console.error(`${LOG_PREFIX} uso: --path <caminho> --intent read|write`);
    process.exit(2);
  }

  const expanded = rawPath.startsWith("~") ? rawPath.replace(/^~/, homedir()) : rawPath;
  const resolvedPath = resolve(expanded);

  const roots = defaultWorkdirRoots(homedir(), DIARIA_STUDIO_ROOT);
  const decision = isPathAllowed(resolvedPath, intent, roots);

  if (decision.allowed) {
    console.log(`${LOG_PREFIX} allowed — ${decision.reason}`);
    process.exit(0);
  } else {
    console.error(`${LOG_PREFIX} denied — ${decision.reason}`);
    process.exit(1);
  }
}
