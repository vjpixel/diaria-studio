/**
 * clarice-waves-dryrun.ts — comparação READ-ONLY entre o método ATUAL de montar
 * waves e o modelo STORE-DRIVEN (#2656 cutover), pro editor validar antes do
 * cutover. NÃO dispara, NÃO faz fetch ao vivo — usa os dados do Brevo já
 * sincronizados no store (#2647).
 *
 * ⚠️ LIMITES DO MODELO (importante pra uma decisão de alto blast-radius):
 *  - Compara a SUPRESSÃO/ELEGIBILIDADE do universo, NÃO a seleção de cohort por
 *    ciclo. O pipeline atual (clarice-build-waves) envia, por ciclo, só T1
 *    (ativos) + T2 (ex-assinantes MV-verified) — ~milhares —, não a base toda.
 *    O cutover "swap total" passa a segmentar a BASE INTEIRA. São estratégias
 *    diferentes; aqui medimos quem é elegível/suprimido, não o tamanho da wave.
 *  - "Não está no Brevo" é o estado NORMAL: o editor só importa o cohort pro
 *    Brevo na hora de AGENDAR o envio. Logo `eligible_not_in_brevo` é
 *    informativo, NÃO regressão — quebrado por tier só pra sanity-check (ex:
 *    algum T1 ativo faltando seria curioso, já que ativos costumam estar no
 *    Brevo de envios passados). O guard `notFound` do `classifyT1` cobre T1.
 *  - O filtro MV do pipeline é por-tier (só T2); aqui é tratado universalmente.
 *
 * Modelos de supressão comparados:
 *  - blast (ingênuo): exclui só `email_blacklisted`.
 *  - pipeline atual (fiel à supressão): blacklist + mv_rejected + dispute.
 *  - store: `send_eligible=0` (consolida tudo acima + soft-bounce/complaint/list-unsub).
 */

import { segmentFromStore } from "./clarice-segment.ts";

export interface DryrunRow {
  email: string;
  tier: number | null;
  priority_points: number;
  send_eligible: number; // 0 | 1
  ineligible_reason: string | null;
  sends_count: number;
  opens_count: number;
  email_blacklisted: number; // 0 | 1
  in_brevo: number; // 0 | 1 — tem registro no Brevo (brevo_list_ids não-nulo)
}

export interface DivergenceBlock {
  newly_suppressed: number;
  newly_suppressed_by_reason: Record<string, number>;
  newly_sent: number;
  sample_newly_suppressed: Array<{ email: string; reason: string }>;
}

export interface DryrunReport {
  total: number;
  blast: { send_pool: number; suppressed: number };
  current_pipeline: { send_pool: number; suppressed: number };
  store: {
    eligible: number;
    ineligible: number;
    ineligible_by_reason: Record<string, number>;
    /** unsubscribed dividido: já-blacklisted (pipeline pega) vs só-lista (novo). */
    unsubscribed_blacklist: number;
    unsubscribed_lista: number;
    re_send: number; // via segmentFromStore (a MESMA lógica do cutover)
    first_send: number;
    /** elegível mas ainda NÃO no Brevo (importado no agendamento — estado normal). */
    eligible_not_in_brevo: number;
    /** o mesmo, por tier — sanity-check (T1 ativo faltando seria curioso). */
    eligible_not_in_brevo_by_tier: Record<string, number>;
  };
  divergence: {
    vs_blast: DivergenceBlock;
    vs_pipeline: DivergenceBlock;
  };
  warnings: {
    /** email_blacklisted=1 mas send_eligible=1 → recomputeDerived não rodou (dado stale). */
    stale_derived: number;
  };
}

function inc(map: Record<string, number>, k: string): void {
  map[k] = (map[k] ?? 0) + 1;
}

function emptyDiv(): DivergenceBlock {
  return {
    newly_suppressed: 0,
    newly_suppressed_by_reason: {},
    newly_sent: 0,
    sample_newly_suppressed: [],
  };
}

