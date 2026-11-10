/**
 * scripts/lib/diaria/youtube-pending-approval.ts (#12122)
 *
 * Marcador `_internal/05-youtube-pending-approval.json`: o `/diaria-publica-video`
 * está mostrando o plano do horizontal ao editor e ainda não ouviu o "pode
 * publicar" (#11741).
 *
 * Desde o #12588 o marcador é só INFORMATIVO: a Etapa 5 não sobe mais vídeo
 * (o `stage5-youtube.ts` só lê o link), então não há mais upload para segurar.
 * Ele entra no texto do Stage 5 quando falta o link, para dizer que o plano do
 * horizontal ficou à espera do "pode publicar".
 *
 * Por que existia: na edição 261104 o `/diaria-5-publicacao` rodou numa sessão
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
 *   - abandono (o editor desistiu do vídeo pela skill): sem efeito desde o
 *     #12588 (o pré-requisito do Passo 0b barra a Etapa 5 pela falta do link,
 *     não pelo marcador). O texto cita a idade do marcador e o D0 já passado
 *     (#12287).
 *
 * Nada aqui lança na leitura: arquivo ilegível conta como presente.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { BRT_TIMEZONE, datePartsInTz, toAammdd } from "../next-edition-date.ts";

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
    log?.(`[aviso] marcador ${path} não apagado (${(e as Error).message}) (#12122; informativo desde o #12588)`);
    return false;
  }
}

/** #12287: marcador mais velho que isto é tratado como provável abandono (só no texto; nunca publica). */
export const PENDING_APPROVAL_STALE_MS = 12 * 60 * 60_000;

/**
 * #12287: o marcador nunca expira sozinho (na dúvida, não publica), mas a
 * idade dele e o D0 já passado vão no texto — um hold esquecido não pode
 * parecer desfecho normal. Puro. `null` = marcador recente, edição por vir.
 */
export function pendingApprovalStaleNote(
  read: Exclude<PendingApprovalRead, { kind: "none" }>,
  aammdd: string,
  now: Date,
): string | null {
  const notes: string[] = [];
  if (read.kind === "pending") {
    const at = Date.parse(read.marker.at);
    if (Number.isFinite(at) && now.getTime() - at > PENDING_APPROVAL_STALE_MS) {
      const hours = Math.floor((now.getTime() - at) / 3_600_000);
      notes.push(`marcador gravado há ${hours}h, provável abandono da skill`);
    }
  }
  if (toAammdd(datePartsInTz(now, BRT_TIMEZONE)) > aammdd) notes.push(`a edição ${aammdd} já passou do D0, o D1 saiu sem o link do vídeo`);
  return notes.length > 0 ? notes.join("; ") : null;
}

/** Texto que o Stage 5 acrescenta quando falta o link e o marcador existe (#12588: informativo). */
export function describePendingApproval(
  read: Exclude<PendingApprovalRead, { kind: "none" }>,
  aammdd: string,
  now?: Date,
): string {
  const since = read.kind === "pending" ? `desde ${read.marker.at} (${read.marker.source})` : `marcador ilegível: ${read.reason}`;
  const stale = now ? pendingApprovalStaleNote(read, aammdd, now) : null;
  return (
    `o /diaria-publica-video ficou com o horizontal à espera do "pode publicar" do editor ${since} (#12122). ` +
    (stale ? `ATENÇÃO (#12287): ${stale}. ` : "") +
    `Responder o "pode publicar" na skill (ou rodar /diaria-publica-video ${aammdd} de novo); ` +
    `vídeo abandonado: marcar a edição sem vídeo (set-d1-no-video.ts ${aammdd})`
  );
}
