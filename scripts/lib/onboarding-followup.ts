/**
 * onboarding-followup.ts (#10604, #10605, #10606)
 *
 * Núcleo PURO das duas sequências que vêm DEPOIS da escada de boas-vindas
 * (e-mails 1/2/3 em D0/D+3/D+10, `onboarding-state.ts`):
 *
 *  - **Pedido de apoio (#10604)** em D+30, D+90, D+180 e D+360 contados do
 *    CADASTRO (`created_at` do assinante no Kit), só para quem não apoia e
 *    está ativo.
 *  - **Formulário de perfil/interesses (#10605)** com DOIS convites: o e-mail
 *    D+6 da escada (`form`, antes do pedido de apoio do e-mail 3) e o e-mail
 *    ÚNICO para a base já cadastrada (`form_base`, rascunho montado por
 *    `scripts/onboarding-form-base-prep.ts`, enviado à mão pelo editor no
 *    Kit). Para quem recebeu QUALQUER um dos dois e não respondeu, até 3
 *    lembretes, um texto por lembrete (`form_lembrete`, `form_lembrete2`,
 *    `form_lembrete3`, decisão do editor de 09/11/2026). Quem recebeu o D+6
 *    recebe em D+19, D+49 e D+79 da âncora (`form_reminder_days_onboarding`);
 *    quem recebeu o e-mail da base, 30 dias depois do envio anterior
 *    (`form_reminder_days`). O convite que a pessoa recebeu fica em
 *    `people[id].form_invite`. Âncora do D+6 = a mesma da escada
 *    (`reguaAnchorSec`, a confirmação do double opt-in), porque o formulário
 *    entra NA escada.
 *
 * Sem I/O: tudo recebe valores e devolve valores. O executor
 * (`scripts/onboarding-followup-run.ts`) lê o Kit/store e chama isto.
 *
 * ## Regras que este módulo torna estruturais
 *
 * - **Nunca atrasada (base atual, #10604).** Cada etapa só sai dentro da sua
 *   janela `[D+N, D+N+grace)`. Quem já passou da janela — a base existente na
 *   data em que a sequência entra no ar, ou alguém cuja etapa caiu num período
 *   de envio travado — pula a etapa e segue para a PRÓXIMA ainda não vencida,
 *   nunca recebe as atrasadas de uma vez. Mesma decisão do editor que
 *   descartou o backlog do e-mail 3 (#10603). O 1º e-mail do formulário segue
 *   a mesma janela; os lembretes não têm janela. EXCEÇÃO: etapa adiada pela
 *   regra de pedidos (abaixo) nunca vira `vencida` por isso
 *   (`people[id].ask_deferred`).
 * - **Idempotência.** Cada etapa de apoio sai no máximo 1 vez por pessoa
 *   (registro em `people[id].sends`, gravado só depois de o broadcast ser
 *   relido agendado/enviado). O lembrete do formulário sai no máximo 1 vez por
 *   janela de 30 dias (conta do último envio de formulário registrado).
 * - **Só quem não apoia / só ativo.** A checagem é feita PERTO DO ENVIO, pela
 *   leitura singular do assinante no Kit (`GET /subscribers/{id}`: `state` e
 *   o custom field `apoio_nivel`), nunca pelo snapshot da listagem (que serve
 *   `fields` defasado). Leitura que falha nunca autoriza envio.
 *   `apoio_nivel` não zera na virada do mês: o sync (`sync-apoio-nivel-kit.ts`)
 *   aplica carência de 1 mês (#4436).
 * - **Regra de pedidos (decisão do editor de 09/11/2026).** Depois do
 *   primeiro mês da pessoa (a âncora mais antiga conhecida, cadastro ou
 *   confirmação, + `ASK_RULE_STARTS_AFTER_DAYS`), dois PEDIDOS nunca saem a
 *   10 dias ou menos um do outro: intervalo mínimo `ask_min_gap_days` (11,
 *   substituiu o `min_gap_days: 7` antigo). Pedido = `isAsk(kind)`: todas as
 *   etapas destas sequências (apoio, convites e lembretes do formulário) e o
 *   e-mail 3 da escada (pedido de apoio do D+10), que conta como pedido
 *   anterior mas sai no primeiro mês, fora desta regra. Edições diárias não
 *   contam. O pedido que cai perto de outro ESPERA, nunca é pulado: a etapa
 *   adiada ganha `ask_deferred` e deixa de vencer pela janela. Se apoio e
 *   formulário vencem juntos, sai o de apoio e o de formulário espera.
 * - **Envio TRAVADO até os textos serem aprovados.** Os 4 textos de apoio
 *   (`data/snippets/apoio-{30,90,180,360}.md`) destravam a sequência de apoio
 *   JUNTOS; os 4 do formulário (`onboarding-formulario.md`,
 *   `formulario-lembrete-{1,2,3}.md`) mais a URL do formulário destravam a de
 *   formulário. Arquivo ausente, marcador `ONBOARDING-CORPO-PENDENTE`, assunto
 *   ou corpo faltando: bloqueio EXPLÍCITO com motivo, nunca erro silencioso.
 * - **Teto de lote, em lotes parciais (#10631).** Uma etapa com mais elegíveis
 *   que `max_recipients_per_lot` manda até o teto na rodada (cadastro mais
 *   antigo primeiro) e deixa o restante para os dias seguintes, dentro da
 *   janela da etapa (`adiado_teto`, não é falha). Protege contra a coorte
 *   migrada em bloco carregar `created_at` da importação e cair inteira no
 *   mesmo D+N sem barrar a etapa para todo mundo. Ver `splitDueByCap`.
 */

import type { OnboardingEntry } from "./onboarding-store.ts";
import type { KitBroadcastLot } from "./onboarding-kit-transport.ts";
import { PENDING_BODY_MARKER, parseOnboardingSnippet, reguaAnchorSec, type OnboardingSnippet } from "./onboarding-state.ts";
import { checkLinkSecret, FORM_SIG_KIT_FIELD } from "./onboarding-form-link-sig.ts";
import { latestFormResponses } from "./onboarding-form-contract.ts";

const DAY_S = 86_400;

// ---------------------------------------------------------------------------
// Etapas
// ---------------------------------------------------------------------------

export type ApoioStepKind = "apoio30" | "apoio90" | "apoio180" | "apoio360";
/** `form` = convite D+6 da escada; `form_base` = convite único da base já
 *  cadastrada (nunca sai pelo executor diário: o rascunho é montado por
 *  `onboarding-form-base-prep.ts` e o envio é do editor); `form_lembrete` =
 *  lembrete, para quem recebeu qualquer um dos dois convites. */
export type FormReminderKind = "form_lembrete" | "form_lembrete2" | "form_lembrete3";
export type FormStepKind = "form" | "form_base" | FormReminderKind;
/** Os dois convites do formulário. */
export type FormInviteKind = "form" | "form_base";
export type FollowupStepKind = ApoioStepKind | FormStepKind;

export const APOIO_STEPS: readonly { kind: ApoioStepKind; days: number; snippetFile: string }[] = [
  { kind: "apoio30", days: 30, snippetFile: "apoio-30.md" },
  { kind: "apoio90", days: 90, snippetFile: "apoio-90.md" },
  { kind: "apoio180", days: 180, snippetFile: "apoio-180.md" },
  { kind: "apoio360", days: 360, snippetFile: "apoio-360.md" },
];

/** Os 3 lembretes, em ordem: o N-ésimo lembrete da pessoa usa o N-ésimo
 *  texto (decisão do editor de 09/11/2026). `form_lembrete` (sem número) é o
 *  1º, o mesmo nome de antes, para registros antigos continuarem valendo. */
export const FORM_REMINDER_STEPS: readonly { kind: FormReminderKind; snippetFile: string }[] = [
  { kind: "form_lembrete", snippetFile: "formulario-lembrete-1.md" },
  { kind: "form_lembrete2", snippetFile: "formulario-lembrete-2.md" },
  { kind: "form_lembrete3", snippetFile: "formulario-lembrete-3.md" },
];

export const FORM_STEPS: readonly { kind: FormStepKind; snippetFile: string }[] = [
  { kind: "form", snippetFile: "onboarding-formulario.md" },
  ...FORM_REMINDER_STEPS,
];

export function isFormReminder(kind: string): kind is FormReminderKind {
  return FORM_REMINDER_STEPS.some((s) => s.kind === kind);
}

/** Pedido do e-mail 3 da escada (D+10, `onboarding-state.ts`) — fora destas
 *  sequências, mas conta como pedido anterior na regra de espaçamento. */
export const WELCOME_EMAIL3_ASK = "email3";

/**
 * Ponto ÚNICO que diz o que é PEDIDO para a regra de espaçamento (decisão do
 * editor de 09/11/2026): todas as etapas destas sequências (pedidos de apoio,
 * convites e lembretes do formulário) e o e-mail 3 da escada. Pedido novo
 * entra aqui, sem regra própria. Edições diárias (e os e-mails 1 e 2 da
 * escada) não são pedido.
 */
export function isAsk(kind: string): boolean {
  return isApoioStep(kind) || isFormStep(kind) || kind === WELCOME_EMAIL3_ASK;
}

/** Convite único para a base já cadastrada (#10605, decisão 11 do editor).
 *  Fora de `FORM_STEPS` de propósito: o gate da escada (`formContentGate`)
 *  não depende do texto dele, e ele nunca entra no plano diário. */
export const FORM_BASE_STEP: { kind: "form_base"; snippetFile: string } = { kind: "form_base", snippetFile: "pesquisa-base.md" };

export const ALL_FOLLOWUP_STEPS: readonly FollowupStepKind[] = [
  ...APOIO_STEPS.map((s) => s.kind),
  ...FORM_STEPS.map((s) => s.kind),
  FORM_BASE_STEP.kind,
];

export function isApoioStep(kind: string): kind is ApoioStepKind {
  return APOIO_STEPS.some((s) => s.kind === kind);
}

export function isFormStep(kind: string): kind is FormStepKind {
  return kind === "form" || kind === "form_base" || isFormReminder(kind);
}

export function isFormInvite(kind: string): kind is FormInviteKind {
  return kind === "form" || kind === "form_base";
}

export function snippetFileFor(kind: FollowupStepKind): string {
  const apoio = APOIO_STEPS.find((s) => s.kind === kind);
  if (apoio) return apoio.snippetFile;
  if (kind === FORM_BASE_STEP.kind) return FORM_BASE_STEP.snippetFile;
  return FORM_STEPS.find((s) => s.kind === kind)!.snippetFile;
}

/** Placeholder que o corpo dos e-mails de formulário precisa conter — vira o
 *  link do formulário com o e-mail pré-preenchido (merge tag do Kit). */
export const FORM_URL_PLACEHOLDER = "{{FORM_URL}}";

// ---------------------------------------------------------------------------
// Store (namespace `followup` de data/onboarding/store.json)
// ---------------------------------------------------------------------------

export interface FollowupSendRecord {
  step: FollowupStepKind;
  /** ISO do envio (o `send_at` relido do broadcast). */
  at: string;
  lot_id: string;
}

export interface FollowupSkipRecord {
  step: FollowupStepKind;
  /** ISO de quando a etapa foi pulada para esta pessoa (terminal pra etapa). */
  at: string;
  /** `apoia`: na checagem perto do envio, a pessoa já apoiava — a etapa de
   *  apoio não sai para ela (a próxima ainda é avaliada de novo).
   *  `nao_ativo` (#10675): na checagem perto do envio, a pessoa não estava
   *  mais `active` no Kit (descadastrou, bounce, cancelada). Terminal para a
   *  etapa; numa etapa de FORMULÁRIO encerra a sequência inteira do
   *  formulário (`formStepDue` → `saiu`) — senão o lembrete, que não tem
   *  janela, ficaria devido para sempre e ocuparia o teto do lote. Não
   *  ressuscita se a pessoa voltar a se inscrever. */
  motivo: "apoia" | "nao_ativo";
}

