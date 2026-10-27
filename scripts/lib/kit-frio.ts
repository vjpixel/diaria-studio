/**
 * scripts/lib/kit-frio.ts (#11221)
 *
 * Miolo PURO do fluxo "assinante frio no Kit": em vez de mover pra Brevo e
 * descadastrar (#10437, revisado), quem esfria fica no Kit, sai da diária e
 * recebe só a edição de segunda num 2º broadcast. Decisão do editor de
 * 27/10/2026 (issue #11221):
 *
 * 1. **Frio** — ativo no Kit sem abertura nem clique há 30 dias (cadastro com
 *    menos de 90 dias) ou 90 dias (cadastro com 90 dias ou mais). Ganha a tag
 *    `frio` e sai da diária (o segmento da diária exclui `frio`, passo de
 *    painel — a API do Kit não edita segmento).
 * 2. **Semanal** — toda segunda, 2º broadcast com a mesma edição, filtrado
 *    pela tag `frio`, com o intro de reconfirmação e o botão "Quero a diária"
 *    (`scripts/publish-kit-semanal-frio.ts`).
 * 3. **Volta** — abertura ou clique (botão ou qualquer link) → tira `frio`, a
 *    pessoa volta na edição seguinte.
 * 4. **Supressão sem descadastro** — 12 semanais seguidas sem sinal → tag
 *    `suprimido` (e sai de `frio`): sem envio nenhum, mas segue ATIVA no Kit.
 *    Nada aqui chama unsubscribe — só tags.
 * 5. **Vigia** — reclamação de spam da semanal > 0,1% ou queda clara da
 *    abertura da diária no Gmail depois do início da semanal → pausa a semanal
 *    e alerta o editor (`decideSemanalFrioVigia`).
 *
 * ## De onde vem o "sem sinal há N dias"
 *
 * O Kit não expõe "última abertura" por assinante. O sinal é lido por
 * broadcast (`POST /v4/subscribers/filter`, aberturas e cliques) só nos
 * broadcasts da DIÁRIA e das SEMANAIS de frio (registro determinístico por
 * edição, nunca regex de assunto — mesma regra do #10437: abertura sem escopo
 * contaria o e-mail de confirmação e o de boas-vindas). A data do sinal é a
 * do envio do broadcast aberto. Só marca frio quem tem o registro cobrindo a
 * janela inteira (`registryCoversSince`): sem evidência da janela toda, não
 * se afirma "N dias sem sinal" (o Kit virou backend em 04/09/2026; antes de
 * 03/12/2026 nenhuma janela de 90 dias está coberta, e quem tem cadastro com
 * 90+ dias só esfria a partir daí).
 *
 * ## Volta à diária (regra sem estado)
 *
 * `frio` só é aplicada a quem não teve sinal nos últimos `RETURN_WINDOW_DAYS`
 * (>= 30) dias. Logo, qualquer sinal num broadcast enviado nos últimos 30
 * dias, visto com a pessoa já `frio`, é necessariamente posterior à tag: é a
 * volta. Não precisa guardar `tagged_at`.
 */

import { normalizeEmail } from "./brevo-diaria-store.ts";
import { matchFixtureEmail } from "./kit-fixture-patterns.ts";
import { KIT_TEST_SEND_TAG_NAME } from "./kit-broadcasts.ts";
import { KIT_ENVIO_BREVO_TAG_NAME } from "./kit-diaria-audience.ts";
import { KIT_APOIO_NIVEL_FIELD_KEY } from "./apoio-segments-canonical-kit.ts";
import { BREVO_DIARIA_MATURATION_HOURS } from "./shared/brevo-diaria-score.ts";
import type { DiariaBroadcastRecord } from "./kit-sem-abertura.ts";

export const KIT_FRIO_TAG_NAME = "frio";
export const KIT_SUPRIMIDO_TAG_NAME = "suprimido";

