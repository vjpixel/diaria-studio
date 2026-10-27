/**
 * scripts/lib/brevo-diaria-semanal.ts (#11226)
 *
 * Regime SEMANAL da Brevo diária (cadastros que nunca confirmaram o double
 * opt-in). Decisão do editor de 27/10/2026, registrada na issue:
 *
 * - só a edição de SEGUNDA (data da edição, que já é a data BRT) sai pela
 *   Brevo, com um intro próprio (`data/snippets/brevo-diaria-semanal-intro.md`)
 *   e o botão "Confirmar e receber a diária";
 * - os contadores de promoção/supressão passam a ser POR SEMANAL (ver
 *   `classifyBrevoDiariaSemanalAction` em `shared/brevo-diaria-score.ts`):
 *   conta só campanha enviada a partir de `desde`.
 *
 * Config (`platform.config.json` → `brevo_diaria.semanal`):
 *
 *   { "enabled": false, "desde": "2026-11-02", "split_threshold": 200 }
 *
 * Desligado (default do código e do config no merge) ⇒ comportamento
 * anterior inteiro (diária todo dia, score por taxa). Ligar é passo do
 * coordenador pós-merge, na ordem do corpo do PR.
 *
 * ## Guarda de transição (#10533)
 *
 * Enquanto houver contato `kit-sem-abertura:` em `in_brevo`, o segmento da
 * diária no Kit o exclui e ele só recebe pela Brevo. Num dia sem campanha
 * Brevo, `schedule-newsletter-kit.ts` aborta (exit 7) pra não deixá-lo sem a
 * edição. Por isso `resolveBrevoEffectiveMode` cai pro envio DIÁRIO (com
 * aviso) enquanto esse resíduo existir: a ordem segura é devolver os
 * `kit-sem-abertura:` ao Kit (#11221) antes de ligar o semanal, e este guard
 * impede que esquecer essa ordem tire a edição de alguém. O MESMO modo
 * efetivo decide o score do `evaluate-brevo-diaria.ts` (só pontua por
 * semanal quando a Brevo de fato é semanal) e trava o `--apply` do
 * `restore-brevo-semanal-suppressed.ts`.
 *
 * ## Divisão segunda/terça (acima de `split_threshold`)
 *
 * `semanalSplitGroup` é a divisão FIXA por pessoa (hash estável do e-mail
 * normalizado). O envio da metade de terça ainda não existe — exige uma 2ª
 * lista na Brevo e uma 2ª campanha agendada — e fica como follow-up declarado
 * no PR; `checkSemanalCapacity` só torna visível quando o teto é cruzado.
 */

import { eventTimestampMs } from "./brevo-stats.ts";
import { BREVO_DIARIA_MATURATION_HOURS, type BrevoSemanalEvaluationInput, type BrevoSemanalSend } from "./shared/brevo-diaria-score.ts";

export const BREVO_SEMANAL_DEFAULT_SPLIT_THRESHOLD = 200;

export interface BrevoDiariaSemanalConfig {
  enabled?: boolean;
  /** `YYYY-MM-DD` — 1ª segunda do regime; campanhas antes disso não contam como semanal. */
  desde?: string;
  split_threshold?: number;
}

export type BrevoDiariaSemanalParse =
  | { enabled: false }
  | { enabled: true; desde: string; desdeMs: number; splitThreshold: number }
  | { error: string };

/** Pura — valida a config. Ligado sem `desde` válido é erro (nunca um corte implícito). */
export function parseBrevoDiariaSemanal(cfg: unknown): BrevoDiariaSemanalParse {
  if (cfg === undefined || cfg === null) return { enabled: false };
  if (typeof cfg !== "object") return { error: "brevo_diaria.semanal precisa ser objeto." };
  const c = cfg as BrevoDiariaSemanalConfig;
  if (c.enabled !== undefined && typeof c.enabled !== "boolean") {
    return { error: `brevo_diaria.semanal.enabled precisa ser booleano (veio ${JSON.stringify(c.enabled)}).` };
  }
  if (c.enabled !== true) return { enabled: false };
  if (typeof c.desde !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.desde) || !Number.isFinite(Date.parse(`${c.desde}T00:00:00-03:00`))) {
    return { error: `brevo_diaria.semanal.desde precisa ser YYYY-MM-DD (veio ${JSON.stringify(c.desde)}).` };
  }
  if (editionWeekday(c.desde.slice(2).replace(/-/g, "")) !== 1) {
    return { error: `brevo_diaria.semanal.desde precisa ser uma SEGUNDA (veio ${c.desde}) — é a 1ª semanal do regime.` };
  }
  const split = c.split_threshold ?? BREVO_SEMANAL_DEFAULT_SPLIT_THRESHOLD;
  if (typeof split !== "number" || !Number.isInteger(split) || split < 1) {
    return { error: `brevo_diaria.semanal.split_threshold precisa ser inteiro >= 1 (veio ${JSON.stringify(split)}).` };
  }
  // Meia-noite BRT do dia `desde`: a campanha de segunda sai às 06:00 BRT desse dia.
  return { enabled: true, desde: c.desde, desdeMs: Date.parse(`${c.desde}T00:00:00-03:00`), splitThreshold: split };
}

