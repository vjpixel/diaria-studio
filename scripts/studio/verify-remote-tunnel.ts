/**
 * verify-remote-tunnel.ts (#3560)
 *
 * Smoke-test de segurança pós-ativação do acesso remoto ao studio-server
 * (Cloudflare Tunnel + Access, fatia 6 do epic "Studio UI" #3554).
 *
 * O studio-server (`scripts/studio-ui/server.ts`) faz bind exclusivo em
 * `127.0.0.1` — nunca fica exposto na rede local. O acesso remoto passa por
 * um hostname público (ex: `studio.diar.ia.br`) roteado pelo Cloudflare
 * Tunnel, com o Cloudflare Access na frente fazendo a autenticação (allowlist
 * de e-mail do editor + OTP/IdP). Access é responsabilidade da CONFIGURAÇÃO
 * do painel Cloudflare — não há autenticação própria no código do
 * studio-server (isso duplicaria o Access, ver `docs/studio-ui-remote-setup.md`).
 *
 * Este script confirma, batendo no hostname PÚBLICO sem nenhuma credencial,
 * que o Access está de fato na frente: uma requisição sem cookie/header de
 * auth válido NUNCA deve retornar o conteúdo real do Studio — só a página de
 * login do Access (redirect para `*.cloudflareaccess.com`) ou um
 * 401/403/erro de bloqueio.
 *
 * **Só funciona DEPOIS que o editor já ativou o tunnel + Access** (ver
 * `docs/studio-ui-remote-setup.md` e `scripts/studio/setup-remote-tunnel.ps1`).
 * Rodar antes disso resulta em erro de conexão (hostname ainda não existe) —
 * esperado, não é um bug deste script.
 *
 * Uso:
 *   npx tsx scripts/studio/verify-remote-tunnel.ts --url https://studio.diar.ia.br
 *   # ou via env var:
 *   STUDIO_REMOTE_URL=https://studio.diar.ia.br npx tsx scripts/studio/verify-remote-tunnel.ts
 *
 * Flags:
 *   --url URL          hostname público a testar (obrigatório, ou env STUDIO_REMOTE_URL)
 *   --marker STRING    trecho de conteúdo que só aparece na página real do Studio
 *                       autenticado (default: "Diar.ia Studio", o <title> da SPA)
 *   --timeout-ms N     timeout da requisição (default: 10000)
 *
 * Exit codes:
 *   0 = blocked  — Access está protegendo corretamente (nenhum vazamento)
 *   1 = leaked   — VAZAMENTO: conteúdo real respondeu sem autenticação
 *   2 = unknown  — resposta não reconhecida ou erro de rede (tratado como
 *                  falha por segurança — não confirma proteção)
 *
 * Stdout: JSON com shape TunnelCheckResult.
 */

import { loadProjectEnv } from "../lib/env-loader.ts";
import { parseArgs, isMainModule } from "../lib/cli-args.ts";

loadProjectEnv();

export type TunnelCheckState = "blocked" | "leaked" | "unknown";

export interface TunnelCheckResult {
  state: TunnelCheckState;
  status: number;
  reason: string;
}

/** Subconjunto de Headers usado pela classificação — facilita mock em teste. */
export interface HeadersLike {
  get(name: string): string | null;
}

const DEFAULT_MARKER = "Diar.ia Studio";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Classifica uma resposta HTTP (já lida) contra o hostname público, decidindo
 * se o Access está bloqueando corretamente (`blocked`), se o conteúdo real
 * vazou sem autenticação (`leaked`), ou se a resposta é ambígua (`unknown`,
 * tratada como falha por segurança — nunca assume proteção sem confirmação).
 *
 * Função pura — sem I/O — para permitir teste unitário determinístico contra
 * respostas mockadas do Access e do studio-server.
 */