/** Janela sem sinal pra cadastro com menos de `KIT_FRIO_AGE_THRESHOLD_DAYS`. */
export const KIT_FRIO_WINDOW_NEW_DAYS = 30;
/** Janela sem sinal pra cadastro com `KIT_FRIO_AGE_THRESHOLD_DAYS` ou mais. */
export const KIT_FRIO_WINDOW_OLD_DAYS = 90;
export const KIT_FRIO_AGE_THRESHOLD_DAYS = 90;
/** Sinal nos últimos N dias tira `frio` (ver docstring do módulo). */
export const KIT_FRIO_RETURN_WINDOW_DAYS = KIT_FRIO_WINDOW_NEW_DAYS;
/** Semanais seguidas sem sinal até `suprimido`. */
export const KIT_FRIO_SUPPRESS_AFTER_SEMANAIS = 12;
/** Vigia: reclamação de spam da semanal acima disto (fração) pausa a semanal. */
export const KIT_FRIO_VIGIA_MAX_COMPLAINT_RATE = 0.001;
/**
 * Vigia: queda da abertura da diária no Gmail (pontos percentuais) que conta
 * como "clara". PREMISSA desta implementação (a issue diz só "queda clara"):
 * 5 pp entre a média das diárias maduras ANTES da 1ª semanal e a das diárias
 * maduras DEPOIS, com pelo menos `KIT_FRIO_VIGIA_MIN_BROADCASTS` de cada lado.
 */
export const KIT_FRIO_VIGIA_MAX_GMAIL_OPEN_DROP_PP = 5;
export const KIT_FRIO_VIGIA_MIN_BROADCASTS = 3;

const DAY_MS = 24 * 3600 * 1000;

/** Fatia de `platform.config.json` → `kit.frio`. */
export interface KitFrioConfig {
  /** Detecção/volta/supressão (`sync-kit-frio.ts --push`). Ausente ⇒ desligada. */
  enabled?: boolean;
  /** Broadcast semanal de segunda pra tag `frio` (`publish-kit-semanal-frio.ts`). Ausente ⇒ desligado. */
  semanal_enabled?: boolean;
}

export function isKitFrioEnabled(cfg: KitFrioConfig | undefined): boolean {
  return cfg?.enabled === true;
}
export function isKitSemanalFrioEnabled(cfg: KitFrioConfig | undefined): boolean {
  return cfg?.semanal_enabled === true;
}

/** Pura — janela sem sinal que vale pra este cadastro (30 ou 90 dias). `null` se `created_at` ilegível. */
export function frioWindowDays(createdAt: string, nowMs: number): number | null {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return null;
  return nowMs - t >= KIT_FRIO_AGE_THRESHOLD_DAYS * DAY_MS ? KIT_FRIO_WINDOW_OLD_DAYS : KIT_FRIO_WINDOW_NEW_DAYS;
}

// ── sinal por assinante ──────────────────────────────────────────────────

/** Aberturas/cliques de um broadcast (diária ou semanal de frio). */
export interface BroadcastSignals {
  broadcastId: number;
  sentAt: string;
  opens: readonly string[];
  clicks: readonly string[];
}

/** Pura — e-mail → ms do envio mais recente que a pessoa abriu ou clicou. */
export function buildLastSignalIndex(perBroadcast: readonly BroadcastSignals[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of perBroadcast) {
    const t = Date.parse(b.sentAt);
    if (!Number.isFinite(t)) continue;
    for (const raw of [...b.opens, ...b.clicks]) {
      const email = normalizeEmail(raw);
      const prev = out.get(email);
      if (prev === undefined || t > prev) out.set(email, t);
    }
  }
  return out;
}

/** Pura — o registro tem broadcast enviado em ou antes de `sinceMs`? (cobre a janela inteira) */
export function registryCoversSince(records: readonly DiariaBroadcastRecord[], sinceMs: number): boolean {
  return records.some((r) => {
    const t = Date.parse(r.sentAt);
    return Number.isFinite(t) && t <= sinceMs;
  });
}

/** Uma semanal de frio, com quem recebeu e quem deu sinal. */
export interface SemanalFrioEngagement {
  broadcastId: number;
  sentAt: string;
  delivered: readonly string[];
  opens: readonly string[];
  clicks: readonly string[];
}

/**
 * Pura — e-mail → semanais de frio MADURAS seguidas (da mais recente pra
 * trás) que a pessoa recebeu sem abrir nem clicar. Semanal que ela não
 * recebeu não quebra nem soma a sequência.
 */
