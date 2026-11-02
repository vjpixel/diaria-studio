/**
 * scripts/lib/diaria/short-corte.ts (#11795)
 *
 * Miolo PURO do vídeo vertical AVULSO (um "corte" fora de edição, ex.: um
 * trecho de mentoria em `Cortes para as redes`) publicado pelo
 * `publish-shorts.ts --corte SLUG`.
 *
 * Até o #11795 o `publish-shorts.ts` só funcionava a partir de uma edição, e o
 * agendamento de um corte (01/11/2026) saiu com workarounds: um `02-reviewed.md`
 * sintético com um DESTAQUE 1 falso, nome de arquivo e chave de R2 da edição
 * do dia (`diaria-comentada-261102-short.mp4`), `--edition-url` só pra
 * satisfazer o plano, e o horário caindo na rotação do teste do #10831.
 *
 * O modo corte resolve isso com:
 *   - título e gancho explícitos (`--title`, `--hook`), nunca um D1;
 *   - registro próprio em `data/cortes/{slug}/` (`corte.json` + o registro por
 *     destino de sempre, `_internal/06-shorts-published.json`), fora de
 *     `data/editions/` — não conta como amostra do teste de horário;
 *   - chaves de R2 próprias (`shorts/cortes/{slug}.mp4`), que não colidem com
 *     o vertical da edição do dia;
 *   - horário explícito (`--at HH:MM`), fora da rotação do #10831;
 *   - sem delegar aos timers do 300 (eles procuram a pasta da edição e não
 *     enxergam o corte): o que a API não agenda fica `pending_schedule`, com o
 *     comando de re-execução no `owners` do plano.
 */

import { isAbsolute, join, relative, sep } from "node:path";
import type { ShortTime } from "./short-video.ts";

/** Especificação do corte, gravada em `data/cortes/{slug}/corte.json`. */
export interface CorteSpec {
  slug: string;
  /** Dia da publicação, AAMMDD. */
  date: string;
  /** HH:MM BRT. */
  hhmm: string;
  title: string;
  /** Gancho: a 1ª frase vai no texto de cada rede (mesmo papel do corpo do D1). */
  hook: string;
  /** Caminho do vertical: relativo à pasta do corte quando está nela (`corteVideoRef`), senão absoluto. */
  video: string;
}

export const CORTE_SPEC_FILE = "corte.json";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const DATE_RE = /^\d{6}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Slug do corte: minúsculas, dígitos e hífen (vira nome de pasta e chave de R2). */
export function validateCorteSlug(slug: string): string | null {
  return SLUG_RE.test(slug) ? null : `--corte espera um slug em minúsculas, dígitos e hífen (2 a 64 caracteres), recebeu ${JSON.stringify(slug)}`;
}

/** Pasta dos cortes, relativa à raiz do repo. */
export const CORTES_REL_DIR = "data/cortes";

/** Pasta do corte, relativa à raiz do repo. */
export function corteRelDir(slug: string): string {
  return `data/cortes/${slug}`;
}

/** Nome do vertical baixado na pasta do corte (`--from-drive` sem `--video`). */
export function corteVideoFileName(slug: string): string {
  return `corte-${slug}.mp4`;
}

/**
 * Como o `video` vai para o `corte.json`: RELATIVO à pasta do corte quando o
 * arquivo está dentro dela (caso `--from-drive`), senão o caminho absoluto.
 * `data/` sincroniza entre as máquinas; um absoluto de uma máquina não existe
 * na outra, então a re-execução dos `owners` cairia em "vídeo curto ausente".
 */
export function corteVideoRef(corteDir: string, absVideo: string): string {
  const rel = relative(corteDir, absVideo);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : absVideo;
}

/** Caminho do vertical a partir do `video` do `corte.json` (relativo = dentro da pasta do corte). */
export function resolveCorteVideo(corteDir: string, video: string): string {
  return isAbsolute(video) ? video : join(corteDir, video);
}

/**
 * Aviso quando o vídeo do corte está fora de `data/` (não sincroniza entre as
 * máquinas): a re-execução em outra máquina não vai achar o arquivo.
 */
export function corteVideoPortabilityWarning(video: string, dataDir: string): string | null {
  if (!isAbsolute(video)) return null;
  const rel = relative(dataDir, video);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return null;
  return `vídeo do corte fora de data/ (${video}): re-execução em outra máquina não acha o arquivo — use --from-drive ou copie o vídeo para a pasta do corte`;
}

/**
 * Chaves do corte no R2. Prefixo próprio (`shorts/cortes/`): nunca o
 * `shorts/diaria-comentada-{AAMMDD}-short.mp4` da edição do dia.
 */
