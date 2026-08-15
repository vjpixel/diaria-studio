/**
 * brevo-diaria-store.ts (#4266, formula/status atualizados no #4476)
 *
 * Store JSON simples (não SQLite — diferente de `clarice-db.ts`) que rastreia
 * o ciclo de vida de cada contato triado do segmento Pending da Beehiiv pro
 * canal Brevo próprio do editor:
 *
 *   beehiiv_pending → (ingestão) → in_brevo → (avaliação) →
 *     promoted_beehiiv  (openRate alto — item 1 do #4476 — OU auto-confirmação)
 *     OU suppressed     (openRate baixo — item 1 do #4476)
 *     OU unsubscribed   (descadastro NATIVO na Brevo — item 7 do #4476,
 *                        distinto de `suppressed`: ação própria da pessoa,
 *                        não decisão algorítmica por engajamento)
 *     OU permanece in_brevo ("keep")
 *
 * Arquivo em `data/brevo-diaria/contacts.json` (mesma convenção de
 * `data/clarice-subscribers/`: dado business-sensitive, fora do repo via
 * `.gitignore` blanket de `data/`).
 *
 * Deliberadamente SEM SQLite: volume esperado (segmento Pending da Beehiiv)
 * é pequeno o bastante (fila de tamanho fixo, 300 — #4476 item 5 — já é o
 * teto operacional) pra um JSON simples bastar — motivo #2 (junto com o
 * acoplamento node:sqlite) pra não reusar `clarice-db.ts` aqui.
 *
 * Toda lógica de transição de estado é PURA (recebe/devolve o array de
 * contatos) — leitura/escrita em disco ficam isoladas em `readStore`/
 * `writeStore`, injetáveis via `path` pra testes não tocarem `data/` real.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrevoDiariaAction } from "./shared/brevo-diaria-score.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_STORE_PATH = resolve(ROOT, "data/brevo-diaria/contacts.json");

export type BrevoDiariaContactStatus =
  | "in_brevo"
  | "promoted_beehiiv"
  | "suppressed"
  /** #4476 item 7 — descadastro NATIVO na Brevo (`emailBlacklisted:true`
   * detectado sem passar por avaliação de score), 3ª saída terminal
   * distinta de `suppressed` (ação própria da pessoa vs. decisão
   * algorítmica por engajamento baixo). */
  | "unsubscribed"
  /** #5351 Parte B — 4ª saída terminal, PURAMENTE LOCAL: `emailBlacklisted`
   * sem `userUnsubscription` (bounce ou ação admin-side na Brevo, #4630).
   * Sem clique do usuário este contato nunca recebe outra campanha —
   * `sends_count`/`messagesSent` congelam abaixo do piso de amostra da
   * avaliação normal, então sem esta saída dedicada o contato ficaria preso
   * `in_brevo` indefinidamente (ocupando 1 slot da fila de 300, gastando 1
   * `GET /contacts/{email}` por rodada pra sempre). Decisão do editor
   * (15/08/2026, issue #5351): NUNCA escrever na Beehiiv nesses casos — o
   * registro fica `Pending` lá de propósito (API v2 não tem campo `status`
   * gravável pra distinguir "bounce" de "inativo por qualquer outro
   * motivo"). */
  | "bounced";

