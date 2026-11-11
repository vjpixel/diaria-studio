/**
 * brevo-rate-state.ts (#5697)
 *
 * Rastreia, em disco, o `x-sib-ratelimit-remaining` mais recente observado
 * pela família de endpoints `/v3/emailCampaigns*` da Brevo (100 req/HORA por
 * CONTA — ver `docs/brevo-rate-limits.md`, #5215/#5219). `brevo-client.ts`
 * grava o estado a cada resposta dessa família (sucesso ou 429); consumidores
 * de LEITURA/diagnóstico (nunca o caminho de ESCRITA — ver abaixo) chamam
 * `assertCampaignQuotaHeadroom()` antes de um sweep em lote pra recusar gastar
 * cota abaixo de uma reserva, em vez de descobrir o esgotamento no meio do
 * sweep (ou pior, esgotar a cota que o caminho de escrita precisava).
 *
 * Origem do incidente (#5697): um diagnóstico ad-hoc via `node -e` com
 * `fetch` cru (bypassando `brevo-client.ts` inteiramente) gastou a cota
 * horária inteira fazendo N `GET /v3/emailCampaigns/{id}` — um por campanha —
 * pra responder "algum contato recebeu 2 e-mails em agosto?". Isso fez
 * `clarice-build-segment.ts` abortar (corretamente — não escreve sem
 * confirmar campanhas comprometidas) por falta de cota pra checar campanhas
 * agendadas/disparadas antes de montar a onda.
 *
 * **O caminho de ESCRITA (`clarice-build-segment.ts`/`clarice-plan-wave.ts`)
 * NUNCA chama `assertCampaignQuotaHeadroom` — ele é o BENEFICIÁRIO da
 * reserva, não quem a respeita.** Só READ diagnóstico/auditoria chama.
 *
 * Fail-soft por design: falha de leitura/escrita do arquivo de estado nunca
 * deve quebrar a chamada real à Brevo que está em curso em `brevo-client.ts`
 * — o pior caso é perder visibilidade da cota, não a chamada em si.
 *
 * #12841 (G5 de `docs/onedrive-dependencias-cloudflare.md`): o estado também
 * vive no KV da Cloudflare (namespace `diaria-ops-state`, chave
 * `BREVO_RATE_KV_KEY`), porque a cota é da CONTA e o arquivo em `data/` é
 * escrito por todas as máquinas — com a replicação do Drive, escrita
 * concorrente perde o contador de uma delas. O arquivo local continua sendo o
 * cache que as leituras SÍNCRONAS (`readCampaignQuotaState` e os asserts)
 * consultam:
 *   - escrita: grava o arquivo (síncrono, como antes) e manda o mesmo estado
 *     ao KV em segundo plano (`recordCampaignQuotaRemaining` nunca espera a
 *     rede; falha vira um aviso único em stderr). "Último valor vence": o
 *     valor vem do header da própria Brevo.
 *   - leitura: quem vai decidir por cota chama antes
 *     `await refreshCampaignQuotaStateFromKv()`, que traz a observação do KV
 *     para o arquivo quando ela é mais nova que a local (o leitor de cada
 *     janela horária vê a última observação de QUALQUER máquina). KV fora do
 *     ar, sem credencial ou com valor ilegível → segue só com o arquivo,
 *     nunca lança, nunca bloqueia envio.
 * Sem `CLOUDFLARE_ACCOUNT_ID`/token no ambiente o módulo se comporta como
 * antes (só arquivo). Sob `node --test` o KV padrão fica desligado: teste
 * injeta o backend com `setCampaignQuotaKvOpsForTest` (nenhum teste fala com
 * a Cloudflare real).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKvRestOps, type KvOps } from "./cloudflare-kv-rest.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** `data/` é gitignored (junction OneDrive) — mesma convenção do resto do
 *  projeto (ex: `brevo-diaria-store.ts`). Path override só existe pra teste. */
export const DEFAULT_RATE_STATE_PATH = resolve(ROOT, "data/brevo-rate-state.json");

