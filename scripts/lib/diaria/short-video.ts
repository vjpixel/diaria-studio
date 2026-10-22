/**
 * scripts/lib/diaria/short-video.ts (#10769)
 *
 * Miolo PURO da publicação do vídeo CURTO (vertical) de cada edição: o recorte
 * de ~2 min do "diar.ia.br comentada" (#10659) que sai como YouTube Shorts e
 * como Reels no Facebook e no Instagram. Sem I/O, sem rede — quem lê arquivo e
 * chama a Graph API é `scripts/publish-shorts.ts`.
 *
 * Decisões do editor que este módulo codifica (#10769, 21-22/10/2026):
 *   - objetivo é levar gente pro canal do YouTube (@diariabr) — o CTA aponta
 *     pro canal; o link da edição vai na legenda do Facebook (no Instagram,
 *     "link da bio");
 *   - Reels TODO DIA nas páginas diar.ia.br e VJ Pixel (MemeLab saiu, #10790)
 *     e no perfil pessoal do editor. Jandig, Teatro vs Game e Criaturas Afetivas ficam fora
 *     da rotina — só quando o editor pedir, nunca automático;
 *   - YouTube Shorts: título `{D1} #Shorts`, descrição curta, vídeo
 *     relacionado = o longo da edição — fluxo validado à mão no 1º Short,
 *     https://youtube.com/shorts/nhMUtgPPs4U. SEM comentário fixado (#10831):
 *     desde 2023 link em descrição E em comentário de Short não é clicável; o
 *     único caminho clicável é o vídeo relacionado, vinculado depois que o
 *     horizontal publica (#10811);
 *   - horário próprio do vertical (#10831): o horizontal sai às 06:00 junto da
 *     newsletter; o vertical sai num teste de 2 semanas alternando 12:00 e
 *     19:00 BRT (`resolveShortTime`, config `publishing.shorts.schedule`).
 *
 * Por que YouTube Shorts e o perfil pessoal são passos GUIADOS (Chrome, com o
 * editor escolhendo o arquivo) e não API:
 *   - YouTube: sem a auditoria do projeto GCP, todo `videos.insert` sai travado
 *     em `private` (`YOUTUBE_API_PROJECT_AUDITED`, #10659) — o Short não fica
 *     público por API até a auditoria;
 *   - perfil pessoal: a Graph API não publica em perfil de pessoa, só em Página.
 */

import { BEEHIIV_BASE_URL } from "../edition-url.ts";
import { civilDayNumber, formatCivilDate, parseIsoCivilDate, type CivilDate } from "../social-schedule-rotation.ts";
import {
  DEFAULT_MIN_GAP_MINUTES,
  brtDayWindow,
  planSlots,
  socialAccountKey,
  type ScheduledSlot,
  type SlotRule,
} from "../social-slot-planner.ts";
import { YOUTUBE_TITLE_MAX_CHARS, sanitizeForYouTube, stripInlineMarkdown } from "./youtube-video.ts";

/** Canal do YouTube que os Shorts/Reels divulgam. */
export const DIARIA_YOUTUBE_CHANNEL_URL = "https://www.youtube.com/@diariabr";

/** Convenção de nome do vertical por edição (ao lado do longo, `diaria-comentada-{AAMMDD}.mp4`). */
export function shortVideoFileName(aammdd: string): string {
  return `diaria-comentada-${aammdd}-short.mp4`;
}

/** Registro do que já saiu, por destino (idempotência do `publish-shorts.ts`). */
export const SHORTS_PUBLISHED_FILE = "_internal/06-shorts-published.json";

/** Teto da legenda do Reels no Instagram (2.200 caracteres, doc `ig-user/media`). */
export const INSTAGRAM_CAPTION_MAX_CHARS = 2200;

/** Hashtags fixas — `#Shorts` só no YouTube, onde ajuda a classificação. */
export const SHORTS_HASHTAGS = ["#IA", "#inteligênciaartificial"] as const;

export interface ShortD1Input {
  title: string;
  /** Corpo do D1 (pode ter markdown). */
  body: string;
}

