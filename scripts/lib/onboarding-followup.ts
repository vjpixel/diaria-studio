/**
 * onboarding-followup.ts (#10604, #10605, #10606)
 *
 * Núcleo PURO das duas sequências que vêm DEPOIS da escada de boas-vindas
 * (e-mails 1/2/3 em D0/D+3/D+10, `onboarding-state.ts`):
 *
 *  - **Pedido de apoio (#10604)** em D+30, D+90, D+180 e D+360 contados do
 *    CADASTRO (`created_at` do assinante no Kit), só para quem não apoia e
 *    está ativo.
 *  - **Formulário de perfil/interesses (#10605)** em D+6 (antes do pedido de
 *    apoio do e-mail 3) e, para quem não preencheu, um lembrete a cada 30
 *    dias contados do envio ANTERIOR — sem teto (decisão do editor no
 *    briefing do overnight 261020), até preencher. Âncora do D+6 = a mesma da
 *    escada (`reguaAnchorSec`, a confirmação do double opt-in), porque o
 *    formulário entra NA escada.
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
 *   a mesma janela; os lembretes não têm janela (contam do envio anterior).
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
 * - **Espaçamento mínimo** entre e-mails de apoio e de formulário para a
 *   mesma pessoa (`min_gap_days`, padrão 7). Se os dois vencem juntos, sai o
 *   de apoio (janela fixa) e o de formulário espera (o lembrete conta do
 *   envio anterior, não perde nada esperando).
 * - **Envio TRAVADO até os textos serem aprovados.** Os 4 textos de apoio
 *   (`data/snippets/apoio-{30,90,180,360}.md`) destravam a sequência de apoio
 *   JUNTOS; os 2 do formulário (`onboarding-formulario.md`,
 *   `formulario-lembrete.md`) mais a URL do formulário destravam a de
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

const DAY_S = 86_400;

// ---------------------------------------------------------------------------
// Etapas
// ---------------------------------------------------------------------------

export type ApoioStepKind = "apoio30" | "apoio90" | "apoio180" | "apoio360";
export type FormStepKind = "form" | "form_lembrete";
export type FollowupStepKind = ApoioStepKind | FormStepKind;

export const APOIO_STEPS: readonly { kind: ApoioStepKind; days: number; snippetFile: string }[] = [
  { kind: "apoio30", days: 30, snippetFile: "apoio-30.md" },
  { kind: "apoio90", days: 90, snippetFile: "apoio-90.md" },
  { kind: "apoio180", days: 180, snippetFile: "apoio-180.md" },
  { kind: "apoio360", days: 360, snippetFile: "apoio-360.md" },
];

export const FORM_STEPS: readonly { kind: FormStepKind; snippetFile: string }[] = [
  { kind: "form", snippetFile: "onboarding-formulario.md" },
  { kind: "form_lembrete", snippetFile: "formulario-lembrete.md" },
];

export const ALL_FOLLOWUP_STEPS: readonly FollowupStepKind[] = [
  ...APOIO_STEPS.map((s) => s.kind),
  ...FORM_STEPS.map((s) => s.kind),
];

export function isApoioStep(kind: string): kind is ApoioStepKind {
  return APOIO_STEPS.some((s) => s.kind === kind);
}

export function isFormStep(kind: string): kind is FormStepKind {
  return kind === "form" || kind === "form_lembrete";
}

export function snippetFileFor(kind: FollowupStepKind): string {
  const apoio = APOIO_STEPS.find((s) => s.kind === kind);
  if (apoio) return apoio.snippetFile;
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
   *  apoio não sai para ela (a próxima ainda é avaliada de novo). */
  motivo: "apoia";
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
  /** Respostas do formulário, como vieram do Worker (#10605). */
  form_answers?: Record<string, string>;
}

/** Lote Kit de uma etapa destas sequências — mesma forma do lote da escada. */
export type FollowupLot = Omit<KitBroadcastLot, "kind"> & { kind: FollowupStepKind };

