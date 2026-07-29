/**
 * clarice-mailbox-dryrun.ts (#4249) — relatório READ-ONLY do fix de
 * coerência por caixa canônica (supressão propagada + cohort corrigido +
 * dedup de duplicata) antes do merge. Gate humano obrigatório (ver corpo da
 * issue #4249) — o editor revisa este relatório e só então autoriza o merge
 * que ativa `resolveMailboxCoherence` dentro de `recomputeDerived`
 * (clarice-db.ts).
 *
 * MESMA função (`resolveMailboxCoherence`) usada aqui e no caminho real de
 * escrita — dry-run e efeito real nunca divergem por definição (não há 2
 * implementações pra manter sincronizadas). O que este módulo faz por cima é
 * só a CONTABILIDADE do relatório: comparar o "antes" (classificação per-row
 * isolada, o comportamento pré-#4249) com o "depois" (`resolveMailboxCoherence`)
 * e agrupar por causa.
 */

import {
  classifyEligibility,
  groupByCanonicalMailbox,
  resolveMailboxCoherence,
  type MailboxRow,
} from "./clarice-db.ts";
import { COHORT_ASSINANTES_ATIVOS } from "./cohorts.ts";

export interface MailboxDryrunReport {
  total_rows: number;
  /** grupos com >1 linha na mesma caixa canônica. */
  groups_with_collision: number;
  eligible_to_ineligible: {
    total: number;
    duplicata_mesma_caixa: number;
    supressao_propagada: number;
  };
  duplicata_groups: Array<{
    mailbox: string;
    survivor: string;
    losers: string[];
    tie_break_criterion: string;
  }>;
  supressao_groups: Array<{
    mailbox: string;
    /** linha(s) com sinal PRÓPRIO (email_blacklisted/unsubscribed/complained). */
    suppressed_lines: string[];
    /** linha(s) irmã que vira(m) inelegível por propagação (não tinham sinal próprio). */
    newly_ineligible: string[];
  }>;
  cohort_correction: {
    groups_corrected: number;
    rows_corrected: number;
    details: Array<{ mailbox: string; promoted: string[] }>;
    /** grupos com cohorts divergentes SEM assinantes-ativos pra resolver — não corrigido, só sinalizado. */
    diverged_unresolved: Array<{ mailbox: string; cohorts: Array<string | null> }>;
  };
  /** caixas onde o desempate do dedup empatou em TODOS os critérios (priority_points/opens_count/sends_count/created). */
  arbitrary_ties: number;
}

/**
 * Computa o relatório do dry-run a partir de linhas já com o cohort BASELINE
 * resolvido per-row (mesmo preserve-then-backfill de `recomputeDerived`, sem
 * o passo de coerência de caixa — esse é o que este módulo mede).
 */
export function computeMailboxDryrunReport(
  rows: MailboxRow[],
): MailboxDryrunReport {
  const resolved = resolveMailboxCoherence(rows);
  const groups = groupByCanonicalMailbox(rows);

  const report: MailboxDryrunReport = {
    total_rows: rows.length,
    groups_with_collision: 0,
    eligible_to_ineligible: { total: 0, duplicata_mesma_caixa: 0, supressao_propagada: 0 },
    duplicata_groups: [],
    supressao_groups: [],
    cohort_correction: {
      groups_corrected: 0,
      rows_corrected: 0,
      details: [],
      diverged_unresolved: [],
    },
    arbitrary_ties: 0,
  };

  for (const [mailbox, groupRows] of groups) {
    if (groupRows.length < 2) continue;
    report.groups_with_collision++;

    const losers: string[] = [];
    const newlySuppressed: string[] = [];
    const ownSuppressionLines: string[] = [];
    const promoted: string[] = [];
    let survivor: string | null = null;
    let tieCriterion: string | null = null;

    for (const r of groupRows) {
      const res = resolved.get(r.email)!;
      // "Antes" = classificação per-row ISOLADA (o comportamento pré-#4249,
      // sem olhar pras irmãs de caixa) — mesma chamada que `recomputeDerived`
      // fazia por linha antes deste fix.
      const before = classifyEligibility({
        email_blacklisted: r.email_blacklisted,
        unsubscribed: r.unsubscribed,
        hard_bounced: r.hard_bounced,
        complained: r.complained,
        mv_bucket: r.mv_bucket,
        dispute_losses: r.dispute_losses,
        soft_bounce_count: r.soft_bounce_count,
        priority_points: r.priority_points,
        cohort: r.cohort ?? null,
      });
      const transitioned = before.send_eligible && !res.send_eligible;

      if (res.duplicate_loser) {
        losers.push(r.email);
        survivor = res.survivor_email;
        tieCriterion = res.tie_break_criterion;
      }
      if (res.mailbox_suppressed) newlySuppressed.push(r.email);
      if (r.email_blacklisted || r.unsubscribed || r.complained) ownSuppressionLines.push(r.email);
      if (res.cohort_corrected) promoted.push(r.email);

      if (transitioned) {
        report.eligible_to_ineligible.total++;
        if (res.duplicate_loser) report.eligible_to_ineligible.duplicata_mesma_caixa++;
        else if (res.mailbox_suppressed) report.eligible_to_ineligible.supressao_propagada++;
      }
    }

    if (losers.length > 0 && survivor) {
      report.duplicata_groups.push({
        mailbox,
        survivor,
        losers,
        tie_break_criterion: tieCriterion ?? "unico",
      });
      if (tieCriterion === "arbitrary") report.arbitrary_ties++;
    }
    if (newlySuppressed.length > 0) {
      report.supressao_groups.push({
        mailbox,
        suppressed_lines: ownSuppressionLines,
        newly_ineligible: newlySuppressed,
      });
    }
    if (promoted.length > 0) {
      report.cohort_correction.groups_corrected++;
      report.cohort_correction.rows_corrected += promoted.length;
      report.cohort_correction.details.push({ mailbox, promoted });
    }

    const distinctCohorts = new Set(groupRows.map((r) => r.cohort ?? null));
    const hasAssinante = groupRows.some((r) => r.cohort === COHORT_ASSINANTES_ATIVOS);
    if (distinctCohorts.size > 1 && !hasAssinante) {
      report.cohort_correction.diverged_unresolved.push({
        mailbox,
        cohorts: [...distinctCohorts],
      });
    }
  }

  return report;
}

