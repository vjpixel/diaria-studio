#!/usr/bin/env node
/**
 * clarice-mv-ondemand.ts (#4659) — verificação MillionVerifier SOB DEMANDA,
 * só o suficiente pra cobrir o déficit de fila da onda que
 * `/diaria-clarice-envio` está montando — nunca em lote sobre o backlog
 * inteiro.
 *
 * Substitui a proposta descartada da #4427 (varrer os ~253k `mv_unverified`
 * de uma vez, ~US$482 pré-comprados — contra o teto de aquisição do projeto,
 * que não pré-compra capacidade). Aqui o gasto é proporcional ao uso: só
 * verifica o suficiente pra destravar a proposta ATUAL, na MESMA ordem de
 * prioridade que a fila de envio usa (recência real via
 * `compareCohortEntriesByRecency`, morno→frio — sucede a ordenação pura por
 * `cohortSendRank`, #5398; #4542 já corrigiu uma inversão dessa ordem, não
 * reintroduzir).
 *
 * READ+WRITE — ao contrário de `clarice-plan-wave.ts` (read-only por
 * construção, docstring dele), este script GASTA crédito MillionVerifier de
 * verdade. Reusa TODA a maquinaria de `verify-emails-mv.ts`
 * (`verifyCohortList`, checkpoint resumível, retry, "skip forever" #2886,
 * `-error.csv` #4353) — não duplica nenhuma dessas garantias.
 *
 * O cálculo do RECORTE (quantos verificar, de quais cohorts, em qual ordem)
 * é 100% read-only e mora em `scripts/lib/clarice-wave-plan.ts`
 * (`computeFirstSendDeficit` + `planMvOnDemand`), já embutido na proposta que
 * `clarice-plan-wave.ts` imprime (`mvOnDemandPlan`) — este script só
 * RECOMPUTA a mesma proposta (chamando `planWave`) e EXECUTA o plano que ela
 * já revelou. Um valor que a proposta não mostrou não é um valor que este
 * script verifica.
 *
 * Fluxo completo (a skill `/diaria-clarice-envio`, Passo 5, chama os 3 nesta
 * ordem quando o Passo 1 revelar um déficit com `mvOnDemandPlan` não-vazio):
 *
 *   1. npx tsx scripts/clarice-mv-ondemand.ts --cycle X --dates A,B,C    (este script — verifica)
 *   2. npx tsx scripts/clarice-build-db.ts                               (reingere o store, #4362)
 *   3. npx tsx scripts/clarice-plan-wave.ts --cycle X --dates A,B,C      (recompõe a proposta, agora sem o déficit — ou com um déficit menor)
 *
 * Decisão do editor (05-06/08/2026, #4659): sem teto de gasto explícito por
 * invocação — "o teto é o próprio volume diário da onda" (~1k contatos/dia
 * ≈ US$2/dia, ordem de grandeza pequena demais pra merecer um gate extra de
 * confirmação). Este script NUNCA verifica além do que a proposta ATUAL
 * revela precisar (`mvOnDemandPlan`, calculado a partir do déficit real) —
 * o volume da onda já É o teto, por construção, não por confirmação manual.
 *
 * Guards herdados de `verify-emails-mv.ts`/`clarice-wave-plan.ts` (nunca
 * removidos por este script):
 *   - "skip forever" (#2886) — `readStoreCandidates` só enxerga contatos com
 *     `mv_bucket` vazio; um contato já verificado em qualquer ciclo anterior
 *     nunca reaparece aqui.
 *   - `assinantes-ativos` NUNCA verificado — MV-isento (#3826/#1297);
 *     filtrado do plano por construção (`planMvOnDemand` exclui
 *     `isMvExemptCohort`) e `verify-emails-mv.ts` teria abortado de qualquer
 *     forma se recebesse esse cohort — defesa em profundidade dupla.
 *   - Falha transitória vai pro `-error.csv`, nunca no checkpoint (#4353) —
 *     comportamento herdado de `verifyCohortList`, intocado.
 *
 * Uso:
 *   npx tsx scripts/clarice-mv-ondemand.ts --cycle 2607-08 --dates 2026-08-07
 *
 * Stdout: sempre o resumo em JSON (mesmo padrão de verify-emails-mv.ts —
 * sem flag `--json` separada). Stderr: progresso humano-legível.
 *
 * Env: MILLION_VERIFIER_API_KEY (obrigatório) + BREVO_CLARICE_API_KEY (usada
 * por `planWave` — crédito Brevo/campanhas comprometidas; sem ela a proposta
 * ainda roda, com os bloqueios correspondentes de pé, mas o `mvOnDemandPlan`
 * calculado é o mesmo, já que não depende de nenhum dos dois).
 *
 * ⚠️ **Não exercitado ao vivo nesta unidade** (#4659, worktree isolado sem
 * `MILLION_VERIFIER_API_KEY`/`data/` reais — mesma disciplina do #4320/#4382/
 * #4490/#4534/#4572). Testado com mocks (fetch/DB in-memory); a 1ª execução
 * numa onda real fica pra sessão supervisionada com o editor presente.
 */

