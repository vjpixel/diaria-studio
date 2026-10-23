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
 */

import {
  formResponseKey,
  isAuthorizedResponsesRequest,
  parseFormSubmission,
  prefillEmailFromQuery,
  type FormResponse,
} from "../../../scripts/lib/onboarding-form-contract.ts";
import { checkFormEmailSig, checkLinkSecret, type FormSigRejection } from "../../../scripts/lib/onboarding-form-link-sig.ts";
import { collectFormFields, renderErrorHtml, renderFormHtml, renderInvalidLinkHtml, renderThanksHtml } from "./render.ts";
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
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function notConfigured(what: string): Response {
  console.error(JSON.stringify({ event: "not_configured", what }));
  return new Response(JSON.stringify({ error: "not_configured" }), { status: 503 });
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
    const isFormRoute = (request.method === "GET" && url.pathname === "/") || (request.method === "POST" && url.pathname === "/enviar");
    const secretCheck = checkLinkSecret(env.ONBOARDING_FORM_LINK_SECRET);
    if (isFormRoute && !secretCheck.ok) return notConfigured("secret ONBOARDING_FORM_LINK_SECRET");
    const secret = secretCheck.ok ? secretCheck.secret : "";

    if (request.method === "GET" && url.pathname === "/") {
      const email = prefillEmailFromQuery(url.searchParams.get("email"));
      const sig = url.searchParams.get("sig") ?? "";
      const check = await checkFormEmailSig(email, sig, secret);
      if (!check.ok) return rejectLink("/", check.reason);
      return html(renderFormHtml(email, sig));
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
      if (!parsed.ok) return html(renderErrorHtml(parsed.error), 400);
      const record: FormResponse = { ...parsed.submission, submitted_at: new Date().toISOString() };
      try {
        await env.ONBOARDING_FORM.put(formResponseKey(record.email), JSON.stringify(record));
      } catch (e) {
        // Falha de gravação nunca vira "Obrigado": a pessoa precisa saber que não registrou.
        console.error(`[onboarding-form] falha ao gravar resposta no KV: ${(e as Error).message}`);
        return html(renderErrorHtml("tivemos um problema para guardar suas respostas, tente de novo em alguns minutos"), 503);
      }
      return html(renderThanksHtml());
    }

    if (request.method === "GET" && url.pathname === "/api/respostas") {
      if (!isAuthorizedResponsesRequest(request.headers.get("authorization"), env.RESPONSES_TOKEN)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      const responses: FormResponse[] = [];
      let cursor: string | undefined;
      do {
        const list = await env.ONBOARDING_FORM.list({ prefix: "resp:", cursor });
        for (const k of list.keys) {
          const raw = await env.ONBOARDING_FORM.get(k.name);
          if (raw) responses.push(JSON.parse(raw) as FormResponse);
        }
        cursor = list.list_complete ? undefined : list.cursor;
      } while (cursor);
      return new Response(JSON.stringify({ responses }), { headers: { "content-type": "application/json" } });
    }

    return new Response("not found", { status: 404 });
  },
};
