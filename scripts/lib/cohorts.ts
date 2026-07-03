/**
 * cohorts.ts — taxonomia canônica de cohorts (#2857).
 *
 * Unifica as duas dimensões paralelas que o store carregava até aqui
 * (`tier` numérico T01–T10 + `cohort` de safra mensal 'YYYY-MM', #2817) numa
 * única taxonomia de identificadores NOMEADOS: `assinantes-ativos`,
 * `ex-assinantes`, `leads-{período}` (semestral/range legado OU safra mensal
 * `leads-YYYY-MM`), `leads-caudao`. Pedido do editor 260702 (issue #2857):
 * "T04" não diz nada, "leads-2025h2" diz tudo.
 *
 * FASE A: dupla-escrita. `tier` INTEGER continua populado (fase C remove).
 * FASE B: consumidores de envio (segmentFromStore/cohortSendRank) passam a
 * ler `cohort` em vez de `tier`.
 * FASE B.1 (esta, correção pós dry-run no store real): 2 problemas achados —
 * (1) pagante (tier 1/2) com `created` recente virava lead (`leads-YYYY-MM`),
 * rebaixado da fila quente; (2) o mapa `TIER_TO_COHORT` (congelado no momento
 * do freeze da fase A) atribuía rótulo de PERÍODO a leads pré-epoch com base
 * no tier residual do merge, que desalinha do `created` real a cada virada de
 * semestre (ex: bucket rotulado 'leads-2025h2' continha `created`
 * jan-abr/2026). Fix, ver `computeCohort` em `clarice-db.ts` e
 * `deriveLeadCohort` em `clarice-segment.ts`: pagante (tier 1/2) NUNCA vira
 * lead (cohort fixo, `created` irrelevante); lead deriva o cohort do PERÍODO
 * REAL do próprio `created` (mensal `leads-YYYY-MM` ≥ epoch da safra, senão
 * semestre real `leads-YYYYhN`) — `TIER_TO_COHORT` deste arquivo vira
 * FALLBACK, usado só quando `created` está ausente/inválido (rótulo pode não
 * refletir o período real nesse caso raro, documentado onde é consumido).
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

// ---------------------------------------------------------------------------
// Emails internos (#2809) — editor + parceiro Clarice. Abrem/testam envios
// por ofício; o engajamento deles não é sinal de audiência. Movido pra cá
// (fonte única, #2885) porque tanto `clarice-db.ts` (agregações de exibição)
// quanto `clarice-segment.ts` (predicados de grupo nomeado — `engajados`/
// `reativacao` excluem internos, ver `segmentFromStore`) precisam do mesmo
// literal, e `clarice-segment.ts` é dependency-free/Workers-safe (não pode
// importar de `clarice-db.ts`, que usa `node:sqlite` — e `clarice-db.ts` já
// importa DESTE arquivo, então o inverso criaria um ciclo). `clarice-db.ts`
// re-exporta este símbolo (`export { INTERNAL_EMAILS } from "./cohorts.ts"`)
// pra manter os imports existentes (`clarice-db-summary.ts`) intocados.
// ---------------------------------------------------------------------------

export const INTERNAL_EMAILS = [
  "vjpixel@gmail.com",
  "pixel@memelab.com.br",
  "felipe@clarice.ai",
  // #2880: endereço da equipe Clarice (sem registro Stripe → aparecia como a
  // única linha "sem cohort"). Mesmo tratamento dos demais internos: excluído
  // das agregações de exibição (priority_points, cohort_stats), mas segue no
  // store e na fila de envio.
  "ti@clarice.ai",
] as const;

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
 * USO (#2857 fase B.1 — mudou desde o freeze original): T1/T2 continuam a
 * ÚNICA fonte do cohort de pagante (`computeCohort` em `clarice-db.ts` nunca
 * deixa `created` sobrescrever isso). Pra T3–T10 (leads), este mapa NÃO é
 * mais a fonte primária do cohort — vira FALLBACK, consultado só quando
 * `created` está ausente/inválido (a fonte primária passou a ser o período
 * REAL do `created`, via `deriveLeadCohort` em `clarice-segment.ts`, que não
 * fica desatualizado a cada virada de semestre porque não é um rótulo
 * congelado). Na prática, dado que `tierOf` (`merge-clarice-subscribers.ts`)
 * SEMPRE popula `created` pra T3–T9 (só T10 pode ficar sem — "sem data →
 * fóssil"), o fallback deste mapa só é atingível de fato pra T10 com
 * `created` NULL; T3–T9 ficam como fallback defensivo pra dados
 * corrompidos/futuros que violem essa invariante.
 *
 * T3 é o único slug "range" (não segue o padrão semestral H1/H2) porque, no
 * momento em que esta taxonomia foi congelada, T3 (semestre corrente,
 * 2026-H1) estava PARCIAL por causa do corte do export — só ia até abril —
 * então herdou o nome descritivo real do arquivo já gerado pelo pipeline
 * (`tierFileName`, ver `merge-clarice-subscribers.ts`) em vez do nome
 * semestral "cheio". Desde a fase B.1, a derivação primária (`created`) NUNCA
 * emite este range — created 2026-01..04 vira 'leads-2026h1' (semestre real).
 * O slug 'leads-2026-jan-abr' continua reconhecido em `isKnownCohortSlug`/
 * `cohortDisplayLabel`/`resolveCohortArg` (legado-lido) e alcançável por este
 * fallback (T3 + created NULL, caso defensivo acima).
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

/**
 * Início do período (ISO date, UTC) do único cohort "range" legado que NÃO
 * casa com `SEMESTER_RE`/`MONTHLY_SAFRA_RE` (#2857 fase B.1 — os 6 buckets
 * semestrais fixos que viviam aqui, 'leads-2023h1'..'leads-2025h2', saíram
 * desta tabela: `leadPeriodStartMs` agora parseia QUALQUER 'leads-YYYYhN'
 * genericamente via `SEMESTER_RE`, sem lista hardcoded de anos — necessário
 * porque a derivação por período real do `created` (`deriveLeadCohort`, ver
 * clarice-segment.ts) pode emitir semestres de QUALQUER ano, não só os 3
 * anos que o freeze da fase A cobria). 'leads-2026-jan-abr' fica sozinho
 * aqui porque é um formato de RANGE (não segue o padrão hN) — legado-lido:
 * a derivação nunca mais o EMITE (ver `deriveLeadCohort`), só o fallback de
 * tier (`TIER_TO_COHORT[3]`, created ausente) ou dado antigo em KV/CSV podem
 * trazê-lo de volta.
 */
