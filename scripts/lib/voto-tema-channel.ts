/**
 * scripts/lib/voto-tema-channel.ts (#8371)
 *
 * Config + I/O de KV compartilhados pelos scripts do ciclo de votação de
 * tema (`voto-tema-open.ts`, `-stats.ts`, `-lembrete.ts`, `-close.ts`,
 * `sync-apoio-voto-tema-tag-kit.ts`). A lógica de decisão fica em
 * `workers/artigos/src/voto-tema-core.ts` (pura, reusada tal-e-qual pelos
 * scripts, ver docstring de lá sobre por que o formato do token não é
 * reimportado do worker `poll`); este módulo é só a conversa com o KV via
 * API REST da Cloudflare (os scripts rodam fora do runtime do Worker, não
 * têm `env.POLL.list` nativo — só a API).
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import {
  getTextFromWorkerKV,
  listWorkerKVKeys,
  putTextToWorkerKV,
  type CloudflareKVConfig,
} from "./cloudflare-kv-upload.ts";
import {
  ballotKey,
  resultKey,
  voteKey,
  voteKeyPrefix,
  type BallotTema,
  type VotoRegistrado,
} from "../../workers/artigos/src/voto-tema-core.ts";
import { resolveAudienceTagName, type TagNameResolution } from "./shared/kit-apoio-tag.ts";
import type { ApoioNivel } from "./shared/apoio-nivel-types.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Mesmo namespace físico `POLL` do worker `poll` — `workers/artigos/wrangler.toml`
 *  adiciona o binding no mesmo id, e `scripts/lib/poll-kv.ts` usa o mesmo
 *  default (env var override idêntico, pra nunca divergir por engano). */
export const VOTO_TEMA_KV_NAMESPACE_ID = process.env.POLL_KV_NAMESPACE_ID ?? "72784da4ae39444481eb422ebac357c6";

/** Eleitorado da votação — Mantenedor + Patrono (R$25+), decisão do editor
 *  18/09/2026. Mesmo formato de `ARTIGO_ESPECIAL_EMAIL_NIVEIS`. */
export const VOTO_TEMA_NIVEIS: readonly ApoioNivel[] = ["mantenedor", "patrono"];

/** Comando que cria/popula a tag — entra nas mensagens de erro dos guards. */
export const VOTO_TEMA_TAG_SYNC_COMMAND = "npx tsx scripts/sync-apoio-voto-tema-tag-kit.ts --push";

export interface KitVotacaoChannelConfig {
  audience_tag?: string;
}

export interface PlatformConfigSlice {
  kit_votacao?: KitVotacaoChannelConfig;
}

export class VotoTemaGuardError extends Error {}

export function readPlatformConfig(rootDir: string = ROOT): PlatformConfigSlice {
  const path = resolve(rootDir, "platform.config.json");
  if (!existsSync(path)) throw new VotoTemaGuardError(`${path} ausente.`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PlatformConfigSlice;
  } catch (e) {
    throw new VotoTemaGuardError(`${path} não é JSON válido: ${(e as Error).message}`);
  }
}

export function resolveVotoTemaTagName(config: KitVotacaoChannelConfig | undefined | null): TagNameResolution {
  return resolveAudienceTagName(config?.audience_tag, "kit_votacao.audience_tag");
}

export function resolveVotoTemaKvConfig(): CloudflareKVConfig {
  return { kvNamespaceId: VOTO_TEMA_KV_NAMESPACE_ID };
}

// ── I/O do KV (ballot / votos / resultado) ────────────────────────────────

export async function readBallotFromKv(ciclo: string, cfg: CloudflareKVConfig): Promise<BallotTema | null> {
  const raw = await getTextFromWorkerKV(ballotKey(ciclo), cfg);
  if (!raw) return null;
  return JSON.parse(raw) as BallotTema;
}

export async function writeBallotToKv(ciclo: string, ballot: BallotTema, cfg: CloudflareKVConfig): Promise<void> {
  await putTextToWorkerKV(ballotKey(ciclo), JSON.stringify(ballot), { ...cfg, contentType: "application/json" });
}

export async function listVotosFromKv(ciclo: string, cfg: CloudflareKVConfig): Promise<VotoRegistrado[]> {
  const keys = await listWorkerKVKeys(voteKeyPrefix(ciclo), cfg);
  const out: VotoRegistrado[] = [];
  for (const key of keys) {
    const raw = await getTextFromWorkerKV(key, cfg);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<VotoRegistrado>;
      if (typeof parsed.opcao === "number" && typeof parsed.ts === "string") {
        out.push({ opcao: parsed.opcao, ts: parsed.ts });
      }
    } catch {
      // entrada corrompida — ignora, não derruba a apuração inteira
    }
  }
  return out;
}

/** Emails de quem já votou — deriva das keys (`tema:vote:{ciclo}:{email}`)
 *  sem precisar ler o VALOR de cada uma. Usado por `voto-tema-lembrete.ts`
 *  pra saber quem AINDA NÃO votou (eleitorado - votantes). */
export function emailFromVoteKey(ciclo: string, key: string): string {
  return key.slice(voteKeyPrefix(ciclo).length);
}

export interface ResultadoFinal {
  vencedor: number | null;
  empate: boolean;
  contagem: { n: number; titulo: string; votos: number }[];
  total: number;
  fechado_em: string;
}

export async function readResultFromKv(ciclo: string, cfg: CloudflareKVConfig): Promise<ResultadoFinal | null> {
  const raw = await getTextFromWorkerKV(resultKey(ciclo), cfg);
  if (!raw) return null;
  return JSON.parse(raw) as ResultadoFinal;
}

export async function writeResultToKv(ciclo: string, result: ResultadoFinal, cfg: CloudflareKVConfig): Promise<void> {
  await putTextToWorkerKV(resultKey(ciclo), JSON.stringify(result), { ...cfg, contentType: "application/json" });
}

/** Só pra `voto-tema-open.ts` — não é usado pelo worker (que só grava, nunca
 *  compõe a key de escrita de um voto). Reexportado por conveniência dos
 *  scripts que precisam checar `tema:vote:{ciclo}:{email}` diretamente. */
export { voteKey };
