#!/usr/bin/env node
/**
 * sunset-dead-subscribers.ts (#5807)
 *
 * Identifica assinantes ATIVOS maduros que nunca se engajam de verdade — abrem
 * ≤10% E nunca clicaram em nada — e os move do envio diário Beehiiv pro funil
 * de reativação Brevo (`brevo_diaria`), mesma trilha já usada pelo segmento
 * Pending (`sync-pending-to-brevo.ts`).
 *
 * ## O guard que a issue exige (#5807, análise 260820, snapshot 2026-08-16)
 *
 * Critério NUNCA pode ser só abertura baixa: dos ativos maduros com abertura
 * ≤10%, uma fração real (101 na medição de origem) TEM cliques — leitores
 * genuínos com pixel de abertura bloqueado (Apple MPP e afins). Só quem tem
 * abertura ≤10% **E** zero cliques na vida inteira é sunset. Mesma filosofia
 * de `scripts/lib/leitor.ts` (nunca decidir por abertura sozinha, CTR/clique
 * real é o sinal que não mente) — aqui invertida: em vez de "quem lê", a
 * pergunta é "quem provadamente NUNCA leu".
 *
 * `receivedMin` desta issue é 20 (mais conservador que os 10 usados na
 * análise original que motivou a issue — decisão explícita da spec, não um
 * relaxamento acidental do piso de `leitor-v1`, que também usa 20).
 *
 * ## Dry-run por padrão, `--push` real NUNCA rodado por sessão autônoma
 *
 * Mesmo guard de publicação do overnight/develop (`context/overnight-dispatch-rules.md`
 * item 1) — `--push` existe no código (a issue pede) mas nenhuma sessão
 * autônoma o invoca contra a Beehiiv/Brevo real; só testado com fetch mockado.
 *
 * ## Push: ingestão Brevo + unsubscribe Beehiiv + store
 *
 * `--push` faz, por selecionado, NESTA ORDEM: (a) **ingestão real na lista
 * Brevo** via `ingestContactToBrevo` (com releitura de confirmação); (b) `PUT
 * .../subscriptions/by_email/{email}` com `{unsubscribe:true}` na Beehiiv —
 * único campo documentado como gravável nesse endpoint (mesma disciplina de
 * `cleanup-preflight-subscribers.ts`/`evaluate-brevo-diaria.ts`: nunca DELETE,
 * preserva histórico); (c) upsert no store `data/brevo-diaria/contacts.json`
 * via `upsertIngested`, o mesmo ciclo de vida que `sync-pending-to-brevo.ts`
 * usa (`in_brevo` → avaliação periódica por `evaluate-brevo-diaria.ts`); (d)
 * registro em `data/brevo-diaria/sunset-log.jsonl` (append-only,
 * auditoria/reversão manual) com `origem: "sunset"`, que distingue do fluxo
 * normal Pending.
 *
 * **O passo (a) não existia até o #5843** — o script fazia só (b)+(c)+(d), e a
 * premissa de que marcar `in_brevo` no store equivalia a estar na fila (só
 * verdadeira em `sync-pending-to-brevo.ts`, onde a ingestão real acontece uma
 * linha antes) era exatamente o que este header afirmava. Descrição completa
 * da ordem, do porquê dela e do tratamento de falha parcial: JSDoc de
 * `applySunsetOne` — fonte única, não reafirmar aqui.
 *
 * O cap de fila `brevo_diaria.daily_send_cap` é aplicado por este script, no
 * `main()`, via `computeAvailableSlots`/`applyQueueCapGate` (helpers
 * importados de `sync-pending-to-brevo.ts`, mas o corte acontece aqui).
 *
 * ## Guard de blast radius (mesmo padrão de #4436 — sync-apoio-nivel-beehiiv.ts)
 *
 * Recusa `--push` inteiro se a seleção passar de `BLAST_RADIUS_THRESHOLD`
 * (20%, decisão desta issue — spec pede "~20% dos ativos") dos assinantes
 * ativos maduros (`receivedMin` atingido) do snapshot. `--force-blast-radius`
 * é o escape hatch explícito, mesma convenção.
 *
 * ## MillionVerifier — fora de escopo aqui
 *
 * Diferente de `sync-pending-to-brevo.ts` (que ingere e-mails NUNCA
 * confirmados na Beehiiv, risco de bounce real), os selecionados por este
 * script já são assinantes `status=active` confirmados há muito tempo
 * (`receivedMin >= 20` edições recebidas) — não há necessidade de
 * verificação MV antes de reingerir no canal Brevo.
 *
 * ## Rodada semanal contínua (#5807, reescopo do comentário do editor 20/08 20:56)
 *
 * `--push` sozinho AGORA É a rodada semanal completa — não existe um modo
 * "weekly-round" separado, pra não duplicar superfície: (a) garante snapshot
 * fresco (`ensureFreshSnapshot`, dispara `backup-beehiiv.ts` se o mais
 * recente passar de `SNAPSHOT_MAX_AGE_DAYS` — só quando `--snapshot` não foi
 * passado explicitamente, pin manual nunca aciona refresh automático); (b)
 * avalia TODOS os ativos maduros contra `isDeadSubscriber` (já existia); (c)
 * exclui quem já passou pelo store `brevo_diaria` (`excludeAlreadyInStore` —
 * evita reprocessar quem já foi ingerido/promovido/suprimido por este script
 * ou por `sync-pending-to-brevo.ts`, mesmo padrão de dedup de
 * `computeContactsToIngest`) além do guard de consentimento já existente
 * (seleção só considera `status=active`, então descadastro orgânico nunca
 * entra); (d) aplica os guards de blast radius + folga de fila (já
 * existiam); (e) grava 1 linha em `data/brevo-diaria/sunset-rounds.jsonl`
 * por rodada (`appendSunsetRoundLog`) com avaliados/elegíveis/movidos/pulados
 * + motivo — auditoria append-only, mesmo padrão de `sunset-log.jsonl` mas
 * no nível da RODADA, não do contato individual.
 *
 * A task agendada (`Diaria-Sunset-Weekly`, `scripts/lib/scheduled-tasks.ts`)
 * nasce `enabled: false`. A #5849 achou que `receivedMin=20` sozinho não
 * separava "morto de verdade" de "recém-chegado dentro da janela de medição
 * do teste 2608" (#5734/#4556) — **resolvida** (sessão `/diaria-develop`
 * 260821): critério agora combina `receivedMin` E `subscribedMinDays` (ver
 * `SunsetThresholds`). Ligar a task (`enabled: true`) continua sendo decisão
 * separada e não foi tomada nesta mesma sessão — o mecanismo está pronto,
 * mas o interruptor segue desligado até o editor decidir armar a execução
 * automática.
 *
 * ## Backend: só enxerga assinantes Beehiiv, sem checar `platform.config.json` (#6051)
 *
 * A seleção parte de `data/beehiiv-backup/` (snapshot Beehiiv) e o
 * `unsubscribe:true` é um `PUT` hardcoded pra `beehiivApiBase()` — este
 * script nunca lê `publishing.newsletter.backend`/`SUBSCRIBE_BACKEND`.
 * Desde o #6339 (26/08/2026), os 3 workers de assinatura já cadastram
 * assinante novo direto no Kit — a base Beehiiv que este script varre é,
 * a partir daí, um conjunto CONGELADO (nenhum assinante novo entra nela).
 * Consequência prática: assinante Kit que se tornar "morto" (nunca abre,
 * nunca clica) **não é visto por este script** — ele só teria cobertura
 * quando um `sunset-dead-subscribers-kit.ts` equivalente existir, que
 * depende de um snapshot/backup do lado Kit ainda não escrito (mesma
 * lacuna documentada em `edition-cache-reader.ts` pro par
 * `loadKitCache`/broadcasts, aqui pro eixo de ASSINANTE). Não é uma
 * regressão de código — é escopo que nunca existiu no lado Kit. A task
 * segue `enabled: false`, e nenhum `--push` real rodou até aqui (dry-run
 * só testado com fetch mockado), então o gap não tem efeito observável
 * ainda; registrar aqui para quando a task for armada.
 *
 * ## Uso
 *
 *   npx tsx scripts/sunset-dead-subscribers.ts                          # dry-run (default)
 *   npx tsx scripts/sunset-dead-subscribers.ts --snapshot 2026-08-16    # snapshot específico
 *   npx tsx scripts/sunset-dead-subscribers.ts --push                   # rodada completa (fresh snapshot + unsubscribe Beehiiv + funil Brevo + log de rodada)
 *   npx tsx scripts/sunset-dead-subscribers.ts --push --force-blast-radius
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import {
  isSubscribersSnapshotUsable,
  latestSnapshotDate,
  readSnapshotSubscribers,
  type BeehiivBackupSubscriber,
} from "./lib/beehiiv-backup-snapshots.ts";
import { DEFAULT_BACKUP_ROOT } from "./lib/leitor.ts";
import {
  readStore,
  writeStore,
  upsertIngested,
  normalizeEmail,
  DEFAULT_STORE_PATH,
  type BrevoDiariaStore,
} from "./lib/brevo-diaria-store.ts";
import { computeAvailableSlots, computeCurrentActiveCount, ingestContactToBrevo } from "./sync-pending-to-brevo.ts";
import { loadBrevoDiariaTarget } from "./lib/brevo-diaria-target.ts";
import { buildOrigin } from "./lib/shared/brevo-diaria-origin.ts"; // #6678

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_SUNSET_LOG_PATH = resolve(ROOT, "data/brevo-diaria/sunset-log.jsonl");
/** Log append-only por RODADA (não por contato — ver {@link SunsetLogEntry}
 *  pra isso) — item (e) do reescopo #5807. */
