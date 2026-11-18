/**
 * scripts/lib/diaria/video-trecho-fonte.ts (#13437, PR 2)
 *
 * De onde a montagem tira o trecho de outro vídeo (formato react): o EXPORT
 * do horizontal do vídeo de origem, nunca o YouTube (sem yt-dlp nem download
 * do canal: risco de ToS, CLAUDE.md). Ordem de procura, a 1ª que existe vence:
 *
 *   1. `--trecho-fonte "CHAVE=caminho;…"`, com a CHAVE sendo o id da fala, o
 *      id do vídeo no YouTube ou a edição AAMMDD (a chave AAMMDD vale também
 *      para o trecho que cita youtu.be, depois de achar a edição pelo
 *      registro). Caminho explícito que não existe para ali, com `[aviso]`:
 *      a busca automática não o troca em silêncio por outro arquivo;
 *   2. o `video_path` do `_internal/05-youtube-published.json` da edição de
 *      origem (o arquivo que subiu para o canal), lido tanto quando o trecho
 *      cita o id do YouTube quanto quando cita a edição AAMMDD;
 *   3. `diaria-comentada-{AAMMDD}.mp4` na pasta da edição de origem;
 *   4. a pasta de vídeo no Drive (`{raiz}/{AAMMDD}/`): `Final/` e variações,
 *      e, sem `.mp4` lá, `Editado/`/`Editados/`, com a escolha do horizontal
 *      de `selectDriveVideo` (o mesmo critério do `/diaria-publica`: sufixo
 *      `horizontal_V{n}`/`_Youtube_`, versão mais alta em `Editados/`, 2+ em
 *      `Final/` é ambíguo e não se chuta).
 *
 * A edição de origem é o `video` do trecho (AAMMDD) ou a que tem o id do
 * YouTube no `05-youtube-published.json`. Sem fonte, o trecho fica só no
 * marcador do XML, com os caminhos procurados no aviso: a montagem segue.
 *
 * O `texto` do trecho é conferido contra o SRT do vídeo de origem
 * (`avisosTrechosNaMontagem`): divergência, SRT ausente e SRT sem legenda
 * legível viram `[aviso]`; o tempo é sempre o do roteiro.
 *
 * Puro, salvo os defaults de `FonteFs` (o disco desta máquina).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { edicaoDoVideoPublicado, registroDaEdicao, srtDaEdicao, srtDoVideoPublicado, avisosTrechoContraSrt } from "./roteiro-react.ts";
import { parseSrtCues } from "./short-cover-caption.ts";
import { isEditedFolderName, isFinalFolderName, isMp4VideoFile, selectDriveVideo, type DriveVideoFile } from "./drive-video-source.ts";
import type { TrechoInseridoLido } from "./trecho-inserido-formato.ts";
import type { TrechoEncoder } from "./video-xml-trechos.ts";
import type { FalaRoteiro } from "./roteiro-gravacao.ts";

/** O que a procura lê do disco (injetável nos testes). */
export interface FonteFs {
  exists: (p: string) => boolean;
  /** Entradas de uma pasta; pasta ausente ou ilegível = `[]`. */
  list: (dir: string) => Array<{ name: string; dir: boolean; mtimeMs: number; size: number }>;
}

export const DEFAULT_FONTE_FS: FonteFs = {
  exists: existsSync,
  list: (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((d) => {
        let mtimeMs = 0;
        let size = 0;
        try {
          const st = statSync(join(dir, d.name));
          mtimeMs = st.mtimeMs;
          size = st.size;
        } catch {
          /* sem stat: data e tamanho zerados, o nome ainda decide */
        }
        return { name: d.name, dir: d.isDirectory(), mtimeMs, size };
      });
    } catch {
      return [];
    }
  },
};

/**
 * `--trecho-fonte "CHAVE=caminho;CHAVE=caminho"` (#13437): `;` separa as
 * entradas (caminho do Windows não tem `;`). Ausente = `{}`. Entrada sem `=`
 * ou com lado vazio lança.
 */
