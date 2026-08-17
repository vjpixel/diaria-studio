/**
 * scripts/lib/preflight-utm.ts (#5545)
 *
 * Núcleo puro + helpers de I/O do gate de pré-voo do teste de 3 canais
 * (#5522/#5524/#5543). A #5522 registrou que o destino dos 3 braços é a
 * HOME (`https://diar.ia.br/`), não `/subscribe`, e que entre a chegada e o
 * cadastro existe uma navegação interna pelo widget "Assinar grátis" — sem
 * `href` no HTML, então não dá pra provar por inspeção estática se a query
 * string sobrevive (ver `home-widget-probe.ts` pra essa sondagem, que é só
 * diagnóstico, nunca gate).
 *
 * O critério de aprovação (corpo da #5522) é binário, por braço:
 *   - `utm_source` gravado no assinante é EXATO ao do braço (não `direct`,
 *     não `diar.ia.br`, não vazio);
 *   - `utm_campaign` também sobreviveu (é o que separa o teste do tráfego
 *     normal do canal).
 *
 * `utm_medium` é reportado (informativo) mas **não** faz parte do gate — o
 * corpo da #5522 só menciona `utm_source`/`utm_campaign` no checklist.
 *
 * Os 3 braços e seus `utm_source`/`utm_medium` esperados espelham
 * `data/aquisicao/campanhas-260816/00-PROTOCOLO.md` §0.3/§8.4 (arquivo
 * gitignored — `data/` é junction do OneDrive, não pode ser importado por
 * código versionado). `utm_campaign` NÃO é fixo aqui — é passado pelo
 * chamador (`--campaign`), porque o valor real usado no teste ao vivo
 * (`preflight-2608`) é distinto do `utm_campaign` da campanha de produção
 * (`ads-{plataforma}-2608`), de propósito, pra não contaminar o snapshot
 * real com tráfego de teste.
 *
 * Achado ao vivo já registrado na #5522 (não repetir o teste — só ler os
 * comentários da issue): testar os 3 braços em SEQUÊNCIA no MESMO navegador
 * faz os braços 2 e 3 herdarem o `utm_source` do 1º (atribuição first-touch
 * via cookie de 1ª parte da Beehiiv). O roteiro em
 * `docs/roteiro-preflight-utm-3-canais.md` cobre esse risco explicitamente
 * — este módulo só avalia o resultado, não controla como o teste foi feito.
 */

import { beehiivApiBase } from "./beehiiv-config.ts";

/** Um dos 3 braços do teste comparativo de canais pagos. */
export interface PreflightArm {
  /** Slug estável — usado como chave em `--emails arm=email,...`. */
  id: string;
  /** `utm_source` exato esperado nesse braço. */
  utmSource: string;
  /** `utm_medium` esperado — informativo, não gate (ver docstring do módulo). */
  utmMedium: string;
}

/**
 * Os 3 braços do teste de 3 canais (#5524), na ordem em que aparecem em
 * `00-PROTOCOLO.md` §0.3/§8.4: Google Ads, Microsoft Advertising, Meta.
 * `utm_source=facebook`/`utm_source=instagram` são proibidos aqui de
 * propósito (já usados pelo tráfego orgânico do projeto, ver §8.4) — os 3
 * braços pagos usam sufixo `-ads` sempre.
 */
export const PREFLIGHT_UTM_ARMS: readonly PreflightArm[] = [
  { id: "google-ads", utmSource: "google-ads", utmMedium: "cpc" },
  { id: "microsoft-ads", utmSource: "microsoft-ads", utmMedium: "cpc" },
  { id: "meta-ads", utmSource: "meta-ads", utmMedium: "paid_social" },
];

/** IDs válidos, derivados de `PREFLIGHT_UTM_ARMS` — usado pra validar `--emails`. */
export const PREFLIGHT_ARM_IDS: readonly string[] = PREFLIGHT_UTM_ARMS.map((a) => a.id);

// ---------------------------------------------------------------------------
// Parsing de `--emails arm=email,arm=email,...`
// ---------------------------------------------------------------------------

/**
 * Parseia a flag `--emails` no formato `arm=email,arm=email,...` — mesmo
 * espírito de par chave=valor usado por outras flags de lista do repo (ex:
 * `--metadata a=1,b=2` em scripts diversos). Lança em qualquer par malformado
 * (sem `=`, arm vazio, email vazio) — falha explícita é melhor que ignorar
 * um braço em silêncio (mesma disciplina de `getStringArg`/`getIntArg`,
 * `scripts/lib/cli-args.ts`).
 *
 * @pure
 */
export function parseArmEmailPairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pairRaw of raw.split(",")) {
    const pair = pairRaw.trim();
    if (!pair) continue;
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) {
      throw new Error(
        `--emails: par inválido "${pair}" (esperado "braço=email", ex: "google-ads=teste@x.com"). ` +
          `Braços válidos: ${PREFLIGHT_ARM_IDS.join(", ")}.`,
      );
    }
    const arm = pair.slice(0, eqIdx).trim();
    const email = pair.slice(eqIdx + 1).trim();
    if (!arm || !email) {
      throw new Error(`--emails: par inválido "${pair}" — braço e email não podem ser vazios.`);
    }
    if (!PREFLIGHT_ARM_IDS.includes(arm)) {
      throw new Error(`--emails: braço desconhecido "${arm}". Braços válidos: ${PREFLIGHT_ARM_IDS.join(", ")}.`);
    }
    out[arm] = email;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Leitura da subscription na Beehiiv (I/O)
