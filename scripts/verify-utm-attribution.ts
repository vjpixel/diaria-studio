#!/usr/bin/env node
/**
 * verify-utm-attribution.ts (#5545)
 *
 * Coração do escopo desta issue — o critério de aprovação da #5522, de
 * forma binária, sem leitura humana de JSON:
 *
 *   - os 3 cadastros de teste aparecem com o `utm_source` EXATO do braço
 *     (não "direct", não "diar.ia.br", não vazio);
 *   - o `utm_campaign` também sobrevive (é o que separa o teste do tráfego
 *     normal do canal).
 *
 * Consulta `GET .../subscriptions/by_email/{email}` — a MESMA leitura que
 * `promoteBeehiivSubscription`/`fetchBeehiivSubscriptionStatus`
 * (`scripts/evaluate-brevo-diaria.ts`) e `sync-apoio-nivel-beehiiv.ts` já
 * usam, em vez de abrir um caminho novo contra a API. A extração dos campos
 * de origem reusa `extractSubscriptionOrigin`
 * (`scripts/lib/shared/beehiiv-origem-original.ts`) — mesmo parser que
 * `promoteBeehiivSubscription` usa pra preservar origem no fluxo de
 * reativação, não uma segunda leitura ad-hoc do corpo.
 *
 * `loadOrigemIndex` (`scripts/cac-report.ts`) é reusado pra checar se o
 * e-mail de teste tem entrada em `data/aquisicao/origem-original.json` —
 * a mesma derivação que o relatório de aquisição usaria depois. Isto é
 * defensivo/edge-case (um e-mail de preflight recém-criado normalmente NÃO
 * aparece nesse mapa — ele existe pra reconstruir origem perdida no fluxo
 * de REATIVAÇÃO de contato Pending, não pra cadastro novo), mas divergir
 * dessa derivação produziria um "PASSOU" aqui que o cac-report contradiria
 * depois — a issue #5545 pede explicitamente que as duas nunca divirjam.
 *
 * Uso:
 *   npx tsx scripts/verify-utm-attribution.ts --campaign preflight-2608
 *   npx tsx scripts/verify-utm-attribution.ts --campaign preflight-2608 --json
 *   npx tsx scripts/verify-utm-attribution.ts --campaign preflight-2608 --base-email outro@ex.com
 *
 * Exit codes: 0 = todos os 3 braços PASSARAM; 1 = ao menos 1 FALHOU;
 * 2 = config/argumento inválido.
 *
 * Guard de publicação: só LEITURA (`GET`) — nunca cria/edita/deleta
 * subscription. Nenhuma sessão overnight/develop executa este script contra
 * a Beehiiv ao vivo por conta própria; é o editor quem roda, como passo 7
 * do roteiro em `docs/preflight-utm-cookie-roteiro.md`.
 */
import "dotenv/config";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import {
  extractSubscriptionOrigin,
  type BeehiivSubscriptionGetBody,
} from "./lib/shared/beehiiv-origem-original.ts";
import { loadOrigemIndex, DEFAULT_ORIGEM_MAP_PATH } from "./cac-report.ts";
import { normalizeEmail, type OrigemEntryFields } from "./lib/cac.ts";
import {
  buildPreflightPlan,
  DEFAULT_PREFLIGHT_BASE_EMAIL,
  type PreflightArmPlan,
} from "./lib/preflight-utm-arms.ts";

export interface ArmVerdict {
  arm: string;
  email: string;
  expected_utm_source: string;
  expected_utm_campaign: string;
  found_utm_source: string | null;
  found_utm_campaign: string | null;
  found_via_origem_override: boolean;
  subscription_found: boolean;
  passed: boolean;
  reason?: string;
}

/**
 * Busca a subscription por e-mail — mesmo endpoint/shape que
 * `promoteBeehiivSubscription` (`evaluate-brevo-diaria.ts`) já usa. `null`
 * quando a Beehiiv responde 404 (não é erro — "ainda não cadastrado/
 * confirmado").
 */
export async function fetchSubscriptionBody(
  publicationId: string,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BeehiivSubscriptionGetBody> {
  const res = await fetchImpl(
    `${beehiivApiBase()}/publications/${publicationId}/subscriptions/by_email/${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Beehiiv API ${res.status} em subscriptions/by_email/${email}`);
  }
  return (await res.json()) as BeehiivSubscriptionGetBody;
}

/**
 * Pura — aplica o critério binário da #5522 sobre a origem já extraída do
 * corpo do GET (+ eventual override de `data/aquisicao/origem-original.json`).
 * `origemIndex` vazio (mapa ausente/não aplicado) é o caso normal — o
 * override só entra em jogo se o e-mail de teste tiver histórico de
 * reativação (edge case, ver docstring do módulo).
 */