export function parseTrechoFonteArg(v: string | undefined): Record<string, string> {
  if (v === undefined) return {};
  const out: Record<string, string> = {};
  for (const raw of v.split(";")) {
    const e = raw.trim();
    if (!e) continue;
    const i = e.indexOf("=");
    const k = i > 0 ? e.slice(0, i).trim() : "";
    const p = i > 0 ? e.slice(i + 1).trim() : "";
    if (!k || !p) throw new Error(`--trecho-fonte: entrada "${e}" deve ser CHAVE=caminho (CHAVE = id da fala, id do vídeo no YouTube ou AAMMDD; entradas separadas por ;) (#13437)`);
    out[k] = p;
  }
  return out;
}

/** O resultado da procura: o arquivo (ou `null`) e o que foi olhado, na ordem. */
export interface FonteTrecho {
  fonte: string | null;
  /** A edição de origem, quando achada. */
  edicao: string | null;
  /** Os lugares olhados (com o motivo de cada um não servir), para o aviso e o `roteiro.md`. */
  procurado: string[];
  /** Premissa da escolha no Drive (versão mais alta em `Editados/`), quando houver. */
  premissa?: string;
  /** `--trecho-fonte` apontou um arquivo que não existe: a procura parou ali, sem a busca automática. */
  explicitoAusente?: true;
}

/** A pasta da edição AAMMDD sob a raiz das edições (`{AAMM}/{AAMMDD}`). */
const editionDirIn = (root: string, ed: string): string => join(root, ed.slice(0, 4), ed);

/**
 * Procura a fonte de um trecho (ordem no cabeçalho). Puro sobre `fs`; `now`
 * só entra no `selectDriveVideo` (a janela da raiz, que aqui nunca vale: a
 * subpasta da edição é sempre a consultada).
 */
export function resolverFonteTrecho(input: {
  id: string;
  trecho: Pick<TrechoInseridoLido, "youtubeId" | "edicao" | "video">;
  fontes: Readonly<Record<string, string>>;
  editionsRootDir: string;
  /** Raiz da pasta de vídeo no Drive (`I:/Meu Drive/diaria-studio-video` no Neo); `null` = sem Drive nesta máquina. */
  driveRoot: string | null;
  fs?: FonteFs;
  now?: Date;
}): FonteTrecho {
  const fs = input.fs ?? DEFAULT_FONTE_FS;
  const procurado: string[] = [];
  const t = input.trecho;
  // `--trecho-fonte` explícito: existe = vence; ausente = para ali (o editor apontou um arquivo, a busca
  // automática não o substitui em silêncio por outro).
  const explicito = (keys: ReadonlyArray<string | null | undefined>, edicao: string | null): FonteTrecho | null => {
    for (const k of keys) {
      if (!k || input.fontes[k] === undefined) continue;
      const p = input.fontes[k];
      if (fs.exists(p)) return { fonte: p, edicao, procurado };
      procurado.push(`--trecho-fonte ${k}=${p} (não existe nesta máquina; com caminho explícito a busca automática não roda: corrigir o caminho)`);
      return { fonte: null, edicao, procurado, explicitoAusente: true };
    }
    return null;
  };
  const direto = explicito([input.id, t.youtubeId, t.edicao], t.edicao);
  if (direto) return direto;
  let edicao = t.edicao;
  let registro: string | null = null;
  if (!edicao && t.youtubeId) {
    const pub = edicaoDoVideoPublicado(input.editionsRootDir, t.youtubeId);
    if (!pub) {
      procurado.push(`a edição do vídeo ${t.youtubeId} (nenhum _internal/05-youtube-published.json com esse videoId em ${input.editionsRootDir})`);
      return { fonte: null, edicao: null, procurado };
    }
    edicao = pub.edicao;
    registro = pub.videoPath;
    // A chave AAMMDD de `--trecho-fonte` também vale para o trecho que cita youtu.be (a edição veio do registro).
    const porEdicao = explicito([edicao], edicao);
    if (porEdicao) return porEdicao;
    if (!registro) procurado.push(`o video_path do 05-youtube-published.json de ${edicao} (registro sem video_path)`);
  } else if (edicao) {
    // Trecho que cita a edição AAMMDD: o registro de publicação dela também diz qual export subiu.
    const reg = registroDaEdicao(input.editionsRootDir, edicao);
    registro = reg.videoPath;
    if (!reg.registro) procurado.push(`${reg.path} (registro de publicação ausente ou ilegível)`);
    else if (!registro) procurado.push(`${reg.path} (registro sem video_path)`);
  }
  if (!edicao) return { fonte: null, edicao: null, procurado: [...procurado, `o vídeo ${t.video} (nem id do YouTube nem edição)`] };
  if (registro) {
    if (fs.exists(registro)) return { fonte: registro, edicao, procurado };
    procurado.push(`${registro} (video_path do 05-youtube-published.json de ${edicao}, ausente nesta máquina)`);
  }
  const local = join(editionDirIn(input.editionsRootDir, edicao), `diaria-comentada-${edicao}.mp4`);
  if (fs.exists(local)) return { fonte: local, edicao, procurado };
  procurado.push(`${local} (ausente)`);
  if (input.driveRoot === null) {
    procurado.push(`a pasta de vídeo no Drive (sem a raiz nesta máquina: rodar no Neo, com o Drive em I:)`);
    return { fonte: null, edicao, procurado };
  }
  const drive = fonteNoDrive(join(input.driveRoot, edicao), fs, input.now ?? new Date());
  if (drive.fonte) return { fonte: drive.fonte, edicao, procurado, ...(drive.premissa ? { premissa: drive.premissa } : {}) };
  procurado.push(drive.motivo);
  return { fonte: null, edicao, procurado };
}

