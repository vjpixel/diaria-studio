/**
 * social-schedule-rotation-record.ts (#10305) — gravação do registro do teste
 * rotativo em `data/social-schedule-rotation.jsonl`.
 *
 * Separado de `social-schedule-rotation.ts` (puro) porque escreve em disco.
 * Dois chamadores:
 *   - a CLI `scripts/social-schedule-rotation.ts --record` (manual, e o passo
 *     5c-3d do Stage 5 / `/diaria-retro-semanal` / Passo 9 do LinkedIn semanal);
 *   - os publicadores diários em `--schedule` (`publish-facebook.ts`,
 *     `publish-linkedin.ts`, `publish-instagram.ts`, `publish-threads.ts`), que
 *     chamam `recordDailyRotationFailSoft` ao fim do agendamento — self-review
 *     #10417 finding 3: o registro não pode depender só do playbook lembrar de
 *     rodar o passo. Idempotente: o 1º publicador grava, os demais não acham
 *     nada novo.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { editionDir } from "./edition-paths.ts";
import {
  HHMM_RE,
  type RotationPlanRow,
  baseTimesFromSocial,
  buildRotationPlan,
  civilDayNumber,
  civilFromDayNumber,
  parseIsoCivilDate,
  publishDateForEdition,
  readSocialRotation,
} from "./social-schedule-rotation.ts";

export const DEFAULT_ROTATION_LOG = "data/social-schedule-rotation.jsonl";

/** Pure: chave de deduplicação de uma linha do plano. */
export function rowKey(r: RotationPlanRow): string {
  if (r.kind === "weekday") return `${r.date}|weekday|${r.type}`;
  if (r.kind === "weekend") return `${r.date}|weekend|${r.day}`;
  return `${r.date}|linkedin_article`;
}

/**
 * Pure: linhas novas (ainda não gravadas) — `existing` é o conteúdo atual do
 * JSONL. Linha ilegível no arquivo é ignorada (não impede gravar as demais).
 * Uma linha já gravada com outro horário NÃO é sobrescrita: o registro é do
 * que foi decidido na hora (o config pode ter mudado depois).
 */
export function newRowsToRecord(existing: string, rows: RotationPlanRow[]): RotationPlanRow[] {
  const seen = new Set<string>();
  for (const line of existing.split("\n")) {
    if (!line.trim()) continue;
    try {
      seen.add(rowKey(JSON.parse(line) as RotationPlanRow));
    } catch {
      // linha corrompida: ignorar
    }
  }
  return rows.filter((r) => !seen.has(rowKey(r)));
}

/** Acrescenta ao JSONL as linhas ainda não gravadas. Devolve quantas eram novas. */
export function recordRotationRows(logPath: string, rows: RotationPlanRow[], recordedAt = new Date().toISOString()): number {
  const existing = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const fresh = newRowsToRecord(existing, rows);
  if (fresh.length > 0) {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, fresh.map((r) => JSON.stringify({ ...r, recorded_at: recordedAt })).join("\n") + "\n");
  }
  return fresh.length;
}

/**
 * Linha do registro com o horário REAL informado à mão (#11180): `time` passa a
 * ser o real (é o campo que a medição cruza com os cliques) e `planned_time`
 * guarda o que o plano mandava, com `time_differs_from_plan: true` como marca.
 * Linha publicada no horário planejado não leva nenhum dos dois campos.
 */
export type RecordedRotationRow = RotationPlanRow & { planned_time?: string; time_differs_from_plan?: true };

/**
 * Pure (#11180): aplica o `--time HH:MM` da CLI `--record`. Exige exatamente 1
 * linha (o horário real é de UM post; num dia útil sem `--kind` há 3-4 linhas e
 * não dá pra saber a qual ele se refere). Horário igual ao planejado devolve a
 * linha intacta, idêntica a um `--record` sem `--time`. Lança com HH:MM
 * inválido ou contagem de linhas diferente de 1.
 */