import { resolve } from "node:path";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import {
  readStoreCandidates,
  readAllCohortRows,
  verifyCohortList,
  type CohortVerifySummary,
} from "./verify-emails-mv.ts";
import { computeFirstSendDeficit, MV_ONDEMAND_APPROVAL_MARGIN, type MvOnDemandPlan } from "./lib/clarice-wave-plan.ts";
import { planWave, parseDatesArg } from "./clarice-plan-wave.ts";
import { clariceCycleDir, ensureDir, requireCycleArg } from "./lib/clarice-paths.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { DEFAULT_DASHBOARD_URL } from "./clarice-schedule-ramp.ts";
import { getArg, getIntArg, isMainModule } from "./lib/cli-args.ts";
import { readClariceAbcState, lockedSubjectFromState } from "./lib/clarice-abc-state.ts";

/** Raiz do repo — não `process.cwd()`, mesmo motivo de `clarice-plan-wave.ts`. */
const ROOT = resolve(new URL("..", import.meta.url).pathname);

loadProjectEnv();

export interface MvOnDemandRunSummary {
  plan: MvOnDemandPlan;
  perCohort: CohortVerifySummary[];
  /** Soma de `processed_this_run` de todos os cohorts. */
  totalVerifiedNow: number;
  /**
   * `verified ÷ (verified+rejected)` agregado desta rodada — `unknown` fica
   * de fora do denominador (nem aprovado nem rejeitado, inconclusivo).
   * `null` quando nada foi decidido ainda (0 verified+rejected).
   */
  approvalRate: number | null;
}

/**
 * Executa um `MvOnDemandPlan` já calculado — para cada cohort do plano, lê os
 * candidatos do store (`readStoreCandidates`/`readAllCohortRows`, mesmas
 * queries de `verify-emails-mv.ts`) e chama `verifyCohortList` com
 * `limit: alloc.count`. Sequencial entre cohorts (não paralelo) — cada
 * `verifyCohortList` já paraleliza internamente (`concurrency`) e rodar
 * cohorts em paralelo multiplicaria a concorrência efetiva sem necessidade,
 * além de complicar o SIGINT/checkpoint-flush que `verifyCohortList` já trata
 * por cohort.
 *
 * Puro em relação ao PLANO (não decide quem verificar, só executa o que
 * `plan` já determinou) — mas não é "puro" no sentido geral do módulo: faz
 * I/O real (rede MV + disco). Testável com `apiKey` fake + `globalThis.fetch`
 * mockado (mesmo padrão de `test/verify-emails-mv.test.ts`).
 */