/**
 * 1ª frase do corpo do D1, sem markdown — o "gancho" das legendas curtas.
 * Frase longa demais é cortada na última palavra que cabe (com "…"); se a
 * última palavra começar antes da metade do limite, corta seco no caractere.
 * O fim de frase é o 1º `.`/`!`/`?` seguido de espaço — abreviação ("Dr. X")
 * corta antes; aceitável pra um gancho, e o texto inteiro está no vídeo.
 */
export function firstSentence(body: string, maxChars = 220): string {
  const plain = stripInlineMarkdown(body).replace(/\s+/g, " ").trim();
  if (!plain) return "";
  const m = plain.match(/^.+?[.!?](?=\s|$)/);
  const sentence = (m ? m[0] : plain).trim();
  const chars = Array.from(sentence);
  if (chars.length <= maxChars) return sentence;
  const cut = chars.slice(0, maxChars - 1).join("");
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** UTMs de um link do projeto num vídeo curto (`utm_medium=shorts|reels`). */
export function withShortUtm(
  url: string,
  utm: { source: "youtube" | "facebook" | "instagram"; medium: "shorts" | "reels"; campaign: string; content?: string | null },
): string {
  const u = new URL(url);
  u.searchParams.set("utm_source", utm.source);
  u.searchParams.set("utm_medium", utm.medium);
  u.searchParams.set("utm_campaign", utm.campaign);
  if (utm.content) u.searchParams.set("utm_content", utm.content);
  return u.toString();
}

/**
 * Metadados do Short. Sem comentário fixado (#10831): link em comentário de
 * Short não é clicável desde 2023 — o funil clicável é o vídeo relacionado.
 */
export interface YouTubeShortMetadata {
  title: string;
  description: string;
}

/** Título `{D1} #Shorts`, truncando só o D1 se passar de 100 caracteres. */
export function buildYouTubeShortTitle(d1Title: string): string {
  const suffix = " #Shorts";
  const base = sanitizeForYouTube(stripInlineMarkdown(d1Title).replace(/\s+/g, " ").trim());
  const room = YOUTUBE_TITLE_MAX_CHARS - suffix.length;
  const chars = Array.from(base);
  const head = chars.length <= room ? base : `${chars.slice(0, room - 1).join("").trimEnd()}…`;
  return `${head}${suffix}`;
}

export function buildYouTubeShortMetadata(input: { d1: ShortD1Input }): YouTubeShortMetadata {
  if (!input.d1.title.trim()) throw new Error("D1 sem título");
  const hook = sanitizeForYouTube(firstSentence(input.d1.body));
  const description = [
    hook,
    "",
    `Vídeo completo e edição: ${BEEHIIV_BASE_URL.replace(/^https:\/\//, "")}`,
    ["#Shorts", ...SHORTS_HASHTAGS].join(" "),
  ]
    .filter((l, i) => i > 0 || l)
    .join("\n")
    .trim();
  return { title: buildYouTubeShortTitle(input.d1.title), description };
}

export type ReelsPlatform = "facebook" | "instagram";

/**
 * Legenda do Reels. Tratamos link em legenda de Reels como não clicável nas
 * duas redes (é o comportamento do app hoje), então o CTA principal é o canal escrito por extenso; no Facebook
 * o link da edição vai com UTM (atribuível se alguém copiar), no Instagram a
 * chamada é pro link da bio (padrão dos posts diários).
 */
export function buildReelsCaption(input: {
  platform: ReelsPlatform;
  aammdd: string;
  d1: ShortD1Input;
  editionUrl: string;
  /** `utm_content` da página do Facebook (`page-memelab`…); null = sem tag. */
  utmContent?: string | null;
}): string {
  const title = stripInlineMarkdown(input.d1.title).replace(/\s+/g, " ").trim();
  if (!title) throw new Error("D1 sem título");
  const hook = firstSentence(input.d1.body);
  const channel = `Vídeo completo no YouTube: ${DIARIA_YOUTUBE_CHANNEL_URL.replace(/^https:\/\/www\./, "")}`;
  const edition =
    input.platform === "instagram"
      ? "Edição completa no link da bio."
      : `Edição completa: ${withShortUtm(input.editionUrl, {
          source: "facebook",
          medium: "reels",
          campaign: input.aammdd,
          content: input.utmContent ?? null,
        })}`;
  const caption = [title, hook, [channel, edition].join("\n"), SHORTS_HASHTAGS.join(" ")].filter(Boolean).join("\n\n");
  if (input.platform === "instagram" && Array.from(caption).length > INSTAGRAM_CAPTION_MAX_CHARS) {
    throw new Error(`legenda do Instagram passou de ${INSTAGRAM_CAPTION_MAX_CHARS} caracteres`);
  }
  return caption;
}

/** Configuração `publishing.shorts` em `platform.config.json`. */
export interface ShortsConfig {
  /** Slugs de `publishing.social.facebook.pages` que recebem o Reels (ignora o `enabled` de lá — aquele é o dos posts diários). */
  facebookPages: string[];
  /** Publica o Reels no Instagram. */
  instagram: boolean;
  /**
   * Slug de `publishing.social.facebook.pages` cuja conta do Instagram VINCULADA é a autora do Reels
   * (#10790: conta pessoal do editor, ligada à página VJ pixel). `null` = conta da diar.ia.br
   * (`INSTAGRAM_BUSINESS_ACCOUNT_ID`/`INSTAGRAM_ACCESS_TOKEN`).
   */
  instagramAuthorPage: string | null;
  /** Usernames convidados como collab no Reels (#10790: `diar.ia.br`). Máx. 3 (limite da Graph API). */
  instagramCollaborators: string[];
}

/** Limite de collaborators por mídia na Graph API do Instagram. */
export const INSTAGRAM_MAX_COLLABORATORS = 3;

export const DEFAULT_SHORTS_CONFIG: Readonly<ShortsConfig> = Object.freeze({
  // #10790 (decisão do editor, 22/10/2026): MemeLab fora da rotina.
  facebookPages: Object.freeze(["diaria", "vjpixel"]) as unknown as string[],
  instagram: true,
  instagramAuthorPage: "vjpixel",
  instagramCollaborators: Object.freeze(["diar.ia.br"]) as unknown as string[],
});

function defaultShortsConfig(): ShortsConfig {
  return {
    facebookPages: [...DEFAULT_SHORTS_CONFIG.facebookPages],
    instagram: DEFAULT_SHORTS_CONFIG.instagram,
    instagramAuthorPage: DEFAULT_SHORTS_CONFIG.instagramAuthorPage,
    instagramCollaborators: [...DEFAULT_SHORTS_CONFIG.instagramCollaborators],
  };
}

/** Lê e valida `publishing.shorts`; ausente → default (decisão do editor, #10769/#10790). */
export function loadShortsConfig(config: unknown): ShortsConfig {
  const raw = (config as any)?.publishing?.shorts;
  if (raw === undefined) return defaultShortsConfig();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("[shorts] publishing.shorts precisa ser um objeto (#10769).");
  }
  const pages = raw.facebook_pages;
  if (!Array.isArray(pages) || pages.some((p: unknown) => typeof p !== "string" || !p)) {
    throw new Error("[shorts] publishing.shorts.facebook_pages precisa ser uma lista de slugs (#10769).");
  }
  if (new Set(pages).size !== pages.length) throw new Error("[shorts] slug repetido em publishing.shorts.facebook_pages.");
  if (typeof raw.instagram !== "boolean") throw new Error("[shorts] publishing.shorts.instagram precisa ser boolean.");
  const author = raw.instagram_author_page ?? null;
  if (author !== null && (typeof author !== "string" || !author)) {
    throw new Error("[shorts] publishing.shorts.instagram_author_page precisa ser o slug de uma página ou null (#10790).");
  }
  const collabs = raw.instagram_collaborators ?? [];
  if (!Array.isArray(collabs) || collabs.some((c: unknown) => typeof c !== "string" || !/^[A-Za-z0-9._]{1,30}$/.test(c))) {
    throw new Error("[shorts] publishing.shorts.instagram_collaborators precisa ser uma lista de usernames do Instagram, sem @ (#10790).");
  }
  if (collabs.length > INSTAGRAM_MAX_COLLABORATORS) {
    throw new Error(`[shorts] publishing.shorts.instagram_collaborators aceita no máximo ${INSTAGRAM_MAX_COLLABORATORS} contas.`);
  }
  return { facebookPages: [...pages], instagram: raw.instagram, instagramAuthorPage: author, instagramCollaborators: [...collabs] };
}