export function classifyResponse(
  status: number,
  headers: HeadersLike,
  bodySnippet: string,
  marker: string = DEFAULT_MARKER,
): TunnelCheckResult {
  const location = headers.get("location") ?? "";
  const bodyLower = bodySnippet.toLowerCase();
  const markerLower = marker.toLowerCase();

  // Cloudflare Access redireciona requisições não-autenticadas para o login
  // hospedado em <team>.cloudflareaccess.com/cdn-cgi/access/login/...
  if (
    (status === 302 || status === 303 || status === 307) &&
    /cloudflareaccess\.com/i.test(location)
  ) {
    return {
      state: "blocked",
      status,
      reason: `redirect para login do Access (Location: ${location})`,
    };
  }

  // Bloqueio explícito via status code — também conta como protegido.
  if (status === 401 || status === 403) {
    return {
      state: "blocked",
      status,
      reason: `status ${status} — bloqueado sem conteúdo real`,
    };
  }

  // Access também pode servir a própria página de login com 200 (edge
  // renderiza o formulário de OTP/IdP em vez de redirecionar).
  if (
    status === 200 &&
    (bodyLower.includes("cloudflareaccess.com") || bodyLower.includes("cloudflare access"))
  ) {
    return {
      state: "blocked",
      status,
      reason: "página de login do Access servida (200, sem conteúdo do Studio)",
    };
  }

  // 200 com o marcador do Studio real presente = vazamento — o conteúdo
  // autenticado respondeu para uma requisição sem credenciais.
  if (status === 200 && bodyLower.includes(markerLower)) {
    return {
      state: "leaked",
      status,
      reason: `conteúdo real do Studio vazou sem autenticação (marcador "${marker}" encontrado no corpo)`,
    };
  }

  // Qualquer outra combinação é ambígua — nunca inferir "protegido" por
  // ausência de evidência positiva de vazamento. Falha por segurança.
  return {
    state: "unknown",
    status,
    reason: `resposta não reconhecida (status ${status}) — não foi possível confirmar proteção; tratando como falha`,
  };
}

/**
 * Bate no hostname público sem nenhuma credencial (sem cookie, sem header de
 * auth) e classifica a resposta. `fetchFn` é injetável para teste.
 */
export async function checkRemoteTunnel(
  url: string,
  opts: { marker?: string; timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<TunnelCheckResult> {
  const marker = opts.marker ?? DEFAULT_MARKER;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = opts.fetchFn ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(url, {
      method: "GET",
      redirect: "manual", // precisamos ver o 30x cru, não segui-lo
      headers: {
        Accept: "text/html",
        // Explicitamente NENHUM header de auth/cookie — é o ponto do teste.
      },
      signal: controller.signal,
    });

    let bodySnippet = "";
    try {
      // status 0 é o valor que `redirect: "manual"` retorna no fetch nativo
      // para respostas opaque-redirect — não há corpo legível nesse caso.
      if (res.type !== "opaqueredirect") {
        bodySnippet = (await res.text()).slice(0, 4000);
      }
    } catch {
      // corpo ilegível (ex: binário) — segue com snippet vazio, classificação
      // ainda funciona via status/location.
    }

    return classifyResponse(res.status, res.headers, bodySnippet, marker);
  } catch (e) {
    return {
      state: "unknown",
      status: 0,
      reason: `erro de rede: ${(e as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = args.values.url ?? process.env.STUDIO_REMOTE_URL;
  const marker = args.values.marker ?? DEFAULT_MARKER;
  const timeoutMs = args.values["timeout-ms"] ? Number(args.values["timeout-ms"]) : DEFAULT_TIMEOUT_MS;

  if (!url) {
    process.stderr.write(
      "Uso: verify-remote-tunnel.ts --url https://studio.diar.ia.br [--marker STRING] [--timeout-ms N]\n" +
        "(ou defina STUDIO_REMOTE_URL no ambiente/.env.local)\n\n" +
        "Só funciona DEPOIS que o tunnel + Access foram ativados pelo editor —\n" +
        "ver docs/studio-ui-remote-setup.md e scripts/studio/setup-remote-tunnel.ps1.\n",
    );
    process.exit(2);
  }

  const result = await checkRemoteTunnel(url, { marker, timeoutMs });

  if (result.state === "blocked") {
    process.stderr.write(`[verify-remote-tunnel] OK — Access está bloqueando corretamente. ${result.reason}\n`);
  } else if (result.state === "leaked") {
    process.stderr.write(
      `\n🚨 VAZAMENTO DETECTADO — ${url} respondeu com conteúdo real sem autenticação.\n` +
        `   ${result.reason}\n` +
        `   Ação imediata: revisar a policy do Cloudflare Access no painel CF —\n` +
        `   o hostname NÃO deveria responder sem OTP/IdP válido.\n\n`,
    );
  } else {
    process.stderr.write(
      `[verify-remote-tunnel] estado desconhecido — ${result.reason}\n` +
        `   Isso NÃO confirma que o Access está protegendo o hostname. Investigar manualmente.\n`,
    );
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  if (result.state === "blocked") process.exit(0);
  if (result.state === "leaked") process.exit(1);
  process.exit(2);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`Fatal error: ${(e as Error).message}\n`);
    process.exit(2);
  });
}
