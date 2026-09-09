/**
 * workers/meta-leads/src/leadgen.ts (#7769)
 *
 * Miolo PURO do webhook de Lead Ads da Meta — parsing, validação de
 * assinatura e extração de campos do lead. Zero I/O: tudo que fala com a
 * rede (Graph API, Kit) vive em `index.ts`, pra este arquivo ser testável
 * sem mock de fetch (mesma fronteira de `scripts/lib/shared/`, #2747).
 *
 * ## Por que este worker existe
 *
 * Habilitar o local de conversão "Site e formulário instantâneo" no ad set
 * (recomendação do Opportunity Score, #7768) captura o lead DENTRO do Meta:
 * ele nunca chega no nosso site, então nenhum dos 3 funis existentes
 * (poll/cursos/reativar) o vê. Sem esta ponte, o lead fica parado no Leads
 * Center e a pessoa nunca recebe a newsletter — com o clique já pago.
 *
 * As pontes de mercado (Zapier, LeadsBridge, SaveMyLeads) resolveriam isso
 * por assinatura mensal; o projeto tem princípio de zero custo recorrente,
 * e já tem 13 Workers em produção. A ponte é nossa.
 *
 * ## Fail-alto, ao contrário do resto do projeto
 *
 * O padrão daqui é fail-soft (ausência de secret = no-op silencioso). Este
 * worker faz o OPOSTO de propósito: quando não consegue processar um lead,
 * responde não-200 pra Meta fazer retry.
 *
 * O precedente que justifica a exceção é recente e caro: o #5504
 * (Conversions API) é fail-soft, ficou sem o secret `META_CAPI_ACCESS_TOKEN`
 * e virou no-op silencioso — descoberto meses depois, com
 * `server_last_fired_time` ainda em epoch 0. Ali o custo era medição
 * degradada. Aqui seria uma pessoa real que preencheu um formulário e
 * sumiu, e a Meta só guarda o lead por 90 dias. Silêncio não é opção.
 */

/** Campo do webhook que carrega lead novo. A Página pode estar assinada em
 *  outros campos (`feed`, `messages`); tudo que não for isto é ignorado com
 *  200 — não é erro nosso, só não é assunto deste worker. */
export const LEADGEN_FIELD = "leadgen";

/**
 * Atribuição gravada no Kit pra todo lead que entra por aqui.
 *
 * O triplo é o MESMO do teste pago já registrado em
 * `scripts/lib/shared/utm-registry.ts` (`ads-meta-2608`) — o lead veio da
 * mesma campanha, mudar o `utm_source` aqui quebraria a comparação de canal
 * que o `spend.csv` e o relatório de CAC fazem.
 *
 * O que distingue é o `referringSite`: o lead de formulário instantâneo
 * nunca passou pelo site, então precisa ser separável do lead que clicou no
 * mesmo anúncio e converteu na landing page. Mesmo padrão de `referringSite`
 * por posição de `workers/poll/src/subscribe.ts` (#4530 Parte B).
 */
export const META_INSTANT_FORM_UTM = {
  source: "meta-ads",
  medium: "paid_social",
  campaign: "ads-meta-2608",
  referringSite: "meta-instant-form",
} as const;

/** Resultado do handshake `GET /webhook` da Meta. */
export type VerificationResult =
  | { ok: true; challenge: string }
  | { ok: false; status: number; error: string };

/**
 * Handshake de verificação da subscrição (`GET`). A Meta chama uma vez, ao
 * salvar a URL do webhook no painel do app, com `hub.mode=subscribe`,
 * `hub.verify_token` (o valor que NÓS escolhemos e configuramos nos dois
 * lados) e `hub.challenge` (que precisa ser ecoado cru no corpo).
 *
 * Token ausente no env → 503, nunca "passa direto": um worker sem token
 * configurado que aceitasse qualquer verificação deixaria qualquer um
 * apontar uma subscrição pra cá.
 *
 * @pure
 */
export function resolveVerification(
  params: URLSearchParams,
  expectedToken: string | undefined,
): VerificationResult {
  if (!expectedToken) {
    return { ok: false, status: 503, error: "verify_token_not_configured" };
  }
  if (params.get("hub.mode") !== "subscribe") {
    return { ok: false, status: 400, error: "bad_mode" };
  }
  const token = params.get("hub.verify_token") ?? "";
  if (!timingSafeEqualStr(token, expectedToken)) {
    return { ok: false, status: 403, error: "bad_verify_token" };
  }
  const challenge = params.get("hub.challenge");
  if (!challenge) {
    return { ok: false, status: 400, error: "missing_challenge" };
  }
  return { ok: true, challenge };
}

