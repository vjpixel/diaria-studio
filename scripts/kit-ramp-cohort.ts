#!/usr/bin/env node
/**
 * scripts/kit-ramp-cohort.ts (#6507)
 *
 * Script único para as DUAS pontas de uma onda da migração Beehiiv → Kit
 * (#461/#6048): tagueia a coorte no Kit e desativa a mesma coorte na
 * Beehiiv. As Ondas 0 e 1 (28/08/2026, 92 pessoas — ver
 * `platform.config.json` → `kit_diaria.audience_tag_note`) foram feitas à
 * mão, com chamadas ad-hoc; este script formaliza esse procedimento pra
 * repeti-lo com registro e sem depender de disciplina manual do operador.
 *
 * ## O invariante que este script garante
 *
 * **Quem está na tag do Kit NÃO pode estar ativo na Beehiiv** — senão a
 * pessoa recebe a edição duas vezes (`kit_diaria.audience_tag_note`). Hoje
 * isso é disciplina do operador, não guard de código — este script troca
 * isso por um guard mecânico: `decideBeehiivDeactivateAction` só permite
 * desativar na Beehiiv depois que a tag do Kit foi CONFIRMADA por releitura
 * pós-escrita para aquele e-mail específico.
 *
 * ## Ordem importa — falha para o lado do duplicado, nunca do lado vazio
 *
 * Taguear no Kit PRIMEIRO, desativar na Beehiiv DEPOIS, sempre em duas fases
 * (`applyCohortWave`): Fase A tagueia (e verifica) TODA a coorte no Kit;
 * Fase B só então decide, PARA CADA E-MAIL, se desativa na Beehiiv — usando
 * o resultado REAL (não o planejado) da Fase A daquele e-mail específico.
 * Se a tag falhar (ou a releitura não confirmar) para um e-mail, aquele
 * e-mail é PULADO na Fase B — nunca desativado sem canal nenhum. A falha
 * possível, por design, é "recebe duplicado até o operador re-rodar", nunca
 * "some da lista".
 *
 * ## `--dry-run` NUNCA muta (default)
 *
 * Diferente de `createOrUpdateSubscriber` (POST, upsert — cria se ausente),
 * o dry-run usa `findKitSubscriberByEmail` (GET, leitura pura) pra checar se
 * a pessoa já existe no Kit — nunca cria um subscriber novo só por estar
 * planejando. `--push` é quem de fato chama `createOrUpdateSubscriber`/
 * `tagSubscriber`/o PUT de unsubscribe na Beehiiv.
 *
 * ## Releitura pós-escrita nas duas pontas (#573)
 *
 * Kit: `POST /tags/{id}/subscribers/{id}` responde 2xx mesmo quando a
 * listagem por tag não reflete por ~180s (armadilha #6181/#6183 documentada
 * em `kit-client.ts`) — por isso a verificação AQUI nunca usa
 * `GET /tags/{id}/subscribers` (que mente sobre completude logo após
 * taguear), e sim a direção inversa, `GET /subscribers/{id}/tags`, que
 * reflete a mutação imediatamente (mesma nota do módulo citado).
 * Beehiiv: reread via `GET .../subscriptions/by_email/{email}` depois do
 * PUT `{unsubscribe:true}` — mesma disciplina de `sync-apoio-nivel-beehiiv.ts`/
 * `sunset-dead-subscribers.ts` (a API já aceitou uma escrita ignorada em
 * silêncio com 200 no passado).
 *
 * ## Guard de blast radius
 *
 * Mesmo padrão/limiar (30%, `--force-blast-radius` como escape hatch
 * explícito, sempre logado) de `sync-apoio-nivel-brevo.ts` (#4572) —
 * denominador aqui é quantos assinantes estão ATIVOS hoje na Beehiiv
 * (`fetchCurrentBeehiivState`, reusado de `sync-apoio-nivel-beehiiv.ts`).
 *
 * ## `--audit` — o invariante, verificável a qualquer momento sem side-effect
 *
 * Lê a membresia atual da tag no Kit (`GET /tags/{id}/subscribers` —
 * aceitável aqui porque uma auditoria roda INDEPENDENTE de uma tagueação
 * recente, então o atraso de propagação de ~180s da listagem não se aplica
 * — diferente da verificação pós-escrita da Fase A, que por isso usa a
 * direção inversa) contra os ativos da Beehiiv, e reporta a interseção —
 * quem está nos DOIS lugares ao mesmo tempo. Reusa `toNormalizedEmailSet`/
 * `maskEmail` de `beehiiv-kit-reconcile.ts` (#6269), mesma disciplina de
 * comparar CONJUNTOS (não contagens) e nunca imprimir e-mail cru no
 * relatório de auditoria.
 *
 * ## Entrada
 *
 * `--input <arquivo>` — um e-mail por linha (linhas vazias e começando com
 * `#` são ignoradas). Critério programático (ex: "quem engajou no broadcast
 * X") fica FORA de escopo deste script — a Onda 1 já foi montada assim
 * externamente (via export ad-hoc) e alimentada aqui como arquivo; um
 * seletor de critério embutido é trabalho futuro, não decidido aqui.
 *
 * Uso:
 *   npx tsx scripts/kit-ramp-cohort.ts --input data/kit-ramp/onda-2.txt                         # dry-run (default)
 *   npx tsx scripts/kit-ramp-cohort.ts --input data/kit-ramp/onda-2.txt --push                   # executa
 *   npx tsx scripts/kit-ramp-cohort.ts --input data/kit-ramp/onda-2.txt --tag rampa-kit-onda-2   # tag custom
 *   npx tsx scripts/kit-ramp-cohort.ts --audit                                                   # só o invariante, read-only
 *   npx tsx scripts/kit-ramp-cohort.ts --audit --tag rampa-kit
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { resolveKitConfig, type KitConfig } from "./lib/kit-config.ts";
import { resolveBeehiivConfig, beehiivApiBase, type BeehiivConfig } from "./lib/beehiiv-config.ts";
import { kitFetch } from "./lib/kit-client.ts";
import type { KitPagination } from "./lib/kit-client.ts";
import { createOrUpdateSubscriber, type KitSubscriberSummary } from "./lib/kit-subscribers.ts";
import { tagSubscriber, findTagIdByName } from "./lib/kit-broadcasts.ts";
import { resolveAudienceTagId } from "./lib/kit-diaria-channel.ts";
import { fetchCurrentBeehiivState } from "./sync-apoio-nivel-beehiiv.ts";
import { toNormalizedEmailSet, maskEmail } from "./lib/beehiiv-kit-reconcile.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[kit-ramp-cohort]";

/**
 * Espaçamento entre chamadas SINGULARES ao Kit na Fase A de `applyCohortWave`
 * (buscar/criar → tag → releitura, até 3 chamadas por endereço). Mesma
 * constante/racional de `kit-gmail-warmup-ramp.ts` (`KIT_CALL_SPACING_MS`,
 * ver a docstring lá — armadilha #6047: endpoints singulares do Kit toleram
 * só dezenas de chamadas sequenciais antes de 429). Portado aqui pelo #7392
 * depois de uma medição ao vivo (03-04/09/2026, migração #7386): 318
 * operações sem espaçamento tomaram 31 falhas 429 (até 16,7% num lote de
 * 36) — o `try/catch` por e-mail evitou corrupção, mas cada 429 virou
 * resíduo exigindo uma varredura extra pra limpar.
 */
