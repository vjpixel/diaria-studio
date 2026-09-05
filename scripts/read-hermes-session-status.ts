#!/usr/bin/env npx tsx
/**
 * scripts/read-hermes-session-status.ts (#6817 item 2)
 *
 * ÚNICO caminho sancionado pra ler `~/.hermes/sessions/sessions.json` —
 * decisão do editor (03/09/2026): "o script é o único caminho de leitura;
 * ler o arquivo direto continua proibido, inclusive por conveniência de
 * debug." Ver `scripts/lib/hermes-session-status.ts` pro racional completo
 * (allowlist de saída, não blacklist) e `scripts/lib/continuo-workdir-
 * allowlist.ts` pro gate de raiz (#6817 item 1).
 *
 * Dois gates ANTES de qualquer byte do arquivo tocar stdout:
 *   1. `isPathAllowed(path, "read", roots)` — path precisa estar sob uma
 *      raiz habilitada e não pode casar `HARD_DENIED_SUFFIXES`
 *      (`.hermes/auth.json` — mas isso não é o caso aqui; é uma segunda
 *      camada de defesa caso alguém aponte `--path` pro arquivo errado).
 *   2. `extractSessionStatus` — filtra o JSON parseado pra só os campos
 *      declarados em `--fields`/`DEFAULT_ALLOWED_SESSION_FIELDS`.
 *
 * Uso:
 *   npx tsx scripts/read-hermes-session-status.ts --path ~/.hermes/sessions/sessions.json
 *   npx tsx scripts/read-hermes-session-status.ts --path ~/.hermes/sessions/sessions.json \
 *     --fields last_status,model_override,exhausted,custom_field_novo
 *
 * Exit codes:
 *   0 = leitura + filtragem ok, JSON redigido no stdout
 *   1 = path negado pela allowlist de raízes (motivo no stderr)
 *   2 = arquivo ausente, JSON inválido, ou uso inválido
 *
 * Erro/motivo sempre no stderr; stdout carrega SÓ o JSON redigido (nunca
 * uma mensagem de erro misturada) — quem invoca via subshell (`$(...)`)
 * precisa poder confiar que stdout é JSON limpo ou está vazio.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { defaultWorkdirRoots, isPathAllowed } from "./lib/continuo-workdir-allowlist.ts";
import { DEFAULT_ALLOWED_SESSION_FIELDS, extractSessionStatus } from "./lib/hermes-session-status.ts";

const LOG_PREFIX = "[read-hermes-session-status]";
const DIARIA_STUDIO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

function resolveInputPath(raw: string): string {
  const expanded = raw.startsWith("~") ? raw.replace(/^~/, homedir()) : raw;
  return resolve(expanded);
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const { values } = parseArgs(argv);
  const rawPath = values.path;

  if (!rawPath) {
    console.error(`${LOG_PREFIX} uso: --path <caminho para sessions.json> [--fields a,b,c]`);
    process.exit(2);
  }

  const resolvedPath = resolveInputPath(rawPath);
  const roots = defaultWorkdirRoots(homedir(), DIARIA_STUDIO_ROOT);
  const decision = isPathAllowed(resolvedPath, "read", roots);
  if (!decision.allowed) {
    console.error(`${LOG_PREFIX} denied — ${decision.reason}`);
    process.exit(1);
  }

  if (!existsSync(resolvedPath)) {
    console.error(`${LOG_PREFIX} arquivo não existe: ${resolvedPath}`);
    process.exit(2);
  }

  const fieldsValue = values.fields;
  const fields = fieldsValue
    ? fieldsValue.split(",").map((f) => f.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_SESSION_FIELDS;

  let parsed: unknown;
  try {
    const raw = readFileSync(resolvedPath, "utf8");
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`${LOG_PREFIX} falha ao ler/parsear ${resolvedPath}: ${(e as Error).message}`);
    process.exit(2);
  }

  const redacted = extractSessionStatus(parsed, fields);
  process.stdout.write(JSON.stringify(redacted, null, 2) + "\n");
  process.exit(0);
}
