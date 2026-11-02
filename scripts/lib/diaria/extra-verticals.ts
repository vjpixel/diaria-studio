/**
 * scripts/lib/diaria/extra-verticals.ts (#11900)
 *
 * Miolo PURO do plano de publicação das verticais EXTRAS de uma edição: as
 * sequências de corte do `blocks.json` (#11898), cada uma uma vertical com
 * roteiro próprio gravada no mesmo bruto da edição.
 *
 * Decisões do editor (02/11/2026, comentário na #11900):
 *   - mais de uma vertical por edição vira o padrão;
 *   - a extra sai em todos os destinos da principal, automaticamente (o modo
 *     corte do `publish-shorts.ts` + o timer do 300, `Diaria-Shorts-Cortes`,
 *     com `publishing.shorts.corte_via_timer`);
 *   - em DIAS diferentes: a principal no dia da edição e a k-ésima extra no
 *     k-ésimo dia útil seguinte (edições só seg–sex), no horário da grade
 *     daquele dia;
 *   - a extra não entra no D1, no site nem nos relatórios da edição. O modo
 *     corte já garante isso: registro em `data/cortes/{slug}/`, fora de
 *     `data/editions/`.
 *
 * Premissa do horário (registrada no plano): no dia da extra também sai a
 * vertical principal da edição DAQUELE dia, nas mesmas contas, no horário do
 * teste (#10831, `resolveShortTime`). A extra usa o horário seguinte da mesma
 * lista (`rotation_times`, em ciclo), nunca o mesmo da principal do dia.
 *
 * Feriado não é conhecido aqui: "dia útil" = segunda a sexta.
 *
 * Fonte do vídeo (#11906, review): o `corte.json` grava o caminho do `--video`
 * e quem re-executa os destinos pendentes é o timer do 300
 * (`Diaria-Shorts-Cortes`). Caminho fora de `data/` (ex.: `G:/...` do Drive
 * for desktop no Neo) não existe no 300, e Instagram, perfil do LinkedIn e
 * Threads caem em `missing-video`. Por isso o plano PREFERE `--from-drive {id}`
 * (baixa para `data/cortes/{slug}/`, que sincroniza) quando o id do arquivo no
 * Drive é conhecido; com só o caminho local fora de `data/`, o comando sai com
 * `--video`, mas com aviso explícito em `warnings` e a instrução de trocar.
 */

import { resolveShortTime, type ShortScheduleConfig } from "./short-video.ts";
import { corteSuffixOf } from "./drive-video-source.ts";
import { corteVideoPortabilityWarning } from "./short-corte.ts";
import { itemInTarget, type BlockItem, type BlocksFile, type SequenceSpec } from "./video-montage.ts";

const AAMMDD_RE = /^(\d{2})(\d{2})(\d{2})$/;

function toUtcDate(aammdd: string): Date {
  const m = AAMMDD_RE.exec(aammdd);
  if (!m) throw new Error(`AAMMDD inválido: ${JSON.stringify(aammdd)}`);
  const d = new Date(Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) throw new Error(`AAMMDD inválido: ${JSON.stringify(aammdd)}`);
  return d;
}

function toAammdd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** O `k`-ésimo dia útil (seg–sex) DEPOIS de `aammdd` (k ≥ 1). */
export function nthBusinessDayAfter(aammdd: string, k: number): string {
  if (!Number.isInteger(k) || k < 1) throw new Error(`k precisa ser inteiro ≥ 1 (veio ${k})`);
  const d = toUtcDate(aammdd);
  let left = k;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return toAammdd(d);
}

/** As sequências de corte do `blocks.json`, na ordem do arquivo (a 1ª é a extra do dia útil seguinte). */
export function extraVerticalSpecs(file: Pick<BlocksFile, "sequences">): SequenceSpec[] {
  return (file.sequences ?? []).filter((s) => typeof s.corte === "string");
}

/** Slug do corte na publicação: `{corte}-{AAMMDD}` (pasta `data/cortes/{slug}/`, convenção da #11898). */
export function extraVerticalSlug(corte: string, edition: string): string {
  return `${corte}-${edition}`;
}

const itemText = (it: BlockItem): string => (typeof it.text === "string" ? it.text.replace(/\s+/g, " ").trim() : "");

