/**
 * cloudflare-oauth-env.ts
 *
 * Fonte única (#6900) do env "sanitizado" que `purge-leaderboard.ts` usa pra
 * forçar o `wrangler` a resolver auth pela sessão OAuth do CLI, nunca por
 * um `CLOUDFLARE_API_TOKEN` avulso no `.env` do processo (#2265 — o token
 * avulso historicamente não tinha permissão de KV, dava 401; um
 * `CLOUDFLARE_ACCOUNT_ID` errado no shell dava 404).
 *
 * Antes desta extração, `purge-leaderboard.ts` derivava esse env inline e
 * NENHUM outro consumidor sabia disso — o guard `wrangler whoami` de §6h do
 * Stage 6 (`.claude/agents/orchestrator-stage-6.md`) rodava `wrangler whoami`
 * no ambiente NORMAL (com o token ainda presente), validando uma identidade
 * diferente da que `purge-leaderboard.ts` de fato usa. Achado ao vivo na
 * edição 260901 (#6900): o guard passou (autenticado via API Token) e
 * `purge-leaderboard.ts` falhou logo em seguida com `Authentication error
 * [code: 10000]` porque a sessão OAuth (a auth que ele realmente usa) estava
 * expirada — o guard nunca tinha como detectar isso, validava a coisa
 * errada. Um único helper compartilhado fecha esse gap: os dois lados não
 * podem mais divergir sobre QUAL env conta como "autenticado".
 */
export const CLOUDFLARE_OAUTH_STRIPPED_ENV_VARS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] as const;

/**
 * Retorna uma CÓPIA de `env` sem as vars acima — nunca muta o objeto
 * recebido (`purge-leaderboard.ts` e o guard de §6h chamam isto sobre
 * `process.env`; mutar o `process.env` do processo pai afetaria qualquer
 * outra coisa rodando na mesma sessão).
 */
export function sanitizedCloudflareOAuthEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  for (const key of CLOUDFLARE_OAUTH_STRIPPED_ENV_VARS) {
    delete childEnv[key];
  }
  return childEnv;
}
