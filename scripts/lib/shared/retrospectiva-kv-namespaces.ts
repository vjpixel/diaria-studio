/**
 * scripts/lib/shared/retrospectiva-kv-namespaces.ts (#7580/#7581, unificado em
 * #7658)
 *
 * Lê os IDs dos namespaces KV de `workers/retrospectiva/wrangler.toml` — que é
 * onde eles já vivem e de onde o `wrangler deploy` também os tira.
 *
 * ## Por que uma fonte só, e por que este módulo é um só
 *
 * Duplicar um ID que já está versionado a dois diretórios de distância não
 * compra nada e cria divergência silenciosa: era assim até o #7580, e os
 * scripts ficaram com o literal `"REPLACE_ME_APOS_CRIAR_NAMESPACE_ALLOWLIST"`
 * do #3940 muito depois de os namespaces existirem de verdade. O sintoma só
 * aparecia no `--push` (a única execução que importa), como um 400 opaco do
 * Cloudflare — e os dois scripts rodam em dry-run por padrão, então a falha
 * ficava escondida atrás do modo que ninguém usa pra valer.
 *
 * O #7658 juntou os DOIS leitores que existiam (um por worker, `anual` e
 * `artigo-mensal`, com o mesmo parser copiado) num só: depois da unificação
 * eles passariam a ler o MESMO arquivo, e manter duas cópias do parser pra
 * isso seria repetir o erro que o módulo existe pra evitar.
 *
 * ## Parsing deliberadamente restrito
 *
 * Não usa parser TOML: procura os blocos `[[kv_namespaces]]` e casa
 * `binding`/`id` dentro de cada um. É o suficiente para este arquivo (formato
 * estável, versionado) e evita uma dependência nova para ler três linhas. Se o
 * formato mudar, lança nomeando o binding procurado — nunca devolve um ID
 * errado nem um placeholder.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WRANGLER_TOML = resolve(ROOT, "workers", "retrospectiva", "wrangler.toml");
const TOML_LABEL = "workers/retrospectiva/wrangler.toml";

/** Bindings KV declarados pelo worker (ver `workers/retrospectiva/wrangler.toml`). */
export type RetrospectivaBinding = "ARTICLES" | "ALLOWLIST" | "RATE_LIMIT";

/**
 * Extrai o `id` do bloco `[[kv_namespaces]]` cujo `binding` casa. Puro — o
 * caller lê o arquivo, para o parsing ser testável sem tocar o disco.
 *
 * @throws se o binding não existir, ou se o `id` ainda for um placeholder —
 *   publicar contra `REPLACE_ME_...` é um 400 do Cloudflare que só aparece no
 *   `--push`, e falhar aqui nomeia a causa em vez do sintoma.
 */
export function parseNamespaceId(toml: string, binding: RetrospectivaBinding): string {
  for (const bloco of toml.split(/^\s*\[\[kv_namespaces\]\]\s*$/m).slice(1)) {
    // `[` inicia a próxima seção TOML — não olhar além dela evita casar o `id`
    // de um bloco vizinho quando o binding procurado não declara nenhum.
    const escopo = bloco.split(/^\s*\[/m)[0];
    if (escopo.match(/^\s*binding\s*=\s*"([^"]+)"/m)?.[1] !== binding) continue;
    const id = escopo.match(/^\s*id\s*=\s*"([^"]+)"/m)?.[1];
    if (!id) {
      // Erro PRÓPRIO: o bloco foi encontrado, só está incompleto. Cair no
      // "binding não encontrado" genérico mandaria quem depura procurar um
      // nome errado de binding em vez de uma linha `id` que falta (achado do
      // review da PR #7592).
      throw new Error(`${TOML_LABEL}: bloco [[kv_namespaces]] do binding "${binding}" não declara \`id\`.`);
    }
    if (id.startsWith("REPLACE_ME")) {
      throw new Error(
        `${TOML_LABEL}: binding "${binding}" ainda tem o id placeholder "${id}". ` +
          `Rodar \`npx wrangler kv namespace create ${binding} --remote\` (dentro de workers/retrospectiva/) ` +
          "e colar o id retornado.",
      );
    }
    return id;
  }
  throw new Error(`${TOML_LABEL}: binding "${binding}" não encontrado em nenhum bloco [[kv_namespaces]].`);
}

/** Lê o `wrangler.toml` do worker e devolve o namespace do binding. */
export function readRetrospectivaNamespaceId(
  binding: RetrospectivaBinding,
  tomlPath = WRANGLER_TOML,
): string {
  if (!existsSync(tomlPath)) {
    throw new Error(`${TOML_LABEL} não encontrado em ${tomlPath}.`);
  }
  return parseNamespaceId(readFileSync(tomlPath, "utf8"), binding);
}