export const DEFAULT_SUNSET_ROUND_LOG_PATH = resolve(ROOT, "data/brevo-diaria/sunset-rounds.jsonl");

// ---------------------------------------------------------------------------
// Limiares (spec #5807)
// ---------------------------------------------------------------------------

export interface SunsetThresholds {
  /** Mínimo de edições recebidas pra elegibilidade — 20, mais conservador
   *  que os 10 usados na análise original (#5807). */
  receivedMin: number;
  /** Abertura pessoal (open rate) máxima em fração 0-1 (0.10 = 10%). */
  openRateMaxPct: number;
  /** Idade mínima de cadastro em dias — piso combinado do #5849. Achado ao
   *  vivo em 20/08/2026: `receivedMin=20` sozinho mistura assinantes mortos
   *  de verdade (grupo original, mediana 101 recebidas / ~8 meses de
   *  cadastro) com gente que acabou de cruzar o piso de volume (23 casos,
   *  mediana 22 recebidas / ~1 mês de cadastro, coorte da campanha de
   *  lançamento em medição — #5734/#4556). Decisão registrada do editor
   *  (marcador `decisao-editor` em #5849, 21/08/2026 18:16 UTC): 90 dias,
   *  não 60 — o piso de idade existe pra não descadastrar a coorte de
   *  cadastro 22/07/2026 antes das medições que dependem dela (#5734,
   *  ~28/08; checkpoint #4556, 15/09). Com 60 dias a margem do #4556 seria
   *  de só 5 dias (20/09 vs checkpoint 15/09) — risco real se o checkpoint
   *  atrasar. 90 dias também alinha com a automação "Re-engagement
   *  Automation Flow (90 day Inactivity)" já configurada na Beehiiv. (Uma
   *  implementação paralela do #5849 mergeou com 60 antes de ver o
   *  marcador de decisão registrado — corrigido pelo #5881.) */
  subscribedMinDays: number;
}

export const SUNSET_THRESHOLDS: SunsetThresholds = {
  receivedMin: 20,
  openRateMaxPct: 10,
  subscribedMinDays: 90,
};

