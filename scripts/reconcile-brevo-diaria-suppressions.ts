#!/usr/bin/env node
/**
 * scripts/reconcile-brevo-diaria-suppressions.ts (#5077)
 *
 * ## O problema (achado ao vivo em 260811)
 *
 * `evaluate-brevo-diaria.ts --push` suprime um contato (`emailBlacklisted:
 * true` na Brevo, `status: "suppressed"` no store,
 * `resolution_reason: "score_threshold"`) quando `openRate<=20%` sobre
 * envios MADUROS (>=48h). Isso é uma decisão TERMINAL — `runEvaluation` só
 * itera `status === "in_brevo"`, então um contato `suppressed` nunca é
 * reavaliado de novo por essa rotina.
 *
 * Só que a via de CLIQUE (`workers/reativar/`, ver cabeçalho de
 * `evaluate-brevo-diaria.ts` "Duas vias de promoção em paralelo") continua
 * viva por fora: se a pessoa clica no link de reativação de uma campanha
 * ANTIGA ainda parada na caixa de entrada — mesmo horas/dias DEPOIS de já
 * ter sido suprimida — o Worker ativa a subscription na Beehiiv diretamente,
 * sem checar o estado deste store. O funil funcionou (a pessoa não volta a
 * receber e-mails deste canal, que é o comportamento correto — ela já está
 * confirmada na Beehiiv), mas o registro de auditoria local fica com uma
 * foto tirada ANTES do desfecho real: `resolution_reason: "score_threshold"`
 * quando na verdade foi uma confirmação tardia bem-sucedida.
 *
 * Caso concreto da issue: `felipeaparecida918@gmail.com` — suprimido
 * 2026-08-10 00:18 BRT (`openRate=20%`), clicou às 14:15 BRT do MESMO DIA
 * num link de campanha enviada 3 dias antes.
 *
 * ## O que este script faz (e o que NÃO faz)
 *
 * Releitura pontual do status Beehiiv de contatos `suppressed` por
 * `score_threshold` recentes (`--days`, default `DEFAULT_LOOKBACK_DAYS`) —
 * se `status === "active"`, corrige `resolution_reason` pra
 * `"self_confirmed_after_suppression"` (ver
 * `applySuppressionReconciliation`, `scripts/lib/brevo-diaria-store.ts`).
 *
 * **NUNCA reverte `status`** — o contato PERMANECE `suppressed` (não volta a
 * receber e-mails deste canal; ele já está confirmado na Beehiiv por fora
 * deste store, então as duas entregas seriam redundantes). Isto é
 * estritamente uma correção de OBSERVABILIDADE/auditoria — mesma disciplina
 * de `reconcileStoreWithBrevoList`/`findMissingSeedEmails`
 * (`evaluate-brevo-diaria.ts`, #4579/#4982): lê, reporta, e só ESCREVE com
 * `--push` explícito.
 *
 * Só lê a Beehiiv (`GET .../subscriptions/by_email/{email}`, mesmo helper
 * `fetchBeehiivSubscriptionStatus` de `evaluate-brevo-diaria.ts`) — nunca
 * escreve na Brevo nem na Beehiiv. A única mutação de qualquer tipo é local,
 * no store (`data/brevo-diaria/contacts.json`), e só acontece com `--push`.
 *
 * ## Uso
 *
 *   npx tsx scripts/reconcile-brevo-diaria-suppressions.ts                          # dry-run, últimos 30 dias
 *   npx tsx scripts/reconcile-brevo-diaria-suppressions.ts --days 60                # dry-run, janela maior
 *   npx tsx scripts/reconcile-brevo-diaria-suppressions.ts --email pessoa@x.com     # dry-run, 1 contato específico (ignora --days)
 *   npx tsx scripts/reconcile-brevo-diaria-suppressions.ts --push                   # aplica as correções encontradas
 *   npx tsx scripts/reconcile-brevo-diaria-suppressions.ts --email felipeaparecida918@gmail.com --push  # correção pontual da issue
 *
 * Como todo `--push` deste repo que toca contas externas (ver
 * `context/overnight-dispatch-rules.md` #1), esta unidade (#5077) NUNCA
 * rodou `--push` ao vivo — só testes com fetch mockado. A correção pontual
 * de `felipeaparecida918@gmail.com` e a auditoria de outros casos do mesmo
 * padrão ficam pendentes pro editor rodar manualmente (ver corpo do PR).
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { loadBeehiivConfig } from "./lib/beehiiv-config.ts";
import { hasFlag, getIntArg, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { fetchBeehiivSubscriptionStatus } from "./evaluate-brevo-diaria.ts";
import {
  readStore,
  writeStore,
  applySuppressionReconciliation,
  normalizeEmail,
  DEFAULT_STORE_PATH,
  type BrevoDiariaContact,
  type BrevoDiariaStore,
} from "./lib/brevo-diaria-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Janela padrão de recência (#5077) — só recandidata a reconciliação
 * contatos suprimidos DENTRO desta janela. Sem um teto, TODO contato
 * suprimido desde o início do canal seria relido (1 chamada Beehiiv por
 * contato) em toda rodada, crescendo sem limite. 30 dias cobre com folga o
 * caso concreto da issue (clique ~14h depois da supressão) e qualquer
 * confirmação tardia plausível — uma pessoa suprimida há meses que decide
 * clicar num link antigo é o caso raro que `--email` cobre manualmente. */
