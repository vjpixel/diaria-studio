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
import type { OnboardingKitLot, KitSendRunRecord } from "./onboarding-kit-transport.ts";
import { withFileLock } from "./file-lock.ts";

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
  /**
   * Chave do mapa `entries`. **A semântica muda conforme o backend vigente
   * quando a entrada nasceu**: entradas criadas sob a Beehiiv guardam
   * `sub_c32a8dc4-...`; as criadas sob o Kit (desde #7599) guardam o id
   * numérico do Kit como string. Nada no tipo distingue as duas — por isso
   * existe `kit_subscriber_id` abaixo.
   */
  subscription_id: string;
  /**
   * #7670: id numérico do Kit, resolvido PELO E-MAIL quando
   * `subscription_id` é um id legado da Beehiiv.
   *
   * Cache, não fonte de verdade: existe só pra não repetir o lookup por
   * e-mail em toda rodada. A chave do mapa e `subscription_id` continuam
   * intocados — rekeyar o store é migração, não efeito colateral de um
   * refresh diário.
   *
   * Ausente = ou a entrada já nasceu com id do Kit em `subscription_id`, ou
   * o refresh ainda não rodou pra ela.
   */
  kit_subscriber_id?: number;
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
   *
   * Sem `| null` de propósito (achado do review da PR #7683): nenhum
   * produtor grava `null` — a detecção automática simplesmente não escreve
   * o campo, e a semeadura só escreve string não-vazia (`planSeed` recusa
   * `seededBy` em branco). Admitir `null` no tipo criaria um terceiro
   * estado inalcançável, convidando consumidores a distinguir
   * `=== undefined` de `== null` sem que a diferença exista.
   */
  seeded_by?: string;
  /**
   * #9015: proveniência EXPLÍCITA da escada — qual transporte é dono do
   * e-mail 1 (e, por consequência, do e-mail 2: "termina no transporte onde
   * começou"). Gravado no momento do envio (`applySendResult` → `"brevo"`,
   * `applyKitLotToEntries` → `"kit"`) e da semeadura (seeds são sempre
   * continuação da escada Brevo → `"brevo"`).
   *
   * Antes a proveniência era INFERIDA de `email1_brevo_id != null`, o que
   * errava para entradas semeadas (`email1_brevo_id: null` por construção)
   * e para envios Brevo cujo id veio nulo / foi zerado por
   * `--cancel-pending` — todas tratadas como "do Kit" no e-mail 2, sem que
   * nenhum dos dois lados enviasse. Ausente = entrada anterior a este campo;
   * `ownerTransportFor` resolve isso para `"brevo"` (o Kit nunca gravou
   * `email1_sent_at` antes do #9014, então todo e-mail 1 legado é Brevo).
   */
  email1_transport?: "brevo" | "kit";
  /**
   * #9014: `lot_id` do lote Kit que serviu o e-mail 1/2 desta entrada —
   * gravado junto com `email{1,2}_sent_at` quando o broadcast é
   * `scheduled`/`completed` (#9060 item 3: `created` — rascunho ainda não
   * agendado — NÃO grava; ver `applyKitLotToEntries`), e usado pra desfazer exatamente
   * essa marcação se o lote for cancelado depois (`--cancel-lot`).
   */
  email1_kit_lot_id?: string;
  email2_kit_lot_id?: string;
  /**
   * #9059: `lot_id` do lote Kit de e-mail 3 que levou esta entrada a
   * `email3_state = "campaign_created"` (rascunho Kit criado). Usado pra
   * desfazer exatamente essa decisão se o lote for cancelado depois
   * (`--cancel-lot` → `email3_state` volta a `pending`). Ausente = decisão do
   * e-mail 3 não veio de um lote Kit (Brevo, skip, ou ainda pendente).
   */
  email3_kit_lot_id?: string;
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

  /**
   * #7665: ISO da última rodada `--send` que de fato EXECUTOU e atualizou
   * `consecutive_zero_detections`. Existe pro alarme de continuidade
   * (`onboarding-continuity-alarm.ts`) distinguir "a rodada rodou e detectou
   * zero" de "a rodada parou de rodar".
   *
   * Sem este campo, a streak congela quando o run para (timer desarmado,
   * crash, guard abortando por `data/` ausente) — e congelada ABAIXO do
   * limiar, o alarme reportaria `ok` pra sempre, ficando mudo exatamente
   * quando a situação é pior. Era o achado P1/alta do review da PR #7805, e
   * é a mesma classe do #7776 um nível acima: o detector precisa saber se
   * ele próprio ainda está sendo alimentado.
   *
   * Ausente (store anterior a este campo) → o alarme responde
   * `cannot-verify`, nunca `ok`.
   */
  last_zero_detection_run_at?: string | null;

  /**
   * #7922 (fatia 1/N): estado dos LOTES de transporte Kit (broadcasts
   * segmentados por tag) — reusa este mesmo store por decisão explícita da
   * issue ("integrar com a base de #7916, sem criar outra fonte de
   * verdade"), em vez de um arquivo próprio. Chave = `lot_id`
   * (`onboarding-kit-transport.ts` → `buildLotId`). Ausente/`undefined` =
   * store criado antes deste campo existir, ou o transporte Kit nunca rodou
   * — tratado como "nenhum lote" (`{}`), nunca como erro.
   */
  kit_transport?: {
    lots: Record<string, OnboardingKitLot>;
    /**
     * #7922 (pré-requisito do corte, §3 de docs/onboarding-kit-cutover.md):
     * última rodada `--send` NÃO-piloto do executor Kit — quando rodou e
     * quantos lotes criou/falhou. É o par Kit do `last_zero_detection_run_at`:
     * permite ao alarme de continuidade distinguir "o executor Kit rodou e
     * deu certo" de "parou de rodar" e de "roda mas não consegue criar o
     * broadcast". Ausente = executor Kit nunca rodou `--send` com este campo
     * (store anterior, ou kill switch ainda desligado) — o alarme responde
     * `cannot-verify`, nunca `ok`. Gravado só pelo executor Kit
     * (`stampKitSendRun`, sob o lock do store); dry-run nunca grava.
     */
    last_send_run?: KitSendRunRecord | null;
    /** #7922: rodadas `--send` consecutivas com ≥1 lote que falhou ao
     *  criar/taguear/agendar o broadcast. Zera numa rodada sem falha. */
    consecutive_failed_send_runs?: number;
  };
}