export interface FollowupPerson {
  kit_subscriber_id: number;
  email: string;
  /** ISO — `created_at` do Kit na última vez que a pessoa foi vista. */
  cadastro_at: string | null;
  sends: FollowupSendRecord[];
  skips?: FollowupSkipRecord[];
  /** Resultado da última checagem de apoio perto do envio (`null` = nunca checado). */
  apoia?: boolean | null;
  apoio_checked_at?: string | null;
  /** ISO — quando preencheu o formulário (para os lembretes na hora). */
  form_filled_at?: string | null;
  /** Respostas do formulário, como vieram do Worker (#10605) — as do envio mais recente. */
  form_answers?: Record<string, string>;
  /** ISO do envio de onde vieram `form_answers` (#12490: a pessoa pode reenviar). */
  form_answers_at?: string | null;
  /** #10605 (regra A do editor, 08/11/2026): qual convite do formulário a
   *  pessoa recebeu primeiro — `form` (D+6 da escada) ou `form_base` (e-mail
   *  único da base). Gravado junto do envio confirmado. Ausente não prova
   *  "nenhum convite" (registro anterior ao campo): ler sempre por
   *  `formInviteOf`, que deriva de `sends`. O lembrete vale para os dois. */
  form_invite?: FormInviteKind;
  /** #10605 (regra de pedidos, 09/11/2026): etapas COM JANELA (apoio, convite
   *  D+6) que a regra de espaçamento adiou. Etapa aqui nunca vira `vencida`
   *  pela janela: o pedido espera, nunca é pulado. Gravado na 1ª rodada
   *  `--send` que adiou; sem efeito depois que a etapa tem envio/pulo. */
  ask_deferred?: { step: FollowupStepKind; at: string }[];
  /** #10763: etapas cuja leitura singular falhou na última tentativa (transitório,
   *  NUNCA pulo terminal). Só rebaixa a pessoa na ordem do teto; sai no 1º sucesso. */
  live_failures?: { step: FollowupStepKind; at: string; n: number }[];
  /** #10774: e-mails anteriores (normalizados, mais recente por último) de
   *  quem trocou de e-mail no Kit. `applyFormResponses` também casa por eles:
   *  uma resposta assinada com o e-mail antigo continua valendo. */
  previous_emails?: string[];
}

/** Lote Kit de uma etapa destas sequências — mesma forma do lote da escada. */
export type FollowupLot = Omit<KitBroadcastLot, "kind"> & { kind: FollowupStepKind };

export type FollowupBlockReason =
  | "snippet_ausente"
  | "texto_pendente"
  | "snippet_invalido"
  | "form_nao_configurado"
  /** #10657: `ONBOARDING_FORM_LINK_SECRET` ausente ou curto no executor — sem
   *  ele o link sairia sem assinatura e o Worker recusaria (fail-closed). */
  | "assinatura_nao_configurada"
  /** #10657: o Kit não guardou o custom field `form_sig` (releitura sem o
   *  campo: ele não existe na conta e o Kit descarta a chave em silêncio). */
  | "campo_assinatura_ausente"
  /** #10657: a sonda de ponta a ponta (`GET {form_url}?email=...&sig=...`)
   *  não voltou 200 — segredo diferente do Worker, Worker defasado ou
   *  `form_url` errado. Ninguém recebe link que o Worker recusaria. */
  | "link_rejeitado_pelo_worker"
  | "respostas_indisponiveis"
  | "kit_indisponivel"
  | "desligado";

export interface FollowupRunRecord {
  at: string;
  /** `null` = sequência liberada nesta rodada. */
  apoio_blocked: { motivo: FollowupBlockReason; detalhe: string } | null;
  form_blocked: { motivo: FollowupBlockReason; detalhe: string } | null;
  lots_created: number;
  lots_failed: number;
  /** Etapas que não saíram por passar do teto de lote (`max_recipients_per_lot`).
   *  Desde o #10631 o teto corta em lote parcial (o excedente aparece em
   *  `counts[etapa].adiado_teto`), então isto só sobe pela defesa em
   *  profundidade pós-checagem — que não deveria disparar. */
  over_cap: number;
  /** #10652: etapas cujo excedente do teto não cabe na janela de cada
   *  pessoa (capacidade por pessoa desde #10660, ver
   *  `capWindowOverflows`) — gente que vai virar `vencida` sem receber.
   *  Conta como rodada falha (alarme de continuidade + exit 1). Opcional:
   *  registros anteriores não têm o campo. */
  cap_window_overflow?: number;
  /** Consultas ao Kit que falharam e contam como rodada falha: listagem/tag
   *  (travam a sequência) e, desde o #10676, só as leituras singulares cujo
   *  adiamento NÃO é seguro (ver `classifyLookupFailures`). */
  lookups_failed: number;
  /** #10676: leituras singulares que falharam depois do retry da rodada mas
   *  foram adiadas com segurança (a pessoa volta amanhã, dentro da janela) —
   *  não contam como falha. Opcional: registros anteriores não têm o campo. */
  lookups_deferred?: number;
  /** #10628: lotes que seguem sem confirmação depois da releitura do início do
   *  `--send` (releitura falhou, ou rascunho que não deu pra apagar). Opcional:
   *  registros anteriores não têm o campo. */
  lots_unresolved?: number;
  /** #10605: a releitura do e-mail da base falhou (404, status `aborted` ou
   *  desconhecido, filtro divergente/não ecoado) ou ele está `divergent`.
   *  Conta como rodada falha. Opcional: registros anteriores não têm o campo. */
  base_invite_failed?: number;
  /** Por etapa: contagem de enviados nesta rodada e de pulados/adiados por motivo. */
  counts: Partial<Record<FollowupStepKind, Record<string, number>>>;
  aborted?: boolean;
  error?: string | null;
}

/**
 * #10605 (decisão 11 do editor): o rascunho do e-mail único para a base,
 * montado por `onboarding-form-base-prep.ts --step draft --apply`. Fica FORA
 * de `lots` de propósito: um lote `created` com broadcast é tratado pelo
 * executor diário como "não resolvido", e a releitura dele APAGARIA um
 * rascunho que não foi agendado. Os envios por pessoa (`form_base`) só são
 * gravados por `--step confirm`, depois que o editor agendou/enviou no Kit e
 * a releitura do broadcast confirmou.
 */
export interface FollowupBaseInvite {
  lot_id: string;
  tag_name: string;
  tag_id: number | null;
  broadcast_id: number | null;
  recipient_subscription_ids: string[];
  recipient_emails: string[];
  /** `pending` = reivindicado, sem broadcast; `draft` = rascunho no Kit;
   *  `scheduled` = o editor agendou no Kit (relido a cada rodada; desagendado
   *  volta a `draft`), ainda sem registro por pessoa; `divergent` = a
   *  audiência do rascunho não foi confirmada e a exclusão dele não foi
   *  confirmada (gravado ANTES de tentar apagar): nada é marcado como enviado
   *  até `--step reset`; `sent` = o Kit mostrou o broadcast saindo/saído
   *  (`sending`/`completed`) e o envio foi gravado por pessoa;
   *  `sent_unverified` = terminal, só por `--step reset --mark-sent-unverified
   *  --force` quando o Kit mostra o broadcast saindo/saído mas a audiência
   *  nunca foi confirmada: para o alarme e libera o D+6 dos destinatários
   *  gravados, SEM registro `form_base` por pessoa (o público real é
   *  desconhecido) — o lembrete não se aplica a esse convite. */
  status: "pending" | "draft" | "scheduled" | "divergent" | "sent" | "sent_unverified";
  created_at: string;
  send_at: string | null;
  confirmed_at: string | null;
  last_error: string | null;
  /** Tentativa de montagem (1, 2, ...): a tag do lote leva o número quando
   *  a tentativa anterior deixou na tag gente fora do público novo. Ausente = 1. */
  attempt?: number;
  /** ISO de quando `createBroadcast` foi chamado nesta tentativa. Com o
   *  broadcast ainda nulo (timeout, queda no meio), o Kit PODE ter criado o
   *  rascunho: a montagem seguinte recusa até `--step reset --force`. */
  create_attempted_at?: string | null;
}

/** Status do e-mail da base em que pode existir broadcast no Kit para os
 *  destinatários gravados (rascunho, agendado, ou exclusão não confirmada). */
export function baseInviteMayExist(invite: Pick<FollowupBaseInvite, "status" | "broadcast_id" | "create_attempted_at"> | null | undefined): boolean {
  if (!invite) return false;
  if (invite.status === "draft" || invite.status === "scheduled" || invite.status === "divergent") return true;
  return invite.status === "pending" && (invite.broadcast_id != null || invite.create_attempted_at != null);
}

/**
 * @pure — #10605 (item 8 do review): enquanto o e-mail da base pode sair
 * (`baseInviteMayExist`), os destinatários dele não recebem o D+6 — senão
 * quem o editor agendasse tarde receberia os dois convites. Quem responde o
 * formulário entre o rascunho e o envio continua no público congelado da tag
 * do lote (aceito: tirar da tag exigiria uma escrita por pessoa no Kit).
 */
export function baseInviteRecipientIds(invite: FollowupBaseInvite | null | undefined): Set<string> {
  return baseInviteMayExist(invite) ? new Set(invite!.recipient_subscription_ids) : new Set();
}

export interface FollowupBlock {
  people: Record<string, FollowupPerson>;
  lots: Record<string, FollowupLot>;
  base_invite?: FollowupBaseInvite | null;
  last_run?: FollowupRunRecord | null;
  consecutive_failed_runs?: number;
}

// ---------------------------------------------------------------------------
// Config (`platform.config.json` → `onboarding.followup`)
// ---------------------------------------------------------------------------

export interface FollowupConfigRaw {
  enabled?: boolean;
  grace_days?: number;
  /** Intervalo mínimo entre pedidos depois do 1º mês (regra de 09/11/2026: 11). */
  ask_min_gap_days?: number;
  form_first_days?: number;
  /** Lembretes de quem recebeu o convite da BASE: dias depois do envio anterior. */
  form_reminder_days?: number;
  /** Lembretes de quem recebeu o convite do ONBOARDING: dias da âncora (`[19, 49, 79]`). */
  form_reminder_days_onboarding?: number[];
  /** #10605: teto de lembretes por pessoa (decisão do editor de 08/11/2026: 3). */
  form_reminder_max?: number;
  /** #10605 regra B: o e-mail da base exclui quem vai receber o D+6 em até N dias. */
  base_invite_window_days?: number;
  max_recipients_per_lot?: number;
  form_url?: string | null;
  form_responses_url?: string | null;
  form_responses_token_env?: string;
}

export interface FollowupConfig {
  enabled: boolean;
  graceDays: number;
  askMinGapDays: number;
  formFirstDays: number;
  formReminderDays: number;
  formReminderDaysOnboarding: number[];
  formReminderMax: number;
  baseInviteWindowDays: number;
  maxRecipientsPerLot: number;
  formUrl: string | null;
  formResponsesUrl: string | null;
  formResponsesTokenEnv: string;
}

function posInt(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : dflt;
}

/** Default dos lembretes do onboarding (dias da âncora). */
export const DEFAULT_FORM_REMINDER_DAYS_ONBOARDING: readonly number[] = [19, 49, 79];

/** Lista crescente de inteiros positivos; qualquer coisa fora disso cai no default. */
function reminderDays(v: unknown): number[] {
  const ok =
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x, i) => typeof x === "number" && Number.isInteger(x) && x > 0 && (i === 0 || x > (v[i - 1] as number)));
  return ok ? [...(v as number[])] : [...DEFAULT_FORM_REMINDER_DAYS_ONBOARDING];
}

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** @pure — valores inválidos caem no default (nunca 0/negativo). */
export function resolveFollowupConfig(raw: FollowupConfigRaw | undefined | null): FollowupConfig {
  const r = raw ?? {};
  return {
    enabled: r.enabled === true,
    graceDays: posInt(r.grace_days, 10),
    askMinGapDays: posInt(r.ask_min_gap_days, 11),
    formFirstDays: posInt(r.form_first_days, 6),
    formReminderDays: posInt(r.form_reminder_days, 30),
    formReminderDaysOnboarding: reminderDays(r.form_reminder_days_onboarding),
    formReminderMax: posInt(r.form_reminder_max, 3),
    baseInviteWindowDays: posInt(r.base_invite_window_days, 7),
    maxRecipientsPerLot: posInt(r.max_recipients_per_lot, 300),
    formUrl: nonEmpty(r.form_url),
    formResponsesUrl: nonEmpty(r.form_responses_url),
    formResponsesTokenEnv: nonEmpty(r.form_responses_token_env) ?? "ONBOARDING_FORM_TOKEN",
  };
}

