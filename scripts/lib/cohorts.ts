/**
 * cohorts.ts — taxonomia canônica de cohorts (#2857, fase A).
 *
 * Unifica as duas dimensões paralelas que o store carregava até aqui
 * (`tier` numérico T01–T10 + `cohort` de safra mensal 'YYYY-MM', #2817) numa
 * única taxonomia de identificadores NOMEADOS: `assinantes-ativos`,
 * `ex-assinantes`, `leads-{período}` (semestral/range legado OU safra mensal
 * `leads-YYYY-MM`), `leads-caudao`. Pedido do editor 260702 (issue #2857):
 * "T04" não diz nada, "leads-2025h2" diz tudo.
 *
 * FASE A (esta): dupla-escrita. `tier` INTEGER continua populado e
 * AUTORITATIVO — nenhum consumidor de envio (segmentFromStore/tierRank) lê
 * daqui ainda. A coluna `cohort` do store passa a guardar o slug (não mais só
 * a safra crua) — ver `recomputeDerived` em `clarice-db.ts`. Fase B troca os
 * consumidores pra ler cohort; fase C remove `tier`.
 *
 * Dependency-free / Workers-safe (como `clarice-segment.ts`) — o worker
 * `brevo-dashboard` importa daqui diretamente, sem `node:sqlite` nem outras
 * deps de Node.
 */

// ---------------------------------------------------------------------------
// Slugs canônicos
// ---------------------------------------------------------------------------

export const COHORT_ASSINANTES_ATIVOS = "assinantes-ativos";
export const COHORT_EX_ASSINANTES = "ex-assinantes";
export const COHORT_LEADS_CAUDAO = "leads-caudao";

/**
 * tier numérico (T01–T10) → slug de cohort nomeado.
 *
 * CONGELADO na mesma referência temporal usada pelos testes de
 * `tierLabel`/`tierFileName` em `merge-clarice-subscribers.ts` (NOW =
 * 2026-05-04T12:00:00Z, a véspera do epoch da safra #2817 — 2026-05). T4–T9
 * usam lá a matemática de SEMESTRE DESLIZANTE relativa a `now` (o rótulo
 * muda a cada virada de semestre); aqui ficam ESTÁTICOS de propósito — a
 * partir da fase A, um cohort nomeado é um identificador FIXO, não um rótulo
 * vivo que muda sozinho (isso reintroduziria a opacidade que a #2857 existe
 * pra eliminar — um "leads-2025h2" que silenciosamente vira "leads-2026h1"
 * seis meses depois seria pior que T04).
 *
 * Consequência do freeze: contatos com `created` ANTES do epoch da safra
 * (2026-05) são classificados por este mapa fixo pra sempre — a classe deles
 * não muda mais. Contatos com `created` A PARTIR do epoch não passam mais por
 * tier: entram direto como `leads-YYYY-MM` via `cohortFromSafra` (ver
 * `recomputeDerived`). T3–T9 e o caudão (T10) são, portanto, efetivamente
 * legado: só existem pra classificar a base pré-epoch.
 *
 * T3 é o único slug "range" (não segue o padrão semestral H1/H2) porque, no
 * momento em que esta taxonomia foi congelada, T3 (semestre corrente,
 * 2026-H1) estava PARCIAL por causa do corte do export — só ia até abril —
 * então herdou o nome descritivo real do arquivo já gerado pelo pipeline
 * (`tierFileName`, ver `merge-clarice-subscribers.ts`) em vez do nome
 * semestral "cheio".
 */
export const TIER_TO_COHORT: Record<number, string> = {
  1: COHORT_ASSINANTES_ATIVOS,
  2: COHORT_EX_ASSINANTES,
  3: "leads-2026-jan-abr",
  4: "leads-2025h2",
  5: "leads-2025h1",
  6: "leads-2024h2",
  7: "leads-2024h1",
  8: "leads-2023h2",
  9: "leads-2023h1",
  10: COHORT_LEADS_CAUDAO,
};

/** tier numérico → slug de cohort. `null`/`undefined`/tier desconhecido → `null`. */
export function cohortFromTier(tier: number | null | undefined): string | null {
  if (tier == null) return null;
  return TIER_TO_COHORT[tier] ?? null;
}