// ---------------------------------------------------------------------------

/** Subconjunto de `GET .../subscriptions/by_email/{email}` que este módulo
 *  consome — mesmo endpoint já usado por `evaluate-brevo-diaria.ts`
 *  (`fetchBeehiivSubscriptionStatus`/`promoteBeehiivSubscription`) e
 *  `beehiiv-origem-original.ts`, aqui só os 3 campos de atribuição + status. */
export interface BeehiivSubscriptionUtmData {
  id: string;
  status: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
}

/**
 * `GET .../subscriptions/by_email/{email}` — retorna `null` em 404 (contato
 * não encontrado, nunca lança pra esse caso — é um resultado esperado do
 * fluxo, não uma falha). Qualquer outro status não-2xx lança.
 */
export async function fetchBeehiivSubscriptionUtm(
  publicationId: string,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BeehiivSubscriptionUtmData | null> {
  const res = await fetchImpl(
    `${beehiivApiBase()}/publications/${publicationId}/subscriptions/by_email/${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Beehiiv API ${res.status} em subscriptions/by_email/${email}`);
  }
  const body = (await res.json().catch((e) => {
    throw new Error(`Beehiiv API GET /subscriptions/by_email/${email} corpo não-parseável: ${e}`);
  })) as {
    data?: {
      id?: unknown;
      status?: unknown;
      utm_source?: unknown;
      utm_medium?: unknown;
      utm_campaign?: unknown;
    };
  };
  const data = body.data;
  if (!data) return null;
  return {
    id: typeof data.id === "string" ? data.id : "",
    status: typeof data.status === "string" ? data.status : "",
    utm_source: typeof data.utm_source === "string" && data.utm_source ? data.utm_source : null,
    utm_medium: typeof data.utm_medium === "string" && data.utm_medium ? data.utm_medium : null,
    utm_campaign: typeof data.utm_campaign === "string" && data.utm_campaign ? data.utm_campaign : null,
  };
}

/**
 * `DELETE .../subscriptions/{id}` — remove um cadastro de teste. 404 é
 * tratado como sucesso (idempotente: já não existe, nada a fazer) — só
 * qualquer outro não-2xx lança.
 */
export async function deleteBeehiivSubscription(
  publicationId: string,
  apiKey: string,
  subscriptionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(
    `${beehiivApiBase()}/publications/${publicationId}/subscriptions/${subscriptionId}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
  );
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`Beehiiv API DELETE /subscriptions/${subscriptionId} falhou (HTTP ${res.status}): ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Avaliação pura — veredito por braço
// ---------------------------------------------------------------------------

export interface ArmVerdict {
  arm: string;
  email: string;
  expectedSource: string;
  expectedMedium: string;
  expectedCampaign: string;
  obtainedSource: string | null;
  obtainedMedium: string | null;
  obtainedCampaign: string | null;
  /** `false` quando a subscription não foi encontrada (404) — distinto de
   *  "encontrada mas com origem errada". */
  found: boolean;
  /** Critério do corpo da #5522: `utm_source` exato + `utm_campaign`
   *  sobrevivente. Só `true` quando `found` também é `true`. */
  passed: boolean;
}

/**
 * Compara o esperado (braço + campanha) contra o obtido (subscription lida
 * da Beehiiv, ou `null` se não encontrada). Pura — não faz I/O.
 */
export function evaluateArm(
  arm: PreflightArm,
  email: string,
  expectedCampaign: string,
  subscription: BeehiivSubscriptionUtmData | null,
): ArmVerdict {
  const found = subscription !== null;
  const obtainedSource = subscription?.utm_source ?? null;
  const obtainedMedium = subscription?.utm_medium ?? null;
  const obtainedCampaign = subscription?.utm_campaign ?? null;
  const passed = found && obtainedSource === arm.utmSource && obtainedCampaign === expectedCampaign;
  return {
    arm: arm.id,
    email,
    expectedSource: arm.utmSource,
    expectedMedium: arm.utmMedium,
    expectedCampaign,
    obtainedSource,
    obtainedMedium,
    obtainedCampaign,
    found,
    passed,
  };
}

/** `true` só quando `verdicts` não está vazio e TODOS os braços passaram. */
export function allPassed(verdicts: readonly ArmVerdict[]): boolean {
  return verdicts.length > 0 && verdicts.every((v) => v.passed);
}

/** Tabela human-readable — `esperado → obtido` por campo + veredito por braço. */
export function formatVerdictTable(verdicts: readonly ArmVerdict[]): string {
  if (verdicts.length === 0) return "(nenhum braço avaliado)";
  const lines: string[] = [];
  for (const v of verdicts) {
    const status = !v.found ? "NÃO ENCONTRADO" : v.passed ? "PASSOU" : "FALHOU";
    lines.push(`[${v.arm}] ${v.email}`);
    lines.push(`  utm_source:   esperado=${v.expectedSource} → obtido=${v.obtainedSource ?? "(ausente)"}`);
    lines.push(`  utm_campaign: esperado=${v.expectedCampaign} → obtido=${v.obtainedCampaign ?? "(ausente)"}`);
    lines.push(
      `  utm_medium:   esperado=${v.expectedMedium} → obtido=${v.obtainedMedium ?? "(ausente)"} (informativo, não gate)`,
    );
    lines.push(`  veredito: ${status}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