export function applyActualTime(rows: RotationPlanRow[], actual: string): RecordedRotationRow[] {
  const t = actual.trim();
  if (!HHMM_RE.test(t)) throw new Error(`--time inválido: '${actual}' (esperado HH:MM entre 00:00 e 23:59).`);
  if (rows.length !== 1) {
    const keys = rows.map(rowKey).join(", ") || "nenhuma";
    throw new Error(
      `--time exige exatamente 1 linha no --record; o filtro deixou ${rows.length} (${keys}). Isole o post com --kind (ex.: --kind linkedin_article).`,
    );
  }
  const [r] = rows;
  if (r.time === t) return [r];
  return [{ ...r, time: t, planned_time: r.time, time_differs_from_plan: true }];
}

/**
 * Pure (#11180): horário já gravado no JSONL pra mesma chave de `row`, quando
 * DIFERE de `row.time` — `null` se a chave não foi gravada ou se o horário bate.
 * O registro é append-only e não sobrescreve (`newRowsToRecord`), então um
 * `--time` depois de um `--record` sem ele seria descartado em silêncio; a CLI
 * usa isto pra falhar alto nesse caso.
 */
export function recordedTimeConflict(existing: string, row: RotationPlanRow): string | null {
  const key = rowKey(row);
  for (const line of existing.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as RotationPlanRow;
      if (rowKey(rec) === key) return rec.time === row.time ? null : rec.time;
    } catch {
      // linha corrompida: ignorar (mesma regra de newRowsToRecord)
    }
  }
  return null;
}

/**
 * O que o publicador sabe do próprio agendamento e o registro precisa (#10427).
 */
export interface DailyRotationRecordOptions {
  /**
   * O 4º post (Use Melhor, `um`) foi de fato agendado por ESTE publicador
   * neste dia. `false` tira a linha `…|weekday|um`: dia sem Use Melhor
   * elegível (ou peça faltando) não tem post, e gravar a célula faria a
   * medição tratar post inexistente como dado. Outro publicador que agendou o
   * `um` no mesmo dia grava a linha depois (o registro é por dia, não por
   * canal). `undefined` = desconhecido, mantém a linha. A CLI `--record` não
   * passa por aqui: ela filtra `um`/`d3` por `_internal/06-social-published.json`
   * (`filterUseMelhorRowsByPublished`). Ressalva (review #10432 finding 2):
   * o valor vem só dos `results` do run atual — publicador que pule um `um`
   * já agendado sem empurrá-lo pra `results` passa `false` na re-rodada; não
   * apaga nada (append-only), só não grava se a 1ª gravação fosse essa.
   */
  useMelhorScheduled?: boolean;
  /**
   * O post `d3` foi agendado por ESTE publicador (#10541). `false` tira a
   * linha `…|weekday|d3`: edição de 2 destaques (o editor rebaixou o D3 pro
   * Radar, #2316) não tem post d3, e gravar a célula faria `weekdayCoverage`
   * contar como coberto um horário × d3 que nunca recebeu post — mesma classe
   * do `um` acima, com a mesma ressalva de re-rodada. `undefined` = mantém.
   */
  d3Scheduled?: boolean;
  /** `--day-offset` do publicador — mesma data de `computeScheduledAt`. */
  dayOffsetOverride?: number;
}

/**
 * Pure: o post `um` foi agendado (ou já estava, em rodada anterior) segundo as
 * entradas que o publicador acumulou. `failed`/`draft`/`skipped` não contam.
 */
export function useMelhorScheduledIn(posts: ReadonlyArray<{ destaque: string; status: string }>): boolean {
  return destaqueScheduledIn(posts, "um");
}

/** Pure (#10541): generalização de `useMelhorScheduledIn` pra qualquer post (`d3`, …). */
export function destaqueScheduledIn(posts: ReadonlyArray<{ destaque: string; status: string }>, destaque: string): boolean {
  return posts.some((p) => p.destaque === destaque && (p.status === "scheduled" || p.status === "published"));
}

/**
 * Caminhos de `06-social-published.json` de uma edição, na ordem de leitura
 * (#10540): os 5 publicadores gravam em `_internal/`; a raiz é legado. Mesma
 * ordem de `readUseMelhorScheduledAt` (`resolve-post-pixel.ts`).
 */
