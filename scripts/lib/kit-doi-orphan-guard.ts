/**
 * scripts/lib/kit-doi-orphan-guard.ts (#6810)
 *
 * Lógica PURA (sem I/O) do alarme que detecta assinantes Kit presos em
 * `inactive` sem NUNCA terem sido vinculados ao form de confirmação do
 * double opt-in (`KIT_DOI_FORM_ID`, hoje `platform.config.json` →
 * `kit.doiFormId`). Mesmo molde de `scripts/lib/subscribe-redirect-drift-check.ts`
 * (decisão pura testável + fingerprint/idempotência do alarme, separados do
 * I/O que mora em `scripts/kit-doi-orphan-guard.ts`).
 *
 * ─── Contexto (#6810) ───────────────────────────────────────────────────────
 *
 * 4 cadastros reais caíram numa janela de ~19h em 28/08/2026 em que o
 * worker `poll` já criava o subscriber como `inactive`
 * (`resolveKitCreateState`, `workers/poll/src/subscribe.ts`) mas o deploy
 * ainda não tinha `KIT_DOI_FORM_ID` configurado — então `vincularKitDoiForm`
 * nunca rodou (o guard `if (!formId) return;` fez o vínculo virar no-op
 * silencioso), o e-mail de confirmação nunca saiu, e o subscriber ficou
 * `inactive` para sempre: nada no Kit promove `inactive → active` sozinho, e
 * o broadcast do Kit só alcança `active`. Nenhuma camada reportou erro —
 * a criação do subscriber teve sucesso (201), e a ausência de vínculo ao
 * form é silenciosa por design (`vincularKitDoiForm` é best-effort, nunca
 * lança).
 *
 * Esta unidade cobre só a Ação 2 da issue (guard de detecção) — a Ação 1
 * (resgatar os 4 cadastros específicos, disparando confirmação com atraso)
 * envia e-mail real a pessoas reais e depende de decisão do editor, fora do
 * escopo de uma sessão autônoma (ver PR).
 *
 * ─── Regra do órfão ─────────────────────────────────────────────────────────
 *
 * Um assinante Kit é "órfão do DOI" quando, SIMULTANEAMENTE:
 *   1. `state === "inactive"`;
 *   2. criado há mais de `ORPHAN_THRESHOLD_HOURS` (48h, mesmo prazo citado
 *      na Ação 1 da issue — tempo mais que suficiente pro e-mail de
 *      confirmação chegar e ser clicado, se ele de fato saiu);
 *   3. AUSENTE de `GET /forms/{KIT_DOI_FORM_ID}/subscribers` — nunca foi
 *      vinculado ao form, então nunca recebeu o e-mail de confirmação por
 *      este mecanismo.
 *
 * Um `inactive` recém-criado (< 48h) não é órfão ainda — pode estar dentro
 * da janela normal de "aguardando o clique no e-mail de confirmação". Um
 * `inactive` antigo mas VINCULADO ao form não é órfão — recebeu o e-mail;
 * se não confirmou, é decisão do assinante, não bug do pipeline.
 *
 * ─── Idempotência: mesmo padrão dos demais alarmes locais (#4320/.../#6365) ─
 *
 * Fingerprint = ids ordenados dos órfãos pendentes. Um órfão a mais/a menos
 * muda o fingerprint (alarma de novo); o mesmo conjunto persistindo não
 * gera e-mail repetido; o conjunto esvaziando "re-arma" o cursor.
 */

import type { KitSubscriberSummary } from "./kit-subscribers.ts";

/** Prazo mínimo (#6810) antes de um `inactive` sem vínculo ao form contar
 *  como órfão — evita falso positivo sobre quem está dentro da janela
 *  normal de "ainda não clicou no e-mail de confirmação". */
export const ORPHAN_THRESHOLD_HOURS = 48;

export interface KitDoiOrphan {
  id: number;
  email_address: string;
  created_at: string;
  /** Horas decorridas desde `created_at` até o momento da checagem —
   *  incluído no achado só pro texto do e-mail/issue, não participa da
   *  decisão além do que já decidiu `isKitDoiOrphan`. */
  ageHours: number;
}

/**
 * Pura — decide se UM subscriber `inactive` é órfão do DOI, dado o
 * conjunto de ids já vinculados ao form (`formSubscriberIds`) e o instante
 * da checagem (`now`, injetável pra teste determinístico).
 */
export function isKitDoiOrphan(
  subscriber: Pick<KitSubscriberSummary, "id" | "state" | "created_at">,
  formSubscriberIds: ReadonlySet<number>,
  now: Date,
  thresholdHours: number = ORPHAN_THRESHOLD_HOURS,
): boolean {
  if (subscriber.state !== "inactive") return false;
  if (formSubscriberIds.has(subscriber.id)) return false;
  const createdAtMs = Date.parse(subscriber.created_at);
  if (Number.isNaN(createdAtMs)) return false;
  const ageHours = (now.getTime() - createdAtMs) / (60 * 60 * 1000);
  return ageHours >= thresholdHours;
}

