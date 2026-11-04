/**
 * linkedin-api-version.ts (#12171)
 *
 * Default do header `LinkedIn-Version` (YYYYMM) do caminho de API direta do
 * Worker (carrossel #8052, documento). A LinkedIn mantém cada versão da API
 * REST por cerca de um ano e lança uma por mês: dois meses atrás sempre
 * existe e nunca está perto do fim. Antes deste arquivo o Worker pinava
 * "202401" (em `wrangler.toml` e como default em `resolveLinkedInCreds`),
 * versão que sai da janela de suporte e só se revelaria como erro da API no
 * primeiro disparo com o token da página (#8816).
 *
 * Cópia da regra de `defaultLinkedInApiVersion` em
 * `scripts/lib/linkedin-personal.ts`: o Worker não importa de `scripts/lib`
 * (bundle do Cloudflare). A paridade entre as duas é travada por
 * `test/linkedin-api-version-parity-12171.test.ts`.
 */
export function defaultLinkedInApiVersion(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