export function socialPublishedCandidates(editionDirAbs: string): string[] {
  return [resolve(editionDirAbs, "_internal", "06-social-published.json"), resolve(editionDirAbs, "06-social-published.json")];
}

/**
 * Lê os posts do 1º `06-social-published.json` existente da edição
 * (`_internal/` antes da raiz, #10540). `null` = nenhum dos dois existe, ou o
 * 1º existente está malformado (não cai pro legado: um `_internal/` truncado
 * por escrita concorrente é o estado atual, não um arquivo ausente).
 */
export function readEditionPublishedPosts(
  editionDirAbs: string,
  warn: (msg: string) => void = (m) => console.error(m),
): ReadonlyArray<{ destaque: string; status: string }> | null {
  for (const p of socialPublishedCandidates(editionDirAbs)) {
    if (existsSync(p)) return readPublishedPosts(p, warn);
  }
  return null;
}

/**
 * Pure: AAMMDD da edição cujos posts diários saem em `publishDate`
 * (AAAA-MM-DD) — inverso de `publishDateForEdition` com o `day_offset` do
 * config (default 0).
 */
export function editionForPublishDate(publishDate: string, social: unknown): string {
  const raw = (social as { fallback_schedule?: { day_offset?: unknown } } | null | undefined)?.fallback_schedule?.day_offset;
  const offset = typeof raw === "number" && Number.isInteger(raw) ? raw : 0;
  const d = civilFromDayNumber(civilDayNumber(parseIsoCivilDate(publishDate)) - offset);
  return `${String(d.year).slice(2)}${String(d.month).padStart(2, "0")}${String(d.day).padStart(2, "0")}`;
}

/**
 * Lê os `posts` de um `06-social-published.json`. `null` = arquivo ausente OU
 * malformado (#10438 item 2): JSON truncado por escrita concorrente de um
 * publicador derrubava a CLI `--record`; agora vira "não dá pra saber" + WARN,
 * igual ao arquivo ausente. `posts` não-array = `[]`.
 */
export function readPublishedPosts(
  path: string,
  warn: (msg: string) => void = (m) => console.error(m),
): ReadonlyArray<{ destaque: string; status: string }> | null {
  if (!existsSync(path)) return null;
  try {
    const posts = (JSON.parse(readFileSync(path, "utf8")) as { posts?: unknown } | null)?.posts;
    return Array.isArray(posts) ? (posts as Array<{ destaque: string; status: string }>) : [];
  } catch (e) {
    warn(`[rotação #10438] WARN: ${path} malformado (${(e as Error).message}) — tratado como ausente.`);
    return null;
  }
}

/**
 * Pure (#10438 item 1): mensagem da CLI `--record`. "Já gravada(s)" conta só
 * as linhas que PASSARAM no filtro do `um`/`d3` (`candidates`) — a linha
 * descartada não foi gravada nem estava gravada; sai em contagem própria.
 */
export function formatRecordSummary(logPath: string, written: number, candidates: number, filteredOut: number): string {
  const base = `[social-schedule-rotation] ${written} linha(s) nova(s) em ${logPath} (${candidates - written} já gravada(s)`;
  return filteredOut > 0 ? `${base}, ${filteredOut} não gravada(s) — um/d3 sem post agendado).` : `${base}).`;
}

/**
 * Filtro da CLI `--record` (#10427, review #10432): a linha `…|weekday|um` só
 * fica quando `06-social-published.json` da edição do dia mostra o post `um`
 * agendado/publicado (`useMelhorScheduledIn`). Arquivo ausente = não dá pra
 * saber → a linha NÃO é gravada e `warn` recebe o motivo (rodar de novo
 * depois do Stage 5 grava, o registro é idempotente). A linha `d3` (#10541)
 * sai quando o arquivo existe e não tem o post `d3` agendado (edição de 2
 * destaques); arquivo ausente mantém a `d3` — 3 destaques é o padrão. Demais
 * linhas passam intactas. `readPublished(edition)` devolve os posts, ou
 * `null` se o arquivo não existe — injetável pra teste; o default lê
 * `_internal/06-social-published.json` (onde os publicadores gravam) e cai
 * pra raiz legada (#10540), sob `editionDir(edition)` em `rootDir`.
 */
