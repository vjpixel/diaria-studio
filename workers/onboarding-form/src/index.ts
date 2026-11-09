/**
 * workers/onboarding-form/src/index.ts (#10605)
 *
 * Formulário de perfil/interesses do onboarding. Contrato completo (rotas,
 * formato, como o executor grava "preencheu" no store) em
 * `scripts/lib/onboarding-form-contract.ts`; HTML em `./render.ts`. Sem o KV
 * `ONBOARDING_FORM` declarado (ver wrangler.toml) toda rota responde 503
 * `not_configured`.
 *
 * #10657: link assinado por pessoa (`?email=...&sig=...`,
 * `scripts/lib/onboarding-form-link-sig.ts`, o MESMO módulo do executor —
 * trim e tamanho mínimo do segredo vivem lá). Só as rotas do formulário (`/`
 * e `/enviar`) exigem o secret `ONBOARDING_FORM_LINK_SECRET` (ausente ou
 * curto: 503 `not_configured`); `/api/respostas` não depende dele, senão um
 * secret faltando apareceria no executor como "respostas indisponíveis". GET
 * sem assinatura válida mostra a página de link inválido (sem formulário);
 * POST sem assinatura válida para o e-mail enviado responde 403 e não grava
 * nada no KV. Toda recusa vai pro log com o motivo, nunca com e-mail ou
 * assinatura.
 *
 * #12490: cada resposta leva `form_version` e vai também para o histórico
 * (`hist:`, nunca sobrescrito; `planFormResponseWrites`); `/api/respostas`
 * segue servindo a mais recente por pessoa, `?historico=1` serve o histórico.
 * #12495: com `RESULTS_URL`/`RESULTS_PUBLISHED_AT` preenchidos, a página de
 * obrigado mostra o link dos resultados.
 * #12509: `/api/respostas` é paginado (`?cursor=`, `next_cursor`), uma
 * página por invocação, para não passar do teto de operações de KV.
 * #12504: rascunho de quem preencheu parte e não enviou — `POST /rascunho`
 * (mesma assinatura do envio, tamanho máximo, rate limit por e-mail), o
 * `GET /` devolve o formulário preenchido com ele, o envio o apaga e
 * `/api/respostas?rascunhos=1` os lista para o executor e o perfil.
 * #12522: envio recusado na validação volta ao formulário preenchido, com a
 * mensagem na pergunta, em vez de uma página de erro genérica.
 */

import {
  FORM_DRAFT_MAX_BYTES,
  FORM_DRAFT_PREFIX,
  FORM_DRAFT_TTL_S,
  FORM_DRAFTS_QUERY_PARAM,
  FORM_HISTORY_PREFIX,
  FORM_VERSION,
  buildFormDraftRecord,
  decideFormDraftWrite,
  draftPrefill,
  formDraftKey,
  formResponseKey,
  isAuthorizedResponsesRequest,
  parseFormDraft,
  parseFormSubmission,
  planFormResponseWrites,
  prefillEmailFromQuery,
  readFormResponsesPage,
  readKvJsonPage,
  resolveFormResults,
  type FormDraft,
  type FormResponse,
  type FormResponsesPage,
  type FormResponsesPayload,
} from "../../../scripts/lib/onboarding-form-contract.ts";
import {
  checkFormEmailSig,
  checkLinkSecret,
  formDurationFromToken,
  FORM_RENDERED_FIELD,
  signFormRenderedAt,
  type FormSigRejection,
} from "../../../scripts/lib/onboarding-form-link-sig.ts";
import { collectFormFields, FORM_DRAFT_ROUTE, renderErrorHtml, renderFormHtml, renderInvalidLinkHtml, renderThanksHtml } from "./render.ts";
import { renderCuradoriaRobotsTxt } from "../../../scripts/lib/shared/robots-txt.ts"; // #10809

/**
 * `robots.txt` PRÓPRIO de `formulario.diar.ia.br` (#10809, guard #4777): todo
 * Worker com `custom_domain` serve o seu, senão nasce servindo o default da
 * Cloudflare. Mesmo helper dos outros Workers. O envio (`/enviar`) e a API do
 * executor (`/api/`) ficam fora do rastreamento. Não depende de KV nem de
 * secret.
 *
 * #10871: declara `Sitemap:` apontando pro `/sitemap.xml` PRÓPRIO do host
 * (nunca o do site principal, regra de `renderCuradoriaRobotsTxt`) — o alarme
 * `robots-txt-drift-check` exige a linha em todo host descoberto. O formulário
 * só abre com link assinado por pessoa, então não há página a listar: o
 * sitemap é um `<urlset>` vazio e válido, honesto sobre isso.
 */