export interface BrevoDiariaContact {
  email: string;
  /** id da subscription Beehiiv de origem (status Pending no momento da ingestão). */
  beehiiv_subscription_id: string;
  status: BrevoDiariaContactStatus;
  opens_count: number;
  sends_count: number;
  /** Taxa de abertura (0-1, `opens_count/sends_count`) da última avaliação
   * (`computeBrevoDiariaOpenRate`, #4476 item 1) — null antes da 1ª
   * avaliação. Renomeado de `last_score` (#4266) — a fórmula deixou de
   * produzir um score aditivo único, agora é taxa + piso de amostra (2
   * variáveis), então o campo persistido também precisa nomear o que
   * realmente guarda. */
  last_open_rate: number | null;
  added_at: string; // ISO — quando entrou no store (ingestão)
  last_evaluated_at: string | null; // ISO — última rodada de evaluate-brevo-diaria.ts
  promoted_at?: string; // ISO — quando status virou promoted_beehiiv
  suppressed_at?: string; // ISO — quando status virou suppressed
  /** ISO — quando status virou unsubscribed (#4476 item 7). */
  unsubscribed_at?: string;
  /** ISO — quando status virou bounced (#5351 Parte B). */
  bounced_at?: string;
  /** ISO — quando `resolution_reason` foi CORRIGIDO por
   * `applySuppressionReconciliation` (#5077), distinto de `suppressed_at`
   * (quando a supressão original aconteceu). Preserva as duas datas: "quando
   * foi suprimido" e "quando a auditoria foi corrigida" são eventos
   * diferentes e ambos interessam pra reconstruir a timeline real do
   * contato. */
  reconciled_at?: string;
  /** Motivo da supressão/promoção/descadastro — auditoria (#4266 self-review:
   * nunca silenciar POR QUE um contato saiu do fluxo). `native_unsubscribe_beehiiv_404`
   * (#4633) é uma variante do descadastro nativo: a propagação pra Beehiiv
   * encontrou HTTP 404 (nenhum registro de subscription pra esse e-mail —
   * falha PERMANENTE, não transitória) — marcado `unsubscribed` mesmo sem a
   * confirmação usual (`verifyUnsubscribedInBeehiiv`), já que não há o que
   * confirmar; a divergência fica registrada aqui pra auditoria.
   * `self_confirmed_after_suppression` (#5077) é uma CORREÇÃO retroativa de
   * `score_threshold`: o contato foi suprimido por engajamento baixo, mas
   * depois (clique tardio numa campanha antiga já na caixa de entrada,
   * observado fora da janela de avaliação normal) confirmou a subscription
   * na Beehiiv por conta própria — o `status` continua `suppressed` (não
   * volta a receber e-mails do canal, o funil funcionou como desenhado), só
   * o motivo registrado passa a contar a história real em vez de uma foto
   * tirada antes do desfecho. Ver `applySuppressionReconciliation`. */
  resolution_reason?:
    | "score_threshold"
    | "self_confirmed_beehiiv"
    | "native_unsubscribe"
    | "native_unsubscribe_beehiiv_404"
    | "self_confirmed_after_suppression"
    /** #5351 Parte B — `emailBlacklisted` com `statistics.hardBounces` não
     * vazio: bounce de entrega genuíno (endereço inválido/caixa cheia). */
    | "native_bounce"
    /** #5351 Parte B — `emailBlacklisted` sem `userUnsubscription` E sem
     * `hardBounces`: ação admin-side/complaint na Brevo, motivo exato não
     * distinguível pela API disponível. */
    | "native_admin_block";
}

export interface BrevoDiariaStore {
  contacts: BrevoDiariaContact[];
}

function emptyStore(): BrevoDiariaStore {
  return { contacts: [] };
}

/** Lê o store do path dado (default `data/brevo-diaria/contacts.json`).
 * Arquivo ausente → store vazio (1ª execução, nunca erro). */
export function readStore(path: string = DEFAULT_STORE_PATH): BrevoDiariaStore {
  if (!existsSync(path)) return emptyStore();
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return emptyStore();
  const parsed = JSON.parse(raw) as Partial<BrevoDiariaStore>;
  return { contacts: Array.isArray(parsed.contacts) ? parsed.contacts : [] };
}

/** Escreve o store (cria o diretório pai se necessário). */
export function writeStore(store: BrevoDiariaStore, path: string = DEFAULT_STORE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n");
}

/** Pura — email normalizado (lowercase/trim), mesma convenção do resto do repo. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function findContact(store: BrevoDiariaStore, email: string): BrevoDiariaContact | undefined {
  const norm = normalizeEmail(email);
  return store.contacts.find((c) => c.email === norm);
}

/**
 * Pura — adiciona um contato novo ao store (ingestão). NUNCA sobrescreve um
 * contato já existente (idempotência: a mesma pessoa não é re-ingerida a
 * cada rodada de `sync-pending-to-brevo.ts` — dedup pelo store, não pela
 * Beehiiv, ver comentário de design em `sync-pending-to-brevo.ts`).
 * Retorna o store inalterado (mesma referência não garantida — novo objeto)
 * se o contato já existir.
 */
export function upsertIngested(
  store: BrevoDiariaStore,
  input: { email: string; beehiiv_subscription_id: string },
  now: string = new Date().toISOString(),
): BrevoDiariaStore {
  const norm = normalizeEmail(input.email);
  if (store.contacts.some((c) => c.email === norm)) return store;
  const contact: BrevoDiariaContact = {
    email: norm,
    beehiiv_subscription_id: input.beehiiv_subscription_id,
    status: "in_brevo",
    opens_count: 0,
    sends_count: 0,
    last_open_rate: null,
    added_at: now,
    last_evaluated_at: null,
  };
  return { contacts: [...store.contacts, contact] };
}