export interface BrevoCampaignQuotaState {
  /** `x-sib-ratelimit-remaining` mais recente observado na família /emailCampaigns*. */
  remaining: number;
  /** `x-sib-ratelimit-limit` correspondente, se o header veio presente. */
  limit?: number;
  /** `x-sib-ratelimit-reset` em segundos até o reset da cota (header horário, 100 req/HORA). */
  reset?: number;
  /** ISO timestamp de quando este estado foi gravado. */
  updatedAt: string;
}

/**
 * Janela padrão de expiração: 1h em ms (3600s) — a cota da família
 * /v3/emailCampaigns* da Brevo é horária (100 req/HORA por CONTA, ver
 * docs/brevo-rate-limits.md, #5215/#5219). Usado como fallup quando o
 * header `x-sib-ratelimit-reset` não veio presente ou não foi armazenado.
 */
export const DEFAULT_RESET_WINDOW_MS = 3_600_000;

/**
 * Decide se um estado observado é "stale" — expirou a janela de reset da
 * Brevo. Um estado stale é indistinguível de "nunca observado" para efeitos
 * de assertQuotaHeadroom e warnIfCampaignQuotaLow: a cota real da Brevo já
 * pode ter sido renovada, então o consumidor read-only não deve ser barrado
 * por um estado que pode não refletir mais a realidade.
 *
 * Se o campo `reset` (segundos) está presente no state, usa `updatedAt + reset`
 * como expiração. Caso contrário, usa `updatedAt + DEFAULT_RESET_WINDOW_MS / 1000`.
 *
 * @param state — estado observado (nunca null — chamador decide o que fazer com null)
 */
export function isStateStale(state: BrevoCampaignQuotaState): boolean {
  const updatedMs = Date.parse(state.updatedAt);
  if (isNaN(updatedMs)) return false; // timestamp inválido → não podemos julgar staleness
  const resetSeconds = state.reset ?? (DEFAULT_RESET_WINDOW_MS / 1000);
  const expiryMs = updatedMs + (resetSeconds * 1000);
  return Date.now() > expiryMs;
}

/**
 * Grava o estado observado. Fail-soft: qualquer erro (disco cheio, `data/`
 * ausente numa sessão cloud, race de escrita) é engolido — rastrear cota é
 * um extra de visibilidade, nunca deve derrubar a chamada real à Brevo que
 * originou esta gravação.
 */
export function writeCampaignQuotaState(
  state: BrevoCampaignQuotaState,
  path: string = DEFAULT_RATE_STATE_PATH,
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2));
  } catch {
    // fail-soft — ver docstring do módulo.
  }
}

/** Lê o último estado gravado. `null` se ausente, corrompido, ou shape inesperado. */
export function readCampaignQuotaState(
  path: string = DEFAULT_RATE_STATE_PATH,
): BrevoCampaignQuotaState | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw?.remaining !== "number" || typeof raw?.updatedAt !== "string") return null;
    return raw as BrevoCampaignQuotaState;
  } catch {
    return null;
  }
}

/**
 * Registra o `remaining`/`limit` mais recente observado num response da
 * família /emailCampaigns*. Chamada por `brevo-client.ts` em toda resposta
 * dessa família (sucesso ou 429) que carregue o header — ver
 * `maybeRecordCampaignRateLimit` lá.
 */
export function recordCampaignQuotaRemaining(
  remaining: number,
  limit?: number,
  reset?: number,
  path: string = DEFAULT_RATE_STATE_PATH,
): void {
  const state: BrevoCampaignQuotaState = { remaining, limit, reset, updatedAt: new Date().toISOString() };
  writeCampaignQuotaState(state, path);
  scheduleCampaignQuotaKvPush(state);
}

// ---------------------------------------------------------------------------
// #12841 — espelho no KV da Cloudflare (ver docstring do módulo).
// ---------------------------------------------------------------------------

/** Chave do estado no namespace `ops_state_kv` (`diaria-ops-state`). Um valor
 *  só, como o arquivo: o header não diz de qual conta Brevo veio a resposta. */
export const BREVO_RATE_KV_KEY = "brevo-rate:email-campaigns";