export type FollowupBlockReason =
  | "snippet_ausente"
  | "texto_pendente"
  | "snippet_invalido"
  | "form_nao_configurado"
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
  /** Consultas ao Kit (listagem, leitura singular) que falharam. */
  lookups_failed: number;
  /** #10628: lotes que seguem sem confirmação depois da releitura do início do
   *  `--send` (releitura falhou, ou rascunho que não deu pra apagar). Opcional:
   *  registros anteriores não têm o campo. */
  lots_unresolved?: number;
  /** Por etapa: contagem de enviados nesta rodada e de pulados/adiados por motivo. */
  counts: Partial<Record<FollowupStepKind, Record<string, number>>>;
  aborted?: boolean;
  error?: string | null;
}

export interface FollowupBlock {
  people: Record<string, FollowupPerson>;
  lots: Record<string, FollowupLot>;
  last_run?: FollowupRunRecord | null;
  consecutive_failed_runs?: number;
}

// ---------------------------------------------------------------------------
// Config (`platform.config.json` → `onboarding.followup`)
// ---------------------------------------------------------------------------

export interface FollowupConfigRaw {
  enabled?: boolean;
  grace_days?: number;
  min_gap_days?: number;
  form_first_days?: number;
  form_reminder_days?: number;
  max_recipients_per_lot?: number;
  form_url?: string | null;
  form_responses_url?: string | null;
  form_responses_token_env?: string;
}

export interface FollowupConfig {
  enabled: boolean;
  graceDays: number;
  minGapDays: number;
  formFirstDays: number;
  formReminderDays: number;
  maxRecipientsPerLot: number;
  formUrl: string | null;
  formResponsesUrl: string | null;
  formResponsesTokenEnv: string;
}

function posInt(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : dflt;
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
    minGapDays: posInt(r.min_gap_days, 7),
    formFirstDays: posInt(r.form_first_days, 6),
    formReminderDays: posInt(r.form_reminder_days, 30),
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

/** @pure — a sequência de apoio só destrava com os 4 textos aprovados. */
export function apoioContentGate(snippets: FollowupSnippets): ContentGate {
  for (const step of APOIO_STEPS) {
    const gate = checkSnippet(step.kind, snippets[step.kind]);
    if (gate.blocked) return gate;
  }
  return { blocked: false };
}

/** @pure — o formulário só destrava com os 2 textos aprovados, o link do
 *  formulário no corpo e o formulário configurado (URL pública + endpoint de
 *  respostas: sem saber quem preencheu, os lembretes não param). */
export function formContentGate(snippets: FollowupSnippets, cfg: Pick<FollowupConfig, "formUrl" | "formResponsesUrl">): ContentGate {
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
  return { blocked: false };
}

/** @pure — troca o placeholder pelo link do formulário com o e-mail
 *  pré-preenchido pela merge tag do Kit. SEM filtro Liquid de propósito
 *  (review #10623): `url_encode` não foi confirmado ao vivo no Kit, e um
 *  filtro desconhecido pode quebrar o link inteiro. O e-mail vai cru; o Worker
 *  restaura o `+` que a query decodifica como espaço (`prefillEmailFromQuery`)
 *  e o campo segue editável. */
export function renderFollowupBody(body: string, formUrl: string | null): string {
  if (formUrl == null || !body.includes(FORM_URL_PLACEHOLDER)) return body;
  const sep = formUrl.includes("?") ? "&" : "?";
  const link = `${formUrl}${sep}email={{ subscriber.email_address }}`;
  return body.split(FORM_URL_PLACEHOLDER).join(link);
}

/** Template gravado por `--init-snippets` (nunca sobrescreve arquivo existente). */
export function snippetTemplate(kind: FollowupStepKind): string {
  const isForm = isFormStep(kind);
  const what = isApoioStep(kind)
    ? `pedido de apoio D+${APOIO_STEPS.find((s) => s.kind === kind)!.days} (#10604)`
    : kind === "form"
      ? "e-mail do formulário D+6 (#10605)"
      : "lembrete do formulário, a cada 30 dias até preencher (#10605)";
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
    if (nowSec < start + graceDays * DAY_S) return { due: step.kind, vencidas };
    vencidas.push(step.kind);
  }
  return { due: null, vencidas };
}

export type FormDueResult =
  | { due: FormStepKind }
  | { due: null; motivo: "preencheu" | "sem_ancora" | "nao_venceu" | "vencida" };

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

