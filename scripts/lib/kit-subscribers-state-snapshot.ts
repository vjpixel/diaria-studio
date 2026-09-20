/**
 * kit-subscribers-state-snapshot.ts (#8543 / #8552)
 *
 * Snapshot de estado `(id, state, created_at)` dos assinantes do Kit — o
 * único jeito de detectar "quem virou `active` desde a última rodada".
 *
 * ## Por que o Kit não serve sozinho
 *
 * O Kit não preserva o estado de criação na `subscription`: um assinante
 * `active` hoje pode ter nascido `active` (cadastro direto) ou nascido
 * `inactive` e confirmado depois (double opt-in). Só comparando o estado de
 * AGORA com o de na última rodada é possível distinguir os dois, e o estado
 * anterior tem que ser mantido por nós — a #8552 desenha esse snapshot
 * pra servir a #8543, #8548 e a própria #8552.
 *
 * ## O que entra no snapshot
 *
 * Apenas `id`, `state` e `created_at` — o mínimo que o Kit já expõe em
 * `GET /v4/subscribers` (`listKitSubscribersPage`, `kit-subscribers.ts`).
 * `created_at` é o horário do CADASTRO, não da confirmação: o Kit não
 * expõe timestamp de transição, então o `ts` do evento `confirm` que
 * `detectKitConfirmations` grava é esse `created_at` do snapshot onde a
 * transição foi detectada. Quem quiser o horário real da confirmação
 * (#8552 item 2) precisa de outra fonte.
 *
 * ## Fronteira `lib/shared/` (#2747)
 *
 * Puro — só constantes + parse de JSON, zero I/O, zero dependência de Node:
 * pode ser importado no bundle do Worker `reativar` e em scripts Node sem
 * quebrar a regra de fronteira.
 */

/** Linha do snapshot — o subset do Kit que o snapshot precisa. */
export interface KitSubscriberStateSnapshot {
  id: number;
  state: string;
  createdAt: string;
}

/** Nome do arquivo de snapshot por dia: `YYYY-MM-DD`. */
export function snapshotFileName(date: string): string {
  return `${date}.jsonl`;
}

/** Nome do diretório de snapshots, relativo à raiz do repo. */
export const DEFAULT_KIT_STATE_SNAPSHOT_DIR = "data/kit-subscribers-state";

/** Parse tolerante de 1 linha do snapshot — mesma disciplina de
 * `beehiiv-backup-snapshots.ts` (linha corrompida é ignorada, nunca aborta
 * o arquivo). `state` é `unknown` (não `string`) porque é um campo do Kit
 * que pode vir em formatos inesperados em rodadas futuras; o consumidor
 * checa o valor antes de usar. */
export function parseKitSubscriberStateSnapshotLine(
  line: string,
): KitSubscriberStateSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const id = o.id;
  const state = o.state;
  const createdAt = o.createdAt ?? o.created_at;
  if (typeof id !== "number" || !Number.isFinite(id)) return null;
  if (typeof state !== "string" || state.length === 0) return null;
  if (typeof createdAt !== "string" || createdAt.length === 0) return null;
  return { id, state, createdAt };
}

/**
 * Lê um snapshot já parseado em um `Map<number, KitSubscriberStateSnapshot>`
 * indexado por `id` — a forma que `detectKitConfirmations` espera como
 * `previous`. Pure, sem I/O.
 */
export function indexSnapshotById(
  rows: readonly KitSubscriberStateSnapshot[],
): Map<number, KitSubscriberStateSnapshot> {
  const map = new Map<number, KitSubscriberStateSnapshot>();
  for (const row of rows) map.set(row.id, row);
  return map;
}