/** Limiar do guard de blast radius (20% — spec da issue #5807, "~20% dos
 *  ativos"). Mesmo mecanismo de `sync-apoio-nivel-beehiiv.ts` (#4436, lá 30%). */
export const BLAST_RADIUS_THRESHOLD = 0.2;

// ---------------------------------------------------------------------------
// Predicado puro de seleção
// ---------------------------------------------------------------------------

export interface SunsetInput {
  email: string;
  status: string;
  totalReceived: number;
  totalUniqueOpened: number;
  totalUniqueClicked: number;
  /** Epoch em SEGUNDOS do cadastro (`created` do snapshot Beehiiv, mesma
   *  unidade documentada em `acquisition-health.ts`) — piso de idade do
   *  #5849. */
  subscribedAt: number;
}

/** Open rate real (aberturas únicas ÷ recebidas), em pontos percentuais
 *  (0-100). Mesma disciplina de `computeCtrPct` (`leitor.ts`): denominador
 *  ≤0 ou entradas inválidas retornam 0, nunca NaN/Infinity. */
export function computeOpenRatePct(totalUniqueOpened: number, totalReceived: number): number {
  if (!Number.isFinite(totalReceived) || totalReceived <= 0) return 0;
  if (!Number.isFinite(totalUniqueOpened) || totalUniqueOpened < 0) return 0;
  return (totalUniqueOpened / totalReceived) * 100;
}

/** Dias corridos entre `subscribedAt` (epoch SEGUNDOS) e `referenceDate`
 *  (`YYYY-MM-DD`, meia-noite UTC — mesma disciplina de `computeSnapshotAgeDays`
 *  abaixo). Entrada inválida retorna 0 (fail-soft — nunca NaN/Infinity, nunca
 *  exclui por engano um assinante com dado ausente). */
export function daysSinceSubscribed(subscribedAt: number, referenceDate: string): number {
  if (!Number.isFinite(subscribedAt) || subscribedAt <= 0) return 0;
  const refMs = Date.parse(`${referenceDate}T00:00:00Z`);
  if (!Number.isFinite(refMs)) return 0;
  return Math.floor((refMs / 1000 - subscribedAt) / 86400);
}

/**
 * Predicado puro: `status=active` AND `totalReceived >= receivedMin` AND
 * `daysSinceSubscribed >= subscribedMinDays` AND `openRatePct <=
 * openRateMaxPct` AND `totalUniqueClicked === 0`.
 *
 * Dois guards críticos, nenhum dispensável (#5849 adicionou o guard de
 * idade explícito, endurecendo o proxy indireto de tempo que `receivedMin`
 * já fornecia sozinho):
 *
 * - `totalUniqueClicked === 0`, não `<= algum limiar` — QUALQUER clique na
 *   vida inteira, mesmo um só, exclui o assinante do sunset (é o mesmo
 *   assinante que os "101 com pixel bloqueado" da análise original
 *   representam — abertura baixa sozinha nunca decide, exatamente como
 *   `isLeitorV1` nunca decide só por CTR sem o piso de recebidas, e o
 *   inverso do motivo de `leitor-v1` nunca usar `click_rate`: aqui é
 *   abertura que pode mentir por MPP, clique nunca mente).
 * - `daysSinceSubscribed >= subscribedMinDays` — sem isso, `receivedMin`
 *   sozinho é um proxy indireto de tempo que quebra se a cadência de envio
 *   mudar, e mistura recém-chegado (ainda dentro da janela de formar
 *   hábito) com morto de verdade. Ver achado completo no docstring de
 *   `SunsetThresholds.subscribedMinDays`.
 */
export function isDeadSubscriber(
  input: SunsetInput,
  referenceDate: string,
  thresholds: SunsetThresholds = SUNSET_THRESHOLDS,
): boolean {
  if (input.status !== "active") return false;
  if (input.totalReceived < thresholds.receivedMin) return false;
  if (daysSinceSubscribed(input.subscribedAt, referenceDate) < thresholds.subscribedMinDays) return false;
  if (input.totalUniqueClicked !== 0) return false;
  return computeOpenRatePct(input.totalUniqueOpened, input.totalReceived) <= thresholds.openRateMaxPct;
}

/** Narrow do subscriber bruto do snapshot pra `SunsetInput` — mesmo padrão
 *  de `leitorInputFromBeehiivSubscriber`. */