/** Timeout por request ao KV: a leitura antecede um sweep/render, não pode pendurar. */
export const BREVO_RATE_KV_TIMEOUT_MS = 4_000;

/** Interpreta o valor do KV. `null` para ausente, JSON inválido ou shape inesperado. */
export function parseCampaignQuotaState(raw: string | null): BrevoCampaignQuotaState | null {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw);
    if (typeof v?.remaining !== "number" || !Number.isFinite(v.remaining)) return null;
    if (typeof v?.updatedAt !== "string" || Number.isNaN(Date.parse(v.updatedAt))) return null;
    const out: BrevoCampaignQuotaState = { remaining: v.remaining, updatedAt: v.updatedAt };
    if (typeof v.limit === "number") out.limit = v.limit;
    if (typeof v.reset === "number") out.reset = v.reset;
    return out;
  } catch {
    return null;
  }
}

/**
 * "Último valor vence": devolve a observação mais recente pelo `updatedAt`.
 * `updatedAt` ilegível perde para um legível; empate fica com `local`.
 */
export function pickNewerCampaignQuotaState(
  local: BrevoCampaignQuotaState | null,
  remote: BrevoCampaignQuotaState | null,
): BrevoCampaignQuotaState | null {
  if (!remote) return local;
  if (!local) return remote;
  const l = Date.parse(local.updatedAt);
  const r = Date.parse(remote.updatedAt);
  if (Number.isNaN(r)) return local;
  if (Number.isNaN(l)) return remote;
  return r > l ? remote : local;
}

/** Resolve o backend KV a partir de `platform.config.json` + ambiente. `null` = só arquivo. */
export function resolveCampaignQuotaKvOps(
  platformConfig: unknown,
  env: Record<string, string | undefined>,
): KvOps | null {
  const optOut = (env.BREVO_RATE_STATE_KV ?? "").trim().toLowerCase();
  if (optOut === "0" || optOut === "off" || optOut === "false") return null;
  const ns = (platformConfig as { ops_state_kv?: { namespace_id?: unknown } } | null)?.ops_state_kv?.namespace_id;
  const namespaceId = typeof ns === "string" ? ns.trim() : "";
  const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const token = (env.CLOUDFLARE_WORKERS_TOKEN ?? "").trim() || (env.CLOUDFLARE_API_TOKEN ?? "").trim();
  if (!namespaceId || !accountId || !token) return null;
  return createKvRestOps({ accountId, token, namespaceId, timeoutMs: BREVO_RATE_KV_TIMEOUT_MS });
}

/** `undefined` = ainda não resolvido neste processo. */
let kvOpsCache: KvOps | null | undefined;
let kvOpsInjected = false;

function getCampaignQuotaKvOps(): KvOps | null {
  if (kvOpsInjected) return kvOpsCache ?? null;
  if (kvOpsCache !== undefined) return kvOpsCache;
  // Sob `node --test` (o runner exporta NODE_TEST_CONTEXT para os processos de
  // teste e seus filhos) o KV real nunca é tocado, mesmo com credencial no shell.
  if (process.env.NODE_TEST_CONTEXT) {
    kvOpsCache = null;
    return null;
  }
  try {
    const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
    kvOpsCache = resolveCampaignQuotaKvOps(cfg, process.env);
  } catch {
    kvOpsCache = null;
  }
  return kvOpsCache;
}

/**
 * Seam de teste: injeta o backend KV (fake) ou `null` (desligado). `undefined`
 * volta à resolução padrão. Também zera a fila de escrita e o aviso único.
 */
export function setCampaignQuotaKvOpsForTest(ops: KvOps | null | undefined): void {
  kvOpsInjected = ops !== undefined;
  kvOpsCache = ops === undefined ? undefined : ops;
  kvPending = null;
  kvWarned = false;
}

let kvWarned = false;
function warnKvOnce(what: string, err: unknown): void {
  if (kvWarned) return;
  kvWarned = true;
  console.error(
    `⚠️  brevo-rate-state: KV da Cloudflare indisponível (${what}: ${(err as Error)?.message ?? String(err)}) — ` +
      "seguindo com o arquivo local (#12841).",
  );
}