export function buildSemanalFrioSilentStreaks(
  semanais: readonly SemanalFrioEngagement[],
  nowMs: number,
  maturationHours: number = BREVO_DIARIA_MATURATION_HOURS,
): Map<string, number> {
  const mature = semanais
    .filter((s) => {
      const t = Date.parse(s.sentAt);
      return Number.isFinite(t) && nowMs - t >= maturationHours * 3600 * 1000;
    })
    .slice()
    .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt)); // mais recente primeiro
  const streak = new Map<string, number>();
  const broken = new Set<string>();
  for (const s of mature) {
    const signal = new Set([...s.opens, ...s.clicks].map(normalizeEmail));
    for (const raw of new Set(s.delivered.map(normalizeEmail))) {
      if (broken.has(raw)) continue;
      if (signal.has(raw)) {
        broken.add(raw);
        continue;
      }
      streak.set(raw, (streak.get(raw) ?? 0) + 1);
    }
  }
  return streak;
}

// ── decisão por assinante ────────────────────────────────────────────────

export interface KitFrioCandidate {
  id: number;
  email: string;
  created_at: string;
  fields?: Record<string, string | null | undefined>;
  tagNames: readonly string[];
}

export type KitFrioExclusion =
  | "apoiador"
  | "editor_seed"
  | "fixture"
  | "tag_teste"
  | "tag_envio_brevo"
  | "suprimido"
  | "created_at_ilegivel"
  | "cadastro_mais_novo_que_a_janela"
  | "registro_nao_cobre_a_janela"
  | "teve_sinal";

export type KitFrioDecision =
  | { action: "tag_frio"; windowDays: number }
  | { action: "remove_frio"; lastSignalMs: number }
  | { action: "suppress"; silentSemanais: number }
  | { action: "keep_frio"; silentSemanais: number }
  | { action: "skip"; reason: KitFrioExclusion };

/**
 * Pura — o que fazer com UM assinante ativo. Nunca devolve descadastro: os
 * únicos efeitos possíveis são tags (`frio`, `suprimido`).
 */
export function decideKitFrio(
  c: KitFrioCandidate,
  ctx: {
    nowMs: number;
    lastSignal: ReadonlyMap<string, number>;
    silentStreaks: ReadonlyMap<string, number>;
    diariaRecords: readonly DiariaBroadcastRecord[];
    seedEmails: ReadonlySet<string>;
  },
): KitFrioDecision {
  const email = normalizeEmail(c.email);
  const isFrio = c.tagNames.includes(KIT_FRIO_TAG_NAME);
  const lastSignalMs = ctx.lastSignal.get(email);
  if (c.tagNames.includes(KIT_SUPRIMIDO_TAG_NAME)) return { action: "skip", reason: "suprimido" };
  if (isFrio) {
    if (lastSignalMs !== undefined && ctx.nowMs - lastSignalMs <= KIT_FRIO_RETURN_WINDOW_DAYS * DAY_MS) {
      return { action: "remove_frio", lastSignalMs };
    }
    const silent = ctx.silentStreaks.get(email) ?? 0;
    if (silent >= KIT_FRIO_SUPPRESS_AFTER_SEMANAIS) return { action: "suppress", silentSemanais: silent };
    return { action: "keep_frio", silentSemanais: silent };
  }
  const nivel = c.fields?.[KIT_APOIO_NIVEL_FIELD_KEY];
  if ((typeof nivel === "string" && nivel.trim() !== "") || c.tagNames.some((t) => t.toLowerCase().startsWith("apoio-"))) {
    return { action: "skip", reason: "apoiador" };
  }
  if (ctx.seedEmails.has(email)) return { action: "skip", reason: "editor_seed" };
  if (matchFixtureEmail(email) !== null) return { action: "skip", reason: "fixture" };
  if (c.tagNames.includes(KIT_TEST_SEND_TAG_NAME)) return { action: "skip", reason: "tag_teste" };
  // Ainda na Brevo pelo #10437 (resíduo): a devolução ao Kit com `frio` é do script de transição.
  if (c.tagNames.includes(KIT_ENVIO_BREVO_TAG_NAME)) return { action: "skip", reason: "tag_envio_brevo" };
  const windowDays = frioWindowDays(c.created_at, ctx.nowMs);
  if (windowDays === null) return { action: "skip", reason: "created_at_ilegivel" };
  const sinceMs = ctx.nowMs - windowDays * DAY_MS;
  if (Date.parse(c.created_at) > sinceMs) return { action: "skip", reason: "cadastro_mais_novo_que_a_janela" };
  if (!registryCoversSince(ctx.diariaRecords, sinceMs)) return { action: "skip", reason: "registro_nao_cobre_a_janela" };
  if (lastSignalMs !== undefined && lastSignalMs >= sinceMs) return { action: "skip", reason: "teve_sinal" };
  return { action: "tag_frio", windowDays };
}

