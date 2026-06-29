/**
 * clarice-waves-dryrun.ts — comparação READ-ONLY entre o método ATUAL de montar
 * waves e o modelo STORE-DRIVEN (#2656 cutover), pro editor validar antes do
 * cutover. NÃO dispara nada, NÃO faz fetch ao vivo — usa os dados do Brevo já
 * sincronizados no store (#2647) pra emular o método atual.
 *
 * Método atual (emulado): exclui só `email_blacklisted` (a supressão do
 * clarice-build-waves é "EXCLUI unsubscribes = emailBlacklisted de TODAS as
 * waves"); envia o resto.
 * Modelo store: corta por `send_eligible=0` (que cobre unsub-via-lista,
 * soft-bounce≥3, mv_rejected, dispute, hard-bounce, complaint — além de
 * blacklist), e segmenta re-envio por priority_points / 1º envio por tier.
 *
 * O sinal-chave de validação: **quem o método atual ENVIA mas o store CORTA**
 * (ganhos de segurança) e o inverso (regressões — esperado ~0).
 */

export interface DryrunRow {
  email: string;
  tier: number | null;
  priority_points: number;
  send_eligible: number; // 0 | 1
  ineligible_reason: string | null;
  sends_count: number;
  opens_count: number;
  email_blacklisted: number; // 0 | 1
}

export interface DivergenceBlock {
  /** Baseline ENVIA, store CORTA → supressão a mais do store. Por razão. */
  newly_suppressed: number;
  newly_suppressed_by_reason: Record<string, number>;
  /** Store ENVIA, baseline CORTA → esperado 0 (store é mais conservador). */
  newly_sent: number;
  /** Amostra (local-only) p/ spot-check do editor. */
  sample_newly_suppressed: Array<{ email: string; reason: string }>;
}

export interface DryrunReport {
  total: number;
  /** Blast ingênuo: envia a todos menos blacklisted. */
  blast: { send_pool: number; suppressed: number };
  /**
   * Pipeline ATUAL real (fiel): além de blacklisted, já exclui mv_rejected (T2
   * vem de CSV MV-verified) e dispute (no merge). Isola o que o store adiciona.
   */
  current_pipeline: { send_pool: number; suppressed: number };
  /** Modelo store: corta por send_eligible. */
  store: {
    eligible: number;
    ineligible: number;
    ineligible_by_reason: Record<string, number>;
    re_send: number; // elegível com histórico (priority_points)
    first_send: number; // elegível sem histórico (tier)
  };
  divergence: {
    /** vs blast ingênuo (sobrestima: inclui mv/dispute que o pipeline real já corta). */
    vs_blast: DivergenceBlock;
    /** vs pipeline atual real → a supressão GENUINAMENTE nova do store. */
    vs_pipeline: DivergenceBlock;
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

/** Razões que o pipeline ATUAL real já filtra a montante (além de blacklist). */
const PIPELINE_FILTERED_REASONS = new Set(["mv_rejected", "dispute"]);

export function computeWavesDryrun(
  rows: DryrunRow[],
  sampleSize = 20,
): DryrunReport {
  const r: DryrunReport = {
    total: rows.length,
    blast: { send_pool: 0, suppressed: 0 },
    current_pipeline: { send_pool: 0, suppressed: 0 },
    store: {
      eligible: 0,
      ineligible: 0,
      ineligible_by_reason: {},
      re_send: 0,
      first_send: 0,
    },
    divergence: { vs_blast: emptyDiv(), vs_pipeline: emptyDiv() },
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
      r.store.eligible++;
      if ((row.sends_count ?? 0) > 0) r.store.re_send++;
      else r.store.first_send++;
    } else {
      r.store.ineligible++;
      inc(r.store.ineligible_by_reason, row.ineligible_reason ?? "unknown");
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

/** Relatório markdown READ-ONLY (sem PII além da amostra de spot-check local). */
export function renderDryrunMarkdown(r: DryrunReport): string {
  const vp = r.divergence.vs_pipeline;
  const vb = r.divergence.vs_blast;
  return `# Dry-run cutover de waves (#2656) — atual vs store

> Comparação READ-ONLY. NÃO dispara nada, NÃO faz fetch ao vivo. Usa os dados do
> Brevo já sincronizados no store (#2647). Total: **${fmt(r.total)}** contatos.

## Pool de envio — 3 visões
| | envia | corta |
|---|---:|---:|
| **blast** (blacklist-only, ingênuo) | ${fmt(r.blast.send_pool)} | ${fmt(r.blast.suppressed)} |
| **pipeline atual** (blacklist + mv_rejected + dispute) | ${fmt(r.current_pipeline.send_pool)} | ${fmt(r.current_pipeline.suppressed)} |
| **modelo store** (send_eligible) | ${fmt(r.store.eligible)} | ${fmt(r.store.ineligible)} |

Modelo store — segmentação do pool elegível: **${fmt(r.store.re_send)}** re-envio (priority_points DESC) · **${fmt(r.store.first_send)}** 1º envio (tier ASC).

## ⚠️ Divergência vs PIPELINE ATUAL (o que REALMENTE muda)

### Supressão genuinamente nova — pipeline atual ENVIA, store CORTA: **${fmt(vp.newly_suppressed)}**
O pipeline real já exclui blacklist + mv_rejected + dispute; isto é o que SÓ o store pega (ex: descadastro via lista não-blacklisted, soft-bounce≥3, hard-bounce, complaint):

| razão | contatos |
|---|---:|
${reasonTable(vp.newly_suppressed_by_reason)}

### Regressão — store ENVIA, pipeline atual CORTA: **${fmt(vp.newly_sent)}**
(Esperado **0**. Se >0, o store estaria mandando pra quem o pipeline atual já exclui — investigar antes do cutover.)

## Referência: divergência vs BLAST ingênuo (blacklist-only)
Sobrestima (inclui mv_rejected/dispute que o pipeline atual JÁ corta a montante) — só pra dimensionar: **${fmt(vb.newly_suppressed)}** a mais que um blast cru.

| razão | contatos |
|---|---:|
${reasonTable(vb.newly_suppressed_by_reason)}

## Inelegíveis no store, por razão
| razão | contatos |
|---|---:|
${reasonTable(r.store.ineligible_by_reason)}

## Amostra p/ spot-check (local) — newly_suppressed vs pipeline
${vp.sample_newly_suppressed.map((s) => `- ${s.email} → ${s.reason}`).join("\n") || "- (nenhum — store ≈ pipeline atual na supressão)"}
`;
}