export function emptyStore(): OnboardingStore {
  return {
    version: 1,
    last_detection_cursor: null,
    d10_brevo_list_id: null,
    entries: {},
    last_detection_backend: null,
    consecutive_zero_detections: 0,
    last_zero_detection_run_at: null,
    kit_transport: { lots: {} },
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
        // `?? null` e NÃO um default de "agora": store antigo genuinamente
        // não sabe quando rodou, e fingir frescor aqui seria exatamente o
        // `ok` mentiroso que o campo existe pra impedir.
        last_zero_detection_run_at: raw.last_zero_detection_run_at ?? null,
        // #7922: store anterior ao transporte Kit não tem este bloco —
        // normaliza pra "nenhum lote" em vez de deixar `undefined` vazar
        // para callers que assumem `.lots` sempre presente.
        kit_transport: {
          lots: raw.kit_transport?.lots ?? {},
          // #7922: sinais de saúde do executor Kit — só propagados quando
          // presentes (store anterior não ganha campo fabricado; `?? null`
          // seria um "nunca rodou" que o disco não disse).
          ...(raw.kit_transport?.last_send_run != null ? { last_send_run: raw.kit_transport.last_send_run } : {}),
          ...(raw.kit_transport?.consecutive_failed_send_runs != null
            ? { consecutive_failed_send_runs: raw.kit_transport.consecutive_failed_send_runs }
            : {}),
        },
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

// ---------------------------------------------------------------------------
// #9151: escrita do executor Brevo sob o MESMO lock do executor Kit
// ---------------------------------------------------------------------------

/** Campos de topo que o executor Brevo (`onboarding-welcome-run.ts`) é dono.
 *  `kit_transport` NUNCA está aqui: é do executor Kit e sempre vem do disco. */
const BREVO_OWNED_TOP_LEVEL = [
  "last_detection_cursor",
  "last_detection_backend",
  "consecutive_zero_detections",
  "last_zero_detection_run_at",
  "d10_brevo_list_id",
] as const;

/** Clone profundo do store — o baseline que `mergeStoreDelta` usa pra saber
 *  o que a rodada Brevo de fato mudou. JSON round-trip basta (store é JSON). */
export function cloneStore(store: OnboardingStore): OnboardingStore {
  return JSON.parse(JSON.stringify(store)) as OnboardingStore;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface StoreMergeConflict {
  subscription_id: string;
  field: string;
}

/**
 * #9151: aplica sobre o store FRESCO do disco (`fresh`) só o DELTA que a
 * rodada Brevo produziu (`updated` vs. `baseline`, o snapshot lido no início
 * do `main()`).
 *
 * Antes deste fix o executor Brevo regravava o snapshot inteiro do início da
 * rodada — minutos depois, por causa do refresh de rede por candidato — sem
 * lock. Um `--send`/`--reconcile` do executor Kit que gravasse
 * `kit_transport.lots` + `email{1,2}_sent_at` nessa janela era apagado, e no
 * `--send` seguinte a mesma pessoa recebia o e-mail 1/2 de novo.
 *
 * Regras:
 *  - `kit_transport` vem sempre de `fresh` (nunca do snapshot Brevo).
 *  - campo de topo do Brevo (`BREVO_OWNED_TOP_LEVEL`) só é aplicado se a
 *    rodada o mudou em relação ao baseline.
 *  - entry nova (ausente no baseline) é adicionada se ainda não existir no
 *    disco; se existir (outro processo criou), vale o disco.
 *  - entry existente: só os campos que a rodada mudou são aplicados, por
 *    cima do que o disco tem hoje. Campo que a rodada mudou E que o disco
 *    também mudou pra um valor diferente é reportado em `conflicts` — a
 *    escrita Brevo vence (registra um envio/decisão que aconteceu de fato),
 *    mas o caller avisa em stderr.
 *
 * Sem I/O — mas MUTA e devolve `fresh` (não é pura).
 */
export function mergeStoreDelta(
  fresh: OnboardingStore,
  baseline: OnboardingStore,
  updated: OnboardingStore,
): { store: OnboardingStore; conflicts: StoreMergeConflict[] } {
  const conflicts: StoreMergeConflict[] = [];
  const freshRec = fresh as unknown as Record<string, unknown>;
  const baseRec = baseline as unknown as Record<string, unknown>;
  const updRec = updated as unknown as Record<string, unknown>;
  for (const key of BREVO_OWNED_TOP_LEVEL) {
    if (!sameValue(baseRec[key], updRec[key])) freshRec[key] = updRec[key];
  }
  for (const [id, updEntry] of Object.entries(updated.entries)) {
    const baseEntry = baseline.entries[id];
    const freshEntry = fresh.entries[id];
    if (baseEntry == null) {
      if (freshEntry == null) fresh.entries[id] = updEntry;
      // Outro processo criou a mesma entry durante a rodada: vale o disco,
      // mas avisa — um envio desta rodada pode não ficar registrado.
      else if (!sameValue(freshEntry, updEntry)) conflicts.push({ subscription_id: id, field: "*entry_nova_ja_no_disco" });
      continue;
    }
    if (freshEntry == null) {
      // Removida do disco por outro processo depois da leitura — nenhum
      // caminho do repo remove entry hoje; recoloca a versão da rodada em vez
      // de perder o registro de um envio que pode ter acontecido.
      fresh.entries[id] = updEntry;
      continue;
    }
    const baseE = baseEntry as unknown as Record<string, unknown>;
    const updE = updEntry as unknown as Record<string, unknown>;
    const freshE = freshEntry as unknown as Record<string, unknown>;
    const keys = new Set([...Object.keys(baseE), ...Object.keys(updE)]);
    for (const k of keys) {
      if (sameValue(baseE[k], updE[k])) continue;
      if (!sameValue(freshE[k], baseE[k]) && !sameValue(freshE[k], updE[k])) {
        conflicts.push({ subscription_id: id, field: k });
      }
      if (updE[k] === undefined) delete freshE[k];
      else freshE[k] = updE[k];
    }
  }
  return { store: fresh, conflicts };
}

function readStoreOrThrow(storePath: string, contexto: string): OnboardingStore {
  const { store, corrupted } = readStore(storePath);
  if (corrupted) {
    throw new Error(
      `[onboarding-store] store em "${storePath}" está CORROMPIDO (JSON ilegível) — recusando ${contexto} sobre um ` +
        `snapshot que "readStore" já esvaziou silenciosamente. Repare/restaure o store antes de rodar de novo.`,
    );
  }
  return store;
}

/**
 * #9151 (review da PR #9181, achados 1+2): relê o store do disco sob o lock
 * logo ANTES do executor Brevo enviar. Serve a dois fins: (a) o plano pode
 * ser refiltrado contra o que o Kit gravou durante a rodada
 * (`dropActionsCoveredOnDisk`); (b) lock preso (órfão) ou store corrompido
 * falham AQUI, antes de qualquer envio — nunca depois, quando a gravação
 * falharia e o próximo `--send` reenviaria.
 */
export function readStoreUnderLock(storePath: string, timeoutMs = 30_000): OnboardingStore {
  return withFileLock(`${storePath}.lock`, () => readStoreOrThrow(storePath, "decidir o envio Brevo"), timeoutMs);
}

/**
 * #9151: persiste o resultado de uma rodada do executor Brevo sob
 * `withFileLock(${storePath}.lock)` — o MESMO lock que `claimLot`/
 * `persistLotUpdate`/`backfillTerminalLotEntries` do executor Kit usam —,
 * relendo o disco dentro do lock e aplicando só o delta
 * (`mergeStoreDelta`). Store corrompido no disco → lança (mesma classe do
 * guard do lado Kit: nunca sobrescrever um arquivo que `readStore` esvaziou).
 */
export function persistStoreDelta(
  storePath: string,
  baseline: OnboardingStore,
  updated: OnboardingStore,
  timeoutMs = 30_000,
): StoreMergeConflict[] {
  return withFileLock(
    `${storePath}.lock`,
    () => {
      const fresh = readStoreOrThrow(storePath, "persistir a rodada Brevo");
      const { store, conflicts } = mergeStoreDelta(fresh, baseline, updated);
      writeStore(store, storePath);
      return conflicts;
    },
    timeoutMs,
  );
}