/** Razões que o pipeline ATUAL real já filtra a montante (além de blacklist).
 *  mv_unverified (histórico, #2656 → revertido em #2804): o store não atribui
 *  mais essa razão (contato nunca-verificado voltou a ser elegível em
 *  qualquer tier), mas o literal fica aqui pra não quebrar a comparação sobre
 *  um DB antigo/não-rebuildado que ainda carregue a razão de antes do
 *  reversal — nesse caso o pipeline atual (que só trabalha a partir de
 *  `*-verified.csv`, curados via verify-emails-mv.ts) também já filtrava esse
 *  cohort a montante, então não deve contar como "newly_suppressed" novo. */
const PIPELINE_FILTERED_REASONS = new Set(["mv_rejected", "dispute", "mv_unverified"]);

export function computeWavesDryrun(
  rows: DryrunRow[],
  sampleSize = 20,
): DryrunReport {
  // Segmentação do store via a MESMA função que o cutover usará (fidelidade).
  const seg = segmentFromStore(rows);

  const r: DryrunReport = {
    total: rows.length,
    blast: { send_pool: 0, suppressed: 0 },
    current_pipeline: { send_pool: 0, suppressed: 0 },
    store: {
      eligible: seg.reSend.length + seg.firstSend.length,
      ineligible: seg.excluded.length,
      ineligible_by_reason: {},
      unsubscribed_blacklist: 0,
      unsubscribed_lista: 0,
      re_send: seg.reSend.length,
      first_send: seg.firstSend.length,
      eligible_not_in_brevo: 0,
      eligible_not_in_brevo_by_tier: {},
    },
    divergence: { vs_blast: emptyDiv(), vs_pipeline: emptyDiv() },
    warnings: { stale_derived: 0 },
  };

  const tally = (
    div: DivergenceBlock,
    baselineSends: boolean,
    storeSends: boolean,
    row: DryrunRow,
  ): void => {
    if (baselineSends && !storeSends) {
      div.newly_suppressed++;
      const reason = row.ineligible_reason ?? "unknown";
      inc(div.newly_suppressed_by_reason, reason);
      if (div.sample_newly_suppressed.length < sampleSize) {
        div.sample_newly_suppressed.push({ email: row.email, reason });
      }
    } else if (!baselineSends && storeSends) {
      div.newly_sent++;
    }
  };

  for (const row of rows) {
    const reason = row.ineligible_reason ?? "";
    const blastSends = !row.email_blacklisted;
    const pipelineSends =
      !row.email_blacklisted && !PIPELINE_FILTERED_REASONS.has(reason);
    const storeSends = row.send_eligible === 1;

    if (blastSends) r.blast.send_pool++;
    else r.blast.suppressed++;
    if (pipelineSends) r.current_pipeline.send_pool++;
    else r.current_pipeline.suppressed++;

    if (storeSends) {
      if (!row.in_brevo) {
        r.store.eligible_not_in_brevo++;
        inc(r.store.eligible_not_in_brevo_by_tier, row.tier == null ? "null" : `T${String(row.tier).padStart(2, "0")}`);
      }
      if (row.email_blacklisted) r.warnings.stale_derived++; // blacklisted mas elegível → stale
    } else {
      inc(r.store.ineligible_by_reason, row.ineligible_reason ?? "unknown");
      if (reason === "unsubscribed") {
        if (row.email_blacklisted) r.store.unsubscribed_blacklist++;
        else r.store.unsubscribed_lista++;
      }
    }

    tally(r.divergence.vs_blast, blastSends, storeSends, row);
    tally(r.divergence.vs_pipeline, pipelineSends, storeSends, row);
  }

  return r;
}

const fmt = (n: number): string => n.toLocaleString("pt-BR");

function reasonTable(map: Record<string, number>): string {
  const rows = Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `| ${k} | ${fmt(v)} |`)
    .join("\n");
  return rows || "| (nenhum) | 0 |";
}