/**
 * Pura — aplica o resultado de uma avaliação de score a um contato existente
 * (by email). Só contatos com status `in_brevo` são elegíveis pra transição —
 * um contato já `promoted_beehiiv`/`suppressed` é noop (re-avaliação depois
 * da resolução não deveria acontecer, mas se o caller passar um email
 * resolvido por engano, isto não regride o estado).
 */
export function applyEvaluation(
  store: BrevoDiariaStore,
  email: string,
  update: { opens_count: number; sends_count: number; open_rate: number; action: BrevoDiariaAction },
  now: string = new Date().toISOString(),
): BrevoDiariaStore {
  const norm = normalizeEmail(email);
  return {
    contacts: store.contacts.map((c) => {
      if (c.email !== norm || c.status !== "in_brevo") return c;
      const base: BrevoDiariaContact = {
        ...c,
        opens_count: update.opens_count,
        sends_count: update.sends_count,
        last_open_rate: update.open_rate,
        last_evaluated_at: now,
      };
      if (update.action === "promote_to_beehiiv") {
        return { ...base, status: "promoted_beehiiv", promoted_at: now, resolution_reason: "score_threshold" };
      }
      if (update.action === "suppress") {
        return { ...base, status: "suppressed", suppressed_at: now, resolution_reason: "score_threshold" };
      }
      return base; // "keep" — permanece in_brevo, contadores/taxa atualizados
    }),
  };
}

/**
 * Pura — marca um contato como promovido por AUTO-CONFIRMAÇÃO (a pessoa
 * confirmou o double opt-in da Beehiiv por conta própria, independente do
 * score) em vez de threshold. Fecha o gap de duplicidade que a própria issue
 * #4266 registrou como risco não resolvido: "quem confirma o opt-in depois
 * de já ter recebido via Brevo passa a estar nas duas bases" — a avaliação
 * periódica (`evaluate-brevo-diaria.ts`) checa o status Beehiiv atual de
 * cada contato `in_brevo` e usa esta função quando encontra `status=active`
 * (já confirmado no Beehiiv por iniciativa própria).
 */
export function applySelfConfirmed(
  store: BrevoDiariaStore,
  email: string,
  now: string = new Date().toISOString(),
): BrevoDiariaStore {
  const norm = normalizeEmail(email);
  return {
    contacts: store.contacts.map((c) => {
      if (c.email !== norm || c.status !== "in_brevo") return c;
      return { ...c, status: "promoted_beehiiv", promoted_at: now, resolution_reason: "self_confirmed_beehiiv" };
    }),
  };
}

/**
 * Pura — marca um contato como DESCADASTRADO NATIVAMENTE na Brevo (#4476
 * item 7): `emailBlacklisted === true` detectado ANTES de qualquer avaliação
 * de score (a pessoa clicou no link de opt-out do bloco de intro, a Brevo
 * processa nativamente, sem passar por `evaluate-brevo-diaria.ts`). Saída
 * TERMINAL distinta de `applyEvaluation(..., action: "suppress")` — o motivo
 * é auditável separadamente (`resolution_reason: "native_unsubscribe"`):
 * "descadastrado por ação própria" não é o mesmo evento que "suprimido por
 * engajamento baixo", mesmo que ambos liberem o slot da fila (item 5) do
 * mesmo jeito. Mesmo guard de idempotência dos outros `apply*` — só contatos
 * `in_brevo` transicionam; um contato já resolvido nunca regride.
 *
 * @param reason (#4633) — override pro caso HTTP 404 permanente na
 * propagação (`native_unsubscribe_beehiiv_404`, ver
 * `RunEvaluationParams`/`runEvaluation` em `evaluate-brevo-diaria.ts`);
 * default `"native_unsubscribe"` cobre o caso confirmado normalmente
 * (releitura mostrou `inactive`).
 */
