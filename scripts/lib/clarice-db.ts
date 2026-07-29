/**
 * clarice-db.ts — store único de usuários da Clarice (#2647).
 *
 * Um SQLite local (keyed por email) que consolida os 3 papéis das fontes:
 *   - Stripe = quem é / relacionamento comercial (snapshot estático)
 *   - Brevo  = como se comporta com nossos emails (stream dinâmico)
 *   - MV      = entregabilidade (risco de bounce)
 *
 * Achado validado (`data/clarice-subscribers/monday-drive-drafts.md`): atributos
 * estáticos da base NÃO predizem abertura (score r=0,04 · recência r=0,049 ~ zero).
 * O preditor real é histórico de abertura → por isso `score`/`OPEN_PROBABILITY`
 * NÃO entram no store; a priorização de re-envio é por comportamento
 * (`priority_points`, ver `computePriorityPoints`).
 *
 * Eixos de priorização:
 *   - `tier` (T01–T10): decide QUANDO entra no primeiro envio (de status+created).
 *   - `priority_points`: prioriza re-envios por comportamento de abertura passado.
 *   - `send_eligible` + `ineligible_reason`: corte de supressão/entregabilidade.
 *
 * Usa `node:sqlite` (built-in no Node ≥22.5 / 24) — sem dependência nativa nova.
 *
 * O arquivo .db vive em `data/clarice-subscribers/` (OneDrive, gitignored como
 * todo `data/`). Builder: `scripts/clarice-build-db.ts`. Optin manual:
 * `scripts/clarice-optin.ts`.
 */

import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import type { BrevoColumns } from "./brevo-stats.ts";
import { deriveLeadCohort } from "./clarice-segment.ts";
import {
  COHORT_ASSINANTES_ATIVOS,
  COHORT_EX_ASSINANTES,
  cohortFromTier,
  isKnownCohortSlug,
  isMvExemptCohort,
  isTestAccount,
} from "./cohorts.ts";
import { canonicalizeGmail, GMAIL_DOMAINS } from "./canonicalize-gmail.ts";

// import.meta.dirname pode vir undefined em alguns loaders CJS (tsx eval / import
// deep-relative) — fallback pra cwd evita throw no load do módulo. Scripts do
// projeto rodam a partir da raiz, então ambos resolvem pra raiz do repo.
const ROOT = import.meta.dirname
  ? resolve(import.meta.dirname, "..", "..")
  : process.cwd();
