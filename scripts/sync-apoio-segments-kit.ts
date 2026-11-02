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
 * Só LÊ do Kit. Os caches antigos `beehiiv-segments.json` e
 * `beehiiv-vinculo.json` ficam no disco, sem uso.
 *
 * O endpoint de lista do Kit serve `fields` defasado por um tempo depois de um
 * PATCH: logo após `sync-apoio-nivel-kit.ts --push`, o painel pode mostrar o
 * nível antigo até a próxima rodada deste script.
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
import { type ApoioNivel, isApoioNivel } from "./lib/shared/apoio-nivel-types.ts";
import type { ApoioSubscriberSnapshot } from "./lib/apoio-nivel-sync.ts";
import { fetchCurrentKitState } from "./sync-apoio-nivel-kit.ts";
import { segmentsCachePath, vinculoCachePath, type SegmentsCache, type VinculoCache } from "./studio-ui/studio-apoios.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[sync-apoio-segments-kit]";

const NIVEL_TO_SEGMENT_NAME: Record<ApoioNivel, string> = {
  amigo: "Apoio — Amigo",
  apoiador: "Apoio — Apoiador",
  mantenedor: "Apoio — Mantenedor",
  patrono: "Apoio — Patrono",
};

const SEGMENT_NAME_TODOS = "Apoio — Todos";
const SEGMENT_NAME_NENHUM = "Apoio — Nenhum";

/**
 * Pure: segmentos `Apoio — *` de um valor de `apoio_nivel`. Nível setado casa
 * com a faixa + "Todos"; vazio ou desconhecido casa só com "Nenhum".
 * `isApoioNivel` compara valores, então um campo externo como "toString" nunca
 * casa pela cadeia de protótipo do objeto acima (self-review #4437).
 */
export function segmentsForNivel(apoioNivel: string): string[] {
  if (isApoioNivel(apoioNivel)) {
    return [NIVEL_TO_SEGMENT_NAME[apoioNivel], SEGMENT_NAME_TODOS];
  }
  return [SEGMENT_NAME_NENHUM];
}

/** Pure: cache `email normalizado → SegmentsInfo` a partir do snapshot lido. */
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

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const kitConfig = resolveKitConfig();
  if (!kitConfig.ok) {
    process.stderr.write(`${LOG_PREFIX} ${kitConfig.reason}\n`);
    process.exitCode = 1;
    return;
  }

  const contactEmails = loadContacts(ROOT).flatMap((c) => c.emails);
  const wanted = new Set(contactEmails.map((e) => e.trim().toLowerCase()));

  process.stderr.write(`${LOG_PREFIX} buscando estado atual no Kit…\n`);
  const subscriptions = await fetchCurrentKitState(kitConfig.config);
  process.stderr.write(`${LOG_PREFIX} ${subscriptions.length} assinante(s) ativo(s) no Kit.\n`);

  const segments = buildSegmentsCache(subscriptions.filter((s) => wanted.has(s.email)));
  const vinculo = buildVinculoCache(contactEmails, subscriptions);
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
