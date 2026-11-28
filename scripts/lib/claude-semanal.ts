/**
 * scripts/lib/claude-semanal.ts (#14329)
 *
 * Miolo PURO do e-mail semanal "Claude na semana" (`/diaria-claude-semanal`):
 * atualizações oficiais do Claude da semana, escritas para quem ASSINA o
 * Claude (Pro/Max, apps web/desktop/mobile, Claude Code), com resumo + "como
 * usar" por item. Zero I/O: quem lê disco, feed e Kit são os CLIs
 * `claude-semanal-collect.ts`, `publish-claude-semanal-kit.ts` e
 * `sync-apoio-claude-semanal-tag-kit.ts`.
 *
 * Decisões do editor (27/11/2026, issue #14329):
 *   - Fase de teste só com o Núcleo (`patrono`). O público definitivo não foi
 *     decidido: a audiência é CONFIG (`kit_claude_semanal.audience_niveis` +
 *     `audience_tag`), nunca constante de código. Trocar o público é editar o
 *     config e rodar o sync da tag.
 *   - Só fontes oficiais da Anthropic/Claude, nada de comunidade/terceiros
 *     (`isOfficialClaudeUrl`).
 *   - Nunca pula semana: volume baixo vira "ampliar a coleta", nunca "não
 *     enviar" (`evaluateClaudeSemanalVolume` não tem saída de pular).
 *   - Dedup próprio entre semanas, a partir dos registros de envio deste
 *     canal; `data/past-editions.md` não conta (aparecer na diária não impede
 *     o item de entrar aqui).
 *
 * Audiência por TAG do Kit e não por segmento, com recusa de tag vazia ou não
 * resolvida: racional em `shared/kit-apoio-tag.ts` (#6126, #6582).
 */
import { isApoioNivel, type ApoioNivel } from "./shared/apoio-nivel-types.ts";
import { resolveAudienceTagName, type TagNameResolution } from "./shared/kit-apoio-tag.ts";
import { COLORS } from "./shared/design-tokens.ts";

// ── seções ────────────────────────────────────────────────────────────────

export const CLAUDE_SEMANAL_SECTIONS = [
  { id: "lancamentos", title: "Lançamentos" },
  { id: "dia-a-dia", title: "No dia a dia" },
  { id: "claude-code", title: "Claude Code" },
  { id: "aprenda", title: "Aprenda" },
] as const;

export type ClaudeSemanalSectionId = (typeof CLAUDE_SEMANAL_SECTIONS)[number]["id"];

export function isClaudeSemanalSectionId(v: unknown): v is ClaudeSemanalSectionId {
  return CLAUDE_SEMANAL_SECTIONS.some((s) => s.id === v);
}

/** Prefixo fixo do assunto: diz por que o e-mail chegou, fora da cadência diária. */
export const CLAUDE_SEMANAL_SUBJECT_PREFIX = "Claude na semana: ";
/** Mesmo teto do assunto do D1 (CLAUDE.md, #11254). */
export const CLAUDE_SEMANAL_SUBJECT_MAX_CHARS = 70;
export const CLAUDE_SEMANAL_TITLE_MAX_CHARS = 120;
export const CLAUDE_SEMANAL_RESUMO_MAX_CHARS = 480;
export const CLAUDE_SEMANAL_COMO_USAR_MAX_CHARS = 220;
export const CLAUDE_SEMANAL_INTRO_MAX_CHARS = 320;

/** Comando que cria/popula a tag — entra nas mensagens de erro dos guards. */
export const CLAUDE_SEMANAL_TAG_SYNC_COMMAND = "npx tsx scripts/sync-apoio-claude-semanal-tag-kit.ts --push";

/** Chave de `platform.config.json`. */
export const CLAUDE_SEMANAL_CONFIG_KEY = "kit_claude_semanal";

export class ClaudeSemanalGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeSemanalGuardError";
  }
}

/**
 * Um broadcast PODE existir no Kit (criação sem confirmação, cancelamento sem
 * confirmação, registro não gravado). `cancelled` = o cancelamento automático
 * foi CONFERIDO (nada saiu).
 */
export class ClaudeSemanalIncidentError extends Error {
  constructor(
    message: string,
    readonly broadcastId?: number,
    readonly cancelled = false,
  ) {
    super(message);
    this.name = "ClaudeSemanalIncidentError";
  }
}

// ── config ────────────────────────────────────────────────────────────────

export interface ClaudeSemanalSource {
  name: string;
  url: string;
  /** `rss`: o collect lê o feed. `page`: página HTML que a skill lê (WebFetch) e mescla com `--merge`. */
  kind: "rss" | "page";
  /** Seção mais provável dos itens desta fonte — só uma dica ao writer. */
  section_hint?: ClaudeSemanalSectionId;
  /**
   * Só `rss`: página oficial que cobre o que o feed não cobrir (feed que não
   * alcança o início da janela, ou cortado pelo teto de itens). Ausente = a
   * própria `url` do feed vai para `pages_to_fetch`.
   */
  coverage_page?: string;
}

/** Forma crua de `platform.config.json` → `kit_claude_semanal`. */
export interface KitClaudeSemanalRawConfig {
  audience_tag?: unknown;
  audience_niveis?: unknown;
  send_weekday?: unknown;
  send_time_brt?: unknown;
  min_items?: unknown;
  max_items?: unknown;
  preview_text?: unknown;
  footer_note?: unknown;
  sources?: unknown;
}