export const DEFAULT_LOOKBACK_DAYS = 30;

export interface SelectSuppressionCandidatesOptions {
  /** Default `DEFAULT_LOOKBACK_DAYS`. Ignorado quando `email` é passado. */
  lookbackDays?: number;
  /** Mira só este e-mail (normalizado antes de comparar), ignorando o
   * lookback — usado pra correção pontual sem esperar o contato ainda estar
   * dentro da janela padrão (caso concreto da issue #5077). */
  email?: string;
  /** Injetável pra teste — nunca `Date.now()` real em teste (#633). */
  nowMs?: number;
}

/**
 * Pura — seleciona candidatos a reconciliação: contatos `suppressed` por
 * `score_threshold` (o único motivo que esta rotina corrige — `native_*` e
 * `self_confirmed_beehiiv` já são saídas corretas por desenho, sem foto
 * desatualizada pra corrigir) dentro da janela de recência (ou, com `email`,
 * exatamente aquele contato, sem checar recência).
 *
 * `suppressed_at` ausente/malformado → NUNCA candidata por recência
 * (fail-safe: sem timestamp confiável, não assume "recente") — só entra via
 * `--email` explícito.
 */
export function selectSuppressionReconciliationCandidates(
  store: BrevoDiariaStore,
  opts: SelectSuppressionCandidatesOptions = {},
): BrevoDiariaContact[] {
  const nowMs = opts.nowMs ?? Date.now();
  const targetEmail = opts.email ? normalizeEmail(opts.email) : undefined;
  const lookbackMs = (opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) * 24 * 60 * 60 * 1000;

  return store.contacts.filter((c) => {
    if (c.status !== "suppressed" || c.resolution_reason !== "score_threshold") return false;
    if (targetEmail) return c.email === targetEmail;
    if (!c.suppressed_at) return false;
    const suppressedMs = Date.parse(c.suppressed_at);
    if (Number.isNaN(suppressedMs)) return false;
    return nowMs - suppressedMs <= lookbackMs;
  });
}

export interface ReconciliationParams {
  contacts: BrevoDiariaContact[];
  store: BrevoDiariaStore;
  publicationId: string;
  beehiivApiKey: string;
  push: boolean;
  log: (msg: string) => void;
  /** Injetável pra teste — nunca a rede real em teste (#633). */
  fetchImpl?: typeof fetch;
}

