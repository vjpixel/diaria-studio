#!/usr/bin/env node
/**
 * verify-utm-attribution.ts (#5545, migrado pro Kit no #7359)
 *
 * Coração do escopo original da #5522, de forma binária, sem leitura humana
 * de JSON:
 *
 *   - os 3 cadastros de teste aparecem com o `utm_source` EXATO do braço
 *     (não "direct", não "diar.ia.br", não vazio);
 *   - o `utm_campaign` também sobrevive (é o que separa o teste do tráfego
 *     normal do canal).
 *
 * ## Migração Beehiiv → Kit (#7359)
 *
 * O cadastro real que este script verifica nasce hoje no Kit, não na
 * Beehiiv: a home (`workers/site/public/index.html`) faz `POST` direto pra
 * `https://eia.diar.ia.br/jogar/subscribe` (worker `poll`,
 * `SUBSCRIBE_BACKEND = "kit"`, `workers/poll/wrangler.toml`) — o widget JS
 * da Beehiiv com double opt-in que a versão anterior deste roteiro descrevia
 * está extinto. A versão anterior deste script, rodada como está, dava
 * FALHOU FALSO nos 3 braços — os 3 e-mails de teste nunca existiram na
 * Beehiiv pra começo de conversa.
 *
 * A atribuição real fica em custom fields do Kit
 * (`utm_source`/`utm_campaign`, `workers/poll/wrangler.toml` →
 * `KIT_UTM_SOURCE_FIELD`/`KIT_UTM_CAMPAIGN_FIELD`, gravados por
 * `subscribeToKit`, `workers/poll/src/subscribe.ts`) — NUNCA no bloco
 * `attribution` nativo do Kit, que vem sempre presente mas com UTM nulo pra
 * cadastro via `POST /v4/subscribers` (medido no #7174; mesmo contrato já
 * documentado em `scripts/lib/kit-subscribers-ingest.ts`). Lookup por e-mail
 * via `getKitSubscriberByEmail` (`scripts/lib/kit-subscribers.ts`, novo no
 * #7359) — `GET /v4/subscribers?email_address=...&status=all`.
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
 * subscriber. Nenhuma sessão overnight/develop executa este script contra o
 * Kit ao vivo por conta própria; é o editor quem roda, como passo 7 do
 * roteiro em `docs/preflight-utm-cookie-roteiro.md`.
 */
import "dotenv/config";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { getKitSubscriberByEmail, type KitSubscriberSummary } from "./lib/kit-subscribers.ts";
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
  subscription_found: boolean;
  passed: boolean;
  reason?: string;
}

/**
 * Pura — aplica o critério binário da #5522 sobre um `KitSubscriberSummary`
 * já resolvido (ou `null`, quando não encontrado). Lê `fields.utm_source`/
 * `fields.utm_campaign` (fonte real, ver docstring do módulo) — nunca o
 * bloco `attribution`.
 */
export function evaluateArm(
  plan: PreflightArmPlan,
  campaign: string,
  subscriber: KitSubscriberSummary | null,
): ArmVerdict {
  const fields = subscriber?.fields ?? {};
  const foundUtmSource = fields.utm_source ?? null;
  const foundUtmCampaign = fields.utm_campaign ?? null;
  const subscriptionFound = subscriber != null;

  const base: Omit<ArmVerdict, "passed" | "reason"> = {
    arm: plan.arm.key,
    email: plan.email,
    expected_utm_source: plan.arm.utm_source,
    expected_utm_campaign: campaign,
    found_utm_source: foundUtmSource,
    found_utm_campaign: foundUtmCampaign,
    subscription_found: subscriptionFound,
  };

  if (!subscriptionFound) {
    return {
      ...base,
      passed: false,
      reason: "sem registro no Kit (ainda não cadastrado, ou o POST /jogar/subscribe falhou)",
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

  const cfgResult = resolveKitConfig();
  if (!cfgResult.ok) {
    process.stderr.write(`[verify-utm-attribution] ${cfgResult.reason}\n`);
    process.exit(2);
  }
  const plans = buildPreflightPlan(campaign, baseEmail);

  Promise.all(
    plans.map(async (plan) => {
      const subscriber = await getKitSubscriberByEmail(plan.email, cfgResult.config);
      return evaluateArm(plan, campaign, subscriber);
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