export function corteR2Key(slug: string, kind: "video" | "cover"): string {
  return kind === "video" ? `shorts/cortes/${slug}.mp4` : `shorts/cortes/${slug}-cover.jpg`;
}

/** Horário do corte: explícito, fora do teste de horário do vertical (#10831). */
export function corteShortTime(hhmm: string): ShortTime {
  return { hhmm, source: "explicit", reason: "corte avulso: horário explícito (--at), fora do teste de horário do vertical (#10831, #11795)" };
}

/**
 * Task do 300 que publica os destinos do corte que a API não agenda (#11795,
 * `scripts/shorts-corte-timer.ts`), com `publishing.shorts.corte_via_timer`.
 */
export const CORTE_TIMER_TASK = "Diaria-Shorts-Cortes";

/** Destinos do corte que ficam `pending_schedule` antes do horário: a API deles não agenda. */
export const CORTE_TIMER_DESTINATIONS: readonly string[] = ["linkedin_profile", "threads_profile", "instagram"];

/** Comando base das re-execuções (`owners` do plano): o resto vem do `corte.json`. */
export function corteBaseCommand(slug: string): string {
  return `npx tsx scripts/publish-shorts.ts --corte ${slug}`;
}

/** Título e gancho no formato que os montadores de texto do vertical leem (`{ title, body }`). */
export function corteTextInput(spec: Pick<CorteSpec, "title" | "hook">): { title: string; body: string } {
  return { title: spec.title, body: spec.hook };
}

/** Lê e valida o `corte.json`. Ilegível ou inválido lança (nunca vira "corte novo"). */
export function parseCorteSpec(raw: string, path: string): CorteSpec {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path} ilegível: ${(e as Error).message}`);
  }
  const problems = corteSpecProblems(data);
  if (problems.length) throw new Error(`${path} inválido: ${problems.join("; ")}`);
  return data as CorteSpec;
}

function corteSpecProblems(data: unknown): string[] {
  if (!data || typeof data !== "object") return ["não é um objeto"];
  const d = data as Record<string, unknown>;
  const problems: string[] = [];
  const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : null);
  const slug = str("slug");
  if (slug === null || validateCorteSlug(slug)) problems.push("slug inválido");
  if (!DATE_RE.test(str("date") ?? "")) problems.push("date precisa ser AAMMDD (--date)");
  if (!HHMM_RE.test(str("hhmm") ?? "")) problems.push("hhmm precisa ser HH:MM (--at)");
  if (!(str("title") ?? "").trim()) problems.push("title vazio (--title)");
  if (!(str("hook") ?? "").trim()) problems.push("hook vazio (--hook)");
  if (!(str("video") ?? "").trim()) problems.push("video vazio (--video ou --from-drive)");
  return problems;
}

/** Flags da CLI que alimentam o `corte.json`. */
export interface CorteFlags {
  date?: string;
  at?: string;
  title?: string;
  hook?: string;
  video?: string;
}

/**
 * Pure: junta o `corte.json` existente com as flags desta rodada (a flag
 * vence). Devolve a spec válida, se ela mudou (pra gravar), ou os problemas.
 * Mudar título, gancho ou horário depois de algum destino registrado só vale
 * para os destinos ainda não publicados: quem chama avisa.
 */
export function mergeCorteSpec(
  slug: string,
  existing: CorteSpec | null,
  flags: CorteFlags,
): { ok: true; spec: CorteSpec; changed: (keyof CorteSpec)[] } | { ok: false; error: string } {
  const slugErr = validateCorteSlug(slug);
  if (slugErr) return { ok: false, error: slugErr };
  if (existing && existing.slug !== slug) return { ok: false, error: `corte.json é do corte "${existing.slug}", não de "${slug}"` };
  const pick = (v: string | undefined) => (v === undefined ? undefined : v.trim());
  const candidate = {
    slug,
    date: pick(flags.date) ?? existing?.date ?? "",
    hhmm: pick(flags.at) ?? existing?.hhmm ?? "",
    title: pick(flags.title) ?? existing?.title ?? "",
    hook: pick(flags.hook) ?? existing?.hook ?? "",
    video: pick(flags.video) ?? existing?.video ?? "",
  };
  const problems = corteSpecProblems(candidate);
  if (problems.length) {
    return { ok: false, error: `corte "${slug}" incompleto: ${problems.join("; ")}${existing ? "" : " (1ª rodada do corte: passe --date, --at, --title, --hook e --video ou --from-drive)"}` };
  }
  const keys: (keyof CorteSpec)[] = ["date", "hhmm", "title", "hook", "video"];
  const changed = existing ? keys.filter((k) => existing[k] !== candidate[k]) : keys;
  return { ok: true, spec: candidate, changed };
}