/** Um destino do vídeo curto. `api` = o script publica; `guided` = passo no Chrome com o editor. */
export type ShortDestination =
  | { id: FacebookDestinationId; kind: "facebook_page"; mode: "api"; slug: string }
  | { id: "instagram"; kind: "instagram"; mode: "api" }
  | { id: "youtube_shorts"; kind: "youtube_shorts"; mode: "guided" }
  | { id: "facebook_profile"; kind: "facebook_profile"; mode: "guided" };

export type FacebookDestinationId = `facebook:${string}`;

export function facebookDestinationId(slug: string): FacebookDestinationId {
  return `facebook:${slug}`;
}

/** Todos os destinos da rotina diária, na ordem em que o skill os percorre. */
export function listShortDestinations(cfg: ShortsConfig): ShortDestination[] {
  const out: ShortDestination[] = [{ id: "youtube_shorts", kind: "youtube_shorts", mode: "guided" }];
  for (const slug of cfg.facebookPages) out.push({ id: facebookDestinationId(slug), kind: "facebook_page", mode: "api", slug });
  if (cfg.instagram) out.push({ id: "instagram", kind: "instagram", mode: "api" });
  out.push({ id: "facebook_profile", kind: "facebook_profile", mode: "guided" });
  return out;
}

/** Ids válidos de destino pra uma config (pra validar `--only`/`--mark`). */
export function knownDestinationIds(cfg: ShortsConfig): Set<string> {
  return new Set(listShortDestinations(cfg).map((d) => d.id));
}