/**
 * Gancho da publicação: o `hook` da sequência; sem ele, o texto do
 * `resumo_curto` que entra nesta vertical (ou do `resumo`, se ela não tem
 * `resumo_curto`). `null` = nada para usar.
 */
export function extraVerticalHook(file: Pick<BlocksFile, "blocks">, spec: SequenceSpec): { text: string; how: "hook" | "resumo_curto" | "resumo" } | null {
  if (typeof spec.hook === "string" && spec.hook.trim()) return { text: spec.hook.replace(/\s+/g, " ").trim(), how: "hook" };
  for (const key of ["resumo_curto", "resumo"] as const) {
    if (!spec.order.includes(key)) continue;
    const text = (file.blocks[key] ?? [])
      .filter((it) => itemInTarget(it, spec.target))
      .map(itemText)
      .filter(Boolean)
      .join(" ");
    if (text) return { text, how: key };
  }
  return null;
}

/** Horário da extra no dia `date`: o seguinte ao da principal daquele dia em `rotation_times` (ciclo). */
export function extraVerticalTime(sched: ShortScheduleConfig, date: string): { hhmm: string; principal: string; reason: string; collides: boolean } {
  const principal = resolveShortTime(sched, date).hhmm;
  const times = sched.rotationTimes;
  const i = times.indexOf(principal);
  for (let step = 1; step <= times.length; step++) {
    const t = times[((i < 0 ? -1 : i) + step + times.length) % times.length];
    if (t !== principal) {
      return { hhmm: t, principal, collides: false, reason: `a vertical principal de ${date} sai às ${principal}; a extra usa o horário seguinte de rotation_times (${times.join("/")})` };
    }
  }
  return { hhmm: principal, principal, collides: true, reason: `rotation_times só tem ${principal}: a extra cai no mesmo horário da vertical principal de ${date}` };
}

/** Aspas simples de shell POSIX. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'"'"'`)}'`;
}

export interface ExtraVerticalPlan {
  corte: string;
  /** Slug do modo corte (`--corte`). */
  slug: string;
  /** Nome da sequência = nome do export no Drive (`…_V1-{corte}.mp4`). */
  sequenceName: string;
  /** Dia da publicação, AAMMDD. */
  date: string;
  hhmm: string;
  title: string | null;
  hook: string | null;
  /** Caminho local do export (`--video`), quando o comando usa ele. */
  video: string | null;
  /** Id do export no Drive (`--from-drive`), preferido sobre `video`. */
  driveId: string | null;
  premises: string[];
  /** O que impede o comando; vazio = `command` pronto. */
  problems: string[];
  warnings: string[];
  /** Dry-run do modo corte (registra `data/cortes/{slug}/corte.json`); publica só com `--publish` e o "pode publicar". */
  command: string | null;
}

/**
 * Pure: o plano de cada vertical extra da edição. `videos` = export local de
 * cada corte (chave = `corte`), `driveIds` = id do export no Drive (chave =
 * `corte`, preferido), `dataDir` = `data/` absoluto desta máquina, para avisar
 * quando o `--video` local não acompanha o timer do 300.
 */