let kvPending: BrevoCampaignQuotaState | null = null;
let kvInFlight: Promise<void> | null = null;

/**
 * Manda o estado ao KV em segundo plano, sem bloquear quem gravou. Coalesce:
 * com um PUT em voo, só a observação mais nova espera a vez (as intermediárias
 * são descartadas), e os PUTs deste processo saem em ordem — uma observação
 * velha nunca sobrescreve uma nova vinda do mesmo processo.
 */
function scheduleCampaignQuotaKvPush(state: BrevoCampaignQuotaState): void {
  if (!getCampaignQuotaKvOps()) return;
  kvPending = state;
  if (kvInFlight) return;
  kvInFlight = (async () => {
    while (kvPending) {
      const next = kvPending;
      kvPending = null;
      const ops = getCampaignQuotaKvOps();
      if (!ops) return;
      try {
        await ops.put(BREVO_RATE_KV_KEY, JSON.stringify(next));
      } catch (e) {
        warnKvOnce("escrita", e);
      }
    }
  })()
    .catch((e) => warnKvOnce("escrita", e))
    .finally(() => {
      kvInFlight = null;
    });
}

/** Espera os PUTs pendentes deste processo. Nunca lança. */
export async function flushCampaignQuotaKvWrites(): Promise<void> {
  while (kvInFlight) await kvInFlight;
}

/**
 * Traz a observação do KV para o arquivo local quando ela é mais nova que a
 * local, para que as leituras síncronas (`assertCampaignQuotaHeadroom`,
 * `warnIfCampaignQuotaLow`, `readCampaignQuotaState`) vejam a última
 * observação de qualquer máquina. Chamar logo antes delas. Nunca lança: KV
 * fora do ar, sem credencial ou com valor ilegível → devolve o estado local.
 * Devolve o estado vencedor (o que fica no arquivo).
 */
export async function refreshCampaignQuotaStateFromKv(
  path: string = DEFAULT_RATE_STATE_PATH,
): Promise<BrevoCampaignQuotaState | null> {
  const local = readCampaignQuotaState(path);
  const ops = getCampaignQuotaKvOps();
  if (!ops) return local;
  let remote: BrevoCampaignQuotaState | null;
  try {
    remote = parseCampaignQuotaState(await ops.get(BREVO_RATE_KV_KEY));
  } catch (e) {
    warnKvOnce("leitura", e);
    return local;
  }
  const winner = pickNewerCampaignQuotaState(local, remote);
  if (winner && winner === remote) writeCampaignQuotaState(winner, path);
  return winner;
}

/**
 * Erro lançado por `assertCampaignQuotaHeadroom`/`assertQuotaHeadroom` quando
 * a cota observada está abaixo da reserva mínima. Mensagem explícita sobre
 * QUEM deve mudar de comportamento (o consumidor read-only, nunca o caminho
 * de escrita) e QUAL é a alternativa barata (`fetchCampaignsByStatus`).
 */
export class BrevoCampaignQuotaLowError extends Error {
  constructor(
    public readonly remaining: number,
    public readonly minRemaining: number,
  ) {
    super(
      `Cota da família /v3/emailCampaigns* da Brevo está baixa: remaining=${remaining} < reserva ` +
        `mínima ${minRemaining} (100 req/HORA por CONTA — ver docs/brevo-rate-limits.md). Este é um ` +
        `consumidor de LEITURA/diagnóstico — recusando gastar a cota reservada pro caminho de ESCRITA ` +
        `(clarice-build-segment.ts/clarice-plan-wave.ts, que precisa checar campanhas comprometidas antes ` +
        `de montar onda, #5697). Aguarde o reset horário, ou prefira scripts/clarice-audit-overlap.ts ` +
        `(custo fixo, ~2 chamadas) em vez de N GETs por campanha.`,
    );
    this.name = "BrevoCampaignQuotaLowError";
  }
}