const fmt = (n: number): string => n.toLocaleString("pt-BR");

function table(rows: string[], header: string): string {
  return rows.length > 0 ? rows.join("\n") : header;
}

/** Relatório markdown READ-ONLY. Contém e-mails (PII) — manter local, colar no corpo do PR pro gate do editor (#4249). */
export function renderMailboxDryrunMarkdown(r: MailboxDryrunReport): string {
  const dupRows = r.duplicata_groups.map(
    (g) => `| ${g.mailbox} | ${g.survivor} | ${g.losers.join(", ")} | ${g.tie_break_criterion} |`,
  );
  const suppRows = r.supressao_groups.map(
    (g) => `| ${g.mailbox} | ${g.suppressed_lines.join(", ")} | ${g.newly_ineligible.join(", ")} |`,
  );
  const cohortRows = r.cohort_correction.details.map(
    (g) => `| ${g.mailbox} | ${g.promoted.join(", ")} |`,
  );
  const divergedRows = r.cohort_correction.diverged_unresolved.map(
    (g) => `| ${g.mailbox} | ${g.cohorts.map((c) => c ?? "null").join(" vs ")} |`,
  );

  return `# Dry-run — coerência por caixa canônica (#4249)

READ-ONLY. Não escreve no store, não toca Brevo/Beehiiv. Usa a MESMA função
(\`resolveMailboxCoherence\`) que \`recomputeDerived\` vai usar no efeito real —
o número abaixo é exatamente o que vai acontecer no PRÓXIMO recompute
pós-merge (ver nota operacional no corpo do PR sobre quando esse recompute roda).

Total de linhas no store: **${fmt(r.total_rows)}**. Grupos com colisão de caixa canônica (>1 linha): **${fmt(r.groups_with_collision)}**.

## Linhas que passam de elegível → inelegível: ${fmt(r.eligible_to_ineligible.total)}

| causa | linhas |
|---|---:|
| duplicata-mesma-caixa | ${fmt(r.eligible_to_ineligible.duplicata_mesma_caixa)} |
| supressao-propagada | ${fmt(r.eligible_to_ineligible.supressao_propagada)} |

> \`cohort-corrigido\` (seção própria abaixo) **não** entra nesta contagem por si só — promover uma linha pra \`assinantes-ativos\` só AUMENTA elegibilidade (isenção de MV, #3819), nunca reduz. Mas repare: numa dupla SEM supressão, a promoção deixa as 2 linhas elegíveis ao mesmo tempo — o que dispara o dedup (\`duplicata-mesma-caixa\`) sobre a MESMA dupla. Cohort e dedup não são independentes num grupo de 2; a transição em si é sempre atribuída à causa que de fato reduz elegibilidade (dedup ou supressão), nunca à correção de cohort.

## Duplicata na mesma caixa (${fmt(r.duplicata_groups.length)} grupos, ${fmt(r.eligible_to_ineligible.duplicata_mesma_caixa)} linhas perdedoras)

| caixa | sobrevive | perde | critério de desempate |
|---|---|---|---|
${table(dupRows, "| (nenhum) | | | |")}

⚠️ **${fmt(r.arbitrary_ties)} caixas empataram em TODOS os critérios** (priority_points, opens_count, sends_count, created) — desempate final por ordem alfabética do e-mail, arbitrário de fato. Revisar antes de confiar no critério "created mais recente" nesses casos.

## Supressão propagada (${fmt(r.supressao_groups.length)} grupos, ${fmt(r.eligible_to_ineligible.supressao_propagada)} linhas)

| caixa | linha(s) com sinal próprio (blacklist/unsub/complaint) | linha(s) irmã que vira(m) inelegível |
|---|---|---|
${table(suppRows, "| (nenhum) | | |")}

## Cohort corrigido — assinantes-ativos promovido (${fmt(r.cohort_correction.groups_corrected)} grupos, ${fmt(r.cohort_correction.rows_corrected)} linhas)

| caixa | linha(s) promovida(s) pra assinantes-ativos |
|---|---|
${table(cohortRows, "| (nenhum) | |")}

## Cohort divergente SEM assinantes-ativos pra resolver (${fmt(r.cohort_correction.diverged_unresolved.length)} grupos) — NÃO corrigido automaticamente, só sinalizado

| caixa | cohorts em conflito |
|---|---|
${table(divergedRows, "| (nenhum) | |")}
`;
}
