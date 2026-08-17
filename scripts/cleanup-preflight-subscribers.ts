#!/usr/bin/env node
/**
 * cleanup-preflight-subscribers.ts (#5545)
 *
 * Remove os 3 cadastros de teste do preflight de atribuição (#5522) da base
 * Beehiiv — último item do critério de aprovação da #5522 ("limpar os 3
 * assinantes de teste da base ao final") e o mais fácil de esquecer: sem
 * isso, os 3 endereços de preflight ficam contaminando `leitor-v1` e o
 * custo por leitor do próprio teste que eles validam.
 *
 * Nunca `DELETE` — mesma convenção já documentada em
 * `unsubscribeInBeehiiv`/`promoteBeehiivSubscription`
 * (`scripts/evaluate-brevo-diaria.ts`): a doc da Beehiiv desaconselha DELETE
 * (remove o histórico do registro). Usa `PUT .../subscriptions/by_email/{email}`
 * com `{unsubscribe: true}` — o único campo documentado como gravável nesse
 * endpoint (`status` não é, ver o módulo irmão pro histórico da
 * investigação). Isso tira os 3 endereços de `status: active`, que já basta
 * pra excluí-los de `leitor-v1` (`status=active` é condição NECESSÁRIA,
 * `scripts/lib/leitor.ts`) sem apagar o registro/histórico.
 *
 * Idempotente: e-mail já `inactive`, ou sem registro (404) → NOOP, reportado
 * como já-limpo, nunca erro — rodar de novo depois de já ter limpado é
 * seguro. Dry-run por padrão (só imprime o plano, nenhuma escrita); `--push`
 * executa de verdade.
 *
 * Uso:
 *   npx tsx scripts/cleanup-preflight-subscribers.ts --campaign preflight-2608          # dry-run
 *   npx tsx scripts/cleanup-preflight-subscribers.ts --campaign preflight-2608 --push    # executa
 *
 * Guard de publicação: em `--push` faz um `PUT` real na Beehiiv — não é
 * "publicação" no sentido do guard de dispatch (não cria/agenda/envia
 * campanha; é remoção de 3 cadastros de teste que o próprio fluxo de teste
 * criou), mas nenhuma sessão overnight/develop roda `--push` sozinha —
 * roteiro (`docs/preflight-utm-cookie-roteiro.md`) instrui o editor a rodar
 * isso manualmente como último passo da passada.
 */
import "dotenv/config";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import {
  buildPreflightPlan,
  DEFAULT_PREFLIGHT_BASE_EMAIL,
  type PreflightArmPlan,
} from "./lib/preflight-utm-arms.ts";

export type CleanupOutcome = "unsubscribed" | "already_inactive" | "not_found" | "skipped_dry_run";

export interface CleanupResult {
  arm: string;
  email: string;
  status_before: string | null;
  outcome: CleanupOutcome;
}

/**
 * Status atual (`data.status`) do registro — `null` se 404 (nunca
 * cadastrado ou já removido). Mesma leitura de `fetchBeehiivSubscriptionStatus`
 * (`scripts/evaluate-brevo-diaria.ts`), reimplementada aqui (não importada)
 * pra não puxar um módulo com concerns de Brevo pra este script, que é
 * Beehiiv-only.
 */
export async function fetchStatus(
  publicationId: string,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const res = await fetchImpl(
    `${beehiivApiBase()}/publications/${publicationId}/subscriptions/by_email/${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Beehiiv API ${res.status} em subscriptions/by_email/${email}`);
  }
  const body = (await res.json()) as { data?: { status?: string } };
  return body.data?.status ?? null;
}

/** `PUT .../subscriptions/by_email/{email}` com `{unsubscribe: true}` — ver
 *  docstring do módulo pro porquê de nunca ser DELETE. */
export async function unsubscribe(
  publicationId: string,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(
    `${beehiivApiBase()}/publications/${publicationId}/subscriptions/by_email/${encodeURIComponent(email)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ unsubscribe: true }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Beehiiv API PUT subscriptions/by_email/${email} (unsubscribe:true) falhou (HTTP ${res.status}): ${text}`,
    );
  }
}

/** Pura — decide a ação a partir do status atual, sem tocar rede. */
export function decideOutcome(statusBefore: string | null, push: boolean): CleanupOutcome {
  if (statusBefore === null) return "not_found";
  if (statusBefore === "inactive") return "already_inactive";
  return push ? "unsubscribed" : "skipped_dry_run";
}

export async function cleanupOneArm(
  publicationId: string,
  apiKey: string,
  plan: PreflightArmPlan,
  push: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<CleanupResult> {
  const statusBefore = await fetchStatus(publicationId, apiKey, plan.email, fetchImpl);
  const outcome = decideOutcome(statusBefore, push);
  if (outcome === "unsubscribed") {
    await unsubscribe(publicationId, apiKey, plan.email, fetchImpl);
  }
  return { arm: plan.arm.key, email: plan.email, status_before: statusBefore, outcome };
}

/** Pura — tabela texto de resultado por braço. */
export function formatResultsTable(results: CleanupResult[], push: boolean): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`[${r.arm}] ${r.email} — status antes: ${r.status_before ?? "(sem registro)"} → ${r.outcome}`);
  }
  if (!push) {
    lines.push("");
    lines.push(`(dry-run — nenhuma escrita feita; rode com --push pra executar)`);
  }
  return lines.join("\n");
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const campaign = getStringArg(argv, "campaign", { example: "preflight-2608" });
  if (!campaign) {
    process.stderr.write(
      `[cleanup-preflight-subscribers] --campaign é obrigatório (ex: --campaign preflight-2608)\n`,
    );
    process.exit(2);
  }
  const baseEmail = getStringArg(argv, "base-email") ?? DEFAULT_PREFLIGHT_BASE_EMAIL;
  const push = argv.includes("--push");

  const cfg = loadBeehiivConfig("[cleanup-preflight-subscribers]");
  const plans = buildPreflightPlan(campaign, baseEmail);

  Promise.all(plans.map((plan) => cleanupOneArm(cfg.publicationId, cfg.apiKey, plan, push)))
    .then((results) => {
      process.stdout.write(formatResultsTable(results, push) + "\n");
    })
    .catch((err) => {
      process.stderr.write(`[cleanup-preflight-subscribers] ERRO: ${String(err)}\n`);
      process.exit(1);
    });
}
