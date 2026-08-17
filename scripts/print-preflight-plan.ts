#!/usr/bin/env node
/**
 * print-preflight-plan.ts (#5545)
 *
 * Imprime as 3 URLs + os 3 e-mails de teste do preflight de atribuição
 * (#5522 + #5543) pra um `utm_campaign` dado — "URLs pré-montadas pelos 3
 * sufixos, prontas pra copiar" (item 4 da #5545, passo 1 do roteiro em
 * `docs/preflight-utm-cookie-roteiro.md`). Puro texto, sem I/O de rede —
 * só monta a partir de `lib/preflight-utm-arms.ts`.
 *
 * Uso:
 *   npx tsx scripts/print-preflight-plan.ts --campaign preflight-2608
 *   npx tsx scripts/print-preflight-plan.ts --campaign preflight-2608 --json
 */
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { buildPreflightPlan, DEFAULT_PREFLIGHT_BASE_EMAIL, type PreflightArmPlan } from "./lib/preflight-utm-arms.ts";

/** Pura — formata o plano em texto pronto pra copiar. */
export function formatPlan(campaign: string, plans: PreflightArmPlan[]): string {
  const lines = [`Plano de preflight — campanha "${campaign}"`, ""];
  for (const p of plans) {
    lines.push(`[${p.arm.key}]`);
    lines.push(`  URL:   ${p.url}`);
    lines.push(`  email: ${p.email}`);
    lines.push("");
  }
  return lines.join("\n");
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const campaign = getStringArg(argv, "campaign", { example: "preflight-2608" });
  if (!campaign) {
    process.stderr.write(
      `[print-preflight-plan] --campaign é obrigatório (ex: --campaign preflight-2608)\n`,
    );
    process.exit(2);
  }
  const baseEmail = getStringArg(argv, "base-email") ?? DEFAULT_PREFLIGHT_BASE_EMAIL;
  const jsonMode = argv.includes("--json");
  const plans = buildPreflightPlan(campaign, baseEmail);

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ campaign, plans }, null, 2) + "\n");
  } else {
    process.stdout.write(formatPlan(campaign, plans) + "\n");
  }
}