/**
 * O horizontal exportado na pasta da edição no Drive (`{raiz}/{AAMMDD}/`):
 * `Final/` (e variações) primeiro; sem `.mp4` em nenhuma delas, `Editado/` e
 * variações. Escolha por `selectDriveVideo` (destino `youtube`).
 */
export function fonteNoDrive(edDir: string, fs: FonteFs, now: Date): { fonte: string | null; motivo: string; premissa?: string } {
  if (!fs.exists(edDir)) return { fonte: null, motivo: `${edDir} (pasta da edição ausente no Drive)` };
  const subs = fs.list(edDir).filter((e) => e.dir);
  const filesOf = (names: string[], edited: boolean): Array<DriveVideoFile & { path: string }> =>
    names.flatMap((sub) =>
      fs.list(join(edDir, sub))
        .filter((e) => !e.dir)
        .map((e) => ({
          id: join(edDir, sub, e.name),
          path: join(edDir, sub, e.name),
          name: e.name,
          mimeType: "",
          modifiedTime: new Date(e.mtimeMs).toISOString(),
          size: String(e.size),
          scope: "final-folder" as const,
          folderName: sub,
          ...(edited ? { editedFolder: true } : {}),
        }))
        .filter((f) => isMp4VideoFile(f)),
    );
  let pool = filesOf(subs.filter((s) => isFinalFolderName(s.name)).map((s) => s.name), false);
  if (!pool.length) pool = filesOf(subs.filter((s) => isEditedFolderName(s.name)).map((s) => s.name), true);
  if (!pool.length) return { fonte: null, motivo: `${edDir}/Final/ e Editado/ (nenhum .mp4)` };
  const sel = selectDriveVideo(pool, { orientation: "horizontal", now, editionFolderPresent: true, target: "youtube" });
  if (sel.kind === "found") {
    const f = sel.file as DriveVideoFile & { path?: string };
    return { fonte: f.path ?? f.id, motivo: "", ...(sel.premise ? { premissa: sel.premise } : {}) };
  }
  if (sel.kind === "ambiguous") return { fonte: null, motivo: `${edDir}: horizontal ambíguo (${sel.candidates.map((c) => c.name).join(", ")}); escolher com --trecho-fonte` };
  return { fonte: null, motivo: `${edDir}: ${"reason" in sel ? sel.reason : "sem horizontal"}` };
}