export function applyNativeUnsubscribe(
  store: BrevoDiariaStore,
  email: string,
  now: string = new Date().toISOString(),
  reason: Extract<BrevoDiariaContact["resolution_reason"], "native_unsubscribe" | "native_unsubscribe_beehiiv_404"> = "native_unsubscribe",
): BrevoDiariaStore {
  const norm = normalizeEmail(email);
  return {
    contacts: store.contacts.map((c) => {
      if (c.email !== norm || c.status !== "in_brevo") return c;
      return { ...c, status: "unsubscribed", unsubscribed_at: now, resolution_reason: reason };
    }),
  };
}

/**
 * Pura — marca um contato como `bounced` (#5351 Parte B): `emailBlacklisted`
 * na Brevo SEM `userUnsubscription` (não é descadastro por clique do
 * usuário — ver `applyNativeUnsubscribe`/`hasUserUnsubscription` em
 * `evaluate-brevo-diaria.ts`). Saída TERMINAL puramente LOCAL — decisão do
 * editor (15/08/2026): nunca escreve na Beehiiv, o registro fica `Pending`
 * lá de propósito. Libera o slot da fila sem tocar
 * `computeCurrentActiveCount` (que já só conta `status === "in_brevo"`) e
 * sem tocar `computeContactsToIngest` (o e-mail permanece no array do
 * store, então o dedup de `sync-pending-to-brevo.ts` continua funcionando —
 * nunca reentra). Mesmo guard de idempotência dos outros `apply*` acima —
 * só contatos `in_brevo` transicionam.
 *
 * @param reason `"native_bounce"` quando `statistics.hardBounces` não
 * vazio, `"native_admin_block"` caso contrário — decidido pelo caller a
 * partir do MESMO `GET /contacts/{email}` já feito (`fetchBrevoContactState`
 * ganha o campo `hardBounced`), zero chamada nova.
 */
export function applyBrevoDiariaBounced(
  store: BrevoDiariaStore,
  email: string,
  reason: Extract<BrevoDiariaContact["resolution_reason"], "native_bounce" | "native_admin_block">,
  now: string = new Date().toISOString(),
): BrevoDiariaStore {
  const norm = normalizeEmail(email);
  return {
    contacts: store.contacts.map((c) => {
      if (c.email !== norm || c.status !== "in_brevo") return c;
      return { ...c, status: "bounced", bounced_at: now, resolution_reason: reason };
    }),
  };
}

/**
 * Pura — CORRIGE o `resolution_reason` de um contato já `suppressed` por
 * `score_threshold` quando uma releitura posterior mostra que a pessoa
 * confirmou a subscription na Beehiiv depois da supressão (#5077 — clique
 * tardio numa campanha antiga ainda parada na caixa de entrada, horas/dias
 * depois de `evaluate-brevo-diaria.ts --push` já ter suprimido o contato por
 * engajamento baixo).
 *
 * **NUNCA reverte `status`** — o contato continua `suppressed` (não volta a
 * receber e-mails deste canal; o funil de reativação já ativou a subscription
 * na Beehiiv diretamente, por fora deste store, e isso está correto: a
 * pessoa não precisa das DUAS entregas). Isto é estritamente uma correção de
 * AUDITORIA: `resolution_reason` passa a contar "confirmou depois de
 * suprimido" em vez de "score baixo" — a foto tirada ANTES do desfecho real.
 *
 * Guard de idempotência/escopo (mesmo padrão dos outros `apply*` acima): só
 * transiciona contatos com `status === "suppressed"` E
 * `resolution_reason === "score_threshold"` — um contato ainda `in_brevo`,
 * já reconciliado (`self_confirmed_after_suppression`), ou suprimido por
 * qualquer motivo que não seja o score algorítmico (não existe hoje, mas a
 * guarda é defensiva) fica inalterado. Chamar 2x com o mesmo contato já
 * reconciliado é noop na 2ª chamada — o `resolution_reason` não bate mais
 * com `"score_threshold"`.
 *
 * `suppressed_at` (quando a supressão original aconteceu) é preservado sem
 * alteração — `reconciled_at` (novo campo) registra separadamente quando a
 * auditoria foi corrigida.
 */
export function applySuppressionReconciliation(
  store: BrevoDiariaStore,
  email: string,
  now: string = new Date().toISOString(),
): BrevoDiariaStore {
  const norm = normalizeEmail(email);
  return {
    contacts: store.contacts.map((c) => {
      if (c.email !== norm || c.status !== "suppressed" || c.resolution_reason !== "score_threshold") return c;
      return { ...c, reconciled_at: now, resolution_reason: "self_confirmed_after_suppression" };
    }),
  };
}
