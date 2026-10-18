/**
 * estilo-regen-state.ts (#10335)
 *
 * Manutenção de `_internal/04-estilo-regen.json` — o estado do plano de
 * regeneração por Noite Estrelada (`run-image-crop-reviewer.ts
 * --estilo-regen-plan`, #10312) — quando o EDITOR mexe nos destaques no
 * Stage 4.
 *
 * Por que existe: o estado é chaveado por POSIÇÃO (`d1`/`d2`/`d3`) e o plano
 * seguinte decide "a regeneração rodou?" comparando o md5 atual com o
 * snapshot de `pending`/`pendingBase`/`pendingAll`. Só com md5 não dá para
 * separar "a regeneração reescreveu o destaque" de "o editor trocou a imagem
 * daquela posição": com um `pending` vivo, uma troca completa (2:1, 1:1 e 4:5
 * novos) passa por regeneração, os md5 da imagem trocada entram em `images`,
 * o reset do #10327 não dispara e o destaque vai a `exhausted` — erro
 * `image-starry-night-detected` no gate para uma imagem nunca regenerada.
 *
 * Decisão do editor (briefing overnight 261018): o estado é limpo na própria
 * troca, por quem a faz, em vez de tornar `--estilo-regen-ran` obrigatório.
 *   - `swap-destaque.ts`: a posição recebe outro item (imagens apagadas) →
 *     estado da posição zerado (`clearEstiloRegenDestaques`).
 *   - `reorder-destaques.ts` / `promote-to-destaque.ts`: as imagens MUDAM de
 *     posição junto com o conteúdo → o estado segue a imagem
 *     (`reorderEstiloRegenState`, mesma semântica de `reorderCropReviewJson`);
 *     a posição nova do promote não herda nada.
 *   - troca manual da arte (arquivo novo no lugar do antigo, sem script):
 *     `run-image-crop-reviewer.ts --estilo-regen-reset dN`.
 *
 * Fail-soft como os demais JSONs secundários desses scripts: arquivo
 * ausente/ilegível nunca aborta a operação editorial.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const ESTILO_REGEN_STATE_FILE = "04-estilo-regen.json";

/**
 * Campos de `EstiloRegenState` (run-image-crop-reviewer.ts) chaveados por
 * destaque. Um campo novo lá precisa entrar aqui — o tipo é travado em
 * compilação no próprio run-image-crop-reviewer.ts.
 */
export const ESTILO_REGEN_PER_DESTAQUE_KEYS = [
  "attempts",
  "failed",
  "pending",
  "pendingBase",
  "pendingAll",
  "images",
] as const;

export function estiloRegenStatePath(internalDir: string): string {
  return resolve(internalDir, ESTILO_REGEN_STATE_FILE);
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Remove o estado dos destaques dados (`["d1"]`) de todos os campos por
 * destaque. Estado não reconhecível → no-op.
 */
export function clearEstiloRegenDestaques(
  data: unknown,
  destaques: readonly string[],
): { changed: boolean; data: unknown } {
  if (!isObj(data)) return { changed: false, data };
  let changed = false;
  const out: Json = { ...data };
  for (const key of ESTILO_REGEN_PER_DESTAQUE_KEYS) {
    const map = out[key];
    if (!isObj(map)) continue;
    const next: Json = { ...map };
    for (const d of destaques) {
      if (d in next) {
        delete next[d];
        changed = true;
      }
    }
    out[key] = next;
  }
  return changed ? { changed, data: out } : { changed: false, data };
}

/**
 * Remapeia o estado conforme `newOrder` (mesma convenção de
 * `reorder-destaques.ts`: a posição nova `d{i+1}` recebe o conteúdo da antiga
 * `d{newOrder[i]}`). Posição nova cuja origem não tem estado fica sem estado;
 * chaves fora do range de `newOrder` são preservadas.
 */
export function reorderEstiloRegenState(
  data: unknown,
  newOrder: readonly number[],
): { changed: boolean; data: unknown } {
  if (!isObj(data)) return { changed: false, data };
  let changed = false;
  const out: Json = { ...data };
  for (const key of ESTILO_REGEN_PER_DESTAQUE_KEYS) {
    const map = out[key];
    if (!isObj(map)) continue;
    const next: Json = {};
    for (const [k, v] of Object.entries(map)) {
      const pos = /^d(\d+)$/.exec(k);
      if (!pos || Number(pos[1]) > newOrder.length) next[k] = v;
    }
    for (let i = 0; i < newOrder.length; i++) {
      const oldKey = `d${newOrder[i]}`;
      const newKey = `d${i + 1}`;
      if (oldKey !== newKey && (oldKey in map || newKey in map)) changed = true;
      if (oldKey in map) next[newKey] = map[oldKey];
    }
    out[key] = next;
  }
  return changed ? { changed, data: out } : { changed: false, data };
}

/**
 * Aplica `transform` em `_internal/04-estilo-regen.json` e grava se mudou.
 * Retorna o path quando reescreveu (ou reescreveria, em `dryRun`), `null` se
 * nada mudou, e `warning` quando o arquivo existe mas não pôde ser lido.
 * `write` permite ao chamador usar a própria escrita verificada.
 */
export function updateEstiloRegenStateFile(
  internalDir: string,
  transform: (data: unknown) => { changed: boolean; data: unknown },
  dryRun = false,
  write: (path: string, content: string) => void = (path, content) => writeFileSync(path, content, "utf8"),
): { rewritten: string | null; warning?: string } {
  const path = estiloRegenStatePath(internalDir);
  if (!existsSync(path)) return { rewritten: null };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { rewritten: null, warning: `${path} ilegível (${(e as Error).message}), pulando.` };
  }
  const r = transform(data);
  if (!r.changed) return { rewritten: null };
  if (!dryRun) write(path, JSON.stringify(r.data, null, 2) + "\n");
  return { rewritten: path };
}
