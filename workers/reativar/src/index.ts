/**
 * workers/reativar/src/index.ts (#4476 item 3)
 *
 * Link de confirmação PERSONALIZADO pro segmento Pending do canal Brevo
 * próprio do editor (`context/snippets/brevo-diaria-pending-intro.md`) —
 * substitui o formulário de cadastro genérico da Beehiiv (2 etapas: clica →
 * digita o e-mail de novo) por 1 clique só. O e-mail chega via merge tag da
 * Brevo (`?email={{ contact.EMAIL }}`), SEM assinatura HMAC — mesmo padrão
 * já usado no link de voto "É IA?" desde a decisão #1186 (modo merge-tag,
 * `inject-poll-sig.ts` removido — ver CLAUDE.md §Publicação manual requer
 * prep-manual-publish.ts).
 *
 * Rota: GET /?email=X → busca a subscription existente por e-mail, DELETA o
 * registro Pending travado e CRIA uma nova do zero (mesma mecânica de
 * `promoteBeehiivSubscription`, `scripts/evaluate-brevo-diaria.ts` — mas
 * essa via é acionada por CLIQUE explícito do usuário, não por inferência de
 * score sobre abertura passiva; ver #4476 item 2 — as duas vias de promoção
 * nunca colidem porque `evaluate-brevo-diaria.ts` checa auto-confirmação
 * Beehiiv ANTES de avaliar score).
 *
 * ## Sem assinatura HMAC — risco aceito (mesmo perfil do link de /vote)
 *
 * Qualquer terceiro que descubra o padrão da URL pode "confirmar" um
 * e-mail alheio sem prova de posse da caixa de entrada. Risco aceito, mesmo
 * racional da decisão #1186: o pior caso é a pessoa passar a RECEBER a
 * newsletter (efeito equivalente a ela mesma confirmando o double opt-in da
 * Beehiiv por conta própria), não um vazamento de dado nem uma ação
 * destrutiva/irreversível — reverter é 1 clique de unsubscribe. Sem
 * KV/rate-limit por IP nesta 1ª versão: volume esperado é baixo (o link só
 * chega a quem já recebe o e-mail via Brevo, população cap 300).
 *
 * ## Verificação ao vivo (#4476 item 3) — CONFIRMADA em 260802
 *
 * O teste anterior (2 contatos sintéticos, `@example.com`/`@mailinator.com`)
 * ficou inconclusivo: os 2 caíram em `status:"invalid"` (domínio disposable)
 * antes de chegar em `pending`. Um teste seguinte, com 1 contato Pending
 * REAL (autorizado explicitamente pelo editor), fechou a lacuna:
 * `reactivate_existing:true` **não mudou o status** (continuou `pending`).
 * Deletar o registro e criar do zero **ativou direto** (`validating` →
 * `active` em segundos). Esta versão do Worker já reflete essa mecânica —
 * `reactivate_existing` foi removido, não é mais usado em lugar nenhum.
 */

export interface Env {
  /** Secret — `wrangler secret put BEEHIIV_API_KEY`. Sem ela, 503 amigável. */
  BEEHIIV_API_KEY?: string;
  /** Secret — `wrangler secret put BEEHIIV_PUBLICATION_ID`. */
  BEEHIIV_PUBLICATION_ID?: string;
  /** Override só pra teste (mock server local) — default `https://api.beehiiv.com/v2`. */
  BEEHIIV_API_URL?: string;
}

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" } as const;

/** Timeout explícito do fetch pra Beehiiv — mesmo racional de
 * `SUBSCRIBE_FETCH_TIMEOUT_MS` em `workers/poll/src/subscribe.ts` (#4438):
 * sem timeout, uma rede instável deixaria o `await` pendurado indefinidamente. */
export const ACTIVATE_FETCH_TIMEOUT_MS = 8000;

/** Espera antes de 1 releitura, só quando o CREATE responde `status:
 * "validating"` (#4476, achado ao vivo 260802): estado transitório — a
 * Beehiiv processa a validação de e-mail de forma assíncrona e resolve pra
 * `active` em poucos segundos (confirmado ao vivo: releitura ~alguns
 * segundos depois já mostrava `active`). Sem este retry, `handleConfirm`
 * mostraria "ainda não confirmado" pra quem na verdade só precisava de mais
 * 1-2s. Não faz retry pra outros status (ex: `invalid`) — são terminais. */
export const CONFIRM_RETRY_DELAY_MS = 2000;

// ── validação (pura) ─────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ParsedEmailParam =
  | { ok: true; email: string }
  | { ok: false; error: "missing_email" | "invalid_email" };

/** Pura — extrai e valida `?email=` da query string. Nunca lança. */
export function parseEmailParam(url: URL): ParsedEmailParam {
  const raw = url.searchParams.get("email");
  if (!raw || raw.trim() === "") return { ok: false, error: "missing_email" };
  const email = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "invalid_email" };
  return { ok: true, email };
}

// ── ativação (I/O) ───────────────────────────────────────────────────────

