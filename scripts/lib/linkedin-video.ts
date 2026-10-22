/**
 * linkedin-video.ts (#10772 — vertical nativo no perfil pessoal do LinkedIn)
 *
 * Upload de vídeo pela Videos API da LinkedIn (REST versionada) e o post com o
 * vídeo no perfil pessoal, com o MESMO app e token do 4º post
 * (`linkedin-personal.ts`, escopo `w_member_social` — que cobre vídeo; nenhum
 * segredo novo). Sequência documentada da API:
 *
 *   1. `POST /rest/videos?action=initializeUpload` com `owner` (a URN da
 *      pessoa) e `fileSizeBytes` → `video` (URN) + `uploadInstructions`
 *      (uma URL por parte, com `firstByte`/`lastByte`) + `uploadToken`;
 *   2. `PUT` de cada parte na sua URL — o `ETag` de cada resposta é o id da
 *      parte;
 *   3. `POST /rest/videos?action=finalizeUpload` com os ids das partes;
 *   4. `GET /rest/videos/{urn}` até `AVAILABLE` (`PROCESSING_FAILED` aborta);
 *   5. `POST /rest/posts` com `content.media.id` = a URN do vídeo
 *      (`postToPersonalProfile`).
 *
 * Até o passo 4 nada aparece no perfil: qualquer falha ali é `before_send` e
 * pode ser re-tentada. A classificação do passo 5 (`ambiguous` em timeout/5xx)
 * é a do `postToPersonalProfile` — o caller registra `send_unknown` e nunca
 * re-tenta sozinho.
 *
 * A Posts API não agenda: o vídeo sai na hora em que o passo 5 roda. Quem
 * escolhe a hora é o `publish-shorts.ts` (pendente até o horário do vertical).
 *
 * Tudo recebe `fetchFn`/`sleep` injetados — os testes nunca chamam a LinkedIn.
 */

import { HTTP_TIMEOUT_MS, REVOKED_REASON, postToPersonalProfile, restHeaders, type FetchFn, type PersonalCreds, type PostResult } from "./linkedin-personal.ts";

export const LINKEDIN_VIDEOS_INIT_URL = "https://api.linkedin.com/rest/videos?action=initializeUpload";
export const LINKEDIN_VIDEOS_FINALIZE_URL = "https://api.linkedin.com/rest/videos?action=finalizeUpload";

export function linkedInVideoUrl(videoUrn: string): string {
  return `https://api.linkedin.com/rest/videos/${encodeURIComponent(videoUrn)}`;
}

/** Espera pelo processamento: 60 × 10 s = 10 min (vertical de ~2 min processa bem antes). */
export const LINKEDIN_VIDEO_POLL_ATTEMPTS = 60;
export const LINKEDIN_VIDEO_POLL_INTERVAL_MS = 10_000;
/** PUT de parte (~4 MB) pode demorar mais que uma chamada comum. */
export const LINKEDIN_VIDEO_PART_TIMEOUT_MS = 120_000;

export interface UploadInstruction {
  uploadUrl: string;
  firstByte: number;
  lastByte: number;
}

/**
 * Pure: as partes cobrem o arquivo inteiro, contíguas e sem sobreposição?
 * Instrução fora disso subiria um vídeo corrompido — recusa antes do 1º PUT.
 */
export function validateUploadInstructions(instr: unknown, fileSize: number): UploadInstruction[] {
  if (!Array.isArray(instr) || instr.length === 0) throw new Error("initializeUpload sem uploadInstructions");
  const parts = instr.map((p, i) => {
    const u = p as Partial<UploadInstruction>;
    if (typeof u?.uploadUrl !== "string" || !/^https:\/\//.test(u.uploadUrl) || !Number.isInteger(u.firstByte) || !Number.isInteger(u.lastByte)) {
      throw new Error(`uploadInstructions[${i}] malformada`);
    }
    return { uploadUrl: u.uploadUrl, firstByte: u.firstByte as number, lastByte: u.lastByte as number };
  });
  const sorted = [...parts].sort((a, b) => a.firstByte - b.firstByte);
  let next = 0;
  for (const p of sorted) {
    if (p.firstByte !== next || p.lastByte < p.firstByte) throw new Error(`uploadInstructions não contíguas (esperado byte ${next}, veio ${p.firstByte}-${p.lastByte})`);
    next = p.lastByte + 1;
  }
  if (next !== fileSize) throw new Error(`uploadInstructions cobrem ${next} bytes, o arquivo tem ${fileSize}`);
  return sorted;
}