// ── vigia ────────────────────────────────────────────────────────────────

export interface SemanalFrioVigiaInput {
  /** Destinatários (entregues) da semanal de frio mais recente madura. */
  semanalDelivered: number;
  /** Desses, quantos estão hoje `complained` no Kit. */
  semanalComplained: number;
  /** Abertura (0-1) da diária no Gmail por broadcast maduro, ANTES da 1ª semanal. */
  gmailOpenRatesBefore: readonly number[];
  /** Idem, DEPOIS da 1ª semanal. */
  gmailOpenRatesAfter: readonly number[];
}

export type SemanalFrioVigiaVerdict = { pause: false; notes: string[] } | { pause: true; reasons: string[] };

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Pura — pausa a semanal se a reclamação passar de 0,1% ou a abertura da diária no Gmail cair 5 pp. */
export function decideSemanalFrioVigia(input: SemanalFrioVigiaInput): SemanalFrioVigiaVerdict {
  const reasons: string[] = [];
  const notes: string[] = [];
  if (input.semanalDelivered > 0) {
    const rate = input.semanalComplained / input.semanalDelivered;
    if (rate > KIT_FRIO_VIGIA_MAX_COMPLAINT_RATE) {
      reasons.push(
        `reclamação de spam da semanal de frio em ${(rate * 100).toFixed(2)}% (${input.semanalComplained}/${input.semanalDelivered}), ` +
          `acima de ${(KIT_FRIO_VIGIA_MAX_COMPLAINT_RATE * 100).toFixed(1)}%`,
      );
    }
  } else {
    notes.push("nenhuma semanal de frio madura ainda — reclamação não medida");
  }
  if (input.gmailOpenRatesBefore.length >= KIT_FRIO_VIGIA_MIN_BROADCASTS && input.gmailOpenRatesAfter.length >= KIT_FRIO_VIGIA_MIN_BROADCASTS) {
    const before = mean(input.gmailOpenRatesBefore) * 100;
    const after = mean(input.gmailOpenRatesAfter) * 100;
    if (before - after >= KIT_FRIO_VIGIA_MAX_GMAIL_OPEN_DROP_PP) {
      reasons.push(
        `abertura da diária no Gmail caiu de ${before.toFixed(1)}% pra ${after.toFixed(1)}% depois do início da semanal ` +
          `(queda >= ${KIT_FRIO_VIGIA_MAX_GMAIL_OPEN_DROP_PP} pp)`,
      );
    }
  } else {
    notes.push(`menos de ${KIT_FRIO_VIGIA_MIN_BROADCASTS} diárias maduras de cada lado — queda no Gmail não medida`);
  }
  return reasons.length > 0 ? { pause: true, reasons } : { pause: false, notes };
}

/** Pura — abertura no Gmail (0-1) de um broadcast; `null` sem entregues Gmail. */
export function gmailOpenRate(delivered: readonly string[], opens: readonly string[]): number | null {
  const isGmail = (e: string) => /@(gmail|googlemail)\.com$/i.test(e.trim());
  const del = new Set(delivered.filter(isGmail).map(normalizeEmail));
  if (del.size === 0) return null;
  const op = new Set(opens.filter(isGmail).map(normalizeEmail));
  let n = 0;
  for (const e of op) if (del.has(e)) n++;
  return n / del.size;
}