export interface ReconciliationResult {
  store: BrevoDiariaStore;
  checked: number;
  /** Quantos contatos mostraram `status === "active"` na Beehiiv — confirmação
   * tardia detectada. Em dry-run, isto é "quantos SERIAM corrigidos"; com
   * `--push`, "quantos FORAM corrigidos" (o `store` retornado já reflete). */
  reconciled: number;
  failed: number;
}

/**
 * Roda a reconciliação sobre os candidatos já selecionados (sem I/O de
 * env/config/disco — isso é responsabilidade do `main()`, mesma separação
 * de `runEvaluation` em `evaluate-brevo-diaria.ts`). Falha por contato NUNCA
 * aborta a função inteira — mesmo padrão do resto do canal Brevo diária.
 */
export async function runSuppressionReconciliation(params: ReconciliationParams): Promise<ReconciliationResult> {
  const { contacts, publicationId, beehiivApiKey, push, log, fetchImpl } = params;
  let store = params.store;
  let checked = 0;
  let reconciled = 0;
  let failed = 0;

  for (const contact of contacts) {
    checked++;
    let status: string | null;
    try {
      status = await fetchBeehiivSubscriptionStatus(publicationId, beehiivApiKey, contact.email, fetchImpl);
    } catch (e) {
      failed++;
      log(`warn: falha ao checar status Beehiiv de ${contact.email}: ${(e as Error).message}`);
      continue;
    }
    if (status !== "active") {
      log(
        `${contact.email}: status Beehiiv atual = ${status ?? "não encontrado"} — supressão continua consistente, ` +
          "nada a corrigir.",
      );
      continue;
    }
    reconciled++;
    log(
      `${contact.email}: suprimido por score_threshold, MAS status Beehiiv atual é "active" — confirmação tardia ` +
        `detectada (#5077). status PERMANECE suppressed (não volta a receber e-mails deste canal); ` +
        `resolution_reason ${push ? "corrigido" : "SERIA corrigido (dry-run)"} pra self_confirmed_after_suppression.`,
    );
    if (push) {
      store = applySuppressionReconciliation(store, contact.email);
    }
  }

  return { store, checked, reconciled, failed };
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const log = (msg: string) => process.stderr.write(`[reconcile-brevo-diaria-suppressions] ${msg}\n`);

  const days = getIntArg(argv, "days", { min: 1 }) ?? DEFAULT_LOOKBACK_DAYS;
  const email = getStringArg(argv, "email", { example: "pessoa@dominio.com" });

  const { apiKey: beehiivApiKey, publicationId } = loadBeehiivConfig("[reconcile-brevo-diaria-suppressions]");

  const store = readStore(DEFAULT_STORE_PATH);
  const candidates = selectSuppressionReconciliationCandidates(store, { lookbackDays: days, email });

  if (candidates.length === 0) {
    log(
      email
        ? `nenhum contato suppressed (score_threshold) encontrado pro e-mail ${normalizeEmail(email)} — nada a reconciliar.`
        : `nenhum contato suppressed (score_threshold) nos últimos ${days} dia(s) — nada a reconciliar.`,
    );
    return;
  }
  log(`${candidates.length} contato(s) suppressed (score_threshold) candidato(s) a reconciliação.`);

  const result = await runSuppressionReconciliation({
    contacts: candidates,
    store,
    publicationId,
    beehiivApiKey,
    push,
    log,
  });

  log(
    `resumo: ${result.checked} checado(s), ${result.reconciled} confirmação(ões) tardia(s) detectada(s) ` +
      `(${push ? "resolution_reason corrigido" : "dry-run — NENHUMA mutação aplicada"}), ${result.failed} falha(s).`,
  );

  if (!push) {
    log("dry-run (default) — NENHUMA mutação aplicada. Use --push para gravar as correções encontradas.");
    if (result.failed > 0) process.exitCode = 1;
    return;
  }
  writeStore(result.store, DEFAULT_STORE_PATH);
  log("push concluído — store atualizado (status permanece suppressed; só resolution_reason/reconciled_at corrigidos).");
  if (result.failed > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[reconcile-brevo-diaria-suppressions] erro fatal: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}