export interface ActivateResult {
  ok: boolean;
  status: number;
  reason?: "not_configured" | "beehiiv_error";
  /**
   * `data.status` da subscription APÓS o CREATE (ou o status já-`active`
   * encontrado no GET inicial, se a pessoa clicar 2x — idempotente). `ok:true`
   * reflete só o HTTP 2xx da última chamada; `beehiivStatus` carrega o estado
   * REAL, que `handleConfirm` usa pra decidir a página certa — nunca confiar
   * só no HTTP 2xx (achado do teste ao vivo #4476: POST pode responder 2xx
   * mesmo quando a subscription não fica `active`, ex: `status:"invalid"`).
   */
  beehiivStatus?: string | null;
}

/**
 * DELETE + CREATE — não mais `reactivate_existing` (#4476, mecânica
 * corrigida a partir do teste ao vivo 260802, ver header do módulo).
 * `fetchImpl` injetável pra teste — nunca faz rede real nos testes (#633).
 *
 * Passos:
 * 1. `GET .../subscriptions/by_email/{email}` — se já `active`, idempotente
 *    (pessoa clicou 2x, ou a via de score já promoveu): retorna sem tocar
 *    em nada. Se 404 (nunca existiu), pula direto pro passo 3.
 * 2. Se existe e não é `active`: `DELETE .../subscriptions/{id}` — remove o
 *    registro Pending travado. 404 aqui (sumiu entre o GET e o DELETE) não é
 *    erro, só segue.
 * 3. `POST .../subscriptions {email, send_welcome_email:false}` — cria do
 *    zero, SEM `reactivate_existing` (não há mais o que reativar). Cadastro
 *    novo ativa direto, sem double opt-in (mudança de fluxo da publicação) —
 *    é essa transição que o teste ao vivo confirmou.
 */
export async function activateSubscription(
  env: Env,
  email: string,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ActivateResult> {
  const apiKey = env.BEEHIIV_API_KEY;
  const pubId = env.BEEHIIV_PUBLICATION_ID;
  if (!apiKey || !pubId) {
    // #4476 achado silent-failure-hunter: sem log estruturado, um secret
    // ausente/rotacionado ficava invisível em wrangler tail/Workers Logs —
    // mesmo padrão de `event`/contexto já usado em workers/poll/src/vote.ts.
    // Nunca loga o email (dado pessoal) neste ponto — a config ausente não
    // depende do contato.
    console.error(JSON.stringify({ event: "reativar_not_configured", missing_api_key: !apiKey, missing_pub_id: !pubId }));
    return { ok: false, status: 503, reason: "not_configured" };
  }

  const base = env.BEEHIIV_API_URL ?? "https://api.beehiiv.com/v2";
  const authHeaders = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

  // 1) estado atual (idempotência — já active não precisa de mais nada).
  let existing: { id: string; status: string } | null = null;
  try {
    const getRes = await fetchImpl(`${base}/publications/${pubId}/subscriptions/by_email/${encodeURIComponent(email)}`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(ACTIVATE_FETCH_TIMEOUT_MS),
    });
    if (getRes.status === 404) {
      existing = null;
    } else if (!getRes.ok) {
      console.error(JSON.stringify({ event: "reativar_beehiiv_non_2xx", step: "get", status: getRes.status }));
      return { ok: false, status: getRes.status, reason: "beehiiv_error" };
    } else {
      const body = (await getRes.json().catch(() => null)) as { data?: { id?: string; status?: string } } | null;
      existing = body?.data?.id ? { id: body.data.id, status: body.data.status ?? "" } : null;
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "reativar_fetch_failed", step: "get", error: String(e) }));
    return { ok: false, status: 502, reason: "beehiiv_error" };
  }

  if (existing?.status === "active") {
    return { ok: true, status: 200, beehiivStatus: "active" };
  }

  // 2) deleta o registro travado (se existir e não for active).
  if (existing) {
    try {
      const delRes = await fetchImpl(`${base}/publications/${pubId}/subscriptions/${existing.id}`, {
        method: "DELETE",
        headers: authHeaders,
        signal: AbortSignal.timeout(ACTIVATE_FETCH_TIMEOUT_MS),
      });
      if (!delRes.ok && delRes.status !== 404) {
        console.error(JSON.stringify({ event: "reativar_beehiiv_non_2xx", step: "delete", status: delRes.status }));
        return { ok: false, status: delRes.status, reason: "beehiiv_error" };
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "reativar_fetch_failed", step: "delete", error: String(e) }));
      return { ok: false, status: 502, reason: "beehiiv_error" };
    }
  }

  // 3) cria do zero.
  let res: Response;
  try {
    res = await fetchImpl(`${base}/publications/${pubId}/subscriptions`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ email, send_welcome_email: false }),
      signal: AbortSignal.timeout(ACTIVATE_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error(JSON.stringify({ event: "reativar_fetch_failed", step: "create", error: String(e) }));
    return { ok: false, status: 502, reason: "beehiiv_error" };
  }
  if (!res.ok) {
    console.error(JSON.stringify({ event: "reativar_beehiiv_non_2xx", step: "create", status: res.status }));
    return { ok: false, status: res.status, reason: "beehiiv_error" };
  }

  let beehiivStatus: string | null = null;
  try {
    const body = (await res.json()) as { data?: { status?: string } };
    beehiivStatus = body.data?.status ?? null;
  } catch (e) {
    console.warn(JSON.stringify({ event: "reativar_response_parse_failed", step: "create", status: res.status, error: String(e) }));
  }

  // Estado transitório — 1 retry curto antes de aceitar como resultado final
  // (ver `CONFIRM_RETRY_DELAY_MS`). Falha na releitura mantém o
  // `beehiivStatus` original ("validating") — `handleConfirm` trata como
  // não-confirmado, fail-safe (nunca mostra sucesso sem confirmar de fato).
  if (beehiivStatus === "validating") {
    await sleepImpl(CONFIRM_RETRY_DELAY_MS);
    try {
      const recheck = await fetchImpl(`${base}/publications/${pubId}/subscriptions/by_email/${encodeURIComponent(email)}`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(ACTIVATE_FETCH_TIMEOUT_MS),
      });
      if (recheck.ok) {
        const body = (await recheck.json().catch(() => null)) as { data?: { status?: string } } | null;
        if (body?.data?.status) beehiivStatus = body.data.status;
      }
    } catch (e) {
      console.warn(JSON.stringify({ event: "reativar_recheck_failed", error: String(e) }));
    }
  }

  return { ok: true, status: res.status, beehiivStatus };
}