export function planExtraVerticals(input: {
  edition: string;
  file: Pick<BlocksFile, "blocks" | "sequences">;
  sched: ShortScheduleConfig;
  videos?: Readonly<Record<string, string>>;
  driveIds?: Readonly<Record<string, string>>;
  dataDir?: string;
}): ExtraVerticalPlan[] {
  return extraVerticalSpecs(input.file).map((spec, idx) => {
    const corte = spec.corte as string;
    const date = nthBusinessDayAfter(input.edition, idx + 1);
    const time = extraVerticalTime(input.sched, date);
    const premises = [
      `${idx + 1}ª extra da edição ${input.edition}: ${idx + 1}º dia útil seguinte (${date}), decisão do editor de 02/11/2026 (#11900); feriado não é considerado`,
      `horário ${time.hhmm} BRT: ${time.reason}`,
    ];
    const warnings: string[] = [];
    if (time.collides) warnings.push(time.reason);
    const problems: string[] = [];
    const titleRaw = typeof spec.screenTitle === "string" ? spec.screenTitle.replace(/\s+/g, " ").trim() : "";
    const title = titleRaw || null;
    if (!title) problems.push(`sequência do corte "${corte}" sem screenTitle: é o título da publicação (--title); informe na sequência do blocks.json`);
    const hook = extraVerticalHook(input.file, spec);
    if (!hook) problems.push(`corte "${corte}" sem gancho: informe "hook" na sequência ou um resumo_curto com texto nesta vertical`);
    else if (hook.how !== "hook") premises.push(`gancho do ${hook.how} desta vertical (o "hook" da sequência sobrepõe)`);
    const slug = extraVerticalSlug(corte, input.edition);
    const driveId = input.driveIds?.[corte]?.trim() || null;
    const video = driveId ? null : (input.videos?.[corte] ?? null);
    if (driveId) {
      premises.push(`vídeo pelo --from-drive ${driveId}: baixa para data/cortes/${slug}/, que o timer do 300 alcança`);
    } else if (!video) {
      problems.push(`export do corte ("${spec.name}.mp4") não encontrado: passe --drive-ids ${corte}=ID (id do arquivo em Final/ no Drive, preferido; sai pronto de \`npx tsx scripts/fetch-drive-video.ts --edition ${input.edition} --corte ${corte}\`) ou --video-dir com a pasta Final/ local`);
    } else if (input.dataDir) {
      const portability = corteVideoPortabilityWarning(video, input.dataDir);
      if (portability) {
        warnings.push(
          `${portability}. O timer do 300 (Diaria-Shorts-Cortes) não acha esse caminho e Instagram, perfil do LinkedIn e Threads do corte caem em missing-video: troque no comando --video ${shellQuote(video)} por --from-drive {id de "${spec.name}.mp4" no Drive}, ou rode o plano com --drive-ids ${corte}=ID`,
        );
      }
    }
    const command = problems.length
      ? null
      : [
          "npx tsx scripts/publish-shorts.ts",
          `--corte ${shellQuote(slug)}`,
          `--date ${date}`,
          `--at ${time.hhmm}`,
          `--title ${shellQuote(title as string)}`,
          `--hook ${shellQuote(hook!.text)}`,
          driveId ? `--from-drive ${shellQuote(driveId)}` : `--video ${shellQuote(video as string)}`,
        ].join(" ");
    return { corte, slug, sequenceName: spec.name, date, hhmm: time.hhmm, title, hook: hook?.text ?? null, video, driveId, premises, problems, warnings, command };
  });
}

/**
 * Pure: o export de cada corte numa listagem de arquivos (nome → caminho). Um
 * corte com 2+ arquivos é ambíguo (fica fora, com o motivo).
 */
export function matchCorteExports(
  cortes: readonly string[],
  files: ReadonlyArray<{ name: string; path: string }>,
): { videos: Record<string, string>; ambiguous: Record<string, string[]> } {
  const videos: Record<string, string> = {};
  const ambiguous: Record<string, string[]> = {};
  for (const corte of cortes) {
    const hits = files.filter((f) => /\.mp4$/i.test(f.name) && corteSuffixOf(f.name) === corte);
    if (hits.length === 1) videos[corte] = hits[0].path;
    else if (hits.length > 1) ambiguous[corte] = hits.map((h) => h.name);
  }
  return { videos, ambiguous };
}

/**
 * Pure: `--drive-ids corte1=ID1,corte2=ID2` → mapa corte → id. Entrada
 * malformada (sem `=`, corte ou id vazio, corte repetido) é erro.
 */
export function parseDriveIds(raw: string): { ok: true; ids: Record<string, string> } | { ok: false; error: string } {
  const ids: Record<string, string> = {};
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    const corte = eq < 0 ? "" : part.slice(0, eq).trim();
    const id = eq < 0 ? "" : part.slice(eq + 1).trim();
    if (!corte || !id) return { ok: false, error: `--drive-ids: "${part}" não é corte=ID` };
    if (corte in ids) return { ok: false, error: `--drive-ids: corte "${corte}" repetido` };
    ids[corte] = id;
  }
  if (!Object.keys(ids).length) return { ok: false, error: "--drive-ids vazio" };
  return { ok: true, ids };
}