/** Entrada de `_internal/06-shorts-published.json`. */
export interface ShortPublishedEntry {
  destination: string;
  status: "published" | "scheduled";
  /** id do vídeo/mídia na plataforma; nos destinos guiados (`--mark`), a própria URL. */
  id: string;
  url?: string;
  scheduled_at?: string | null;
  at: string;
}

export interface ShortsPublishedFile {
  aammdd: string;
  entries: ShortPublishedEntry[];
}

/** Upsert por destino (o último registro de um destino vence). */
export function upsertShortEntry(file: ShortsPublishedFile, entry: ShortPublishedEntry): ShortsPublishedFile {
  if (!entry.destination) throw new Error("entrada sem destino");
  return { ...file, entries: [...file.entries.filter((e) => e.destination !== entry.destination), entry] };
}

/** Destino já tem registro (publicado ou agendado)? */
export function isDestinationDone(file: ShortsPublishedFile, destination: string): boolean {
  return file.entries.some((e) => e.destination === destination);
}

/**
 * Lê o registro de forma ESTRITA. Um registro quebrado nunca vira "nada
 * publicado": isso republicaria Reels públicos em duplicata. Arquivo de outra
 * edição também é recusado.
 */
export function parseShortsPublishedFile(raw: string, aammdd: string, where = SHORTS_PUBLISHED_FILE): ShortsPublishedFile {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${where}: JSON inválido (${(e as Error).message}) — corrija ou apague à mão, conferindo antes o que já foi publicado`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw new Error(`${where}: sem lista "entries" — corrija à mão antes de publicar (risco de duplicar Reels)`);
  }
  if (parsed.aammdd !== aammdd) throw new Error(`${where}: é da edição ${parsed.aammdd}, não de ${aammdd}`);
  for (const [i, e] of parsed.entries.entries()) {
    if (!e || typeof e.destination !== "string" || !e.destination || typeof e.id !== "string" || !e.id) {
      throw new Error(`${where}: entrada ${i} sem destination/id`);
    }
    if (e.status !== "published" && e.status !== "scheduled") throw new Error(`${where}: entrada ${i} com status inválido (${e.status})`);
  }
  return { aammdd, entries: parsed.entries };
}

/**
 * Horário do vertical (#10831). O horizontal sai às 06:00 BRT junto da
 * newsletter; o vertical sai em horário PRÓPRIO, num teste de 2 semanas que
 * alterna `rotation_times` dia a dia a partir de `rotation_start` (261022 saiu
 * às 12:00, à mão), comparando as visualizações nas primeiras 24 h. Fora da
 * janela `[rotation_start, rotation_end]` vale `default_time`.
 *
 * Premissas registradas (não documentadas na decisão do editor):
 *   - o horário vale pro vertical em TODOS os destinos (Shorts, Reels das
 *     páginas, Instagram, perfil) — em 261022 "tudo foi ajustado à mão pra 12:00";
 *   - a alternância conta dias CORRIDOS, não edições publicadas: dia sem
 *     edição não desloca o horário dos seguintes (plano reconstruível);
 *   - fora da janela, `default_time` = 12:00 (o horário de 261022) até o
 *     editor decidir o vencedor do teste e mudar o config.
 *
 * A regra de grade da #10819 (alinhar com o que já está agendado em outras
 * contas / espaçar na mesma conta) entra por `planShortSlots`, abaixo: durante
 * o teste este horário tem precedência; fora dele, a grade decide.
 */
export interface ShortScheduleConfig {
  rotationTimes: string[];
  rotationStart: CivilDate;
  /** Inclusivo. `null` = sem fim. */
  rotationEnd: CivilDate | null;
  defaultTime: string;
}

const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Decisão do editor de 22/10/2026 (#10831): 2 semanas alternando 12:00/19:00 a partir de 261022. */
export const DEFAULT_SHORT_SCHEDULE_RAW = Object.freeze({
  rotation_times: Object.freeze(["12:00", "19:00"]),
  rotation_start: "2026-10-22",
  rotation_end: "2026-11-04",
  default_time: "12:00",
});

/** Lê `publishing.shorts.schedule`; ausente → default (#10831). Malformado LANÇA (estragaria o teste em silêncio). */
export function loadShortScheduleConfig(config: unknown): ShortScheduleConfig {
  const raw = (config as any)?.publishing?.shorts?.schedule ?? DEFAULT_SHORT_SCHEDULE_RAW;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("[shorts] publishing.shorts.schedule precisa ser um objeto (#10831).");
  }
  const times = raw.rotation_times;
  if (!Array.isArray(times) || !times.length || times.some((t: unknown) => typeof t !== "string" || !HHMM_RE.test(t))) {
    throw new Error("[shorts] publishing.shorts.schedule.rotation_times precisa ser uma lista não vazia de HH:MM (#10831).");
  }
  if (typeof raw.default_time !== "string" || !HHMM_RE.test(raw.default_time)) {
    throw new Error("[shorts] publishing.shorts.schedule.default_time precisa ser HH:MM (#10831).");
  }
  if (typeof raw.rotation_start !== "string") throw new Error("[shorts] publishing.shorts.schedule.rotation_start precisa ser AAAA-MM-DD (#10831).");
  const start = parseIsoCivilDate(raw.rotation_start, "publishing.shorts.schedule.rotation_start");
  let end: CivilDate | null = null;
  if (raw.rotation_end !== null && raw.rotation_end !== undefined) {
    if (typeof raw.rotation_end !== "string") throw new Error("[shorts] publishing.shorts.schedule.rotation_end precisa ser AAAA-MM-DD ou null (#10831).");
    end = parseIsoCivilDate(raw.rotation_end, "publishing.shorts.schedule.rotation_end");
    if (civilDayNumber(end) < civilDayNumber(start)) throw new Error("[shorts] publishing.shorts.schedule.rotation_end antes de rotation_start.");
  }
  return { rotationTimes: [...times], rotationStart: start, rotationEnd: end, defaultTime: raw.default_time };
}

export interface ShortTime {
  /** HH:MM em BRT, no dia da edição. */
  hhmm: string;
  source: "rotation" | "default";
  /** Explicação curta pra premissa do plano. */
  reason: string;
}

/** Pure: horário (BRT) do vertical da edição `AAMMDD` (#10831). */
export function resolveShortTime(sched: ShortScheduleConfig, aammdd: string): ShortTime {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(aammdd);
  if (!m) throw new Error(`AAMMDD inválido: ${JSON.stringify(aammdd)}`);
  const date = parseIsoCivilDate(`20${m[1]}-${m[2]}-${m[3]}`, "data da edição");
  const day = civilDayNumber(date);
  const start = civilDayNumber(sched.rotationStart);
  const inWindow = day >= start && (sched.rotationEnd === null || day <= civilDayNumber(sched.rotationEnd));
  if (!inWindow) {
    return { hhmm: sched.defaultTime, source: "default", reason: `fora do teste de horário (${formatCivilDate(sched.rotationStart)} a ${sched.rotationEnd ? formatCivilDate(sched.rotationEnd) : "sem fim"}) — horário fixo` };
  }
  const k = day - start;
  const hhmm = sched.rotationTimes[k % sched.rotationTimes.length];
  return { hhmm, source: "rotation", reason: `teste de horário do vertical, dia ${k + 1} (alterna ${sched.rotationTimes.join("/")})` };
}

/** Horário escolhido pra um destino de API do vertical (#10819). */
export interface ShortSlot {
  destination: string;
  /** Chave de conta da grade (`socialAccountKey`). */
  account: string;
  /** ISO UTC. */
  at: string;
  /** HH:MM BRT. */
  hhmm: string;
  /** `test-schedule` = horário do teste do #10831 mantido; o resto vem do planner. */
  rule: "test-schedule" | SlotRule;
  premise: string;
  warning?: string;
}

/** Conta da grade de um destino de API do vertical; guiados não entram (`null`). */
export function shortDestinationAccount(dest: ShortDestination, cfg: Pick<ShortsConfig, "instagramAuthorPage">): string | null {
  if (dest.kind === "facebook_page") return socialAccountKey("facebook", dest.slug);
  if (dest.kind === "instagram") return socialAccountKey("instagram", cfg.instagramAuthorPage ?? "diaria");
  return null;
}

const brtHHMM = (iso: string) => new Date(Date.parse(iso) - 3 * 3_600_000).toISOString().slice(11, 16);

/**
 * Pure (#10819): horário de cada destino de API do vertical contra a grade já
 * agendada (`gridFromSocialPublished` + `gridFromShortsPublished`).
 *
 * Premissas (registradas em `premise`; a precedência do teste veio do
 * coordenador da rodada, o resto não veio do editor):
 *   - DURANTE o teste de horário do #10831 (`time.source === "rotation"`) o
 *     horário do teste vale pra todos os destinos: mover um destino tiraria
 *     aquele dia da comparação 12:00 × 19:00. A grade só gera AVISO quando o
 *     horário do teste cai a menos de `DEFAULT_MIN_GAP_MINUTES` de um post da
 *     MESMA conta (colado/empilhado), pro editor decidir à mão;
 *   - FORA do teste (`default_time`), `planSlots` decide por destino com
 *     `preferredAt` = `default_time`, janela 06:00–22:00 BRT do dia da edição e
 *     sem `notBefore` (o plano não depende da hora em que roda; horário que já
 *     passou cai em "publica na hora" no `resolveReelsSchedule`, como antes).
 *     Cada destino planejado entra na grade antes do seguinte;
 *   - destinos guiados (YouTube Shorts, perfil pessoal) seguem `shortTime`: o
 *     skill lê um horário só pra eles.
 */
export function planShortSlots(input: {
  aammdd: string;
  time: ShortTime;
  /** ISO do `time.hhmm` no dia da edição. */
  timeAt: string;
  destinations: readonly ShortDestination[];
  cfg: Pick<ShortsConfig, "instagramAuthorPage">;
  grid: readonly ScheduledSlot[];
}): ShortSlot[] {
  const api = input.destinations
    .map((d) => ({ dest: d, account: shortDestinationAccount(d, input.cfg) }))
    .filter((x): x is { dest: ShortDestination; account: string } => x.account !== null);

  if (input.time.source === "rotation") {
    const t = Date.parse(input.timeAt);
    return api.map(({ dest, account }) => {
      const close = input.grid
        .filter((s) => s.account === account && Math.abs(Date.parse(s.at) - t) < DEFAULT_MIN_GAP_MINUTES * 60_000)
        .map((s) => brtHHMM(s.at));
      const slot: ShortSlot = {
        destination: dest.id,
        account,
        at: new Date(t).toISOString(),
        hhmm: input.time.hhmm,
        rule: "test-schedule",
        premise: `teste de horário do vertical (#10831) tem precedência sobre a grade (#10819)`,
      };
      if (close.length) {
        slot.warning =
          `${dest.id}: o horário do teste (${input.time.hhmm} BRT) fica a menos de ${DEFAULT_MIN_GAP_MINUTES} min de post da mesma conta ` +
          `(${[...new Set(close)].join(", ")} BRT) — mantido por causa do teste; mova à mão se não quiser colado`;
      }
      return slot;
    });
  }

  const window = brtDayWindow(input.aammdd);
  const decisions = planSlots(
    input.grid,
    api.map(({ account }) => ({ account, window, preferredAt: input.timeAt })),
  );
  return api.map(({ dest, account }, i) => {
    const d = decisions[i];
    if (!d.at) {
      return {
        destination: dest.id,
        account,
        at: new Date(Date.parse(input.timeAt)).toISOString(),
        hhmm: input.time.hhmm,
        rule: d.rule,
        premise: d.premise,
        warning: `${dest.id}: a grade não achou horário (${d.premise}) — mantido ${input.time.hhmm} BRT`,
      };
    }
    return {
      destination: dest.id,
      account,
      at: d.at,
      hhmm: brtHHMM(d.at),
      rule: d.rule,
      premise: d.premise,
      ...(d.warning ? { warning: `${dest.id}: ${d.warning}` } : {}),
    };
  });
}

