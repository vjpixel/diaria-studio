/**
 * dashboard-kv-types.ts — tipos dos payloads KV compartilhados entre os
 * scripts que os PRODUZEM (`clarice-engagement-cohorts.ts`, `clarice-mv-status.ts`,
 * `clarice-db-summary.ts`) e o worker `brevo-dashboard` que os CONSOME (#3081).
 *
 * Antes cada um desses 4 tipos (`EngagementCohorts`, `MvGroupStatus`, `MvStatus`,
 * `ContactsSummary`, `CohortStatsRow`) era declarado DUAS vezes — uma no script
 * que grava o KV, outra em `workers/brevo-dashboard/src/types.ts` que lê —
 * sincronizadas manualmente via comentário "MANTER EM SINCRONIA". Fonte única
 * aqui elimina o drift silencioso.
 *
 * Dependency-free / Workers-safe (como `clarice-segment.ts`/`cohorts.ts`) —
 * nenhum import de `node:sqlite` ou outra API só-Node, então tanto os scripts
 * quanto o worker (runtime `workerd`, sem Node) podem importar daqui.
 */

/**
 * #2426: coortes de engajamento por contato. Pré-computadas por
 * `scripts/clarice-engagement-cohorts.ts` (que faz os ~40k GETs per-contato
 * fora do Worker) e gravadas no KV sob `cohorts:engagement`. O Worker só lê e
 * renderiza — nunca recomputa no render. As 5 coortes são mutuamente exclusivas
 * (cada contato em exatamente uma); "saídas" (bounce/unsub) têm precedência.
 */
export interface EngagementCohorts {
  /** ISO timestamp da geração (dado é pré-computado, não live) */
  generatedAt: string;
  /** total de pessoas únicas alcançadas (recebeu ≥1 OU teve saída) — cada contato conta 1× (≠ eventos de envio) */
  universe: number;
  /** abriu 2+ e-mails (sem saída) */
  opened2plus: number;
  /** abriu exatamente 1 e-mail (sem saída) */
  opened1: number;
  /** recebeu 1, não abriu nenhum (sem saída) */
  received1_opened0: number;
  /** recebeu 2+, não abriu nenhum (sem saída) */
  received2_opened0: number;
  /** saídas: bounce OU descadastro (precedência sobre tudo) */
  exits: number;
  /** breakdown DISJUNTO das saídas (bounced + optedOut = exits) */
  exitsBreakdown: { bounced: number; optedOut: number };
  /**
   * maior nº de e-mails recebidos por um único contato (valida o rótulo "2+").
   * #3081: DEAD CODE de exibição — nenhum render do worker consome este campo
   * (o rótulo "2+" nos buckets ≥2 é hardcoded, sempre exato por definição).
   * Mantido no payload por ora — não remover nem adicionar exibição sem pedido
   * do editor (decisão de produto, fora de escopo do #3081).
   */
  maxReceived: number;
}

// #2609: status MillionVerifier por grupo de contatos, gravado por
// scripts/clarice-mv-status.ts sob a chave KV `mv:status`.
export interface MvGroupStatus {
  /** Identificador do grupo (ex: "t01-assinantes-ativos", "t02-ex-assinantes"). */
  group: string;
  /** Ciclo em que a verificação foi feita (ex: "2605-06"). */
  cycle: string;
  /** "verified" = tem mv-export-*-verified.csv; "t01" = N/A por pagamento Stripe; "pending" = sem arquivo. */
  status: "verified" | "t01" | "pending";
  /** ISO date do mtime do arquivo verified.csv (ou null). */
  verifiedAt: string | null;
  verified: number;
  rejected: number;
  unknown: number;
}

export interface MvStatus {
  generatedAt: string;
  groups: MvGroupStatus[];
}

/**
 * #2864: 1 linha agregada por cohort pra aba "Cohorts" do dashboard. Contagens
 * BRUTAS (não percentuais) — o render calcula as taxas (opened/received,
 * clicked/received, etc.) e trata denominador 0 como "—", nunca NaN/Infinity.
 *
 * Gravada por `scripts/clarice-db-summary.ts` (sempre populada — `computeCohortStats`
 * faz `SUM(CASE ...)` sobre todo o universo, nunca omite campo); consumida pelo
 * worker, que precisa tolerar payloads KV mais antigos sem os campos opcionais.
 */
