/**
 * workers/onboarding-form/src/index.ts (#10605) — STUB mínimo, não implantado.
 *
 * Formulário de perfil/interesses do onboarding. Contrato completo (rotas,
 * formato, como o executor grava "preencheu" no store) em
 * `scripts/lib/onboarding-form-contract.ts`. Sem o KV `ONBOARDING_FORM`
 * declarado (ver wrangler.toml) toda rota responde 503 `not_configured`.
 */

import {
  FORM_QUESTIONS,
  formResponseKey,
  isAuthorizedResponsesRequest,
  parseFormSubmission,
  prefillEmailFromQuery,
  type FormResponse,
} from "../../../scripts/lib/onboarding-form-contract.ts";

interface Env {
  ONBOARDING_FORM?: KVNamespace;
  RESPONSES_TOKEN?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>diar.ia.br</title></head><body style="font-family:Georgia,serif;max-width:560px;margin:2rem auto;padding:0 16px">${body}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function formPage(email: string): Response {
  const fields = FORM_QUESTIONS.map((q) => {
    const name = escapeHtml(q.id);
    const label = `<label for="${name}">${escapeHtml(q.label)}</label>`;
    if (q.kind === "textarea") return `<p>${label}<br><textarea id="${name}" name="${name}" rows="4"></textarea></p>`;
    if (q.kind === "select") {
      const opts = (q.options ?? []).map((o) => `<option>${escapeHtml(o)}</option>`).join("");
      return `<p>${label}<br><select id="${name}" name="${name}"><option value=""></option>${opts}</select></p>`;
    }
    return `<p>${label}<br><input id="${name}" name="${name}" type="text"></p>`;
  }).join("");
  return page(
    `<h1>Conte pra gente sobre você</h1><form method="post" action="/enviar">` +
      `<p><label for="email">Seu e-mail</label><br><input id="email" name="email" type="email" required value="${escapeHtml(email)}"></p>` +
      `${fields}<p><button type="submit">Enviar</button></p></form>`,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!env.ONBOARDING_FORM) return new Response(JSON.stringify({ error: "not_configured" }), { status: 503 });

    if (request.method === "GET" && url.pathname === "/") {
      return formPage(prefillEmailFromQuery(url.searchParams.get("email")));
    }

    if (request.method === "POST" && url.pathname === "/enviar") {
      const form = await request.formData();
      const fields: Record<string, string> = {};
      for (const [k, v] of form.entries()) if (typeof v === "string") fields[k] = v;
      const parsed = parseFormSubmission(fields);
      if (!parsed.ok) return page(`<p>Não deu para registrar: ${escapeHtml(parsed.error)}.</p>`, 400);
      const record: FormResponse = { ...parsed.submission, submitted_at: new Date().toISOString() };
      await env.ONBOARDING_FORM.put(formResponseKey(record.email), JSON.stringify(record));
      return page("<h1>Obrigado!</h1><p>Recebemos suas respostas.</p>");
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