export async function runMvOnDemandPlan(params: {
  apiKey: string;
  dbPath: string;
  cycleDir: string;
  plan: MvOnDemandPlan;
  concurrency: number;
  timeout: number;
}): Promise<MvOnDemandRunSummary> {
  const db = openClariceDb(params.dbPath);
  const perCohort: CohortVerifySummary[] = [];
  try {
    for (const alloc of params.plan.byCohort) {
      const { rows, fields, emailKey } = readStoreCandidates(db, alloc.cohort);
      const { rows: allCohortRows } = readAllCohortRows(db, alloc.cohort);
      const summary = await verifyCohortList({
        apiKey: params.apiKey,
        cohort: alloc.cohort,
        cycleDir: params.cycleDir,
        rows,
        fields,
        emailKey,
        allCohortRows,
        concurrency: params.concurrency,
        timeout: params.timeout,
        limit: alloc.count,
      });
      perCohort.push(summary);
    }
  } finally {
    // Windows: handle SQLite aberto segura o lock e trava um sync concorrente
    // (mesmo motivo de clarice-plan-wave.ts fechar o db antes de retornar).
    db.close();
  }

  const totalVerifiedNow = perCohort.reduce((s, x) => s + x.processed_this_run, 0);
  const verified = perCohort.reduce((s, x) => s + x.buckets.verified, 0);
  const rejected = perCohort.reduce((s, x) => s + x.buckets.rejected, 0);
  const decided = verified + rejected;
  return {
    plan: params.plan,
    perCohort,
    totalVerifiedNow,
    approvalRate: decided > 0 ? verified / decided : null,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const apiKey = process.env.MILLION_VERIFIER_API_KEY;
  if (!apiKey) {
    console.error(
      "MILLION_VERIFIER_API_KEY não definida. Configure no .env (veja .env.example) " +
        "ou no ambiente. Pegue a key no dashboard MillionVerifier → API.",
    );
    process.exit(1);
  }

  const cycle = requireCycleArg(argv);
  const dates = parseDatesArg(getArg(argv, "dates"));
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const dashboardUrl = getArg(argv, "dashboard-url") || DEFAULT_DASHBOARD_URL;

  // Recomputa a MESMA proposta que `/diaria-clarice-envio` já viu no Passo 1
  // — o `mvOnDemandPlan` embutido nela é a única fonte do recorte a
  // verificar (nunca um cálculo paralelo aqui).
  const proposal = await planWave({
    cycle,
    dates,
    dbPath,
    dashboardUrl,
    // #5055 (achado do review da PR #5057): 3º caller de `planWave()`, e o
    // rollout original só cobriu os outros dois. Sem o estado durável aqui,
    // este script recomputa a proposta como se o teste A/B/C ainda estivesse
    // aberto — dimensionando a verificação MillionVerifier pra 3 células
    // quando a onda real vai sair com 1. Não cria nem agenda campanha (o raio
    // é crédito MV gasto à toa, não envio errado), mas "a MESMA proposta que
    // o Passo 1 já viu" só é verdade se as duas leem a mesma fonte.
    lockedSubject: getArg(argv, "locked-subject") || lockedSubjectFromState(readClariceAbcState(ROOT)),
  });
  const plan = proposal.mvOnDemandPlan;
  // #4792 (fleet review, achado #4): `plan.deficit` (desde #4787) é o MAIOR
  // entre o déficit de fila tradicional e a cauda fria de uma inversão de
  // safra (ver docstring de `MvOnDemandPlan.deficit` em clarice-wave-plan.ts)
  // — pode vir INTEIRAMENTE de `coldTailCount` sem nenhum déficit real de
  // fila. Rotular sempre como "Déficit" é o MESMO bug de rotulagem que o
  // commit de fixup desta PR já corrigiu em `renderWaveProposal`; decompõe
  // aqui pelo mesmo cálculo (puro, barato) pra não repetir o engano nas
  // mensagens de console deste script.
  const queueDeficit = computeFirstSendDeficit(proposal.availableFirstSend, proposal.volumes.total);
  const inversionTail = proposal.cohortInversion?.coldTailCount ?? 0;
  const deficitReason =
    queueDeficit > 0 && inversionTail > 0
      ? `déficit de fila (${queueDeficit}) + inversão de safra (${inversionTail}) — alvo pelo MAIOR dos dois`
      : queueDeficit > 0
        ? `déficit de fila: ${queueDeficit}`
        : `inversão de safra (fila cobre o volume, sem déficit real): ${inversionTail}`;

  if (plan.byCohort.length === 0) {
    const msg =
      plan.deficit === 0
        ? "ℹ️  Fila de 1º envio já cobre o volume proposto — nenhuma verificação MV necessária."
        : `⚠️  Alvo de verificação motivado por ${deficitReason}, mas o backlog MV (${proposal.mvBacklog.total} no total) não tem candidato elegível pra cobrir — nada a verificar aqui.`;
    console.error(msg);
    console.log(JSON.stringify({ plan, perCohort: [], totalVerifiedNow: 0, approvalRate: null }, null, 2));
    return;
  }

  const cycleDir = clariceCycleDir(cycle, getArg(argv, "data-root") || undefined);
  ensureDir(cycleDir);

  console.error(
    `🎯 ${deficitReason} → alvo de verificação=${plan.targetVerifyCount} ` +
      `(margem ${(MV_ONDEMAND_APPROVAL_MARGIN * 100).toFixed(0)}%) em ${plan.byCohort.length} cohort(s), ` +
      `≈ US$ ${plan.estimatedCostUsd.toFixed(2)}` +
      (plan.backlogInsufficient
        ? " — ⚠️ backlog insuficiente pra cobrir o alvo mesmo verificando tudo disponível."
        : ""),
  );
  for (const a of plan.byCohort) {
    console.error(`   ${a.cohort}: ${a.count} contato(s)`);
  }

  const summary = await runMvOnDemandPlan({
    apiKey,
    dbPath,
    cycleDir,
    plan,
    concurrency: getIntArg(argv, "concurrency") ?? 12,
    timeout: getIntArg(argv, "timeout") ?? 20,
  });

  console.error(
    `\n✅ ${summary.totalVerifiedNow} e-mail(s) verificado(s) nesta rodada` +
      (summary.approvalRate != null ? ` · aprovação=${(summary.approvalRate * 100).toFixed(1)}%` : "") +
      ` · REINGIRA O STORE (npx tsx scripts/clarice-build-db.ts) antes de recompor a proposta.`,
  );

  console.log(JSON.stringify(summary, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