/**
 * Decisão pura (sem I/O) — separada de `assertCampaignQuotaHeadroom` pra
 * ficar testável sem tocar disco. `state === null` (nunca observamos a
 * família /emailCampaigns* nesta máquina/processo ainda, ou o arquivo de
 * estado está ausente/corrompido) não recusa — não há base pra recusar uma
 * cota que nunca foi medida; o request seguinte é quem vai gravar o 1º
 * estado real.
 */
export function assertQuotaHeadroom(
  state: BrevoCampaignQuotaState | null,
  minRemaining: number,
): void {
  if (state == null) return;
  if (isStateStale(state)) return; // #9913: estado expirado — cota Brevo ja pode ter renovado
  if (state.remaining < minRemaining) {
    throw new BrevoCampaignQuotaLowError(state.remaining, minRemaining);
  }
}

/**
 * Entry point pra consumidores read-only/diagnóstico. Reserva sugerida pela
 * issue #5697: 30. Chamar ANTES de iniciar um sweep em lote contra
 * /v3/emailCampaigns* — nunca dentro do caminho de escrita (guard de
 * campanhas comprometidas em clarice-build-segment.ts/clarice-plan-wave.ts
 * continua sem chamar isto, de propósito: ele é o beneficiário da reserva).
 */
export function assertCampaignQuotaHeadroom(
  minRemaining = 30,
  path: string = DEFAULT_RATE_STATE_PATH,
): void {
  assertQuotaHeadroom(readCampaignQuotaState(path), minRemaining);
}

/**
 * #6458 — leitura BEST-EFFORT, NUNCA bloqueante, pro caminho de ESCRITA
 * (`clarice-build-segment.ts`/`clarice-plan-wave.ts`). Ao contrário de
 * `assertCampaignQuotaHeadroom` (que LANÇA, e é só pra consumidores de
 * leitura/diagnóstico — ver docstring do módulo), esta função NUNCA
 * bloqueia: lê o último estado observado e, se a cota já está abaixo da
 * reserva, imprime um AVISO em `console.error` — puro sinal pro
 * operador/log, sem mudar o comportamento fail-hard existente (a tentativa
 * segue; se a Brevo responder 429 de verdade, o call site trata isso
 * normalmente, como já fazia). Continua verdade que o caminho de escrita é
 * o BENEFICIÁRIO da reserva, não quem a respeita — este aviso não é uma
 * versão fraca do assert, é observabilidade pura.
 *
 * Motivação (#6458, achado do #6421/#5697): antes desta função, o caminho
 * de escrita só descobria o esgotamento da cota AO TOMAR o 429 na cara —
 * sem nenhum sinal prévio no relatório/log de que a tentativa provavelmente
 * ia falhar por contenção de OUTRA sessão. Chamar isto logo antes de
 * `fetchCommittedCampaignListIds`/`fetchQueuedCampaignListIds` dá esse
 * contexto de graça, sem esperar o guard de #6831 (retry com orçamento
 * maior) entrar em ação.
 *
 * `state === null` (nunca observado, ou arquivo ausente/corrompido) não
 * avisa — não há base pra avisar sobre uma cota que nunca foi medida (mesmo
 * racional de `assertQuotaHeadroom`).
 */
export function warnIfCampaignQuotaLow(
  minRemaining = 30,
  path: string = DEFAULT_RATE_STATE_PATH,
): void {
  const state = readCampaignQuotaState(path);
  if (state == null) return;
  if (isStateStale(state)) return; // #9913: estado expirado — cota ja pode ter renovado
  if (state.remaining < minRemaining) {
    console.error(
      `⚠️  cota da família /v3/emailCampaigns* da Brevo pode estar baixa: última leitura remaining=${state.remaining} ` +
        `(< reserva ${minRemaining}) às ${state.updatedAt} — possivelmente esgotada por outra task/sessão concorrente ` +
        "(100 req/HORA por CONTA, ver docs/brevo-rate-limits.md). Tentando mesmo assim — o caminho de ESCRITA " +
        "nunca bloqueia por cota (#5697); isto é só um aviso pra explicar um 429 que pode vir a seguir (#6458).",
    );
  }
}