// ---------------------------------------------------------------------------
// Textos (data/snippets/*.md) — envio travado até aprovação
// ---------------------------------------------------------------------------

export type FollowupSnippets = Partial<Record<FollowupStepKind, OnboardingSnippet | null>>;

/** Mesmo formato dos `onboarding-{1,2,3}.md` (cabeçalho em comentário HTML). */
export function parseFollowupSnippet(raw: string | null): OnboardingSnippet | null {
  return parseOnboardingSnippet(raw, 0);
}

export type ContentGate = { blocked: false } | { blocked: true; motivo: FollowupBlockReason; detalhe: string };

function checkSnippet(kind: FollowupStepKind, snip: OnboardingSnippet | null | undefined): ContentGate {
  const file = `data/snippets/${snippetFileFor(kind)}`;
  if (snip == null) return { blocked: true, motivo: "snippet_ausente", detalhe: `${file} não existe` };
  if (snip.hasPendingMarker) {
    return { blocked: true, motivo: "texto_pendente", detalhe: `${file} contém ${PENDING_BODY_MARKER} (texto aguardando aprovação do editor)` };
  }
  if (!snip.assunto) return { blocked: true, motivo: "snippet_invalido", detalhe: `${file} sem 'assunto:' no cabeçalho` };
  if (!snip.body) return { blocked: true, motivo: "snippet_invalido", detalhe: `${file} sem corpo` };
  return { blocked: false };
}

/** @pure — a sequência de apoio só destrava com os 4 textos aprovados. Um
 *  `{{FORM_URL}}` num texto de apoio TRAVA (#10657): o placeholder só é
 *  trocado nas etapas do formulário, e o leitor receberia o texto cru. */
export function apoioContentGate(snippets: FollowupSnippets): ContentGate {
  for (const step of APOIO_STEPS) {
    const gate = checkSnippet(step.kind, snippets[step.kind]);
    if (gate.blocked) return gate;
    if (snippets[step.kind]!.body.includes(FORM_URL_PLACEHOLDER)) {
      return {
        blocked: true,
        motivo: "snippet_invalido",
        detalhe: `data/snippets/${step.snippetFile} contém ${FORM_URL_PLACEHOLDER}, que só vale nos e-mails do formulário (o leitor veria o texto cru)`,
      };
    }
  }
  return { blocked: false };
}

/** Gate do formulário: liberado carrega o segredo JÁ validado (trim +
 *  tamanho mínimo, `checkLinkSecret`) — é ele que o executor usa para assinar,
 *  nunca o valor cru do ambiente. */
export type FormContentGate = { blocked: false; linkSecret: string } | { blocked: true; motivo: FollowupBlockReason; detalhe: string };

/** @pure — o formulário só destrava com os 2 textos aprovados, o link do
 *  formulário no corpo, o formulário configurado (URL pública + endpoint de
 *  respostas: sem saber quem preencheu, os lembretes não param) e o segredo
 *  que assina o link por pessoa (#10657). `linkSecret` é obrigatório de
 *  propósito: ausente, vazio ou curto TRAVA (fail-closed), nunca vira link
 *  sem assinatura. */
export function formContentGate(
  snippets: FollowupSnippets,
  cfg: Pick<FollowupConfig, "formUrl" | "formResponsesUrl">,
  linkSecret: string | null | undefined,
): FormContentGate {
  for (const step of FORM_STEPS) {
    const gate = checkSnippet(step.kind, snippets[step.kind]);
    if (gate.blocked) return gate;
    if (!snippets[step.kind]!.body.includes(FORM_URL_PLACEHOLDER)) {
      return {
        blocked: true,
        motivo: "snippet_invalido",
        detalhe: `data/snippets/${step.snippetFile} sem ${FORM_URL_PLACEHOLDER} no corpo (o e-mail sairia sem o link do formulário)`,
      };
    }
  }
  if (cfg.formUrl == null || cfg.formResponsesUrl == null) {
    return {
      blocked: true,
      motivo: "form_nao_configurado",
      detalhe: "onboarding.followup.form_url/form_responses_url ausentes — Worker do formulário não publicado (#10605)",
    };
  }
  const secret = checkLinkSecret(linkSecret);
  if (!secret.ok) {
    return {
      blocked: true,
      motivo: "assinatura_nao_configurada",
      detalhe: `${secret.detalhe} no ambiente do executor — o link do formulário sairia sem assinatura válida (#10657)`,
    };
  }
  return { blocked: false, linkSecret: secret.secret };
}

/** @pure — link do formulário: `{formUrl}?email=...&sig=...` (ou `&email=`
 *  se a URL já tem query). Usado com merge tags no corpo e com valores reais
 *  na sonda (`FORM_LINK_PROBE_EMAIL`), pra os dois nunca divergirem. */
export function buildFormLink(formUrl: string, emailPart: string, sigPart: string): string {
  const sep = formUrl.includes("?") ? "&" : "?";
  return `${formUrl}${sep}email=${emailPart}&sig=${sigPart}`;
}

/** Endereço da sonda de ponta a ponta do link (#10657): assinado pelo
 *  executor e enviado CRU ao Worker (como a merge tag faz), com `+` para
 *  exercitar a restauração de `prefillEmailFromQuery`. GET sem efeito. */
export const FORM_LINK_PROBE_EMAIL = "sonda+link@diar.ia.br";

/** @pure — troca o placeholder pelo link do formulário com o e-mail e a
 *  assinatura da pessoa, ambos por merge tag do Kit (o corpo é um só pro lote
 *  inteiro). A assinatura vem do custom field `form_sig`, gravado pelo
 *  executor antes do lote (#10657, `provisionFormSigs`).
 *
 *  O e-mail vai SEM filtro Liquid (review #10623, mantido no #10657):
 *  `{{ subscriber.email_address }}` é a única merge tag confirmada ao vivo no
 *  Kit, e um filtro que o Kit não resolvesse quebraria o link de TODO mundo
 *  (403). O Worker restaura o `+` que a query decodifica como espaço
 *  (`prefillEmailFromQuery`). Resíduo conhecido e aceito: um `&` ou `#` no
 *  local part corta o e-mail na query, a assinatura não confere e a pessoa vê
 *  "Link inválido" (nunca grava para o e-mail errado). A assinatura é
 *  base64url, segura na query. */
export function renderFollowupBody(body: string, formUrl: string | null): string {
  if (formUrl == null || !body.includes(FORM_URL_PLACEHOLDER)) return body;
  const link = buildFormLink(formUrl, "{{ subscriber.email_address }}", `{{ subscriber.${FORM_SIG_KIT_FIELD} }}`);
  return body.split(FORM_URL_PLACEHOLDER).join(link);
}