export interface LinkedInVideoDeps {
  fetchFn: FetchFn;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

type UploadResult = { ok: true; videoUrn: string } | { ok: false; reason: string; revoked?: boolean };

const timeout = (ms: number, init: RequestInit = {}): RequestInit => ({ ...init, signal: AbortSignal.timeout(ms) });

async function readJson(res: Response): Promise<any> {
  const text = await res.text().catch(() => "");
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

/** Passos 1-4. Nunca lança: falha é sempre `before_send` (nada no perfil ainda). */
export async function uploadLinkedInVideo(deps: LinkedInVideoDeps, creds: PersonalCreds, apiVersion: string, bytes: Uint8Array): Promise<UploadResult> {
  try {
    const init = await deps.fetchFn(
      LINKEDIN_VIDEOS_INIT_URL,
      timeout(HTTP_TIMEOUT_MS, {
        method: "POST",
        headers: restHeaders(creds.accessToken, apiVersion),
        body: JSON.stringify({
          initializeUploadRequest: { owner: creds.personUrn, fileSizeBytes: bytes.length, uploadCaptions: false, uploadThumbnail: false },
        }),
      }),
    );
    if (init.status === 401 || init.status === 403) return { ok: false, reason: REVOKED_REASON, revoked: true };
    const { json, text } = await readJson(init);
    const value = json?.value;
    if (!init.ok || typeof value?.video !== "string") return { ok: false, reason: `initializeUpload (vídeo) falhou (HTTP ${init.status}): ${text.slice(0, 200)}` };
    let parts: UploadInstruction[];
    try {
      parts = validateUploadInstructions(value.uploadInstructions, bytes.length);
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    const etags: string[] = [];
    for (const [i, p] of parts.entries()) {
      const put = await deps.fetchFn(
        p.uploadUrl,
        timeout(LINKEDIN_VIDEO_PART_TIMEOUT_MS, {
          method: "PUT",
          headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/octet-stream" },
          body: bytes.subarray(p.firstByte, p.lastByte + 1) as unknown as BodyInit,
        }),
      );
      const etag = put.headers.get("etag");
      if (!put.ok || !etag) return { ok: false, reason: `upload da parte ${i + 1}/${parts.length} falhou (HTTP ${put.status}${etag ? "" : ", sem ETag"})` };
      etags.push(etag);
    }
    const fin = await deps.fetchFn(
      LINKEDIN_VIDEOS_FINALIZE_URL,
      timeout(HTTP_TIMEOUT_MS, {
        method: "POST",
        headers: restHeaders(creds.accessToken, apiVersion),
        body: JSON.stringify({ finalizeUploadRequest: { video: value.video, uploadToken: value.uploadToken ?? "", uploadedPartIds: etags } }),
      }),
    );
    if (!fin.ok) return { ok: false, reason: `finalizeUpload falhou (HTTP ${fin.status}): ${(await fin.text().catch(() => "")).slice(0, 200)}` };
    for (let i = 0; i < LINKEDIN_VIDEO_POLL_ATTEMPTS; i++) {
      let status: string | undefined;
      try {
        const res = await deps.fetchFn(linkedInVideoUrl(value.video), timeout(HTTP_TIMEOUT_MS, { headers: restHeaders(creds.accessToken, apiVersion) }));
        status = (await readJson(res)).json?.status;
      } catch (e) {
        deps.log(`[aviso] linkedin_profile: status do vídeo falhou (${(e as Error).message}) — tentando de novo`);
      }
      if (status === "AVAILABLE") return { ok: true, videoUrn: value.video };
      if (status === "PROCESSING_FAILED") return { ok: false, reason: `a LinkedIn recusou o vídeo ${value.video} no processamento (PROCESSING_FAILED)` };
      await deps.sleep(LINKEDIN_VIDEO_POLL_INTERVAL_MS);
    }
    // Sem AVAILABLE não posta: o post de um vídeo que nunca termina de processar fica quebrado no perfil.
    return { ok: false, reason: `vídeo ${value.video} não ficou AVAILABLE em ${(LINKEDIN_VIDEO_POLL_ATTEMPTS * LINKEDIN_VIDEO_POLL_INTERVAL_MS) / 60_000} min — rode de novo (nada foi postado)` };
  } catch (e) {
    return { ok: false, reason: `upload do vídeo: erro de rede: ${(e as Error).message}` };
  }
}

/** Passos 1-5: sobe o vertical e posta no perfil pessoal. Nunca lança. */
export async function postVideoToPersonalProfile(args: {
  deps: LinkedInVideoDeps;
  creds: PersonalCreds;
  apiVersion: string;
  text: string;
  title: string;
  bytes: Uint8Array;
}): Promise<PostResult> {
  const up = await uploadLinkedInVideo(args.deps, args.creds, args.apiVersion, args.bytes);
  if (!up.ok) return { ok: false, phase: "before_send", reason: up.reason, ...(up.revoked ? { revoked: true } : {}) };
  return postToPersonalProfile({
    fetchFn: args.deps.fetchFn,
    creds: args.creds,
    apiVersion: args.apiVersion,
    text: args.text,
    media: { id: up.videoUrn, title: args.title },
  });
}
