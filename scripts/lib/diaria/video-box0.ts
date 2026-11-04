/**
 * scripts/lib/diaria/video-box0.ts (#12073)
 *
 * Miolo PURO do box do vídeo no slot 0 da newsletter (topo, antes do D1).
 * Sem I/O: quem lê o disco é `resolveVideoBox0` em `newsletter-parse.ts`.
 *
 * Por que existe: nas edições 261021 e 261029, com um box do vídeo no slot 0,
 * o horizontal teve 151 e 176 views; sem box, de 7 a 65 (YouTube Data API,
 * 03/11/2026, #12073). A imagem do D1 já linkava o vídeo em todas.
 *
 * Decisão do editor (03/11/2026, comentário na #12073): o box entra **2 vezes
 * por semana**. Premissa registrada na mesma decisão:
 *   - dias fixos: terça e quinta (`VIDEO_BOX0_WEEKDAYS`);
 *   - se o slot 0 do dia já tem outro aviso (apoio, sorteio, qualquer box0
 *     escrito no `02-reviewed.md`), o box do vídeo cede a vez e passa para a
 *     próxima edição da semana com vídeo;
 *   - edição sem vídeo nunca leva o box, e nunca com link pro canal no lugar.
 *
 * A cota é cumulativa na semana (segunda a domingo): até a terça cabe 1 box,
 * da quinta em diante cabem 2. Uma edição leva o box quando tem vídeo, o slot 0
 * está livre e a semana ainda não usou a cota até aquele dia. Assim a terça
 * que cedeu a vez passa para a quarta; se a quarta também cedeu, a quinta leva
 * um e a sexta leva o outro. Nunca mais de um box por edição.
 */

/** Dias da semana (`Date.getUTCDay`: 0 = domingo) que abrem uma vaga do box. */
export const VIDEO_BOX0_WEEKDAYS: readonly number[] = [2, 4];

/** Rótulo (kicker) do box. */
export const VIDEO_BOX0_CATEGORIA = "Vídeo";

/** Frase do box, abaixo do título do vídeo (premissa: uma linha, tom da casa). */
export const VIDEO_BOX0_PHRASE = "Gravei meus comentários sobre o primeiro destaque de hoje.";

/** Texto do link (o mesmo do box da 261029). */
export const VIDEO_BOX0_CTA = "Assista no YouTube";

export const VIDEO_BOX0_UTM_SOURCE = "newsletter";
export const VIDEO_BOX0_UTM_MEDIUM = "email";

/** `utm_campaign` do link do box (#12073). */
export function videoBox0UtmCampaign(aammdd: string): string {
  return `video-box0-${aammdd}`;
}

function assertAammdd(aammdd: string, who: string): void {
  if (!/^\d{6}$/.test(aammdd)) throw new Error(`${who}: edição inválida ${JSON.stringify(aammdd)} (esperado AAMMDD)`);
}

/** Link do box: o vídeo com a UTM própria do box. */
export function buildVideoBox0Href(videoUrl: string, aammdd: string): string {
  assertAammdd(aammdd, "buildVideoBox0Href");
  const u = new URL(videoUrl);
  u.searchParams.set("utm_source", VIDEO_BOX0_UTM_SOURCE);
  u.searchParams.set("utm_medium", VIDEO_BOX0_UTM_MEDIUM);
  u.searchParams.set("utm_campaign", videoBox0UtmCampaign(aammdd));
  return u.toString();
}

function aammddToUtc(aammdd: string): Date {
  assertAammdd(aammdd, "aammddToUtc");
  const d = new Date(Date.UTC(2000 + Number(aammdd.slice(0, 2)), Number(aammdd.slice(2, 4)) - 1, Number(aammdd.slice(4, 6))));
  if (d.getUTCDate() !== Number(aammdd.slice(4, 6))) throw new Error(`aammddToUtc: data inexistente ${aammdd}`);
  return d;
}

function utcToAammdd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** Dia da semana da edição (0 = domingo ... 6 = sábado). */
export function editionWeekday(aammdd: string): number {
  return aammddToUtc(aammdd).getUTCDay();
}

/** Posição na semana que começa na segunda (segunda = 1 ... domingo = 7). */
function mondayBasedDay(weekday: number): number {
  return weekday === 0 ? 7 : weekday;
}

/** Quantos boxes a semana comporta até o dia `weekday`, inclusive. */
export function videoBox0Quota(weekday: number): number {
  const day = mondayBasedDay(weekday);
  return VIDEO_BOX0_WEEKDAYS.filter((w) => mondayBasedDay(w) <= day).length;
}

/** Edições da mesma semana (a partir da segunda) ANTES de `aammdd`, em ordem. */
export function weekEditionsBefore(aammdd: string): string[] {
  const d = aammddToUtc(aammdd);
  const back = mondayBasedDay(d.getUTCDay()) - 1;
  const out: string[] = [];
  for (let i = back; i >= 1; i--) out.push(utcToAammdd(new Date(d.getTime() - i * 86_400_000)));
  return out;
}

export interface VideoBox0DayState {
  /** A edição tem vídeo com URL (`_internal/05-video-url.txt`). */
  hasVideo: boolean;
  /** O slot 0 já tem outro box escrito no `02-reviewed.md`. */
  slot0Busy: boolean;
}

/** A edição do dia `weekday` leva o box, dado quantos a semana já mostrou. */
export function decideVideoBox0(weekday: number, state: VideoBox0DayState, shownBefore: number): boolean {
  if (!state.hasVideo || state.slot0Busy) return false;
  return shownBefore < videoBox0Quota(weekday);
}

/**
 * Quantos boxes as edições anteriores da semana levaram, dia a dia (em ordem).
 * `recorded` (#12159) é o que o e-mail daquela edição de fato levou, gravado no
 * Stage 5 (`_internal/video-box0.json`): quando existe, vale ele. Sem registro,
 * a mesma regra é recalculada sobre o estado relido do disco (vídeo, slot 0),
 * que erra quando o link do vídeo chegou depois do envio.
 */
export function countVideoBox0Shown(prior: ReadonlyArray<{ weekday: number; state: VideoBox0DayState; recorded?: boolean }>): number {
  let shown = 0;
  for (const p of prior) {
    if (p.recorded !== undefined ? p.recorded : decideVideoBox0(p.weekday, p.state, shown)) shown++;
  }
  return shown;
}

/**
 * Markdown do box (mesmo formato do box escrito à mão na 261029: título em
 * negrito, uma frase, o link). Título vazio cai no texto genérico.
 */
export function buildVideoBox0Markdown(input: { title: string | null; href: string }): string {
  const title = (input.title ?? "").replace(/\*/g, "").trim() || "O vídeo de hoje";
  return `**${title}**\n\n${VIDEO_BOX0_PHRASE}\n\n[${VIDEO_BOX0_CTA}](${input.href})`;
}