/** Pura — dia da semana (0=domingo … 1=segunda) de uma edição `AAMMDD`; `null` se malformada. */
export function editionWeekday(aammdd: string): number | null {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(aammdd);
  if (!m) return null;
  const y = 2000 + Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.getUTCDay();
}

export function isMondayEdition(aammdd: string): boolean {
  return editionWeekday(aammdd) === 1;
}

export type BrevoSemanalSendDecision =
  | { send: true; mode: "diaria"; warning?: string }
  | { send: true; mode: "semanal" }
  | { send: false; reason: string };

export type BrevoEffectiveMode = { mode: "diaria"; warning?: string } | { mode: "semanal"; desdeMs: number } | { error: string };

/**
 * Pura — o regime EFETIVO da Brevo diária hoje: desligado ⇒ diária; ligado
 * mas com `kit-sem-abertura:` em `in_brevo` ⇒ diária com aviso (guarda de
 * transição, ver docstring do módulo); senão semanal. Fonte única pro envio
 * (`decideBrevoSemanalSend`), pro score (`evaluate-brevo-diaria.ts`) e pro
 * `--apply` da devolução dos suprimidos.
 */
export function resolveBrevoEffectiveMode(semanal: BrevoDiariaSemanalParse, kitSemAberturaInBrevo: number): BrevoEffectiveMode {
  if ("error" in semanal) return { error: semanal.error };
  if (!semanal.enabled) return { mode: "diaria" };
  if (kitSemAberturaInBrevo > 0) {
    return {
      mode: "diaria",
      warning:
        `brevo_diaria.semanal ligado, mas o store ainda tem ${kitSemAberturaInBrevo} contato(s) kit-sem-abertura: em ` +
        "in_brevo — a Brevo segue DIÁRIA até eles voltarem ao Kit (scripts/restore-kit-sem-abertura-frio.ts, #11221), " +
        "senão ficariam sem a edição nos dias sem campanha (#10533).",
    };
  }
  return { mode: "semanal", desdeMs: semanal.desdeMs };
}

/** Pura — quantos `kit-sem-abertura:` ainda estão `in_brevo` no store (entrada da guarda de transição). */
export function countKitSemAberturaInBrevo(
  contacts: readonly { status: string; beehiiv_subscription_id?: unknown }[],
  kitSemAberturaPrefix: string,
): number {
  return contacts.filter(
    (c) => c.status === "in_brevo" && typeof c.beehiiv_subscription_id === "string" && c.beehiiv_subscription_id.startsWith(kitSemAberturaPrefix),
  ).length;
}

/**
 * Pura — esta edição sai pela Brevo? Desligado ⇒ diária (como antes). Ligado:
 * só segunda; exceção de transição com `kit-sem-abertura:` em `in_brevo`
 * (ver docstring do módulo).
 */
export function decideBrevoSemanalSend(input: {
  semanal: BrevoDiariaSemanalParse;
  editionAammdd: string;
  kitSemAberturaInBrevo: number;
}): BrevoSemanalSendDecision {
  const eff = resolveBrevoEffectiveMode(input.semanal, input.kitSemAberturaInBrevo);
  if ("error" in eff) return { send: false, reason: eff.error };
  if (eff.mode === "diaria") return eff.warning ? { send: true, mode: "diaria", warning: eff.warning } : { send: true, mode: "diaria" };
  const weekday = editionWeekday(input.editionAammdd);
  if (weekday === null) return { send: false, reason: `edição ${input.editionAammdd} não é AAMMDD válido.` };
  if (weekday !== 1) {
    return { send: false, reason: `regime semanal (#11226): a edição ${input.editionAammdd} não é de segunda — sem campanha Brevo.` };
  }
  return { send: true, mode: "semanal" };
}