const KIT_CALL_SPACING_MS = 350;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Mesmo limiar/semântica de `sync-apoio-nivel-brevo.ts` (#4572/#4436) — ver
 *  docstring do módulo. "Passar de" é estrito: exatamente no limiar não
 *  bloqueia. */
export const KIT_RAMP_BLAST_RADIUS_THRESHOLD = 0.3;

// ── entrada (pura) ──────────────────────────────────────────────────────

/**
 * Pure: parseia o arquivo de e-mails — um por linha, `#`/linha vazia
 * ignorados, normaliza (trim + lowercase) e deduplica preservando a 1ª
 * ocorrência de cada e-mail.
 */
export function parseEmailListFile(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const email = trimmed.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

// ── guard de blast radius (pura) ────────────────────────────────────────

export interface KitRampBlastRadiusGuardResult {
  blocked: boolean;
  cohortSize: number;
  currentActiveBeehiivCount: number;
  ratio: number;
}

/**
 * Pure: recusa o `--push` inteiro quando a coorte excede
 * `KIT_RAMP_BLAST_RADIUS_THRESHOLD` (30%) de quem está ATIVO hoje na
 * Beehiiv — mesmo racional de `evaluateBrevoBlastRadiusGuard`
 * (`sync-apoio-nivel-brevo.ts`), denominador adaptado (aqui é sempre a
 * desativação Beehiiv o lado "removido"). `force` é o escape hatch
 * explícito (`--force-blast-radius`), sempre logado pelo caller.
 */
export function evaluateKitRampBlastRadiusGuard(
  cohortSize: number,
  currentActiveBeehiivCount: number,
  force: boolean,
): KitRampBlastRadiusGuardResult {
  const ratio = currentActiveBeehiivCount > 0 ? cohortSize / currentActiveBeehiivCount : 0;
  const blocked = !force && ratio > KIT_RAMP_BLAST_RADIUS_THRESHOLD;
  return { blocked, cohortSize, currentActiveBeehiivCount, ratio };
}

// ── decisão de ordem (pura) — o coração do invariante ───────────────────

export type KitTagStep = "noop" | "tag_existing" | "create_and_tag";

/**
 * Pure: decide o que fazer do lado Kit pra 1 e-mail, a partir de leitura
 * read-only prévia. `existedInKit=false` nunca implica pular — implica
 * CRIAR (o cadastro precisa existir pra receber a tag), mas isso só
 * acontece de fato em `--push` (ver `applyCohortWave`); em dry-run o
 * caller reporta esta decisão sem executá-la.
 */
export function decideKitTagStep(input: { existedInKit: boolean; alreadyTagged: boolean }): KitTagStep {
  if (input.alreadyTagged) return "noop";
  return input.existedInKit ? "tag_existing" : "create_and_tag";
}

export type BeehiivDeactivateAction = "deactivate" | "skip_kit_unconfirmed" | "skip_not_active_beehiiv";

/**
 * Pure: decide se desativa na Beehiiv — **o invariante de ordem do #6507**.
 * Nunca desativa sem a tag do Kit CONFIRMADA (`kitTagConfirmed`, resultado
 * REAL de releitura pós-escrita, não a intenção); nunca desativa quem já
 * não está ativo lá (idempotência — nada a fazer).
 */
export function decideBeehiivDeactivateAction(input: {
  kitTagConfirmed: boolean;
  beehiivActive: boolean;
}): BeehiivDeactivateAction {
  if (!input.kitTagConfirmed) return "skip_kit_unconfirmed";
  if (!input.beehiivActive) return "skip_not_active_beehiiv";
  return "deactivate";
}

// ── auditoria / divergência (pura) — o invariante, sem side-effect ─────

export interface KitRampDivergenceResult {
  kitTaggedCount: number;
  beehiivActiveCount: number;
  /** Normalizado, ordenado — e-mails presentes nos DOIS conjuntos ao mesmo
   *  tempo. Vazio = invariante ok. */
  divergent: string[];
}

/**
 * Pure: compara o conjunto de e-mails tagueados no Kit contra o conjunto de
 * e-mails ativos na Beehiiv — a interseção é a violação do invariante
 * ("quem está na tag do Kit NÃO pode estar ativo na Beehiiv"). Mesma
 * disciplina de `reconcileEmailSets` (#6269): compara CONJUNTOS, nunca
 * contagens.
 */
export function computeKitRampDivergence(
  kitTaggedEmailsRaw: readonly string[],
  beehiivActiveEmailsRaw: readonly string[],
): KitRampDivergenceResult {
  const kitSet = toNormalizedEmailSet(kitTaggedEmailsRaw);
  const beehiivSet = toNormalizedEmailSet(beehiivActiveEmailsRaw);
  const divergent: string[] = [];
  for (const email of kitSet) {
    if (beehiivSet.has(email)) divergent.push(email);
  }
  divergent.sort();
  return { kitTaggedCount: kitSet.size, beehiivActiveCount: beehiivSet.size, divergent };
}

// ── resultado por e-mail + resumo (pura) ────────────────────────────────

export interface CohortEmailResult {
  email: string;
  existedInKit: boolean;
  kitTagAlreadyPresent: boolean;
  /** `true` só se esta execução (`--push`) de fato chamou a mutação Kit. */
  kitTagApplied: boolean;
  /** Resultado REAL (já-presente OU aplicada-e-confirmada por releitura). */
  kitTagConfirmed: boolean;
  kitError?: string;
  beehiivWasActive: boolean;
  beehiivAction: BeehiivDeactivateAction;
  /** `true` só se esta execução (`--push`) de fato chamou a mutação Beehiiv. */
  beehiivApplied: boolean;
  /** `true` quando não havia mutação a confirmar (ação != "deactivate"), OU
   *  quando é dry-run (nada foi tentado ainda — não é falha), OU quando a
   *  mutação foi de fato aplicada (`--push`) e a releitura confirmou. */
  beehiivConfirmed: boolean;
  beehiivError?: string;
}

export interface CohortRunSummary {
  total: number;
  kitTagged: number;
  kitTagFailed: number;
  beehiivDeactivated: number;
  beehiivDeactivateFailed: number;
  skippedKitUnconfirmed: number;
  skippedNotActiveBeehiiv: number;
  /** Tagueado no Kit E ainda ativo na Beehiiv ao FIM desta rodada — a
   *  violação do invariante que sobrou (falha de desativação, ou skip por
   *  outro motivo). Zero é o resultado esperado de uma rodada `--push`
   *  bem-sucedida. */
  residualDivergence: number;
}

/** Pure: tabula `CohortEmailResult[]` num resumo — "Relatório final" pedido
 *  pela issue #6507 (quantos tagueados, quantos desativados, divergência). */
export function summarizeCohortResults(results: readonly CohortEmailResult[]): CohortRunSummary {
  let kitTagged = 0;
  let kitTagFailed = 0;
  let beehiivDeactivated = 0;
  let beehiivDeactivateFailed = 0;
  let skippedKitUnconfirmed = 0;
  let skippedNotActiveBeehiiv = 0;
  let residualDivergence = 0;

  for (const r of results) {
    if (r.kitTagConfirmed) kitTagged++;
    else kitTagFailed++;

    if (r.beehiivAction === "deactivate") {
      if (r.beehiivConfirmed) beehiivDeactivated++;
      else beehiivDeactivateFailed++;
    } else if (r.beehiivAction === "skip_kit_unconfirmed") {
      skippedKitUnconfirmed++;
    } else {
      skippedNotActiveBeehiiv++;
    }

    const stillActiveInBeehiiv = r.beehiivWasActive && !(r.beehiivAction === "deactivate" && r.beehiivConfirmed);
    if (r.kitTagConfirmed && stillActiveInBeehiiv) residualDivergence++;
  }

  return {
    total: results.length,
    kitTagged,
    kitTagFailed,
    beehiivDeactivated,
    beehiivDeactivateFailed,
    skippedKitUnconfirmed,
    skippedNotActiveBeehiiv,
    residualDivergence,
  };
}

// ── I/O — Kit ────────────────────────────────────────────────────────────

interface KitSubscribersByEmailResponse {
  subscribers?: KitSubscriberSummary[];
}

/**
 * `GET /v4/subscribers?email_address=...` — leitura PURA, nunca cria.
 * "não encontrado" é 200 com array vazio, não 404 (confirmado ao vivo em
 * `verifySubscriberViaKitByEmail`, `scripts/lib/shared/subscriber-verify.ts`).
 * Existe pra permitir checar "esta pessoa já é subscriber no Kit?" sem o
 * efeito colateral de criação que `createOrUpdateSubscriber` (POST, upsert)
 * sempre tem — essencial pro `--dry-run` nunca mutar (ver docstring do
 * módulo).
 */
export async function findKitSubscriberByEmail(
  email: string,
  config: KitConfig,
): Promise<KitSubscriberSummary | null> {
  const data = await kitFetch<KitSubscribersByEmailResponse>(
    `/subscribers?email_address=${encodeURIComponent(email)}`,
    { config },
  );
  return data.subscribers?.[0] ?? null;
}

interface KitSubscriberTagsResponse {
  tags?: { id: number; name: string; created_at: string }[];
}

/**
 * `GET /v4/subscribers/{id}/tags` — direção que NÃO tem o atraso de
 * propagação documentado em `kit-client.ts` (ao contrário de
 * `GET /tags/{id}/subscribers`, que mente sobre completude por ~180s logo
 * após taguear). Usado tanto pro pre-check de idempotência (Fase A) quanto
 * pra releitura pós-escrita (#573) — nunca confiar só no 2xx do
 * `POST /tags/{id}/subscribers/{id}`.
 */
export async function fetchSubscriberTagIds(subscriberId: number, config: KitConfig): Promise<Set<number>> {
  const data = await kitFetch<KitSubscriberTagsResponse>(`/subscribers/${subscriberId}/tags`, { config });
  return new Set((data.tags ?? []).map((t) => t.id));
}

interface KitTagSubscribersResponse {
  subscribers?: { id: number; email_address: string }[];
  pagination?: KitPagination;
}

/**
 * `GET /v4/tags/{id}/subscribers`, paginado. **Só usar pra auditoria
 * independente** (`--audit`) — logo após taguear alguém, esta listagem
 * pode ficar ~180s sem refletir a mutação, e `has_next_page: false` mente
 * como se a lista estivesse completa (armadilha #6181, ver `kit-client.ts`).
 * A verificação pós-escrita da Fase A usa a direção inversa
 * (`fetchSubscriberTagIds`) por causa exatamente disso.
 */
export async function listAllSubscribersForTag(tagId: number, config: KitConfig): Promise<string[]> {
  const out: string[] = [];
  let after: string | undefined;
  for (;;) {
    const params = new URLSearchParams({ per_page: "500" });
    if (after) params.set("after", after);
    const data = await kitFetch<KitTagSubscribersResponse>(`/tags/${tagId}/subscribers?${params.toString()}`, {
      config,
    });
    for (const s of data.subscribers ?? []) {
      if (s.email_address) out.push(s.email_address);
    }
    if (!data.pagination?.has_next_page || !data.pagination.end_cursor) break;
    after = data.pagination.end_cursor;
  }
  return out;
}

// ── I/O — Beehiiv (reimplementado, não importado — mesma disciplina de
//    `cleanup-preflight-subscribers.ts`/`sunset-dead-subscribers.ts`: cada
//    script de mutação Beehiiv reimplementa este PUT minúsculo em vez de
//    puxar um módulo alheio, evitando acoplamento entre scripts sem relação
//    editorial entre si) ───────────────────────────────────────────────────

/** `PUT .../subscriptions/by_email/{email}` com `{unsubscribe:true}` — nunca
 *  `DELETE` (preserva histórico do registro, mesma nota de todos os
 *  scripts-irmãos acima). */
export async function unsubscribeFromBeehiiv(
  publicationId: string,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(
    `${beehiivApiBase()}/publications/${publicationId}/subscriptions/by_email/${encodeURIComponent(email)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ unsubscribe: true }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Beehiiv API PUT subscriptions/by_email/${email} (unsubscribe:true) falhou (HTTP ${res.status}): ${text}`,
    );
  }
}

/** `GET .../subscriptions/by_email/{email}` — `null` = 404 (nunca
 *  cadastrado/já removido). Mesmo padrão de leitura Beehiiv usado em outros
 *  scripts deste repo (`evaluate-brevo-diaria.ts`) — `cleanup-preflight-
 *  subscribers.ts` migrou pro Kit no #7359, não é mais a referência Beehiiv
 *  pra este tipo de leitura. */
export async function fetchBeehiivStatus(
  publicationId: string,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const res = await fetchImpl(
    `${beehiivApiBase()}/publications/${publicationId}/subscriptions/by_email/${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Beehiiv API ${res.status} em subscriptions/by_email/${email}`);
  const body = (await res.json()) as { data?: { status?: string } };
  return body.data?.status ?? null;
}

/**
 * Aplica o unsubscribe e verifica por RELEITURA (#573) — nunca confia só no
 * 2xx do PUT (a mesma armadilha do endpoint de tags da Beehiiv já mordeu
 * outros scripts deste repo, ver `sync-apoio-nivel-beehiiv.ts`).
 */
export async function deactivateAndVerify(
  publicationId: string,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; error?: string }> {
  // A releitura de confirmação fica DENTRO do mesmo try que o PUT — não só
  // ele — pra que uma falha aqui (rede, 5xx, JSON malformado) resolva pra
  // {ok:false}, nunca lance (fleet review, #6507): sem isso, o loop da Fase
  // B em applyCohortWave (sem try/catch próprio) deixava a exceção
  // propagar, abortando a rodada inteira sem nunca chegar em
  // formatCohortReport — perdendo o relatório de todo mundo já processado,
  // inclusive de e-mails cujo PUT de desativação já tinha sido aceito.
  try {
    await unsubscribeFromBeehiiv(publicationId, apiKey, email, fetchImpl);
    const status = await fetchBeehiivStatus(publicationId, apiKey, email, fetchImpl);
    if (status === "active") {
      return { ok: false, error: `releitura pós-escrita NÃO confirma: status ainda "active" para ${email}.` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── aplicação da coorte (I/O — wiring das duas fases) ───────────────────

export interface ApplyCohortWaveInput {
  emails: readonly string[];
  push: boolean;
  kitConfig: KitConfig;
  tagId: number;
  activeBeehiivEmails: ReadonlySet<string>;
  beehiivConfig: BeehiivConfig;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  /** Injetável só para teste (mock sem tempo real) — default é `sleep` real. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Aplica (ou planeja, em dry-run) a coorte inteira em DUAS FASES — Fase A
 * (Kit, toda a coorte) sempre termina antes da Fase B (Beehiiv) começar, e a
 * Fase B usa o resultado REAL de cada e-mail da Fase A (nunca a intenção) —
 * ver docstring do módulo sobre "ordem importa".
 */
export async function applyCohortWave(input: ApplyCohortWaveInput): Promise<CohortEmailResult[]> {
  const { emails, push, kitConfig, tagId, activeBeehiivEmails, beehiivConfig } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const log = input.log ?? (() => {});
  const sleepFn = input.sleepFn ?? sleep;

  interface KitOutcome {
    email: string;
    existedInKit: boolean;
    alreadyTagged: boolean;
    applied: boolean;
    confirmed: boolean;
    error?: string;
  }
  const kitOutcomes: KitOutcome[] = [];

  // Fase A — Kit: resolve + tagueia (ou planeja) TODA a coorte primeiro.
  // Espaçado por `KIT_CALL_SPACING_MS` antes de CADA chamada singular ao Kit
  // (exceto a 1ª de toda a rodada) — mesma granularidade de
  // `confirmTaggedEmails` em kit-gmail-warmup-ramp.ts, não só entre e-mails:
  // um único e-mail em `--push` já soma até 5 chamadas (find → fetchTags →
  // create/tag → confirm), e deixá-las em rajada dentro do e-mail reintroduz
  // o mesmo estouro de 429 que a espera entre e-mails sozinha não evita
  // (#7392, medido: 31/318 operações falharam sem nenhum espaçamento).
  let kitCallMade = false;
  const spaceBeforeKitCall = async (): Promise<void> => {
    if (kitCallMade) await sleepFn(KIT_CALL_SPACING_MS);
    kitCallMade = true;
  };

  for (const email of emails) {
    try {
      await spaceBeforeKitCall();
      const existing = await findKitSubscriberByEmail(email, kitConfig);
      const existedInKit = existing !== null;
      let currentTagIds = new Set<number>();
      if (existing) {
        await spaceBeforeKitCall();
        currentTagIds = await fetchSubscriberTagIds(existing.id, kitConfig);
      }
      const alreadyTagged = currentTagIds.has(tagId);
      const step = decideKitTagStep({ existedInKit, alreadyTagged });

      if (!push || step === "noop") {
        kitOutcomes.push({ email, existedInKit, alreadyTagged, applied: false, confirmed: alreadyTagged });
        continue;
      }

      let subscriberId: number;
      if (existing) {
        subscriberId = existing.id;
      } else {
        await spaceBeforeKitCall();
        subscriberId = (await createOrUpdateSubscriber({ email_address: email }, kitConfig)).id;
      }
      await spaceBeforeKitCall();
      await tagSubscriber(tagId, subscriberId, kitConfig);
      await spaceBeforeKitCall();
      const after = await fetchSubscriberTagIds(subscriberId, kitConfig);
      const confirmed = after.has(tagId);
      kitOutcomes.push({
        email,
        existedInKit,
        alreadyTagged,
        applied: true,
        confirmed,
        error: confirmed
          ? undefined
          : "releitura pós-escrita NÃO confirma a tag (POST 2xx mas GET /subscribers/{id}/tags não reflete) — ver armadilha #6181.",
      });
      if (!confirmed) log(`ERRO ao confirmar tag para ${email} no Kit — Beehiiv NÃO será tocada para este e-mail.`);
    } catch (e) {
      const message = (e as Error).message;
      kitOutcomes.push({ email, existedInKit: false, alreadyTagged: false, applied: false, confirmed: false, error: message });
      log(`ERRO ao taguear ${email} no Kit: ${message}`);
    }
  }

  const results: CohortEmailResult[] = [];

  // Fase B — Beehiiv: só desativa quem teve o Kit CONFIRMADO na Fase A.
  for (const ko of kitOutcomes) {
    const beehiivWasActive = activeBeehiivEmails.has(ko.email);
    const action = decideBeehiivDeactivateAction({ kitTagConfirmed: ko.confirmed, beehiivActive: beehiivWasActive });

    let beehiivApplied = false;
    // dry-run (!push) nunca tenta a mutação — nada foi tentado, então não é
    // uma FALHA a reportar (bug do fleet review, #6507): sem o `!push ||`,
    // uma coorte já tagueada no Kit mas ainda ativa na Beehiiv, rodando em
    // dry-run, aparecia como "FALHOU" no relatório (deveria ser "seria
    // desativado") e disparava o AVISO de invariante violado por engano —
    // nada foi tentado, muito menos violado.
    let beehiivConfirmed = !push || action !== "deactivate";
    let beehiivError: string | undefined;

    if (push && action === "deactivate") {
      beehiivApplied = true;
      const outcome = await deactivateAndVerify(beehiivConfig.publicationId, beehiivConfig.apiKey, ko.email, fetchImpl);
      beehiivConfirmed = outcome.ok;
      beehiivError = outcome.error;
      if (!outcome.ok) log(`ERRO ao desativar ${ko.email} na Beehiiv: ${outcome.error}`);
    }

    results.push({
      email: ko.email,
      existedInKit: ko.existedInKit,
      kitTagAlreadyPresent: ko.alreadyTagged,
      kitTagApplied: ko.applied,
      kitTagConfirmed: ko.confirmed,
      kitError: ko.error,
      beehiivWasActive,
      beehiivAction: action,
      beehiivApplied,
      beehiivConfirmed,
      beehiivError,
    });
  }

  return results;
}

// ── formatação (pura) ────────────────────────────────────────────────────

export function formatCohortReport(results: readonly CohortEmailResult[], summary: CohortRunSummary, push: boolean): string {
  const lines: string[] = [];
  lines.push(`${LOG_PREFIX} coorte de ${summary.total} e-mail(is)${push ? "" : " (dry-run — nenhuma mutação aplicada)"}:`);
  for (const r of results) {
    const kitLabel = r.kitTagConfirmed
      ? r.kitTagAlreadyPresent
        ? "já tagueado"
        : push
          ? "tagueado"
          : "seria tagueado"
      : `FALHOU${r.kitError ? ` (${r.kitError})` : ""}`;
    const beehiivLabel =
      r.beehiivAction === "deactivate"
        ? r.beehiivConfirmed
          ? push
            ? "desativado"
            : "seria desativado"
          : `FALHOU${r.beehiivError ? ` (${r.beehiivError})` : ""}`
        : r.beehiivAction === "skip_kit_unconfirmed"
          ? "PULADO (tag Kit não confirmada)"
          : "sem ação (já não-ativo na Beehiiv)";
    lines.push(`  ${r.email} — Kit: ${kitLabel}; Beehiiv: ${beehiivLabel}`);
  }
  lines.push("");
  lines.push(
    `resumo: ${summary.kitTagged}/${summary.total} tagueado(s) no Kit (${summary.kitTagFailed} falha(s)); ` +
      `${summary.beehiivDeactivated} desativado(s) na Beehiiv (${summary.beehiivDeactivateFailed} falha(s)); ` +
      `${summary.skippedKitUnconfirmed} pulado(s) por tag não confirmada; ` +
      `${summary.skippedNotActiveBeehiiv} sem ação (já não-ativos na Beehiiv).`,
  );
  if (summary.residualDivergence > 0) {
    lines.push(
      `AVISO: ${summary.residualDivergence} e-mail(is) tagueado(s) no Kit e AINDA ativo(s) na Beehiiv ao fim desta ` +
        "rodada — invariante violado; investigar (rode --audit depois de corrigir).",
    );
  }
  if (!push) {
    lines.push("");
    lines.push("(dry-run — rode novamente com --push para gravar de verdade)");
  }
  return lines.join("\n");
}

function logBlastRadiusGuard(guard: KitRampBlastRadiusGuardResult, log: (msg: string) => void): void {
  const pct = (guard.ratio * 100).toFixed(1);
  log(
    `guard de blast radius: coorte de ${guard.cohortSize} contra ${guard.currentActiveBeehiivCount} ativo(s) hoje ` +
      `na Beehiiv (${pct}%, limiar ${(KIT_RAMP_BLAST_RADIUS_THRESHOLD * 100).toFixed(0)}%)` +
      (guard.blocked ? " — EXCEDIDO." : "."),
  );
}

export function formatAuditReport(tagName: string, result: KitRampDivergenceResult): string {
  const lines: string[] = [];
  lines.push(`${LOG_PREFIX} --audit — tag "${tagName}"`);
  lines.push(`  tagueados no Kit: ${result.kitTaggedCount}`);
  lines.push(`  ativos na Beehiiv: ${result.beehiivActiveCount}`);
  if (result.divergent.length === 0) {
    lines.push("  VEREDITO: OK — nenhum e-mail está nos dois lugares ao mesmo tempo.");
  } else {
    lines.push(`  VEREDITO: DIVERGE — ${result.divergent.length} e-mail(is) tagueado(s) no Kit E ativo(s) na Beehiiv:`);
    for (const e of result.divergent) lines.push(`    - ${maskEmail(e)}`);
  }
  return lines.join("\n");
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  loadProjectEnv(ROOT);
  const log = (msg: string) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`);

  const push = hasFlag(argv, "push");
  const audit = hasFlag(argv, "audit");
  const forceBlastRadius = hasFlag(argv, "force-blast-radius");
  const inputPath = getStringArg(argv, "input", { example: "data/kit-ramp/onda-2.txt" });
  const tagOverride = getStringArg(argv, "tag", { example: "rampa-kit" });

  const platformConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as {
    kit_diaria?: { audience_tag?: string };
  };
  const tagName = tagOverride ?? platformConfig.kit_diaria?.audience_tag ?? "rampa-kit";

  const kitResolved = resolveKitConfig();
  const beehiivResolved = resolveBeehiivConfig();

  if (audit) {
    if (!kitResolved.ok || !beehiivResolved.ok) {
      log(
        `ERRO: --audit exige credenciais das duas plataformas — Kit: ${kitResolved.ok ? "ok" : kitResolved.reason}; ` +
          `Beehiiv: ${beehiivResolved.ok ? "ok" : beehiivResolved.reason}`,
      );
      process.exitCode = 2;
      return;
    }
    const tagId = await findTagIdByName(tagName, kitResolved.config);
    const resolution = resolveAudienceTagId(tagName, tagId);
    if (!resolution.ok) {
      log(`ERRO: ${resolution.reason}`);
      process.exitCode = 2;
      return;
    }
    log(`auditando tag "${tagName}" (id ${resolution.tagId})…`);
    const kitTaggedEmails = await listAllSubscribersForTag(resolution.tagId, kitResolved.config);
    const beehiivActive = await fetchCurrentBeehiivState(beehiivResolved.config.publicationId, beehiivResolved.config.apiKey);
    const divergence = computeKitRampDivergence(kitTaggedEmails, beehiivActive.map((s) => s.email));
    process.stdout.write(formatAuditReport(tagName, divergence) + "\n");
    process.exitCode = divergence.divergent.length > 0 ? 1 : 0;
    return;
  }

  if (!inputPath) {
    log("ERRO: --input <arquivo> é obrigatório fora do modo --audit (lista de e-mails, um por linha).");
    process.exitCode = 2;
    return;
  }

  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), inputPath), "utf8");
  } catch (e) {
    log(`ERRO: não foi possível ler ${inputPath}: ${(e as Error).message}`);
    process.exitCode = 2;
    return;
  }
  const emails = parseEmailListFile(raw);
  if (emails.length === 0) {
    log(`ERRO: ${inputPath} não contém nenhum e-mail válido.`);
    process.exitCode = 2;
    return;
  }
  log(`${emails.length} e-mail(is) na coorte (arquivo: ${inputPath}).`);

  if (push && (!kitResolved.ok || !beehiivResolved.ok)) {
    log(
      `ERRO: --push exige credenciais das duas plataformas — Kit: ${kitResolved.ok ? "ok" : kitResolved.reason}; ` +
        `Beehiiv: ${beehiivResolved.ok ? "ok" : beehiivResolved.reason}`,
    );
    process.exitCode = 2;
    return;
  }

  let tagId: number | null = null;
  if (kitResolved.ok) {
    const resolved = await findTagIdByName(tagName, kitResolved.config);
    const resolution = resolveAudienceTagId(tagName, resolved);
    if (!resolution.ok) {
      log(`ERRO: ${resolution.reason}`);
      process.exitCode = 2;
      return;
    }
    tagId = resolution.tagId;
  } else {
    log(`aviso: Kit sem credencial (${kitResolved.reason}) — não é possível resolver a tag nem calcular o plano.`);
  }

  let activeBeehiivEmails: string[] = [];
  if (beehiivResolved.ok) {
    log("buscando assinantes ATIVOS atuais na Beehiiv…");
    const snapshots = await fetchCurrentBeehiivState(beehiivResolved.config.publicationId, beehiivResolved.config.apiKey);
    activeBeehiivEmails = snapshots.map((s) => s.email);
    log(`${activeBeehiivEmails.length} assinante(s) ativo(s) na Beehiiv hoje.`);
  } else {
    log(`aviso: Beehiiv sem credencial (${beehiivResolved.reason}) — guard de blast radius e desativação ficam indisponíveis.`);
  }

  const guard = evaluateKitRampBlastRadiusGuard(emails.length, activeBeehiivEmails.length, forceBlastRadius);
  logBlastRadiusGuard(guard, log);

  if (push && guard.blocked) {
    log("RECUSANDO o --push inteiro (guard de blast radius acima) — nenhuma mutação foi aplicada.");
    process.exitCode = 1;
    return;
  }

  if (!push) {
    log("dry-run (default) — NENHUMA mutação será aplicada nesta chamada. Use --push para gravar.");
  }

  if (!kitResolved.ok || tagId === null) {
    log("plano incompleto (Kit indisponível) — só a lista de entrada é mostrada:");
    process.stdout.write(emails.map((e) => `  ${e}`).join("\n") + "\n");
    return;
  }

  const results = await applyCohortWave({
    emails,
    push,
    kitConfig: kitResolved.config,
    tagId,
    activeBeehiivEmails: new Set(activeBeehiivEmails),
    beehiivConfig: beehiivResolved.ok
      ? beehiivResolved.config
      : ({ apiKey: "", publicationId: "" } as BeehiivConfig), // sem credencial: Fase B nunca chega a "deactivate" de verdade sem beehiivWasActive=true (set vazio acima)
    log,
  });

  const summary = summarizeCohortResults(results);
  process.stdout.write(formatCohortReport(results, summary, push) + "\n");
  if (summary.kitTagFailed > 0 || summary.beehiivDeactivateFailed > 0) {
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${LOG_PREFIX} erro fatal: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}
