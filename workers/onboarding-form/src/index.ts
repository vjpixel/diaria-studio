/**
 * workers/onboarding-form/src/index.ts (#10605)
 *
 * Formulário de perfil/interesses do onboarding. Contrato completo (rotas,
 * formato, como o executor grava "preencheu" no store) em
 * `scripts/lib/onboarding-form-contract.ts`; HTML em `./render.ts`. Sem o KV
 * `ONBOARDING_FORM` declarado (ver wrangler.toml) toda rota responde 503
 * `not_configured`.
 */

import {
  formResponseKey,
  isAuthorizedResponsesRequest,
  parseFormSubmission,
  prefillEmailFromQuery,
  type FormResponse,
} from "../../../scripts/lib/onboarding-form-contract.ts";
import { collectFormFields, renderErrorHtml, renderFormHtml, renderThanksHtml } from "./render.ts";

interface Env {
  ONBOARDING_FORM?: KVNamespace;
  RESPONSES_TOKEN?: string;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!env.ONBOARDING_FORM) return new Response(JSON.stringify({ error: "not_configured" }), { status: 503 });

    if (request.method === "GET" && url.pathname === "/") {
      return html(renderFormHtml(prefillEmailFromQuery(url.searchParams.get("email"))));
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
      const parsed = parseFormSubmission(collectFormFields(form.entries()));
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