const FORM_SITEMAP_URL = "https://formulario.diar.ia.br/sitemap.xml";
const ROBOTS_TXT = renderCuradoriaRobotsTxt(FORM_SITEMAP_URL, { extraDisallowPaths: ["/enviar", "/api/"] });
/** #10871: sitemap sem URLs — o formulário não tem página pública indexável. */
const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n`;

export interface Env {
  ONBOARDING_FORM?: KVNamespace;
  RESPONSES_TOKEN?: string;
  /** #10657: segredo do HMAC do link (mesmo valor do executor). */
  ONBOARDING_FORM_LINK_SECRET?: string;
  /** #12495: versão web restrita dos resultados e instante do envio da
   *  edição especial (`[vars]` do wrangler.toml). Os dois vazios = página de
   *  obrigado genérica (`resolveFormResults`). */
  RESULTS_URL?: string;
  RESULTS_PUBLISHED_AT?: string;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function notConfigured(what: string): Response {
  console.error(JSON.stringify({ event: "not_configured", what }));
  return new Response(JSON.stringify({ error: "not_configured" }), { status: 503 });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * #12504: `POST /rascunho`. Ordem igual à do envio: tamanho, corpo legível,
 * assinatura do link para o e-mail enviado (antes de tocar no KV), limpeza
 * (`parseFormDraft`), e só então as leituras (rascunho anterior, para o rate
 * limit; resposta mais recente, para não ressuscitar o rascunho logo depois
 * do envio) e a gravação com `expirationTtl`. Nunca devolve conteúdo do
 * rascunho: a resposta é só o status.
 */
async function saveDraft(request: Request, kv: KVNamespace, secret: string): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > FORM_DRAFT_MAX_BYTES) return json({ error: "too_large" }, 413);
  let fields: Record<string, string | string[]>;
  try {
    const body = await request.arrayBuffer();
    if (body.byteLength > FORM_DRAFT_MAX_BYTES) return json({ error: "too_large" }, 413);
    const ctype = request.headers.get("content-type") ?? "";
    fields = collectFormFields((await new Request("https://rascunho.invalid/", { method: "POST", body, headers: { "content-type": ctype } }).formData()).entries());
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const check = await checkFormEmailSig(one(fields.email), one(fields.sig), secret);
  if (!check.ok) {
    console.warn(JSON.stringify({ event: "link_invalido", route: FORM_DRAFT_ROUTE, reason: check.reason }));
    return json({ error: "forbidden" }, 403);
  }
  const parsed = parseFormDraft(fields);
  if (!parsed) return json({ error: "bad_request" }, 400);
  const nowMs = Date.now();
  try {
    const [prev, latest] = await Promise.all([kv.get(formDraftKey(parsed.email)), kv.get(formResponseKey(parsed.email))]);
    const decision = decideFormDraftWrite(Object.keys(parsed.answers).length, prev, latest, nowMs);
    if (decision.action === "skip") return json({ ok: false, reason: decision.reason }, decision.reason === "rate_limited" ? 429 : 202);
    if (decision.action === "delete") await kv.delete(formDraftKey(parsed.email));
    else await kv.put(formDraftKey(parsed.email), JSON.stringify(buildFormDraftRecord(parsed, nowMs)), { expirationTtl: FORM_DRAFT_TTL_S });
  } catch (e) {
    console.error(JSON.stringify({ event: "rascunho_gravar_falhou", error: (e as Error).message }));
    return json({ error: "kv_failure" }, 503);
  }
  return json({ ok: true }, 200);
}

/** Log de recusa do link: só rota e motivo (nunca e-mail nem assinatura). */
function rejectLink(route: "/" | "/enviar", reason: FormSigRejection): Response {
  console.warn(JSON.stringify({ event: "link_invalido", route, reason }));
  return html(renderInvalidLinkHtml(), 403);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // #10809: antes do check de KV — robots.txt não depende de configuração.
    if (request.method === "GET" && url.pathname === "/robots.txt") {
      return new Response(ROBOTS_TXT, {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
      });
    }
    // #10871: o sitemap declarado no robots.txt, também antes do check de KV.
    if (request.method === "GET" && url.pathname === "/sitemap.xml") {
      return new Response(SITEMAP_XML, {
        headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
      });
    }
    if (!env.ONBOARDING_FORM) return notConfigured("kv ONBOARDING_FORM");
    const isFormRoute =
      (request.method === "GET" && url.pathname === "/") ||
      (request.method === "POST" && (url.pathname === "/enviar" || url.pathname === FORM_DRAFT_ROUTE));
    const secretCheck = checkLinkSecret(env.ONBOARDING_FORM_LINK_SECRET);
    if (isFormRoute && !secretCheck.ok) return notConfigured("secret ONBOARDING_FORM_LINK_SECRET");
    const secret = secretCheck.ok ? secretCheck.secret : "";

    if (request.method === "GET" && url.pathname === "/") {
      const email = prefillEmailFromQuery(url.searchParams.get("email"));
      const sig = url.searchParams.get("sig") ?? "";
      const check = await checkFormEmailSig(email, sig, secret);
      if (!check.ok) return rejectLink("/", check.reason);
      // v3: hora em que a página foi gerada, assinada — o envio grava `duration_s`.
      // Falha ao assinar a hora nunca derruba a página: sai sem o campo (o envio fica sem `duration_s`).
      let rendered: string | null = null;
      try {
        rendered = await signFormRenderedAt(email, Date.now() / 1000, secret);
      } catch (e) {
        console.error(JSON.stringify({ event: "rendered_at_sign_failed", error: (e as Error).message }));
      }
      // #12504: retoma o rascunho. Falha de leitura nunca derruba a página:
      // sai o formulário vazio (a pessoa perde a retomada, não o formulário).
      let prefill: Record<string, string> | null = null;
      try {
        prefill = draftPrefill(await env.ONBOARDING_FORM.get(formDraftKey(email)), email);
      } catch (e) {
        console.error(JSON.stringify({ event: "rascunho_leitura_falhou", error: (e as Error).message }));
      }
      return html(renderFormHtml(email, sig, undefined, rendered, { prefill, resumed: prefill != null }));
    }

    if (request.method === "POST" && url.pathname === FORM_DRAFT_ROUTE) {
      return saveDraft(request, env.ONBOARDING_FORM, secret);
    }

    if (request.method === "POST" && url.pathname === "/enviar") {
      // Ordem: (1) corpo legível; (2) assinatura do link para o e-mail enviado
      // — antes de QUALQUER validação das respostas, para um POST forjado
      // nunca chegar perto do KV; (3) respostas válidas; (4) gravação.
      let form: FormData;
      try {
        form = await request.formData();
      } catch (e) {
        console.error(`[onboarding-form] corpo do POST ilegível: ${(e as Error).message}`);
        return html(renderErrorHtml("o envio chegou incompleto"), 400);
      }
      // Caixas de seleção mandam um valor por opção marcada: preservar os repetidos.
      const fields = collectFormFields(form.entries());
      // #10657: só grava com a assinatura do link para ESTE e-mail — sem isso
      // qualquer um marcava outra pessoa como "preencheu" ou sobrescrevia as
      // respostas dela. Campo repetido: vale o 1º, o MESMO que
      // `parseFormSubmission` usa como e-mail (a chave gravada é sempre a do
      // e-mail verificado). Segredo trocado depois de o formulário abrir: este
      // POST volta 403 e as respostas preenchidas se perdem (ver o módulo).
      const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
      const check = await checkFormEmailSig(one(fields.email), one(fields.sig), secret);
      if (!check.ok) return rejectLink("/enviar", check.reason);
      const parsed = parseFormSubmission(fields);
      if (!parsed.ok) {
        // #12522: volta ao formulário com o que a pessoa marcou (a mesma
        // limpeza do rascunho) e a mensagem na pergunta. O e-mail e a
        // assinatura já foram conferidos; a hora assinada da página segue a
        // mesma, para o tempo de preenchimento contar desde o início.
        const prefill = parseFormDraft(fields)?.answers ?? null;
        const rendered = one(fields[FORM_RENDERED_FIELD]) || null;
        return html(
          renderFormHtml(one(fields.email), one(fields.sig), undefined, rendered, { prefill, error: { message: parsed.error, questionId: parsed.questionId } }),
          400,
        );
      }
      // #12490: versão das perguntas em cada resposta, e histórico sem
      // sobrescrever (`hist:`); `resp:` segue sendo a mais recente.
      const nowMs = Date.now();
      const record: FormResponse = { ...parsed.submission, submitted_at: new Date(nowMs).toISOString(), form_version: FORM_VERSION };
      // Tempo de preenchimento: só com a hora assinada para ESTE e-mail (senão fica sem o campo).
      const duration = await formDurationFromToken(record.email, one(fields[FORM_RENDERED_FIELD]), secret, nowMs / 1000);
      if (duration != null) record.duration_s = duration;
      try {
        const previous = await env.ONBOARDING_FORM.get(formResponseKey(record.email));
        // `resp:` por último: se uma gravação do histórico falhar, a pessoa vê o
        // erro e tenta de novo, sem a resposta nova ter virado "a mais recente".
        for (const w of planFormResponseWrites(record, previous)) await env.ONBOARDING_FORM.put(w.key, w.value);
      } catch (e) {
        // Falha de gravação nunca vira "Obrigado": a pessoa precisa saber que não registrou.
        console.error(`[onboarding-form] falha ao gravar resposta no KV: ${(e as Error).message}`);
        return html(renderErrorHtml("tivemos um problema para guardar suas respostas, tente de novo em alguns minutos"), 503);
      }
      // #12504: o envio apaga o rascunho. Falha aqui não desfaz o envio (já
      // gravado): o rascunho que sobrar não conta como resposta, sai dos
      // consumidores porque a resposta enviada vence (`unsentFormDrafts`) e
      // expira sozinho; no máximo preenche a página se a pessoa abrir o link de novo.
      try {
        await env.ONBOARDING_FORM.delete(formDraftKey(record.email));
      } catch (e) {
        console.error(JSON.stringify({ event: "rascunho_apagar_falhou", error: (e as Error).message }));
      }
      return html(renderThanksHtml(resolveFormResults(env.RESULTS_URL, env.RESULTS_PUBLISHED_AT)));
    }

    if (request.method === "GET" && url.pathname === "/api/respostas") {
      if (!isAuthorizedResponsesRequest(request.headers.get("authorization"), env.RESPONSES_TOKEN)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      // #12509: UMA página por invocação (o Workers limita as operações de KV
      // por invocação); quem lê segue `next_cursor` (`fetchAllFormResponses`).
      const cursor = url.searchParams.get("cursor") || undefined;
      // #12504: `?rascunhos=1` lista os rascunhos (`{drafts, next_cursor}`).
      if (url.searchParams.get(FORM_DRAFTS_QUERY_PARAM) === "1") {
        try {
          const page = await readKvJsonPage<FormDraft>(env.ONBOARDING_FORM, FORM_DRAFT_PREFIX, cursor);
          if (page.unreadable > 0) console.error(JSON.stringify({ event: "rascunho_ilegivel", count: page.unreadable }));
          return new Response(JSON.stringify({ drafts: page.items, next_cursor: page.next_cursor }), { headers: { "content-type": "application/json" } });
        } catch (e) {
          const reason = (e as Error).message;
          console.error(JSON.stringify({ event: "rascunhos_kv_falhou", reason }));
          return new Response(JSON.stringify({ error: "kv_failure", reason }), { status: 503, headers: { "content-type": "application/json" } });
        }
      }
      // #12490: `?historico=1` lista todas as respostas guardadas (uma por envio).
      const prefix = url.searchParams.get("historico") === "1" ? FORM_HISTORY_PREFIX : "resp:";
      let page: FormResponsesPage;
      try {
        page = await readFormResponsesPage(env.ONBOARDING_FORM, prefix, cursor);
      } catch (e) {
        // Motivo explícito no 5xx: o executor repassa na mensagem da trava.
        const reason = (e as Error).message;
        console.error(JSON.stringify({ event: "respostas_kv_falhou", reason }));
        return new Response(JSON.stringify({ error: "kv_failure", reason }), { status: 503, headers: { "content-type": "application/json" } });
      }
      if (page.unreadable > 0) console.error(JSON.stringify({ event: "resposta_ilegivel", prefix, count: page.unreadable }));
      const payload: FormResponsesPayload = { responses: page.responses, next_cursor: page.next_cursor };
      return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    }

    return new Response("not found", { status: 404 });
  },
};