// ── HTML (puro) ───────────────────────────────────────────────────────────

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — diar.ia.br</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;text-align:center;color:#1a1a1a}
h1{font-size:1.4rem;margin-bottom:0.5rem}
p{color:#555;line-height:1.5}
a{color:#0a5}
</style></head>
<body>${body}</body></html>`;
}

export function renderSuccessPage(): string {
  return page(
    "Cadastro confirmado",
    `<h1>Cadastro confirmado!</h1><p>Você vai voltar a receber a diária direto pela Beehiiv a partir da próxima edição.</p><p><a href="https://diar.ia.br">Voltar pra diar.ia.br</a></p>`,
  );
}

export function renderMissingEmailPage(): string {
  return page(
    "Link inválido",
    `<h1>Link inválido</h1><p>Este link de confirmação não tem um e-mail associado. Volte no e-mail que você recebeu e clique no botão de novo.</p>`,
  );
}

export function renderInvalidEmailPage(): string {
  return page(
    "Link inválido",
    `<h1>Link inválido</h1><p>O e-mail deste link não parece válido. Volte no e-mail que você recebeu e clique no botão de novo.</p>`,
  );
}

export function renderErrorPage(): string {
  return page(
    "Algo deu errado",
    `<h1>Algo deu errado</h1><p>Não conseguimos confirmar seu cadastro agora. Tente de novo em alguns minutos, ou confirme direto em <a href="https://diar.ia.br">diar.ia.br</a>.</p>`,
  );
}

/**
 * #4476 self-review (achado do teste ao vivo): a Beehiiv pode responder 2xx
 * ao POST sem que a subscription fique `active` de fato (ex: `status:
 * "invalid"`). Página distinta de `renderErrorPage` — o clique FOI recebido
 * e processado (não é um erro de rede/config), só o resultado não é o
 * esperado; a mensagem orienta a pessoa a tentar de novo pela via genérica
 * em vez de sugerir um problema técnico do lado do site.
 */
export function renderNotConfirmedPage(): string {
  return page(
    "Ainda não confirmado",
    `<h1>Ainda não confirmado</h1><p>Recebemos seu clique, mas não conseguimos confirmar o cadastro automaticamente. Tente se cadastrar direto em <a href="https://diar.ia.br">diar.ia.br</a>.</p>`,
  );
}

// ── handler ────────────────────────────────────────────────────────────

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

export async function handleConfirm(
  url: URL,
  env: Env,
  fetchImpl: typeof fetch = fetch,
  sleepImpl?: (ms: number) => Promise<void>,
): Promise<Response> {
  const parsed = parseEmailParam(url);
  if (!parsed.ok) {
    const html = parsed.error === "missing_email" ? renderMissingEmailPage() : renderInvalidEmailPage();
    return htmlResponse(html, 400);
  }
  const result = sleepImpl
    ? await activateSubscription(env, parsed.email, fetchImpl, sleepImpl)
    : await activateSubscription(env, parsed.email, fetchImpl);
  if (!result.ok) {
    const status = result.reason === "not_configured" ? 503 : 502;
    return htmlResponse(renderErrorPage(), status);
  }
  // #4476 self-review (achado do teste ao vivo): HTTP 2xx no POST não é
  // garantia de `active` — só `beehiivStatus === "active"` conta como
  // confirmação real (mesma correção aplicada em
  // `verifyPromotedToBeehiiv`, scripts/evaluate-brevo-diaria.ts).
  if (result.beehiivStatus === "active") return htmlResponse(renderSuccessPage(), 200);
  return htmlResponse(renderNotConfirmedPage(), 200);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...CORS_HEADERS, "Access-Control-Allow-Methods": "GET, OPTIONS" } });
    }
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    return handleConfirm(url, env);
  },
};
