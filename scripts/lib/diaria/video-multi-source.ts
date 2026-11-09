/**
 * Bruto em vários arquivos (#12559), portado de `vjpixel/edicao-video`
 * (`scripts/lib/core.ts`: `SourceFile`, `sourceFiles`, `fileIndexAtFrame`,
 * `fileBounds`) e estendido para o caso da diar.ia.br:
 *
 *   - os arquivos são concatenados numa linha do tempo ÚNICA (todo tempo do
 *     projeto é global: transcrição, itens do `blocks.json`, quadros do plano);
 *     `offsetFrames` leva ao arquivo, e o XML usa quadros locais dele;
 *   - a ordem da linha do tempo é a de GRAVAÇÃO (`creation_time` do ffprobe,
 *     o nome só desempata). A ordem da EDIÇÃO continua vindo do `blocks.json`
 *     (ordem dos blocos e dos itens), nunca da ordem dos arquivos;
 *   - diferente do edicao-video, os arquivos podem ter resolução e orientação
 *     diferentes (vertical 1080x1920 junto de horizontal 1920x1080): cada
 *     arquivo guarda a sua, e o enquadramento de cada clipe usa a do arquivo
 *     dele. fps diferente continua sendo erro (o XML tem um timebase só).
 *
 * Bruto único não ganha `files` no `source.json`: tudo que lê o bruto segue
 * idêntico (regressão coberta em `test/video-montage-multi-source-12559.test.ts`).
 */

export interface SourceFile {
  /** Identidade do arquivo no projeto: o nome sem extensão (único; repetido ganha sufixo `-2`). Usado em `source` de item/sequência. */
  id: string;
  /** Caminho local, com `/`. */
  path: string;
  /** Primeiro quadro do arquivo na linha do tempo global. */
  offsetFrames: number;
  frames: number;
  /** Tamanho exibido (rotação de metadado já aplicada). */
  width: number;
  height: number;
  /** Espelhamento lido do metadado da câmera deste arquivo (o `blocks.json` sobrepõe). */
  mirrored?: boolean;
  /** `creation_time` do ffprobe (ISO), quando o arquivo traz. */
  creationTime?: string;
}

/** O mínimo do `SourceInfo` que estas funções leem (sem importar `video-montage.ts`, que importa este módulo). */
export interface MultiSourceLike {
  path: string;
  fps: number;
  durationS: number;
  width: number;
  height: number;
  mirrored?: boolean;
  files?: SourceFile[];
}

export interface Span {
  start: number;
  end: number;
}

const baseName = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p;
const stem = (p: string) => baseName(p).replace(/\.[^.]+$/, "");

/** Bruto em vários arquivos? (`files` com 2+ entradas). Um arquivo só se comporta como o bruto único de sempre. */
export function isMultiSource(src: Pick<MultiSourceLike, "files">): boolean {
  return (src.files?.length ?? 0) > 1;
}

/** Os arquivos do bruto; o bruto único vira uma lista de um. */
export function sourceFiles(src: MultiSourceLike): SourceFile[] {
  if (src.files?.length) return src.files;
  return [{ id: stem(src.path), path: src.path, offsetFrames: 0, frames: Math.round(src.durationS * src.fps), width: src.width, height: src.height, ...(src.mirrored !== undefined ? { mirrored: src.mirrored } : {}) }];
}

/** Índice do arquivo que contém o quadro global `frame` (o último quando passa do fim). */
export function fileIndexAtFrame(src: MultiSourceLike, frame: number): number {
  const fs = sourceFiles(src);
  for (let i = fs.length - 1; i >= 0; i--) if (frame >= fs[i].offsetFrames) return i;
  return 0;
}

/** Índice do arquivo que contém o tempo global `t` (s). */
export function fileIndexAtTime(src: MultiSourceLike, t: number): number {
  return fileIndexAtFrame(src, Math.floor(t * src.fps + 1e-6));
}

