/**
 * beehiiv-backup-snapshots.ts (#5235)
 *
 * Helpers de LEITURA LOCAL dos snapshots semanais gerados por
 * `scripts/backup-beehiiv.ts` (`data/beehiiv-backup/{YYYY-MM-DD}/`, task
 * `Diaria-Beehiiv-Backup`, #5229). Puramente leitura de arquivo — nunca chama
 * a API Beehiiv (guard de publicação do overnight/develop: scripts que tocam
 * Beehiiv ao vivo não rodam aqui, e este módulo não é um desses).
 *
 * Consumido por `scripts/lib/leitor.ts` (CLI de definição de leitor-v1,
 * #5235 Parte 1) e `scripts/build-origem-map.ts` (mapa de origem recuperada,
 * #5235 Parte 2) — ambos precisam listar snapshots disponíveis e iterar
 * `subscribers.jsonl` de forma idêntica; extraído aqui pra não duplicar.
 *
 * Parse é tolerante a linha corrompida (arquivo pode ter sido escrito
 * parcialmente numa falha de rede do backup) — mesmo padrão de
 * `parseIntentionalErrorsJsonl` (`scripts/lib/intentional-errors.ts`): linha
 * que não parseia é ignorada, nunca aborta o resto do arquivo.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Nome de diretório de snapshot: `YYYY-MM-DD` (ver `backupDir` em backup-beehiiv.ts). */
const SNAPSHOT_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Subconjunto dos campos de `subscribers.jsonl` usado pelos consumidores
 *  desta issue. O objeto real tem mais campos (custom_fields, tags,
 *  referrals, stripe_customer_id) — deliberadamente não tipados aqui porque
 *  nenhum consumidor atual precisa deles; `stats.click_rate` está TIPADO
 *  (existe no dado real, ver `docs/definicao-leitor.md`) mas nenhuma função
 *  deste módulo ou de `leitor.ts` o lê — só `total_received`/`total_unique_clicked`. */
export interface BeehiivBackupSubscriber {
  email: string;
  status: string;
  created: number;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  referring_site: string;
  stats?: {
    total_received?: number;
    total_unique_clicked?: number;
    total_unique_opened?: number;
    /** Presente no dado real — ver o Apêndice A do mídia kit e a armadilha
     *  documentada em `docs/definicao-leitor.md`. Nenhuma função deste
     *  repo deve ler este campo como se fosse CTR sobre entregas. */
    click_rate?: number;
  } | null;
}

/** Lista as datas de snapshot disponíveis sob `root`, ordem ASCENDENTE
 *  (mais antigo primeiro — `YYYY-MM-DD` ordena lexicograficamente igual à
 *  ordem cronológica). `root` ausente retorna `[]` (sem crash — mesmo
 *  fail-soft de `loadIntentionalErrors`). */
export function listSnapshotDates(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SNAPSHOT_DIR_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Data do snapshot mais recente sob `root`, ou `null` se nenhum existir. */
export function latestSnapshotDate(root: string): string | null {
  const dates = listSnapshotDates(root);
  return dates.length > 0 ? dates[dates.length - 1] : null;
}

export function subscribersJsonlPath(root: string, date: string): string {
  return join(root, date, "subscribers.jsonl");
}

/** Pure: parsifica o conteúdo de um `subscribers.jsonl`, ignorando linhas
 *  vazias ou corrompidas. */
export function parseSubscribersJsonl(content: string): BeehiivBackupSubscriber[] {
  const out: BeehiivBackupSubscriber[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as BeehiivBackupSubscriber;
      if (parsed && typeof parsed.email === "string") out.push(parsed);
    } catch {
      continue; // linha corrompida → skip, mesmo padrão de parseIntentionalErrorsJsonl
    }
  }
  return out;
}

/** Lê e parsifica `subscribers.jsonl` de um snapshot. Arquivo ausente
 *  retorna `[]` (snapshot pode ter rodado com `--no-subscribers`). */
export function readSnapshotSubscribers(root: string, date: string): BeehiivBackupSubscriber[] {
  const path = subscribersJsonlPath(root, date);
  if (!existsSync(path)) return [];
  return parseSubscribersJsonl(readFileSync(path, "utf8"));
}