/** Template gravado por `--init-snippets` (nunca sobrescreve arquivo existente). */
export function snippetTemplate(kind: FollowupStepKind): string {
  const isForm = isFormStep(kind);
  const what = isApoioStep(kind)
    ? `pedido de apoio D+${APOIO_STEPS.find((s) => s.kind === kind)!.days} (#10604)`
    : kind === "form"
      ? "e-mail do formulário D+6 (#10605)"
      : kind === "form_base"
        ? "e-mail único da pesquisa para a base já cadastrada (#10605)"
        : `lembrete ${FORM_REMINDER_STEPS.findIndex((s) => s.kind === kind) + 1} de 3 do formulário (#10605)`;
  return [
    "<!--",
    what,
    `assunto: ""`,
    `preview_text: ""`,
    `${PENDING_BODY_MARKER} — remover esta linha quando o editor aprovar o texto.`,
    ...(isForm ? [`O corpo precisa conter ${FORM_URL_PLACEHOLDER} (vira o link do formulário com o e-mail pré-preenchido).`] : []),
    "-->",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Cadência
// ---------------------------------------------------------------------------

export function isoToSec(iso: string | null | undefined): number | null {
  if (iso == null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function hasStepRecord(person: FollowupPerson | undefined, kind: FollowupStepKind): boolean {
  if (!person) return false;
  return person.sends.some((s) => s.step === kind) || (person.skips ?? []).some((s) => s.step === kind);
}

/** A regra de pedidos já adiou esta etapa para a pessoa (nunca vence pela janela). */
export function isAskDeferred(person: FollowupPerson | undefined, kind: FollowupStepKind): boolean {
  return (person?.ask_deferred ?? []).some((d) => d.step === kind);
}

export interface ApoioDueResult {
  /** Etapa de apoio dentro da janela e ainda não enviada/pulada — `null` = nenhuma. */
  due: ApoioStepKind | null;
  /** Etapas cuja janela já passou sem envio (nunca enviadas atrasadas). */
  vencidas: ApoioStepKind[];
}

/** @pure — qual etapa de apoio está dentro da janela agora. */
export function apoioStepDue(
  cadastroSec: number | null,
  nowSec: number,
  person: FollowupPerson | undefined,
  graceDays: number,
): ApoioDueResult {
  const vencidas: ApoioStepKind[] = [];
  if (cadastroSec == null) return { due: null, vencidas };
  for (const step of APOIO_STEPS) {
    if (hasStepRecord(person, step.kind)) continue;
    const start = cadastroSec + step.days * DAY_S;
    if (nowSec < start) break; // etapas seguintes ainda mais no futuro
    // Adiada pela regra de pedidos: espera, nunca é descartada pela janela.
    if (nowSec < start + graceDays * DAY_S || isAskDeferred(person, step.kind)) return { due: step.kind, vencidas };
    vencidas.push(step.kind);
  }
  return { due: null, vencidas };
}

export type FormDueResult =
  | { due: "form" | FormReminderKind }
  | { due: null; motivo: "preencheu" | "saiu" | "sem_ancora" | "nao_venceu" | "vencida" | "teto_lembretes" };

/** Lembretes do formulário já registrados para a pessoa (os 3 textos somados). */
export function formReminderCount(person: FollowupPerson | undefined): number {
  return (person?.sends ?? []).filter((s) => isFormReminder(s.step)).length;
}

/** @pure — o convite que a pessoa recebeu: `form_invite`, ou o 1º convite em `sends`. */
export function formInviteOf(person: FollowupPerson | undefined): FormInviteKind | null {
  if (person?.form_invite) return person.form_invite;
  const invites = (person?.sends ?? []).filter((s) => isFormInvite(s.step));
  invites.sort((a, b) => (isoToSec(a.at) ?? 0) - (isoToSec(b.at) ?? 0));
  return invites.length > 0 ? (invites[0].step as FormInviteKind) : null;
}

/** #10675: a checagem perto do envio já viu a pessoa fora do Kit numa etapa
 *  do formulário — a sequência do formulário acabou para ela. */
export function leftKitInFormSequence(person: FollowupPerson | undefined): boolean {
  return (person?.skips ?? []).some((s) => s.motivo === "nao_ativo" && isFormStep(s.step));
}

/** Último envio de formulário registrado (epoch s), ou `null`. */
export function lastFormSendSec(person: FollowupPerson | undefined): number | null {
  let last: number | null = null;
  for (const s of person?.sends ?? []) {
    if (!isFormStep(s.step)) continue;
    const sec = isoToSec(s.at);
    if (sec != null && (last == null || sec > last)) last = sec;
  }
  return last;
}

/**
 * @pure — qual e-mail de formulário está devido agora.
 *
 * Lembretes (decisão do editor de 09/11/2026): o N-ésimo lembrete usa o
 * N-ésimo texto (`FORM_REMINDER_STEPS`). Quem recebeu o convite do
 * ONBOARDING (`form`) e tem âncora recebe o N-ésimo em
 * `anchor + formReminderDaysOnboarding[N-1]` (D+19, D+49, D+79); quem recebeu
 * o convite da BASE (ou sem âncora conhecida) recebe `formReminderDays` depois
 * do envio anterior. Teto: `formReminderMax` (e nunca mais lembretes que
 * textos). O espaçamento entre pedidos é do `planFollowup`, não daqui.
 */
export function formStepDue(
  anchorSec: number | null,
  nowSec: number,
  person: FollowupPerson | undefined,
  cfg: Pick<FollowupConfig, "formFirstDays" | "formReminderDays" | "graceDays"> &
    Partial<Pick<FollowupConfig, "formReminderMax" | "formReminderDaysOnboarding">>,
): FormDueResult {
  if (person?.form_filled_at) return { due: null, motivo: "preencheu" };
  // #10675: quem saiu do Kit não volta a ser devido (nem ocupa vaga do teto).
  if (leftKitInFormSequence(person)) return { due: null, motivo: "saiu" };
  const last = lastFormSendSec(person);
  if (last == null) {
    if (anchorSec == null) return { due: null, motivo: "sem_ancora" };
    const start = anchorSec + cfg.formFirstDays * DAY_S;
    if (nowSec < start) return { due: null, motivo: "nao_venceu" };
    if (nowSec >= start + cfg.graceDays * DAY_S && !isAskDeferred(person, "form")) return { due: null, motivo: "vencida" };
    return { due: "form" };
  }
  const n = formReminderCount(person);
  if (n >= Math.min(cfg.formReminderMax ?? 3, FORM_REMINDER_STEPS.length)) return { due: null, motivo: "teto_lembretes" };
  const kind = FORM_REMINDER_STEPS[n].kind;
  const days = cfg.formReminderDaysOnboarding ?? DEFAULT_FORM_REMINDER_DAYS_ONBOARDING;
  const dueAt =
    formInviteOf(person) === "form" && anchorSec != null && n < days.length
      ? anchorSec + days[n] * DAY_S
      : last + cfg.formReminderDays * DAY_S;
  return nowSec >= dueAt ? { due: kind } : { due: null, motivo: "nao_venceu" };
}

/** Último envio de QUALQUER e-mail destas sequências para a pessoa (epoch s). */
export function lastFollowupSendSec(person: FollowupPerson | undefined): number | null {
  let last: number | null = null;
  for (const s of person?.sends ?? []) {
    const sec = isoToSec(s.at);
    if (sec != null && (last == null || sec > last)) last = sec;
  }
  return last;
}

/** A regra de pedidos só vale DEPOIS do 1º mês da pessoa (âncora + 30 dias). */
export const ASK_RULE_STARTS_AFTER_DAYS = 30;

/** Contexto de pedidos de uma pessoa vindo de fora destas sequências (a escada). */
export interface AskContext {
  /** Âncora da escada (`reguaAnchorSec`, a confirmação). */
  anchorSec: number | null;
  /** Epoch s de pedidos feitos fora daqui (o e-mail 3 da escada). */
  extraAskSecs: readonly number[];
}

/** @pure — último pedido (`isAsk`) da pessoa: envios destas sequências + os de fora. */
export function lastAskSec(person: FollowupPerson | undefined, extraAskSecs: readonly number[] = []): number | null {
  let last: number | null = null;
  for (const s of person?.sends ?? []) {
    if (!isAsk(s.step)) continue;
    const sec = isoToSec(s.at);
    if (sec != null && (last == null || sec > last)) last = sec;
  }
  for (const sec of extraAskSecs) if (last == null || sec > last) last = sec;
  return last;
}

/**
 * @pure — a regra de pedidos barra um pedido AGORA? Depois do 1º mês (a
 * âncora mais antiga conhecida + `ASK_RULE_STARTS_AFTER_DAYS`; sem âncora
 * nenhuma a regra vale, lado conservador), um pedido só sai com
 * `askMinGapDays` dias ou mais desde o último. Dentro do 1º mês não barra
 * (D+6, D+10 e D+19 estão nele).
 */
export function askGapBlocks(nowSec: number, anchors: readonly (number | null)[], lastAsk: number | null, askMinGapDays: number): boolean {
  if (lastAsk == null) return false;
  const known = anchors.filter((a): a is number => a != null);
  if (known.length > 0 && nowSec < Math.min(...known) + ASK_RULE_STARTS_AFTER_DAYS * DAY_S) return false;
  return nowSec < lastAsk + askMinGapDays * DAY_S;
}

/**
 * @pure — contexto de pedidos a partir das entradas da escada, por id Kit:
 * âncora (`reguaAnchorSec`) e a hora do e-mail 3 quando ele saiu
 * (`email3_state: "campaign_created"`, `email3_decided_at`).
 */
export function askContextFromEntries(entries: readonly OnboardingEntry[]): Map<number, AskContext> {
  const out = new Map<number, AskContext>();
  for (const e of entries) {
    const kitId = kitIdForEntry(e);
    if (kitId == null) continue;
    const extra: number[] = [];
    if (e.email3_state === "campaign_created") {
      const sec = isoToSec(e.email3_decided_at);
      if (sec != null) extra.push(sec);
    }
    out.set(kitId, { anchorSec: reguaAnchorSec(e), extraAskSecs: extra });
  }
  return out;
}

/** @pure — grava `ask_deferred` (etapas com janela) para os adiados da rodada. Idempotente. */
export function recordAskDeferrals(
  people: Record<string, FollowupPerson>,
  deferred: readonly FollowupDue[],
  nowIso: string,
  cadastroById: ReadonlyMap<number, string | null> = new Map(),
): number {
  let n = 0;
  for (const d of deferred) {
    if (isFormReminder(d.kind) || d.kind === "form_base") continue; // sem janela: nada a proteger
    const p = ensurePerson(people, d.kit_subscriber_id, d.email, cadastroById.get(d.kit_subscriber_id) ?? null);
    if (isAskDeferred(p, d.kind) || hasStepRecord(p, d.kind)) continue;
    (p.ask_deferred ??= []).push({ step: d.kind, at: nowIso });
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Plano
// ---------------------------------------------------------------------------

export interface ApoioCandidate {
  kit_subscriber_id: number;
  email: string;
  cadastro_at: string | null;
}

export interface FormCandidate {
  kit_subscriber_id: number;
  email: string;
  /** Âncora da escada (`reguaAnchorSec`) — `null` = ainda não confirmou. */
  anchorSec: number | null;
}

export interface FollowupDue {
  kit_subscriber_id: number;
  email: string;
  kind: FollowupStepKind;
}

export interface FollowupPlan {
  due: FollowupDue[];
  /** Por etapa, contagem por motivo de quem NÃO entrou (`vencida`, `espacamento`, `bloqueado_*`). */
  counts: Partial<Record<FollowupStepKind, Record<string, number>>>;
  /** Devidos que a regra de pedidos adiou nesta rodada (o executor grava
   *  `ask_deferred` com `recordAskDeferrals`, para a janela não descartá-los). */
  askDeferred: FollowupDue[];
}

function bump(counts: FollowupPlan["counts"], kind: FollowupStepKind, motivo: string, n = 1): void {
  const byKind = (counts[kind] ??= {});
  byKind[motivo] = (byKind[motivo] ?? 0) + n;
}

/**
 * @pure — monta o plano da rodada. `apoioBlocked`/`formBlocked` vêm dos gates
 * de conteúdo/config: a etapa devida mas travada é contada (`bloqueado_{motivo}`)
 * e não entra em `due` — nem conta para o espaçamento (nada saiu).
 */
export function planFollowup(opts: {
  apoioCandidates: readonly ApoioCandidate[];
  formCandidates: readonly FormCandidate[];
  people: Readonly<Record<string, FollowupPerson>>;
  nowSec: number;
  cfg: Pick<FollowupConfig, "graceDays" | "askMinGapDays" | "formFirstDays" | "formReminderDays"> &
    Partial<Pick<FollowupConfig, "formReminderMax" | "formReminderDaysOnboarding">>;
  apoioBlocked: FollowupBlockReason | null;
  formBlocked: FollowupBlockReason | null;
  /**
   * E-mails (normalizados, `normalizeEmail`) com a tag `envio-brevo` no Kit
   * (#10437 — movidos pra Brevo por entregabilidade). Não recebem pedido de
   * apoio nem formulário pelo Kit: contados como `envio_brevo`, fora de `due`.
   */
  excludedEmails?: ReadonlySet<string>;
  /**
   * #10605: ids (string) dos destinatários do e-mail da base enquanto ele
   * pode sair (`baseInviteRecipientIds`). Não recebem o D+6 (`form`):
   * contados como `email_da_base_pendente`, fora de `due`.
   */
  baseInviteRecipientIds?: ReadonlySet<string>;
  /**
   * Regra de pedidos: âncora da escada e pedidos feitos fora daqui (e-mail 3)
   * por id Kit (`askContextFromEntries`). Ausente = só os envios do store.
   */
  askContext?: ReadonlyMap<number, AskContext>;
}): FollowupPlan {
  const { nowSec, cfg, people } = opts;
  const isEnvioBrevo = (email: string) => opts.excludedEmails?.has(normalizeEmail(email)) ?? false;
  const counts: FollowupPlan["counts"] = {};
  const byId = new Map<number, { email: string; apoio: ApoioStepKind | null; form: "form" | FormReminderKind | null }>();
  const cadastroSecById = new Map(opts.apoioCandidates.map((c) => [c.kit_subscriber_id, isoToSec(c.cadastro_at)] as const));
  const formAnchorById = new Map(opts.formCandidates.map((c) => [c.kit_subscriber_id, c.anchorSec] as const));

  for (const c of opts.apoioCandidates) {
    const person = people[String(c.kit_subscriber_id)];
    const r = apoioStepDue(isoToSec(c.cadastro_at), nowSec, person, cfg.graceDays);
    for (const v of r.vencidas) bump(counts, v, "vencida");
    if (r.due == null) continue;
    if (isEnvioBrevo(c.email)) {
      bump(counts, r.due, "envio_brevo");
      continue;
    }
    if (opts.apoioBlocked) {
      bump(counts, r.due, `bloqueado_${opts.apoioBlocked}`);
      continue;
    }
    byId.set(c.kit_subscriber_id, { email: c.email, apoio: r.due, form: null });
  }

  for (const c of opts.formCandidates) {
    const person = people[String(c.kit_subscriber_id)];
    const r = formStepDue(c.anchorSec, nowSec, person, cfg);
    if (r.due == null) {
      if (r.motivo === "vencida") bump(counts, "form", "vencida");
      if (r.motivo === "teto_lembretes") bump(counts, "form_lembrete", "teto_lembretes");
      continue;
    }
    if (isEnvioBrevo(c.email)) {
      bump(counts, r.due, "envio_brevo");
      continue;
    }
    if (r.due === "form" && opts.baseInviteRecipientIds?.has(String(c.kit_subscriber_id))) {
      bump(counts, "form", "email_da_base_pendente");
      continue;
    }
    if (opts.formBlocked) {
      bump(counts, r.due, `bloqueado_${opts.formBlocked}`);
      continue;
    }
    const cur = byId.get(c.kit_subscriber_id);
    if (cur) cur.form = r.due;
    else byId.set(c.kit_subscriber_id, { email: c.email, apoio: null, form: r.due });
  }

  const due: FollowupDue[] = [];
  const askDeferred: FollowupDue[] = [];
  const defer = (id: number, email: string, kind: FollowupStepKind) => {
    bump(counts, kind, "espacamento");
    askDeferred.push({ kit_subscriber_id: id, email, kind });
  };
  for (const [id, v] of byId) {
    const person = people[String(id)];
    const ctx = opts.askContext?.get(id);
    const cadastro = cadastroSecById.get(id) ?? isoToSec(person?.cadastro_at);
    const anchors = [cadastro ?? null, ctx?.anchorSec ?? formAnchorById.get(id) ?? null];
    const last = lastAskSec(person, ctx?.extraAskSecs ?? []);
    if (askGapBlocks(nowSec, anchors, last, cfg.askMinGapDays)) {
      if (v.apoio) defer(id, v.email, v.apoio);
      if (v.form) defer(id, v.email, v.form);
      continue;
    }
    if (v.apoio) {
      due.push({ kit_subscriber_id: id, email: v.email, kind: v.apoio });
      // Os dois vencendo juntos: sai o de apoio (janela fixa); o formulário espera.
      if (v.form) defer(id, v.email, v.form);
      continue;
    }
    if (v.form) due.push({ kit_subscriber_id: id, email: v.email, kind: v.form });
  }
  return { due, counts, askDeferred };
}

/** Por etapa, quantos elegíveis havia e quantos ficaram para os dias seguintes. */
export interface CapDeferral {
  kind: FollowupStepKind;
  eligible: number;
  deferred: number;
}

/**
 * @pure — #10773: rebaixamento do rodízio (#10763) que CEDE no fim da janela.
 * Quem falhou a leitura na rodada anterior (`failedLastRound`) vai para o fim
 * da fila, exceto quando hoje é a última rodada que ainda o pega dentro da
 * janela da etapa (`diasRestantes <= 1`, mesma conta de `capWindowOverflows`):
 * aí volta à ordem normal, senão viraria `vencida` sem nunca ser lido (a marca
 * só sai com uma leitura, e quem fica em `adiado_teto` não é lido). Sem
 * janela conhecida (âncora nula, `form_lembrete`) o rebaixamento vale sempre.
 */
export function isCapDemoted(
  d: FollowupDue,
  failedLastRound: boolean,
  anchorSec: number | null,
  nowSec: number,
  cfg: Pick<FollowupConfig, "graceDays" | "formFirstDays">,
): boolean {
  if (!failedLastRound) return false;
  const start = capWindowStartSec(d.kind, anchorSec, cfg);
  if (start == null) return true;
  return windowRoundsLeft(start, nowSec, cfg.graceDays) > 1;
}

/** Rodadas diárias (a de hoje inclusive) que ainda pegam a janela `[start, start + grace)`. */
function windowRoundsLeft(startSec: number, nowSec: number, graceDays: number): number {
  return Math.ceil((startSec + graceDays * DAY_S - nowSec) / DAY_S);
}

/** Ordem do corte do teto (ver `splitDueByCap`): `orderSec` crescente, `null` por último, desempate por id. */
function sortByCapOrder(
  list: readonly FollowupDue[],
  orderSec: (d: FollowupDue) => number | null,
  demoted: (d: FollowupDue) => boolean = () => false,
): FollowupDue[] {
  const keyed = list.map((d) => ({ d, sec: orderSec(d), dem: demoted(d) }));
  keyed.sort((a, b) => {
    if (a.dem !== b.dem) return a.dem ? 1 : -1;
    if (a.sec !== b.sec) {
      if (a.sec == null) return 1;
      if (b.sec == null) return -1;
      return a.sec - b.sec;
    }
    return a.d.kit_subscriber_id - b.d.kit_subscriber_id;
  });
  return keyed.map((k) => k.d);
}

/**
 * @pure — aplica o teto de lote POR ETAPA sobre os devidos ANTES da checagem
 * singular no Kit (review da PR #10623): uma coorte inteira caindo no mesmo
 * D+N (ex.: base migrada com `created_at` da importação) não pode gerar
 * milhares de `GET /subscribers/{id}`.
 *
 * **Lote parcial até o teto (#10631, decisão do editor 21/10/2026).** Etapa
 * com mais elegíveis que `cap` NÃO é barrada inteira: saem os primeiros `cap`
 * e o restante fica para as rodadas seguintes (motivo `adiado_teto`, não é
 * falha). Vale igual para todas as etapas (apoio D+30/90/180/360 e
 * formulário), porque o defeito era o mesmo em todas. O excedente não ganha
 * registro nenhum no store, então continua devido no dia seguinte enquanto
 * estiver dentro da janela `[D+N, D+N+grace)`; quem recebeu ganha o registro
 * em `people[id].sends` e nunca volta a ser devido (sem envio duplicado).
 * Excedente que não couber até o fim da janela vira `vencida` como qualquer
 * outra pessoa fora da janela — a ordenação abaixo põe primeiro quem está mais
 * perto disso.
 *
 * **Ordem determinística** dentro de cada etapa: `orderSec(d)` crescente (o
 * executor passa o `created_at` do Kit para as etapas de apoio e a âncora da
 * escada para o formulário — o cadastro mais ANTIGO sai primeiro, porque a
 * janela dele fecha antes), `null` por último, desempate por
 * `kit_subscriber_id` crescente. **Rodízio (#10763):** `demoted(d)` (quem
 * falhou a leitura singular na rodada anterior) vai depois de quem não
 * falhou, mantendo a ordem acima dentro de cada grupo — falha recorrente não
 * monopoliza o teto nem aumenta o número de GETs; a pessoa continua devida
 * (não é pulo terminal) e volta à frente assim que a leitura passa. O
 * executor monta `demoted` com `isCapDemoted` (#10773): no último dia da
 * janela o rebaixamento cede, senão a pessoa nunca seria lida enquanto a
 * etapa estiver acima do teto. A ordem relativa entre etapas diferentes em
 * `within` segue a de `due`.
 */
export function splitDueByCap(
  due: readonly FollowupDue[],
  cap: number,
  orderSec: (d: FollowupDue) => number | null = () => null,
  demoted: (d: FollowupDue) => boolean = () => false,
): { within: FollowupDue[]; deferred: CapDeferral[] } {
  const byKind = new Map<FollowupStepKind, FollowupDue[]>();
  for (const d of due) {
    const list = byKind.get(d.kind);
    if (list) list.push(d);
    else byKind.set(d.kind, [d]);
  }
  const keep = new Set<FollowupDue>();
  const deferred: CapDeferral[] = [];
  for (const kind of ALL_FOLLOWUP_STEPS) {
    const list = byKind.get(kind);
    if (!list) continue;
    if (list.length <= cap) {
      for (const d of list) keep.add(d);
      continue;
    }
    for (const d of sortByCapOrder(list, orderSec, demoted).slice(0, cap)) keep.add(d);
    deferred.push({ kind, eligible: list.length, deferred: list.length - cap });
  }
  return { within: due.filter((d) => keep.has(d)), deferred };
}

/** Etapa cujo excedente do teto não cabe na janela (#10652, por pessoa desde #10660). */
export interface CapWindowOverflow {
  kind: FollowupStepKind;
  eligible: number;
  /** Quantos elegíveis cabem até o fim da janela de cada um (1 lote de `cap`/dia). */
  capacity: number;
  /** Estimativa de quantos virariam `vencida` sem receber (`eligible − capacity`). */
  projected_vencidas: number;
}

/**
 * Início da janela da etapa `[start, start + grace)` a partir da âncora que o
 * executor passa para a ordem do teto (`created_at` do Kit nas etapas de
 * apoio, âncora da escada no formulário). `null` = sem janela (âncora
 * ausente, ou `form_lembrete`, que não tem janela).
 */
export function capWindowStartSec(
  kind: FollowupStepKind,
  anchorSec: number | null,
  cfg: Pick<FollowupConfig, "formFirstDays">,
): number | null {
  if (anchorSec == null) return null;
  if (isApoioStep(kind)) return anchorSec + APOIO_STEPS.find((s) => s.kind === kind)!.days * DAY_S;
  if (kind === "form") return anchorSec + cfg.formFirstDays * DAY_S;
  return null;
}

/**
 * @pure — #10652: depois do #10631 o excedente do teto (`adiado_teto`) não é
 * falha, porque volta a ser devido na rodada seguinte. Mas quando a etapa tem
 * mais elegíveis do que as janelas deles comportam (uma rodada por dia), o
 * resto vira `vencida` sem nunca receber — e nada avisava. Devolve as etapas
 * nessa situação.
 *
 * **Capacidade por pessoa (#10660).** A conta antiga (`cap × graceDays`)
 * tratava a coorte como se estivesse no 1º dia da janela: o alarme sumia
 * antes da perda acabar (a coorte encolhe, os dias também), excedente pequeno
 * só alarmava no dia 0, e coorte entrando no meio da janela passava calada.
 * Agora, para cada devido, `diasRestantes = ceil((start + grace·DAY − now) /
 * DAY)` (rodadas que ainda pegam a pessoa dentro da janela, a de hoje
 * inclusive), e a simulação segue a MESMA ordem de `splitDueByCap` (cadastro
 * mais antigo primeiro): quem está na posição `i` sai na rodada
 * `floor(i / cap)`; se essa rodada já não está dentro da janela dele, é
 * `vencida` projetada. Sem rebaixados, a ordem é por início de janela e a
 * janela tem o mesmo tamanho na etapa, então ela coincide com a do prazo.
 *
 * **Rebaixamento (#10773).** `failedLastRound` é o mesmo sinal que o
 * executor usa no corte (`hasLiveFailure`), e a simulação aplica a mesma
 * regra (`isCapDemoted`) rodada a rodada: o rebaixado vai para o fim da fila
 * nas rodadas em que ainda sobra janela e volta à ordem normal na última.
 * Sem falhas, a ordem é a mesma em toda rodada e o resultado é o da conta
 * por posição acima.
 *
 *
 * Etapa com `eligible <= cap` sai inteira hoje e nunca vence. `form_lembrete`
 * fica de fora: o lembrete não tem janela (repete a cada `form_reminder_days`),
 * então o excedente só atrasa, nunca vence. Devido sem âncora (`start` nulo)
 * não tem prazo conhecido e não conta como vencida.
 *
 * Precisão de horário (#10680): assume rodadas a cada 24h exatas. O followup
 * é o 3º passo da task Welcome-Run e seu horário varia com os passos anteriores
 * e execuções manuais. Considere margem operacional de aproximadamente 1h na
 * fronteira: com 23,9h restantes, esta conta prevê só hoje, mas uma próxima
 * rodada em 23,8h ainda alcançaria a janela. A margem é documentada, não
 * somada à janela real nem ao cálculo; o alarme nessa faixa pode ser falso.
 *
 * Limites: não projeta elegíveis que entram nos próximos dias. O teto é
 * aplicado ANTES de `filterDueByLiveCheck`: exclusões `apoia`, `nao_ativo`
 * e `consulta_falhou` ocupam vaga hoje, sem reposição. `apoia` e `nao_ativo`
 * ganham pulo terminal; `consulta_falhou` não ganha registro e pode voltar
 * a ocupar vaga amanhã. A projeção pode errar nos dois sentidos; não é teto
 * superior nem mínimo garantido de perdas.
 */
export function capWindowOverflows(
  due: readonly FollowupDue[],
  cap: number,
  nowSec: number,
  cfg: Pick<FollowupConfig, "graceDays" | "formFirstDays">,
  anchorSec: (d: FollowupDue) => number | null,
  failedLastRound: (d: FollowupDue) => boolean = () => false,
): CapWindowOverflow[] {
  const byKind = new Map<FollowupStepKind, FollowupDue[]>();
  for (const d of due) {
    if (isFormReminder(d.kind)) continue;
    const list = byKind.get(d.kind);
    if (list) list.push(d);
    else byKind.set(d.kind, [d]);
  }
  const out: CapWindowOverflow[] = [];
  for (const kind of ALL_FOLLOWUP_STEPS) {
    const list = byKind.get(kind);
    if (!list || list.length <= cap) continue;
    let vencidas = 0;
    const perRound = Math.max(1, cap);
    let remaining = list;
    for (let k = 0; remaining.length > 0; k++) {
      const roundSec = nowSec + k * DAY_S;
      const ordered = sortByCapOrder(remaining, anchorSec, (d) =>
        isCapDemoted(d, failedLastRound(d), anchorSec(d), roundSec, cfg),
      );
      for (const d of ordered.slice(0, perRound)) {
        const start = capWindowStartSec(kind, anchorSec(d), cfg);
        if (start != null && k >= windowRoundsLeft(start, nowSec, cfg.graceDays)) vencidas++;
      }
      remaining = ordered.slice(perRound);
    }
    if (vencidas > 0) out.push({ kind, eligible: list.length, capacity: list.length - vencidas, projected_vencidas: vencidas });
  }
  return out;
}

export interface LiveSubscriberCheck {
  state: string | null;
  /** Valor de `apoio_nivel` (`""` = não apoia). */
  apoioNivel: string | null;
  /** #10657: valor atual do custom field `form_sig` (assinatura do link do
   *  formulário). Ausente/diferente do esperado = o executor regrava. */
  formSig?: string | null;
  /** #10657: e-mail atual no Kit — é o que a merge tag põe no link, então é
   *  o que a assinatura cobre. Ausente = cai no e-mail do store. */
  email?: string | null;
}

export type LiveExclusionReason = "apoia" | "nao_ativo" | "consulta_falhou";

/** @pure — #10685: `state` é string não vazia. Só um estado concreto
 *  diferente de `active` (cancelled, bounced, complained, inactive…) prova
 *  saída e vira pulo terminal; nulo/vazio é leitura falha. */
export function isConcreteKitState(state: unknown): state is string {
  return typeof state === "string" && state.trim() !== "";
}

/**
 * @pure — filtra o plano pela leitura FRESCA do Kit. Só `active` recebe;
 * `apoio_nivel` não-vazio exclui das etapas de APOIO (o formulário segue
 * valendo pra quem apoia); leitura ausente (falhou) nunca autoriza envio.
 */
export function filterDueByLiveCheck(
  due: readonly FollowupDue[],
  checks: ReadonlyMap<number, LiveSubscriberCheck | null>,
): { send: FollowupDue[]; excluded: { due: FollowupDue; motivo: LiveExclusionReason }[] } {
  const send: FollowupDue[] = [];
  const excluded: { due: FollowupDue; motivo: LiveExclusionReason }[] = [];
  for (const d of due) {
    const c = checks.get(d.kit_subscriber_id);
    // #10685: `state` nulo/vazio não é estado de saída — tratar como leitura
    // falha (adia, sem pulo terminal), nunca como `nao_ativo`.
    if (c == null || !isConcreteKitState(c.state)) {
      excluded.push({ due: d, motivo: "consulta_falhou" });
      continue;
    }
    if (c.state !== "active") {
      excluded.push({ due: d, motivo: "nao_ativo" });
      continue;
    }
    if (isApoioStep(d.kind) && (c.apoioNivel ?? "").trim() !== "") {
      excluded.push({ due: d, motivo: "apoia" });
      continue;
    }
    send.push(d);
  }
  return { send, excluded };
}

/** #10676: fração de leituras singulares falhas (depois do retry) a partir da
 *  qual a falha deixa de ser "isolada" e a rodada conta como falha. */
export const FOLLOWUP_LOOKUP_SYSTEMIC_FRACTION = 0.5;

/** #10694: amostra mínima de leituras para a fração valer. Com 1 ou 2
 *  devidos no dia, uma única falha transitória já é ≥ 50% e virava "falha
 *  sistêmica" (exit 1 + streak do alarme). Abaixo disso, cada falha é
 *  classificada sozinha (erro não transitório ou último dia da janela). */
export const FOLLOWUP_LOOKUP_SYSTEMIC_MIN_LOOKUPS = 10;

export interface LookupFailure {
  due: FollowupDue;
  /** O erro é retentável mais tarde (429, 5xx, rede). 401/403 não é. */
  transient: boolean;
  /** Âncora da janela da etapa (a mesma de `capWindowStartSec`). */
  anchorSec: number | null;
}

/**
 * @pure — #10676: separa as leituras singulares que falharam (já depois do
 * retry espaçado da rodada) entre ADIADAS com segurança e as que contam como
 * rodada falha. Quem falha fica fora do envio de hoje (`consulta_falhou`,
 * nunca autoriza envio) e volta a ser devido amanhã — perda só existe se
 * amanhã já estiver fora da janela. Conta como falha (`blocking`):
 *   - erro não transitório (401/403: não passa com o tempo);
 *   - último dia da janela da etapa (amanhã a pessoa vira `vencida`);
 *   - falha sistêmica: `≥ FOLLOWUP_LOOKUP_SYSTEMIC_FRACTION` das leituras,
 *     só com `totalLookups ≥ FOLLOWUP_LOOKUP_SYSTEMIC_MIN_LOOKUPS` (#10694).
 *     Numa amostra pequena, uma pane real do Kit ainda aparece: a pessoa
 *     volta amanhã e, no último dia da janela, a falha conta.
 * O resto é `deferred`. `form_lembrete` não tem janela, então só sai por
 * erro não transitório ou falha sistêmica.
 */
export function classifyLookupFailures(
  failures: readonly LookupFailure[],
  totalLookups: number,
  nowSec: number,
  cfg: Pick<FollowupConfig, "graceDays" | "formFirstDays">,
): { blocking: number; deferred: number } {
  if (failures.length === 0) return { blocking: 0, deferred: 0 };
  if (
    totalLookups >= FOLLOWUP_LOOKUP_SYSTEMIC_MIN_LOOKUPS &&
    failures.length / totalLookups >= FOLLOWUP_LOOKUP_SYSTEMIC_FRACTION
  ) {
    return { blocking: failures.length, deferred: 0 };
  }
  let blocking = 0;
  for (const f of failures) {
    const start = capWindowStartSec(f.due.kind, f.anchorSec, cfg);
    const lastChance = start != null && start + cfg.graceDays * DAY_S <= nowSec + DAY_S;
    if (!f.transient || lastChance) blocking++;
  }
  return { blocking, deferred: failures.length - blocking };
}

// ---------------------------------------------------------------------------
// Aplicação no store (muta o objeto recebido, sem I/O)
// ---------------------------------------------------------------------------

function ensurePerson(
  people: Record<string, FollowupPerson>,
  kitId: number,
  email: string,
  cadastroAt: string | null = null,
): FollowupPerson {
  const key = String(kitId);
  const p = (people[key] ??= { kit_subscriber_id: kitId, email, cadastro_at: cadastroAt, sends: [] });
  if (cadastroAt != null && p.cadastro_at == null) p.cadastro_at = cadastroAt;
  p.sends ??= [];
  return p;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Grava, para cada destinatário de um lote CONFIRMADO (`scheduled`/`completed`
 * com broadcast), o envio da etapa com data — idempotente (o mesmo `lot_id`
 * nunca é registrado 2 vezes). Lote não confirmado: no-op. Devolve quantas
 * pessoas ganharam registro.
 */
export function applyFollowupLotToPeople(
  people: Record<string, FollowupPerson>,
  lot: FollowupLot,
  nowIso: string,
  cadastroById: ReadonlyMap<number, string | null> = new Map(),
): number {
  if ((lot.status !== "scheduled" && lot.status !== "completed") || lot.broadcast_id == null) return 0;
  const at = typeof lot.send_at === "string" && ISO_RE.test(lot.send_at) ? lot.send_at : nowIso;
  let n = 0;
  lot.recipient_subscription_ids.forEach((idStr, i) => {
    const kitId = Number(idStr);
    if (!Number.isInteger(kitId) || kitId <= 0) return;
    const person = ensurePerson(people, kitId, lot.recipient_emails[i] ?? "", cadastroById.get(kitId) ?? null);
    if (person.sends.some((s) => s.lot_id === lot.lot_id)) return;
    person.sends.push({ step: lot.kind, at, lot_id: lot.lot_id });
    // #10605 regra A: registra o convite (o primeiro vale; o lembrete serve aos dois).
    if (isFormInvite(lot.kind) && person.form_invite == null) person.form_invite = lot.kind;
    n++;
  });
  return n;
}

/**
 * Registra os pulos terminais da checagem perto do envio: `apoia` (etapa de
 * apoio, pessoa já apoiava) e `nao_ativo` (#10675, pessoa fora do Kit — em
 * qualquer etapa). `consulta_falhou` nunca vira pulo: a pessoa volta no dia
 * seguinte. Idempotente por etapa.
 */
export function recordLiveCheckSkips(
  people: Record<string, FollowupPerson>,
  excluded: readonly { due: FollowupDue; motivo: LiveExclusionReason }[],
  nowIso: string,
): number {
  let n = 0;
  for (const x of excluded) {
    if (x.motivo !== "apoia" && x.motivo !== "nao_ativo") continue;
    const person = ensurePerson(people, x.due.kit_subscriber_id, x.due.email);
    if (x.motivo === "apoia") {
      person.apoia = true;
      person.apoio_checked_at = nowIso;
    }
    person.skips ??= [];
    if (person.skips.some((s) => s.step === x.due.kind)) continue;
    person.skips.push({ step: x.due.kind, at: nowIso, motivo: x.motivo });
    n++;
  }
  return n;
}

/** @pure — #10763: a pessoa falhou a leitura singular desta etapa na rodada anterior. */
export function hasLiveFailure(person: FollowupPerson | undefined, step: FollowupStepKind): boolean {
  return !!person?.live_failures?.some((f) => f.step === step);
}

/**
 * #10763: grava `consulta_falhou` como marca transitória (só rebaixa na ordem
 * do teto) e limpa a marca de quem leu bem. Nunca cria pulo terminal.
 */
export function recordLiveCheckFailures(
  people: Record<string, FollowupPerson>,
  excluded: readonly { due: FollowupDue; motivo: LiveExclusionReason }[],
  read: readonly FollowupDue[],
  nowIso: string,
): void {
  for (const x of excluded) {
    if (x.motivo !== "consulta_falhou") continue;
    const person = ensurePerson(people, x.due.kit_subscriber_id, x.due.email);
    const list = (person.live_failures ??= []);
    const cur = list.find((f) => f.step === x.due.kind);
    if (cur) { cur.n++; cur.at = nowIso; } else list.push({ step: x.due.kind, at: nowIso, n: 1 });
  }
  const cleared = [...read, ...excluded.filter((x) => x.motivo !== "consulta_falhou").map((x) => x.due)];
  for (const d of cleared) {
    const person = people[String(d.kit_subscriber_id)];
    if (!person?.live_failures) continue;
    person.live_failures = person.live_failures.filter((f) => f.step !== d.kind);
    if (person.live_failures.length === 0) delete person.live_failures;
  }
}

/** Guarda o resultado da checagem de apoio de quem vai receber (não apoia). */
export function recordApoioChecks(
  people: Record<string, FollowupPerson>,
  sent: readonly FollowupDue[],
  nowIso: string,
): void {
  for (const d of sent) {
    if (!isApoioStep(d.kind)) continue;
    const person = ensurePerson(people, d.kit_subscriber_id, d.email);
    person.apoia = false;
    person.apoio_checked_at = nowIso;
  }
}

export interface FormResponseRecord {
  email: string;
  submitted_at: string;
  answers?: Record<string, string>;
}

/** Quantos e-mails anteriores guardar por pessoa (#10774). */
export const FOLLOWUP_PREVIOUS_EMAILS_MAX = 5;

/**
 * #10774: atualiza `email` de quem já está no store a partir da leitura
 * singular FRESCA do Kit (o mesmo e-mail que a merge tag põe no link e que a
 * assinatura `form_sig` cobre). Sem isto, quem trocou de e-mail no Kit
 * respondia o formulário com o e-mail novo, `applyFormResponses` procurava
 * pelo antigo, a resposta caía em `unmatched` e o lembrete saía para sempre.
 * O e-mail antigo vai para `previous_emails` (resposta já enviada com ele
 * continua casando). Leitura falha (`null`) ou sem e-mail não mexe em nada.
 * Muta `people`; devolve quantas pessoas mudaram.
 */
export function refreshPeopleEmailsFromChecks(
  people: Record<string, FollowupPerson>,
  checks: ReadonlyMap<number, LiveSubscriberCheck | null>,
): number {
  let n = 0;
  for (const [id, check] of checks) {
    const fresh = normalizeEmail(check?.email ?? "");
    if (fresh === "") continue;
    const p = people[String(id)];
    if (!p) continue;
    const old = normalizeEmail(p.email);
    if (old === fresh) continue;
    if (old !== "") {
      const prev = (p.previous_emails ?? []).filter((e) => e !== old && e !== fresh);
      prev.push(old);
      p.previous_emails = prev.slice(-FOLLOWUP_PREVIOUS_EMAILS_MAX);
    }
    p.email = fresh;
    n++;
  }
  return n;
}

/**
 * Marca "preencheu" (para os lembretes na hora) em quem respondeu — casando
 * por e-mail (minúsculo, sem espaços) com as pessoas já conhecidas (só quem
 * recebeu o e-mail do formulário tem o link). Casa pelo e-mail atual e, sem
 * colisão com o atual de outra pessoa, pelos `previous_emails` (#10774).
 * Devolve marcadas e não casadas.
 */
export function applyFormResponses(
  people: Record<string, FollowupPerson>,
  responses: readonly FormResponseRecord[],
): { marked: number; unmatched: number } {
  const byEmail = new Map<string, FollowupPerson>();
  for (const p of Object.values(people)) byEmail.set(normalizeEmail(p.email), p);
  for (const p of Object.values(people)) {
    for (const e of p.previous_emails ?? []) {
      const k = normalizeEmail(e);
      if (k !== "" && !byEmail.has(k)) byEmail.set(k, p);
    }
  }
  let marked = 0;
  let unmatched = 0;
  // v3 (#12490): o Worker devolve TODOS os envios; vale o mais recente por e-mail.
  for (const r of latestFormResponses(responses)) {
    const p = byEmail.get(normalizeEmail(r.email));
    if (!p) {
      unmatched++;
      continue;
    }
    if (p.form_filled_at) {
      // Já preencheu (os lembretes já pararam): só troca as respostas por um envio mais novo.
      const prev = isoToSec(p.form_answers_at ?? p.form_filled_at);
      const cur = isoToSec(r.submitted_at);
      if (r.answers && cur != null && (prev == null || cur > prev)) {
        p.form_answers = { ...r.answers };
        p.form_answers_at = r.submitted_at;
      }
      continue;
    }
    p.form_filled_at = r.submitted_at;
    if (r.answers) {
      p.form_answers = { ...r.answers };
      p.form_answers_at = r.submitted_at;
    }
    marked++;
  }
  return { marked, unmatched };
}

export function normalizeEmail(email: string): string {
  return String(email ?? "").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Candidatos do formulário a partir das entradas da escada
// ---------------------------------------------------------------------------

/** Id Kit da entrada: `kit_subscriber_id`, ou o próprio `subscription_id`
 *  numérico (entradas nascidas no Kit). `null` = não resolvido. */
export function kitIdForEntry(entry: OnboardingEntry): number | null {
  if (typeof entry.kit_subscriber_id === "number" && entry.kit_subscriber_id > 0) return entry.kit_subscriber_id;
  const n = Number(entry.subscription_id);
  return /^\d+$/.test(entry.subscription_id) && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * @pure — #10605 regra A: quem recebeu o convite da BASE (`form_base`) e não
 * está entre os candidatos da escada (a maior parte da base: gente que entrou
 * antes da escada existir) também é candidato, só para o lembrete. Âncora
 * nula: com um envio de formulário registrado, `formStepDue` só olha o
 * último envio e o teto de lembretes.
 */
export function formBaseCandidatesFromPeople(
  people: Readonly<Record<string, FollowupPerson>>,
  alreadyCandidates: ReadonlySet<number>,
): FormCandidate[] {
  const out: FormCandidate[] = [];
  for (const p of Object.values(people)) {
    if (alreadyCandidates.has(p.kit_subscriber_id)) continue;
    if (!(p.sends ?? []).some((s) => s.step === "form_base")) continue;
    out.push({ kit_subscriber_id: p.kit_subscriber_id, email: p.email, anchorSec: null });
  }
  return out;
}

/** @pure — entradas da escada que podem receber o formulário (fora piloto e
 *  recuperação manual; precisa de id Kit — o envio é broadcast por tag). */
export function formCandidatesFromEntries(entries: readonly OnboardingEntry[]): {
  candidates: FormCandidate[];
  semKitId: number;
} {
  const candidates: FormCandidate[] = [];
  let semKitId = 0;
  for (const e of entries) {
    if (e.subscription_id.startsWith("pilot:") || e.seeded_by) continue;
    const kitId = kitIdForEntry(e);
    if (kitId == null) {
      semKitId++;
      continue;
    }
    candidates.push({ kit_subscriber_id: kitId, email: e.email, anchorSec: reguaAnchorSec(e) });
  }
  return { candidates, semKitId };
}

// ---------------------------------------------------------------------------
// E-mail único para a base já cadastrada (#10605, decisão 11 + regra B)
// ---------------------------------------------------------------------------

export interface BaseInviteSubscriber {
  kit_subscriber_id: number;
  email: string;
}

/** Por que um assinante ativo ficou fora do e-mail da base. */
export type BaseInviteExclusion =
  /** Já recebeu o convite D+6 da escada (ou está num lote dele). */
  | "ja_recebeu_formulario"
  /** Já recebeu este mesmo e-mail da base (idempotência). */
  | "ja_recebeu_base"
  /** Vai receber o D+6 em até `baseInviteWindowDays` (cadastro recente na escada). */
  | "formulario_em_breve"
  /** Já respondeu o formulário NOVO. */
  | "respondeu"
  /** Tag `envio-brevo` (#10437): não recebe pelo Kit. */
  | "envio_brevo"
  /** Saiu do Kit numa etapa do formulário (#10675): a sequência acabou para ela. */
  | "saiu_do_formulario";

export const BASE_INVITE_EXCLUSIONS: readonly BaseInviteExclusion[] = [
  "ja_recebeu_formulario",
  "ja_recebeu_base",
  "formulario_em_breve",
  "respondeu",
  "envio_brevo",
  "saiu_do_formulario",
];

export interface BaseInviteAudience {
  recipients: BaseInviteSubscriber[];
  excluded: Record<BaseInviteExclusion, number>;
}

/**
 * @pure — #10605 regra B: público do e-mail único para a base já cadastrada.
 * Parte dos assinantes ATIVOS do Kit (a listagem; o rascunho é conferido de
 * novo pela tag do lote antes de existir) e tira:
 *   - quem já recebeu o convite D+6 (`form` em `sends`, ou destinatário de um
 *     lote `form` não cancelado — defesa em profundidade);
 *   - quem está a até `baseInviteWindowDays` de recebê-lo: entrada da escada
 *     cuja janela do D+6 ainda não fechou e começa em até N dias, ou entrada
 *     ainda sem confirmação criada há pouco (`formFirstDays + N` dias) — a
 *     escada cuida dessas pessoas;
 *   - quem já respondeu o formulário NOVO (`form_filled_at`, ou o e-mail
 *     atual/anterior nas respostas do Worker);
 *   - quem já recebeu este e-mail (`form_base`), quem tem `envio-brevo` e
 *     quem saiu do Kit numa etapa do formulário.
 * Quem passou da janela do D+6 sem receber (a base que entrou com o envio
 * travado) entra: é exatamente para essas pessoas que o e-mail existe. Quem
 * recebe este e-mail e depois aparece na escada não recebe o D+6: com um
 * envio de formulário registrado, `formStepDue` só oferece o lembrete.
 * A ordem dos destinatários segue a do `subscribers`, sem repetição de id.
 * As contagens de `excluded` são mutuamente exclusivas: cada pessoa conta
 * em UM motivo, o primeiro desta precedência — `envio_brevo`, `respondeu`,
 * `ja_recebeu_formulario`, `ja_recebeu_base`, `saiu_do_formulario`,
 * `formulario_em_breve`. A janela é de 7 dias por padrão
 * (`base_invite_window_days`).
 */
export function selectBaseInviteAudience(opts: {
  subscribers: readonly BaseInviteSubscriber[];
  entries: readonly OnboardingEntry[];
  people: Readonly<Record<string, FollowupPerson>>;
  lots?: Readonly<Record<string, FollowupLot>>;
  responseEmails: ReadonlySet<string>;
  excludedEmails?: ReadonlySet<string>;
  nowSec: number;
  cfg: Pick<FollowupConfig, "formFirstDays" | "graceDays" | "baseInviteWindowDays">;
}): BaseInviteAudience {
  const { nowSec, cfg } = opts;
  const excluded = Object.fromEntries(BASE_INVITE_EXCLUSIONS.map((k) => [k, 0])) as Record<BaseInviteExclusion, number>;
  const responded = new Set([...opts.responseEmails].map(normalizeEmail));
  const brevo = new Set([...(opts.excludedEmails ?? [])].map(normalizeEmail));

  const entryById = new Map<number, OnboardingEntry>();
  const entryByEmail = new Map<string, OnboardingEntry>();
  for (const e of opts.entries) {
    if (e.subscription_id.startsWith("pilot:") || e.seeded_by) continue;
    const id = kitIdForEntry(e);
    if (id != null) entryById.set(id, e);
    entryByEmail.set(normalizeEmail(e.email), e);
  }
  const formLotIds = new Set<string>();
  for (const lot of Object.values(opts.lots ?? {})) {
    if (lot.kind !== "form" || lot.status === "cancelled") continue;
    for (const id of lot.recipient_subscription_ids) formLotIds.add(id);
  }

  const windowS = cfg.baseInviteWindowDays * DAY_S;
  const reguaSoon = (e: OnboardingEntry | undefined): boolean => {
    if (!e) return false;
    const anchor = reguaAnchorSec(e);
    if (anchor == null) {
      // Ainda sem confirmação: a escada manda o D+6 se ela confirmar. Só conta
      // como "em breve" se a entrada é recente; entrada velha sem âncora
      // (envio do e-mail 1 que nunca saiu) fica com a base.
      const created = typeof e.created_at === "number" ? e.created_at : isoToSec(e.detected_at);
      return created != null && nowSec - created < (cfg.formFirstDays * DAY_S + windowS);
    }
    const start = anchor + cfg.formFirstDays * DAY_S;
    const closed = nowSec >= start + cfg.graceDays * DAY_S;
    return !closed && start - nowSec <= windowS;
  };

  const seen = new Set<number>();
  const recipients: BaseInviteSubscriber[] = [];
  for (const sub of opts.subscribers) {
    if (seen.has(sub.kit_subscriber_id)) continue;
    seen.add(sub.kit_subscriber_id);
    const email = normalizeEmail(sub.email);
    const person = opts.people[String(sub.kit_subscriber_id)];
    const emails = [email, ...(person?.previous_emails ?? []).map(normalizeEmail), ...(person ? [normalizeEmail(person.email)] : [])];
    let motivo: BaseInviteExclusion | null = null;
    if (brevo.has(email)) motivo = "envio_brevo";
    else if (person?.form_filled_at || emails.some((e) => e !== "" && responded.has(e))) motivo = "respondeu";
    else if ((person?.sends ?? []).some((s) => s.step === "form") || formLotIds.has(String(sub.kit_subscriber_id))) motivo = "ja_recebeu_formulario";
    else if ((person?.sends ?? []).some((s) => s.step === "form_base")) motivo = "ja_recebeu_base";
    else if (leftKitInFormSequence(person)) motivo = "saiu_do_formulario";
    else if (reguaSoon(entryById.get(sub.kit_subscriber_id) ?? entryByEmail.get(email))) motivo = "formulario_em_breve";
    if (motivo) {
      excluded[motivo]++;
      continue;
    }
    recipients.push({ kit_subscriber_id: sub.kit_subscriber_id, email: sub.email });
  }
  return { recipients, excluded };
}

/**
 * @pure — o rascunho do e-mail da base só é montado com o texto aprovado
 * (`data/snippets/pesquisa-base.md` sem `ONBOARDING-CORPO-PENDENTE`, com
 * assunto, corpo e `{{FORM_URL}}`), o formulário configurado e o segredo do
 * link válido — mesmas condições do gate da escada, aplicadas a este texto.
 */
export function baseInviteContentGate(
  snippet: OnboardingSnippet | null | undefined,
  cfg: Pick<FollowupConfig, "formUrl" | "formResponsesUrl">,
  linkSecret: string | null | undefined,
): FormContentGate {
  const gate = checkSnippet("form_base", snippet);
  if (gate.blocked) return gate;
  if (!snippet!.body.includes(FORM_URL_PLACEHOLDER)) {
    return {
      blocked: true,
      motivo: "snippet_invalido",
      detalhe: `data/snippets/${FORM_BASE_STEP.snippetFile} sem ${FORM_URL_PLACEHOLDER} no corpo (o e-mail sairia sem o link do formulário)`,
    };
  }
  if (cfg.formUrl == null || cfg.formResponsesUrl == null) {
    return { blocked: true, motivo: "form_nao_configurado", detalhe: "onboarding.followup.form_url/form_responses_url ausentes" };
  }
  const secret = checkLinkSecret(linkSecret);
  if (!secret.ok) return { blocked: true, motivo: "assinatura_nao_configurada", detalhe: `${secret.detalhe} no ambiente` };
  return { blocked: false, linkSecret: secret.secret };
}

export type BaseInviteConfirmDecision =
  | { action: "sent"; sendAt: string }
  | { action: "scheduled"; sendAt: string }
  | { action: "still_draft" }
  | { action: "unknown"; reason: string };

/**
 * @pure — lê a releitura do broadcast do e-mail da base: só `sending`/
 * `completed` é envio (grava por pessoa); `scheduled` com `send_at` válido é
 * um estado próprio, relido a cada rodada (o editor pode desagendar);
 * `draft` segue rascunho; o resto (`aborted`, status desconhecido, agendado
 * sem `send_at`) não prova nada e conta como falha da releitura.
 */
export function decideBaseInviteConfirm(
  reread: { status?: string | null; send_at?: string | null },
  nowIso: string,
): BaseInviteConfirmDecision {
  const status = reread.status ?? null;
  const sendAt = typeof reread.send_at === "string" && ISO_RE.test(reread.send_at) ? reread.send_at : null;
  if (status === "scheduled") return sendAt ? { action: "scheduled", sendAt } : { action: "unknown", reason: "scheduled sem send_at válido" };
  if (status === "sending" || status === "completed") return { action: "sent", sendAt: sendAt ?? nowIso };
  if (status === "draft") return { action: "still_draft" };
  return { action: "unknown", reason: `status "${status ?? "?"}"` };
}

/**
 * Grava o envio do e-mail da base (`form_base`) para cada destinatário do
 * rascunho, depois que `--step confirm` releu o broadcast agendado/enviado.
 * Idempotente pelo `lot_id` (mesma regra de `applyFollowupLotToPeople`).
 * Devolve quantas pessoas ganharam registro.
 */
export function applyBaseInviteToPeople(
  people: Record<string, FollowupPerson>,
  invite: FollowupBaseInvite,
  sendAtIso: string,
  nowIso: string,
): number {
  const lot: FollowupLot = {
    lot_id: invite.lot_id,
    kind: "form_base",
    tag_name: invite.tag_name,
    tag_id: invite.tag_id,
    broadcast_id: invite.broadcast_id,
    recipient_subscription_ids: invite.recipient_subscription_ids,
    recipient_emails: invite.recipient_emails,
    status: "scheduled",
    created_at: invite.created_at,
    send_at: sendAtIso,
    last_reconciled_at: nowIso,
    last_error: null,
  };
  return applyFollowupLotToPeople(people, lot, nowIso);
}

// ---------------------------------------------------------------------------
// Lotes
// ---------------------------------------------------------------------------

export function buildFollowupLotId(kind: FollowupStepKind, dateIso: string, seq: number): string {
  return `${kind}-${dateIso}-${String(seq).padStart(2, "0")}`;
}

/** Lote mais novo (maior seq) de `kind`+`dateIso`. */
export function findLatestFollowupLot(
  lots: Readonly<Record<string, FollowupLot>>,
  kind: FollowupStepKind,
  dateIso: string,
): { lot: FollowupLot; seq: number } | null {
  const prefix = `${kind}-${dateIso}-`;
  let best: { lot: FollowupLot; seq: number } | null = null;
  for (const lot of Object.values(lots)) {
    if (lot.kind !== kind || !lot.lot_id.startsWith(prefix)) continue;
    const seq = Number.parseInt(lot.lot_id.slice(prefix.length), 10);
    if (Number.isFinite(seq) && (best == null || seq > best.seq)) best = { lot, seq };
  }
  return best;
}

/** Pessoas já cobertas por um lote CONFIRMADO desta etapa (de qualquer dia) —
 *  defesa em profundidade caso o registro em `people` tenha se perdido. */
export function idsInConfirmedFollowupLots(lots: Readonly<Record<string, FollowupLot>>, kind: FollowupStepKind): Set<string> {
  const ids = new Set<string>();
  for (const lot of Object.values(lots)) {
    if (lot.kind !== kind || lot.broadcast_id == null || lot.status === "cancelled" || lot.schedule_failed === true) continue;
    for (const id of lot.recipient_subscription_ids) ids.add(id);
  }
  return ids;
}

/**
 * Lote com broadcast que NÃO terminou confirmado (#10628): `created` — releitura
 * pós-PATCH falhou (`unverified`) ou a limpeza falhou (`schedule_failed`). Em
 * ambos o broadcast PODE ter saído ou estar agendado, então o destinatário não
 * entra em lote novo enquanto o lote não for relido (`confirmOrCleanUpScheduledLot`
 * no início do `--send`). @pure
 */
export function isUnresolvedFollowupLot(lot: Pick<FollowupLot, "status" | "broadcast_id">): boolean {
  return lot.status === "created" && lot.broadcast_id != null;
}

/** Pessoas em algum lote não resolvido (`isUnresolvedFollowupLot`), de QUALQUER
 *  etapa — o broadcast pendente pode ter saído, então nem outra etapa (que
 *  ignoraria o espaçamento, já que nada foi registrado) entra por cima. @pure */
export function idsInUnresolvedFollowupLots(lots: Readonly<Record<string, FollowupLot>>): Set<string> {
  const ids = new Set<string>();
  for (const lot of Object.values(lots)) {
    if (!isUnresolvedFollowupLot(lot)) continue;
    for (const id of lot.recipient_subscription_ids) ids.add(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Saúde do executor + alarme de continuidade
// ---------------------------------------------------------------------------

/** Rodada que falhou em ENTREGAR. Travada por texto/config NÃO é falha
 *  (estado esperado até o editor aprovar) — o painel mostra o bloqueio. */
export function isFailedFollowupRun(run: FollowupRunRecord): boolean {
  if (run.aborted === true) return true;
  if (run.lots_failed > 0 || run.over_cap > 0 || run.lookups_failed > 0 || (run.lots_unresolved ?? 0) > 0) return true;
  if ((run.base_invite_failed ?? 0) > 0) return true;
  // #10652: excedente do teto que não cabe na janela vira `vencida` em silêncio.
  if ((run.cap_window_overflow ?? 0) > 0) return true;
  // #10657: os três motivos da assinatura só aparecem com textos aprovados E
  // form_url configurado (vêm depois no gate), ou seja, com o formulário já
  // pronto para sair — travar ali em silêncio toda rodada precisa do alarme,
  // não só do painel. É a exceção deliberada ao "config não é falha" acima.
  const m = run.form_blocked?.motivo;
  return (
    m === "respostas_indisponiveis" ||
    m === "assinatura_nao_configurada" ||
    m === "campo_assinatura_ausente" ||
    m === "link_rejeitado_pelo_worker"
  );
}

/** #10661: exit do `onboarding-followup-run.ts` quando o ÚNICO problema da
 *  rodada é o excedente do teto que não cabe na janela (`cap_window_overflow`).
 *  É achado operacional, não quebra do executor: a task
 *  `Diaria-Onboarding-Welcome-Run` declara `successExitCodes: [3]`, então a
 *  unit e o `/tarefas` não ficam vermelhos por dias enquanto o excedente
 *  durar (e uma falha real dos passos `run`/`kit` no período continua
 *  visível). O excedente segue contando no alarme de continuidade
 *  (`isFailedFollowupRun`) e no painel. */
export const FOLLOWUP_CAP_WINDOW_OVERFLOW_EXIT_CODE = 3;

/**
 * @pure — #10661: exit code da rodada. Falha de entrega (lote falho, acima do
 * teto, lote não resolvido) é `1` e vence o excedente; só o excedente é
 * `FOLLOWUP_CAP_WINDOW_OVERFLOW_EXIT_CODE`; o resto é `0`.
 */
export function resolveFollowupExitCode(
  run: Pick<FollowupRunRecord, "lots_failed" | "over_cap" | "lots_unresolved" | "cap_window_overflow" | "base_invite_failed">,
): 0 | 1 | typeof FOLLOWUP_CAP_WINDOW_OVERFLOW_EXIT_CODE {
  if (run.lots_failed > 0 || run.over_cap > 0 || (run.lots_unresolved ?? 0) > 0 || (run.base_invite_failed ?? 0) > 0) return 1;
  if ((run.cap_window_overflow ?? 0) > 0) return FOLLOWUP_CAP_WINDOW_OVERFLOW_EXIT_CODE;
  return 0;
}

/** @pure — muta e devolve o bloco. */
export function recordFollowupRun(block: FollowupBlock, run: FollowupRunRecord): FollowupBlock {
  block.last_run = run;
  const prev = block.consecutive_failed_runs ?? 0;
  block.consecutive_failed_runs = isFailedFollowupRun(run) ? prev + 1 : 0;
  return block;
}

export const FOLLOWUP_FAILURE_ALARM_THRESHOLD_RUNS = 2;
export const FOLLOWUP_RUN_FRESHNESS_MAX_HOURS = 48;

export interface FollowupHealthEvaluation {
  verdict: "ok" | "stale" | "cannot-verify";
  reason: "store_missing" | "store_corrupted" | "rodada_ausente" | "rodada_parada" | "rodadas_falhando" | null;
  lastRunAt: string | null;
  consecutiveFailedRuns: number;
}

/** @pure — só faz sentido com `onboarding.followup.enabled === true`. */
export function evaluateFollowupHealth(
  storeExists: boolean,
  corrupted: boolean,
  block: FollowupBlock | undefined,
  now: Date,
  maxHours: number = FOLLOWUP_RUN_FRESHNESS_MAX_HOURS,
  threshold: number = FOLLOWUP_FAILURE_ALARM_THRESHOLD_RUNS,
): FollowupHealthEvaluation {
  const failed = block?.consecutive_failed_runs ?? 0;
  if (!storeExists) return { verdict: "cannot-verify", reason: "store_missing", lastRunAt: null, consecutiveFailedRuns: failed };
  if (corrupted) return { verdict: "cannot-verify", reason: "store_corrupted", lastRunAt: null, consecutiveFailedRuns: failed };
  const run = block?.last_run ?? null;
  if (run == null) return { verdict: "stale", reason: "rodada_ausente", lastRunAt: null, consecutiveFailedRuns: failed };
  const atMs = Date.parse(run.at);
  if (!Number.isFinite(atMs) || now.getTime() - atMs > maxHours * 3_600_000) {
    return { verdict: "stale", reason: "rodada_parada", lastRunAt: run.at, consecutiveFailedRuns: failed };
  }
  if (failed >= threshold) return { verdict: "stale", reason: "rodadas_falhando", lastRunAt: run.at, consecutiveFailedRuns: failed };
  return { verdict: "ok", reason: null, lastRunAt: run.at, consecutiveFailedRuns: failed };
}

// ---------------------------------------------------------------------------
// Tag de quem respondeu o formulário (#10605, para a #12495)
// ---------------------------------------------------------------------------

/** Tag do Kit para quem respondeu o formulário. Precisa EXISTIR no Kit: o
 *  executor nunca cria a tag (`--tag-respondents` avisa e para). */
export const FORM_RESPONDENT_TAG = "formulario-respondeu";

export interface RespondentTagPlan {
  /** Respondentes (e-mails únicos) que o Worker devolveu. */
  respondents: number;
  /** Já têm a tag no Kit. */
  alreadyTagged: number;
  /** Faltam a tag e têm id Kit no store. */
  toTag: { email: string; kit_subscriber_id: number }[];
  /** Faltam a tag e não estão no store (o id sai da leitura por e-mail no `--apply`). */
  unresolved: string[];
}

/**
 * @pure — quem precisa ganhar a tag `FORM_RESPONDENT_TAG`: respondentes (por
 * e-mail, o mais recente) que ainda não estão na tag. O id Kit vem do store
 * (`people`, casando também pelos `previous_emails`, #10774); quem não está
 * lá fica em `unresolved`.
 */
export function planRespondentTagging(
  responses: readonly FormResponseRecord[],
  people: Readonly<Record<string, FollowupPerson>>,
  taggedEmails: ReadonlySet<string>,
): RespondentTagPlan {
  const idByEmail = new Map<string, number>();
  for (const p of Object.values(people)) idByEmail.set(normalizeEmail(p.email), p.kit_subscriber_id);
  for (const p of Object.values(people)) {
    for (const e of p.previous_emails ?? []) {
      const k = normalizeEmail(e);
      if (k !== "" && !idByEmail.has(k)) idByEmail.set(k, p.kit_subscriber_id);
    }
  }
  const tagged = new Set([...taggedEmails].map(normalizeEmail));
  const latest = latestFormResponses(responses);
  const plan: RespondentTagPlan = { respondents: latest.length, alreadyTagged: 0, toTag: [], unresolved: [] };
  for (const r of latest) {
    const email = normalizeEmail(r.email);
    if (tagged.has(email)) {
      plan.alreadyTagged++;
      continue;
    }
    const id = idByEmail.get(email);
    if (id != null) plan.toTag.push({ email, kit_subscriber_id: id });
    else plan.unresolved.push(email);
  }
  return plan;
}