/** @pure — qual e-mail de formulário está devido agora. */
export function formStepDue(
  anchorSec: number | null,
  nowSec: number,
  person: FollowupPerson | undefined,
  cfg: Pick<FollowupConfig, "formFirstDays" | "formReminderDays" | "graceDays">,
): FormDueResult {
  if (person?.form_filled_at) return { due: null, motivo: "preencheu" };
  const last = lastFormSendSec(person);
  if (last == null) {
    if (anchorSec == null) return { due: null, motivo: "sem_ancora" };
    const start = anchorSec + cfg.formFirstDays * DAY_S;
    if (nowSec < start) return { due: null, motivo: "nao_venceu" };
    if (nowSec >= start + cfg.graceDays * DAY_S) return { due: null, motivo: "vencida" };
    return { due: "form" };
  }
  // Lembrete SEM teto (decisão do editor, 20/10/2026): a cada N dias do envio anterior.
  return nowSec >= last + cfg.formReminderDays * DAY_S ? { due: "form_lembrete" } : { due: null, motivo: "nao_venceu" };
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
  cfg: Pick<FollowupConfig, "graceDays" | "minGapDays" | "formFirstDays" | "formReminderDays">;
  apoioBlocked: FollowupBlockReason | null;
  formBlocked: FollowupBlockReason | null;
  /**
   * E-mails (normalizados, `normalizeEmail`) com a tag `envio-brevo` no Kit
   * (#10437 — movidos pra Brevo por entregabilidade). Não recebem pedido de
   * apoio nem formulário pelo Kit: contados como `envio_brevo`, fora de `due`.
   */
  excludedEmails?: ReadonlySet<string>;
}): FollowupPlan {
  const { nowSec, cfg, people } = opts;
  const isEnvioBrevo = (email: string) => opts.excludedEmails?.has(normalizeEmail(email)) ?? false;
  const counts: FollowupPlan["counts"] = {};
  const byId = new Map<number, { email: string; apoio: ApoioStepKind | null; form: FormStepKind | null }>();

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
      continue;
    }
    if (isEnvioBrevo(c.email)) {
      bump(counts, r.due, "envio_brevo");
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
  for (const [id, v] of byId) {
    const person = people[String(id)];
    const last = lastFollowupSendSec(person);
    const tooSoon = last != null && nowSec < last + cfg.minGapDays * DAY_S;
    if (tooSoon) {
      if (v.apoio) bump(counts, v.apoio, "espacamento");
      if (v.form) bump(counts, v.form, "espacamento");
      continue;
    }
    if (v.apoio) {
      due.push({ kit_subscriber_id: id, email: v.email, kind: v.apoio });
      // Os dois vencendo juntos: sai o de apoio (janela fixa); o formulário espera.
      if (v.form) bump(counts, v.form, "espacamento");
      continue;
    }
    if (v.form) due.push({ kit_subscriber_id: id, email: v.email, kind: v.form });
  }
  return { due, counts };
}

/** Por etapa, quantos elegíveis havia e quantos ficaram para os dias seguintes. */
export interface CapDeferral {
  kind: FollowupStepKind;
  eligible: number;
  deferred: number;
}

