/**
 * scripts/lib/diaria/youtube-pending-approval.ts (#12122)
 *
 * Marcador `_internal/05-youtube-pending-approval.json`: o `/diaria-publica-video`
 * está mostrando o plano do horizontal ao editor e ainda não ouviu o "pode
 * publicar" (#11741).
 *
 * Por que existe: na edição 261104 o `/diaria-5-publicacao` rodou numa sessão
 * paralela enquanto a skill de vídeo ainda iterava a capa com o editor. O
 * `stage5-youtube.ts` achou `diaria-comentada-261104.mp4` (baixado pela skill,
 * à espera da confirmação) e subiu o horizontal às 03:50 UTC com a capa
 * intermediária; o "pode publicar" só veio às ~03:53 UTC.
 *
 * Ciclo de vida:
 *   - gravado pelo `publish-youtube.ts --dry-run` (Passo A1 da skill, que roda
 *     antes de toda pergunta de confirmação), salvo quando o vídeo da edição já
 *     está registrado ou o link já foi colado;
 *   - apagado quando o vídeo passa a existir no canal: `publish-youtube.ts
 *     --upload` com registro gravado (enviado agora, já no canal, já
 *     registrado) e `link-video-d1.ts --save` (fallback do Studio);
 *   - abandono (o editor desistiu do vídeo pela skill): o Stage 5 não sobe
 *     sozinho; o editor decide com `stage5-youtube.ts --ignore-pending-approval`
 *     ou apagando o arquivo. Nunca expira por tempo: na dúvida, não publica.
 *
 * Nada aqui lança na leitura: arquivo ilegível conta como presente (o passo do
 * Stage 5 pula o upload e manda conferir), porque o erro seguro é não subir.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";

export const YOUTUBE_PENDING_APPROVAL_FILE = "_internal/05-youtube-pending-approval.json";

export interface YouTubePendingApproval {
  aammdd: string;
  /** ISO do dry-run que gravou o marcador. */
  at: string;
  source: string;
}

export type PendingApprovalRead =
  | { kind: "none" }
  | { kind: "pending"; marker: YouTubePendingApproval }
  /** Arquivo presente mas ilegível ou de outra edição: tratado como presente. */
  | { kind: "unreadable"; reason: string };

export function pendingApprovalPath(editionDir: string): string {
  return join(editionDir, YOUTUBE_PENDING_APPROVAL_FILE);
}

/** Grava o marcador (sobrescreve o anterior com o instante novo). Lança em falha de escrita. */
export function writePendingApproval(editionDir: string, aammdd: string, now: Date, source = "publish-youtube --dry-run"): string {
  const path = pendingApprovalPath(editionDir);
  const marker: YouTubePendingApproval = { aammdd, at: now.toISOString(), source };
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(marker, null, 2) + "\n");
  return path;
}

export function readPendingApproval(editionDir: string, aammdd: string): PendingApprovalRead {
  const path = pendingApprovalPath(editionDir);
  if (!existsSync(path)) return { kind: "none" };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<YouTubePendingApproval> | null;
    if (!raw || typeof raw !== "object" || typeof raw.at !== "string") return { kind: "unreadable", reason: "sem campo at" };
    if (raw.aammdd !== aammdd) return { kind: "unreadable", reason: `é de outra edição: ${JSON.stringify(raw.aammdd ?? null)}` };
    return { kind: "pending", marker: { aammdd: raw.aammdd, at: raw.at, source: typeof raw.source === "string" ? raw.source : "?" } };
  } catch (e) {
    return { kind: "unreadable", reason: (e as Error).message };
  }
}

/** Apaga o marcador. `true` = havia e foi apagado. Nunca lança (falha vira `[aviso]` no `log`). */
export function clearPendingApproval(editionDir: string, log?: (line: string) => void): boolean {
  const path = pendingApprovalPath(editionDir);
  if (!existsSync(path)) return false;
  try {
    rmSync(path, { force: true });
    return true;
  } catch (e) {
    log?.(`[aviso] marcador ${path} não apagado (${(e as Error).message}) — o stage5-youtube.ts vai pular o upload até ele sumir (#12122)`);
    return false;
  }
}

/** Texto do `detail` do Stage 5 quando o marcador segura o upload. */
export function describePendingApproval(read: Exclude<PendingApprovalRead, { kind: "none" }>, aammdd: string): string {
  const since = read.kind === "pending" ? `desde ${read.marker.at} (${read.marker.source})` : `marcador ilegível: ${read.reason}`;
  return (
    `o /diaria-publica-video está com o horizontal à espera do "pode publicar" do editor ${since} (#12122): nada baixado nem enviado. ` +
    `A skill sobe o vídeo depois da confirmação. Se o vídeo pela skill foi abandonado, rodar ` +
    `\`npx tsx scripts/stage5-youtube.ts ${aammdd} --ignore-pending-approval\` (ou apagar ${YOUTUBE_PENDING_APPROVAL_FILE})`
  );
}