/** Tempo global (s) → arquivo e tempo local nele. */
export function locateTime(src: MultiSourceLike, t: number): { file: SourceFile; index: number; localS: number } {
  const fs = sourceFiles(src);
  const index = fileIndexAtTime(src, t);
  const file = fs[index];
  return { file, index, localS: Math.max(0, t - file.offsetFrames / src.fps) };
}

/** Limites de cada arquivo em segundos globais. */
export function fileBounds(src: MultiSourceLike): Span[] {
  return sourceFiles(src).map((f) => ({ start: f.offsetFrames / src.fps, end: (f.offsetFrames + f.frames) / src.fps }));
}

/** Índice do arquivo pelo `id` (ou pelo nome do arquivo, com ou sem extensão); -1 se não existe. */
export function fileIndexById(src: MultiSourceLike, id: string): number {
  const fs = sourceFiles(src);
  const i = fs.findIndex((f) => f.id === id);
  if (i >= 0) return i;
  return fs.findIndex((f) => baseName(f.path) === id || stem(f.path) === id);
}

/** O arquivo é vertical (mais alto que largo)? */
export function isVerticalFile(f: Pick<SourceFile, "width" | "height">): boolean {
  return f.height > f.width;
}

/** Um arquivo medido pelo ffprobe, antes de entrar na linha do tempo. */
export interface ProbedFile {
  path: string;
  fps: number;
  durationS: number;
  width: number;
  height: number;
  mirrored?: boolean;
  creationTime?: string;
}

export type FileOrder = "gravacao" | "dada";

/**
 * Vários arquivos medidos → uma linha do tempo. `order: "gravacao"` (default)
 * ordena por `creation_time` (o nome desempata, e arquivo sem data vai para o
 * fim na ordem do nome); `"dada"` mantém a ordem recebida (o `--source` com a
 * lista na ordem que o editor escolheu). fps diferente é erro; resolução
 * diferente só avisa (cada clipe usa a do seu arquivo).
 */
export function combineSourceFiles(
  probed: ProbedFile[],
  opts: { order?: FileOrder } = {},
): { ok: true; source: MultiSourceLike & { files: SourceFile[] }; warnings: string[] } | { ok: false; errors: string[] } {
  if (probed.length < 2) return { ok: false, errors: ["bruto em vários arquivos precisa de 2 ou mais arquivos"] };
  const errors: string[] = [];
  const warnings: string[] = [];
  const fps = probed[0].fps;
  for (const p of probed) if (p.fps !== fps) errors.push(`${baseName(p.path)}: ${p.fps} fps, diferente de ${fps} fps de ${baseName(probed[0].path)} (o XML tem um timebase só; converta antes)`);
  if (errors.length) return { ok: false, errors };
  const ordered = (opts.order ?? "gravacao") === "dada" ? [...probed] : sortByRecording(probed);
  const ids = new Map<string, number>();
  let offset = 0;
  const files: SourceFile[] = ordered.map((p) => {
    const base = stem(p.path);
    const n = (ids.get(base) ?? 0) + 1;
    ids.set(base, n);
    const frames = Math.round(p.durationS * fps);
    const f: SourceFile = {
      id: n === 1 ? base : `${base}-${n}`,
      path: p.path,
      offsetFrames: offset,
      frames,
      width: p.width,
      height: p.height,
      ...(p.mirrored !== undefined ? { mirrored: p.mirrored } : {}),
      ...(p.creationTime ? { creationTime: p.creationTime } : {}),
    };
    offset += frames;
    return f;
  });
  const sizes = new Set(files.map((f) => `${f.width}x${f.height}`));
  if (sizes.size > 1) warnings.push(`arquivos com tamanhos diferentes (${[...sizes].join(", ")}): cada clipe é enquadrado pelo tamanho do próprio arquivo; vertical em sequência horizontal usa o encaixe (fit/fill/blur-fill) do item ou da sequência`);
  const noDate = files.filter((f) => !f.creationTime);
  if ((opts.order ?? "gravacao") === "gravacao" && noDate.length) warnings.push(`sem creation_time em ${noDate.map((f) => baseName(f.path)).join(", ")}: ordenados pelo nome depois dos datados (confira a ordem de gravação; --source com a lista na ordem e --ordem dada sobrepõe)`);
  const first = files[0];
  return {
    ok: true,
    source: { path: first.path, fps, durationS: Math.round((offset / fps) * 1000) / 1000, width: first.width, height: first.height, ...(first.mirrored !== undefined ? { mirrored: first.mirrored } : {}), files },
    warnings,
  };
}

