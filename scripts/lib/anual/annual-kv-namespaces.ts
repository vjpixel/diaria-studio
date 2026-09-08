/**
 * scripts/lib/anual/annual-kv-namespaces.ts (#7581)
 *
 * Lê os IDs dos namespaces KV do worker `anual` do `wrangler.toml` — mesmo
 * mecanismo/rationale de `scripts/lib/mensal/artigo-mensal-kv-namespaces.ts`
 * (#7580): uma fonte só (o próprio `wrangler.toml`, de onde `wrangler deploy`
 * também lê), sem literal duplicado que pode ficar defasado em silêncio até
 * o `--push` falhar com um 400 opaco do Cloudflare.
 *
 * Parsing deliberadamente restrito (sem parser TOML) — mesma justificativa
 * do módulo espelhado.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WRANGLER_TOML = resolve(ROOT, "workers", "anual", "wrangler.toml");

/** Bindings KV declarados pelo worker `anual` (ver `workers/anual/wrangler.toml`). */
export type AnnualBinding = "ARTICLES" | "RATE_LIMIT";

/**
 * Extrai o `id` do bloco `[[kv_namespaces]]` cujo `binding` casa. Puro — o
 * caller lê o arquivo, para o parsing ser testável sem tocar o disco.
 */
export function parseAnnualNamespaceId(toml: string, binding: AnnualBinding): string {
  for (const bloco of toml.split(/^\s*\[\[kv_namespaces\]\]\s*$/m).slice(1)) {
    const escopo = bloco.split(/^\s*\[/m)[0];
    if (escopo.match(/^\s*binding\s*=\s*"([^"]+)"/m)?.[1] !== binding) continue;
    const id = escopo.match(/^\s*id\s*=\s*"([^"]+)"/m)?.[1];
    if (!id) {
      throw new Error(
        `workers/anual/wrangler.toml: bloco [[kv_namespaces]] do binding "${binding}" não declara \`id\`.`,
      );
    }
    if (id.startsWith("REPLACE_ME")) {
      throw new Error(
        `workers/anual/wrangler.toml: binding "${binding}" ainda tem o id placeholder "${id}". ` +
          `Rodar \`npx wrangler kv namespace create ${binding} --remote\` (dentro de workers/anual/) e colar o id retornado.`,
      );
    }
    return id;
  }
  throw new Error(
    `workers/anual/wrangler.toml: binding "${binding}" não encontrado em nenhum bloco [[kv_namespaces]].`,
  );
}

/** Lê o `wrangler.toml` do worker e devolve o namespace do binding. */
export function readAnnualNamespaceId(binding: AnnualBinding, tomlPath = WRANGLER_TOML): string {
  if (!existsSync(tomlPath)) {
    throw new Error(`workers/anual/wrangler.toml não encontrado em ${tomlPath}.`);
  }
  return parseAnnualNamespaceId(readFileSync(tomlPath, "utf8"), binding);
}
