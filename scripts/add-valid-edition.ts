/**
 * add-valid-edition.ts (#1086)
 *
 * Adiciona uma edição AAMMDD ao set `valid_editions` no KV do Worker
 * `poll`. Idempotente — se já estiver, no-op. Sem essa entrada o
 * Worker rejeita votos da edição com 410 "Essa edição não aceita mais votos."
 *
 * Uso: chamar no pipeline quando o `newsletter-final.html` da edição corrente
 * está pronto pra ser publicado (Stage 4 pré-paste). Antes da nova edição
 * disparar, o Worker já aceita votos pra ela.
 *
 * Uso CLI:
 *   npx tsx scripts/add-valid-edition.ts --edition 260512
 *   npx tsx scripts/add-valid-edition.ts --edition 260512 --remove
 *
 * Env:
 *   CLOUDFLARE_ACCOUNT_ID  - default 5d15d8303325211d6976d73051f4b002
 *   POLL_KV_NAMESPACE_ID   - default 72784da4ae39444481eb422ebac357c6
 */

import "dotenv/config"; // #1379 — carrega CLOUDFLARE_API_TOKEN do .env pra wrangler
import { parseArgs } from "./lib/cli-args.ts";
import { isValidEditionDir } from "./lib/edition-utils.ts"; // #1811
import { wranglerKvGet, wranglerKvPut } from "./lib/poll-kv.ts";

// #1086: Node 24 introduziu mudança em spawnSync que quebra .cmd files no
// Windows com EINVAL. shell:true (em poll-kv.ts) contorna (chama via cmd.exe)
// e os argumentos são seguros aqui (edition validado via regex ^\d{6}$;
// namespace/account são constantes; value é JSON.stringify de array de strings).

export function run(args: {
  edition: string;
  remove: boolean;
}): { previous: string[]; current: string[]; changed: boolean } {
  const { edition, remove } = args;
  if (!isValidEditionDir(edition)) {
    throw new Error(`--edition deve ser AAMMDD válido (mês 01-12, dia 01-31), recebido: "${edition}"`);
  }

  const raw = wranglerKvGet("valid_editions");
  let previous: string[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) previous = parsed.filter((x) => typeof x === "string");
    } catch {
      console.warn(`[add-valid-edition] valid_editions corrupted, starting fresh: ${raw.slice(0, 100)}`);
    }
  }

  const current = new Set(previous);
  const hadEdition = current.has(edition);
  if (remove) {
    current.delete(edition);
  } else {
    current.add(edition);
  }
  const currentArr = [...current].sort();
  const changed = remove ? hadEdition : !hadEdition;

  if (changed) {
    wranglerKvPut("valid_editions", JSON.stringify(currentArr));
  }

  return { previous, current: currentArr, changed };
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const edition = values["edition"];
  const remove = flags.has("remove");

  if (!edition) {
    console.error("Uso: add-valid-edition.ts --edition AAMMDD [--remove]");
    process.exit(1);
  }

  const result = run({ edition, remove });
  const action = remove ? "remove" : "add";
  const status = result.changed ? "applied" : "noop";
  console.log(
    JSON.stringify(
      { action, edition, status, previous: result.previous, current: result.current },
      null,
      2,
    ),
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
