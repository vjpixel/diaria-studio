/**
 * Snapshot da fila COMPLETA de elegíveis de cada onda do envio diário da
 * Clarice (#10479) e o verificador de ordem sobre ele (definição de feito do
 * #9824).
 *
 * O #9824 trocou a ordem da fila única (`compareDailyQueueOrder`,
 * clarice-segment.ts) para `priority_points` DESC na fila inteira, com o
 * cadastro mais recente desempatando. A definição de feito pede prova por
 * script, em 3 ondas reais consecutivas, de que (a) nenhum contato incluído
 * tem score menor que algum elegível deixado de fora e (b) entre scores iguais
 * todo incluído tem cadastro igual ou mais recente que todo excluído. O
 * `daily-priority-snapshot.csv` (#4763) só tem os INCLUÍDOS; sem a fila
 * inteira, "deixado de fora" não tem como ser auditado depois, porque
 * `priority_points` é recomputado a cada sync e não guarda histórico.
 *
 * "Elegível" aqui é exatamente a saída de `buildDailySendQueue` na invocação:
 * já passou elegibilidade, recência, reserva (`--hold`) e o guard por contato.
 * Quem caiu nesses filtros não disputava vaga na onda; quem ficou só fora do
 * `--budget` disputava, e é esse corte que o verificador audita.
 *
 * O arquivo é gzip porque a fila pode ter dezenas de milhares de linhas por
 * onda e `data/` sincroniza por OneDrive entre as máquinas.
 */
import { gzipSync, gunzipSync } from "node:zlib";
import Papa from "papaparse";

/** Subdiretório de `segments/` onde cada onda grava o seu snapshot. */
export const DAILY_QUEUE_SNAPSHOT_DIR = "daily-queue";

export const DAILY_QUEUE_SNAPSHOT_FIELDS = ["rank", "email", "priority_points", "created", "included"] as const;

export interface DailyQueueSnapshotRow {
  /** Posição na fila ordenada, começando em 1. */
  rank: number;
  email: string;
  priority_points: number;
  /** `created` cru do store; string vazia quando ausente. */
  created: string;
  included: boolean;
}

/**
 * Monta o CSV (texto) da fila completa. `ordered` é a fila já ordenada por
 * `buildDailySendQueue`; os `includedCount` primeiros são os que foram pro
 * `daily.csv` (o corte de `--budget` é sempre um prefixo da fila).
 */
export function buildDailyQueueSnapshotCsv(
  ordered: ReadonlyArray<{ email: string; priority_points?: number | null; created?: string | null }>,
  includedCount: number,
): string {
  const data = ordered.map((r, i) => ({
    rank: i + 1,
    email: r.email,
    priority_points: r.priority_points ?? 0,
    created: r.created ?? "",
    included: i < includedCount ? 1 : 0,
  }));
  return Papa.unparse({ fields: [...DAILY_QUEUE_SNAPSHOT_FIELDS], data });
}

export function buildDailyQueueSnapshotGz(
  ordered: ReadonlyArray<{ email: string; priority_points?: number | null; created?: string | null }>,
  includedCount: number,
): Buffer {
  return gzipSync(Buffer.from(buildDailyQueueSnapshotCsv(ordered, includedCount), "utf8"));
}

/**
 * Nome do arquivo de uma onda. O carimbo de montagem vem primeiro para a
 * ordem lexicográfica ser a ordem cronológica das ondas (o verificador pega
 * as N últimas por nome). Dois-pontos e ponto viram hífen para o nome valer
 * no Windows.
 */
export function dailyQueueSnapshotFileName(builtAt: Date, sendDate?: string | null): string {
  const stamp = builtAt.toISOString().replace(/[:.]/g, "-");
  return `${stamp}_send-${sendDate || "sem-data"}.csv.gz`;
}

/** Lê o CSV (texto). Lança em cabeçalho ou linha inválida: snapshot corrompido
 *  não pode passar como "ordem verificada". */