/** Ordem de gravação: `creation_time` crescente, nome como desempate; sem data no fim, pelo nome. */
export function sortByRecording<T extends { path: string; creationTime?: string }>(files: T[]): T[] {
  const t = (x: T) => (x.creationTime ? Date.parse(x.creationTime) : NaN);
  return [...files].sort((a, b) => {
    const ta = t(a);
    const tb = t(b);
    const aOk = Number.isFinite(ta);
    const bOk = Number.isFinite(tb);
    if (aOk && bOk && ta !== tb) return ta - tb;
    if (aOk !== bOk) return aOk ? -1 : 1;
    return baseName(a.path).localeCompare(baseName(b.path), "pt-BR", { numeric: true });
  });
}

type ProbeJson = {
  streams?: Array<{ codec_type?: string; width?: number; height?: number; tags?: Record<string, unknown>; side_data_list?: Array<Record<string, unknown>> }>;
  format?: { tags?: Record<string, unknown> };
};

/**
 * O que o `parseProbe` não lia (#12559): `creation_time` (ordem de gravação) e
 * a rotação do metadado (celular gravando "em pé" guarda 1920x1080 com
 * rotação 90: o tamanho exibido, que o ffmpeg e o Premiere usam, é 1080x1920).
 */
export function probeExtras(json: string): { creationTime?: string; rotation: number } {
  const j = JSON.parse(json) as ProbeJson;
  const v = j.streams?.find((s) => s.codec_type === "video");
  const ct = [j.format?.tags?.creation_time, j.format?.tags?.["com.apple.quicktime.creationdate"], v?.tags?.creation_time].find((x) => typeof x === "string" && !Number.isNaN(Date.parse(x as string))) as string | undefined;
  let rotation = 0;
  const rotTag = v?.tags?.rotate;
  if (typeof rotTag === "string" || typeof rotTag === "number") rotation = Number(rotTag);
  const sd = v?.side_data_list?.find((d) => typeof d.rotation === "number");
  if (sd) rotation = Number(sd.rotation);
  rotation = ((Math.round(rotation) % 360) + 360) % 360;
  return { ...(ct ? { creationTime: new Date(ct).toISOString() } : {}), rotation };
}

