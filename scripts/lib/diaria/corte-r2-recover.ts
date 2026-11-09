/**
 * scripts/lib/diaria/corte-r2-recover.ts (#12473)
 *
 * O timer do corte avulso (`scripts/shorts-corte-timer.ts`, no 300) exige o
 * vídeo e a capa do corte na pasta `data/cortes/{slug}/` para conferir o
 * sha256 contra o "pode publicar" (#11912). Os arquivos chegam ao 300 pelo
 * OneDrive, e em 08/11/2026 o mp4 de 93 MB do corte `modelos-chatgpt-261108`
 * não chegou: o `corte.json`, a capa e o registro sincronizaram, o vídeo não,
 * e Instagram, LinkedIn e Threads pessoais ficaram ~1h50 atrasados (alarmes
 * `missing-video`, contorno manual por scp).
 *
 * O vídeo já estava no R2: os destinos da API (YouTube/Facebook/X/TikTok)
 * publicados no Neo sobem o vertical em `shorts/cortes/{slug}.mp4`
 * (`corteR2Key`). Quando o arquivo local falta, o timer baixa o objeto do R2
 * pela API S3 assinada (nunca pela URL pública, que pode servir cache velho),
 * confere o sha256 dos bytes contra o aprovado e só então grava o arquivo na
 * pasta do corte (escrita atômica). Hash diferente, objeto ausente ou erro de
 * leitura não gravam nada: o timer segue para o alarme `missing-video` de
 * sempre, com o motivo do R2 no texto.
 *
 * A gravação na pasta do corte é o mesmo contorno manual da issue (scp para a
 * pasta), e o arquivo gravado é byte a byte o aprovado: quando a cópia do
 * OneDrive chegar, o conteúdo é o mesmo.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { R2_PUT_TIMEOUT_MS, signedR2Request, type R2BucketAccess, type R2UploadDeps } from "../r2-object-upload.ts";
import { sha256Bytes } from "./corte-content.ts";
import { corteR2Key, resolveCorteVideo, type CorteSpec } from "./short-corte.ts";
import { SHORT_COVER_FILE } from "./short-cover.ts";

export type CorteRecoverFile = "video" | "cover";

export type CorteR2RecoverOutcome =
  | { file: CorteRecoverFile; kind: "recovered"; key: string; path: string; bytes: number }
  | { file: CorteRecoverFile; kind: "failed"; key: string; reason: string };

export interface CorteR2RecoverDeps extends R2UploadDeps {
  config: R2BucketAccess;
}

/** O arquivo local está presente? Capa vazia conta como ausente (como em `corteContentFingerprint`). */
function presentLocally(path: string, file: CorteRecoverFile): boolean {
  if (!existsSync(path)) return false;
  return file === "video" || statSync(path).size > 0;
}

/** Caminho dentro da pasta do corte? (vídeo fora de `data/` nunca é escrito pelo timer). */
function insideDir(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Baixa do R2 o vídeo e/ou a capa APROVADOS do corte que faltam nesta
 * máquina. Só age em arquivo ausente com sha256 aprovado
 * (`publish_confirmed_content`); arquivo presente (igual ou diferente do
 * aprovado) nunca é tocado: a conferência de conteúdo do timer decide. Devolve
 * um desfecho por arquivo tentado (lista vazia = nada a recuperar).
 */
export async function recoverCorteFilesFromR2(dir: string, spec: CorteSpec, deps: CorteR2RecoverDeps): Promise<CorteR2RecoverOutcome[]> {
  const approved = spec.publish_confirmed_content;
  if (!approved) return [];
  const targets: Array<{ file: CorteRecoverFile; path: string; sha: string | null }> = [
    { file: "video", path: resolveCorteVideo(dir, spec.video), sha: approved.video_sha256 },
    { file: "cover", path: join(dir, SHORT_COVER_FILE), sha: approved.cover_sha256 },
  ];
  const out: CorteR2RecoverOutcome[] = [];
  for (const t of targets) {
    if (!t.sha || presentLocally(t.path, t.file)) continue;
    const key = corteR2Key(spec.slug, t.file);
    if (!insideDir(dir, t.path)) {
      out.push({ file: t.file, kind: "failed", key, reason: `${t.path} fica fora da pasta do corte: o timer não grava ali` });
      continue;
    }
    let res: Response;
    try {
      res = await signedR2Request(deps, deps.config, "GET", key, { timeoutMs: R2_PUT_TIMEOUT_MS });
    } catch (e) {
      out.push({ file: t.file, kind: "failed", key, reason: `leitura do R2 falhou: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    if (!res.ok) {
      out.push({ file: t.file, kind: "failed", key, reason: res.status === 404 ? "objeto não está no R2" : `R2 respondeu HTTP ${res.status}` });
      continue;
    }
    let body: Buffer;
    try {
      body = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      out.push({ file: t.file, kind: "failed", key, reason: `download do R2 interrompido: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    const got = sha256Bytes(body);
    if (got !== t.sha) {
      out.push({ file: t.file, kind: "failed", key, reason: `o objeto do R2 não é o arquivo aprovado (sha256 ${got?.slice(0, 12)} ≠ ${t.sha.slice(0, 12)}): nada gravado` });
      continue;
    }
    writeFileAtomic(t.path, body);
    out.push({ file: t.file, kind: "recovered", key, path: t.path, bytes: body.length });
  }
  return out;
}