export const DEFAULT_DB_PATH = resolve(
  ROOT,
  "data/clarice-subscribers/clarice-users.db",
);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * `clarice_users`: 1 linha por email (base Stripe completa, left-join Brevo/MV).
 * `priority_optin`: flag manual gerida pela CLI (`clarice-optin.ts`), separada
 *   pra sobreviver a rebuilds do store — o builder a lê via join, nunca a apaga.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS clarice_users (
  email                TEXT PRIMARY KEY,
  name                 TEXT,
  stripe_ids           TEXT,            -- JSON array

  -- Stripe (5 campos mantidos; plan/total_spend/payment_count/tag/description fora — #2647)
  status               TEXT,
  created              TEXT,            -- ISO date
  delinquent           INTEGER,         -- 0 | 1 | NULL
  dispute_losses       REAL DEFAULT 0,
  refunded_volume      REAL DEFAULT 0,

  tier                 INTEGER,         -- LEGADO read-only (#2857 fase C — cutover). 1..10 (T01-T10),
                                         -- so populado em linhas antigas (dupla-escrita da fase A ATE
                                         -- a fase C). Ingest NOVO (ingestStripe, clarice-build-db.ts)
                                         -- NAO escreve mais esta coluna -- cohort e escrito DIRETO a
                                         -- partir de merge-clarice-subscribers.ts (que tem o contexto
                                         -- Stripe completo: payment_count/total_spend, que este store
                                         -- NAO persiste). Mantido so como fallback do computeCohort
                                         -- pra linhas legadas sem cohort/created (ver recomputeDerived).
                                         -- NAO DROPAR a coluna -- dado historico auditavel.
  cohort               TEXT,            -- slug de cohort nomeado (#2857 -- ver scripts/lib/cohorts.ts).
                                         -- Fase C: escrito DIRETO por ingestStripe a partir do cohort
                                         -- ja computado por merge-clarice-subscribers.ts (contexto
                                         -- completo: status+payment_count+total_spend+created) --
                                         -- SEMPRE fresco a cada rebuild, para linhas com presenca no
                                         -- export Stripe. recomputeDerived PRESERVA um cohort ja
                                         -- reconhecido (isKnownCohortSlug) e so faz BACKFILL (via
                                         -- computeCohort, fallback legado tier+created) quando a coluna
                                         -- esta NULL ou com um valor nao-reconhecido (dado legado
                                         -- pre-fase-A ainda nao migrado). tier 1/2 -> 'assinantes-ativos'
                                         -- /'ex-assinantes' SEMPRE; lead -> periodo REAL do created
                                         -- (deriveLeadCohort); created ausente/invalido -> fallback
                                         -- cohortFromTier(tier); tier NULL + sem created -> NULL.

  -- MillionVerifier (ingestão total per-email)
  mv_result            TEXT,            -- ok | catch_all | invalid | disposable | unknown
  mv_resultcode        INTEGER,
  mv_quality           TEXT,
  mv_subresult         TEXT,
  mv_bucket            TEXT,            -- verified | rejected | unknown (derivado)
  mv_last_verified_at  TEXT,
  mv_cycle             TEXT,            -- ciclo {conteúdo}-{envio}

  -- Brevo (ingestão total per-contato)
  recency_quartil      TEXT,
  brevo_list_ids       TEXT,            -- JSON array
  opens_count          INTEGER DEFAULT 0,
  clicks_count         INTEGER DEFAULT 0,
  sends_count          INTEGER DEFAULT 0,
  soft_bounce_count    INTEGER DEFAULT 0,
  last_open_at         TEXT,
  last_click_at        TEXT,
  last_sent_at         TEXT,
  email_blacklisted    INTEGER DEFAULT 0,
  unsubscribed         INTEGER DEFAULT 0,
  hard_bounced         INTEGER DEFAULT 0,
  complained           INTEGER DEFAULT 0,
  brevo_created_at     TEXT,
  brevo_modified_at    TEXT,

  -- Priorização derivada (recomputada a cada build, ver recomputeDerived)
  priority_optin       INTEGER DEFAULT 0,
  priority_points      INTEGER DEFAULT 0,
  send_eligible        INTEGER DEFAULT 1,
  ineligible_reason    TEXT,

  updated_at           TEXT
);

CREATE TABLE IF NOT EXISTS priority_optin (
  email     TEXT PRIMARY KEY,
  added_at  TEXT NOT NULL
);

-- #4205: metadado key/value de 1 linha só (last_recomputed_at) — carimba
-- QUANDO o último recomputeDerived rodou, pra clarice-build-segment.ts
-- detectar defasagem (MAX(brevo_modified_at) mais recente que o último
-- recompute) sem depender de heurística sobre priority_points, que teria
-- falso-positivo em qualquer contato legitimamente decaído (ver isDerivedStale).
CREATE TABLE IF NOT EXISTS derived_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_tier        ON clarice_users(tier);
CREATE INDEX IF NOT EXISTS idx_users_eligible    ON clarice_users(send_eligible);
CREATE INDEX IF NOT EXISTS idx_users_points       ON clarice_users(priority_points);
`;

/** Abre (ou cria) o DB e garante o schema. */
export function openClariceDb(dbPath: string = DEFAULT_DB_PATH): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  // #3021: sem busy_timeout, um reader que colide com a janela de escrita da
  // task diária (Diaria-Clarice-Sync, 08:30) recebe SQLITE_BUSY imediatamente
  // em vez de esperar e tentar de novo. 5s cobre folgadamente uma transação
  // de sync incremental típica sem travar scripts de leitura por muito tempo.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  migrateSchema(db);
  return db;
}

/**
 * Migrações idempotentes pra stores existentes criados ANTES de uma coluna
 * nova entrar no SCHEMA acima — `CREATE TABLE IF NOT EXISTS` não adiciona
 * colunas a uma tabela já existente, e SQLite não tem `ADD COLUMN IF NOT
 * EXISTS`, então guardamos via `PRAGMA table_info`. Roda a cada `openClariceDb`
 * (barato — 1 PRAGMA + no-op se a coluna já existe); seguro rodar 2x.
 *
 * #2817: adiciona `cohort` pra stores criados antes desta migração.
 */
function migrateSchema(db: DatabaseSync): void {
  const cols = (
    db.prepare("PRAGMA table_info(clarice_users)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!cols.includes("cohort")) {
    db.exec("ALTER TABLE clarice_users ADD COLUMN cohort TEXT;");
  }
}

// ---------------------------------------------------------------------------
// findContactByEmail — helper canônico de lookup (#2863)
//
// Incidente de processo (260702): um diagnóstico fez lookup por MATCH EXATO no
// store e concluiu que 4 contatos "não eram clientes Stripe" — errado, os 4
// estavam no Stripe com a variante COM pontos do Gmail (`filosofo.daniel@` vs
// a resposta recebida `filosofodaniel@`), um deles assinante ativo T01. A
// conclusão falsa foi relayada ao editor como fato e só caiu quando ele
// contestou. Classe do erro: tratar AUSÊNCIA de match exato como PROVA de
// ausência — extensão do princípio #573 (validar antes de relayar) para
// negative claims.
//
// NORMA DE PROCESSO (vale pra qualquer chamador, não só este helper):
// ausência no store só é afirmável após (a) este lookup normalizado E (b)
// grep dos CSVs crus em `data/clarice-subscribers/` — ver
// `docs/clarice-unified-db.md`. Um miss aqui (matchType null) NUNCA deve virar
// "não está na base" sem esse segundo passo barato.
//
// Ordem de tentativa:
//   1. exato (lowercase/trim) — mesma normalização usada em todo o resto do
//      módulo (`clarice-optin.ts`, `recomputeDerived`).
//   2. normalização Gmail (`canonicalizeGmail`, #1969) — SÓ pra domínios da
//      família Gmail (gmail.com/googlemail.com; ver `GMAIL_DOMAINS`). Fora do
//      Gmail, pontos são significativos — não normaliza (`+sufixo` também não
//      é descartado fora do Gmail, mesma regra do #1969).
//
// `matchType`:
//   - "exact" — `row` é a linha encontrada por igualdade direta.
//   - "gmail-normalized" — `row` é a ÚNICA linha do domínio Gmail cujo
//     endereço canonicaliza pro mesmo valor do email buscado; `candidates`
//     contém essa mesma linha (conveniência pro chamador).
//   - null — ambíguo (`candidates.length > 1`, 2+ linhas colidem na forma
//     canônica — ex: `a.bc@gmail.com` e `ab.c@gmail.com` buscando
//     `a.b.c@gmail.com`) OU miss real (`candidates` vazio). Chamadores NUNCA
//     devem imprimir "fora da base" nesse caso sem antes reportar que o
//     lookup normalizado também não achou nada (e, idealmente, sugerir o grep
//     dos CSVs crus).
// ---------------------------------------------------------------------------

export interface ContactMatch {
  row: Record<string, unknown> | null;
  matchType: "exact" | "gmail-normalized" | null;
  candidates: Array<{ email: string }>;
}

export function findContactByEmail(
  db: DatabaseSync,
  email: string,
): ContactMatch {
  const normalized = email.trim().toLowerCase();

  const exact = db
    .prepare("SELECT * FROM clarice_users WHERE email = ?")
    .get(normalized) as Record<string, unknown> | undefined;
  if (exact) {
    return { row: exact, matchType: "exact", candidates: [] };
  }

  // #2920: contas de teste do editor (`vjpixel+test*@gmail.com`, #2895) são
  // uma identidade DISTINTA da conta real (`vjpixel@gmail.com`, mantida em
  // INTERNAL_EMAILS) — sem exact match acima, a normalização Gmail abaixo
  // canonicalizaria `vjpixel+test2@gmail.com` pra `vjpixel@gmail.com` e
  // resolveria qualquer lookup (ex: `clarice-optin add`, via
  // `resolveOptinEmail`) na conta REAL do editor, não na conta de teste.
  // Corta ANTES do fallback de normalização — miss real, nunca "achou por
  // normalização" pra um input de teste.
  if (isTestAccount(normalized)) {
    return { row: null, matchType: null, candidates: [] };
  }

  const at = normalized.lastIndexOf("@");
  const domain = at === -1 ? "" : normalized.slice(at + 1);
  if (!GMAIL_DOMAINS.has(domain)) {
    // domínio não-Gmail: pontos (e +sufixo) podem ser significativos — não
    // normaliza, não faz scan de candidatos.
    return { row: null, matchType: null, candidates: [] };
  }

  const canonical = canonicalizeGmail(normalized);
  const sameDomainEmails = db
    .prepare(
      "SELECT email FROM clarice_users WHERE email LIKE '%@gmail.com' OR email LIKE '%@googlemail.com'",
    )
    .all() as Array<{ email: string }>;
  const candidates = sameDomainEmails.filter(
    (r) => canonicalizeGmail(r.email) === canonical,
  );

  if (candidates.length === 1) {
    const row = db
      .prepare("SELECT * FROM clarice_users WHERE email = ?")
      .get(candidates[0].email) as Record<string, unknown>;
    return { row, matchType: "gmail-normalized", candidates };
  }
  if (candidates.length > 1) {
    return { row: null, matchType: null, candidates };
  }
  return { row: null, matchType: null, candidates: [] };
}

// ---------------------------------------------------------------------------
// priority_points — prioriza re-envios por comportamento de abertura (#2647)
//
//   +40  se priority_optin (pediu pra entrar na lista de prioridade; flag manual)
//   +20  por email aberto
//   -10  por email recebido e NÃO aberto
//   quem não recebeu nenhum email → 0 (ponto de partida)
//
// Aditivo (não corte duro): um optin que ignora 4 emails decai pra 0
// (40 − 10×4) — comportamento confirmado pelo editor.
// ---------------------------------------------------------------------------

export interface PriorityInput {
  priority_optin: boolean;
  opens_count: number;
  sends_count: number;
}

export function computePriorityPoints(i: PriorityInput): number {
  const notOpened = Math.max(0, i.sends_count - i.opens_count);
  return (i.priority_optin ? 40 : 0) + 20 * i.opens_count - 10 * notOpened;
}

// ---------------------------------------------------------------------------
// Emails internos (#2809) — editor + parceiro Clarice. Abrem/testam envios por
// ofício; o engajamento deles não é sinal de audiência. EXCLUÍDOS das
// agregações de priority_points do sumário (exibição/dashboard) — mas seguem
// no store e na fila de envio normalmente (decisão do editor 260702: "é para
// continuar enviando"). Fonte única — não espalhar os literais.
//
// #2885: movido pra `cohorts.ts` (dependency-free/Workers-safe, sem
// `node:sqlite`) — `clarice-segment.ts` também precisa deste literal (grupos
// nomeados `engajados`/`reativacao` excluem internos) e não pode importar
// deste módulo (ciclo: este módulo já importa de `clarice-segment.ts`).
// Re-exportado aqui pra não quebrar os imports existentes (`clarice-db-summary.ts`).
// ---------------------------------------------------------------------------

export { INTERNAL_EMAILS } from "./cohorts.ts";

// ---------------------------------------------------------------------------
// Test accounts (#2895) — exclusão PERMANENTE (não confundir com
// INTERNAL_EMAILS acima, que mantém no store). `isTestAccount`/
// `TEST_ACCOUNT_PATTERNS` moram em `cohorts.ts` (dependency-free) pelo mesmo
// motivo de `INTERNAL_EMAILS`: `clarice-segment.ts` precisa do mesmo
// predicado pro guard em `segmentFromStore` sem importar `node:sqlite`.
// Re-exportado aqui pra quem já importa deste módulo.
// ---------------------------------------------------------------------------

export { isTestAccount, TEST_ACCOUNT_PATTERNS } from "./cohorts.ts";

// ---------------------------------------------------------------------------
// send_eligible / ineligible_reason — corte de supressão e entregabilidade
//
// Ordem de prioridade (primeira condição que bate vira a razão). Soft bounce é
// transitório (caixa cheia / indisponibilidade temporária) → só exclui após
// SOFT_BOUNCE_LIMIT repetidos, pra não perder contato bom por hiccup do servidor.
//
// As colunas de supressão do Brevo (unsubscribed/hard_bounced/complained/
// email_blacklisted) são mantidas por `clarice-sync-brevo.ts` (MAX-merge,
// nunca des-suprime). `send_eligible=1` só é autoritativo depois que esse
// sync rodou pelo menos 1x sobre um contato — antes disso, as colunas ficam
// no DEFAULT 0 (parecem "limpas" sem ser).
//
// mv_unknown (#2735): mv_bucket="unknown" (MV inconclusivo — reverify/error)
// vira inelegível, mas é transitório (uma re-verificação pode reabilitar).
//
// mv_unverified (#2656 cutover → REVERTIDO em #2804 → RE-INTRODUZIDO em
// #2888, mesmo dia): entre #2656 e #2804, mv_bucket NULL (nunca submetido ao
// MV) virava inelegível com razão "mv_unverified". #2804 removeu esse corte
// ("elegível pra todos"). #2888 reverte #2804 — o editor decidiu que não é
// seguro enviar sem verificação prévia (risco de bounce) — com 2 EXCEÇÕES:
//   1. cohort `assinantes-ativos` (pagante Stripe, #1297): validado
//      implicitamente pelo pagamento, isento da exigência de MV (mesma
//      isenção do corte original #2656, agora expressa via cohort em vez de
//      tier===1 — #2857 fase C tornou cohort o modelo).
//   2. priority_points > 0 (engajamento real — abertura ou opt-in, #2876):
//      mesmo override que já cobre mv_rejected/mv_unknown; mv_unverified é a
//      irmã ausente, agora coerente com a mesma estrutura.
//
// #3819 (decisão do editor, 260721): a isenção de cohort `assinantes-ativos`
// (item 1 acima) foi ESTENDIDA de `mv_unverified` também pra `mv_rejected` e
// `mv_unknown` — regra invariável "assinante ativo é SEMPRE send_eligible".
// Até #3819, um contato que virou pagante DEPOIS de ser verificado como lead
// (mv_bucket='rejected'/'unknown' herdado) continuava cortado mesmo pagando —
// a isenção só cobria o ramo "nunca verificado". `mv_rejected`/`mv_unknown`
// continuam cortando normalmente para cohorts NÃO isentos (checados acima,
// mesma ordem de prioridade). Supressões de consentimento/entrega real
// (unsubscribed/blacklist/hard_bounce/complaint) NUNCA são isentas — intocáveis
// mesmo para pagante.
// ---------------------------------------------------------------------------

export const SOFT_BOUNCE_LIMIT = 3;

export type IneligibleReason =
  | "unsubscribed"
  | "hard_bounce"
  | "complaint"
  | "mv_rejected"
  | "mv_unknown"
  | "mv_unverified"
  | "dispute"
  | "soft_bounce"
  // #4249: razões de COERÊNCIA POR CAIXA CANÔNICA — ver `resolveMailboxCoherence`
  // abaixo. Não são vereditos sobre a linha em si (nem Brevo nem MV disseram
  // nada sobre ELA) — são efeito de uma linha IRMÃ na mesma caixa Gmail
  // (`canonicalizeGmail`, #1969: ponto/+tag ignorados, mesmo inbox físico).
  | "mailbox_suppressed" // linha irmã tem unsubscribed/blacklist/complaint
  | "duplicate_mailbox"; // linha irmã venceu o desempate de duplicata

export interface EligibilityInput {
  email_blacklisted: boolean;
  unsubscribed: boolean;
  hard_bounced: boolean;
  complained: boolean;
  mv_bucket: string | null | undefined;
  dispute_losses: number;
  soft_bounce_count: number;
  /**
   * priority_points do contato (#2876). Engajamento POSITIVO (>0 — só possível
   * via opt-in explícito +40 OU abertura real +20, ver computePriorityPoints)
   * sobrepõe um veredito NEGATIVO do MillionVerifier (`mv_rejected`/
   * `mv_unknown`), ambos mais fortes que a heurística estática do MV (que dá
   * falso-positivo em catch-all/greylist):
   *   - abertura real = prova EMPÍRICA de entregabilidade (o Brevo entregou e
   *     a pessoa abriu);
   *   - opt-in = prova de INTENÇÃO (pediu pra entrar). Não garante entrega —
   *     mas se o e-mail for de fato inválido, o 1º envio real quica e o
   *     `hard_bounced` (checado ANTES do MV) corta no próximo recompute:
   *     auto-corretivo.
   * NÃO sobrepõe sinais de consentimento/entrega real (unsub/blacklist/
   * hard_bounce/complaint/dispute/soft_bounce) — checados ANTES e cortam sempre.
   */
  priority_points: number;
  /**
   * cohort do contato (#2857 fase C — modelo canônico). Usado pra isentar
   * `assinantes-ativos` (pagante Stripe) de TODOS os cortes de MillionVerifier
   * — `mv_unverified` (#2888, mesma isenção do corte original #2656, que
   * checava `tier === 1`), e desde #3819 também `mv_rejected`/`mv_unknown`
   * (assinante ativo é SEMPRE send_eligible — pagamento já valida o e-mail,
   * nenhum veredito do MV deve suprimir um pagante). `tier` virou coluna
   * legada read-only na fase C; cohort é a fonte de verdade atual pra essa
   * distinção.
   */
  cohort: string | null | undefined;
}

export function classifyEligibility(i: EligibilityInput): {
  send_eligible: boolean;
  ineligible_reason: IneligibleReason | null;
} {
  // Consentimento + entrega real: SEMPRE suprimem — engajamento não anula
  // (unsubscribe é opt-out legal; hard_bounce/complaint são fatos do Brevo).
  if (i.unsubscribed || i.email_blacklisted)
    return { send_eligible: false, ineligible_reason: "unsubscribed" };
  if (i.hard_bounced)
    return { send_eligible: false, ineligible_reason: "hard_bounce" };
  if (i.complained)
    return { send_eligible: false, ineligible_reason: "complaint" };
  // #2876: pontuação positiva sobrepõe o veredito estático do MV (reject/
  // unknown). Só o corte de MV é sobreposto — os sinais acima já cortaram.
  const engaged = i.priority_points > 0;
  // #3819: assinante-ativo (pagante Stripe) é SEMPRE send_eligible — quem paga
  // tem e-mail que comprovadamente funciona. Nenhum veredito do MillionVerifier
  // (rejected/unknown/nunca-verificado) deve suprimir um pagante — mesma
  // isenção de `isMvExemptCohort` já usada abaixo pro corte mv_unverified,
  // agora estendida aos cortes mv_rejected/mv_unknown (achado #3819: antes só
  // cobria mv_unverified, deixando 44 assinantes-ativos cortados por
  // mv_bucket='rejected'/'unknown' herdado de quando eram lead). Supressões
  // de consentimento/entrega real (unsubscribed/blacklist/hard_bounce/
  // complaint) continuam valendo sempre — checadas ANTES, não são afetadas.
  const mvExempt = isMvExemptCohort(i.cohort);
  if (i.mv_bucket === "rejected" && !engaged && !mvExempt)
    return { send_eligible: false, ineligible_reason: "mv_rejected" };
  // MV inconclusivo (unknown/reverify/unverified/error, #2735) — mesma lógica
  // defensiva de rejected, mas NÃO é permanente: o registro fica no store (só
  // send_eligible=0), então uma re-verificação futura pode reabilitar. Contatos
  // nunca submetidos ao MV (mv_bucket NULL, ex: T01 ativo) não são afetados —
  // só quem tem uma linha `-unknown.csv` ingerida de fato.
  if (i.mv_bucket === "unknown" && !engaged && !mvExempt)
    return { send_eligible: false, ineligible_reason: "mv_unknown" };
  if (i.dispute_losses > 0)
    return { send_eligible: false, ineligible_reason: "dispute" };
  if (i.soft_bounce_count >= SOFT_BOUNCE_LIMIT)
    return { send_eligible: false, ineligible_reason: "soft_bounce" };
  // #2888 (re-introduz o corte #2656, revertido em #2804): contato nunca
  // submetido ao MV (mv_bucket NULL) é inelegível. Checado POR ÚLTIMO — é
  // "ainda não processado" (transitório: vira elegível assim que a
  // verificação rodar), não uma supressão ativa, então dispute/soft_bounce
  // (sinais de entrega/comportamento reais, mais explícitos) devem aparecer
  // no relatório quando ambos batem — mesma precedência do #2656 original.
  // Isento: cohort `assinantes-ativos` (pagamento Stripe já valida, #1297) e
  // `priority_points > 0` (mesmo override de engajamento do #2876, que já
  // sobrepõe mv_rejected/mv_unknown acima).
  // `!i.mv_bucket` (não `== null`) fecha também o caso de string vazia (#2888
  // self-review achado 1): se o ingest algum dia gravar `mv_bucket=''`, a linha
  // NÃO deve escapar como elegível silenciosamente — falha p/ o lado seguro
  // (inelegível/mv_unverified), coerente com a intenção do corte.
  // #2886 PR3 review: comparação inline substituída pelo predicado compartilhado
  // `isMvExemptCohort` (cohorts.ts) — mesmo predicado usado por
  // `verify-emails-mv.ts` pra recusar `--cohort assinantes-ativos`. Um 2º
  // cohort isento no futuro só precisa mudar num lugar.
  if (!i.mv_bucket && !mvExempt && !engaged)
    return { send_eligible: false, ineligible_reason: "mv_unverified" };
  return { send_eligible: true, ineligible_reason: null };
}

// ---------------------------------------------------------------------------
// MV never-verified predicate (#2886 PR3 review) — nomeado/exportado pra que
// um 2º consumidor de "quem ainda precisa de verificação MV" (dashboard,
// script de auditoria) importe esta constante em vez de re-digitar o WHERE —
// evita a variante sutilmente ERRADA "mv_cycle = ?" (verificar 1x por ciclo),
// que NÃO é a semântica desejada (decisão do editor #2886: skip forever —
// quem já foi verificado em QUALQUER ciclo nunca reentra). `mv_bucket = ''`
// incluído por defesa: nenhum ingest atual escreve string vazia (`ingestMv`
// sempre grava `classifyResult(...)`, que nunca retorna `""`), mas
// `classifyEligibility` acima trata `mv_bucket` vazio como não-verificado via
// checagem falsy (`!i.mv_bucket`) — esta constante espelha a MESMA convenção
// pra quem faz SELECT direto no store em vez de ler a coluna em JS.
// ---------------------------------------------------------------------------

export const MV_NEVER_VERIFIED_SQL = "(mv_bucket IS NULL OR mv_bucket = '')";

/**
 * FALLBACK LEGADO (#2857 fase C): deriva o cohort de uma linha a partir de
 * `tier` (coluna congelada, read-only desde a fase C) + `created`, pra
 * linhas cujo `cohort` ainda está NULL ou num formato não-reconhecido
 * (`isKnownCohortSlug`) — dado que predata qualquer ingest via
 * `merge-clarice-subscribers.ts`/`ingestStripe` pós-cutover, que agora
 * escrevem `cohort` DIRETO (contexto Stripe completo, este store não
 * persiste `payment_count`/`total_spend`). Ver `recomputeDerived` — chamada
 * só quando o `cohort` armazenado não é aproveitável.
 *
 * Precedência original (#2857 fase B.1 — correção pós dry-run no store real
 * sobre a fase A/B, decisão do editor 260702), preservada intacta pra dado
 * legado:
 *
 *   1. PAGANTE NUNCA VIRA LEAD: `tier === 1` → `assinantes-ativos`,
 *      `tier === 2` → `ex-assinantes`, SEMPRE — `created` é irrelevante pra
 *      pagante (mesmo que ele tenha `created` recente, isso reflete só a
 *      data da relação Stripe, nunca rebaixa o status de pagamento). Fix do
 *      achado #1 do dry-run: um assinante tier=1 criado em 2026-06 virava
 *      `leads-2026-06` e caía do topo da fila.
 *   2. LEAD (tier != 1/2) COM `created` VÁLIDO: cohort deriva do PERÍODO
 *      REAL de `created` (`deriveLeadCohort`, clarice-segment.ts — mensal
 *      `leads-YYYY-MM` se `created >= epoch da safra` 2026-05, senão
 *      semestre real `leads-YYYYhN`). Vale pra QUALQUER tier != 1/2
 *      (incluindo `tier` NULL) — o rótulo ESTÁTICO herdado do tier
 *      (`TIER_TO_COHORT`) NUNCA sobrescreve um `created` real presente,
 *      porque esse rótulo é um snapshot do momento do merge
 *      (`merge-clarice-subscribers.ts`, semestre deslizante relativo a
 *      `now` do export) congelado desde a fase A — ele desalinha do período
 *      real do `created` a cada virada de semestre. Fix do achado #2 do
 *      dry-run: o bucket 'leads-2025h2' continha `created` jan-abr/2026.
 *   3. FALLBACK (`created` ausente/inválido, `tier` presente e != 1/2):
 *      `cohortFromTier(tier)` — único caso em que o rótulo ESTÁTICO do tier
 *      é usado (o rótulo pode não refletir o período real do contato, mas é
 *      a melhor informação disponível sem `created`). Na prática este
 *      fallback só é atingível pra T10 com `created` NULL (fóssil sem
 *      data) — `tierOf` (merge-clarice-subscribers.ts) sempre popula
 *      `created` pra T3–T9, então o fallback pra esses tiers é defensivo
 *      (dados corrompidos/futuros fora dessa invariante).
 *   4. `tier` NULL + `created` ausente/inválido → `cohort` NULL (fim da
 *      fila — `cohortSendRank(null)` já trata isso).
 *
 * Exportada pra teste direto (test/clarice-db.test.ts) — espelha
 * `classifyEligibility`/`computePriorityPoints` acima (mesma classe de
 * função pura testável isolada de SQLite).
 */
export function computeCohort(
  tier: number | null | undefined,
  created: string | null | undefined,
): string | null {
  if (tier === 1) return COHORT_ASSINANTES_ATIVOS;
  if (tier === 2) return COHORT_EX_ASSINANTES;
  const leadCohort = deriveLeadCohort(created);
  if (leadCohort) return leadCohort;
  if (tier != null) return cohortFromTier(tier);
  return null;
}

// ---------------------------------------------------------------------------
// CSV membership backfill (#2873) — linhas nuas (stripe_ids NULL) que
// re-entraram no store por caminho secundário (mv-exports, sends CSVs, sync
// Brevo) DEPOIS de terem sido excluídas da ingestão Stripe pela auditoria de
// qualidade de email (role/test/estudante — `isLowQualityEmail`,
// merge-clarice-subscribers.ts). Essas linhas nunca passam por `ingestStripe`
// (não estão em `kept` nem em `disputed`), então ficam sem `stripe_ids`/
// `created`/`cohort` mesmo que o email exista de fato nos CSVs Stripe do root
// — só não passou no filtro de qualidade.
//
// `CsvBackfillIndex` é um índice email→created construído pelo CALLER
// (clarice-build-db.ts, a partir de `buildUniverse().merged` — o Map com
// TODOS os registros Stripe do root, kept E excluded, antes de qualquer
// filtro) e passado a `recomputeDerived`. `recomputeDerived` em si não lê CSV
// nenhum — mantém a função pura/testável com SQLite in-memory.
//
// Decisão de produto embutida (#2873): o cohort do CSV é derivado só via
// `created` (computeCohort com tier=null, cai sempre no ramo `deriveLeadCohort`
// ou NULL) — NUNCA promove a linha a `assinantes-ativos`/`ex-assinantes`
// mesmo que o registro Stripe mostre status pagante. Um email excluído pela
// auditoria (role/test/estudante) não é uma pessoa assinante de verdade — só
// uma caixa que existe no export Stripe (ex: `financeiro@empresa.com` que
// pagou a fatura da empresa). Tratar essa caixa como lead datado (ou deixar
// sem cohort) evita inflar o cohort de maior prioridade de envio com contas
// que a própria auditoria já julgou de baixa qualidade de entrega.
// ---------------------------------------------------------------------------

export interface CsvContactInfo {
  /** `created` (ISO) do registro Stripe mesclado, ou `null` se ausente/inválido. */
  created: string | null;
}

/** Índice email normalizado (lowercase/trim) → dados do CSV Stripe mesclado. */
export type CsvBackfillIndex = Map<string, CsvContactInfo>;

/**
 * Resolve `email` contra `index` — match exato primeiro, e (#2863) match
 * Gmail-normalizado (mesma regra de `findContactByEmail`, reaplicada aqui
 * porque o índice é um `Map` em memória, não uma tabela SQL) quando o
 * domínio é da família Gmail e exatamente 1 chave do índice canonicaliza pro
 * mesmo valor. Ambíguo (2+ candidatos) ou miss real → `null` (nunca adivinha).
 */
export function lookupCsvBackfill(
  index: CsvBackfillIndex,
  email: string,
): CsvContactInfo | null {
  const normalized = email.trim().toLowerCase();

  const exact = index.get(normalized);
  if (exact) return exact;

  const at = normalized.lastIndexOf("@");
  const domain = at === -1 ? "" : normalized.slice(at + 1);
  if (!GMAIL_DOMAINS.has(domain)) return null;

  const canonical = canonicalizeGmail(normalized);
  const candidates: string[] = [];
  for (const key of index.keys()) {
    const kAt = key.lastIndexOf("@");
    const kDomain = kAt === -1 ? "" : key.slice(kAt + 1);
    if (!GMAIL_DOMAINS.has(kDomain)) continue;
    if (canonicalizeGmail(key) === canonical) candidates.push(key);
  }
  if (candidates.length === 1) return index.get(candidates[0]) ?? null;
  return null;
}

// ---------------------------------------------------------------------------
// Coerência por caixa canônica (#4249) — Gmail ignora ponto/+tag no
// local-part; `nome.sobrenome@gmail.com` e `nomesobrenome@gmail.com` são a
// MESMA caixa física (`canonicalizeGmail`, #1969). Até aqui `recomputeDerived`
// tratava cada LINHA do store de forma independente — o que permitia 2 bugs
// reais (achados 260728, varredura de 433.648 linhas, 106 grupos de mesma
// caixa, 125 linhas extras):
//
//   1. supressão vazando: pessoa pede pra sair (unsubscribed/blacklist/
//      complaint) numa linha, continua recebendo pela OUTRA linha da mesma
//      caixa (1 caso vivo — risco de spam-complaint, guardrail de rampa).
//   2. cohort trocado: uma linha `assinantes-ativos` (pagante) e outra
//      `leads-*` da MESMA caixa — o pagante levava onda de reconversão (4
//      grupos, 2 já enviados).
//   3. duplicata de envio: 2+ linhas elegíveis da mesma caixa recebem a
//      MESMA edição (38 grupos ainda elegíveis; 31 caixas já receberam por
//      ≥2 linhas, 40 envios extras entregues).
//
// `resolveMailboxCoherence` roda como um SEGUNDO PASSO sobre o resultado
// per-row já calculado (cohort/priority_points individuais) — nunca
// substitui a classificação per-row, só corrige quando 2+ linhas da MESMA
// passagem de `recomputeDerived` colidem na forma canônica.
//
// Ordem de resolução (determinística):
//   a. cohort: `assinantes-ativos` em QUALQUER linha do grupo vence — todas
//      as linhas do grupo resolvem pro mesmo cohort (só promove, nunca
//      rebaixa). Divergência SEM `assinantes-ativos` presente não é
//      corrigida automaticamente (não há precedência óbvia entre 2 cohorts
//      de lead) — só sinalizada (`cohort_diverged_unresolved`).
//   b. elegibilidade INDIVIDUAL é RE-avaliada com o cohort já corrigido —
//      uma linha promovida a `assinantes-ativos` herda a isenção de MV
//      (#3819, "assinante ativo é sempre elegível") mesmo que a linha
//      original (como lead) estivesse cortada por mv_unverified/mv_rejected/
//      mv_unknown.
//   c. supressão de CONSENTIMENTO (`email_blacklisted`/`unsubscribed`/
//      `complained` — NÃO `hard_bounced`, que é sinal técnico por endereço,
//      não de consentimento) em QUALQUER linha do grupo torna as OUTRAS
//      linhas do grupo (sem o sinal na própria linha) inelegíveis com razão
//      `mailbox_suppressed`. Uma linha já inelegível por conta própria (ex:
//      hard_bounce, mv_rejected) mantém a PRÓPRIA razão — `mailbox_suppressed`
//      só se aplica à linha que SERIA elegível sozinha.
//   d. dedup: das linhas que sobram elegíveis no grupo (pós a/b/c), se
//      restar mais de 1, mantém só 1 (desempate: maior `priority_points` →
//      maior `opens_count` → maior `sends_count` → `created` mais recente →
//      arbitrário/determinístico por e-mail se empatar em TUDO). As demais
//      viram inelegíveis com razão `duplicate_mailbox`.
//
// Domínios fora de `GMAIL_DOMAINS` nunca agrupam — `canonicalizeGmail` só
// normaliza ponto/+tag pra gmail.com/googlemail.com; fora disso a chave é só
// lowercase, então só e-mails LITERALMENTE iguais colidem.
// ---------------------------------------------------------------------------

/** Agrupa `rows` pela forma canônica do e-mail (`canonicalizeGmail`, #1969). */
export function groupByCanonicalMailbox<T extends { email: string }>(
  rows: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = canonicalizeGmail(r.email);
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }
  return groups;
}

/**
 * Insumo por linha pra `resolveMailboxCoherence` — os mesmos campos crus de
 * `EligibilityInput` (pra re-avaliar elegibilidade com o cohort corrigido,
 * passo b) mais os campos de desempate do dedup (passo d). `cohort` aqui é o
 * BASELINE já resolvido per-row (preserve-then-backfill via `computeCohort`/
 * `lookupCsvBackfill`), não o valor cru da coluna.
 */
export interface MailboxRow extends EligibilityInput {
  email: string;
  opens_count: number;
  sends_count: number;
  created: string | null;
}

/** União dos motivos "per-row" (`IneligibleReason`) com os motivos que só existem NO CONTEXTO do grupo (#4249). */
export type MailboxIneligibleReason =
  | IneligibleReason
  | "mailbox_suppressed"
  | "duplicate_mailbox";

export interface MailboxResolution {
  cohort: string | null;
  send_eligible: boolean;
  ineligible_reason: MailboxIneligibleReason | null;
  /** cohort desta linha foi promovido pra `assinantes-ativos` por causa de uma linha irmã. */
  cohort_corrected: boolean;
  /** grupo tem cohorts divergentes SEM `assinantes-ativos` pra resolver — não corrigido, só sinalizado. */
  cohort_diverged_unresolved: boolean;
  /** esta linha virou inelegível por sinal de supressão de uma linha IRMÃ (não da própria). */
  mailbox_suppressed: boolean;
  /** esta linha perdeu o desempate de duplicata na mesma caixa. */
  duplicate_loser: boolean;
  /** tamanho do grupo de caixa canônica (1 = sem colisão, nenhuma das correções acima se aplica). */
  group_size: number;
  /** e-mail da linha sobrevivente do dedup, quando o grupo teve >1 candidata elegível (populado pra TODAS as linhas do grupo nesse caso, inclusive a vencedora). */
  survivor_email: string | null;
  /** critério que decidiu o desempate — só quando esta linha de fato perdeu o dedup. */
  tie_break_criterion: "priority_points" | "opens_count" | "sends_count" | "created" | "arbitrary" | null;
}

/** Desempate de sobrevivência (passo d): DESC priority_points → DESC opens_count → DESC sends_count → DESC created (mais recente primeiro) → ASC email (determinístico, arbitrário de fato). */
function compareForMailboxSurvival(a: MailboxRow, b: MailboxRow): number {
  if (a.priority_points !== b.priority_points) return b.priority_points - a.priority_points;
  if (a.opens_count !== b.opens_count) return b.opens_count - a.opens_count;
  if (a.sends_count !== b.sends_count) return b.sends_count - a.sends_count;
  const aCreated = a.created ?? "";
  const bCreated = b.created ?? "";
  if (aCreated !== bCreated) return aCreated < bCreated ? 1 : -1;
  return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
}

/** Qual critério decidiu entre a 1ª e a 2ª colocada (`sorted` já ordenado por `compareForMailboxSurvival`)? "arbitrary" = empate em TODOS os critérios reais (desempate final por e-mail). */
function decisiveTieBreakCriterion(
  sorted: MailboxRow[],
): "priority_points" | "opens_count" | "sends_count" | "created" | "arbitrary" {
  const [top, second] = sorted;
  if (top.priority_points !== second.priority_points) return "priority_points";
  if (top.opens_count !== second.opens_count) return "opens_count";
  if (top.sends_count !== second.sends_count) return "sends_count";
  if ((top.created ?? "") !== (second.created ?? "")) return "created";
  return "arbitrary";
}

/**
 * Resolve coerência (supressão + cohort + dedup, #4249) por caixa canônica
 * sobre um conjunto de linhas JÁ classificadas individualmente (`cohort`/
 * `priority_points` já resolvidos per-row, ver `recomputeDerived`). Pura —
 * sem I/O, testável isolada.
 *
 * Fonte ÚNICA: usada tanto por `recomputeDerived` (grava no store) quanto
 * por `clarice-mailbox-dryrun.ts` (só relatório, nunca escreve) — dry-run e
 * efeito real nunca divergem por definição, porque não há 2 implementações
 * pra manter sincronizadas.
 */
export function resolveMailboxCoherence(
  rows: MailboxRow[],
): Map<string, MailboxResolution> {
  const out = new Map<string, MailboxResolution>();

  for (const groupRows of groupByCanonicalMailbox(rows).values()) {
    if (groupRows.length === 1) {
      const r = groupRows[0];
      const elig = classifyEligibility(r);
      out.set(r.email, {
        cohort: r.cohort ?? null,
        send_eligible: elig.send_eligible,
        ineligible_reason: elig.ineligible_reason,
        cohort_corrected: false,
        cohort_diverged_unresolved: false,
        mailbox_suppressed: false,
        duplicate_loser: false,
        group_size: 1,
        survivor_email: null,
        tie_break_criterion: null,
      });
      continue;
    }

    // (a) cohort: assinantes-ativos em QUALQUER linha vence pro grupo inteiro.
    const hasAssinante = groupRows.some((r) => r.cohort === COHORT_ASSINANTES_ATIVOS);
    const diverged = new Set(groupRows.map((r) => r.cohort ?? null)).size > 1;
    const resolvedCohort = new Map<string, string | null>();
    for (const r of groupRows) {
      resolvedCohort.set(r.email, hasAssinante ? COHORT_ASSINANTES_ATIVOS : (r.cohort ?? null));
    }

    // (b) elegibilidade individual, RE-avaliada com o cohort já corrigido —
    // uma linha promovida a assinantes-ativos herda a isenção de MV (#3819).
    const ownElig = new Map<string, { send_eligible: boolean; ineligible_reason: IneligibleReason | null }>();
    for (const r of groupRows) {
      ownElig.set(
        r.email,
        classifyEligibility({
          email_blacklisted: r.email_blacklisted,
          unsubscribed: r.unsubscribed,
          hard_bounced: r.hard_bounced,
          complained: r.complained,
          mv_bucket: r.mv_bucket,
          dispute_losses: r.dispute_losses,
          soft_bounce_count: r.soft_bounce_count,
          priority_points: r.priority_points,
          cohort: resolvedCohort.get(r.email) ?? null,
        }),
      );
    }

    // (c) supressão de CONSENTIMENTO propaga pra caixa inteira (não hard_bounce
    // — técnico por endereço, não sinal de consentimento).
    const mailboxSuppressed = groupRows.some(
      (r) => r.email_blacklisted || r.unsubscribed || r.complained,
    );
    const afterSuppression = new Map<
      string,
      { eligible: boolean; reason: MailboxIneligibleReason | null; suppressedBySibling: boolean }
    >();
    for (const r of groupRows) {
      const own = ownElig.get(r.email)!;
      const ownSignal = r.email_blacklisted || r.unsubscribed || r.complained;
      if (!own.send_eligible) {
        afterSuppression.set(r.email, {
          eligible: false,
          reason: own.ineligible_reason,
          suppressedBySibling: false,
        });
      } else if (mailboxSuppressed && !ownSignal) {
        afterSuppression.set(r.email, {
          eligible: false,
          reason: "mailbox_suppressed",
          suppressedBySibling: true,
        });
      } else {
        afterSuppression.set(r.email, { eligible: true, reason: null, suppressedBySibling: false });
      }
    }

    // (d) dedup entre as que sobraram elegíveis.
    const candidates = groupRows.filter((r) => afterSuppression.get(r.email)!.eligible);
    let survivorEmail: string | null = null;
    let tieCriterion: ReturnType<typeof decisiveTieBreakCriterion> | null = null;
    if (candidates.length > 0) {
      const sorted = [...candidates].sort(compareForMailboxSurvival);
      survivorEmail = sorted[0].email;
      if (candidates.length > 1) tieCriterion = decisiveTieBreakCriterion(sorted);
    }

    for (const r of groupRows) {
      const supp = afterSuppression.get(r.email)!;
      const isLoser = candidates.length > 1 && supp.eligible && r.email !== survivorEmail;
      out.set(r.email, {
        cohort: resolvedCohort.get(r.email) ?? null,
        send_eligible: supp.eligible && !isLoser,
        ineligible_reason: isLoser ? "duplicate_mailbox" : supp.reason,
        cohort_corrected: hasAssinante && (r.cohort ?? null) !== COHORT_ASSINANTES_ATIVOS,
        cohort_diverged_unresolved: diverged && !hasAssinante,
        mailbox_suppressed: supp.suppressedBySibling,
        duplicate_loser: isLoser,
        group_size: groupRows.length,
        survivor_email: candidates.length > 1 ? survivorEmail : null,
        tie_break_criterion: isLoser ? tieCriterion : null,
      });
    }
  }

  return out;
}

/**
 * Recomputa as colunas derivadas (`priority_optin`, `priority_points`,
 * `send_eligible`, `ineligible_reason`, `cohort` — #2817, taxonomia
 * unificada #2857 fase A, correção de precedência #2857 fase B.1, cutover
 * fase C) pra todas as linhas a partir do estado atual de Brevo/MV/Stripe +
 * tabela `priority_optin`. Idempotente — roda no fim de cada build e sempre
 * que a flag de optin muda.
 *
 * `cohort` (#2857 fase C — mudou de comportamento): PRESERVA o valor já
 * armazenado quando ele é um slug RECONHECIDO (`isKnownCohortSlug`) — desde
 * a fase C, `ingestStripe` (clarice-build-db.ts) escreve `cohort` DIRETO a
 * partir de `merge-clarice-subscribers.ts` (contexto Stripe completo: este
 * store não persiste `payment_count`/`total_spend`, então só o merge pode
 * distinguir payer/lead com segurança) — recalcular aqui a partir só de
 * `tier`/`created` quebraria essa classificação pra linhas novas (tier deixa
 * de ser escrito). Só faz BACKFILL via `computeCohort` (fallback legado
 * tier+created) quando o `cohort` armazenado está NULL ou não é um slug
 * reconhecido (dado legado pré-fase-A/formato cru ainda não migrado — migra
 * automaticamente na 1ª passagem, idempotente na 2ª). `tier` INTEGER não é
 * escrito aqui nem em nenhum ingest novo (fica intacto — legado read-only
 * desde a fase C).
 *
 * `csvIndex` (#2873, opcional): quando uma linha continua com `cohort` NULL
 * após o backfill normal via `computeCohort(tier, created)` acima E não tem
 * `stripe_ids` (nunca passou por `ingestStripe` — nem `kept` nem `disputed`),
 * tenta resolver o email contra `csvIndex` (membership nos CSVs Stripe do
 * root, construído pelo caller a partir de `buildUniverse().merged` — inclui
 * linhas excluídas pela auditoria de qualidade de email). Achou → deriva
 * cohort do `created` do CSV via `computeCohort(null, created)` (mesmo
 * comportamento do backfill legado, só que o `created` vem do CSV em vez do
 * store). Omitido (chamadores que não passam `csvIndex`, ex: testes
 * unitários com SQLite in-memory sem CSV nenhum) → comportamento idêntico ao
 * de antes, sem tentativa de backfill.
 *
 * #2895 — PRIMEIRO passo (antes de recomputar qualquer coisa): purga
 * PERMANENTE de qualquer linha `isTestAccount` que tenha escapado dos guards
 * de ingestão (`ingestStripe`/`ingestMv`/`makeBrevoUpsert`) e chegado ao
 * store por qualquer outra via (dado legado pré-fix, import manual, etc.).
 * Rodar aqui — chamado ao fim de TODO build/sync — garante que o próximo
 * rebuild não apenas pare de RE-adicionar test accounts, mas efetivamente
 * REMOVA os que já estavam lá (o incidente original: DELETE manual não era
 * permanente porque o rebuild seguinte os trazia de volta).
 */
export function recomputeDerived(
  db: DatabaseSync,
  csvIndex?: CsvBackfillIndex,
): number {
  const allEmails = (
    db.prepare("SELECT email FROM clarice_users").all() as Array<{
      email: string;
    }>
  ).map((r) => r.email);
  const testEmails = allEmails.filter((e) => isTestAccount(e));
  if (testEmails.length > 0) {
    const del = db.prepare("DELETE FROM clarice_users WHERE email = ?");
    for (const email of testEmails) del.run(email);
  }

  const optin = new Set<string>(
    (db.prepare("SELECT email FROM priority_optin").all() as Array<{
      email: string;
    }>).map((r) => r.email),
  );

  const rows = db
    .prepare(
      `SELECT email, opens_count, sends_count, soft_bounce_count, dispute_losses,
              mv_bucket, email_blacklisted, unsubscribed, hard_bounced, complained, created, tier, cohort, stripe_ids
       FROM clarice_users`,
    )
    .all() as Array<{
    email: string;
    opens_count: number;
    sends_count: number;
    soft_bounce_count: number;
    dispute_losses: number;
    mv_bucket: string | null;
    email_blacklisted: number;
    unsubscribed: number;
    hard_bounced: number;
    complained: number;
    created: string | null;
    tier: number | null;
    cohort: string | null;
    stripe_ids: string | null;
  }>;

  const update = db.prepare(
    `UPDATE clarice_users
        SET priority_optin = ?, priority_points = ?, send_eligible = ?, ineligible_reason = ?, cohort = ?
      WHERE email = ?`,
  );

  // Transação única: a recomputação é all-or-nothing. Sem o wrap, um Ctrl+C no
  // meio (ex: durante `clarice-optin add` numa base grande) deixaria parte das
  // linhas com derivados novos e parte stale, sem detecção (#2649 review).
  let n = 0;
  db.exec("BEGIN");
  try {
    // Passo 1: baseline PER-ROW (cohort + priority_points), exatamente como
    // antes do #4249 — cada linha classificada de forma independente, sem
    // olhar pras irmãs de caixa canônica ainda.
    const baseline: Array<MailboxRow & { isOptin: boolean }> = [];
    for (const r of rows) {
      const isOptin = optin.has(r.email);
      const points = computePriorityPoints({
        priority_optin: isOptin,
        opens_count: r.opens_count ?? 0,
        sends_count: r.sends_count ?? 0,
      });
      // #2857 fase C: preserva um cohort já reconhecido (escrito fresco por
      // ingestStripe a partir do merge); backfill via computeCohort (fallback
      // legado tier+created) só quando ausente/não-reconhecido.
      let cohort =
        r.cohort != null && isKnownCohortSlug(r.cohort)
          ? r.cohort
          : computeCohort(r.tier, r.created);
      // #2873: ainda sem cohort E nunca tocada por ingestStripe (stripe_ids
      // NULL — nem kept nem disputed) → tenta membership nos CSVs Stripe do
      // root via o índice que o caller construiu (buildUniverse().merged).
      // Gated nas DUAS condições pra nunca sobrescrever um cohort já derivado
      // (preserve-then-backfill, #2857) nem gastar o lookup em linhas que
      // ingestStripe já classificou (stripe_ids presente, mesmo `[]`).
      if (cohort == null && r.stripe_ids == null && csvIndex) {
        const csvMatch = lookupCsvBackfill(csvIndex, r.email);
        if (csvMatch) {
          cohort = computeCohort(null, csvMatch.created);
        }
      }
      baseline.push({
        email: r.email,
        cohort,
        priority_points: points,
        opens_count: r.opens_count ?? 0,
        sends_count: r.sends_count ?? 0,
        created: r.created,
        email_blacklisted: !!r.email_blacklisted,
        unsubscribed: !!r.unsubscribed,
        hard_bounced: !!r.hard_bounced,
        complained: !!r.complained,
        mv_bucket: r.mv_bucket,
        dispute_losses: r.dispute_losses ?? 0,
        soft_bounce_count: r.soft_bounce_count ?? 0,
        isOptin,
      });
    }

    // Passo 2 (#4249): coerência por caixa canônica — supressão propaga,
    // cohort de assinantes-ativos vence, dedup de duplicata na mesma caixa.
    // Sem colisão (grupo de tamanho 1), o resultado é IDÊNTICO ao
    // `classifyEligibility` direto de antes do #4249 (ver caso `group_size===1`
    // em `resolveMailboxCoherence`) — comportamento pré-existente preservado.
    const resolved = resolveMailboxCoherence(baseline);

    // Passo 3: grava.
    for (const b of baseline) {
      const res = resolved.get(b.email)!;
      update.run(
        b.isOptin ? 1 : 0,
        b.priority_points, // #2876 — engajamento>0 sobrepõe veredito MV (per-row, não afetado pela coerência de caixa)
        res.send_eligible ? 1 : 0,
        res.ineligible_reason,
        res.cohort, // #2888/#4249 — assinantes-ativos (próprio ou promovido pela caixa) isento de mv_unverified
        b.email,
      );
      n++;
    }
    // #4205: carimba QUANDO este recompute rodou — isDerivedStale() abaixo
    // compara contra MAX(brevo_modified_at) pra detectar defasagem sem
    // depender de heurística sobre priority_points (que teria falso-positivo
    // em qualquer contato legitimamente decaído). Dentro da MESMA transação
    // que os UPDATEs acima — um Ctrl+C não pode deixar o carimbo "à frente"
    // de derivados que na verdade não terminaram de ser recomputados.
    db.prepare(
      `INSERT INTO derived_meta (key, value) VALUES ('last_recomputed_at', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(new Date().toISOString());
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return n;
}

/**
 * #4205: timestamp ISO do último `recomputeDerived` bem-sucedido, ou `null` se
 * o store nunca passou por um recompute nesta versão (store novo, ou store
 * migrado antes do 1º recompute pós-deploy desta feature).
 */
export function getLastRecomputedAt(db: DatabaseSync): string | null {
  const row = db
    .prepare("SELECT value FROM derived_meta WHERE key = 'last_recomputed_at'")
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * #4205: guard de defasagem — defesa em profundidade pro incidente onde
 * `clarice-sync-brevo.ts --incremental` atualiza `opens_count`/`clicks_count`/
 * etc mas é interrompido (rate-limit/Ctrl+C) ANTES de alcançar o
 * `recomputeDerived` final, OU um caminho futuro atualiza colunas Brevo sem
 * passar por `recomputeDerived`. `isEngajados` (clarice-segment.ts) filtra por
 * `priority_points > 0`, não por `opens_count` diretamente — se o store está
 * defasado, contatos que abriram recentemente ficam invisíveis no segmento
 * SEM nenhum sinal de erro (a onda simplesmente sai menor).
 *
 * Detecta via `MAX(brevo_modified_at) > last_recomputed_at`: se QUALQUER
 * linha foi tocada pelo Brevo depois do último recompute, o store está
 * defasado — não precisa saber QUAL linha, só que existe pelo menos uma.
 *
 * Deliberadamente NÃO usa `opens_count > 0 AND priority_points <= 0` como
 * sinal (a heurística sugerida originalmente na issue #4205): medido em
 * produção (260727), ~165/14.290 contatos batem essa condição MESMO logo
 * após um `recomputeDerived` fresco — são contatos que abriram algumas vezes
 * mas ignoraram sends recentes o suficiente pra decair pra `priority_points
 * <= 0` (`computePriorityPoints`: `-10` por send não-aberto pesa mais que
 * `+20` por 1 abertura antiga). Essa condição é um estado LEGÍTIMO e
 * PERMANENTE pra parte da base — usá-la como sinal de staleness faria o guard
 * disparar em praticamente toda invocação, sempre, mesmo com o store
 * perfeitamente fresco (falso-positivo sistemático, não só ocasional).
 *
 * Fail-OPEN (retorna `false`) quando `last_recomputed_at` é `null` — store
 * ainda não passou por um recompute desta versão; o próximo sync/build já
 * resolve. Fail-OPEN também quando não há nenhuma linha com
 * `brevo_modified_at` (store sem Brevo sincronizado ainda — nada pra estar
 * defasado em relação a).
 */
export function isDerivedStale(db: DatabaseSync): boolean {
  const lastRecomputedAt = getLastRecomputedAt(db);
  if (!lastRecomputedAt) return false;
  const row = db
    .prepare("SELECT MAX(brevo_modified_at) AS m FROM clarice_users")
    .get() as { m: string | null };
  if (!row?.m) return false;
  const maxModified = new Date(row.m).getTime();
  const lastRecomputed = new Date(lastRecomputedAt).getTime();
  if (!Number.isFinite(maxModified) || !Number.isFinite(lastRecomputed)) return false;
  return maxModified > lastRecomputed;
}

// ---------------------------------------------------------------------------
// Brevo → upsert das colunas de engajamento/supressão (#2647 follow-up)
//
// INSERT OR IGNORE garante a linha (contato Brevo pode não ter vindo do Stripe),
// depois UPDATE só nas colunas Brevo — não toca Stripe/MV/optin/derivados. Os
// derivados (send_eligible/priority_points) são recomputados depois via
// recomputeDerived, num passo separado, sobre a base inteira.
// ---------------------------------------------------------------------------

export function makeBrevoUpsert(db: DatabaseSync): (cols: BrevoColumns) => void {
  const ensure = db.prepare(
    "INSERT OR IGNORE INTO clarice_users (email) VALUES (?)",
  );
  // MAX-merge das flags de supressão e dos counts (colunas NOT-NULL DEFAULT 0):
  // dois registros Brevo do MESMO email (re-add após unsub) ou um re-run não podem
  // DES-suprimir — se qualquer registro é blacklisted/unsub/bounce, vale o
  // conservador (mesma garantia do OR-merge em fetchBrevoEngagement). Counts da
  // Brevo são cumulativos → MAX nunca regride. last_*/identity = overwrite com o
  // valor fresco. updated_at sempre = agora (marca quando o Brevo foi sincronizado).
  const update = db.prepare(
    `UPDATE clarice_users SET
       email_blacklisted = MAX(email_blacklisted, ?),
       unsubscribed      = MAX(unsubscribed, ?),
       hard_bounced      = MAX(hard_bounced, ?),
       complained        = MAX(complained, ?),
       opens_count       = MAX(opens_count, ?),
       clicks_count      = MAX(clicks_count, ?),
       sends_count       = MAX(sends_count, ?),
       soft_bounce_count = MAX(soft_bounce_count, ?),
       last_open_at = ?, last_click_at = ?, last_sent_at = ?,
       recency_quartil = ?, brevo_list_ids = ?,
       brevo_created_at = ?, brevo_modified_at = ?,
       updated_at = ?
     WHERE email = ?`,
  );
  return (c: BrevoColumns) => {
    if (!c.email) return; // sem email → ignora (evita colisão na key "")
    // #2895: conta de teste do editor (vjpixel+test*@gmail.com) — nunca
    // insere/mantém no store, mesmo vindo do Brevo (clarice-sync-brevo.ts).
    if (isTestAccount(c.email)) return;
    ensure.run(c.email);
    update.run(
      c.email_blacklisted,
      c.unsubscribed,
      c.hard_bounced,
      c.complained,
      c.opens_count,
      c.clicks_count,
      c.sends_count,
      c.soft_bounce_count,
      c.last_open_at,
      c.last_click_at,
      c.last_sent_at,
      c.recency_quartil,
      c.brevo_list_ids,
      c.brevo_created_at,
      c.brevo_modified_at,
      new Date().toISOString(),
      c.email,
    );
  };
}
