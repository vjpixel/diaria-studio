/**
 * workers/onboarding-form/src/index.ts (#10605)
 *
 * Formulário de perfil/interesses do onboarding. Contrato completo (rotas,
 * formato, como o executor grava "preencheu" no store) em
 * `scripts/lib/onboarding-form-contract.ts`; HTML em `./render.ts`. Sem o KV
 * `ONBOARDING_FORM` declarado (ver wrangler.toml) ou sem o secret
 * `ONBOARDING_FORM_LINK_SECRET` toda rota responde 503 `not_configured`.
 *
 * #10657: link assinado por pessoa (`?email=...&sig=...`,
 * `scripts/lib/onboarding-form-link-sig.ts`). GET sem assinatura válida
 * mostra a página de link inválido (sem formulário); POST sem assinatura
 * válida para o e-mail enviado responde 403 e não grava nada no KV.
 */

import {
  formResponseKey,
  isAuthorizedResponsesRequest,
  parseFormSubmission,
  prefillEmailFromQuery,
  type FormResponse,
} from "../../../scripts/lib/onboarding-form-contract.ts";
import { verifyFormEmailSig } from "../../../scripts/lib/onboarding-form-link-sig.ts";
import { collectFormFields, renderErrorHtml, renderFormHtml, renderInvalidLinkHtml, renderThanksHtml } from "./render.ts";

export interface Env {
  ONBOARDING_FORM?: KVNamespace;
  RESPONSES_TOKEN?: string;
  /** #10657: segredo do HMAC do link (mesmo valor do executor). */
  ONBOARDING_FORM_LINK_SECRET?: string;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const secret = env.ONBOARDING_FORM_LINK_SECRET;
    if (!env.ONBOARDING_FORM || !secret) return new Response(JSON.stringify({ error: "not_configured" }), { status: 503 });

    if (request.method === "GET" && url.pathname === "/") {
      const email = prefillEmailFromQuery(url.searchParams.get("email"));
      const sig = url.searchParams.get("sig") ?? "";
      if (!(await verifyFormEmailSig(email, sig, secret))) return html(renderInvalidLinkHtml(), 403);
      return html(renderFormHtml(email, sig));
    }

    if (request.method === "POST" && url.pathname === "/enviar") {
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
      // respostas dela. Verificado antes de qualquer outra validação.
      const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
      if (!(await verifyFormEmailSig(one(fields.email), one(fields.sig), secret))) {
        return html(renderInvalidLinkHtml(), 403);
      }
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
