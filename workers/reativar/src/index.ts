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
 * Rota: GET /?email=X → chama `POST /publications/{id}/subscriptions` da
 * Beehiiv com `{email, reactivate_existing: true, send_welcome_email: false}`
 * (mesmo payload de `promoteBeehiivSubscription`,
 * `scripts/evaluate-brevo-diaria.ts` — mas essa via é acionada por CLIQUE
 * explícito do usuário, não por inferência de score sobre abertura passiva;
 * ver #4476 item 2 — as duas vias de promoção nunca colidem porque
 * `evaluate-brevo-diaria.ts` checa auto-confirmação Beehiiv ANTES de
 * avaliar score).
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
 * ## Verificação ao vivo (#4476 item 3, autorizada explicitamente pelo editor)
 * — INCONCLUSIVA pra pergunta central (comment-analyzer, achado pós-merge)
 *
 * O comportamento REAL de `reactivate_existing: true` contra a API da
 * Beehiiv (ativa direto vs. exige confirmação adicional) foi testado com 2
 * contatos de teste sintéticos (não 1) — ver corpo do PR do #4476 pro
 * request/response exato. Os 2 caíram em `status:"invalid"` (domínio
 * flagado disposable) antes de chegar em `pending`, então a hipótese CENTRAL
 * do item 3 — `reactivate_existing:true` reativa um contato `pending` REAL
 * pra `active`? — NUNCA foi exercitada, nem confirmada nem refutada. O que
 * o teste confirmou de fato: HTTP 2xx no POST não garante `status:"active"`
 * (motivou a checagem explícita em `activateSubscription`/`handleConfirm`
 * abaixo). **Não fazer rollout real sem antes confirmar com 1 e-mail
 * pessoal em modo Pending genuíno** (assinar e não confirmar, depois clicar
 * no link deste Worker) — recomendação registrada no PR, ainda não
 * executada até este comentário.
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
   * `data.status` do corpo da resposta da Beehiiv (#4476 self-review, achado
   * do teste ao vivo): o POST pode responder 2xx (`ok:true` nesta struct)
   * MESMO quando a subscription não fica `active` — visto ao vivo com
   * `status:"invalid"` (Beehiiv aceita o POST mas a validação de e-mail
   * rejeita o contato). `beehiivStatus` deixa essa distinção explícita pro
   * caller (`handleConfirm`) decidir a página certa em vez de confiar só no
   * HTTP 2xx.
   */
  beehiivStatus?: string | null;
}

/**
 * `POST /publications/{id}/subscriptions` com `reactivate_existing: true` —
 * (re)ativa a subscription existente sem exigir novo double opt-in. `fetchImpl`
 * injetável pra teste — nunca faz rede real nos testes (#633).
 *
 * Duas claims distintas aqui — não confundir (comment-analyzer, achado
 * pós-merge #4476):
 *
 * 1. "Bypassa o double opt-in" — **segundo a documentação pública da
 *    Beehiiv, NÃO verificado ao vivo**. O teste ao vivo do #4476 (2 contatos
 *    sintéticos, ver header do módulo) não exercitou essa transição: os 2
 *    caíram em `status:"invalid"` (domínio disposable) antes de chegar em
 *    `pending`, então `pending → active` via este endpoint nunca foi
 *    observado de fato.
 * 2. "A resposta do POST já inclui `data.status`, sem precisar de uma 2ª
 *    chamada (GET) só pra confirmar" E "HTTP 2xx não garante `status:
 *    active`" — **isto SIM foi confirmado ao vivo** no mesmo teste (achado
 *    real: `status:"invalid"` veio no corpo do POST 201). Por isso `ok:true`
 *    reflete só o HTTP 2xx do POST; `beehiivStatus` carrega o estado REAL da
 *    subscription, que `handleConfirm` usa pra decidir a página de sucesso
 *    vs. "ainda não confirmado" — nunca confiar só no HTTP 2xx.
 */
export async function activateSubscription(
  env: Env,
  email: string,
  fetchImpl: typeof fetch = fetch,
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
  let res: Response;
  try {
    res = await fetchImpl(`${base}/publications/${pubId}/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ email, reactivate_existing: true, send_welcome_email: false }),
      signal: AbortSignal.timeout(ACTIVATE_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    // fetch-failure/timeout (AbortSignal.timeout acima) — engolido antes
    // desta correção, agora logado estruturado (nunca o email cru).
    console.error(JSON.stringify({ event: "reativar_fetch_failed", error: String(e) }));
    return { ok: false, status: 502, reason: "beehiiv_error" };
  }
  if (!res.ok) {
    console.error(JSON.stringify({ event: "reativar_beehiiv_non_2xx", status: res.status }));
    return { ok: false, status: res.status, reason: "beehiiv_error" };
  }

  let beehiivStatus: string | null = null;
  try {
    const body = (await res.json()) as { data?: { status?: string } };
    beehiivStatus = body.data?.status ?? null;
  } catch (e) {
    // corpo não-JSON/vazio — não é motivo pra falhar o HTTP 2xx já confirmado,
    // só deixa beehiivStatus null (handleConfirm trata como "não confirmado
    // ainda" via a mesma checagem !== "active") — mas agora logado, pra não
    // engolir silenciosamente um contrato de resposta que mudou.
    console.warn(JSON.stringify({ event: "reativar_response_parse_failed", status: res.status, error: String(e) }));
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

export async function handleConfirm(url: URL, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const parsed = parseEmailParam(url);
  if (!parsed.ok) {
    const html = parsed.error === "missing_email" ? renderMissingEmailPage() : renderInvalidEmailPage();
    return htmlResponse(html, 400);
  }
  const result = await activateSubscription(env, parsed.email, fetchImpl);
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