export function parseDailyQueueSnapshotCsv(csv: string): DailyQueueSnapshotRow[] {
  const parsed = Papa.parse<Record<string, string>>(csv.trim(), { header: true, skipEmptyLines: true });
  const fields = parsed.meta.fields ?? [];
  for (const f of DAILY_QUEUE_SNAPSHOT_FIELDS) {
    if (!fields.includes(f)) throw new Error(`snapshot da fila sem a coluna '${f}' (colunas: ${fields.join(",")})`);
  }
  return parsed.data.map((r, i) => {
    const rank = Number(r.rank);
    const score = Number(r.priority_points);
    if (!Number.isFinite(rank) || !Number.isFinite(score) || !r.email || (r.included !== "0" && r.included !== "1")) {
      throw new Error(`snapshot da fila: linha ${i + 2} inválida (${JSON.stringify(r)})`);
    }
    return { rank, email: r.email, priority_points: score, created: r.created ?? "", included: r.included === "1" };
  });
}

export function parseDailyQueueSnapshotGz(buf: Buffer): DailyQueueSnapshotRow[] {
  return parseDailyQueueSnapshotCsv(gunzipSync(buf).toString("utf8"));
}

export type DailyQueueOrderViolation =
  | {
      kind: "score";
      /** Incluídos com score menor que o maior score deixado de fora. */
      count: number;
      included: { email: string; priority_points: number };
      excluded: { email: string; priority_points: number };
    }
  | {
      kind: "tie-created";
      priority_points: number;
      /** Incluídos deste score com cadastro mais antigo que o excluído mais recente. */
      count: number;
      included: { email: string; created: string };
      excluded: { email: string; created: string };
    };

export interface DailyQueueOrderReport {
  total: number;
  included: number;
  excluded: number;
  ok: boolean;
  violations: DailyQueueOrderViolation[];
}

/** `created` ausente ou inválido conta como o mais antigo possível, mesma
 *  regra de `compareContactRecency` (cadastro conhecido vence desconhecido). */
function createdTime(created: string): number {
  const t = created ? Date.parse(created) : NaN;
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/**
 * Verifica a definição de feito do #9824 sobre uma onda:
 * (a) nenhum incluído tem score menor que algum excluído;
 * (b) entre scores iguais, todo incluído tem cadastro igual ou mais recente
 *     que todo excluído.
 *
 * Compara extremos (mínimo dos incluídos contra máximo dos excluídos), então
 * é linear no tamanho da fila. Onda sem excluídos passa trivialmente: a fila
 * inteira coube no budget.
 */
export function verifyDailyQueueOrder(rows: ReadonlyArray<DailyQueueSnapshotRow>): DailyQueueOrderReport {
  const inc = rows.filter((r) => r.included);
  const exc = rows.filter((r) => !r.included);
  const violations: DailyQueueOrderViolation[] = [];

  if (inc.length > 0 && exc.length > 0) {
    let maxExc = exc[0];
    for (const r of exc) if (r.priority_points > maxExc.priority_points) maxExc = r;
    const below = inc.filter((r) => r.priority_points < maxExc.priority_points);
    if (below.length > 0) {
      let worst = below[0];
      for (const r of below) if (r.priority_points < worst.priority_points) worst = r;
      violations.push({
        kind: "score",
        count: below.length,
        included: { email: worst.email, priority_points: worst.priority_points },
        excluded: { email: maxExc.email, priority_points: maxExc.priority_points },
      });
    }

    // (b) por valor de score presente nos dois lados.
    const newestExcByScore = new Map<number, DailyQueueSnapshotRow>();
    for (const r of exc) {
      const cur = newestExcByScore.get(r.priority_points);
      if (!cur || createdTime(r.created) > createdTime(cur.created)) newestExcByScore.set(r.priority_points, r);
    }
    const incByScore = new Map<number, DailyQueueSnapshotRow[]>();
    for (const r of inc) {
      if (!newestExcByScore.has(r.priority_points)) continue;
      const list = incByScore.get(r.priority_points) ?? [];
      list.push(r);
      incByScore.set(r.priority_points, list);
    }
    for (const [score, list] of [...incByScore.entries()].sort((a, b) => b[0] - a[0])) {
      const newestExc = newestExcByScore.get(score)!;
      const limit = createdTime(newestExc.created);
      const older = list.filter((r) => createdTime(r.created) < limit);
      if (older.length === 0) continue;
      let oldest = older[0];
      for (const r of older) if (createdTime(r.created) < createdTime(oldest.created)) oldest = r;
      violations.push({
        kind: "tie-created",
        priority_points: score,
        count: older.length,
        included: { email: oldest.email, created: oldest.created },
        excluded: { email: newestExc.email, created: newestExc.created },
      });
    }
  }

  return { total: rows.length, included: inc.length, excluded: exc.length, ok: violations.length === 0, violations };
}
