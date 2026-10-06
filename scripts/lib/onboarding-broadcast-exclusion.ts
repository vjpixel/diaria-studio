/**
 * onboarding-broadcast-exclusion.ts (#7916 — compat com #7922)
 *
 * O transporte Kit do onboarding (#7922, `scripts/onboarding-kit-transport-run.ts`)
 * envia cada lote de boas-vindas (email1/email2/email3) como um BROADCAST Kit
 * segmentado por tag — o `broadcast_id` fica persistido em
 * `store.kit_transport.lots[*].broadcast_id` (`data/onboarding/store.json`,
 * `onboarding.store_path` no config).
 *
 * `scripts/diaria-subscribers-ingest-kit.ts` ingere TODO broadcast
 * `status: completed` do Kit no store unificado, gravando eventos
 * sent/delivered/open/click com `edicao = broadcast_id`. Sem este filtro, cada
 * lote de onboarding viraria uma "edição" recebida/clicada para
 * `countDistinctEditions` (`leitor-store.ts`) — inflando o `leitor-v1`
 * (limiar de 20 edições recebidas + CTR) justamente na coorte nova, que
 * recebe 3 desses e-mails. Pela Brevo isso nunca aconteceu: o onboarding é
 * transacional e não passa pelo ingest de campanhas
 * (`diaria-subscribers-ingest-brevo.ts`).
 *
 * ## Política de falha (store de onboarding ausente/ilegível)
 *
 * Deixar passar um broadcast de onboarding = inflar o `leitor-v1` em
 * silêncio. Por isso:
 * - store ilegível ou ausente COM `onboarding.kit_transport.enabled === true`
 *   → LANÇA (a ingestão inteira aborta; melhor nenhum dado novo que dado
 *   contaminado sem sinal);
 * - store ilegível ou ausente com o switch OFF → aviso + conjunto vazio. Com o
 *   switch OFF o executor de produção recusa `--send`, então não há lote de
 *   produção a excluir; abortar aqui derrubaria a ingestão diária de
 *   edições por um subsistema desligado.
 * - store legível → exclui todo `broadcast_id` persistido, INDEPENDENTE do
 *   estado do switch (um rollback que desliga o switch não pode fazer os
 *   lotes já enviados voltarem a contar como edição).
 *
 * Limite conhecido: lotes do modo `--pilot` vivem num store ISOLADO
 * (`assertPilotStoreIsolated`) que este módulo não lê — os broadcasts de
 * piloto (só destinatários de teste autorizados) não são excluídos.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readStore, type OnboardingStore } from "./onboarding-store.ts";

type KitLots = NonNullable<OnboardingStore["kit_transport"]>["lots"];

export interface OnboardingBroadcastExclusion {
  /** `broadcast_id`s (como string, mesma chave do manifest de ingestão) a excluir. */
  ids: Set<string>;
  /** De onde veio o conjunto — `store` = lido com sucesso. */
  source: "store" | "store-absent" | "store-corrupted";
  kitTransportEnabled: boolean;
  /** Aviso a imprimir no stderr (store ausente/ilegível com switch OFF); `null` quando não há. */
  warning: string | null;
}

/** @pure — todo `broadcast_id` não-nulo dos lotes persistidos, como string. */
export function collectOnboardingBroadcastIds(lots: KitLots | undefined | null): Set<string> {
  const ids = new Set<string>();
  for (const lot of Object.values(lots ?? {})) {
    if (lot != null && typeof lot.broadcast_id === "number" && Number.isFinite(lot.broadcast_id)) {
      ids.add(String(lot.broadcast_id));
    }
  }
  return ids;
}

/**
 * @pure — decide o conjunto de exclusão a partir do que foi lido do disco.
 * Lança quando o store não pôde ser lido e o transporte Kit está LIGADO (ver
 * "Política de falha" na docstring do módulo).
 */
export function decideOnboardingBroadcastExclusion(input: {
  storeExists: boolean;
  corrupted: boolean;
  lots: KitLots | undefined | null;
  kitTransportEnabled: boolean;
  storePath: string;
}): OnboardingBroadcastExclusion {
  const { storeExists, corrupted, lots, kitTransportEnabled, storePath } = input;
  if (!storeExists || corrupted) {
    const source = corrupted ? "store-corrupted" : "store-absent";
    const what = corrupted ? "ilegível" : "ausente";
    if (kitTransportEnabled) {
      throw new Error(
        `[onboarding-broadcast-exclusion] store de onboarding ${what} (${storePath}) com ` +
          "onboarding.kit_transport.enabled=true — impossível saber quais broadcasts do Kit são lotes de " +
          "onboarding; abortando a ingestão em vez de contá-los como edições e inflar o leitor-v1 (#7916).",
      );
    }
    return {
      ids: new Set(),
      source,
      kitTransportEnabled,
      warning:
        `[onboarding-broadcast-exclusion] store de onboarding ${what} (${storePath}) — transporte Kit desligado, ` +
        "seguindo sem excluir broadcasts de onboarding (nenhum lote de produção possível com o switch OFF).",
    };
  }
  return { ids: collectOnboardingBroadcastIds(lots), source: "store", kitTransportEnabled, warning: null };
}

/** @pure — separa os broadcasts de onboarding dos de edição. Preserva a ordem. */
export function excludeOnboardingBroadcasts<T extends { id: number | string }>(
  broadcasts: readonly T[],
  ids: ReadonlySet<string>,
): { kept: T[]; excluded: T[] } {
  const kept: T[] = [];
  const excluded: T[] = [];
  for (const b of broadcasts) (ids.has(String(b.id)) ? excluded : kept).push(b);
  return { kept, excluded };
}

/**
 * I/O — lê `platform.config.json` (`onboarding.store_path`,
 * `onboarding.kit_transport.enabled`) e o store de onboarding. `store_path`
 * relativo é resolvido contra o diretório do config (a raiz do repo, em
 * produção — mesmo resultado de `resolve(ROOT, store_path)` do executor).
 * Config ilegível LANÇA: sem ele não dá pra saber se o switch está ligado.
 */
export function readOnboardingBroadcastExclusion(configPathAbs: string): OnboardingBroadcastExclusion {
  const raw = JSON.parse(readFileSync(configPathAbs, "utf8")) as {
    onboarding?: { store_path?: string; kit_transport?: { enabled?: boolean } };
  };
  const storePath = resolve(dirname(configPathAbs), raw.onboarding?.store_path ?? "data/onboarding/store.json");
  const kitTransportEnabled = raw.onboarding?.kit_transport?.enabled === true;
  const storeExists = existsSync(storePath);
  const { store, corrupted } = storeExists ? readStore(storePath) : { store: null, corrupted: false };
  return decideOnboardingBroadcastExclusion({
    storeExists,
    corrupted,
    lots: store?.kit_transport?.lots,
    kitTransportEnabled,
    storePath,
  });
}
