#!/usr/bin/env node
/**
 * scripts/cleanup-preflight-test-subscribers.ts (#5545)
 *
 * Último item do critério de aprovação da #5522 — e o mais fácil de
 * esquecer: os endereços de teste do preflight não podem ficar na base
 * contaminando `leitor-v1` e o custo por leitor do próprio teste que eles
 * validam. `DELETE` (não unsubscribe) — precedente já estabelecido ao vivo
 * na própria #5522 ("Cadastros de teste removidos ao final (3× DELETE
 * confirmado, status 204)"): diferente de `evaluate-brevo-diaria.ts`, que
 * evita DELETE por ser dado de assinante REAL com histórico, os 3 endereços
 * de preflight são descartáveis por definição — não têm histórico de envio
 * a preservar.
 *
 * Idempotente: e-mail já ausente (404) é tratado como sucesso ("nada a
 * fazer"), não como erro — rodar de novo depois de já ter limpado não
 * quebra.
 *
 * Dry-run por padrão (mesma convenção do resto do repo — ex:
 * `sync-apoio-nivel-beehiiv.ts`, `beehiiv-home-meta-check.ts`): só lista o
 * que SERIA deletado. `--execute` deleta de verdade.
 *
 * Uso:
 *   npx tsx scripts/cleanup-preflight-test-subscribers.ts --emails a@x.com,b@x.com,c@x.com             # dry-run
 *   npx tsx scripts/cleanup-preflight-test-subscribers.ts --emails a@x.com,b@x.com,c@x.com --execute    # deleta
 *
 * Env: `BEEHIIV_API_KEY` (obrigatório), `BEEHIIV_PUBLICATION_ID` opcional —
 * mesmo contrato de `loadBeehiivConfig`.
 *
 * Exit codes: 0 = todos os e-mails resolvidos (ausentes, deletados, ou já
 * ausentes); 1 = pelo menos 1 delete falhou; 2 = args/config inválidos.
 */
import "dotenv/config";
import { loadBeehiivConfig } from "./lib/beehiiv-config.ts";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { fetchBeehiivSubscriptionUtm, deleteBeehiivSubscription } from "./lib/preflight-utm.ts";

const LOG_PREFIX = "[cleanup-preflight-test-subscribers]";

export interface CleanupResult {
  email: string;
  action: "already_absent" | "would_delete" | "deleted" | "delete_failed";
  id: string | null;
  status: string | null;
  error?: string;
}

/** Parseia `--emails a@x.com,b@x.com,...` — lista simples, sem par arm=email
 *  (diferente de `parseArmEmailPairs` do verify — cleanup não precisa saber
 *  a que braço cada endereço pertence, só deletar). @pure */
export function parseEmailList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Formata o resumo human-readable de uma rodada de limpeza. @pure */
export function formatCleanupSummary(results: readonly CleanupResult[], dryRun: boolean): string {
  if (results.length === 0) return "(nenhum e-mail informado)";
  const lines: string[] = [];
  for (const r of results) {
    switch (r.action) {
      case "already_absent":
        lines.push(`${r.email}: já ausente na Beehiiv — nada a fazer.`);
        break;
      case "would_delete":
        lines.push(`${r.email}: SERIA deletado (id=${r.id}, status=${r.status}) — rode com --execute.`);
        break;
      case "deleted":
        lines.push(`${r.email}: deletado (id=${r.id}).`);
        break;
      case "delete_failed":
        lines.push(`${r.email}: FALHA ao deletar (id=${r.id}) — ${r.error}`);
        break;
    }
  }
  lines.push("");
  lines.push(
    dryRun
      ? `--dry-run: nenhuma escrita foi feita na Beehiiv. Rode com --execute para deletar de verdade.`
      : `Limpeza concluída.`,
  );
  return lines.join("\n");
}

async function cleanupOne(
  publicationId: string,
  apiKey: string,
  email: string,
  execute: boolean,
): Promise<CleanupResult> {
  const sub = await fetchBeehiivSubscriptionUtm(publicationId, apiKey, email);
  if (!sub) return { email, action: "already_absent", id: null, status: null };

  if (!execute) {
    return { email, action: "would_delete", id: sub.id, status: sub.status };
  }

  try {
    await deleteBeehiivSubscription(publicationId, apiKey, sub.id);
    return { email, action: "deleted", id: sub.id, status: sub.status };
  } catch (e) {
    return { email, action: "delete_failed", id: sub.id, status: sub.status, error: (e as Error).message };
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const emailsRaw = getStringArg(argv, "emails", { example: "a@x.com,b@x.com,c@x.com" });
  const execute = hasFlag(argv, "execute");

  if (!emailsRaw) {
    console.error(`${LOG_PREFIX} uso: --emails a@x.com,b@x.com,... [--execute]`);
    process.exitCode = 2;
    return;
  }

  const emails = parseEmailList(emailsRaw);
  if (emails.length === 0) {
    console.error(`${LOG_PREFIX} --emails não trouxe nenhum endereço válido.`);
    process.exitCode = 2;
    return;
  }

  const { apiKey, publicationId } = loadBeehiivConfig(LOG_PREFIX);

  console.log(`${LOG_PREFIX} ${execute ? "EXECUTANDO (--execute)" : "dry-run"} — ${emails.length} e-mail(s).`);

  const results: CleanupResult[] = [];
  for (const email of emails) {
    results.push(await cleanupOne(publicationId, apiKey, email, execute));
  }

  console.log("");
  console.log(formatCleanupSummary(results, !execute));

  if (results.some((r) => r.action === "delete_failed")) {
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
