/**
 * onboarding-store.ts (#5908)
 *
 * Store JSON simples (mesma família de `brevo-diaria-store.ts` — sem SQLite)
 * que rastreia o ciclo de vida de onboarding de cada assinante novo da
 * Beehiiv detectado pelo script diário `scripts/onboarding-welcome-run.ts`:
 *
 *   detected → email1_sent (transacional, imediato) →
 *     email2_sent (transacional, D+3) →
 *       email3: campaign_created (D+10, zero aberturas+cliques — campanha
 *               Brevo, SEMPRE rascunho por padrão)
 *             | skipped_opened (abriu ou clicou algo antes do D+10)
 *             | skipped_inactive (status Beehiiv ≠ active na decisão)
 *             | skipped_sem_dados (stats ausentes após janela de tolerância)
 *
 * Contexto (#5908, decisão do editor 22/08/2026 ~11:08 BRT via Telegram):
 * a automação Beehiiv `Onboarding — Boas-vindas` (#5808) não pode ser
 * publicada porque QUALQUER automação exige o plano Scale — upgrade
 * recusado. O mecanismo escolhido foi o candidato 1 da issue: Brevo
 * transacional + script diário de detecção (`created_at__gte` na API
 * pública v2, confirmado ao vivo em 22/08/2026), custo zero adicional.
 *
 * Arquivo em `data/onboarding/store.json` (gitignored via blanket de
 * `data/`, sincroniza pelo OneDrive como o resto do diretório).
 *
 * Toda DECISÃO (quem recebe o quê e quando) é PURA e vive em
 * `onboarding-state.ts`; este módulo guarda só forma + I/O, com `path`
 * injetável pra testes nunca tocarem o `data/` real. Escrita é atômica
 * (tmp + rename) pra um crash mid-write nunca corromper o JSON.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_STORE_PATH = resolve(ROOT, "data/onboarding/store.json");

/** Estado do e-mail 3 (única etapa com ramificação condicional). */
export type OnboardingEmail3State =
  | "pending"
  | "campaign_created"
  | "skipped_opened"
  | "skipped_inactive"
  /** Stats Beehiiv ausentes mesmo após a janela de tolerância — não dá pra
   * avaliar "zero aberturas" sem dado; desiste de propósito (terminal),
   * nunca envia às cegas. */
  | "skipped_sem_dados";

export interface OnboardingEntry {
  /** id da subscription na Beehiiv (chave do mapa `entries`). */
  subscription_id: string;
  email: string;
  /** Status Beehiiv no momento da detecção (`active` | `pending` | ...). */
  status_detectado: string;
  /** Epoch SEGUNDOS (campo `created` da API Beehiiv) — base do D+3/D+10. */
  created_at: number | null;
  /** ISO — quando entrou no store. */
  detected_at: string;
  /** ISO — quando o e-mail 1 transacional saiu (null = ainda não). */
  email1_sent_at: string | null;
  /** ISO — quando o e-mail 2 transacional saiu (null = ainda não). */
  email2_sent_at: string | null;
  email3_state: OnboardingEmail3State;
  /** Id da campanha Brevo (rascunho) que continha este contato no D+10. */
  email3_campaign_id: number | null;
  /** ISO — quando o destino do e-mail 3 foi decidido (qualquer branch). */
  email3_decided_at: string | null;
}

export interface OnboardingStore {
  version: 1;
  /**
   * Cursor de detecção em epoch SEGUNDOS — alimenta `created_at__gte` na
   * próxima varredura. `null` = primeira execução (BOOTSTRAP): marca o
   * cursor em `now` e NÃO adiciona entrada alguma — onboarding vale só pra
   * quem chegar DEPOIS da ativação (premissa registrada na #5908; a base
   * existente nunca recebeu a sequência e não deve recebê-la retroativamente).
   */
  last_detection_cursor: number | null;
  /** Id da lista Brevo dedicada ao cohort D+10 (criada sob demanda). */
  d10_brevo_list_id: number | null;
  entries: Record<string, OnboardingEntry>;
}

export function emptyStore(): OnboardingStore {
  return { version: 1, last_detection_cursor: null, d10_brevo_list_id: null, entries: {} };
}

/**
 * Lê o store do disco. Arquivo ausente/corrompido → store vazio (com aviso
 * no stderr para corrupção — arquivo presente mas ilegível merece sinal,
 * não silêncio; ausente é o estado natural da 1ª execução).
 */
export function readStore(path: string = DEFAULT_STORE_PATH): { store: OnboardingStore; corrupted: boolean } {
  if (!existsSync(path)) return { store: emptyStore(), corrupted: false };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as OnboardingStore;
    // Normaliza campos novos (store antigo pode não ter d10_brevo_list_id)
    return {
      store: {
        version: 1,
        last_detection_cursor: raw.last_detection_cursor ?? null,
        d10_brevo_list_id: raw.d10_brevo_list_id ?? null,
        entries: raw.entries ?? {},
      },
      corrupted: false,
    };
  } catch (e) {
    process.stderr.write(`[onboarding-store] JSON ilegível (${(e as Error).message}) — tratando como store vazio.\n`);
    return { store: emptyStore(), corrupted: true };
  }
}

/** Escrita atômica: grava em `{path}.tmp` e rename por cima do original. */
export function writeStore(store: OnboardingStore, path: string = DEFAULT_STORE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
  renameSync(tmp, path);
}
