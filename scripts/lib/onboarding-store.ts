/**
 * onboarding-store.ts (#5908)
 *
 * Store JSON simples (mesma família de `brevo-diaria-store.ts` — sem SQLite)
 * que rastreia o ciclo de vida de onboarding de cada assinante novo
 * detectado pelo script diário `scripts/onboarding-welcome-run.ts`
 * (Beehiiv ou Kit, ver `last_detection_backend` abaixo — #7599):
 *
 *   detected → email1_sent (transacional, imediato) →
 *     email2_sent (transacional, D+3) →
 *       email3: campaign_created (D+10, PELO MENOS 1 abertura — campanha
 *               Brevo, SEMPRE rascunho por padrão; condição INVERTIDA em
 *               #7599, era "zero aberturas+cliques")
 *             | skipped_no_open (zero abertura em D+10 — #7599, terminal)
 *             | skipped_inactive (status/state ≠ active na decisão)
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

/**
 * Estado do e-mail 3 (única etapa com ramificação condicional).
 *
 * #7599 (08/09/2026, decisão do editor registrada na issue): a condição de
 * disparo INVERTEU — o e-mail 3 (copy de apoio, ex-Kit) agora dispara só
 * para quem ABRIU pelo menos 1 edição em D+10 (`campaign_created`); quem
 * tem ZERO aberturas nessa data simplesmente não recebe nada por ora
 * (`skipped_no_open`, terminal) — não é o reengajamento antigo (que exigia
 * exatamente o oposto: zero aberturas+cliques). `skipped_opened` foi
 * renomeado para `skipped_no_open` porque o nome antigo descrevia o motivo
 * do skip da condição ANTIGA (abriu = skip) — manter o nome com a condição
 * invertida teria o sentido oposto ao que o campo passou a significar.
 */
export type OnboardingEmail3State =
  | "pending"
  | "campaign_created"
  | "skipped_no_open"
  | "skipped_inactive"
  /** Stats de abertura ausentes mesmo após a janela de tolerância — não dá
   * pra avaliar "abriu pelo menos 1 edição" sem dado; desiste de propósito
   * (terminal), nunca envia às cegas. */
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
  /**
   * #6158: `messageId`/`batchId` (UUIDv4) devolvido pela Brevo no POST
   * `/smtp/email` — só existe porque o envio agora vai com `scheduledAt`
   * (ver `onboarding-welcome-run.ts`). Formato cancelável via
   * `DELETE /v3/smtp/email/{id}` (`brevoDelete`), diferente do antigo
   * messageId de envio imediato (`...@smtp-relay.mailin.fr`), que a Brevo
   * nunca aceita nesse endpoint. `null` = ainda não enviado, ou a Brevo não
   * devolveu id (nunca bloqueia o envio em si).
   */
  email1_brevo_id: string | null;
  /** ISO — quando o e-mail 2 transacional saiu (null = ainda não). */
  email2_sent_at: string | null;
  /** #6158 — mesma semântica de `email1_brevo_id`, para o e-mail 2 (D+3). */
  email2_brevo_id: string | null;
  email3_state: OnboardingEmail3State;
  /** Id da campanha Brevo (rascunho) que continha este contato no D+10. */
  email3_campaign_id: number | null;
  /** ISO — quando o destino do e-mail 3 foi decidido (qualquer branch). */
  email3_decided_at: string | null;
  /**
   * #7674: rótulo da recuperação MANUAL que criou esta entrada (ex.:
   * `"#7665"`, `"#7675"`), gravado pelo modo dirigido de
   * `onboarding-welcome-run.ts`. Ausente/`null` = entrada nasceu da
   * detecção automática, o caso normal.
   *
   * Existe para que uma auditoria posterior consiga separar as duas
   * origens: sem isto, uma coorte semeada à mão fica indistinguível de
   * uma detectada, e qualquer medição de "quantos o onboarding alcançou
   * sozinho" passa a contar recuperação manual como detecção.
   */
  seeded_by?: string | null;
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
  /**
   * #7599: qual backend gerou `last_detection_cursor` — Beehiiv (`created`,
   * epoch segundos) e Kit (`created_at`, ISO convertido) não são
   * garantidamente comparáveis no mesmo relógio/base. Uma troca de backend
   * (ex: Beehiiv → Kit em 04/09/2026) precisa re-bootstrapar o cursor —
   * nunca reusar um valor calculado sob a fonte antiga, que é exatamente o
   * tipo de erro silencioso que causou o #6043 (585 e-mails retroativos).
   * `null`/ausente = store criado antes deste campo existir; tratado como
   * "backend desconhecido" (força bootstrap na 1ª leitura pós-upgrade).
   */
  last_detection_backend?: "beehiiv" | "kit" | null;
  /**
   * #7599: rodadas `--send` consecutivas (não-bootstrap, não
   * `--cancel-pending`) com `detected_new === 0` — alimenta o alarme de
   * "detecção zerada" (`zeroDetectionAlarm` em `onboarding-state.ts`). Zera
   * a qualquer detecção > 0.
   */
  consecutive_zero_detections?: number;
}

export function emptyStore(): OnboardingStore {
  return {
    version: 1,
    last_detection_cursor: null,
    d10_brevo_list_id: null,
    entries: {},
    last_detection_backend: null,
    consecutive_zero_detections: 0,
  };
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
        last_detection_backend: raw.last_detection_backend ?? null,
        consecutive_zero_detections: raw.consecutive_zero_detections ?? 0,
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