/** Relatório markdown READ-ONLY. Contém amostra com emails (PII) — manter local. */
export function renderDryrunMarkdown(r: DryrunReport): string {
  const vp = r.divergence.vs_pipeline;
  const vb = r.divergence.vs_blast;
  const staleNote =
    r.warnings.stale_derived > 0
      ? `\n> ⚠️ **${fmt(r.warnings.stale_derived)} linhas com email_blacklisted=1 mas send_eligible=1** — derivados stale (rode \`clarice-build-db\`/\`sync-brevo\` que recomputam) antes de confiar nos números.\n`
      : "";
  return `# Dry-run cutover de waves (#2656) — atual vs store
${staleNote}
> READ-ONLY. NÃO dispara, NÃO faz fetch. Usa o Brevo já no store (#2647). Total: **${fmt(r.total)}**.
>
> ⚠️ **Limites do modelo:** compara SUPRESSÃO/elegibilidade do universo, NÃO a
> seleção de cohort por ciclo. O pipeline atual envia só T1+T2 (~milhares/ciclo);
> o cutover "swap total" segmenta a base inteira. Aqui medimos quem é elegível,
> não o tamanho da wave.

## Pool elegível (supressão) — 3 visões
| | envia | corta |
|---|---:|---:|
| blast (blacklist-only) | ${fmt(r.blast.send_pool)} | ${fmt(r.blast.suppressed)} |
| pipeline atual (blacklist+mv_rejected+dispute) | ${fmt(r.current_pipeline.send_pool)} | ${fmt(r.current_pipeline.suppressed)} |
| modelo store (send_eligible) | ${fmt(r.store.eligible)} | ${fmt(r.store.ineligible)} |

Segmentação do store (via \`segmentFromStore\`, a mesma do cutover): **${fmt(r.store.re_send)}** re-envio · **${fmt(r.store.first_send)}** 1º envio.

## ℹ️ Elegíveis ainda NÃO no Brevo: **${fmt(r.store.eligible_not_in_brevo)}** (estado normal)
O editor só importa o cohort pro Brevo no AGENDAMENTO do envio — então não-estar-no-Brevo é o default esperado, NÃO uma regressão. Quebra por tier abaixo só pra sanity-check (T1 ativo faltando seria curioso — ativos costumam estar no Brevo de envios passados):

| tier | não-no-Brevo |
|---|---:|
${reasonTable(r.store.eligible_not_in_brevo_by_tier)}

## Divergência de SUPRESSÃO vs pipeline atual
- supressão genuinamente nova (pipeline envia, store corta): **${fmt(vp.newly_suppressed)}** — ex: unsub via lista não-blacklisted (${fmt(r.store.unsubscribed_lista)}), soft-bounce, complaint.
- regressão de supressão (store envia, pipeline corta): **${fmt(vp.newly_sent)}** (esperado 0 nesta dimensão; o status-desconhecido acima é tratado à parte).

| razão (nova supressão) | contatos |
|---|---:|
${reasonTable(vp.newly_suppressed_by_reason)}

## Inelegíveis no store, por razão
| razão | contatos |
|---|---:|
${reasonTable(r.store.ineligible_by_reason)}

> unsubscribed = ${fmt(r.store.unsubscribed_blacklist)} já-blacklisted (pipeline já pega) + ${fmt(r.store.unsubscribed_lista)} só-lista (supressão nova do store).

## Referência: vs blast ingênuo (sobrestima — inclui mv/dispute que o pipeline já corta)
**${fmt(vb.newly_suppressed)}** a mais que um blast cru:

| razão | contatos |
|---|---:|
${reasonTable(vb.newly_suppressed_by_reason)}

## Amostra p/ spot-check (local — contém emails/PII) — nova supressão vs pipeline
${vp.sample_newly_suppressed.map((s) => `- ${s.email} → ${s.reason}`).join("\n") || "- (nenhuma)"}
`;
}
