/**
 * scripts/lib/mensal/artigo-mensal-kv-namespaces.ts (#7580)
 *
 * Lê os IDs dos namespaces KV do worker `artigo-mensal` do `wrangler.toml`,
 * que é onde eles já vivem e de onde o deploy os tira.
 *
 * ## Por que não uma constante em cada script
 *
 * Era assim até aqui, e os dois scripts ficaram com o literal
 * `"REPLACE_ME_APOS_CRIAR_NAMESPACE_ALLOWLIST"` — placeholder do #3940 que
 * ninguém trocou quando os namespaces foram de fato criados. O `wrangler.toml`
 * ganhou os IDs reais; os scripts não. O resultado só aparece no `--push`, que
 * é a única execução que importa, com um 400 do Cloudflare reclamando de UUID
 * inválido — e ambos os scripts rodam em dry-run por padrão, então a falha
 * ficou escondida atrás do modo que ninguém usa para valer.
 *
 * Duplicar um ID que já está versionado a dois diretórios de distância não
 * compra nada e cria exatamente essa divergência silenciosa. Aqui há uma fonte
 * só, e ela é a mesma que o `wrangler deploy` consome.
 *
 * ## Parsing deliberadamente restrito
 *
 * Não usa parser TOML: procura os blocos `[[kv_namespaces]]` e casa
 * `binding`/`id` dentro de cada um. É o suficiente para este arquivo (dois
 * blocos, formato estável, versionado) e evita uma dependência nova para ler
 * duas linhas. Se o formato mudar, `readArtigoMensalNamespaceId` lança com o
 * binding procurado — nunca devolve um ID errado nem um placeholder.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WRANGLER_TOML = resolve(ROOT, "workers", "artigo-mensal", "wrangler.toml");

/** Bindings KV declarados pelo worker `artigo-mensal`. */
export type ArtigoMensalBinding = "ARTICLES" | "ALLOWLIST";

/**
 * Extrai o `id` do bloco `[[kv_namespaces]]` cujo `binding` casa. Puro — o
 * caller lê o arquivo, para o parsing ser testável sem tocar o disco.
 *
 * @throws se o binding não existir, ou se o `id` ainda for um placeholder do
 *   #3940 — publicar contra `REPLACE_ME_...` é um 400 do Cloudflare que só
 *   aparece no `--push`, e falhar aqui nomeia a causa em vez do sintoma.
 */
export function parseNamespaceId(toml: string, binding: ArtigoMensalBinding): string {
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
      throw new Error(
        `workers/artigo-mensal/wrangler.toml: bloco [[kv_namespaces]] do binding "${binding}" não declara \`id\`.`,
      );
    }
    if (id.startsWith("REPLACE_ME")) {
      throw new Error(
        `workers/artigo-mensal/wrangler.toml: binding "${binding}" ainda tem o id placeholder "${id}". ` +
          `Rodar \`npx wrangler kv namespace create ${binding} --remote\` e colar o id retornado.`,
      );
    }
    return id;
  }
  throw new Error(
    `workers/artigo-mensal/wrangler.toml: binding "${binding}" não encontrado em nenhum bloco [[kv_namespaces]].`,
  );
}

/** Lê o `wrangler.toml` do worker e devolve o namespace do binding. */
export function readArtigoMensalNamespaceId(binding: ArtigoMensalBinding, tomlPath = WRANGLER_TOML): string {
  if (!existsSync(tomlPath)) {
    throw new Error(`workers/artigo-mensal/wrangler.toml não encontrado em ${tomlPath}.`);
  }
  return parseNamespaceId(readFileSync(tomlPath, "utf8"), binding);
}