/**
 * safra mensal na forma canônica 'YYYY-MM' (saída de `deriveCohort`, ver
 * `clarice-segment.ts`) → slug de cohort 'leads-YYYY-MM'. Não valida o
 * formato do input — quem chama já garantiu a forma canônica.
 */
export function cohortFromSafra(safra: string): string {
  return `leads-${safra}`;
}

// ---------------------------------------------------------------------------
// cohortSendRank — ordem de 1º envio, TOTAL e explícita (#2857)
// ---------------------------------------------------------------------------
//
// Ordem (mais morno → mais frio → fim):
//   assinantes-ativos < ex-assinantes
//     < leads por RECÊNCIA DECRESCENTE do início do período
//       (safras mensais 'leads-YYYY-MM' mais novas primeiro, intercaladas
//        corretamente com os buckets semestrais/range legados pela data de
//        INÍCIO do período — ex: leads-2026-06 > leads-2026-jan-abr >
//        leads-2025h2, porque jun/2026 > jan/2026 > jul/2025)
//   < leads-caudao
//   < desconhecido/null (fim — nunca deveria "furar" a fila de propósito)
//
// Propriedade obrigatória (testada): pros 10 cohorts derivados de tier
// (TIER_TO_COHORT), a ordem relativa de cohortSendRank é IDÊNTICA à de
// tierRank (clarice-segment.ts) — a fase A NÃO muda a ordem efetiva de envio,
// só o nome do identificador.
// ---------------------------------------------------------------------------

/** Início do período (ISO date, UTC) dos cohorts legados (semestre/range fixo). */
const LEGACY_LEAD_PERIOD_START: Record<string, string> = {
  "leads-2026-jan-abr": "2026-01-01",
  "leads-2025h2": "2025-07-01",
  "leads-2025h1": "2025-01-01",
  "leads-2024h2": "2024-07-01",
  "leads-2024h1": "2024-01-01",
  "leads-2023h2": "2023-07-01",
  "leads-2023h1": "2023-01-01",
};

/** Casa 'leads-YYYY-MM' (safra mensal, forma canônica de `cohortFromSafra`). */
const MONTHLY_SAFRA_RE = /^leads-(\d{4})-(\d{2})$/;

/** Todos os slugs derivados de tier (`TIER_TO_COHORT`) — usado por `isKnownCohortSlug`. */
const KNOWN_TIER_COHORT_SLUGS = new Set<string>(Object.values(TIER_TO_COHORT));

/**
 * `slug` é um cohort reconhecido pela taxonomia (#2857 fase B — CLIs aceitam o
 * slug canônico diretamente em `--cohort`, além dos aliases pt-BR/legado/tier,
 * ver `resolveCohortArg` em `clarice-segment.ts`)? Cobre os 10 slugs derivados
 * de tier (`TIER_TO_COHORT` — inclui os 3 nomes fixos + os 7 semestrais/range
 * legados) + qualquer safra mensal `leads-YYYY-MM` (mesmo `MONTHLY_SAFRA_RE`
 * de `leadPeriodStartMs` abaixo — sem lista hardcoded de meses futuros, mesmo
 * padrão de `cohortSendRank`/`cohortDisplayLabel`).
 */
export function isKnownCohortSlug(slug: string): boolean {
  return KNOWN_TIER_COHORT_SLUGS.has(slug) || MONTHLY_SAFRA_RE.test(slug);
}

/**
 * Início do período (epoch ms, UTC) de um cohort "leads-*" reconhecido.
 * `null` se não for um cohort de lead reconhecido (assinantes/ex-assinantes/
 * caudão/desconhecido — tratados fora desta função, ver `cohortSendRank`).
 */
function leadPeriodStartMs(cohort: string): number | null {
  const monthly = cohort.match(MONTHLY_SAFRA_RE);
  if (monthly) {
    return Date.UTC(Number(monthly[1]), Number(monthly[2]) - 1, 1);
  }
  const iso = LEGACY_LEAD_PERIOD_START[cohort];
  return iso ? Date.parse(`${iso}T00:00:00Z`) : null;
}