export interface ClaudeSemanalConfig {
  audienceTag: string;
  audienceNiveis: readonly ApoioNivel[];
  /** 0 = domingo … 6 = sábado (convenção de `Date.getUTCDay`). */
  sendWeekday: number;
  /** "HH:MM" em BRT (UTC−3 fixo, sem horário de verão). */
  sendTimeBrt: string;
  minItems: number;
  maxItems: number;
  previewText: string | null;
  footerNote: string | null;
  sources: readonly ClaudeSemanalSource[];
}

export type ClaudeSemanalConfigResolution = { ok: true; config: ClaudeSemanalConfig } | { ok: false; reason: string };

export function resolveClaudeSemanalTagName(raw: KitClaudeSemanalRawConfig | null | undefined): TagNameResolution {
  return resolveAudienceTagName(raw?.audience_tag, `${CLAUDE_SEMANAL_CONFIG_KEY}.audience_tag`);
}

/**
 * Pure: valida o bloco de config inteiro. Nenhum campo de AUDIÊNCIA tem
 * default: sem tag ou sem níveis, recusa (o modo de falha destes canais é
 * mandar para a base inteira, #6126). Os campos de cadência e volume têm os
 * defaults da issue (domingo 08:00 BRT, 8 a 15 itens).
 *
 * @pure
 */
export function resolveClaudeSemanalConfig(
  raw: KitClaudeSemanalRawConfig | null | undefined,
): ClaudeSemanalConfigResolution {
  const k = CLAUDE_SEMANAL_CONFIG_KEY;
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: `platform.config.json → ${k} ausente.` };
  }
  const tag = resolveClaudeSemanalTagName(raw);
  if (!tag.ok) return tag;

  if (!Array.isArray(raw.audience_niveis) || raw.audience_niveis.length === 0) {
    return {
      ok: false,
      reason: `platform.config.json → ${k}.audience_niveis ausente ou vazio. Sem níveis não há como projetar a tag; recusando em vez de supor um público.`,
    };
  }
  const niveis: ApoioNivel[] = [];
  for (const n of raw.audience_niveis) {
    const v = typeof n === "string" ? n.trim().toLowerCase() : "";
    if (!isApoioNivel(v)) {
      return { ok: false, reason: `${k}.audience_niveis tem valor inválido: ${JSON.stringify(n)} (use amigo/apoiador/mantenedor/patrono).` };
    }
    if (!niveis.includes(v)) niveis.push(v);
  }

  const sendWeekday = raw.send_weekday === undefined ? 0 : raw.send_weekday;
  if (typeof sendWeekday !== "number" || !Number.isInteger(sendWeekday) || sendWeekday < 0 || sendWeekday > 6) {
    return { ok: false, reason: `${k}.send_weekday inválido: ${JSON.stringify(raw.send_weekday)} (0 = domingo … 6 = sábado).` };
  }
  const sendTimeBrt = raw.send_time_brt === undefined ? "08:00" : raw.send_time_brt;
  if (typeof sendTimeBrt !== "string" || !parseHhMm(sendTimeBrt)) {
    return { ok: false, reason: `${k}.send_time_brt inválido: ${JSON.stringify(raw.send_time_brt)} (esperado "HH:MM").` };
  }
  const minItems = raw.min_items === undefined ? 8 : raw.min_items;
  const maxItems = raw.max_items === undefined ? 15 : raw.max_items;
  if (
    typeof minItems !== "number" ||
    typeof maxItems !== "number" ||
    !Number.isInteger(minItems) ||
    !Number.isInteger(maxItems) ||
    minItems < 1 ||
    maxItems < minItems
  ) {
    return { ok: false, reason: `${k}.min_items/max_items inválidos: ${JSON.stringify(raw.min_items)}/${JSON.stringify(raw.max_items)}.` };
  }

  const sources: ClaudeSemanalSource[] = [];
  if (raw.sources !== undefined) {
    if (!Array.isArray(raw.sources)) return { ok: false, reason: `${k}.sources precisa ser uma lista.` };
    for (const s of raw.sources) {
      const src = s as Partial<ClaudeSemanalSource> | null;
      if (
        !src ||
        typeof src.name !== "string" ||
        typeof src.url !== "string" ||
        (src.kind !== "rss" && src.kind !== "page")
      ) {
        return { ok: false, reason: `${k}.sources tem entrada inválida: ${JSON.stringify(s)}.` };
      }
      if (!isOfficialClaudeUrl(src.url)) {
        return { ok: false, reason: `${k}.sources: "${src.name}" (${src.url}) não é fonte oficial da Anthropic/Claude.` };
      }
      if (src.section_hint !== undefined && !isClaudeSemanalSectionId(src.section_hint)) {
        return { ok: false, reason: `${k}.sources: section_hint inválido em "${src.name}".` };
      }
      if (src.coverage_page !== undefined && (typeof src.coverage_page !== "string" || !isOfficialClaudeUrl(src.coverage_page))) {
        return { ok: false, reason: `${k}.sources: coverage_page de "${src.name}" não é página oficial.` };
      }
      sources.push({
        name: src.name,
        url: src.url,
        kind: src.kind,
        ...(src.section_hint ? { section_hint: src.section_hint } : {}),
        ...(src.coverage_page ? { coverage_page: src.coverage_page } : {}),
      });
    }
  }

  const optText = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    ok: true,
    config: {
      audienceTag: tag.tagName,
      audienceNiveis: niveis,
      sendWeekday,
      sendTimeBrt,
      minItems,
      maxItems,
      previewText: optText(raw.preview_text),
      footerNote: optText(raw.footer_note),
      sources,
    },
  };
}

