/**
 * scripts/lib/shared/brevo-list-unlink.ts (#4535)
 *
 * `PUT /v3/contacts/{email}` com `{ unlinkListIds: [listId] }` — MESMA
 * chamada que `unlinkFromBrevoList` (`scripts/evaluate-brevo-diaria.ts`) já
 * usa pra desvincular um contato de uma lista Brevo (promovido/suprimido não
 * precisa mais dela). Extraída aqui, fetch-only (zero I/O de Node), pra poder
 * ser importada tanto pelo script quanto por um Worker Cloudflare — mesmo
 * padrão de `poll-token.ts`. Não substitui `unlinkFromBrevoList` (já tem
 * cobertura de teste própria em `test/evaluate-brevo-diaria-4266.test.ts`);
 * nasce pra dar ao Worker `reativar` (#4535) a mesma chamada sem duplicar o
 * literal do endpoint/corpo em 2 lugares que podem divergir sem querer.
 *
 * Lança em qualquer falha HTTP (fail loud) — o caller decide o fail-soft
 * (ver `unlinkReativarFromBrevoList`, `workers/reativar/src/index.ts`). O
 * erro lançado (`BrevoUnlinkError`) NUNCA embute o e-mail nem o corpo da
 * resposta na mensagem — só o status HTTP — porque o caller no Worker loga a
 * exceção (`String(e)`) e um dos requisitos do #4535 é nunca logar o e-mail;
 * embutir o e-mail na própria mensagem de erro (como `unlinkFromBrevoList`
 * faz via `brevoPut`, aceitável lá porque o log é local/operador, não um log
 * hospedado de Worker) vazaria de volta pro log estruturado.
 */
export class BrevoUnlinkError extends Error {
  constructor(public readonly status: number) {
    super(`Brevo API PUT /contacts unlinkListIds falhou (HTTP ${status})`);
    this.name = "BrevoUnlinkError";
  }
}

export async function unlinkFromBrevoListShared(
  apiKey: string,
  listId: number,
  email: string,
  fetchImpl: typeof fetch = fetch,
  apiBase: string = "https://api.brevo.com/v3",
): Promise<void> {
  const res = await fetchImpl(`${apiBase}/contacts/${encodeURIComponent(email)}`, {
    method: "PUT",
    headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ unlinkListIds: [listId] }),
  });
  if (!res.ok) {
    await res.text().catch(() => ""); // drena o corpo (pode conter o e-mail ecoado) — nunca incluído no erro.
    throw new BrevoUnlinkError(res.status);
  }
}