const LEGACY_LEAD_PERIOD_START: Record<string, string> = {
  "leads-2026-jan-abr": "2026-01-01",
};

/** Casa 'leads-YYYY-MM' (safra mensal, forma canônica de `cohortFromSafra`). */
const MONTHLY_SAFRA_RE = /^leads-(\d{4})-(\d{2})$/;

/**
 * Casa 'leads-YYYYhN' (semestre — N ∈ {1,2}, h1 = jan-jun, h2 = jul-dez) de
 * QUALQUER ano — usado tanto por `leadPeriodStartMs` (ranking) quanto por
 * `cohortDisplayLabel` (rótulo pt-BR) e `isKnownCohortSlug` (reconhecimento).
 * Genérico de propósito (#2857 fase B.1): `deriveLeadCohort` deriva o
 * semestre REAL do `created` de um lead, que pode ser de qualquer ano
 * passado — uma tabela fixa (como a removida `LEGACY_LEAD_PERIOD_START` de
 * antes desta fase) ficaria desatualizada pra created mais antigo que ela
 * cobria.
 */
const SEMESTER_RE = /^leads-(\d{4})h([12])$/;

/** Todos os slugs derivados de tier (`TIER_TO_COHORT`) — usado por `isKnownCohortSlug`. */
const KNOWN_TIER_COHORT_SLUGS = new Set<string>(Object.values(TIER_TO_COHORT));