export function filterUseMelhorRowsByPublished(
  rows: RotationPlanRow[],
  social: unknown,
  rootDir: string,
  warn: (msg: string) => void = (m) => console.error(m),
  readPublished: (edition: string) => ReadonlyArray<{ destaque: string; status: string }> | null = (edition) =>
    readEditionPublishedPosts(resolve(rootDir, editionDir(edition)), warn),
): RotationPlanRow[] {
  // Uma leitura por edição: `um` e `d3` do mesmo dia consultam o mesmo arquivo.
  const cache = new Map<string, ReturnType<typeof readPublished>>();
  return rows.filter((r) => {
    if (!(r.kind === "weekday" && (r.type === "um" || r.type === "d3"))) return true;
    const edition = editionForPublishDate(r.date, social);
    if (!cache.has(edition)) cache.set(edition, readPublished(edition));
    const posts = cache.get(edition) ?? null;
    if (posts === null) {
      if (r.type === "d3") return true;
      warn(
        `[rotação #10427] WARN: ${editionDir(edition)}/_internal/06-social-published.json ausente ou ilegível — linha um de ${r.date} NÃO gravada (rode --record de novo depois do Stage 5).`,
      );
      return false;
    }
    return destaqueScheduledIn(posts, r.type);
  });
}

/**
 * Pure: linhas de dia útil da edição `edition` (AAMMDD) que vieram da rotação.
 * Vazio quando a rotação não se aplica ao dia — aí não há o que registrar
 * (o horário fixo já é o default conhecido).
 */
export function dailyRotationRowsForEdition(
  social: unknown,
  edition: string,
  opts: DailyRotationRecordOptions = {},
): RotationPlanRow[] {
  const s = social as Parameters<typeof baseTimesFromSocial>[0];
  const date = publishDateForEdition(edition, s, opts.dayOffsetOverride);
  if (!date) return [];
  return buildRotationPlan(readSocialRotation(s), baseTimesFromSocial(s), date, date).filter(
    (r) =>
      r.kind === "weekday" &&
      r.source === "rotation" &&
      !(r.type === "um" && opts.useMelhorScheduled === false) &&
      !(r.type === "d3" && opts.d3Scheduled === false),
  );
}

/**
 * Grava (idempotente) as linhas do dia de `edition` — chamado pelos
 * publicadores ao fim do `--schedule`. NUNCA lança: falha vira linha no
 * stderr (o agendamento já aconteceu; o plano é reconstruível com `--plan`).
 *
 * Não grava sob o test runner (`NODE_TEST_CONTEXT`) — testes que sobem um
 * publicador como subprocesso não podem escrever no `data/` real. Destino
 * sobreponível por `DIARIA_SOCIAL_ROTATION_LOG`.
 */
export function recordDailyRotationFailSoft(
  rootDir: string,
  edition: string,
  opts: DailyRotationRecordOptions = {},
): void {
  if (process.env.NODE_TEST_CONTEXT && !process.env.DIARIA_SOCIAL_ROTATION_LOG) return;
  try {
    const config = JSON.parse(readFileSync(resolve(rootDir, "platform.config.json"), "utf8"));
    const rows = dailyRotationRowsForEdition(config?.publishing?.social, edition, opts);
    if (rows.length === 0) return;
    const logPath = resolve(rootDir, process.env.DIARIA_SOCIAL_ROTATION_LOG ?? DEFAULT_ROTATION_LOG);
    const n = recordRotationRows(logPath, rows);
    if (n > 0) console.error(`[rotação #10305] ${n} linha(s) do dia ${rows[0].date} gravada(s) em ${logPath}.`);
  } catch (e) {
    console.error(`[rotação #10305] WARN: registro do dia não gravado (${(e as Error).message}) — rode social-schedule-rotation.ts --record.`);
  }
}