/**
 * Comparação de string em tempo constante. Não é dado de altíssimo valor,
 * mas o custo é uma linha e evita o oráculo de timing clássico do `===` em
 * comparação de segredo.
 *
 * @pure
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Valida `X-Hub-Signature-256` — HMAC-SHA256 do corpo CRU com o App Secret,
 * prefixado por `sha256=`.
 *
 * ARMADILHA CONHECIDA, e a razão de esta função receber `rawBody: string` em
 * vez do objeto já parseado: a assinatura é sobre os BYTES exatos que a Meta
 * mandou. Reserializar (`JSON.stringify(JSON.parse(body))`) muda espaçamento
 * e ordem e invalida a assinatura de formas que parecem "às vezes funciona".
 * O caller precisa ler `await request.text()` UMA vez e passar essa string
 * pra cá e pro parse.
 */
export async function verifySignature(
  rawBody: string,
  header: string | null,
  appSecret: string | undefined,
): Promise<boolean> {
  if (!appSecret) return false;
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = header.slice("sha256=".length).trim().toLowerCase();

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const actual = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqualStr(actual, expected);
}

/** Um lead anunciado pelo webhook — só o id; os dados vêm de uma 2ª chamada. */
export interface LeadgenNotification {
  leadgenId: string;
  formId: string;
  adId: string;
  pageId: string;
  createdTime: number;
}

/**
 * Extrai as notificações de lead do corpo do webhook. Nunca lança: corpo
 * malformado devolve lista vazia (o caller responde 200 — retry da Meta não
 * consertaria um payload que já chegou quebrado).
 *
 * Um POST pode trazer VÁRIAS entries e várias changes por entry; a Meta
 * agrupa. Ignora silenciosamente change de campo que não seja `leadgen`.
 *
 * @pure
 */
export function parseLeadgenPayload(rawBody: string): LeadgenNotification[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return [];
  }
  const root = parsed as { object?: unknown; entry?: unknown };
  if (!Array.isArray(root?.entry)) return [];

  const out: LeadgenNotification[] = [];
  for (const entry of root.entry) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const c = change as { field?: unknown; value?: Record<string, unknown> };
      if (c?.field !== LEADGEN_FIELD) continue;
      const v = c.value;
      const leadgenId = typeof v?.leadgen_id === "string" ? v.leadgen_id : String(v?.leadgen_id ?? "");
      if (!leadgenId || leadgenId === "undefined") continue;
      out.push({
        leadgenId,
        formId: String(v?.form_id ?? ""),
        adId: String(v?.ad_id ?? ""),
        pageId: String(v?.page_id ?? ""),
        createdTime: typeof v?.created_time === "number" ? v.created_time : 0,
      });
    }
  }
  return out;
}

/** Dados úteis de um lead, já normalizados a partir do `field_data` da Graph. */
export interface LeadFields {
  email: string;
  name: string;
}

/**
 * Normaliza a resposta da Graph API (`GET /{leadgen_id}`).
 *
 * O formato é uma lista de `{ name, values: [...] }` cujas CHAVES variam
 * conforme o formulário foi montado no painel — `email` é o nome canônico
 * da Meta pro campo de e-mail, mas formulário com pergunta customizada pode
 * trazer outra coisa. Cobrimos os aliases conhecidos e, no fim, qualquer
 * valor que se pareça com e-mail, pra um formulário novo não silenciar o
 * cadastro só por ter nomeado o campo diferente.
 *
 * @pure
 */
export function extractLeadFields(payload: unknown): LeadFields {
  const fd = (payload as { field_data?: unknown })?.field_data;
  const map = new Map<string, string>();
  if (Array.isArray(fd)) {
    for (const f of fd) {
      const item = f as { name?: unknown; values?: unknown };
      const key = String(item?.name ?? "").toLowerCase();
      const value = Array.isArray(item?.values) ? String(item.values[0] ?? "") : "";
      if (key && value) map.set(key, value);
    }
  }

  const email =
    map.get("email") ??
    map.get("email_address") ??
    map.get("e-mail") ??
    firstEmailLike(map) ??
    "";

  const name =
    map.get("full_name") ??
    map.get("nome_completo") ??
    joinFirstLast(map.get("first_name"), map.get("last_name")) ??
    map.get("nome") ??
    "";

  return { email: email.trim(), name: name.trim() };
}

function firstEmailLike(map: Map<string, string>): string | undefined {
  for (const v of map.values()) {
    if (isEmailLike(v)) return v;
  }
  return undefined;
}

function joinFirstLast(first?: string, last?: string): string | undefined {
  const parts = [first, last].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length ? parts.join(" ") : undefined;
}

/**
 * Validação de formato de e-mail. Deliberadamente a MESMA regra do resto do
 * projeto (`isValidVoteEmailFormat`, `workers/poll/src/lib.ts`) — um e-mail
 * aceito num funil e recusado noutro seria divergência silenciosa.
 *
 * @pure
 */
export function isEmailLike(email: string): boolean {
  const e = (email ?? "").trim();
  if (!e || e.length > 254) return false;
  if (/\s/.test(e)) return false;
  const at = e.indexOf("@");
  if (at <= 0 || at !== e.lastIndexOf("@")) return false;
  const domain = e.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return false;
  return true;
}