/** Pura — FNV-1a 32 bits do e-mail normalizado (estável entre rodadas e máquinas). */
export function stableEmailHash(email: string): number {
  let h = 0x811c9dc5;
  for (const ch of email.trim().toLowerCase()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Pura — grupo fixo da pessoa na divisão segunda/terça (sempre o mesmo dia pra mesma pessoa). */
export function semanalSplitGroup(email: string): "segunda" | "terca" {
  return stableEmailHash(email) % 2 === 0 ? "segunda" : "terca";
}

/** Pura — o tamanho da semanal passou do teto que pede divisão? */
export function checkSemanalCapacity(recipients: number, threshold: number): { splitNeeded: boolean; warning?: string } {
  if (recipients <= threshold) return { splitNeeded: false };
  return {
    splitNeeded: true,
    warning:
      `semanal da Brevo com ${recipients} destinatário(s), acima de ${threshold}: a decisão do #11226 é dividir ` +
      "segunda/terça por pessoa (semanalSplitGroup). O envio de terça ainda não existe (follow-up do #11226) — " +
      "esta campanha sai inteira na segunda; confira a cota da conta (300/dia).",
  };
}

// ── estatística do contato → entrada do score semanal ─────────────────────

interface StatEvent {
  campaignId?: unknown;
}
export interface BrevoSemanalStatistics {
  messagesSent?: StatEvent[];
  opened?: StatEvent[];
  clicked?: StatEvent[];
}

/** Pura — o instante cai numa SEGUNDA no horário de Brasília (UTC-3 fixo; o Brasil não tem horário de verão desde 2019). */
export function isMondayBrt(ms: number): boolean {
  return new Date(ms - 3 * 3600 * 1000).getUTCDay() === 1;
}

/**
 * Pura — monta a entrada de `classifyBrevoDiariaSemanalAction` a partir de
 * `statistics` do `GET /contacts/{email}`. Semanal = campanha enviada a
 * partir de `desdeMs` E numa SEGUNDA (BRT): na transição (#10533) e com
 * `--fora-da-segunda` a Brevo ainda manda campanha em outros dias, e contar
 * essas como semanais encurtaria a sequência de 12 pra ~2 semanas (#11226,
 * review). Envio sem timestamp legível nunca conta como semanal (fail-safe:
 * não soma à sequência que suprime). Madura = >= 48h.
 *
 * - `clickedSinceDesde`: clique em campanha ENVIADA a partir de `desdeMs`
 *   (qualquer dia) — nunca clique histórico (premissa A do #11226).
 * - `everOpened`: abertura em qualquer campanha da janela que a Brevo
 *   devolve. **A Brevo devolve só os últimos 90 dias por padrão** ("this
 *   endpoint will show the statistics of contact for the recent 90 days by
 *   default", developers.brevo.com/reference/getcontactinfo-1, lido em
 *   27/10/2026): o caller soma o marcador persistido `ever_opened` do store.
 */
export function buildSemanalEvaluationInput(
  statistics: BrevoSemanalStatistics | undefined,
  desdeMs: number,
  nowMs: number,
): BrevoSemanalEvaluationInput {
  const ids = (events: StatEvent[] | undefined): Set<unknown> =>
    new Set<unknown>((Array.isArray(events) ? events : []).map((e) => e?.campaignId).filter((v) => v !== undefined));
  const opened = ids(statistics?.opened);
  const clicked = ids(statistics?.clicked);
  const maturationMs = BREVO_DIARIA_MATURATION_HOURS * 3600 * 1000;
  // Envio mais antigo por campanha, a partir do corte.
  const sentAtByCampaign = new Map<unknown, number>();
  for (const e of Array.isArray(statistics?.messagesSent) ? statistics!.messagesSent! : []) {
    if (e?.campaignId === undefined) continue;
    const ts = eventTimestampMs(e);
    if (ts === null || ts < desdeMs) continue;
    const prev = sentAtByCampaign.get(e.campaignId);
    if (prev === undefined || ts < prev) sentAtByCampaign.set(e.campaignId, ts);
  }
  const semanais: BrevoSemanalSend[] = [...sentAtByCampaign.entries()]
    .filter(([, ts]) => isMondayBrt(ts))
    .map(([id, ts]) => ({
      sentAtMs: ts,
      mature: nowMs - ts >= maturationMs,
      opened: opened.has(id),
      clicked: clicked.has(id),
    }));
  const clickedSinceDesde = [...clicked].some((id) => sentAtByCampaign.has(id));
  return { semanais, everOpened: opened.size > 0, clickedSinceDesde };
}
