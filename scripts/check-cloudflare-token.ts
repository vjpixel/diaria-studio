/**
 * check-cloudflare-token.ts (#2286)
 *
 * Pré-flight do Stage 0 §0c: checa proativamente a saúde do token
 * Cloudflare/wrangler antes de qualquer passo que dependa do Worker ou KV
 * (ex: maintain-valid-editions, maintain-valid-editions-window).
 *
 * Emite banner consolidado se expirado/inválido/ausente — fail-fast antes de
 * gastar tokens em stages que vão quebrar mais tarde.
 *
 * Analogia: check-google-token.ts (#1973) cobre o token OAuth Google;
 * este cobre o CLOUDFLARE_API_TOKEN.
 *
 * Uso:
 *   npx tsx scripts/check-cloudflare-token.ts
 *
 * Exit codes:
 *   0 = token válido (ou verificado como ativo via API)
 *   1 = token inválido/ausente — banner com a ação (wrangler login ou renovar .env)
 *   2 = erro inesperado (rede, API indisp)
 *
 * Guard de test: NEVER executa wrangler CLI. Usa a Cloudflare REST API
 * (v4/user/tokens/verify) diretamente — testável com mock de fetch.
 * A flag CF_TOKEN_CHECK_SKIP=1 desabilita o check (CI sem wrangler auth).
 */

import { loadProjectEnv } from "./lib/env-loader.ts";

loadProjectEnv(); // carrega .env/.env.local antes de ler process.env

// ── Cloudflare API v4 endpoint de verificação ─────────────────────────────────
// GET /user/tokens/verify — 200 + { result: { status: "active" } } = válido
// 401 = token inválido ou ausente
// Diferente do `wrangler whoami` (que exige CLI instalado no PATH e pode ter
// side-effects de login interativo). REST puro é preferível aqui.
const CF_VERIFY_URL = "https://api.cloudflare.com/client/v4/user/tokens/verify";

export interface CloudflareTokenHealth {
  status: "active" | "missing" | "invalid" | "error";
  token_prefix?: string; // primeiros 8 chars do token (só pra debug, nunca log completo)
  error?: string;
  /** Quando status=active: o token está funcionando. */
  verified?: boolean;
}

/**
 * Verifica o token via API Cloudflare v4.
 *
 * @param apiToken  Token a verificar. Se omitido, lê de CLOUDFLARE_API_TOKEN.
 * @param fetchFn   Injeção de mock para testes. Default: fetch global.
 */
export async function checkCloudflareToken(
  apiToken?: string,
  fetchFn: typeof fetch = fetch,
): Promise<CloudflareTokenHealth> {
  const token = apiToken ?? process.env.CLOUDFLARE_API_TOKEN ?? "";

  if (!token) {
    return {
      status: "missing",
      error:
        "CLOUDFLARE_API_TOKEN não definida. Configure no .env ou rode `wrangler login`.",
    };
  }

  const prefix = token.slice(0, 8);

  try {
    const res = await fetchFn(CF_VERIFY_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (res.status === 401 || res.status === 403) {
      return {
        status: "invalid",
        token_prefix: prefix,
        error: `Token inválido (HTTP ${res.status}). Renovar CLOUDFLARE_API_TOKEN no .env ou rodar \`wrangler login\`.`,
      };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        status: "error",
        token_prefix: prefix,
        error: `Cloudflare API retornou ${res.status}: ${body.slice(0, 200)}`,
      };
    }

    const json = (await res.json()) as {
      result?: { status?: string };
      success?: boolean;
    };

    const cfStatus = json.result?.status ?? "";
    if (cfStatus !== "active") {
      return {
        status: "invalid",
        token_prefix: prefix,
        error: `Token Cloudflare não-ativo (status API: "${cfStatus}"). Renovar no .env.`,
      };
    }

    return { status: "active", token_prefix: prefix, verified: true };
  } catch (e) {
    return {
      status: "error",
      token_prefix: prefix,
      error: `Erro ao verificar token Cloudflare: ${(e as Error).message}`,
    };
  }
}

/**
 * Renderiza banner de erro para exibição no terminal.
 * Retorna string vazia quando health.status === "active".
 */
export function renderCloudflareTokenBanner(
  health: CloudflareTokenHealth,
): string {
  if (health.status === "active") return "";

  const lines: string[] = [
    "╔══════════════════════════════════════════════════════════════════╗",
    "║  ⚠️  CLOUDFLARE TOKEN INVÁLIDO / AUSENTE                         ║",
    "║                                                                  ║",
    `║  Status: ${health.status.padEnd(56)}║`,
    `║  Detalhe: ${(health.error ?? "").slice(0, 55).padEnd(55)}║`,
    "║                                                                  ║",
    "║  Ação necessária:                                                ║",
    "║    1. Renovar CLOUDFLARE_API_TOKEN no .env (do dashboard CF)     ║",
    "║    2. Ou rodar: wrangler login                                   ║",
    "║                                                                  ║",
    "║  Impacto: maintain-valid-editions vai falhar em §0d.bis          ║",
    "║  (votos do É IA? seriam rejeitados durante esta edição).         ║",
    "╚══════════════════════════════════════════════════════════════════╝",
  ];
  return lines.join("\n");
}

async function main(): Promise<number> {
  // Guard: CF_TOKEN_CHECK_SKIP=1 desabilita (usado em CI sem wrangler auth).
  if (process.env.CF_TOKEN_CHECK_SKIP === "1") {
    console.log(
      JSON.stringify({ status: "skipped", reason: "CF_TOKEN_CHECK_SKIP=1" }),
    );
    return 0;
  }

  const health = await checkCloudflareToken();
  console.log(JSON.stringify(health, null, 2));

  const banner = renderCloudflareTokenBanner(health);
  if (banner) console.error("\n" + banner + "\n");

  if (health.status === "active") return 0;
  if (health.status === "error") return 2; // rede/API indisponível — não bloquear
  return 1; // missing ou invalid
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (/\/scripts\/check-cloudflare-token\.ts$/.test(_argv1)) {
  main().then((code) => {
    process.exitCode = code;
  });
}

export { main };
