/**
 * scripts/lib/diaria/short-related-kv.ts (#12541 item 2)
 *
 * Registro do vínculo do vídeo relacionado do Short no KV da Cloudflare, fora
 * do OneDrive. A task LOCAL `diaria-short-video-relacionado` (Neo, #10811)
 * grava aqui pelo `scripts/short-related-kv-publish.ts` depois de registrar o
 * resultado em `_internal/06-short-related.json`; o alarme
 * `Diaria-Short-Related-Missed-Alarm` (#11353, no `300`) lê daqui antes de
 * olhar o arquivo replicado. Decisão do editor (10/11/2026, comentário na
 * #12541): KV da Cloudflare, task do Neo grava por API, o `300` lê.
 *
 * Namespace: `diaria-ops-state` (`platform.config.json` →
 * `ops_state_kv.namespace_id`), criado para isto e pensado para os próximos
 * sinais operacionais que saírem do OneDrive (G5 em
 * `docs/onedrive-dependencias-cloudflare.md`). Por isso a chave leva prefixo.
 *
 * Chave: `short-related:{AAMMDD}`. Valor: o mesmo JSON do arquivo da edição
 * (`ShortRelatedRecord`), lido de volta com `parseShortRelatedRecord`, que já
 * confere o `aammdd` contra a chave. Um formato só nos dois canais.
 *
 * Credenciais: `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_WORKERS_TOKEN` (as mesmas
 * do upload de imagens no KV `POLL`), com `CLOUDFLARE_API_TOKEN` como
 * reserva. Lógica pura; o I/O de rede é o `KvOps` injetado.
 */

import type { KvOps } from "../cloudflare-kv-rest.ts";
import { parseShortRelatedRecord, type ShortRelatedRecord } from "./youtube-short-related.ts";

export const SHORT_RELATED_KV_PREFIX = "short-related:";

/** Chave do registro da edição. Lança em AAMMDD inválido (nunca grava chave torta). */
export function shortRelatedKvKey(aammdd: string): string {
  if (!/^\d{6}$/.test(aammdd)) throw new Error(`shortRelatedKvKey: AAMMDD inválido (${JSON.stringify(aammdd)})`);
  return `${SHORT_RELATED_KV_PREFIX}${aammdd}`;
}

/** Valor gravado: o registro inteiro, em JSON compacto. */
export function serializeShortRelatedKvValue(rec: ShortRelatedRecord): string {
  return JSON.stringify(rec);
}

export interface OpsStateKvConfig {
  accountId: string;
  token: string;
  namespaceId: string;
}

/**
 * Resolve a configuração do namespace. Devolve `missing` (nomes das variáveis
 * ou chaves ausentes, nunca valores) em vez de lançar: quem chama decide se
 * isso é erro (o publish) ou incerteza (o alarme).
 */
export function resolveOpsStateKvConfig(
  platformConfig: unknown,
  env: Record<string, string | undefined>,
): { ok: true; config: OpsStateKvConfig } | { ok: false; missing: string[] } {
  const ns = (platformConfig as { ops_state_kv?: { namespace_id?: unknown } } | null)?.ops_state_kv?.namespace_id;
  const namespaceId = typeof ns === "string" ? ns.trim() : "";
  const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const token = (env.CLOUDFLARE_WORKERS_TOKEN ?? "").trim() || (env.CLOUDFLARE_API_TOKEN ?? "").trim();
  const missing = [
    !namespaceId && "platform.config.json ops_state_kv.namespace_id",
    !accountId && "CLOUDFLARE_ACCOUNT_ID",
    !token && "CLOUDFLARE_WORKERS_TOKEN (ou CLOUDFLARE_API_TOKEN)",
  ].filter((x): x is string => Boolean(x));
  if (missing.length) return { ok: false, missing };
  return { ok: true, config: { accountId, token, namespaceId } };
}

/**
 * Leitura do registro no KV, com a incerteza explícita:
 *   - `ok`     registro válido da edição;
 *   - `absent` o KV respondeu e a chave não existe (a task não gravou);
 *   - `error`  não deu para saber: rede, HTTP, credencial ausente, ou valor
 *              que não parseia como registro desta edição.
 * Valor corrompido entra em `error`, e não em "ilegível = falha": quem decide
 * é o arquivo da edição ou o veredito de incerteza do alarme.
 */
export type ShortRelatedKvRead =
  | { kind: "ok"; value: ShortRelatedRecord }
  | { kind: "absent" }
  | { kind: "error"; error: string };

export async function readShortRelatedKv(ops: Pick<KvOps, "get">, aammdd: string): Promise<ShortRelatedKvRead> {
  const key = shortRelatedKvKey(aammdd);
  let raw: string | null;
  try {
    raw = await ops.get(key);
  } catch (e) {
    return { kind: "error", error: (e as Error).message };
  }
  if (raw === null) return { kind: "absent" };
  try {
    return { kind: "ok", value: parseShortRelatedRecord(raw, aammdd, `KV ${key}`) };
  } catch (e) {
    return { kind: "error", error: (e as Error).message };
  }
}

/**
 * Grava o registro e relê para confirmar (o PUT 2xx não prova que a leitura
 * do `300` vai ver o mesmo valor). Lança se o PUT falhar ou se a releitura
 * não devolver o registro gravado. A releitura vem do mesmo ponto de presença
 * que gravou, então a consistência eventual do KV não a afeta.
 */
export async function publishShortRelatedKv(ops: Pick<KvOps, "get" | "put">, rec: ShortRelatedRecord): Promise<string> {
  const key = shortRelatedKvKey(rec.aammdd);
  const value = serializeShortRelatedKvValue(rec);
  await ops.put(key, value);
  const back = await readShortRelatedKv(ops, rec.aammdd);
  if (back.kind !== "ok") {
    throw new Error(`KV ${key}: releitura depois do PUT deu ${back.kind}${back.kind === "error" ? ` (${back.error})` : ""}`);
  }
  // Campo a campo: a ordem das chaves do JSON varia conforme quem montou o registro.
  const fields = ["aammdd", "status", "horizontalId", "shortId", "note", "at", "alertedAt"] as const;
  // `|| null`: o parser normaliza string vazia para null.
  if (fields.some((f) => (back.value[f] || null) !== (rec[f] || null))) {
    throw new Error(`KV ${key}: releitura depois do PUT devolveu outro registro`);
  }
  return key;
}
