/**
 * workers/meta-leads/src/graph.ts (#7769)
 *
 * Fetch de um lead individual na Graph API da Meta a partir do
 * `leadgen_id` recebido no webhook, e extração dos campos (`field_data`) que
 * interessam ao cadastro no Kit (e-mail, nome).
 */

import { redactPii } from "./redact.ts";

export const DEFAULT_GRAPH_API_VERSION = "v21.0";

export interface MetaFieldDatum {
  name: string;
  values: string[];
}

export interface MetaLead {
  id: string;
  created_time?: string;
  ad_id?: string;
  form_id?: string;
  field_data?: MetaFieldDatum[];
}

export type FetchLeadResult =
  | { ok: true; lead: MetaLead }
  | { ok: false; status: number; reason: string };

/**
 * `GET /{leadgen_id}?fields=field_data,created_time,ad_id,form_id` com o
 * page access token — nunca lança; erro de rede/token/lead inexistente vira
 * `{ ok: false }` estruturado (o caller decide o status HTTP de resposta ao
 * webhook a partir disso — nunca fail-soft, ver `index.ts`).
 */
export async function fetchMetaLead(
  leadgenId: string,
  accessToken: string,
  fetchImpl: typeof fetch,
  graphApiVersion: string = DEFAULT_GRAPH_API_VERSION,
): Promise<FetchLeadResult> {
  if (!accessToken) return { ok: false, status: 500, reason: "missing_access_token" };
  // Token vai no header `Authorization`, NUNCA na query string (achado
  // P3/média do review da PR #7777). A Graph API aceita as duas formas; a
  // query string é a convenção mais comum na doc da Meta, mas com
  // `head_sampling_rate = 1` no wrangler.toml qualquer URL que apareça num
  // log — ou dentro de `String(err)` de uma exceção de fetch, que em vários
  // runtimes embute a URL — carregaria o segredo junto.
  const url = `https://graph.facebook.com/${graphApiVersion}/${encodeURIComponent(leadgenId)}?fields=field_data,created_time,ad_id,form_id`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, status: 502, reason: `fetch_exception: ${redactPii(String(err))}` };
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "<unreadable>");
    return { ok: false, status: 502, reason: `graph_api_${res.status}: ${redactPii(bodyText).slice(0, 300)}` };
  }
  const body = (await res.json().catch(() => undefined)) as MetaLead | undefined;
  if (!body || typeof body.id !== "string") {
    return { ok: false, status: 502, reason: "malformed_lead_response" };
  }
  return { ok: true, lead: body };
}

/** Primeiro valor não-vazio de `field_data` cujo `name` (case-insensitive)
 * casa um dos `candidates`, em ordem — `""` se nenhum casar. Meta não
 * padroniza os nomes de campo entre formulários (varia por template/idioma
 * do form criado no Ads Manager), daí a lista de candidatos. */
export function extractFieldValue(fieldData: MetaFieldDatum[] | undefined, candidates: string[]): string {
  if (!fieldData) return "";
  for (const candidate of candidates) {
    const hit = fieldData.find((f) => (f.name || "").toLowerCase() === candidate);
    const value = hit?.values?.[0];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

export interface LeadContact {
  email: string;
  name: string;
}

/** Resolve e-mail + nome de um lead a partir de `field_data` — nome tenta
 * `full_name` primeiro, cai pra `first_name` + `last_name` combinados
 * quando o form não tem campo de nome completo. */
export function resolveLeadContact(lead: MetaLead): LeadContact {
  const email = extractFieldValue(lead.field_data, ["email"]);
  const fullName = extractFieldValue(lead.field_data, ["full_name"]);
  if (fullName) return { email, name: fullName };
  const first = extractFieldValue(lead.field_data, ["first_name"]);
  const last = extractFieldValue(lead.field_data, ["last_name"]);
  const combined = [first, last].filter(Boolean).join(" ").trim();
  return { email, name: combined };
}