export interface CohortStatsRow {
  /** COUNT(*) do cohort (menos internos). */
  contacts: number;
  /** send_eligible=1. */
  eligible: number;
  /** sends_count>0 — "já recebeu ao menos 1 envio". */
  received: number;
  /** #2909: last_sent_at >= cycle_start — recebeu no CICLO corrente. Opcional
   * (`?`): KV pré-#2909 não tem o campo — render degrada pra 0 (e só o usa
   * quando `ContactsSummary.cycle_start` está presente). */
  received_this_cycle?: number;
  /** sends_count>0 AND opens_count>0 — abriu ≥1, dentre quem recebeu. */
  opened: number;
  /** sends_count>0 AND clicks_count>0 — clicou ≥1, dentre quem recebeu. */
  clicked: number;
  /** #2880: separados a pedido do editor (antes: par unsub_bounce). */
  unsub: number;
  /** sends_count>0 AND hard_bounced=1 — deu hard bounce, dentre quem recebeu. */
  hard_bounce: number;
  /** #2880: brevo_list_ids IS NOT NULL sobre o total do cohort. Opcional (`?`)
   * pra degradar em KV antigo sem o campo — render trata ausência como 0. */
  brevo?: number;
}

/**
 * #2653: sumário agregado do store único de contatos (#2647), gravado por
 * `scripts/clarice-db-summary.ts` sob a chave KV `contacts:summary`
 * (payload = `{generated_at, ...StoreSummary}` — `StoreSummary`, o tipo
 * usado internamente pelo script pra computar cada bloco, permanece local a
 * `clarice-db-summary.ts`; suas propriedades sempre populadas satisfazem
 * estruturalmente os campos opcionais aqui).
 *
 * Campos opcionais (`?`) refletem SCHEMA EVOLUTION — payload gravado antes do
 * campo existir simplesmente não o tem; o render degrada graciosamente
 * (nunca confundir "ausente" com "zero").
 */
export interface ContactsSummary {
  generated_at: string;
  total: number;
  // #2909: início do ciclo de envio corrente, ou null se não há ciclo com
  // plano legível. A tabela Cohorts usa isto pra decidir se exibe "recebeu
  // neste ciclo"/"falta enviar" (número) ou "—" (sem ciclo).
  cycle_start?: string | null;
  brevo: { synced_rows: number; has_signal: boolean };
  eligibility: {
    eligible: number;
    ineligible: number;
    by_reason: Record<string, number>;
  };
  priority_points: {
    lt0: number;
    eq0: number;
    p1_40: number;
    p41_80: number;
    gt80: number;
    optin: number;
    // #3081: quantos emails internos (INTERNAL_EMAILS) foram EXCLUÍDOS deste
    // bloco + do histograma (script `clarice-db-summary.ts`, calculado desde
    // #2809 mas nunca propagado até aqui). Opcional — KV pré-#3081 não tem o
    // campo; render trata ausência como "—" (não 0 — 0 excluídos e "dado
    // ausente" não são a mesma coisa).
    internal_excluded?: number;
  };
  // #2731: distribuição por valor exato (opcional — KV pré-#2731 não tem).
  priority_points_histogram?: Record<string, number>;
  // 260702: coluna "verified" (mv_bucket='verified') por valor exato (opcional
  // — KV antigo não tem; render degrada sem coluna).
  priority_points_histogram_verified?: Record<string, number>;
  // #2880: coluna "elegíveis" (send_eligible=1) do histograma — par opcional,
  // degrade gracioso (KV antigo sem o campo → sem a coluna).
  priority_points_histogram_eligible?: Record<string, number>;
  // #2865: coluna "Brevo" (brevo_list_ids IS NOT NULL) do histograma — par
  // opcional, degrade gracioso (KV antigo sem o campo → sem a coluna).
  priority_points_histogram_brevo?: Record<string, number>;
  // #2864: comparativo de envio/engajamento por cohort. Opcional — KV antigo
  // sem o campo faz a aba renderizar o stub "dados ainda não gerados".
  cohort_stats?: Record<string, CohortStatsRow>;
  mv: Record<string, number>;
  engagement: { with_opens: number; with_clicks: number };
}