// ── pausa da semanal (estado em data/) ──────────────────────────────────

export interface SemanalFrioPauseState {
  paused: boolean;
  since?: string;
  reasons?: string[];
}

/** Pura — lê o estado de pausa. JSON ilegível ⇒ PAUSADA (fail-safe: na dúvida, não envia a semanal). */
export function parseSemanalFrioPauseState(raw: string | null): SemanalFrioPauseState {
  if (raw === null || raw.trim() === "") return { paused: false };
  try {
    const p = JSON.parse(raw) as Partial<SemanalFrioPauseState>;
    return { paused: p.paused === true, since: p.since, reasons: Array.isArray(p.reasons) ? p.reasons : undefined };
  } catch {
    return { paused: true, reasons: ["estado de pausa ilegível (fail-safe)"] };
  }
}

// ── registro das semanais de frio ────────────────────────────────────────

/** Estado gravado por edição em `_internal/kit-semanal-frio-published.json`. */
export interface KitSemanalFrioPublished {
  broadcast_id: number;
  status: "scheduled";
  scheduled_at: string;
  source_broadcast_id: number;
  tag_id: number;
  created_at: string;
}

export const KIT_SEMANAL_FRIO_PUBLISHED_FILENAME = "kit-semanal-frio-published.json";

// ── intro do broadcast semanal ───────────────────────────────────────────

/**
 * Texto do topo decidido pelo editor (#11221, item 2), literal. O link do
 * botão é identificável pela UTM (`utm_campaign=semanal-frio`,
 * `utm_content=quero-a-diaria`); o sync tira `frio` por QUALQUER clique ou
 * abertura, então o botão não depende de rota própria.
 */
export const KIT_SEMANAL_FRIO_INTRO_TEXT =
  "Você está recebendo só a edição de segunda porque não registramos aberturas suas nas últimas semanas " +
  "(às vezes o app de e-mail esconde isso da gente). Quer voltar a receber todo dia?";
export const KIT_SEMANAL_FRIO_BUTTON_LABEL = "Quero a diária";
export const KIT_SEMANAL_FRIO_BUTTON_URL =
  "https://diar.ia.br/?utm_source=kit&utm_medium=email&utm_campaign=semanal-frio&utm_content=quero-a-diaria";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Pura — bloco HTML do intro (tabela própria, largura do container, sem caixa). */
export function renderSemanalFrioIntroHtml(): string {
  return (
    `<!-- #11221 intro semanal frio -->\n` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" align="center" style="width:100%;max-width:600px;margin:0 auto;background:#ffffff;">` +
    `<tr><td style="padding:24px 24px 8px 24px;font-family:Georgia,serif;font-size:17px;line-height:1.5;color:#1a1a1a;">` +
    `${escapeHtml(KIT_SEMANAL_FRIO_INTRO_TEXT)}</td></tr>` +
    `<tr><td align="center" style="padding:8px 24px 24px 24px;">` +
    `<a href="${escapeHtml(KIT_SEMANAL_FRIO_BUTTON_URL)}" style="display:inline-block;background:#00A0A0;color:#ffffff;` +
    `font-family:Georgia,serif;font-size:16px;font-weight:bold;text-decoration:none;padding:12px 28px;border-radius:999px;">` +
    `${escapeHtml(KIT_SEMANAL_FRIO_BUTTON_LABEL)}</a></td></tr></table>\n`
  );
}

/**
 * Pura — insere o intro no começo do conteúdo do broadcast principal. Com
 * `<body` (documento completo), logo depois da abertura; sem (fragmento, o
 * caso do conteúdo de broadcast do Kit), no começo.
 */
export function injectSemanalFrioIntro(content: string, introHtml: string = renderSemanalFrioIntroHtml()): string {
  const bodyIdx = content.indexOf("<body");
  if (bodyIdx === -1) return introHtml + content;
  const close = content.indexOf(">", bodyIdx);
  if (close === -1) throw new Error("injectSemanalFrioIntro: tag <body> malformada.");
  return content.slice(0, close + 1) + introHtml + content.slice(close + 1);
}
