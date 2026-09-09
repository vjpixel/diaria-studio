/**
 * workers/meta-leads/src/kit.ts (#7769)
 *
 * Cria (ou faz upsert de) o subscriber no Kit a partir de um lead da Meta —
 * reusa as convenções já estabelecidas em `workers/poll/src/subscribe.ts`
 * (`subscribeToKit`): `POST /v4/subscribers`, header `X-Kit-Api-Key`
 * (não Bearer), `state`, custom fields de atribuição via gate-por-ausência
 * (campo só é mandado se a var com o nome dele estiver configurada), e o
 * marcador `origem_cadastro` de `applyKitSignupOriginField`.
 *
 * `state: "active"` — decisão de design documentada (não código-morto nem
 * esquecimento): diferente do funil `/jogar` (double opt-in gerido por
 * `optin-flag-6340.ts`, específico do Worker `poll`), o consentimento aqui
 * já foi capturado PELO PRÓPRIO formulário instantâneo da Meta — o
 * visitante preencheu o form dentro do Facebook/Instagram e (dependendo da
 * config do form no Ads Manager) já viu o texto de consentimento da Meta.
 * Mesmo racional já aplicado em `subscribeToBeehiiv`/`subscribeToKit` do
 * `poll` para o cadastro inline do jogo — "a 1ª camada de consentimento é
 * nossa/da plataforma de origem, uma 2ª camada de confirmação por e-mail é
 * redundante". Se o editor decidir depois que o form da Meta não é
 * suficiente (ex: form sem checkbox de opt-in explícito), o ajuste é trocar
 * este literal por `"inactive"` + vincular a um form DOI do Kit — mesmo
 * mecanismo que `subscribe.ts` já tem pronto (`doi-form-guard-7723.ts`), não
 * portado aqui de propósito até essa decisão ser tomada (fora do escopo
 * desta issue — ver corpo da #7769, "Pendências operacionais").
 */
import { applyKitSignupOriginField } from "../../../scripts/lib/shared/kit-signup-origin.ts";

export interface Env {
  KIT_API_KEY?: string;
  KIT_API_URL?: string;
  KIT_NAME_FIELD?: string;
  KIT_UTM_SOURCE_FIELD?: string;
  KIT_UTM_MEDIUM_FIELD?: string;
  KIT_UTM_CAMPAIGN_FIELD?: string;
  KIT_REFERRING_SITE_FIELD?: string;
  KIT_ORIGEM_CADASTRO_FIELD?: string;
}

export interface KitUtm {
  source: string;
  medium: string;
  campaign: string;
  referringSite: string;
}

export type KitCreateResult =
  | { ok: true; status: number }
  | { ok: false; status: number; reason: string };

/** Teto de tamanho do nome — payload abusivo, mesmo racional de
 * `SUBSCRIBE_NAME_MAX` em `workers/poll/src/subscribe.ts`. */
export const KIT_NAME_MAX = 100;

const KIT_FETCH_TIMEOUT_MS = 8000;

export async function createKitSubscriberFromLead(
  env: Env,
  contact: { email: string; name: string },
  utm: KitUtm,
  fetchImpl: typeof fetch,
): Promise<KitCreateResult> {
  const apiKey = env.KIT_API_KEY;
  if (!apiKey) return { ok: false, status: 500, reason: "kit_not_configured" };

  const base = env.KIT_API_URL ?? "https://api.kit.com/v4";
  const fields: Record<string, string> = {};
  const name = contact.name.trim().slice(0, KIT_NAME_MAX);
  if (name && env.KIT_NAME_FIELD) fields[env.KIT_NAME_FIELD] = name;
  if (env.KIT_UTM_SOURCE_FIELD) fields[env.KIT_UTM_SOURCE_FIELD] = utm.source;
  if (env.KIT_UTM_MEDIUM_FIELD) fields[env.KIT_UTM_MEDIUM_FIELD] = utm.medium;
  if (env.KIT_UTM_CAMPAIGN_FIELD) fields[env.KIT_UTM_CAMPAIGN_FIELD] = utm.campaign;
  if (env.KIT_REFERRING_SITE_FIELD) fields[env.KIT_REFERRING_SITE_FIELD] = utm.referringSite;
  applyKitSignupOriginField(fields, env);

  const body: Record<string, unknown> = {
    email_address: contact.email,
    state: "active",
  };
  if (Object.keys(fields).length > 0) body.fields = fields;

  let res: Response;
  try {
    res = await fetchImpl(`${base}/subscribers`, {
      method: "POST",
      headers: {
        "X-Kit-Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(KIT_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, status: 502, reason: `fetch_exception: ${String(err)}` };
  }
  // 200 (upsert de e-mail já existente) e 201 (criação) são ambos sucesso —
  // mesma idempotência documentada em `subscribeToKit` (workers/poll).
  if (res.ok) return { ok: true, status: res.status };
  const bodyText = await res.text().catch(() => "<unreadable>");
  return { ok: false, status: res.status, reason: `kit_${res.status}: ${bodyText.slice(0, 300)}` };
}