/**
 * Pura — filtra `subscribers` (tipicamente o resultado de
 * `listAllKitSubscribers(config, { status: "inactive" })`) pros órfãos,
 * ordenados por `created_at` crescente (mais antigo primeiro — o mais
 * urgente de resgatar).
 */
export function findKitDoiOrphans(
  subscribers: readonly Pick<KitSubscriberSummary, "id" | "email_address" | "state" | "created_at">[],
  formSubscriberIds: ReadonlySet<number>,
  now: Date,
  thresholdHours: number = ORPHAN_THRESHOLD_HOURS,
): KitDoiOrphan[] {
  return subscribers
    .filter((s) => isKitDoiOrphan(s, formSubscriberIds, now, thresholdHours))
    .map((s) => ({
      id: s.id,
      email_address: s.email_address,
      created_at: s.created_at,
      ageHours: (now.getTime() - Date.parse(s.created_at)) / (60 * 60 * 1000),
    }))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

// ─── Idempotência do alarme (fingerprint + estado) ─────────────────────────

export interface KitDoiOrphanAlarmState {
  /** Fingerprint do conjunto de órfãos já alarmado (ou `null` — re-armado). */
  lastAlarmedFingerprint: string | null;
  /** ISO — só pra REPORTAR, não participa da idempotência. */
  lastCheckedAt: string | null;
}

export function emptyKitDoiOrphanAlarmState(): KitDoiOrphanAlarmState {
  return { lastAlarmedFingerprint: null, lastCheckedAt: null };
}

/** Pura — fingerprint estável (determinístico, independente da ordem de
 *  chegada) do conjunto de órfãos pendentes — mesmo padrão de
 *  `computeSubscribeDriftFingerprint`. */
export function computeKitDoiOrphanFingerprint(orphans: readonly KitDoiOrphan[]): string {
  return orphans
    .map((o) => String(o.id))
    .sort()
    .join("|");
}

/** Pura — avança o cursor. `fingerprint: null` quando não há órfão
 *  pendente nesta checagem (re-arma pra próxima ocorrência). */
export function advanceKitDoiOrphanState(fingerprint: string | null, now: Date): KitDoiOrphanAlarmState {
  return { lastAlarmedFingerprint: fingerprint, lastCheckedAt: now.toISOString() };
}

/** Pura — `true` quando há órfão(s) pendente(s) E o fingerprint é
 *  diferente do último já alarmado. */
export function shouldAlarmKitDoiOrphans(
  state: KitDoiOrphanAlarmState,
  orphans: readonly KitDoiOrphan[],
): boolean {
  if (orphans.length === 0) return false;
  return computeKitDoiOrphanFingerprint(orphans) !== state.lastAlarmedFingerprint;
}

// ─── Corpo do e-mail de alarme (puro) ──────────────────────────────────────

/** Pura — monta assunto + corpo do e-mail de alarme (texto puro, mesmo
 *  padrão de `buildSubscribeDriftAlarmEmail`). `issueRef` (opcional) — a
 *  issue já criada/reusada por `scripts/lib/alarm-issues.ts` pro achado
 *  agregado (1 issue por rodada de órfãos pendentes, não 1 por assinante —
 *  ver docstring do script CLI). */
export function buildKitDoiOrphanAlarmEmail(
  orphans: readonly KitDoiOrphan[],
  now: Date = new Date(),
  issueRef?: { issueNumber: number | null; url: string | null; action: string; error?: string },
): { subject: string; body: string } {
  const subject = `[diar.ia.br] ${orphans.length} cadastro(s) Kit preso(s) em inactive sem confirmação (double opt-in)`;

  const lines: string[] = [
    "O guard `Diaria-Kit-Doi-Orphan-Guard` "
      + "(`scripts/kit-doi-orphan-guard.ts`) encontrou assinante(s) Kit "
      + `criados como "inactive" há mais de ${ORPHAN_THRESHOLD_HOURS}h e nunca`,
    "vinculados ao form de confirmação do double opt-in — o e-mail de",
    'confirmação nunca saiu pra eles, e nada no Kit promove "inactive" pra',
    '"active" sozinho. Ficam presos para sempre até uma ação manual (ver',
    "#6810).",
    "",
    `Assinante(s) órfão(s) (${orphans.length}):`,
  ];

  for (const o of orphans) {
    lines.push(`  - ${o.email_address} (id ${o.id}) — criado em ${o.created_at}, ${o.ageHours.toFixed(1)}h atrás`);
  }

  if (issueRef) {
    lines.push("");
    lines.push(
      issueRef.action === "failed"
        ? `Issue: falha ao criar/reusar (${issueRef.error})`
        : `Issue: #${issueRef.issueNumber} (${issueRef.url})`,
    );
  }

  lines.push(
    "",
    "Resgate manual (Ação 1 da issue #6810 — decisão do editor, envia e-mail",
    "real): `POST /v4/forms/{KIT_DOI_FORM_ID}/subscribers/{id}` pra cada",
    "assinante listado dispara a confirmação com atraso.",
    "",
    `(alarme automático — checagem rodou em ${now.toISOString()})`,
  );

  return { subject, body: lines.join("\n") };
}
