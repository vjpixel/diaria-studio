#!/usr/bin/env node
/**
 * scripts/sync-apoio-segments-kit.ts (#4437 Entrega 2, fonte Kit desde o #11225)
 *
 * Popula os caches LOCAIS do painel Apoios do Studio a partir do Kit, só com
 * os e-mails dos contatos de apoio (a base inteira não precisa ficar em disco):
 *
 * - `data/apoia-se/kit-segments.json`: em quais dos 6 segmentos
 *   `Apoio — {Amigo,Apoiador,Mantenedor,Patrono,Todos,Nenhum}` cada um está.
 *   A pertinência é DERIVADA do custom field `apoio_nivel`, porque o Kit não
 *   lista membros de segmento (`lib/apoio-segments-canonical-kit.ts`).
 * - `data/apoia-se/kit-vinculo.json`: se o e-mail é assinante ativo no Kit.
 *
 * Leitura vazia sai não-zero sem sobrescrever os caches.
 *
 * Só LÊ do Kit. Os caches antigos `beehiiv-segments.json` e
 * `beehiiv-vinculo.json` ficam no disco, sem uso.
 *
 * O endpoint de lista do Kit serve `fields` defasado por um tempo depois de um
 * PATCH: rodar logo após `sync-apoio-nivel-kit.ts --push` grava o nível antigo.
 * Rodar depois que o dry-run do nível convergir.
 *
 * Uso:
 *   npx tsx scripts/sync-apoio-segments-kit.ts
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { loadContacts } from "./lib/apoio-contacts-store.ts";
import { expectedKitSegmentsFor } from "./lib/apoio-segments-canonical-kit.ts";
import type { ApoioSubscriberSnapshot } from "./lib/apoio-nivel-sync.ts";
import { fetchCurrentKitState } from "./sync-apoio-nivel-kit.ts";
import { segmentsCachePath, vinculoCachePath, type SegmentsCache, type VinculoCache } from "./studio-ui/studio-apoios.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[sync-apoio-segments-kit]";

/** Segmentos `Apoio — *` de um valor de `apoio_nivel`, pela condição canônica. */
export function segmentsForNivel(apoioNivel: string): string[] {
  return expectedKitSegmentsFor(apoioNivel);
}

/** Pure: cache `email normalizado → SegmentsInfo`, uma entrada por assinante. */
export function buildSegmentsCache(
  subscriptions: readonly ApoioSubscriberSnapshot[],
  now: Date = new Date(),
): SegmentsCache {
  const checkedAt = now.toISOString();
  const cache: SegmentsCache = {};
  for (const sub of subscriptions) {
    cache[sub.email] = {
      segments: segmentsForNivel(sub.apoioNivel),
      apoioNivel: sub.apoioNivel,
      checkedAt,
    };
  }
  return cache;
}

/**
 * Pure: vínculo de cada e-mail de contato contra os assinantes ativos do Kit.
 * E-mail fora da lista vira `hasVinculo: false` (consultado, sem vínculo), para
 * o painel não confundir com "nunca consultado".
 */
export function buildVinculoCache(
  contactEmails: readonly string[],
  subscriptions: readonly ApoioSubscriberSnapshot[],
  now: Date = new Date(),
): VinculoCache {
  const fetchedAt = now.toISOString();
  const byEmail = new Map(subscriptions.map((s) => [s.email, s]));
  const cache: VinculoCache = {};
  for (const raw of contactEmails) {
    const email = raw.trim().toLowerCase();
    if (!email) continue;
    const sub = byEmail.get(email);
    cache[email] = sub
      ? { hasVinculo: true, subscriptionId: sub.subscriptionId, status: "active", fetchedAt }
      : { hasVinculo: false, subscriptionId: null, status: null, fetchedAt };
  }
  return cache;
}

/**
 * Pure: os dois caches do painel, só com e-mails de contatos. Contato fora da
 * base ativa ganha entrada mesmo assim (`segments: []`, `hasVinculo: false`):
 * foi consultado, e o painel distingue isso de "nunca consultado". Lista vazia
 * lança, para uma leitura ruim nunca sobrescrever o cache anterior.
 */
export function buildPanelCaches(
  contactEmails: readonly string[],
  subscriptions: readonly ApoioSubscriberSnapshot[],
  now: Date = new Date(),
): { segments: SegmentsCache; vinculo: VinculoCache } {
  const wanted = new Set(contactEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) throw new Error("nenhum contato de apoio carregado; caches não foram sobrescritos.");
  if (subscriptions.length === 0) throw new Error("nenhum assinante ativo lido do Kit; caches não foram sobrescritos.");
  const segments = buildSegmentsCache(subscriptions.filter((s) => wanted.has(s.email)), now);
  for (const email of wanted) {
    segments[email] ??= { segments: [], apoioNivel: "", checkedAt: now.toISOString() };
  }
  return { segments, vinculo: buildVinculoCache([...wanted], subscriptions, now) };
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const kitConfig = resolveKitConfig();
  if (!kitConfig.ok) {
    process.stderr.write(`${LOG_PREFIX} ${kitConfig.reason}\n`);
    process.exitCode = 1;
    return;
  }

  const contactEmails = loadContacts(ROOT).flatMap((c) => c.emails);

  process.stderr.write(`${LOG_PREFIX} buscando estado atual no Kit…\n`);
  const subscriptions = await fetchCurrentKitState(kitConfig.config);
  process.stderr.write(`${LOG_PREFIX} ${subscriptions.length} assinante(s) ativo(s) no Kit.\n`);

  const { segments, vinculo } = buildPanelCaches(contactEmails, subscriptions);
  writeFileAtomic(segmentsCachePath(ROOT), JSON.stringify(segments, null, 2));
  writeFileAtomic(vinculoCachePath(ROOT), JSON.stringify(vinculo, null, 2));
  process.stderr.write(
    `${LOG_PREFIX} caches gravados: ${Object.keys(segments).length} com segmento, ${Object.keys(vinculo).length} com vínculo consultado.\n`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${LOG_PREFIX} erro fatal: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}