export function evaluateArm(
  plan: PreflightArmPlan,
  campaign: string,
  body: BeehiivSubscriptionGetBody,
  origemIndex: Map<string, OrigemEntryFields>,
): ArmVerdict {
  const origin = extractSubscriptionOrigin(body);
  const overrideEntry = origemIndex.get(normalizeEmail(plan.email));
  const foundUtmSource = overrideEntry?.utm_source ?? origin?.utm_source ?? null;
  const foundUtmCampaign = origin?.utm_campaign ?? null; // origem-original.json não carrega utm_campaign
  const subscriptionFound = body?.data != null;

  const base: Omit<ArmVerdict, "passed" | "reason"> = {
    arm: plan.arm.key,
    email: plan.email,
    expected_utm_source: plan.arm.utm_source,
    expected_utm_campaign: campaign,
    found_utm_source: foundUtmSource,
    found_utm_campaign: foundUtmCampaign,
    found_via_origem_override: overrideEntry != null,
    subscription_found: subscriptionFound,
  };

  if (!subscriptionFound) {
    return {
      ...base,
      passed: false,
      reason: "sem registro na Beehiiv (ainda não cadastrado, ou double opt-in não confirmado)",
    };
  }
  if (foundUtmSource !== plan.arm.utm_source) {
    return {
      ...base,
      passed: false,
      reason: `utm_source obtido ("${foundUtmSource ?? "(vazio)"}") difere do esperado ("${plan.arm.utm_source}")`,
    };
  }
  if (foundUtmCampaign !== campaign) {
    return {
      ...base,
      passed: false,
      reason: `utm_campaign obtido ("${foundUtmCampaign ?? "(vazio)"}") difere do esperado ("${campaign}")`,
    };
  }
  return { ...base, passed: true };
}

/** Pura — tabela texto `esperado → obtido` + veredito por braço + geral. */
export function formatVerdictTable(verdicts: ArmVerdict[]): string {
  const lines: string[] = [];
  for (const v of verdicts) {
    lines.push(`[${v.arm}] ${v.email}`);
    lines.push(
      `  utm_source:   esperado="${v.expected_utm_source}" → obtido="${v.found_utm_source ?? "(nenhum)"}"`,
    );
    lines.push(
      `  utm_campaign: esperado="${v.expected_utm_campaign}" → obtido="${v.found_utm_campaign ?? "(nenhum)"}"`,
    );
    if (v.found_via_origem_override) {
      lines.push(`  (utm_source veio de data/aquisicao/origem-original.json, não do GET direto)`);
    }
    lines.push(`  veredito: ${v.passed ? "PASSOU" : `FALHOU — ${v.reason}`}`);
    lines.push("");
  }
  const passedCount = verdicts.filter((v) => v.passed).length;
  const allPassed = passedCount === verdicts.length;
  lines.push(`RESULTADO GERAL: ${allPassed ? "PASSOU" : "FALHOU"} (${passedCount}/${verdicts.length} braços)`);
  return lines.join("\n");
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const campaign = getStringArg(argv, "campaign", { example: "preflight-2608" });
  if (!campaign) {
    process.stderr.write(
      `[verify-utm-attribution] --campaign é obrigatório (ex: --campaign preflight-2608)\n`,
    );
    process.exit(2);
  }
  const baseEmail = getStringArg(argv, "base-email") ?? DEFAULT_PREFLIGHT_BASE_EMAIL;
  const jsonMode = argv.includes("--json");

  const cfg = loadBeehiivConfig("[verify-utm-attribution]");
  const { index: origemIndex } = loadOrigemIndex(DEFAULT_ORIGEM_MAP_PATH);
  const plans = buildPreflightPlan(campaign, baseEmail);

  Promise.all(
    plans.map(async (plan) => {
      const body = await fetchSubscriptionBody(cfg.publicationId, cfg.apiKey, plan.email);
      return evaluateArm(plan, campaign, body, origemIndex);
    }),
  )
    .then((verdicts) => {
      const allPassed = verdicts.every((v) => v.passed);
      if (jsonMode) {
        process.stdout.write(JSON.stringify({ campaign, verdicts, all_passed: allPassed }, null, 2) + "\n");
      } else {
        process.stdout.write(formatVerdictTable(verdicts) + "\n");
      }
      process.exit(allPassed ? 0 : 1);
    })
    .catch((err) => {
      process.stderr.write(`[verify-utm-attribution] ERRO: ${String(err)}\n`);
      process.exit(2);
    });
}