export function sunsetInputFromBeehiivSubscriber(sub: BeehiivBackupSubscriber): SunsetInput {
  return {
    email: sub.email,
    status: sub.status,
    totalReceived: sub.stats?.total_received ?? 0,
    totalUniqueOpened: sub.stats?.total_unique_opened ?? 0,
    subscribedAt: sub.created,
    totalUniqueClicked: sub.stats?.total_unique_clicked ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Seleção sobre a lista completa + open rate projetado
// ---------------------------------------------------------------------------

export interface SunsetSelectionResult {
  snapshot_date: string;
  thresholds: SunsetThresholds;
  total_subscribers: number;
  /** Ativos maduros (`status=active` AND `totalReceived >= receivedMin`) —
   *  denominador do guard de blast radius. */
  mature_active_count: number;
  selected: SunsetInput[];
  /** Open rate médio ATUAL entre ativos maduros (fração 0-1). */
  open_rate_before: number;
  /** Open rate médio PROJETADO removendo os selecionados do denominador
   *  (fração 0-1) — soma das aberturas dos que ficam ÷ soma das recebidas
   *  dos que ficam. */
  open_rate_projected: number;
}

/** Pura — seleciona os candidatos a sunset e projeta o open rate resultante.
 *  Testável sem tocar disco (recebe a lista já carregada). */
export function selectDeadSubscribers(
  subscribers: readonly BeehiivBackupSubscriber[],
  thresholds: SunsetThresholds,
  snapshotDate: string,
): SunsetSelectionResult {
  const mature = subscribers
    .map(sunsetInputFromBeehiivSubscriber)
    .filter((s) => s.status === "active" && s.totalReceived >= thresholds.receivedMin);

  const selected = mature.filter((s) => isDeadSubscriber(s, snapshotDate, thresholds));
  const selectedEmails = new Set(selected.map((s) => s.email));
  const remaining = mature.filter((s) => !selectedEmails.has(s.email));

  const sumOpened = (list: SunsetInput[]) => list.reduce((acc, s) => acc + s.totalUniqueOpened, 0);
  const sumReceived = (list: SunsetInput[]) => list.reduce((acc, s) => acc + s.totalReceived, 0);

  const receivedBefore = sumReceived(mature);
  const openRateBefore = receivedBefore > 0 ? sumOpened(mature) / receivedBefore : 0;

  const receivedAfter = sumReceived(remaining);
  const openRateProjected = receivedAfter > 0 ? sumOpened(remaining) / receivedAfter : openRateBefore;

  return {
    snapshot_date: snapshotDate,
    thresholds,
    total_subscribers: subscribers.length,
    mature_active_count: mature.length,
    selected,
    open_rate_before: openRateBefore,
    open_rate_projected: openRateProjected,
  };
}

// ---------------------------------------------------------------------------
// Guard de blast radius (#5807, mesmo mecanismo de #4436)
// ---------------------------------------------------------------------------

export interface BlastRadiusGuardResult {
  blocked: boolean;
  selectedCount: number;
  matureActiveCount: number;
  ratio: number;
}

/** Pura — recusa o `--push` inteiro quando a seleção excede
 *  `BLAST_RADIUS_THRESHOLD` dos ativos maduros. "Passar de" é estrito —
 *  exatamente no limiar não bloqueia. `force` é o escape hatch explícito. */
export function evaluateBlastRadiusGuard(
  selectedCount: number,
  matureActiveCount: number,
  force: boolean,
  threshold: number = BLAST_RADIUS_THRESHOLD,
): BlastRadiusGuardResult {
  const ratio = matureActiveCount > 0 ? selectedCount / matureActiveCount : 0;
  const blocked = !force && ratio > threshold;
  return { blocked, selectedCount, matureActiveCount, ratio };
}

/** Resultado de {@link excludeAlreadyInStore}. */
export interface ExcludeAlreadyInStoreResult {
  toConsider: SunsetInput[];
  excludedEmails: string[];
}

/**
 * Pura — exclui da seleção quem já está no store `brevo_diaria`
 * (`data/brevo-diaria/contacts.json`), **qualquer status** (`in_brevo`,
 * `promoted_beehiiv`, `suppressed`, `unsubscribed`, `bounced`) — se o
 * contato já passou por este funil (por este script ou por
 * `sync-pending-to-brevo.ts`), reprocessar seria uma reingestão duplicada na
 * Brevo e um 2º `unsubscribe` inofensivo mas desperdiçado na Beehiiv. Mesmo
 * padrão de dedup de `computeContactsToIngest` (`sync-pending-to-brevo.ts`):
 * `known = new Set(store.contacts.map(email))`.
 *
 * Item (c) do reescopo #5807 — parte "e quem já passou pelo store
 * `brevo_diaria`" (a outra metade, unsubscribe orgânico, já é coberta pelo
 * filtro `status === "active"` de {@link selectDeadSubscribers}: quem se
 * descadastrou nunca chega a `status=active` no snapshot).
 */
export function excludeAlreadyInStore(
  selected: readonly SunsetInput[],
  store: BrevoDiariaStore,
): ExcludeAlreadyInStoreResult {
  const known = new Set(store.contacts.map((c) => normalizeEmail(c.email)));
  const toConsider: SunsetInput[] = [];
  const excludedEmails: string[] = [];
  for (const s of selected) {
    if (known.has(normalizeEmail(s.email))) excludedEmails.push(s.email);
    else toConsider.push(s);
  }
  return { toConsider, excludedEmails };
}

/** Fallback se `daily_send_cap` não estiver em `platform.config.json` — mesmo
 *  valor default de `sync-pending-to-brevo.ts::DEFAULT_QUEUE_CAP`. */
export const DEFAULT_QUEUE_CAP = 300;

/**
 * Pura — trunca a seleção pra caber nos slots livres da MESMA fila
 * compartilhada com `sync-pending-to-brevo.ts` (`brevo_diaria.daily_send_cap`,
 * `data/brevo-diaria/contacts.json`). Sem este gate, um `--push` deste
 * script poderia empurrar `store.contacts` com `status=in_brevo` além do cap
 * combinado com o segmento Pending — os dois scripts escrevem no MESMO store
 * e na MESMA lista Brevo, então o cap é uma propriedade da FILA, não de cada
 * script isoladamente (spec da issue #5807, item 4: "respeitando o fluxo
 * existente... cap da fila").
 *
 * Prioriza quem tem engajamento mais baixo primeiro (open rate ascendente —
 * desempate por `totalReceived` descendente, mais dado = mais confiança no
 * "morto") — se o cap não couber todo mundo nesta rodada, os candidatos mais
 * inequivocamente mortos saem primeiro; o resto permanece elegível pra
 * próxima rodada (dedup pelo store, mesma disciplina de `computeContactsToIngest`).
 */
export function applyQueueCapGate(
  selected: readonly SunsetInput[],
  availableSlots: number,
): SunsetInput[] {
  if (availableSlots <= 0) return [];
  const ordered = [...selected].sort((a, b) => {
    const rateA = computeOpenRatePct(a.totalUniqueOpened, a.totalReceived);
    const rateB = computeOpenRatePct(b.totalUniqueOpened, b.totalReceived);
    if (rateA !== rateB) return rateA - rateB;
    return b.totalReceived - a.totalReceived;
  });
  return ordered.slice(0, availableSlots);
}

// ---------------------------------------------------------------------------
// Aplicação (I/O) — unsubscribe Beehiiv + funil de reativação Brevo
// ---------------------------------------------------------------------------

/** `PUT .../subscriptions/by_email/{email}` com `{unsubscribe:true}` — mesmo
 *  endpoint/disciplina de `cleanup-preflight-subscribers.ts::unsubscribe`
 *  (nunca DELETE, preserva histórico do registro). Reimplementado aqui (não
 *  importado) pelo mesmo motivo documentado lá: este script é
 *  Beehiiv+Brevo, não deveria puxar um módulo pensado só pra limpeza de
 *  teste de preflight. */
export async function unsubscribeFromBeehiiv(
  publicationId: string,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(
    `${beehiivApiBase()}/publications/${publicationId}/subscriptions/by_email/${encodeURIComponent(email)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ unsubscribe: true }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Beehiiv API PUT subscriptions/by_email/${email} (unsubscribe:true) falhou (HTTP ${res.status}): ${text}`,
    );
  }
}

export interface SunsetLogEntry {
  email: string;
  sunset_at: string;
  snapshot_date: string;
  total_received: number;
  total_unique_opened: number;
  total_unique_clicked: number;
  open_rate_pct: number;
  origem: "sunset";
}

/** I/O — grava 1 linha jsonl append-only em `path` (cria o diretório pai se
 *  necessário) — auditoria/reversão manual (#5807 item 6 da spec). */
export function appendSunsetLog(entry: SunsetLogEntry, path: string = DEFAULT_SUNSET_LOG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

/**
 * União discriminada: `error` existe sse `ok === false`, `warnings` sse
 * `ok === true`. O shape anterior (`ok: boolean; error?: string`) permitia
 * `{ok: true, error: "..."}` e `{ok: false}` sem motivo — pareamento mantido
 * só por disciplina, não pelo compilador.
 *
 * `warnings` (não-vazio quando presente) cobre o caso novo do #5843: a
 * ingestão na Brevo SUCEDEU, mas uma etapa posterior (unsubscribe na Beehiiv,
 * log de auditoria) falhou. O resultado é `ok: true` de propósito — a mutação
 * que define o sucesso aconteceu e está registrada no store — mas o operador
 * precisa ver o que ficou pendente.
 */
export type PushOneResult =
  | { email: string; ok: true; warnings?: string[] }
  | { email: string; ok: false; error: string };

/**
 * I/O — aplica sunset a 1 candidato: ingestão real na lista Brevo, unsubscribe
 * na Beehiiv, upsert no store Brevo (`in_brevo`, mesmo ciclo de vida de
 * `sync-pending-to-brevo.ts` — `evaluate-brevo-diaria.ts` cuida da
 * avaliação/promoção/supressão subsequente, não reimplementado aqui), e log de
 * auditoria. `beehiiv_subscription_id` do registro do store fica
 * `"sunset:{email}"` — este fluxo não tem (nem precisa) o id de subscription
 * Beehiiv que `sync-pending-to-brevo.ts` carrega da paginação Pending; o campo
 * é só chave de correlação, nunca usado como subscription id real em nenhum
 * caminho de código existente.
 *
 * ## Ordem das mutações (#5843) — ingestão Brevo ANTES do unsubscribe
 *
 * Até o #5843 esta função chamava `upsertIngested` (função PURA, só mexe no
 * objeto de store) sem nunca chamar `ingestContactToBrevo` — o contato saía da
 * Beehiiv e não entrava em lista nenhuma, ficando marcado `in_brevo` num store
 * que não correspondia a estado real. Como esse store é o dedup de
 * `computeContactsToIngest`, o contato virava invisível pro backfill pra
 * sempre. `sync-pending-to-brevo.ts` sempre fez as duas na ordem certa — ver
 * o par `ingestContactToBrevo` + `upsertIngested` dentro do `main()` dele;
 * aqui só a segunda tinha sido copiada.
 *
 * A ordem é deliberada: **ingerir na Brevo primeiro, descadastrar depois**. Se
 * a ingestão falhar, o contato segue recebendo a diária na Beehiiv (degradação
 * segura, nada se perde). Na ordem inversa, uma falha na 2ª metade deixa a
 * pessoa sem nenhum dos dois canais.
 *
 * `ingest` é injetável (default = `ingestContactToBrevo` real) porque
 * `brevoPost`/`brevoGet` usam `fetch` global sem ponto de injeção — sem isso o
 * teste não conseguiria CONTAR a chamada à Brevo, que é exatamente o que o
 * mock anterior deixava passar (#5843).
 */
export type IngestToBrevoFn = (apiKey: string, listId: number, email: string) => Promise<void>;

export async function applySunsetOne(params: {
  input: SunsetInput;
  snapshotDate: string;
  publicationId: string;
  beehiivApiKey: string;
  brevoApiKey: string;
  brevoListId: number;
  store: BrevoDiariaStore;
  fetchImpl: typeof fetch;
  logPath: string;
  now?: string;
  ingest?: IngestToBrevoFn;
}): Promise<{ result: PushOneResult; nextStore: BrevoDiariaStore }> {
  const {
    input,
    snapshotDate,
    publicationId,
    beehiivApiKey,
    brevoApiKey,
    brevoListId,
    store,
    fetchImpl,
    logPath,
    now = new Date().toISOString(),
    ingest = ingestContactToBrevo,
  } = params;
  // FASE 1 — a única mutação externa que ainda pode ser abortada sem deixar
  // rastro: se a Brevo recusar, ninguém foi tocado em lugar nenhum.
  try {
    await ingest(brevoApiKey, brevoListId, normalizeEmail(input.email));
  } catch (e) {
    return {
      result: { email: input.email, ok: false, error: `ingestão Brevo falhou: ${(e as Error).message}` },
      nextStore: store,
    };
  }

  // A partir daqui o contato ESTÁ na lista Brevo (ingestContactToBrevo confirma
  // por releitura). Nenhuma falha posterior pode devolver `nextStore: store` e
  // fingir que nada aconteceu — era esse descarte que produzia contato órfão:
  // presente na Brevo, ausente do store, e invisível pro backfill (que dedupa
  // pelo store) e pro `evaluate-brevo-diaria.ts` (que só enxerga o store).
  const nextStore = upsertIngested(
    store,
    { email: input.email, beehiiv_subscription_id: buildOrigin("sunset", normalizeEmail(input.email)) },
    now,
  );

  // FASE 2 — unsubscribe na Beehiiv. Falha aqui deixa a pessoa nos DOIS canais
  // temporariamente (recebendo a diária e o funil de reativação), o que é ruim
  // mas auto-curável: ela continua `status=active` no snapshot, então volta a
  // ser candidata na próxima rodada, e a re-ingestão na Brevo é idempotente
  // (`updateEnabled:true`). O store JÁ registra a ingestão, então o cap da fila
  // e o dedup ficam corretos nesse meio-tempo.
  let unsubscribeError: string | null = null;
  try {
    await unsubscribeFromBeehiiv(publicationId, beehiivApiKey, input.email, fetchImpl);
  } catch (e) {
    unsubscribeError = (e as Error).message;
  }

  // FASE 3 — auditoria. Falha de I/O aqui (disco cheio, junction `data/` do
  // OneDrive caída no meio da rodada) NÃO pode reverter as mutações reais já
  // feitas: o registro some, o efeito não. Vira aviso no resultado.
  let logError: string | null = null;
  try {
    appendSunsetLog(
      {
        email: normalizeEmail(input.email),
        sunset_at: now,
        snapshot_date: snapshotDate,
        total_received: input.totalReceived,
        total_unique_opened: input.totalUniqueOpened,
        total_unique_clicked: input.totalUniqueClicked,
        open_rate_pct: computeOpenRatePct(input.totalUniqueOpened, input.totalReceived),
        origem: "sunset",
      },
      logPath,
    );
  } catch (e) {
    logError = (e as Error).message;
  }

  const warnings = [
    unsubscribeError ? `unsubscribe Beehiiv falhou (contato segue ativo lá): ${unsubscribeError}` : null,
    logError ? `log de auditoria falhou: ${logError}` : null,
  ].filter((w): w is string => w !== null);

  return {
    result: { email: input.email, ok: true, warnings: warnings.length > 0 ? warnings : undefined },
    nextStore,
  };
}

// ---------------------------------------------------------------------------
// Formatação (dry-run)
// ---------------------------------------------------------------------------

export function formatDryRunReport(selection: SunsetSelectionResult): string {
  const lines: string[] = [];
  lines.push(
    `[sunset-dead-subscribers] snapshot ${selection.snapshot_date} — ${selection.total_subscribers} assinante(s) no backup, ` +
      `${selection.mature_active_count} ativo(s) maduro(s) (>= ${selection.thresholds.receivedMin} recebidas).`,
  );
  lines.push(
    `[sunset-dead-subscribers] ${selection.selected.length} candidato(s) a sunset ` +
      `(cadastro >= ${selection.thresholds.subscribedMinDays} dias E abertura <= ${selection.thresholds.openRateMaxPct}% E zero cliques na vida inteira).`,
  );
  lines.push(
    `[sunset-dead-subscribers] open rate: ${(selection.open_rate_before * 100).toFixed(1)}% (atual) → ` +
      `${(selection.open_rate_projected * 100).toFixed(1)}% (projetado sem os candidatos).`,
  );
  for (const s of selection.selected) {
    lines.push(
      `  - ${s.email} (recebidas=${s.totalReceived}, cadastro há ${daysSinceSubscribed(s.subscribedAt, selection.snapshot_date)}d, abertura=${computeOpenRatePct(s.totalUniqueOpened, s.totalReceived).toFixed(1)}%, cliques=${s.totalUniqueClicked})`,
    );
  }
  lines.push("");
  lines.push("(dry-run — nenhuma escrita feita; rode com --push pra executar)");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Rodada semanal — snapshot fresco (#5807, item a do reescopo)
// ---------------------------------------------------------------------------

/** Mesmo limiar de `beehiiv-backup-staleness-alarm.ts::MAX_AGE_DAYS` — o
 *  snapshot semanal (`Diaria-Beehiiv-Backup`, domingo 03:00) já alarma
 *  separadamente se passar disso; este script usa o MESMO número pra não
 *  inventar um 2º critério de "velho demais" pro mesmo dado. */
export const SNAPSHOT_MAX_AGE_DAYS = 7;

/** Idade em dias de um snapshot `YYYY-MM-DD` em relação a `now` — parse como
 *  meia-noite UTC (mesma disciplina de `snapshotDateToEpochSeconds`,
 *  `scripts/lib/acquisition-health.ts`: comparação de DATA, não de
 *  timestamp-com-hora). */
export function computeSnapshotAgeDays(snapshotDate: string, now: Date): number {
  const snapshotMs = Date.parse(`${snapshotDate}T00:00:00Z`);
  if (!Number.isFinite(snapshotMs)) return Infinity;
  const diffMs = now.getTime() - snapshotMs;
  return diffMs / (24 * 60 * 60 * 1000);
}

export type RunBackupFn = () => Promise<void> | void;

/** I/O real (default de {@link ensureFreshSnapshot} em produção) — dispara
 *  `scripts/backup-beehiiv.ts` como subprocesso síncrono. Injetável por
 *  `runBackup` em todo caminho de teste — NUNCA invocado por este módulo
 *  fora de `--push` (guard de publicação: só a rodada real dispara backup
 *  ao vivo, dry-run nunca toca a API Beehiiv). */
export function defaultRunBackup(): void {
  execFileSync("npx", ["tsx", resolve(ROOT, "scripts/backup-beehiiv.ts")], {
    stdio: "inherit",
    cwd: ROOT,
  });
}

export interface EnsureFreshSnapshotResult {
  triggered: boolean;
  reason: string;
  snapshotDateBefore: string | null;
  snapshotDateAfter: string | null;
}

/**
 * Item (a) do reescopo #5807: garante que exista um snapshot utilizável com
 * idade ≤ `maxAgeDays` antes da rodada avaliar candidatos — dispara
 * `runBackup()` (I/O real) se o mais recente estiver ausente ou velho demais.
 * Não lê `subscribers.jsonl` em si — só a DATA do snapshot mais recente
 * (`latestSnapshotDate`), então não precisa parsear o arquivo inteiro pra
 * decidir se precisa de refresh.
 */
export async function ensureFreshSnapshot(params: {
  root: string;
  runBackup: RunBackupFn;
  maxAgeDays?: number;
  now?: Date;
}): Promise<EnsureFreshSnapshotResult> {
  const { root, runBackup, maxAgeDays = SNAPSHOT_MAX_AGE_DAYS, now = new Date() } = params;
  const before = latestSnapshotDate(root);
  const ageDays = before ? computeSnapshotAgeDays(before, now) : Infinity;

  if (before && ageDays <= maxAgeDays) {
    return {
      triggered: false,
      reason: `snapshot ${before} tem ${ageDays.toFixed(1)}d — dentro do limite (<= ${maxAgeDays}d), sem refresh.`,
      snapshotDateBefore: before,
      snapshotDateAfter: before,
    };
  }

  await runBackup();
  const after = latestSnapshotDate(root);
  return {
    triggered: true,
    reason: before
      ? `snapshot ${before} tinha ${ageDays.toFixed(1)}d (> ${maxAgeDays}d) — backup disparado.`
      : `nenhum snapshot encontrado em ${root} — backup disparado.`,
    snapshotDateBefore: before,
    snapshotDateAfter: after,
  };
}

// ---------------------------------------------------------------------------
// Rodada semanal — log append-only da RODADA (#5807, item e do reescopo)
// ---------------------------------------------------------------------------

/** 1 linha por RODADA (dry-run ou push) — distinto de {@link SunsetLogEntry},
 *  que é 1 linha por CONTATO efetivamente movido. */
export interface SunsetRoundLogEntry {
  round_at: string;
  push: boolean;
  snapshot_date: string;
  snapshot_refresh: EnsureFreshSnapshotResult | null;
  mature_active_count: number;
  eligible_count: number;
  already_in_store_count: number;
  considered_count: number;
  blast_radius: { blocked: boolean; ratio: number; threshold: number };
  queue: { current_active: number; cap: number; available_slots: number } | null;
  applied_count: number;
  failed_count: number;
  warned_count: number;
  skipped: { email: string; reason: string }[];
}

/** I/O — grava 1 linha jsonl append-only em `path` (cria o diretório pai se
 *  necessário). Mesmo padrão de {@link appendSunsetLog}, nível de RODADA. */
export function appendSunsetRoundLog(
  entry: SunsetRoundLogEntry,
  path: string = DEFAULT_SUNSET_ROUND_LOG_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const log = (msg: string) => process.stderr.write(`[sunset-dead-subscribers] ${msg}\n`);
  const push = hasFlag(argv, "push");
  const force = hasFlag(argv, "force-blast-radius");
  const backupRoot = getStringArg(argv, "root") ?? DEFAULT_BACKUP_ROOT;
  const snapshotArg = getStringArg(argv, "snapshot");

  // #5807 item (a): rodada com --push garante snapshot fresco ANTES de ler
  // qualquer coisa — pin explícito via --snapshot nunca aciona refresh
  // automático (o operador pediu uma data específica de propósito).
  let snapshotRefresh: EnsureFreshSnapshotResult | null = null;
  if (push && !snapshotArg) {
    snapshotRefresh = await ensureFreshSnapshot({ root: backupRoot, runBackup: defaultRunBackup });
    log(snapshotRefresh.reason);
  }

  const date = snapshotArg ?? latestSnapshotDate(backupRoot);
  if (!date) {
    log(`nenhum snapshot encontrado em ${backupRoot}`);
    process.exitCode = 1;
    return;
  }

  const usability = isSubscribersSnapshotUsable(backupRoot, date);
  if (!usability.usable) {
    log(`snapshot ${date} inutilizável: ${usability.reason}`);
    process.exitCode = 1;
    return;
  }

  const subscribers = readSnapshotSubscribers(backupRoot, date);
  const selection = selectDeadSubscribers(subscribers, SUNSET_THRESHOLDS, date);

  process.stdout.write(formatDryRunReport(selection) + "\n");

  if (!push) return;

  // #5807 item (c): exclui quem já passou pelo store brevo_diaria (qualquer
  // status) ANTES de qualquer guard — evita reprocessar um contato já
  // movido/avaliado por este script ou por sync-pending-to-brevo.ts.
  let store = readStore(DEFAULT_STORE_PATH);
  const { toConsider, excludedEmails } = excludeAlreadyInStore(selection.selected, store);
  if (excludedEmails.length > 0) {
    log(
      `${excludedEmails.length} candidato(s) já presente(s) no store brevo_diaria — excluído(s) desta rodada ` +
        "(já movidos/avaliados anteriormente).",
    );
  }

  const round = {
    round_at: new Date().toISOString(),
    push: true,
    snapshot_date: date,
    snapshot_refresh: snapshotRefresh,
    mature_active_count: selection.mature_active_count,
    eligible_count: selection.selected.length,
    already_in_store_count: excludedEmails.length,
    considered_count: toConsider.length,
  };
  const alreadyInStoreSkipped = excludedEmails.map((email) => ({ email, reason: "already_in_store" }));

  // #5807 item (d): guard de blast radius avalia os CONSIDERADOS desta
  // rodada (pós-exclusão do store) — quem já foi processado não é risco novo.
  const guard = evaluateBlastRadiusGuard(toConsider.length, selection.mature_active_count, force);
  if (guard.blocked) {
    log(
      `RECUSANDO o --push inteiro (guard de blast radius): ${guard.selectedCount} sunset(s) de ` +
        `${guard.matureActiveCount} ativo(s) maduro(s) (${(guard.ratio * 100).toFixed(1)}%, limiar ` +
        `${(BLAST_RADIUS_THRESHOLD * 100).toFixed(0)}%) — nenhuma mutação foi aplicada. Investigue antes de usar ` +
        "--force-blast-radius (decisão consciente do editor, sempre logada).",
    );
    appendSunsetRoundLog({
      ...round,
      blast_radius: { blocked: true, ratio: guard.ratio, threshold: BLAST_RADIUS_THRESHOLD },
      queue: null,
      applied_count: 0,
      failed_count: 0,
      warned_count: 0,
      skipped: [
        ...alreadyInStoreSkipped,
        ...toConsider.map((s) => ({ email: s.email, reason: "blast_radius_blocked" })),
      ],
    });
    process.exitCode = 2;
    return;
  }

  const { apiKey: beehiivApiKey, publicationId } = loadBeehiivConfig("[sunset-dead-subscribers]");

  // #5843: credencial + lista da Brevo são pré-condição do push. Sem elas o
  // fluxo antigo seguia em frente descadastrando gente na Beehiiv sem entregar
  // ninguém ao canal de destino — agora aborta antes de qualquer mutação.
  const brevoTarget = loadBrevoDiariaTarget();
  if (!brevoTarget.ok) {
    log(`ERRO: ${brevoTarget.reason} — nenhuma mutação aplicada.`);
    appendSunsetRoundLog({
      ...round,
      blast_radius: { blocked: false, ratio: guard.ratio, threshold: BLAST_RADIUS_THRESHOLD },
      queue: null,
      applied_count: 0,
      failed_count: 0,
      warned_count: 0,
      skipped: [
        ...alreadyInStoreSkipped,
        ...toConsider.map((s) => ({ email: s.email, reason: `brevo_target_unavailable: ${brevoTarget.reason}` })),
      ],
    });
    process.exitCode = 1;
    return;
  }

  // Cap da fila compartilhada com sync-pending-to-brevo.ts (item 4 da spec —
  // "respeitando o fluxo existente... cap da fila"). Lido de
  // platform.config.json → brevo_diaria.daily_send_cap, mesmo campo/fallback
  // de sync-pending-to-brevo.ts::DEFAULT_QUEUE_CAP.
  let cap = DEFAULT_QUEUE_CAP;
  try {
    const platformConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as {
      brevo_diaria?: { daily_send_cap?: number };
    };
    cap = platformConfig.brevo_diaria?.daily_send_cap ?? DEFAULT_QUEUE_CAP;
  } catch (e) {
    log(`aviso: falha ao ler platform.config.json (${(e as Error).message}) — usando cap default ${DEFAULT_QUEUE_CAP}.`);
  }
  const currentActiveCount = computeCurrentActiveCount(store.contacts);
  const availableSlots = computeAvailableSlots(currentActiveCount, cap);
  const toApply = applyQueueCapGate(toConsider, availableSlots);
  const toApplySet = new Set(toApply);
  const queueCapSkipped = toConsider.filter((s) => !toApplySet.has(s));
  log(`fila compartilhada (sync-pending-to-brevo.ts): ${currentActiveCount}/${cap} ocupados, ${availableSlots} slot(s) livre(s).`);
  if (queueCapSkipped.length > 0) {
    log(
      `${queueCapSkipped.length} candidato(s) NÃO aplicado(s) nesta rodada por falta de slot na fila ` +
        "(permanecem elegíveis pra próxima rodada — dedup pelo store).",
    );
  }

  let applied = 0;
  let failed = 0;
  let warned = 0;
  const pushFailedSkipped: { email: string; reason: string }[] = [];
  for (const s of toApply) {
    const { result, nextStore } = await applySunsetOne({
      input: s,
      snapshotDate: date,
      publicationId,
      beehiivApiKey,
      brevoApiKey: brevoTarget.apiKey,
      brevoListId: brevoTarget.listId,
      store,
      fetchImpl: fetch,
      logPath: DEFAULT_SUNSET_LOG_PATH,
    });
    store = nextStore;
    // Persistir a CADA iteração, não só no fim do loop: as mutações são reais
    // e irreversíveis (contato na lista Brevo, descadastrado na Beehiiv), e o
    // store é a única fonte do dedup e da contagem de cap. Um kill/crash no
    // meio do loop com escrita só no final perderia todas as mutações já
    // feitas — a mesma divergência store↔Brevo do #5843, pelo lado oposto.
    // `writeFileAtomic` de um JSON pequeno custa milissegundos.
    writeStore(store, DEFAULT_STORE_PATH);
    if (result.ok) {
      applied++;
      log(`  ${result.email} — ingerido na lista Brevo ${brevoTarget.listId} + unsubscribed na Beehiiv.`);
      for (const w of result.warnings ?? []) {
        warned++;
        log(`    ⚠ ${result.email}: ${w}`);
      }
    } else {
      failed++;
      log(`  FALHA em ${result.email}: ${result.error}`);
      pushFailedSkipped.push({ email: result.email, reason: `push_failed: ${result.error}` });
    }
  }
  writeStore(store, DEFAULT_STORE_PATH);
  log(`push concluído: ${applied} sunset(s) aplicado(s), ${failed} falha(s), ${warned} com pendência.`);
  appendSunsetRoundLog({
    ...round,
    blast_radius: { blocked: false, ratio: guard.ratio, threshold: BLAST_RADIUS_THRESHOLD },
    queue: { current_active: currentActiveCount, cap, available_slots: availableSlots },
    applied_count: applied,
    failed_count: failed,
    warned_count: warned,
    skipped: [
      ...alreadyInStoreSkipped,
      ...queueCapSkipped.map((s) => ({ email: s.email, reason: "queue_cap" })),
      ...pushFailedSkipped,
    ],
  });
  if (failed > 0 || warned > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[sunset-dead-subscribers] erro fatal: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}
