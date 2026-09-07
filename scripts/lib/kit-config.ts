/**
 * kit-config.ts (#463 — migração Beehiiv → Kit, #461)
 *
 * Espelho de `beehiiv-config.ts`: centraliza resolução de credencial +
 * base URL da API do Kit via `resolveKitConfig` (pura/injetável).
 * `loadKitConfig` (#7570) é a casca fina de CLI que sai do processo —
 * adicionada de volta quando `kit-sync.ts` se tornou o 1º consumidor real
 * (a nota original dizia "adicionar quando o 1º script CLI precisar dela").
 * Correção sobre uma nota anterior deste docstring (achado do review do
 * PR #7573, comment-analyzer): `publish-newsletter-kit.ts`/#464 nunca
 * chegou a usar este módulo — ele chama `kit-broadcasts.ts` sem passar
 * nenhum `config`, e a resolução cai no fallback fail-fast de dentro de
 * `kit-client.ts` (lança `Error` quando `resolveKitConfig()` falha, não
 * `process.exit`). A lacuna persistiu porque nenhum caminho ali precisava
 * derrubar o processo com um código de saída específico — não porque
 * alguém tenha optado por passar `KitConfig` explícito em algum lugar.
 *
 * Diferença deliberada do par Beehiiv: o Kit não tem um "publicationId"
 * separado da API key — uma key já resolve pra UMA conta (confirmado ao vivo
 * no #6047: `GET /v4/account` com só `X-Kit-Api-Key` devolve a conta certa).
 * `KitConfig` tem só `apiKey`.
 */

const KIT_API_URL_DEFAULT = "https://api.kit.com/v4";

/**
 * Base URL da API do Kit. `KIT_API_URL` (env) override pra testes.
 * Lazy getter (mesmo motivo de `beehiivApiBase()`) — lê `process.env` no
 * momento da chamada, não no import, pra não capturar um valor antes do
 * `.env` existir em `process.env` quando o caller usa `loadProjectEnv()`.
 */
export function kitApiBase(): string {
  return process.env.KIT_API_URL ?? KIT_API_URL_DEFAULT;
}

export interface KitConfig {
  apiKey: string;
}

export type KitConfigResult = { ok: true; config: KitConfig } | { ok: false; reason: string };

/**
 * Resolve `KIT_API_KEY` do ambiente, sem nunca lançar ou chamar
 * `process.exit` — versão pura pra consumidores long-running (Studio) e pra
 * testes.
 *
 * @param env  Fonte do env — default `process.env`. Injetável pra testes
 *             controlarem o cenário sem tocar o env real da máquina (mesmo
 *             padrão de `resolveBeehiivConfig`).
 */
export function resolveKitConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): KitConfigResult {
  const apiKey = env.KIT_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      reason: "KIT_API_KEY não definida. Configure no .env (veja .env.example).",
    };
  }
  return { ok: true, config: { apiKey } };
}

/**
 * Casca de CLI sobre `resolveKitConfig` — escreve em stderr e chama
 * `process.exit(2)` se `KIT_API_KEY` estiver ausente, em vez de deixar o
 * consumidor lançar (mesmo contrato de `loadBeehiivConfig`). Scripts
 * long-running (Studio) devem seguir usando `resolveKitConfig` direto —
 * esta casca é só para entry-points de CLI onde derrubar o processo é o
 * comportamento certo.
 */
export function loadKitConfig(callerTag = "[kit-config]"): KitConfig {
  const result = resolveKitConfig();
  if (!result.ok) {
    process.stderr.write(`${callerTag} ${result.reason}\n`);
    process.exit(2);
  }
  return result.config;
}
