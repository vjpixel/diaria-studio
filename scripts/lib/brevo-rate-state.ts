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
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** `data/` é gitignored (junction OneDrive) — mesma convenção do resto do
 *  projeto (ex: `brevo-diaria-store.ts`). Path override só existe pra teste. */
export const DEFAULT_RATE_STATE_PATH = resolve(ROOT, "data/brevo-rate-state.json");

export interface BrevoCampaignQuotaState {
  /** `x-sib-ratelimit-remaining` mais recente observado na família /emailCampaigns*. */
  remaining: number;
  /** `x-sib-ratelimit-limit` correspondente, se o header veio presente. */
  limit?: number;
  /** ISO timestamp de quando este estado foi gravado. */
  updatedAt: string;
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
  path: string = DEFAULT_RATE_STATE_PATH,
): void {
  writeCampaignQuotaState({ remaining, limit, updatedAt: new Date().toISOString() }, path);
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
