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
   * passa por aqui: ela filtra a linha `um` por `06-social-published.json`
   * (`filterUseMelhorRowsByPublished`). Ressalva (review #10432 finding 2):
   * o valor vem só dos `results` do run atual — publicador que pule um `um`
   * já agendado sem empurrá-lo pra `results` passa `false` na re-rodada; não
   * apaga nada (append-only), só não grava se a 1ª gravação fosse essa.
   */
  useMelhorScheduled?: boolean;
  /** `--day-offset` do publicador — mesma data de `computeScheduledAt`. */
  dayOffsetOverride?: number;
}

/**
 * Pure: o post `um` foi agendado (ou já estava, em rodada anterior) segundo as
 * entradas que o publicador acumulou. `failed`/`draft`/`skipped` não contam.
 */
export function useMelhorScheduledIn(posts: ReadonlyArray<{ destaque: string; status: string }>): boolean {
  return posts.some((p) => p.destaque === "um" && (p.status === "scheduled" || p.status === "published"));
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
 * Filtro da CLI `--record` (#10427, review #10432): a linha `…|weekday|um` só
 * fica quando `06-social-published.json` da edição do dia mostra o post `um`
 * agendado/publicado (`useMelhorScheduledIn`). Arquivo ausente = não dá pra
 * saber → a linha NÃO é gravada e `warn` recebe o motivo (rodar de novo
 * depois do Stage 5 grava, o registro é idempotente). Demais linhas passam
 * intactas. `readPublished(edition)` devolve os posts, ou `null` se o arquivo
 * não existe — injetável pra teste; o default lê `editionDir(edition)` sob
 * `rootDir`.
 */
export function filterUseMelhorRowsByPublished(
  rows: RotationPlanRow[],
  social: unknown,
  rootDir: string,
  warn: (msg: string) => void = (m) => console.error(m),
  readPublished: (edition: string) => ReadonlyArray<{ destaque: string; status: string }> | null = (edition) => {
    const p = resolve(rootDir, editionDir(edition), "06-social-published.json");
    if (!existsSync(p)) return null;
    return (JSON.parse(readFileSync(p, "utf8")) as { posts?: Array<{ destaque: string; status: string }> }).posts ?? [];
  },
): RotationPlanRow[] {
  return rows.filter((r) => {
    if (!(r.kind === "weekday" && r.type === "um")) return true;
    const edition = editionForPublishDate(r.date, social);
    const posts = readPublished(edition);
    if (posts === null) {
      warn(
        `[rotação #10427] WARN: ${editionDir(edition)}/06-social-published.json ausente — linha um de ${r.date} NÃO gravada (rode --record de novo depois do Stage 5).`,
      );
      return false;
    }
    return useMelhorScheduledIn(posts);
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
      !(r.type === "um" && opts.useMelhorScheduled === false),
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
