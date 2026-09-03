#!/usr/bin/env node
/**
 * cleanup-preflight-subscribers.ts (#5545, migrado pro Kit no #7359)
 *
 * Remove os 3 cadastros de teste do preflight de atribuição (#5522) da base
 * Kit — último item do critério de aprovação da #5522 ("limpar os 3
 * assinantes de teste da base ao final") e o mais fácil de esquecer: sem
 * isso, os 3 endereços de preflight ficam contaminando `leitor-v1` e o
 * custo por leitor do próprio teste que eles validam.
 *
 * ## Migração Beehiiv → Kit (#7359)
 *
 * O cadastro real de teste nasce hoje no Kit (ver docstring de
 * `verify-utm-attribution.ts` pro porquê — a home faz `POST` direto pra
 * `POST /jogar/subscribe`, `SUBSCRIBE_BACKEND = "kit"`). A versão anterior
 * deste script era Beehiiv-only e, rodada hoje, deixaria os 3 e-mails de
 * teste vivos na conta Kit de PRODUÇÃO em silêncio (a Beehiiv sempre
 * responderia 404/not_found pra eles — tratado como "já limpo", nunca como
 * erro, então o operador nunca veria um sinal de que o cadastro real ficou
 * intocado).
 *
 * `POST /v4/subscribers/{id}/unsubscribe` (`unsubscribeKitSubscriber`,
 * `scripts/lib/kit-subscribers.ts`) muda o estado pra `cancelled` — mesma
 * disciplina de nunca usar DELETE (o Kit nem expõe DELETE de subscriber na
 * v4; `cancelled` já basta pra excluir o e-mail de `leitor-v1`, que exige
 * `status=active`).
 *
 * Idempotente: e-mail já `cancelled`/`bounced`/`complained`, ou sem registro
 * → NOOP, reportado como já-limpo, nunca erro — rodar de novo depois de já
 * ter limpado é seguro. Dry-run por padrão (só imprime o plano, nenhuma
 * escrita); `--push` executa de verdade.
 *
 * Uso:
 *   npx tsx scripts/cleanup-preflight-subscribers.ts --campaign preflight-2609          # dry-run
 *   npx tsx scripts/cleanup-preflight-subscribers.ts --campaign preflight-2609 --push    # executa
 *
 * `--email` (herdado do #5736, endurecimento): limpa UM endereço avulso
 * passado literalmente, sem exigir `--campaign` nem que o e-mail bata o
 * padrão `vjpixel+test-preflight-{arm}-{campaign}@gmail.com` de
 * `preflight-utm-arms.ts`. Mutuamente exclusivo com `--campaign`.
 *   npx tsx scripts/cleanup-preflight-subscribers.ts --email vjpixel+preflightgoogle@gmail.com          # dry-run
 *   npx tsx scripts/cleanup-preflight-subscribers.ts --email vjpixel+preflightgoogle@gmail.com --push    # executa
 *
 * Guard de publicação: em `--push` faz um `POST /unsubscribe` real no Kit —
 * não é "publicação" no sentido do guard de dispatch (não cria/agenda/envia
 * campanha; é remoção de 3 cadastros de teste que o próprio fluxo de teste
 * criou), mas nenhuma sessão overnight/develop roda `--push` sozinha —
 * roteiro (`docs/preflight-utm-cookie-roteiro.md`) instrui o editor a rodar
 * isso manualmente como último passo da passada.
 */
import "dotenv/config";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { resolveKitConfig, type KitConfig } from "./lib/kit-config.ts";
import { getKitSubscriberByEmail, unsubscribeKitSubscriber } from "./lib/kit-subscribers.ts";
import { buildPreflightPlan, DEFAULT_PREFLIGHT_BASE_EMAIL } from "./lib/preflight-utm-arms.ts";

export type CleanupOutcome = "unsubscribed" | "already_inactive" | "not_found" | "skipped_dry_run";

export interface CleanupResult {
  arm: string;
  email: string;
  status_before: string | null;
  outcome: CleanupOutcome;
}

/** Estados do Kit que já contam como "fora da base" pra fins de limpeza —
 *  mesma semântica de `KIT_EXITED_STATES` (`kit-subscribers-ingest.ts`),
 *  reimplementada aqui pra não puxar o módulo de ingestão SQLite (concern
 *  bem diferente) só por esta constante. */
const KIT_ALREADY_CLEAN_STATES: ReadonlySet<string> = new Set(["cancelled", "bounced", "complained"]);

/** Pura — decide a ação a partir do status atual, sem tocar rede. */
export function decideOutcome(statusBefore: string | null, push: boolean): CleanupOutcome {
  if (statusBefore === null) return "not_found";
  if (KIT_ALREADY_CLEAN_STATES.has(statusBefore)) return "already_inactive";
  return push ? "unsubscribed" : "skipped_dry_run";
}

/**
 * Forma estrutural mínima que `cleanupOneArm` precisa — `PreflightArmPlan`
 * satisfaz isto, mas também satisfaz um plano avulso construído por
 * `buildAdhocPlan` (#5736), cujo `arm.key` não pertence à união fechada de
 * `PreflightUtmArm["key"]`.
 */
export interface CleanupPlanLike {
  arm: { key: string };
  email: string;
}

/** Pura — monta um "plano" de 1 e-mail avulso pra `--email` (#5736), fora do
 *  padrão de nomeação `preflight-utm-arms.ts`. `arm.key` é só um rótulo pra
 *  aparecer na tabela de resultado, não participa de nenhum lookup. */
export function buildAdhocPlan(email: string): CleanupPlanLike {
  return { arm: { key: "adhoc" }, email };
}

export async function cleanupOneArm(
  plan: CleanupPlanLike,
  push: boolean,
  config: KitConfig,
): Promise<CleanupResult> {
  const subscriber = await getKitSubscriberByEmail(plan.email, config);
  const statusBefore = subscriber?.state ?? null;
  const outcome = decideOutcome(statusBefore, push);
  if (outcome === "unsubscribed" && subscriber) {
    await unsubscribeKitSubscriber(subscriber.id, config);
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
  const campaign = getStringArg(argv, "campaign", { example: "preflight-2609" });
  const adhocEmail = getStringArg(argv, "email", { example: "vjpixel+preflightgoogle@gmail.com" });

  if (campaign && adhocEmail) {
    process.stderr.write(`[cleanup-preflight-subscribers] --campaign e --email são mutuamente exclusivos\n`);
    process.exit(2);
  }
  if (!campaign && !adhocEmail) {
    process.stderr.write(
      `[cleanup-preflight-subscribers] passe --campaign preflight-2609 (os 3 e-mails do plano) OU --email um@endereco.avulso (#5736, e-mail fora do padrão)\n`,
    );
    process.exit(2);
  }
  const baseEmail = getStringArg(argv, "base-email") ?? DEFAULT_PREFLIGHT_BASE_EMAIL;
  const push = argv.includes("--push");

  const cfgResult = resolveKitConfig();
  if (!cfgResult.ok) {
    process.stderr.write(`[cleanup-preflight-subscribers] ${cfgResult.reason}\n`);
    process.exit(2);
  }
  const plans: CleanupPlanLike[] = adhocEmail ? [buildAdhocPlan(adhocEmail)] : buildPreflightPlan(campaign!, baseEmail);

  Promise.all(plans.map((plan) => cleanupOneArm(plan, push, cfgResult.config)))
    .then((results) => {
      process.stdout.write(formatResultsTable(results, push) + "\n");
    })
    .catch((err) => {
      process.stderr.write(`[cleanup-preflight-subscribers] ERRO: ${String(err)}\n`);
      process.exit(1);
    });
}