/**
 * `slug` é um cohort reconhecido pela taxonomia (#2857 fase B — CLIs aceitam o
 * slug canônico diretamente em `--cohort`, além dos aliases pt-BR/legado/tier,
 * ver `resolveCohortArg` em `clarice-segment.ts`)? Cobre os 10 slugs derivados
 * de tier (`TIER_TO_COHORT` — inclui os 3 nomes fixos + os 7 semestrais/range
 * legados) + qualquer safra mensal `leads-YYYY-MM` + qualquer semestre
 * `leads-YYYYhN` (mesmos `MONTHLY_SAFRA_RE`/`SEMESTER_RE` de
 * `leadPeriodStartMs` abaixo — sem lista hardcoded de anos/meses futuros ou
 * passados, mesmo padrão de `cohortSendRank`/`cohortDisplayLabel`; #2857 fase
 * B.1 — antes só os 6 semestres congelados de `TIER_TO_COHORT` eram
 * reconhecidos, o que rejeitaria um semestre real fora desse range, ex:
 * 'leads-2019h2').
 */
export function isKnownCohortSlug(slug: string): boolean {
  return (
    KNOWN_TIER_COHORT_SLUGS.has(slug) ||
    MONTHLY_SAFRA_RE.test(slug) ||
    SEMESTER_RE.test(slug)
  );
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
  const semester = cohort.match(SEMESTER_RE);
  if (semester) {
    // h1 começa em jan (mês 0), h2 em jul (mês 6) — mesma convenção de
    // `deriveLeadCohort` (clarice-segment.ts).
    const month = semester[2] === "1" ? 0 : 6;
    return Date.UTC(Number(semester[1]), month, 1);
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

// SEMESTER_RE é compartilhado com `leadPeriodStartMs`/`isKnownCohortSlug`
// acima (declarado 1x, perto de MONTHLY_SAFRA_RE).
const RANGE_RE = /^leads-(\d{4})-([a-z]{3})-([a-z]{3})$/;
// Legado pré-fase-A: coluna guardava a safra crua 'YYYY-MM' (sem prefixo
// `leads-`) — aceito aqui defensivamente (nunca lança) caso algum snapshot
// (KV cacheado, fixture não migrada) ainda carregue a forma antiga.
const BARE_SAFRA_RE = /^(\d{4})-(\d{2})$/;

/**
 * Slug de cohort → rótulo pt-BR pro dashboard (ex: 'assinantes-ativos' →
 * 'Assinantes ativos', 'leads-2026-06' → 'jun/2026'). `null` → 'sem cohort'.
 * Forma desconhecida/corrompida devolve a chave crua — nunca lança (render do
 * dashboard não pode quebrar por um valor malformado no KV).
 *
 * #2880: o prefixo "Leads " foi removido dos rótulos de lead (pedido do editor
 * — o contexto da tabela já deixa claro que são leads); caudão vira "Caudão".
 */
export function cohortDisplayLabel(cohort: string | null | undefined): string {
  if (cohort == null) return "sem cohort";
  if (cohort === COHORT_ASSINANTES_ATIVOS) return "Assinantes ativos";
  if (cohort === COHORT_EX_ASSINANTES) return "Ex-assinantes";
  if (cohort === COHORT_LEADS_CAUDAO) return "Caudão";

  const monthly = cohort.match(MONTHLY_SAFRA_RE) ?? cohort.match(BARE_SAFRA_RE);
  if (monthly) {
    const month = Number(monthly[2]);
    const mon = PT_MONTHS_ABBR[month - 1];
    if (mon) return `${mon}/${monthly[1]}`;
  }

  const semester = cohort.match(SEMESTER_RE);
  if (semester) return `${semester[1]}-H${semester[2]}`;

  const range = cohort.match(RANGE_RE);
  if (range) return `${range[2]}-${range[3]}/${range[1]}`;

  return cohort;
}