function parseHhMm(s: string): { h: number; m: number } | null {
  const m = /^(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

// ── semana ────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** BRT = UTC−3 fixo (o Brasil não tem horário de verão desde 2019). */
const BRT_OFFSET_H = 3;

export interface ClaudeSemanalWeek {
  /** AAMMDD do dia do envio — é a chave da semana (`data/claude-semanal/{week}/`). */
  week: string;
  /** Meia-noite BRT do 1º dia da janela de coleta, em ISO UTC. */
  windowStart: string;
  /** Fim (exclusivo) da janela: meia-noite BRT do dia seguinte ao envio, em ISO UTC. */
  windowEnd: string;
  /** 1º e último dia da janela de COLETA, AAAA-MM-DD. */
  firstDay: string;
  lastDay: string;
  /** 1º dia da semana EXIBIDA no e-mail (envio − 6 dias); a coleta pode começar antes. */
  displayFirstDay: string;
  /** Semana do último envio `sent` anterior a esta (a que ancora a janela), ou null. */
  lastSentWeek: string | null;
  /** A semana imediatamente anterior (envio − 7 dias) tem registro `sent`? */
  previousWeekSent: boolean;
}

/** Recuo mínimo da janela de coleta em relação ao dia do envio. */
export const CLAUDE_SEMANAL_MIN_LOOKBACK_DAYS = 14;

function parseAammdd(s: string): { y: number; mo: number; d: number } | null {
  if (!/^\d{6}$/.test(s)) return null;
  const y = 2000 + Number(s.slice(0, 2));
  const mo = Number(s.slice(2, 4));
  const d = Number(s.slice(4, 6));
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return { y, mo, d };
}

function isoDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

function toAammdd(t: number): string {
  const d = new Date(t);
  return `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Pure: a semana de um envio. `week` tem de cair no dia da semana configurado
 * (default domingo): uma data fora dele é quase sempre erro de digitação, e
 * uma semana com chave errada quebraria o dedup entre semanas.
 *
 * Janela de coleta: do dia do último envio `sent` anterior (`lastSentWeek`)
 * ou de envio − 14 dias, o que for MAIS CEDO, até o fim do dia do envio. A
 * janela larga é de propósito: o dedup entre semanas impede repetição, e assim
 * nada some quando a skill roda antes do domingo, quando um item sai no
 * domingo depois da coleta ou quando uma semana inteira é perdida (aí a janela
 * recua até o último envio).
 *
 * `sentWeeks`: semanas com registro `sent` (de `sentWeeksFromRecords`).
 *
 * @pure
 */
export function resolveClaudeSemanalWeek(
  week: string,
  sendWeekday: number,
  sentWeeks: readonly string[] = [],
): ClaudeSemanalWeek {
  const p = parseAammdd(week);
  if (!p) throw new ClaudeSemanalGuardError(`semana inválida: ${JSON.stringify(week)} (esperado AAMMDD do dia do envio).`);
  const day = Date.UTC(p.y, p.mo - 1, p.d);
  if (new Date(day).getUTCDay() !== sendWeekday) {
    throw new ClaudeSemanalGuardError(
      `${week} não cai no dia de envio configurado (send_weekday ${sendWeekday}, 0 = domingo). Passe a data do envio.`,
    );
  }
  // AAMMDD ordena como data no mesmo século.
  const earlier = sentWeeks.filter((w) => w < week && parseAammdd(w)).sort();
  const lastSentWeek = earlier.length > 0 ? earlier[earlier.length - 1] : null;
  const previousWeek = toAammdd(day - 7 * DAY_MS);
  let first = day - CLAUDE_SEMANAL_MIN_LOOKBACK_DAYS * DAY_MS;
  if (lastSentWeek) {
    const ls = parseAammdd(lastSentWeek)!;
    first = Math.min(first, Date.UTC(ls.y, ls.mo - 1, ls.d));
  }
  return {
    week,
    windowStart: new Date(first + BRT_OFFSET_H * 3_600_000).toISOString(),
    windowEnd: new Date(day + DAY_MS + BRT_OFFSET_H * 3_600_000).toISOString(),
    firstDay: isoDay(first),
    lastDay: isoDay(day),
    displayFirstDay: isoDay(day - 6 * DAY_MS),
    lastSentWeek,
    previousWeekSent: sentWeeks.includes(previousWeek),
  };
}

/**
 * Pure: aviso para o banner quando a semana anterior não tem envio `sent` —
 * a janela recua até o último envio (ou 14 dias) para cobrir o buraco.
 *
 * @pure
 */
export function claudeSemanalWindowBanner(w: ClaudeSemanalWeek): string | null {
  if (w.previousWeekSent) return null;
  const desde = w.lastSentWeek ? `desde o último envio (${w.lastSentWeek})` : "sem nenhum envio anterior registrado";
  return `a semana anterior não tem envio registrado (sent) — coleta ${desde}, de ${w.firstDay} a ${w.lastDay}.`;
}

/**
 * Pure: semana default quando o editor não passa data — o próximo dia de envio
 * a partir de hoje (BRT), hoje incluído.
 *
 * @pure
 */
export function defaultClaudeSemanalWeek(now: Date, sendWeekday: number): string {
  const brt = new Date(now.getTime() - BRT_OFFSET_H * 3_600_000);
  const today = Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate());
  const delta = (sendWeekday - new Date(today).getUTCDay() + 7) % 7;
  return toAammdd(today + delta * DAY_MS);
}

/** Antecedência mínima do `send_at` sobre o momento da criação (o Kit exige futuro). */
export const CLAUDE_SEMANAL_MIN_LEAD_MIN = 10;

/**
 * Pure: instante do envio. Horário configurado no dia da semana; se ele já
 * passou (a skill rodou atrasada), agenda para daqui a
 * `CLAUDE_SEMANAL_MIN_LEAD_MIN` minutos e marca `late`. Nunca devolve "não
 * envia": a semana não é pulada (decisão do editor, #14329).
 *
 * @pure
 */
export function resolveClaudeSemanalSendAt(
  week: string,
  sendTimeBrt: string,
  now: Date,
): { sendAt: string; late: boolean } {
  const p = parseAammdd(week);
  const hm = parseHhMm(sendTimeBrt);
  if (!p || !hm) throw new ClaudeSemanalGuardError(`semana/horário inválidos: ${week} ${sendTimeBrt}`);
  const configured = Date.UTC(p.y, p.mo - 1, p.d, hm.h + BRT_OFFSET_H, hm.m);
  const earliest = now.getTime() + CLAUDE_SEMANAL_MIN_LEAD_MIN * 60_000;
  if (configured >= earliest) return { sendAt: new Date(configured).toISOString(), late: false };
  return { sendAt: new Date(Math.ceil(earliest / 60_000) * 60_000).toISOString(), late: true };
}

// ── URL: normalização e fonte oficial ─────────────────────────────────────

const OFFICIAL_REGISTRABLE = ["anthropic.com", "claude.com", "claude.ai"] as const;

/**
 * Pure: só fonte oficial da Anthropic/Claude (decisão do editor, 27/11/2026:
 * sem comunidade nem terceiros). Domínios `anthropic.com`, `claude.com`,
 * `claude.ai` e subdomínios (docs, support, code, platform, academy), mais o
 * GitHub da organização `anthropics` (releases do Claude Code). Só https.
 * `claude.ai/share/…` e `claude.ai/public/…` (conversas e artefatos de
 * usuários) ficam de fora.
 *
 * @pure
 */
export function isOfficialClaudeUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  // Conversa e artefato compartilhados em claude.ai são conteúdo de USUÁRIO
  // (terceiro), não página da Anthropic.
  if ((host === "claude.ai" || host.endsWith(".claude.ai")) && /^\/(share|public)(\/|$)/i.test(u.pathname)) return false;
  if (OFFICIAL_REGISTRABLE.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  if (host === "github.com") return /^\/anthropics\/[^/]+/i.test(u.pathname);
  return false;
}

/**
 * Pure: chave de dedup — host minúsculo sem `www.`, sem parâmetros
 * `utm_*`/`ref`, sem barra final. URL inválida volta aparada (o dedup ainda
 * casa a string igual).
 *
 * O FRAGMENTO FICA na chave, de propósito: as páginas de release notes (apps,
 * plataforma) têm uma URL só para todas as entradas, e cada entrada entra no
 * e-mail como `{página}#{âncora ou AAAA-MM-DD}`. Sem o fragmento, a 1ª semana
 * que mandasse uma entrada da página marcaria a página inteira como "já
 * enviada", e nenhuma entrada nova dela passaria mais.
 *
 * @pure
 */
export function normalizeClaudeSemanalUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return url.trim();
  }
  for (const k of [...u.searchParams.keys()]) {
    if (/^utm_/i.test(k) || k === "ref") u.searchParams.delete(k);
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  const q = u.searchParams.toString();
  const hash = u.hash.length > 1 ? u.hash : "";
  return `${u.protocol}//${host}${path}${q ? `?${q}` : ""}${hash}`;
}

// ── dedup entre semanas ───────────────────────────────────────────────────

/** Item como fica no registro de envio da semana. */
export interface ClaudeSemanalSentItem {
  url: string;
  title: string;
  section: ClaudeSemanalSectionId;
}

/**
 * Pure: URLs (normalizadas) já ENVIADAS em outras semanas, lidas dos
 * registros `claude-semanal-published.json`. Só conta registro `sent`: um
 * `pending`/`cancel-failed` não diz que o item saiu (e trava o envio daquela
 * semana até alguém conferir o Kit). A própria semana fica de fora, para que
 * um `--force` da mesma semana não recuse os próprios itens.
 *
 * Registro ilegível ou de forma desconhecida é IGNORADO aqui, mas listado em
 * `unreadable` para o caller avisar: o pior caso é um item repetido, e o
 * editor vê a prévia antes do envio. Semana `pending`/`cancel-failed` sai em
 * `skipped`, para o mesmo aviso.
 *
 * Itens de um envio anterior que um `--force` sobrescreveu continuam valendo:
 * o registro novo os guarda em `previousItems`, e um `pending`/`cancel-failed`
 * guarda o registro anterior inteiro em `previous` (texto) — os dois são lidos
 * aqui. Sem isso, um `--force` apagaria do dedup o que já saiu.
 *
 * `sentWeeks` lista as semanas `sent` (todas, inclusive a atual) e ancora a
 * janela de coleta (`resolveClaudeSemanalWeek`).
 *
 * @pure
 */
export function sentUrlsFromRecords(
  records: readonly { week: string; raw: unknown }[],
  currentWeek: string,
): { sent: Map<string, string>; unreadable: string[]; skipped: string[]; sentWeeks: string[] } {
  const sent = new Map<string, string>();
  const unreadable: string[] = [];
  const skipped: string[] = [];
  const sentWeeks: string[] = [];
  const addItems = (items: unknown, week: string) => {
    if (!Array.isArray(items)) return;
    for (const it of items) {
      const url = (it as { url?: unknown })?.url;
      if (typeof url === "string" && url.trim()) sent.set(normalizeClaudeSemanalUrl(url), week);
    }
  };
  const addPreviousRaw = (previous: unknown, week: string) => {
    if (typeof previous !== "string") return;
    try {
      const p = JSON.parse(previous) as { status?: unknown; items?: unknown; previousItems?: unknown; previous?: unknown };
      if (p?.status === "sent") {
        addItems(p.items, week);
        addItems(p.previousItems, week);
      } else {
        addPreviousRaw(p?.previous, week);
      }
    } catch {
      /* registro anterior ilegível: nada a somar */
    }
  };
  for (const { week, raw } of records) {
    const r = raw as { status?: unknown; items?: unknown; previousItems?: unknown; previous?: unknown } | null;
    if (!r || typeof r !== "object") {
      if (week !== currentWeek) unreadable.push(week);
      continue;
    }
    if (r.status === "sent") {
      if (!Array.isArray(r.items)) {
        if (week !== currentWeek) unreadable.push(week);
        continue;
      }
      sentWeeks.push(week);
      if (week === currentWeek) continue;
      addItems(r.items, week);
      addItems(r.previousItems, week);
      continue;
    }
    if (week === currentWeek) continue;
    if (r.status === "pending" || r.status === "cancel-failed") {
      skipped.push(`${week} (${r.status})`);
      addPreviousRaw(r.previous, week);
      continue;
    }
    unreadable.push(week);
  }
  return { sent, unreadable, skipped, sentWeeks: sentWeeks.sort() };
}

/** Pure: itens já enviados por um registro `sent` (os dele + os que ele herdou de um `--force`). */
export function accumulatedSentItems(record: { items?: unknown; previousItems?: unknown }): ClaudeSemanalSentItem[] {
  const out: ClaudeSemanalSentItem[] = [];
  for (const list of [record.items, record.previousItems]) {
    if (!Array.isArray(list)) continue;
    for (const it of list) {
      const x = it as Partial<ClaudeSemanalSentItem>;
      if (typeof x?.url === "string" && typeof x.title === "string" && isClaudeSemanalSectionId(x.section)) {
        out.push({ url: x.url, title: x.title, section: x.section });
      }
    }
  }
  return out;
}

// ── candidatos da coleta ──────────────────────────────────────────────────

export interface ClaudeSemanalCandidate {
  url: string;
  title: string;
  published_at: string;
  summary: string;
  source: string;
  section_hint?: ClaudeSemanalSectionId;
}

export interface RawCandidate {
  url?: unknown;
  title?: unknown;
  published_at?: unknown;
  summary?: unknown;
  source?: unknown;
  section_hint?: unknown;
}

export interface CandidateSelection {
  candidates: ClaudeSemanalCandidate[];
  alreadySent: { url: string; title: string; week: string }[];
  outOfWindow: { url: string; title: string; published_at: string | null }[];
  rejected: { url: string; reason: string }[];
}

/**
 * Pure: filtra candidatos da semana — fonte oficial, data dentro da janela,
 * não enviado antes, sem URL repetida. Item sem data é rejeitado (sem data não
 * há como saber se é da semana; a página que não data o item tem de ser lida e
 * datada pela skill antes do `--merge`).
 *
 * @pure
 */
export function selectWeekCandidates(
  raw: readonly RawCandidate[],
  week: ClaudeSemanalWeek,
  sent: ReadonlyMap<string, string>,
): CandidateSelection {
  const out: CandidateSelection = { candidates: [], alreadySent: [], outOfWindow: [], rejected: [] };
  const seen = new Set<string>();
  const start = Date.parse(week.windowStart);
  const end = Date.parse(week.windowEnd);
  for (const c of raw) {
    const url = typeof c.url === "string" ? c.url.trim() : "";
    const title = typeof c.title === "string" ? c.title.replace(/\s+/g, " ").trim() : "";
    if (!url || !title) {
      out.rejected.push({ url: url || "(sem url)", reason: "sem url ou sem título" });
      continue;
    }
    if (!isOfficialClaudeUrl(url)) {
      out.rejected.push({ url, reason: "fonte não oficial (só Anthropic/Claude entram, #14329)" });
      continue;
    }
    const pub = typeof c.published_at === "string" ? c.published_at : null;
    const t = pub ? Date.parse(pub) : NaN;
    if (Number.isNaN(t)) {
      out.rejected.push({ url, reason: "sem data de publicação legível" });
      continue;
    }
    if (t < start || t >= end) {
      out.outOfWindow.push({ url, title, published_at: pub });
      continue;
    }
    const key = normalizeClaudeSemanalUrl(url);
    const prevWeek = sent.get(key);
    if (prevWeek !== undefined) {
      out.alreadySent.push({ url, title, week: prevWeek });
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.candidates.push({
      url,
      title,
      published_at: new Date(t).toISOString(),
      summary: typeof c.summary === "string" ? c.summary.trim() : "",
      source: typeof c.source === "string" ? c.source : "",
      ...(isClaudeSemanalSectionId(c.section_hint) ? { section_hint: c.section_hint } : {}),
    });
  }
  out.candidates.sort((a, b) => a.published_at.localeCompare(b.published_at));
  return out;
}

/** Dias de folga, antes do início da janela, pedidos ao feed para medir se ele alcança a janela. */
export const CLAUDE_SEMANAL_FEED_LOOKBACK_EXTRA_DAYS = 30;

/**
 * Pure: o feed cobre a janela inteira? O collect pede ao feed a janela MAIS
 * `CLAUDE_SEMANAL_FEED_LOOKBACK_EXTRA_DAYS` dias; se mesmo assim a entrada
 * mais antiga que voltou é posterior ao início da janela, o feed não alcança
 * a janela (feed curto, ou cortado pelo teto de itens — `truncated`) e itens
 * do começo dela podem ter ficado de fora. Devolve o motivo, ou null.
 *
 * Feed cortado pelo teto mas cuja entrada mais antiga mantida já é anterior à
 * janela cobre a janela inteira (o teto corta as MAIS ANTIGAS) e não é buraco.
 * Feed sem nenhuma entrada no período não é buraco (é semana sem post).
 *
 * @pure
 */
export function feedCoverageGap(
  articles: readonly { published_at: string | null }[],
  truncated: number,
  windowStart: string,
): string | null {
  const times = articles.map((a) => (a.published_at ? Date.parse(a.published_at) : NaN)).filter((t) => !Number.isNaN(t));
  if (times.length === 0) return null;
  const oldest = Math.min(...times);
  if (oldest <= Date.parse(windowStart)) return null;
  const oldestIso = new Date(oldest).toISOString();
  return truncated > 0
    ? `feed cortado pelo teto (${truncated} entrada(s) a mais) e a mais antiga mantida (${oldestIso}) é posterior ao início da janela (${windowStart})`
    : `a entrada mais antiga do feed (${oldestIso}) é posterior ao início da janela (${windowStart}): o feed não alcança a janela`;
}

// ── volume: nunca pula semana ─────────────────────────────────────────────

export type ClaudeSemanalVolume =
  | { kind: "ok"; count: number }
  | { kind: "abaixo"; count: number; faltam: number; instrucao: string }
  | { kind: "acima"; count: number; sobram: number; instrucao: string };

/**
 * Pure: avalia o volume de itens. Abaixo do mínimo a resposta é SEMPRE ampliar
 * a coleta dentro das fontes oficiais, nunca deixar de enviar (decisão do
 * editor, 27/11/2026: o e-mail sai toda semana, sem exceção). Não existe saída
 * "pular" neste tipo, e o teste de regressão trava isso.
 *
 * @pure
 */
export function evaluateClaudeSemanalVolume(count: number, minItems: number, maxItems: number): ClaudeSemanalVolume {
  if (count < minItems) {
    return {
      kind: "abaixo",
      count,
      faltam: minItems - count,
      instrucao:
        `faltam ${minItems - count} item(ns) para o mínimo de ${minItems}. Completar com No dia a dia, Claude Code e ` +
        "Aprenda; se ainda faltar, ampliar a coleta nas fontes oficiais (guias, cursos e páginas de ajuda novas ou " +
        "atualizadas). A semana nunca é pulada.",
    };
  }
  if (count > maxItems) {
    return {
      kind: "acima",
      count,
      sobram: count - maxItems,
      instrucao: `${count - maxItems} item(ns) acima do teto de ${maxItems}: cortar os de menor impacto para o assinante.`,
    };
  }
  return { kind: "ok", count };
}

// ── rascunho do writer ────────────────────────────────────────────────────

export interface ClaudeSemanalItem {
  title: string;
  resumo: string;
  como_usar: string;
  url: string;
}

export interface ClaudeSemanalDraft {
  week: string;
  /** Parte do assunto que vem depois de `CLAUDE_SEMANAL_SUBJECT_PREFIX`. */
  subject: string;
  subject_options?: string[];
  intro: string;
  sections: { id: ClaudeSemanalSectionId; items: ClaudeSemanalItem[] }[];
}

/**
 * Pure: parse estrito do `02-draft.json` gravado pelo `claude-semanal-writer`.
 * Lança `ClaudeSemanalGuardError` em forma inválida: rascunho quebrado nunca
 * vira e-mail com seção sumida.
 *
 * @pure
 */
export function parseClaudeSemanalDraft(raw: unknown, expectedWeek: string): ClaudeSemanalDraft {
  const fail = (msg: string): never => {
    throw new ClaudeSemanalGuardError(`rascunho inválido: ${msg}`);
  };
  const d = raw as Record<string, unknown> | null;
  if (!d || typeof d !== "object") fail("não é um objeto JSON");
  const o = d as Record<string, unknown>;
  if (o.week !== expectedWeek) fail(`week ${JSON.stringify(o.week)} não é a semana ${expectedWeek}`);
  if (typeof o.subject !== "string" || !o.subject.trim()) fail("subject ausente");
  if (typeof o.intro !== "string" || !o.intro.trim()) fail("intro ausente");
  if (!Array.isArray(o.sections)) fail("sections ausente");
  const seenSections = new Set<string>();
  const sections = (o.sections as unknown[]).map((s, i) => {
    const sec = s as { id?: unknown; items?: unknown } | null;
    if (!sec || !isClaudeSemanalSectionId(sec.id)) fail(`sections[${i}].id inválido`);
    const id = (sec as { id: ClaudeSemanalSectionId }).id;
    if (seenSections.has(id)) fail(`seção ${id} repetida`);
    seenSections.add(id);
    if (!Array.isArray(sec!.items)) fail(`sections[${i}].items ausente`);
    const items = (sec!.items as unknown[]).map((it, j) => {
      const x = it as Record<string, unknown> | null;
      for (const f of ["title", "resumo", "como_usar", "url"] as const) {
        if (!x || typeof x[f] !== "string" || !(x[f] as string).trim()) fail(`${id}.items[${j}].${f} ausente`);
      }
      return {
        title: (x!.title as string).trim(),
        resumo: (x!.resumo as string).trim(),
        como_usar: (x!.como_usar as string).trim(),
        url: (x!.url as string).trim(),
      };
    });
    return { id, items };
  });
  const subjectOptions = Array.isArray(o.subject_options)
    ? (o.subject_options as unknown[]).filter((v): v is string => typeof v === "string")
    : undefined;
  return {
    week: expectedWeek,
    subject: (o.subject as string).trim(),
    ...(subjectOptions ? { subject_options: subjectOptions } : {}),
    intro: (o.intro as string).trim(),
    sections,
  };
}

export function draftItems(draft: ClaudeSemanalDraft): (ClaudeSemanalItem & { section: ClaudeSemanalSectionId })[] {
  return draft.sections.flatMap((s) => s.items.map((it) => ({ ...it, section: s.id })));
}

/** Pure: assunto completo do e-mail. */
export function buildClaudeSemanalSubject(subject: string): string {
  return `${CLAUDE_SEMANAL_SUBJECT_PREFIX}${subject.replace(/\s+/g, " ").trim()}`;
}

/**
 * Pure: problemas de cópia num texto que vai ao leitor. Regras do CLAUDE.md:
 * nunca seta (#9721), nada de markdown no output final, e (regra deste canal)
 * nada de URL no texto (o link vai no título do item).
 *
 * @pure
 */
export function claudeSemanalCopyProblems(text: string, where: string): string[] {
  const out: string[] = [];
  if (/[→←]/.test(text)) out.push(`${where}: seta (→/←) no texto (#9721)`);
  if (/\*\*|__|`|^\s*#|^\s*[-*•] |\[[^\]]*\]\([^)]*\)/m.test(text)) out.push(`${where}: markdown no texto (o e-mail sai sem markdown)`);
  if (/https?:\/\/|www\./i.test(text)) out.push(`${where}: URL no texto (o link vai só no título do item)`);
  return out;
}

export interface ClaudeSemanalDraftCheckOptions {
  /** URLs normalizadas já enviadas em outras semanas → semana do envio. */
  sent: ReadonlyMap<string, string>;
}

/**
 * Pure: tudo que impede o rascunho de sair. Lista vazia = pode ir ao gate.
 * O volume fica de fora de propósito (aviso, ver `evaluateClaudeSemanalVolume`).
 *
 * @pure
 */
export function claudeSemanalDraftProblems(draft: ClaudeSemanalDraft, opts: ClaudeSemanalDraftCheckOptions): string[] {
  const out: string[] = [];
  const subject = buildClaudeSemanalSubject(draft.subject);
  if (subject.length > CLAUDE_SEMANAL_SUBJECT_MAX_CHARS) {
    out.push(`assunto com ${subject.length} caracteres (teto ${CLAUDE_SEMANAL_SUBJECT_MAX_CHARS}, prefixo incluído): "${subject}"`);
  }
  out.push(...claudeSemanalCopyProblems(draft.subject, "assunto"));
  if (draft.intro.length > CLAUDE_SEMANAL_INTRO_MAX_CHARS) {
    out.push(`intro com ${draft.intro.length} caracteres (teto ${CLAUDE_SEMANAL_INTRO_MAX_CHARS})`);
  }
  out.push(...claudeSemanalCopyProblems(draft.intro, "intro"));

  const seen = new Map<string, { where: string; section: ClaudeSemanalSectionId }>();
  for (const it of draftItems(draft)) {
    const where = `${it.section} "${it.title.slice(0, 60)}"`;
    if (!isOfficialClaudeUrl(it.url)) out.push(`${where}: link não é fonte oficial (${it.url})`);
    const key = normalizeClaudeSemanalUrl(it.url);
    const prevWeek = opts.sent.get(key);
    if (prevWeek !== undefined) out.push(`${where}: já enviado na semana ${prevWeek} (${it.url})`);
    // Exceção: no Claude Code, um release com várias mudanças relevantes vira
    // um item por mudança (decisão da issue), todos com o link do release.
    const dup = seen.get(key);
    if (dup !== undefined && !(dup.section === "claude-code" && it.section === "claude-code")) {
      out.push(`${where}: link repetido no e-mail (também em ${dup.where})`);
    }
    if (dup === undefined) seen.set(key, { where, section: it.section });
    if (it.title.length > CLAUDE_SEMANAL_TITLE_MAX_CHARS) out.push(`${where}: título com ${it.title.length} caracteres (teto ${CLAUDE_SEMANAL_TITLE_MAX_CHARS})`);
    if (it.resumo.length > CLAUDE_SEMANAL_RESUMO_MAX_CHARS) out.push(`${where}: resumo com ${it.resumo.length} caracteres (teto ${CLAUDE_SEMANAL_RESUMO_MAX_CHARS})`);
    if (/\n/.test(it.como_usar)) out.push(`${where}: "como usar" tem de ser uma linha só`);
    if (it.como_usar.length > CLAUDE_SEMANAL_COMO_USAR_MAX_CHARS) out.push(`${where}: "como usar" com ${it.como_usar.length} caracteres (teto ${CLAUDE_SEMANAL_COMO_USAR_MAX_CHARS})`);
    out.push(
      ...claudeSemanalCopyProblems(it.title, `${where} título`),
      ...claudeSemanalCopyProblems(it.resumo, `${where} resumo`),
      ...claudeSemanalCopyProblems(it.como_usar, `${where} como usar`),
    );
  }
  // Volume fora de min..max NÃO entra aqui: é aviso (`evaluateClaudeSemanalVolume`),
  // nunca bloqueio. A semana não é pulada, e a aprovação do editor no gate já é
  // o consentimento para sair com menos (ou mais) itens (#14329).
  return out;
}

// ── render ────────────────────────────────────────────────────────────────

const { brand: TEAL, ink: INK, paperEmail: PAPER, paperAlt: BEGE } = COLORS;
const SANS = "-apple-system,Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

/** Escape de HTML + chaves (o Kit interpreta o conteúdo como Liquid). */
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** Pure: "22/nov a 29/nov" a partir dos dias AAAA-MM-DD da janela. */
export function formatClaudeSemanalRange(firstDay: string, lastDay: string): string {
  const f = (iso: string) => `${Number(iso.slice(8, 10))}/${MESES[Number(iso.slice(5, 7)) - 1]}`;
  return `${f(firstDay)} a ${f(lastDay)}`;
}

export interface RenderedClaudeSemanalEmail {
  subject: string;
  previewText: string;
  html: string;
  /** Versão texto, para a prévia no terminal e para conferência. */
  text: string;
}

/**
 * Pure: e-mail completo. Regras de e-mail iguais às do canal da Stack: tudo
 * inline, tabela externa 100% + interna 600, sem `<style>`. Seção sem item não
 * aparece.
 *
 * @pure
 */
export function renderClaudeSemanalEmail(
  draft: ClaudeSemanalDraft,
  week: ClaudeSemanalWeek,
  copy: { previewText: string | null; footerNote: string | null },
): RenderedClaudeSemanalEmail {
  const subject = buildClaudeSemanalSubject(draft.subject);
  const previewText = copy.previewText ?? draft.intro.split(/(?<=[.!?])\s/)[0].slice(0, 140);
  const footer = copy.footerNote ?? "Você recebe este e-mail da diar.ia.br.";
  // A semana exibida é a do envio (7 dias); a janela de coleta pode ser maior.
  const range = formatClaudeSemanalRange(week.displayFirstDay, week.lastDay);

  const htmlSections: string[] = [];
  const textSections: string[] = [];
  for (const meta of CLAUDE_SEMANAL_SECTIONS) {
    const sec = draft.sections.find((s) => s.id === meta.id);
    if (!sec || sec.items.length === 0) continue;
    htmlSections.push(
      `<h2 style="margin:32px 0 12px;padding-top:16px;border-top:1px solid ${BEGE};font-family:${SANS};font-size:13px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;color:${INK};">${escHtml(meta.title)}</h2>`,
    );
    textSections.push(meta.title.toUpperCase());
    for (const it of sec.items) {
      htmlSections.push(
        `<h3 style="margin:20px 0 8px;font-family:${SERIF};font-size:19px;line-height:1.3;color:${INK};"><a href="${escHtml(it.url)}" style="color:${TEAL};text-decoration:underline;">${escHtml(it.title)}</a></h3>`,
        `<p style="margin:0 0 10px;font-family:${SANS};font-size:16px;line-height:1.6;color:${INK};">${escHtml(it.resumo)}</p>`,
        `<p style="margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:1.6;color:${INK};"><strong>Como usar:</strong> ${escHtml(it.como_usar)}</p>`,
      );
      textSections.push(`${it.title}\n${it.url}\n${it.resumo}\nComo usar: ${it.como_usar}`);
    }
  }

  const html = `<!doctype html>
<html lang="pt-BR">
<body style="margin:0;padding:0;background:${BEGE};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escHtml(previewText)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BEGE};">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:${PAPER};border-radius:12px;overflow:hidden;">
        <tr><td style="padding:36px 32px 32px;">
          <p style="margin:0 0 6px;font-family:${SANS};font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${INK};opacity:.7;">${escHtml(range)}</p>
          <h1 style="margin:0 0 20px;font-family:${SERIF};font-size:26px;line-height:1.25;color:${INK};">O Claude na semana</h1>
          <p style="margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:1.6;color:${INK};">${escHtml(draft.intro)}</p>
${htmlSections.join("\n")}
          <p style="margin:28px 0 0;font-family:${SANS};font-size:13px;line-height:1.6;color:${INK};opacity:.7;">${escHtml(footer)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  const text = [`${subject}`, range, "", draft.intro, "", textSections.join("\n\n"), "", footer].join("\n");
  return { subject, previewText, html, text };
}