/** Tamanho exibido: rotação de 90/270 troca largura e altura. */
export function displaySize(width: number, height: number, rotation: number): { width: number; height: number } {
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

// ── Encaixe (fit/fill/blur-fill) ──────────────────────────────────────────

/**
 * Como um clipe ocupa o quadro da sequência (#12559):
 *   - `fill`: cobre o quadro, recortando pelo rosto (o comportamento de sempre);
 *   - `fit`: o quadro inteiro do arquivo cabe na sequência, com faixas pretas;
 *   - `blur-fill`: `fit` sobre uma cópia do mesmo trecho cobrindo o quadro e
 *     desfocada (faixa de vídeo de baixo no XML, `boxblur` na prévia).
 */
export type FitMode = "fill" | "fit" | "blur-fill";
export const FIT_MODES: readonly FitMode[] = ["fill", "fit", "blur-fill"];

export function isFitMode(x: unknown): x is FitMode {
  return typeof x === "string" && (FIT_MODES as readonly string[]).includes(x);
}

/**
 * O encaixe de um clipe: o do item, senão o da sequência, senão o default.
 * Default: `fill` quando arquivo e sequência têm a mesma orientação (ou o
 * arquivo é horizontal, o recorte de sempre da vertical derivada); arquivo
 * vertical em sequência horizontal = `blur-fill` (recortar um 9:16 em 16:9
 * cortaria a cabeça ou o peito; a área útil cai para um terço da largura).
 */
export function effectiveFit(
  file: Pick<SourceFile, "width" | "height">,
  spec: { width: number; height: number; fit?: FitMode },
  item?: { fit?: FitMode },
): { fit: FitMode; how: "item" | "sequencia" | "default" } {
  if (item?.fit) return { fit: item.fit, how: "item" };
  if (spec.fit) return { fit: spec.fit, how: "sequencia" };
  const seqVertical = spec.height > spec.width;
  return { fit: isVerticalFile(file) && !seqVertical ? "blur-fill" : "fill", how: "default" };
}

/** Escala (%) que faz o quadro inteiro do arquivo caber na sequência (o `fit`). */
export function fitScalePct(srcW: number, srcH: number, seqW: number, seqH: number): number {
  return Math.round(Math.min(seqW / srcW, seqH / srcH) * 1000000) / 10000;
}

/** Escala (%) que faz o arquivo cobrir a sequência sem recorte de rosto (o fundo do `blur-fill`). */
export function coverScalePct(srcW: number, srcH: number, seqW: number, seqH: number): number {
  return Math.round(Math.max(seqW / srcW, seqH / srcH) * 1000000) / 10000;
}

/**
 * Aviso de perda de área (#12559): no `fit`/`blur-fill`, quanto do quadro da
 * sequência o arquivo ocupa (1080x1920 num 1920x1080 = 608x1080, 32% da
 * largura). `null` quando ocupa o quadro todo ou é `fill`.
 */
export function fitAreaWarning(file: Pick<SourceFile, "id" | "width" | "height">, spec: { name: string; width: number; height: number }, fit: FitMode): string | null {
  if (fit === "fill") return null;
  const s = Math.min(spec.width / file.width, spec.height / file.height);
  const w = Math.round(file.width * s);
  const h = Math.round(file.height * s);
  if (w >= spec.width && h >= spec.height) return null;
  const pct = Math.round(((w * h) / (spec.width * spec.height)) * 100);
  const res = s > 1 ? `, ampliado ${(s * 100).toFixed(0)}% (perde nitidez)` : "";
  return `${spec.name}: ${file.id} (${file.width}x${file.height}) em ${fit} ocupa ${w}x${h} do quadro ${spec.width}x${spec.height} (${pct}% da área${res})${fit === "fit" ? "; o resto fica preto" : "; o resto é o fundo desfocado"}`;
}

/**
 * Filtro de vídeo da prévia para `fit`/`blur-fill` (um grafo com uma entrada
 * e uma saída, que cabe no `-vf`). O `fill` continua no `previewClipArgs`.
 */
export function fitPreviewFilter(input: { fit: Exclude<FitMode, "fill">; mirrored: boolean; outW: number; outH: number; fps: number; blur?: number }): string {
  const flip = input.mirrored ? "hflip," : "";
  const fg = `scale=${input.outW}:${input.outH}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  if (input.fit === "fit") return `${flip}${fg},pad=${input.outW}:${input.outH}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${input.fps}`;
  const r = input.blur ?? 20;
  return (
    `${flip}split=2[bg][fg];` +
    `[bg]scale=${input.outW}:${input.outH}:force_original_aspect_ratio=increase,crop=${input.outW}:${input.outH},boxblur=${r}:2[b];` +
    `[fg]${fg}[f];[b][f]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${input.fps}`
  );
}

// ── Inventário: papel de cada arquivo (#12559 item 5) ─────────────────────

export type FileRole = "mestre-horizontal" | "vertical-nativa" | "desconhecido";

export interface InventoryFile {
  name: string;
  path: string;
  width: number;
  height: number;
  durationS: number;
  fps: number;
  creationTime?: string;
  /** Primeiras palavras ouvidas (transcrição leve), quando houver. */
  heard?: string;
}

export interface InventoryRow extends InventoryFile {
  role: FileRole;
  /** Parte N do mestre horizontal da edição (ordem de gravação), quando há mais de uma. */
  part?: number;
  /** Edição proposta pelo conteúdo da fala, quando o D1 casa. */
  edition?: string;
  /** Tokens do D1 encontrados na fala (a evidência do casamento). */
  editionScore?: number;
  /** Onde a vertical nativa entra no horizontal: entre as partes (gravada entre elas) ou antes do fecho. */
  insertion?: string;
  note?: string;
}

const STOP = new Set(
  "a o e de da do das dos que em um uma para por com no na nos nas se os as ao à é mais como mas foi ser tem isso essa esse este esta ela ele eles elas já não sim também pra pro sobre entre seu sua seus suas vai vou está estão ou muito".split(" "),
);

/** Tokens de conteúdo (sem acento, minúsculos, 4+ letras, fora das palavras vazias). */
export function contentTokens(text: string): Set<string> {
  const norm = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return new Set((norm.match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 4 && !STOP.has(t)));
}

/**
 * Propõe o papel de cada arquivo (o editor só confirma): vertical = vertical
 * nativa (inserção nos dois vídeos + Short avulso, decisão do editor de
 * 09/11/2026), horizontal = mestre horizontal (partes numeradas na ordem de
 * gravação, por edição). A edição sai do casamento da fala com o D1 de cada
 * edição candidata (`d1Texts`), pelo número de tokens de conteúdo em comum
 * (mínimo `minScore`); sem casamento, fica em branco. Vertical gravada ENTRE
 * duas partes do mesmo mestre entra entre elas (caso Nubank); fora disso, a
 * proposta é antes do fecho (caso Nvidia).
 */
export function proposeRoles(files: InventoryFile[], d1Texts: Record<string, string> = {}, opts: { minScore?: number } = {}): InventoryRow[] {
  const minScore = opts.minScore ?? 3;
  const d1 = Object.entries(d1Texts).map(([edition, text]) => ({ edition, tokens: contentTokens(text) }));
  const ordered = sortByRecording(files);
  const rows: InventoryRow[] = ordered.map((f) => {
    const role: FileRole = !(f.width > 0 && f.height > 0) ? "desconhecido" : f.height > f.width ? "vertical-nativa" : "mestre-horizontal";
    let edition: string | undefined;
    let editionScore: number | undefined;
    if (f.heard && d1.length) {
      const heard = contentTokens(f.heard);
      const scored = d1.map((d) => ({ edition: d.edition, score: [...d.tokens].filter((t) => heard.has(t)).length })).sort((a, b) => b.score - a.score);
      if (scored[0].score >= minScore && (scored.length === 1 || scored[0].score > scored[1].score)) {
        edition = scored[0].edition;
        editionScore = scored[0].score;
      }
    }
    return { ...f, role, ...(edition ? { edition, editionScore } : {}) };
  });
  // Partes do mestre por edição (sem edição = um grupo só), na ordem de gravação.
  const groups = new Map<string, InventoryRow[]>();
  for (const r of rows) if (r.role === "mestre-horizontal") groups.set(r.edition ?? "", [...(groups.get(r.edition ?? "") ?? []), r]);
  for (const g of groups.values()) if (g.length > 1) g.forEach((r, i) => (r.part = i + 1));
  for (const r of rows) {
    if (r.role !== "vertical-nativa") continue;
    const masters = groups.get(r.edition ?? "") ?? [];
    const idx = rows.indexOf(r);
    const before = masters.filter((m) => rows.indexOf(m) < idx);
    const after = masters.filter((m) => rows.indexOf(m) > idx);
    if (before.length && after.length) r.insertion = `entre a parte ${before[before.length - 1].part ?? 1} e a parte ${after[0].part ?? 2} do horizontal (gravada entre elas), no bloco comentario`;
    else r.insertion = "no bloco comentario do horizontal, antes do fecho (ponto exato: o editor confirma no blocks.json)";
    r.note = "também sai como Short avulso (sequência de corte com source = este arquivo)";
  }
  return rows;
}