/**
 * Agendar ou publicar já: o Facebook só aceita agendar de 10 min a 75 dias à
 * frente. Com menos de 10 min de folga (ou já passado), na hora.
 */
export function resolveReelsSchedule(targetIso: string, now: Date): { mode: "scheduled"; at: string } | { mode: "immediate" } {
  const t = Date.parse(targetIso);
  if (Number.isNaN(t)) throw new Error(`horário inválido: ${JSON.stringify(targetIso)}`);
  return t - now.getTime() > 10 * 60_000 ? { mode: "scheduled", at: new Date(t).toISOString() } : { mode: "immediate" };
}

/**
 * Teto da API de Reels de Página (`/{page-id}/video_reels`): 90 s. Vídeo
 * maior vai pelo endpoint de vídeo da Página (`/{page-id}/videos`), que o
 * Facebook exibe como Reel quando é vertical.
 */
export const FACEBOOK_REELS_API_MAX_SECONDS = 90;

/**
 * Duração (s) de um MP4 lida do átomo `moov/mvhd`, sem ffprobe. Devolve null
 * se não achar (arquivo truncado, contêiner não-MP4) — o caller decide o
 * fallback. Só lê cabeçalhos de caixa; não decodifica nada.
 */
export function mp4DurationSeconds(buf: Buffer): number | null {
  const findBox = (start: number, end: number, type: string): { start: number; end: number } | null => {
    let off = start;
    while (off + 8 <= end) {
      let size = buf.readUInt32BE(off);
      const t = buf.toString("latin1", off + 4, off + 8);
      let header = 8;
      if (size === 1) {
        if (off + 16 > end) return null;
        size = Number(buf.readBigUInt64BE(off + 8));
        header = 16;
      } else if (size === 0) {
        size = end - off;
      }
      if (size < header || off + size > end) return null;
      if (t === type) return { start: off + header, end: off + size };
      off += size;
    }
    return null;
  };
  const moov = findBox(0, buf.length, "moov");
  if (!moov) return null;
  const mvhd = findBox(moov.start, moov.end, "mvhd");
  if (!mvhd) return null;
  const version = buf.readUInt8(mvhd.start);
  const timescaleOff = mvhd.start + (version === 1 ? 20 : 12);
  const durationOff = timescaleOff + 4;
  if (durationOff + (version === 1 ? 8 : 4) > mvhd.end) return null;
  const timescale = buf.readUInt32BE(timescaleOff);
  const duration = version === 1 ? Number(buf.readBigUInt64BE(durationOff)) : buf.readUInt32BE(durationOff);
  if (!timescale) return null;
  return duration / timescale;
}

/** Qual endpoint do Facebook usar pra este vídeo. */
export function facebookUploadRoute(durationSeconds: number | null): "video_reels" | "videos" {
  // Duração desconhecida → `videos`, que aceita qualquer duração (o `video_reels` recusaria >90 s depois do upload).
  return durationSeconds !== null && durationSeconds <= FACEBOOK_REELS_API_MAX_SECONDS ? "video_reels" : "videos";
}