/** Ordem do corte do teto (ver `splitDueByCap`): `orderSec` crescente, `null` por último, desempate por id. */
function sortByCapOrder(list: readonly FollowupDue[], orderSec: (d: FollowupDue) => number | null): FollowupDue[] {
  const keyed = list.map((d) => ({ d, sec: orderSec(d) }));
  keyed.sort((a, b) => {
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
 * `kit_subscriber_id` crescente. A ordem relativa entre etapas diferentes em
 * `within` segue a de `due`.
 */
export function splitDueByCap(
  due: readonly FollowupDue[],
  cap: number,
  orderSec: (d: FollowupDue) => number | null = () => null,
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
    for (const d of sortByCapOrder(list, orderSec).slice(0, cap)) keep.add(d);
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
  /** Quantos vão virar `vencida` sem receber (`eligible − capacity`). */
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
 * `vencida` projetada. Como a ordem é por início de janela e a janela tem o
 * mesmo tamanho na etapa, ela coincide com a do prazo — é a melhor ordem
 * possível, então a projeção não acusa perda evitável por outra ordem.
 *
 * Etapa com `eligible <= cap` sai inteira hoje e nunca vence. `form_lembrete`
 * fica de fora: o lembrete não tem janela (repete a cada `form_reminder_days`),
 * então o excedente só atrasa, nunca vence. Devido sem âncora (`start` nulo)
 * não tem prazo conhecido e não conta como vencida.
 *
 * Limites: não projeta elegíveis que entram nos próximos dias (só piora a
 * conta), e `due` é contado ANTES do filtro ao vivo (`nao_ativo`/`apoia`,
 * `filterDueByLiveCheck`) — quem sair por esse filtro libera vaga, então a
 * projeção é um teto superior da perda em relação a esse filtro.
 */
export function capWindowOverflows(
  due: readonly FollowupDue[],
  cap: number,
  nowSec: number,
  cfg: Pick<FollowupConfig, "graceDays" | "formFirstDays">,
  anchorSec: (d: FollowupDue) => number | null,
): CapWindowOverflow[] {
  const byKind = new Map<FollowupStepKind, FollowupDue[]>();
  for (const d of due) {
    if (d.kind === "form_lembrete") continue;
    const list = byKind.get(d.kind);
    if (list) list.push(d);
    else byKind.set(d.kind, [d]);
  }
  const out: CapWindowOverflow[] = [];
  for (const kind of ALL_FOLLOWUP_STEPS) {
    const list = byKind.get(kind);
    if (!list || list.length <= cap) continue;
    let vencidas = 0;
    sortByCapOrder(list, anchorSec).forEach((d, i) => {
      const start = capWindowStartSec(kind, anchorSec(d), cfg);
      if (start == null) return;
      const diasRestantes = Math.ceil((start + cfg.graceDays * DAY_S - nowSec) / DAY_S);
      if (Math.floor(i / cap) >= diasRestantes) vencidas++;
    });
    if (vencidas > 0) out.push({ kind, eligible: list.length, capacity: list.length - vencidas, projected_vencidas: vencidas });
  }
  return out;
}

export interface LiveSubscriberCheck {
  state: string | null;
  /** Valor de `apoio_nivel` (`""` = não apoia). */
  apoioNivel: string | null;
}

export type LiveExclusionReason = "apoia" | "nao_ativo" | "consulta_falhou";

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
    if (c == null) {
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
    n++;
  });
  return n;
}

/** Registra o pulo terminal `apoia` (etapa de apoio, pessoa já apoiava). */
export function recordApoiaSkips(
  people: Record<string, FollowupPerson>,
  excluded: readonly { due: FollowupDue; motivo: LiveExclusionReason }[],
  nowIso: string,
): number {
  let n = 0;
  for (const x of excluded) {
    if (x.motivo !== "apoia") continue;
    const person = ensurePerson(people, x.due.kit_subscriber_id, x.due.email);
    person.apoia = true;
    person.apoio_checked_at = nowIso;
    person.skips ??= [];
    if (person.skips.some((s) => s.step === x.due.kind)) continue;
    person.skips.push({ step: x.due.kind, at: nowIso, motivo: "apoia" });
    n++;
  }
  return n;
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

/**
 * Marca "preencheu" (para os lembretes na hora) em quem respondeu — casando
 * por e-mail (minúsculo, sem espaços) com as pessoas já conhecidas (só quem
 * recebeu o e-mail do formulário tem o link). Devolve marcadas e não casadas.
 */
export function applyFormResponses(
  people: Record<string, FollowupPerson>,
  responses: readonly FormResponseRecord[],
): { marked: number; unmatched: number } {
  const byEmail = new Map<string, FollowupPerson>();
  for (const p of Object.values(people)) byEmail.set(normalizeEmail(p.email), p);
  let marked = 0;
  let unmatched = 0;
  for (const r of responses) {
    const p = byEmail.get(normalizeEmail(r.email));
    if (!p) {
      unmatched++;
      continue;
    }
    if (p.form_filled_at) continue;
    p.form_filled_at = r.submitted_at;
    if (r.answers) p.form_answers = { ...r.answers };
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
    // Lembrete do formulário repete por desenho — a dedup dele é a janela de 30 dias.
    if (kind === "form_lembrete") continue;
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
  // #10652: excedente do teto que não cabe na janela vira `vencida` em silêncio.
  if ((run.cap_window_overflow ?? 0) > 0) return true;
  return run.form_blocked?.motivo === "respostas_indisponiveis";
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