const RANK_ASSINANTES_ATIVOS = 0;
const RANK_EX_ASSINANTES = 1;

// Referência bem no futuro: `FUTURE_REFERENCE_MS - periodStartMs` cresce à
// medida que o período fica mais antigo → rank crescente (= prioridade
// menor) pra leads mais frios, sem nunca ficar negativo pra nenhuma data real
// (ano 9999 dá margem de ~7900 anos sobre qualquer `created` plausível).
const FUTURE_REFERENCE_MS = Date.UTC(9999, 0, 1);

// leads-caudao e desconhecido/null ficam ACIMA de qualquer rank de lead
// calculado (que na prática fica na casa de ~10^14 — ver FUTURE_REFERENCE_MS
// acima), com folga enorme sobre MAX_SAFE_INTEGER (~9×10^15).
const RANK_LEADS_CAUDAO = Number.MAX_SAFE_INTEGER - 2;
const RANK_UNKNOWN = Number.MAX_SAFE_INTEGER - 1;

/**
 * Ordem de 1º envio de um cohort — número menor = envia mais cedo (mais
 * morno). Total e determinística: cobre os 10 cohorts derivados de tier, toda
 * safra mensal futura (`leads-YYYY-MM`, sem lista hardcoded de meses), e o
 * fallback `null`/desconhecido (sempre por último).
 */
export function cohortSendRank(cohort: string | null | undefined): number {
  if (cohort === COHORT_ASSINANTES_ATIVOS) return RANK_ASSINANTES_ATIVOS;
  if (cohort === COHORT_EX_ASSINANTES) return RANK_EX_ASSINANTES;
  if (cohort === COHORT_LEADS_CAUDAO) return RANK_LEADS_CAUDAO;
  if (cohort != null) {
    const ms = leadPeriodStartMs(cohort);
    if (ms != null) return 2 + (FUTURE_REFERENCE_MS - ms);
  }
  return RANK_UNKNOWN;
}

// ---------------------------------------------------------------------------
// cohortDisplayLabel — rótulo pt-BR pro dashboard
// ---------------------------------------------------------------------------

const PT_MONTHS_ABBR = [
  "jan", "fev", "mar", "abr", "mai", "jun",
  "jul", "ago", "set", "out", "nov", "dez",
];

const SEMESTER_RE = /^leads-(\d{4})h([12])$/;
const RANGE_RE = /^leads-(\d{4})-([a-z]{3})-([a-z]{3})$/;
// Legado pré-fase-A: coluna guardava a safra crua 'YYYY-MM' (sem prefixo
// `leads-`) — aceito aqui defensivamente (nunca lança) caso algum snapshot
// (KV cacheado, fixture não migrada) ainda carregue a forma antiga.
const BARE_SAFRA_RE = /^(\d{4})-(\d{2})$/;

/**
 * Slug de cohort → rótulo pt-BR pro dashboard (ex: 'assinantes-ativos' →
 * 'Assinantes ativos', 'leads-2026-06' → 'Leads jun/2026'). `null` → 'sem
 * cohort'. Forma desconhecida/corrompida devolve a chave crua — nunca lança
 * (render do dashboard não pode quebrar por um valor malformado no KV).
 */
export function cohortDisplayLabel(cohort: string | null | undefined): string {
  if (cohort == null) return "sem cohort";
  if (cohort === COHORT_ASSINANTES_ATIVOS) return "Assinantes ativos";
  if (cohort === COHORT_EX_ASSINANTES) return "Ex-assinantes";
  if (cohort === COHORT_LEADS_CAUDAO) return "Leads (caudão)";

  const monthly = cohort.match(MONTHLY_SAFRA_RE) ?? cohort.match(BARE_SAFRA_RE);
  if (monthly) {
    const month = Number(monthly[2]);
    const mon = PT_MONTHS_ABBR[month - 1];
    if (mon) return `Leads ${mon}/${monthly[1]}`;
  }

  const semester = cohort.match(SEMESTER_RE);
  if (semester) return `Leads ${semester[1]}-H${semester[2]}`;

  const range = cohort.match(RANGE_RE);
  if (range) return `Leads ${range[2]}-${range[3]}/${range[1]}`;

  return cohort;
}
