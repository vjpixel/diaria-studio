#!/usr/bin/env node
/**
 * confirmation-email-auth-report.ts (#8548 item 2) — DKIM, SPF do
 * Return-Path e DMARC do remetente do e-mail de confirmação do double
 * opt-in (`oi` em `news.diar.ia.br`, Kit), lidos do DNS público. Não envia
 * e-mail. Lógica e limites em `scripts/lib/confirmation-email-auth.ts`.
 *
 * Uso: `npx tsx scripts/confirmation-email-auth-report.ts [--domain D] [--json]`
 *
 * Exit: 0 = ok ou só avisos; 1 = alguma falha; 2 = alguma consulta DNS não
 * respondeu (não dá para afirmar nada sobre aquele registro).
 */
import {
  CONFIRMATION_SENDER_DOMAIN,
  collectSenderAuthDns,
  evaluateSenderAuth,
  type SenderAuthReport,
} from "./lib/confirmation-email-auth.ts";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";

export function renderSenderAuthReport(report: SenderAuthReport): string {
  const lines = [`Autenticação do remetente do e-mail de confirmação: ${report.domain} (#8548 item 2)`, ""];
  for (const c of report.checks) lines.push(`${c.status.padEnd(15)} ${c.id.padEnd(16)} ${c.registro}: ${c.detalhe}`);
  lines.push(
    "",
    `Veredito: ${report.veredito}`,
    "Fora do alcance de DNS: colocação em caixa de entrada vs. spam/Promoções e a reputação no",
    "Postmaster Tools (conta Google do editor, domínio verificado via scripts/postmaster-register-domain.ts).",
  );
  return lines.join("\n");
}

export function exitCodeFor(report: SenderAuthReport): number {
  if (report.veredito === "falha") return 1;
  if (report.veredito === "nao-verificavel") return 2;
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const domain = getArg(argv, "domain") || CONFIRMATION_SENDER_DOMAIN;
  const report = evaluateSenderAuth(await collectSenderAuthDns(domain));
  console.log(hasFlag(argv, "json") ? JSON.stringify(report, null, 2) : renderSenderAuthReport(report));
  process.exitCode = exitCodeFor(report);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[confirmation-email-auth-report] erro: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
  });
}
