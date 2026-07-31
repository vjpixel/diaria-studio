/**
 * clarice-novos-state.ts (#4347 Etapa 4)
 *
 * Estado da skill `/diaria-clarice-novos` — persistido em
 * `data/clarice-subscribers/novos-state.json` (arquivo dedicado, mesmo
 * padrão de `data/studio-chat-enabled.json`). Sustenta 2 decisões da issue:
 *
 *   - D12: pular `--send-test` quando o SHA-256 do HTML (`cloudflare-preview.html`
 *     do ciclo resolvido) for IDÊNTICO ao da última rodada — o digest mensal
 *     é o mesmo em ~16 de 17 rodadas (~4×/semana vs ~1 mudança de conteúdo/mês).
 *   - Idempotência de `--key` (D11-adjacent): `novos-{AAMMDD}`, com sufixo
 *     `-2`/`-3`… se a skill rodar mais de uma vez no mesmo dia.
 *
 * Fail-soft por design (mesmo padrão de `studio-chat-enabled.ts`/`exec-mode.ts`):
 * leitura tolerante (arquivo ausente/corrompido → estado "1ª rodada", nunca
 * lança) — a skill não pode travar por causa de um estado auxiliar corrompido.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomic } from "./atomic-write.ts";
import { CLARICE_BASE } from "./clarice-paths.ts";

export interface NovosState {
  lastRunAt: string;
  lastHtmlSha256: string | null;
  lastCycle: string | null;
  lastListId: number | null;
  lastCampaignId: number | null;
  sentCount: number;
}

/** Path do state file. `baseDir` opcional — uso interno de teste (mesmo padrão `--data-root` do resto do projeto). */
export function novosStatePath(baseDir: string = CLARICE_BASE): string {
  return resolve(baseDir, "novos-state.json");
}

/** Lê o state file. Tolerante: ausente/corrompido/shape inesperado → `null` (nunca lança) — "1ª rodada". */
export function readNovosState(baseDir: string = CLARICE_BASE): NovosState | null {
  const path = novosStatePath(baseDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<NovosState>;
    if (typeof parsed.lastRunAt !== "string") return null;
    return {
      lastRunAt: parsed.lastRunAt,
      lastHtmlSha256: parsed.lastHtmlSha256 ?? null,
      lastCycle: parsed.lastCycle ?? null,
      lastListId: parsed.lastListId ?? null,
      lastCampaignId: parsed.lastCampaignId ?? null,
      sentCount: typeof parsed.sentCount === "number" ? parsed.sentCount : 0,
    };
  } catch {
    return null;
  }
}

/** Escreve o state file (escrita atômica — mesmo padrão do resto do projeto). Cria o diretório se faltar. */
export function writeNovosState(state: NovosState, baseDir: string = CLARICE_BASE): void {
  mkdirSync(baseDir, { recursive: true });
  writeFileAtomic(novosStatePath(baseDir), JSON.stringify(state, null, 2) + "\n");
}

/** SHA-256 (hex) de uma string — usado sobre o conteúdo de `cloudflare-preview.html`. */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * D12 — deve mandar `--send-test` nesta rodada? Pura/testável (recebe o SHA
 * já calculado + o state já lido, sem I/O).
 *   - state ausente (1ª rodada) → true (nunca pular o 1º test email).
 *   - `lastHtmlSha256` ausente no state (rodada anterior não gravou, ex:
 *     versão antiga) → true (fail-safe: na dúvida, manda).
 *   - SHA idêntico ao da última rodada → false (pula — D12).
 *   - SHA diferente → true (conteúdo mudou, manda de novo).
 */
export function shouldSendTest(currentHtmlSha256: string, state: NovosState | null): boolean {
  if (!state || !state.lastHtmlSha256) return true;
  return state.lastHtmlSha256 !== currentHtmlSha256;
}

/**
 * Idempotência de `--key` (#4347): `novos-{AAMMDD}` por padrão; se essa key
 * (ou qualquer sufixo `-N`) já existe em `existingKeys` (lido de
 * `group-campaigns.json` do ciclo Clarice, `--group novos`), retorna o
 * PRÓXIMO sufixo livre (`-2`, `-3`…) — nunca reusa uma key já comprometida
 * com uma campanha criada. Pura/testável.
 */
export function resolveNovosKey(existingKeys: readonly string[], aammdd: string): string {
  const base = `novos-${aammdd}`;
  if (!existingKeys.includes(base)) return base;
  let n = 2;
  while (existingKeys.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
