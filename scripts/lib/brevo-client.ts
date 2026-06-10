/**
 * brevo-client.ts (#1844 — extraído de publish-monthly.ts)
 *
 * Camada de TRANSPORTE do publisher mensal: wrappers HTTP finos sobre a
 * Brevo API v3 (POST/GET campaign/GET list/PUT). Só `fetch` — sem estado,
 * sem deps de módulo. publish-monthly.ts importa pra criar/atualizar/testar/
 * enviar a campanha. (Os testes mockam `fetch` global.)
 */

export async function brevoPost(
  apiKey: string,
  path: string,
  body: unknown
): Promise<unknown> {
  const res = await fetch(`https://api.brevo.com/v3${path}`, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo API POST ${path} falhou (${res.status}): ${text}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const text = await res.text();
    return text.length > 0 ? JSON.parse(text) : {};
  }
  return {};
}

/**
 * GET de uma campanha Brevo. Usado pra validar status antes de PUT em
 * `--update-existing` (#1015) — Brevo rejeita update em campanha já enviada,
 * mas o erro é pouco amigável. Vale checar antes pra dar mensagem clara.
 */
export async function brevoGetCampaign(
  apiKey: string,
  campaignId: number,
): Promise<{ id: number; name: string; status: string }> {
  const res = await fetch(`https://api.brevo.com/v3/emailCampaigns/${campaignId}`, {
    method: "GET",
    headers: { "api-key": apiKey, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo API GET /emailCampaigns/${campaignId} falhou (${res.status}): ${text}`);
  }
  const data = await res.json() as { id: number; name: string; status: string };
  return data;
}

export async function brevoGetList(
  apiKey: string,
  listId: number,
): Promise<{ id: number; name: string; totalSubscribers: number }> {
  const res = await fetch(`https://api.brevo.com/v3/contacts/lists/${listId}`, {
    method: "GET",
    headers: { "api-key": apiKey, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo API GET /contacts/lists/${listId} falhou (${res.status}): ${text}`);
  }
  const data = await res.json() as { id: number; name: string; totalSubscribers: number };
  return data;
}

/**
 * PUT genérico pra Brevo. Usado em #1015 pra:
 *   - --schedule-at:    PUT /emailCampaigns/{id} body { scheduledAt }
 *   - --update-existing: PUT /emailCampaigns/{id} body { subject, htmlContent, ... }
 *
 * Nota (#1025): Brevo API usa PUT (não PATCH) pra updates de emailCampaigns;
 * PATCH retorna 404. Verificado empiricamente em 2026-05-08.
 */
export async function brevoPut(
  apiKey: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(`https://api.brevo.com/v3${path}`, {
    method: "PUT",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo API PUT ${path} falhou (${res.status}): ${text}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const text = await res.text();
    return text.length > 0 ? JSON.parse(text) : {};
  }
  return {};
}

/**
 * #2018: lista TODAS as listas Brevo (paginado, limit=50) — só id + nome.
 * Extraído de clarice-import-waves.ts / clarice-import-sends.ts /
 * clarice-split-cells.ts onde estava triplicado com corpo idêntico.
 * Usado pelo check de duplicata antes de criar listas novas.
 */
export async function brevoListAllLists(
  apiKey: string,
): Promise<{ id: number; name: string }[]> {
  const out: { id: number; name: string }[] = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(`https://api.brevo.com/v3/contacts/lists?limit=50&offset=${offset}`, {
      headers: { "api-key": apiKey, Accept: "application/json" },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Brevo API GET /contacts/lists falhou (${res.status}): ${text}`);
    }
    const body = (await res.json()) as { lists?: { id: number; name: string }[] };
    const lists = body.lists ?? [];
    out.push(...lists.map((l) => ({ id: l.id, name: l.name })));
    if (lists.length < 50) break;
    offset += 50;
  }
  return out;
}