/** Nome do clipe cortado no out dir: `{AAMMDD}_trecho_{fala}-{hash}.mov` (o hash muda com a fonte e o intervalo). */
export function trechoInseridoFileName(edition: string, id: string, hash: string): string {
  return `${edition}_trecho_${id.replace(/[^\w-]/g, "_")}-${hash}.mov`;
}

/**
 * Argumentos do ffmpeg do corte do trecho: seek exato com recodificação, o
 * intervalo do roteiro, no tamanho da sequência (encaixado, com faixa preta se
 * a proporção diferir) e CFR no fps dela (o XML conta quadros), H.264 com GOP
 * curto e PCM 48 kHz, como os trechos do XML leve (#13219). MOV forçado, para
 * a saída poder ser um `.part`.
 */
export function trechoInseridoEncodeArgs(input: {
  src: string;
  out: string;
  inicioS: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  encoder: TrechoEncoder;
}): string[] {
  const { width: W, height: H } = input;
  const video = input.encoder === "h264_nvenc"
    ? ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "19", "-b:v", "0"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19"];
  return [
    "-hide_banner", "-v", "error", "-y",
    "-ss", input.inicioS.toFixed(6), "-i", input.src, "-t", (input.frames / input.fps).toFixed(6),
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    "-fps_mode", "cfr", "-r", String(input.fps),
    ...video, "-g", "15", "-bf", "0", "-pix_fmt", "yuv420p",
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
    "-f", "mov", input.out,
  ];
}

/**
 * O `texto` de cada trecho contra o SRT do vídeo de origem (`avisosTrechoContraSrt`
 * do roteiro, #13433), na montagem: divergência é `[aviso]`, nunca muda o
 * intervalo (o tempo é o do roteiro, nunca inventado). Sem SRT, ou com SRT
 * sem nenhuma legenda legível, o aviso diz que o texto não foi conferido.
 */
export function avisosTrechosNaMontagem(
  trechos: ReadonlyArray<{ id: string; trecho: TrechoInseridoLido }>,
  editionsRootDir: string,
  srt: (t: Pick<TrechoInseridoLido, "youtubeId" | "edicao">) => string | null = (t) =>
    t.edicao ? srtDaEdicao(editionsRootDir, t.edicao) : t.youtubeId ? srtDoVideoPublicado(editionsRootDir, t.youtubeId) : null,
): string[] {
  const avisos: string[] = [];
  const falas = trechos.map((t) => ({
    id: t.id,
    videos: ["horizontal"],
    trechoInserido: { video: t.trecho.video, inicio: t.trecho.inicioS, fim: t.trecho.fimS, texto: t.trecho.texto },
  })) as unknown as FalaRoteiro[];
  for (const t of trechos) {
    const s = srt(t.trecho);
    const nome = t.trecho.youtubeId ?? t.trecho.edicao;
    // SRT ausente ou sem legenda legível: `avisosTrechoContraSrt` pula os dois em silêncio, então o aviso é daqui.
    if (s === null) avisos.push(`${t.id}: sem o SRT do vídeo ${nome} (diaria-comentada-{AAMMDD}.srt na edição de origem): trechoInserido.texto não conferido contra a legenda (#13437)`);
    else if (!parseSrtCues(s).length) avisos.push(`${t.id}: o SRT do vídeo ${nome} não tem legenda legível (nenhum cue): trechoInserido.texto não conferido contra a legenda (#13437)`);
  }
  return [...avisos, ...avisosTrechoContraSrt({ falas }, srt)];
}
