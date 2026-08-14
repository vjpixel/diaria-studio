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

/** Subconjunto de `manifest.json` (`backup-beehiiv.ts` — `ManifestEntry`/
 *  `Manifest`) usado pelos consumidores deste módulo: status por endpoint,
 *  pra diferenciar "pulado de propósito" (`--no-subscribers`) de "falhou de
 *  verdade" (`.partial` preservado, `subscribers.jsonl` nunca criado). */
export interface BackupManifestEntry {
  key: string;
  file: string;
  status: "ok" | "skipped" | "error";
  count?: number;
  error?: string;
}

export interface BackupManifest {
  generatedAt?: string;
  endpoints: BackupManifestEntry[];
  totals?: Record<string, number>;
}

export function manifestJsonPath(root: string, date: string): string {
  return join(root, date, "manifest.json");
}

/** Lê e parsifica `manifest.json` de um snapshot. Ausente ou corrompido
 *  retorna `null` (fail-soft — mesmo espírito de `readSnapshotSubscribers`;
 *  snapshots anteriores ao #5229 podem nem ter manifest). */
export function readBackupManifest(root: string, date: string): BackupManifest | null {
  const path = manifestJsonPath(root, date);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BackupManifest;
  } catch {
    return null;
  }
}

/** Resultado de {@link isSubscribersSnapshotUsable}: `usable=false` sempre
 *  vem com `reason` explicando o motivo (log/e-mail de alarme usam isso
 *  direto, sem re-derivar). */
export interface SubscribersSnapshotUsability {
  usable: boolean;
  reason: string | null;
}

/** Decide se `subscribers.jsonl` de um snapshot é utilizável pra avaliar
 *  achados (#5281 — snapshot ausente/vazio não deve virar "avaliado: limpo"
 *  silencioso). Checa nesta ordem:
 *
 *  1. `manifest.json` tem entry `subscribers` com `status: "error"` →
 *     inutilizável, motivo = o erro registrado no backup.
 *  2. `manifest.json` tem entry `subscribers` com `status: "skipped"` →
 *     inutilizável (rodou com `--no-subscribers` — não há base pra avaliar).
 *  3. Sem manifest (ou sem entry `subscribers`) ou `status: "ok"`: cai pro
 *     conteúdo de fato — `readSnapshotSubscribers` vazio (arquivo ausente OU
 *     só linhas corrompidas) também é inutilizável, mesmo que o manifest
 *     diga "ok" (proteção contra o manifest e o arquivo divergirem). */
export function isSubscribersSnapshotUsable(root: string, date: string): SubscribersSnapshotUsability {
  const manifest = readBackupManifest(root, date);
  const entry = manifest?.endpoints.find((e) => e.key === "subscribers") ?? null;
  if (entry?.status === "error") {
    return {
      usable: false,
      reason: `manifest.json reporta erro no endpoint subscribers: ${entry.error ?? "motivo não registrado"}`,
    };
  }
  if (entry?.status === "skipped") {
    return { usable: false, reason: "manifest.json reporta subscribers pulado (rodou com --no-subscribers)" };
  }
  if (readSnapshotSubscribers(root, date).length === 0) {
    return { usable: false, reason: "subscribers.jsonl ausente, vazio ou só com linhas corrompidas" };
  }
  return { usable: true, reason: null };
}
