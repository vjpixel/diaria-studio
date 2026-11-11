/**
 * drive-video-source.ts (#10659, itens 3-4): escolhe, entre os arquivos de uma
 * pasta do Drive, o vídeo "diar.ia.br comentada" do dia — o horizontal
 * (YouTube) ou o vertical (Short/Reels/Story).
 *
 * Puro: recebe a listagem já feita (`scripts/fetch-drive-video.ts` chama a
 * Drive API v3) e um `now` injetável. Casos de negócio voltam como união
 * discriminada, nunca como exceção.
 *
 * Critério (decisão do editor, 25/10/2026, comentário na #10659):
 * - nome contém "final" como PALAVRA, sem diferenciar maiúsculas/minúsculas
 *   (`hasFinalInName`): "V3 - final", "_Final", "final.mp4" valem;
 *   "finalizando", "pre-final"/"pré-final" e "não final"/"nao final" não;
 * - é `.mp4`: extensão `.mp4` OU `mimeType` `video/mp4` (`isMp4VideoFile`).
 *   `.mov`/`.webm`/`.mkv` ficam fora mesmo com `video/*`. O download confere
 *   o mesmo critério no `content-type` (`isAcceptableDownloadContentType`);
 * - orientação pela proporção de `videoMediaMetadata`: largura > altura é
 *   horizontal, altura > largura é vertical. Sem metadado não se chuta
 *   (`orientation-unknown`); quadrado não é nenhum dos dois;
 * - 2+ candidatos da mesma orientação → `ambiguous`, com id/nome/data de cada
 *   um (o Drive aceita nomes repetidos). Nunca escolhe sozinho (o editor
 *   costuma deixar V2 e V3 "final" lado a lado);
 * - nenhum candidato → `none` (fail-soft: o editor sobe depois e roda
 *   `/diaria-youtube`).
 *
 * Escopo (premissa, medida na pasta real em 25/10/2026): a pasta
 * de vídeo (`Mentoria Fluxo/VTSD/YouTube` até a #12578, hoje `diaria-studio-video`) tem uma subpasta por edição (`261021/`,
 * `261022/`, `261023/`), com os brutos e as versões.
 * - **Subpasta `{AAMMDD}/` existe** → só ela conta, sem janela de tempo (o
 *   nome da pasta já diz o dia). Sem candidato da orientação pedida lá dentro
 *   → `none`; a raiz NÃO é consultada, senão um vídeo de outra edição solto
 *   na raiz subiria como o de hoje.
 * - **Subpasta não existe** → arquivos soltos na raiz, só dentro da janela
 *   (~36h, o mais recente entre criado e modificado).
 * - Subpastas de outras edições nunca entram (quem lista não desce nelas).
 *
 * **Pasta `Final/` (#11222, fluxo real desde a edição 261027 — "será assim em
 * todas as edições", palavra do editor).** O vídeo pronto fica numa subpasta
 * `Final/` dentro de `{AAMMDD}/`, com o destino no nome e SEM "final" nele:
 * `Diaria comentada_Youtube_V3.mp4`, `Diaria comentada_Instagram_V3.mp4`,
 * `Diaria comentada_Outras redes_V3.mp4`. "Final" é o nome da PASTA.
 * - Arquivos listados dentro de `Final/` têm `scope: "final-folder"` e contam
 *   como finais pelo lugar, sem exigir "final" no nome.
 * - Com algum `.mp4` em `Final/`, só ela conta (precede a regra do nome na
 *   subpasta da edição). Sem `.mp4` lá, cai na regra antiga da subpasta.
 * - Horizontal = `horizontal_V{n}` (#12609; o antigo `_Youtube_` segue valendo); uma única vertical `_Vertical_V{n}` atende
 *   todos os destinos (#11491). O target técnico segue `outras-redes`.
 *   Fallback histórico, inclusive para `target: "instagram"`: `_Outras redes_`,
 *   depois `_Instagram_`. Empate no mesmo padrão continua ambíguo.
 * - O sufixo decide sem precisar da proporção (o Drive pode ainda não ter
 *   processado o vídeo). Proporção conhecida e contrária ao destino exclui o
 *   arquivo (um `_Youtube_` vertical não sobe como horizontal).
 * - 2+ arquivos do mesmo destino (V2 e V3 lado a lado) → `ambiguous`, como na
 *   regra antiga: o editor escolhe.
 * - Arquivos sem sufixo de destino em `Final/` seguem a escolha por proporção.
 *
 * **Variações (#11385).** O nome da pasta aceita "Final", "Finais", "Versão
 * final" (`isFinalFolderName`). Sem `.mp4` em nenhuma delas, o fetch lista a
 * subpasta `Editado/` (e variações: `isEditedFolderName`) e trata os arquivos
 * dela como os de `Final/` — na 261028 o vídeo veio em
 * `Editado/Diaria comentada_Youtube_FINAL.mp4`.
 *
 * **Versão mais alta em `Editados/` (#11556).** Na 261029 a pasta tinha
 * `_Youtube_V1` … `_V5` e `_Instagram_V1`/`_V2`, sem `Final/`. Ali 2+ arquivos
 * do mesmo destino não são ambíguos: vale o maior `V{n}` (`pickHighestVersion`,
 * empate no `n` desfeito pelo `modifiedTime`), com a escolha devolvida como
 * `premise`. `needs-editor` fica para nome sem versão ou empate que a data não
 * desfaz. Em `Final/` nada muda: 2+ do mesmo destino seguem `ambiguous`.
 *
 * **Cópia promovida não congela a versão (#11577).** A cópia que o fetch pôs
 * em `Final/` (`appProperties.diaria_promoted_from`) entra na mesma regra da
 * versão mais alta: com `_Youtube_V6` exportado depois do V5 promovido, vale o
 * V6. O original da cópia em `Editados/` sai do pool (é o mesmo vídeo).
 *
 * **Vertical de `Editados/` só com sufixo (#11423).** Para os destinos
 * verticais, um `.mp4` sem `_Instagram_`/`_Outras redes_` em `Editados/` é
 * rascunho e nunca é escolhido pela proporção.
 */

export type VideoOrientation = "horizontal" | "vertical";

/** Destino codificado no nome do arquivo da pasta `Final/` (#11222). */
export type VideoTarget = "youtube" | "instagram" | "outras-redes";

export const VIDEO_TARGETS: readonly VideoTarget[] = ["youtube", "instagram", "outras-redes"];

/** Destino padrão por orientação (#11222). */
export function defaultVideoTarget(orientation: VideoOrientation): VideoTarget {
  return orientation === "horizontal" ? "youtube" : "outras-redes";
}

/** Orientação que cada destino exige. */
export function targetOrientation(target: VideoTarget): VideoOrientation {
  return target === "youtube" ? "horizontal" : "vertical";
}

/** Minúsculas, sem acento, separadores (`_`, `-`, `.`) e espaços colapsados. */
function folderKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[_.\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const FINAL_FOLDER_KEYS = new Set(["final", "finais", "versao final", "video final", "videos finais"]);

/**
 * Nome da subpasta dos vídeos prontos dentro de `{AAMMDD}/` (#11222), sem
 * diferenciar maiúsculas nem acento. Aceita as variações "Final", "Finais",
 * "Versão final" (#11385).
 */
export function isFinalFolderName(name: string): boolean {
  return FINAL_FOLDER_KEYS.has(folderKey(name));
}

const EDITED_FOLDER_KEYS = new Set([
  "editado", "editados", "editada", "editadas", "edicao", "edicoes",
  "exportado", "exportados", "export", "exports",
]);

/**
 * Subpasta alternativa ao `Final/` (#11385): na edição 261028 o horizontal
 * veio em `{AAMMDD}/Editado/Diaria comentada_Youtube_FINAL.mp4` e o fetch
 * respondeu `none`. Só é listada quando não há `.mp4` em nenhuma `Final/`
 * (que continua sendo a convenção e tem precedência); os arquivos dela entram
 * com o mesmo `scope: "final-folder"` e a mesma regra de destino/proporção.
 */
export function isEditedFolderName(name: string): boolean {
  return EDITED_FOLDER_KEYS.has(folderKey(name));
}

/**
 * Destino pelo nome: `horizontal_V{n}`/`horizontal_FINAL` (#12609) ou o antigo `_Youtube_`, `_Vertical_V{n}`/`_Vertical_FINAL` (com texto
 * livre no meio, `_Vertical_Edição 09_V1`, #12133), `_Instagram_`, `_Outras redes_` (separador
 * `_`, `-`, espaço ou `.`; sem diferenciar maiúsculas). Mais de um destino no
 * mesmo nome, ou nenhum, é `null`. Nome de corte (`…_V1-soberana`, ver
 * `corteSuffixOf`) também é `null`: é uma 2ª vertical que sai pelo modo corte,
 * nunca a vertical da edição.
 */
export function videoTargetOf(name: string): VideoTarget | null {
  if (corteSuffixOf(name)) return null;
  const n = ` ${name.normalize("NFC").toLowerCase().replace(/[_.\-]+/g, " ").replace(/\s+/g, " ")} `;
  const found: VideoTarget[] = [];
  // #12609: o horizontal passou de `_Youtube_V{n}` para `horizontal_V{n}`
  // (simétrico com `_Vertical_V{n}`); os dois valem, o antigo pelas edições já exportadas.
  if (/ you ?tube | horizontal (?:final|(?:\S+ )*?v\d+) /.test(n)) found.push("youtube");
  if (/ instagram /.test(n)) found.push("instagram");
  // #12133: o editor põe texto livre entre o destino e a versão
  // (`_Vertical_Edição 09_V1`); vale `_Vertical_` seguido, em algum ponto, de
  // `V{n}`. `FINAL` continua colado ao destino (`_Vertical_pre-final` não é a vertical).
  if (/ outras redes | vertical (?:final|(?:\S+ )*?v\d+) /.test(n)) found.push("outras-redes");
  return found.length === 1 ? found[0] : null;
}

/**
 * O slug do corte no fim do nome (`Diaria comentada_Vertical_V1-soberana.mp4`
 * → `soberana`), ou `null`. Corte = sequência extra da montagem com `corte` no
 * `blocks.json` (261103): o nome é o da vertical normal + `-{slug}`.
 */
export function corteSuffixOf(name: string): string | null {
  const m = /_v\d+-([a-z0-9]+(?:-[a-z0-9]+)*)(?:\.[a-z0-9]+)?$/i.exec(name.normalize("NFC"));
  return m ? m[1].toLowerCase() : null;
}

/**
 * Um corte da edição como o `blocks.json` o declara (#11950): o slug
 * (`sequences[].corte`) e o título de tela da sequência (`screenTitle`), que o
 * editor às vezes usa no nome do export em vez do slug.
 */
export interface CorteRef {
  corte: string;
  screenTitle?: string | null;
}

/**
 * Palavras que já identificam a vertical da edição no nome: um corte com esse
 * slug/título casaria com todo arquivo, então não serve para reconhecer corte.
 */
const RESERVED_CORTE_KEYS = new Set(["vertical", "horizontal", "final", "youtube", "instagram", "outras redes", "diaria", "comentada", "diaria comentada", "still"]);

/** Minúsculas, sem acento, separadores e espaços colapsados, com espaço nas pontas (casamento por palavra). */
function nameTokens(name: string): string {
  return ` ${folderKey(name)} `;
}

/**
 * O corte a que o arquivo pertence (#11950), ou `null` quando é da edição.
 * Reconhece, nesta ordem:
 * - o sufixo do padrão `_V{n}-{slug}` no fim do nome (`corteSuffixOf`);
 * - o mesmo sufixo seguido de `.` (a Still do Premiere:
 *   `Diaria comentada_Vertical_V1-soberana.00_00_00_00.Still002.jpg`);
 * - com os cortes do `blocks.json`: o slug ou o `screenTitle` do corte como
 *   palavras inteiras no nome (`Diaria comentada_Vertical_IA Soberana_Edição 08_V2.mp4`
 *   → "IA Soberana" / "soberana"). Slug ou título que coincide com uma palavra
 *   de destino ("vertical", "final"...) é ignorado.
 */
export function corteOfName(name: string, cortes: readonly CorteRef[] = []): string | null {
  const strict = corteSuffixOf(name);
  if (strict) return strict;
  const still = /_v\d+-([a-z0-9]+(?:-[a-z0-9]+)*)(?=\.)/i.exec(name.normalize("NFC"));
  if (still) return still[1].toLowerCase();
  const tokens = nameTokens(name);
  for (const ref of cortes) {
    const keys = [folderKey(ref.corte), ref.screenTitle ? folderKey(ref.screenTitle) : ""];
    if (keys.some((k) => k && !RESERVED_CORTE_KEYS.has(k) && tokens.includes(` ${k} `))) return ref.corte;
  }
  return null;
}

/** Janela default para arquivos soltos na raiz da pasta (decisão de 25/10). */
export const DRIVE_VIDEO_WINDOW_HOURS = 36;

export interface DriveVideoFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime?: string;
  modifiedTime?: string;
  /** Tamanho em bytes, como a Drive API devolve (string). */
  size?: string;
  videoMediaMetadata?: { width?: number; height?: number; durationMillis?: string };
  /** Onde o arquivo foi listado. Default: `root`. `final-folder` = `{AAMMDD}/Final/` (#11222). */
  scope?: DriveVideoScope;
  /**
   * Listado em `Editado/`/`Editados/` (#11385), não em `Final/`: o scope é o
   * mesmo `final-folder`, mas só aqui vale a versão mais alta (#11556).
   */
  editedFolder?: boolean;
  /** Nome da subpasta onde o arquivo foi listado (`Final`, `Editado`...), para as mensagens (#12133). */
  folderName?: string;
  /** `appProperties` do Drive; `diaria_promoted_from` marca a cópia que o fetch pôs em `Final/` (#11556). */
  appProperties?: Record<string, string>;
}

/** Chave do `appProperties` que marca a cópia promovida para `Final/` (#11556). */
export const PROMOTED_FROM_PROPERTY = "diaria_promoted_from";

/** A cópia em `Final/` foi feita pelo fetch a partir de `Editados/` (#11556)? */
export function isPromotedCopy(file: Pick<DriveVideoFile, "appProperties">): boolean {
  return typeof file.appProperties?.[PROMOTED_FROM_PROPERTY] === "string";
}

/**
 * Número da versão no nome (`_V5`, ` V2`, `-v12`), sem extensão; `null` sem
 * versão ou com mais de uma (#11556). "FINAL" não é versão.
 */
export function videoVersionOf(name: string): number | null {
  const stem = name.normalize("NFC").replace(/\.[a-z0-9]{2,4}$/i, "");
  const found = [...stem.matchAll(/(?:^|[\s_.\-()])v(\d{1,3})(?=$|[\s_.\-()])/gi)].map((m) => Number(m[1]));
  return found.length === 1 ? found[0] : null;
}

/**
 * O texto livre entre `_Vertical_` e o `V{n}`, normalizado (`folderKey`, sem
 * acento): `_Vertical_Edição 09_V1` → `edicao 09`; `_Vertical_V1` → `""`;
 * `null` fora do padrão `_Vertical_…_V{n}` (#12133). Texto antes do destino
 * (`edição 6_Instagram_V1`, #11556) não conta.
 */
export function verticalInfixOf(name: string): string | null {
  const n = ` ${folderKey(name.replace(/\.[a-z0-9]{2,4}$/i, ""))} `;
  const m = / vertical ((?:\S+ )*?)v\d+ /.exec(n);
  return m ? m[1].trim() : null;
}

function modifiedMs(file: DriveVideoFile): number | null {
  const t = file.modifiedTime ? Date.parse(file.modifiedTime) : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * Entre 2+ candidatos do mesmo destino em `Editados/` (#11556): o de maior
 * `V{n}`. Empate no `n` cai no `modifiedTime` estritamente mais recente.
 * `null` (o editor escolhe) quando algum nome não tem versão, ou quando o
 * empate não se desfaz (mesmo `n` e mesma data, ou data ausente).
 */
export function pickHighestVersion(candidates: DriveVideoFile[]): { file: DriveVideoFile; premise: string } | null {
  const versions = candidates.map((f) => videoVersionOf(f.name));
  if (candidates.length < 2 || versions.some((v) => v === null)) return null;
  const max = Math.max(...(versions as number[]));
  const top = candidates.filter((_, i) => versions[i] === max);
  const others = candidates.filter((_, i) => versions[i] !== max).map((f) => f.name);
  if (top.length === 1) {
    return {
      file: top[0],
      premise: `versão mais alta em Editados/: ${top[0].name} (V${max}); fora: ${others.join(", ")} (#11556)`,
    };
  }
  const dated = top.map((f) => ({ f, ms: modifiedMs(f) }));
  if (dated.some((d) => d.ms === null)) return null;
  dated.sort((a, b) => (b.ms as number) - (a.ms as number));
  if (dated[0].ms === dated[1].ms) return null;
  const rest = [...dated.slice(1).map((d) => d.f.name), ...others];
  return {
    file: dated[0].f,
    premise: `versão mais alta em Editados/ empatada em V${max}: ${dated[0].f.name} é a modificada por último (${dated[0].f.modifiedTime}); fora: ${rest.join(", ")} (#11556)`,
  };
}

export type DriveVideoScope = "final-folder" | "edition-folder" | "root";

export type DriveVideoSelection =
  | { kind: "found"; orientation: VideoOrientation; file: DriveVideoFile; premise?: string }
  | { kind: "none"; orientation: VideoOrientation; reason: string }
  | { kind: "ambiguous"; orientation: VideoOrientation; candidates: DriveVideoFile[] }
  | { kind: "orientation-unknown"; orientation: VideoOrientation; files: DriveVideoFile[] };

export interface SelectDriveVideoOptions {
  orientation: VideoOrientation;
  now: Date;
  windowHours?: number;
  /**
   * A subpasta `{AAMMDD}/` existe no Drive (mesmo vazia). Default: inferido de
   * algum arquivo com `scope: "edition-folder"` — quem lista deve passar o
   * valor real, porque uma subpasta vazia não deixa rastro na listagem.
   */
  editionFolderPresent?: boolean;
  /**
   * Destino na pasta `Final/` (#11222). Default: `defaultVideoTarget(orientation)`.
   * Precisa casar com a orientação (`targetOrientation`).
   */
  target?: VideoTarget;
  /**
   * Cortes do `blocks.json` (#11950). Na vertical, arquivo de corte
   * (`corteOfName`) nunca concorre com a vertical da edição; sem a lista, só
   * os nomes no padrão `_V{n}-{slug}` são reconhecidos.
   */
  cortes?: readonly CorteRef[];
}

/** Orientação pela proporção; `null` sem largura/altura válidas. */
export function classifyOrientation(file: DriveVideoFile): VideoOrientation | "square" | null {
  const w = file.videoMediaMetadata?.width;
  const h = file.videoMediaMetadata?.height;
  if (typeof w !== "number" || typeof h !== "number" || !(w > 0) || !(h > 0)) return null;
  if (w > h) return "horizontal";
  if (h > w) return "vertical";
  return "square";
}

const MP4_EXT = /\.mp4$/i;
/** Extensões de vídeo que NÃO são o `.mp4` combinado, mesmo com `mimeType` `video/mp4`. */
const OTHER_VIDEO_EXT = /\.(mov|webm|mkv|avi|m4v|wmv|flv|3gp)$/i;

function baseMime(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

/** `.mp4` por extensão, ou `mimeType` `video/mp4` sem extensão de outro formato. */
export function isMp4VideoFile(file: Pick<DriveVideoFile, "name" | "mimeType">): boolean {
  if (MP4_EXT.test(file.name)) return true;
  return baseMime(file.mimeType) === "video/mp4" && !OTHER_VIDEO_EXT.test(file.name);
}

/**
 * `content-type` aceito no download: `video/mp4`, ou `application/octet-stream`
 * quando o nome termina em `.mp4` (o Drive serve assim alguns uploads).
 */
export function isAcceptableDownloadContentType(contentType: string, fileName: string): boolean {
  const t = baseMime(contentType);
  if (t === "video/mp4") return true;
  return t === "application/octet-stream" && MP4_EXT.test(fileName);
}

const FINAL_WORD = /(?<!\p{L})final(?!\p{L})/giu;
/** Prefixo que nega o "final" logo antes dele: "pre-", "pré ", "não ", "nao_". */
const NEGATING_PREFIX = /(?:^|[^\p{L}])(?:pr[eé]|n[aã]o)[\s_.-]*$/iu;

/** "final" como palavra, não negado. */
export function hasFinalInName(name: string): boolean {
  const n = name.normalize("NFC");
  for (const m of n.matchAll(FINAL_WORD)) {
    if (!NEGATING_PREFIX.test(n.slice(0, m.index))) return true;
  }
  return false;
}

function latestTimestampMs(file: DriveVideoFile): number | null {
  // Arquivo copiado/enviado preserva o modifiedTime original (pode ser ANTES
  // do createdTime): vale o mais recente dos dois.
  const ts = [file.createdTime, file.modifiedTime]
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((n) => Number.isFinite(n));
  return ts.length ? Math.max(...ts) : null;
}

/** Dentro da janela (arquivo do futuro, por relógio adiantado, conta como dentro). */
export function isWithinWindow(file: DriveVideoFile, now: Date, windowHours: number): boolean {
  const ts = latestTimestampMs(file);
  if (ts === null) return false;
  return now.getTime() - ts <= windowHours * 3_600_000;
}

function pick(pool: DriveVideoFile[], orientation: VideoOrientation): DriveVideoSelection | null {
  if (pool.length === 0) return null;
  const unknown = pool.filter((f) => classifyOrientation(f) === null);
  const matching = pool.filter((f) => classifyOrientation(f) === orientation);
  // Um "final" sem proporção pode ser justamente o da orientação pedida:
  // escolher outro ao lado dele seria chutar.
  if (unknown.length > 0) return { kind: "orientation-unknown", orientation, files: unknown };
  if (matching.length > 1) return { kind: "ambiguous", orientation, candidates: matching };
  if (matching.length === 1) return { kind: "found", orientation, file: matching[0] };
  return null;
}

/**
 * Escolha dentro de `{AAMMDD}/Final/` (#11222): pelo sufixo de destino, depois
 * pela proporção entre os sem sufixo. `null` = nenhum `.mp4` serve para o
 * destino pedido (o chamador decide o motivo).
 */
function pickFromFinalFolder(allFiles: DriveVideoFile[], orientation: VideoOrientation, target: VideoTarget): DriveVideoSelection | null {
  const fitsOrientation = (f: DriveVideoFile) => {
    const o = classifyOrientation(f);
    return o === null || o === orientation;
  };
  // #11577: o original em Editados/ de uma cópia promovida já presente em
  // Final/ é o mesmo vídeo: a cópia o representa (senão V5 e cópia do V5
  // empatariam no `n`).
  const promotedSources = new Set(allFiles.filter(isPromotedCopy).map((f) => f.appProperties?.[PROMOTED_FROM_PROPERTY]));
  const pool = allFiles.filter((f) => !(f.editedFolder && promotedSources.has(f.id)));
  // #11491: uma vertical para todos os destinos. Nunca desempatar arquivos
  // do mesmo padrão pela data: preserve a ambiguidade e a regra de versões.
  const verticalRank = (f: DriveVideoFile): number => {
    const t = videoTargetOf(f.name);
    if (t === "outras-redes") return /(?:^|[_.\s-])vertical(?:[_.\s-]|$)/i.test(f.name) ? 0 : 1;
    return t === "instagram" ? 2 : 3;
  };
  const candidates = pool.filter((f) => fitsOrientation(f) && (orientation === "vertical" ? verticalRank(f) < 3 : videoTargetOf(f.name) === target));
  const rank = orientation === "vertical" ? Math.min(...candidates.map(verticalRank)) : 0;
  const byTarget = candidates.filter((f) => orientation !== "vertical" || verticalRank(f) === rank);
  if (byTarget.length > 1) {
    // #11556: em Editados/ ficam todas as exportações (V1…V5); a mais alta é a
    // final. Em Final/ o editor pôs as duas de propósito: segue ambíguo.
    // #11577: a cópia que o fetch promoveu para Final/ conta como Editados/ —
    // uma exportação mais nova lá (V6 depois do V5 promovido) vence a cópia.
    // #12133: com texto livre entre `_Vertical_` e o `V{n}`, um corte sem a
    // lista do blocks.json (`_Vertical_IA Soberana_Edição 08_V2`) casa o mesmo
    // destino que a vertical da edição (`_Vertical_Edição 08_V1`). Versão só
    // se compara com o mesmo texto entre `_Vertical_` e o `V{n}`; texto
    // diferente, o editor escolhe.
    const infixes = new Set(byTarget.map((f) => verticalInfixOf(f.name)).filter((s) => s !== null));
    const sameSeries = orientation !== "vertical" || infixes.size <= 1;
    const highest = sameSeries && byTarget.every((f) => f.editedFolder || isPromotedCopy(f)) ? pickHighestVersion(byTarget) : null;
    if (highest) return { kind: "found", orientation, file: highest.file, premise: highest.premise };
    return { kind: "ambiguous", orientation, candidates: byTarget };
  }
  if (byTarget.length === 1) return { kind: "found", orientation, file: byTarget[0] };
  // #11423: vertical sem sufixo de destino em Editados/ é rascunho, nunca o
  // vertical publicado (LinkedIn/X/Threads/Instagram). Lá só vale o sufixo.
  const unsuffixed = pool.filter((f) => videoTargetOf(f.name) === null && !(orientation === "vertical" && f.editedFolder));
  return pick(unsuffixed, orientation);
}

/**
 * `.mp4` que pode ser um corte VERTICAL (#11428): sufixo `_Instagram_`/
 * `_Outras redes_`, ou, sem sufixo, proporção vertical ou ainda desconhecida.
 * O `_Youtube_` (ou um horizontal sem sufixo) não é.
 */
export function isVerticalCutCandidate(file: DriveVideoFile): boolean {
  if (!isMp4VideoFile(file)) return false;
  const target = videoTargetOf(file.name);
  if (target) return targetOrientation(target) === "vertical";
  const o = classifyOrientation(file);
  return o === "vertical" || o === null;
}

export function selectDriveVideo(allFiles: DriveVideoFile[], opts: SelectDriveVideoOptions): DriveVideoSelection {
  // #11950: o export de um corte é uma 2ª vertical, que sai pelo modo corte.
  const files = opts.orientation === "vertical" ? allFiles.filter((f) => corteOfName(f.name, opts.cortes) === null) : allFiles;
  const windowHours = opts.windowHours ?? DRIVE_VIDEO_WINDOW_HOURS;
  const target = opts.target ?? defaultVideoTarget(opts.orientation);
  if (targetOrientation(target) !== opts.orientation) {
    throw new Error(`destino ${target} é ${targetOrientation(target)}, não ${opts.orientation}`);
  }
  const editionFolderPresent =
    opts.editionFolderPresent ?? allFiles.some((f) => f.scope === "edition-folder" || f.scope === "final-folder");
  const finals = files.filter((f) => isMp4VideoFile(f) && hasFinalInName(f.name));

  const finalFolderPool = files.filter((f) => f.scope === "final-folder" && isMp4VideoFile(f));
  if (finalFolderPool.length > 0) {
    const fromFinal = pickFromFinalFolder(finalFolderPool, opts.orientation, target);
    if (fromFinal) return fromFinal;
    // #12133: nomear a pasta real (na 261104 era `Editado/`, e a mensagem dizia "Final/").
    const folderNames = [...new Set(finalFolderPool.map((f) => f.folderName ?? (f.editedFolder ? "Editado" : "Final")))];
    const where = folderNames.length === 1 ? `a pasta ${folderNames[0]}/` : `as pastas ${folderNames.map((n) => `${n}/`).join(", ")}`;
    return {
      kind: "none",
      orientation: opts.orientation,
      reason:
        `${where} da edição tem ${finalFolderPool.length} .mp4, mas nenhum do destino ${target} ` +
        `(sufixo no nome, ex.: "Diaria comentada${target === "youtube" ? " horizontal" : target === "instagram" ? "_Instagram" : "_Vertical"}_V3.mp4") nem sem sufixo na proporção ${opts.orientation}`,
    };
  }

  if (editionFolderPresent) {
    const editionPool = finals.filter((f) => f.scope === "edition-folder");
    const fromEdition = pick(editionPool, opts.orientation);
    if (fromEdition) return fromEdition;
    const videos = files.filter((f) => f.scope === "edition-folder" && isMp4VideoFile(f)).length;
    return {
      kind: "none",
      orientation: opts.orientation,
      reason:
        `a subpasta da edição existe, mas não tem .mp4 ${opts.orientation} com "final" no nome ` +
        `(${editionPool.length} "final", ${videos} .mp4 lá dentro); a raiz não é consultada quando a subpasta existe`,
    };
  }

  const rootPool = finals.filter((f) => f.scope !== "edition-folder" && isWithinWindow(f, opts.now, windowHours));
  const fromRoot = pick(rootPool, opts.orientation);
  if (fromRoot) return fromRoot;

  const videos = files.filter(isMp4VideoFile).length;
  const reason =
    finals.length === 0
      ? `sem subpasta da edição e nenhum .mp4 com "final" no nome na raiz (${videos} .mp4 listado(s))`
      : `sem subpasta da edição e nenhum .mp4 ${opts.orientation} com "final" no nome na raiz nas últimas ${windowHours}h`;
  return { kind: "none", orientation: opts.orientation, reason };
}

export type CorteExportSelection =
  | { kind: "found"; corte: string; file: DriveVideoFile; premise?: string }
  | { kind: "none"; corte: string; reason: string }
  | { kind: "ambiguous"; corte: string; candidates: DriveVideoFile[] };

/**
 * O export de uma vertical extra (corte, #11898/#11900) em `{AAMMDD}/Final/`:
 * `.mp4` cujo nome termina em `_V{n}-{corte}` (`corteSuffixOf`). Mesmas regras
 * da vertical da edição, só que pelo slug do corte em vez do destino:
 * - em `Final/`, 1 arquivo = o export; 2+ = `ambiguous` (o editor escolhe);
 * - sem nenhum em `Final/` (ou só a cópia que o fetch promoveu, #11577), vale
 *   `Editados/` com a versão mais alta (`pickHighestVersion`, #11556);
 * - proporção conhecida e não vertical exclui o arquivo; desconhecida passa
 *   (o sufixo já diz que é o corte, o Drive pode ainda não ter processado).
 * Recebe os arquivos já listados com `scope: "final-folder"` (e `editedFolder`
 * nos de `Editados/`); os demais escopos são ignorados.
 */
export function selectCorteExport(files: DriveVideoFile[], corte: string, cortes: readonly CorteRef[] = []): CorteExportSelection {
  const promotedSources = new Set(files.filter(isPromotedCopy).map((f) => f.appProperties?.[PROMOTED_FROM_PROPERTY]));
  const pool = files.filter((f) => {
    // #11950: também o export nomeado pelo título do corte (`_Vertical_IA Soberana_Edição 08_V2.mp4`).
    if (f.scope !== "final-folder" || !isMp4VideoFile(f) || corteOfName(f.name, cortes) !== corte) return false;
    if (f.editedFolder && promotedSources.has(f.id)) return false;
    const o = classifyOrientation(f);
    return o === null || o === "vertical";
  });
  const inFinal = pool.filter((f) => !f.editedFolder);
  const editorPicked = inFinal.filter((f) => !isPromotedCopy(f));
  if (editorPicked.length === 1) return { kind: "found", corte, file: editorPicked[0] };
  if (editorPicked.length > 1) return { kind: "ambiguous", corte, candidates: editorPicked };
  const versions = [...inFinal, ...pool.filter((f) => f.editedFolder)];
  if (versions.length === 0) {
    return { kind: "none", corte, reason: `nenhum .mp4 terminado em _V{n}-${corte} em Final/ nem em Editados/` };
  }
  if (versions.length === 1) {
    const only = versions[0];
    return only.editedFolder
      ? { kind: "found", corte, file: only, premise: `${only.name} veio de Editados/ (sem export do corte em Final/)` }
      : { kind: "found", corte, file: only };
  }
  const highest = pickHighestVersion(versions);
  if (highest) return { kind: "found", corte, file: highest.file, premise: highest.premise };
  return { kind: "ambiguous", corte, candidates: versions };
}

function isStillImage(f: DriveVideoFile): boolean {
  return f.scope === "final-folder" && /still/i.test(f.name) && /\.(jpe?g|png)$/i.test(f.name);
}

/**
 * #11542: Premiere Export Frame; vertical stills serve todos os verticais.
 * #11950: a Still de um corte (`…_V1-soberana.00_00_00_00.Still002.jpg`, ou
 * com o slug/título do corte no nome) é capa do corte, nunca da vertical da
 * edição (`corteCoverCandidates`).
 */
export function driveCoverCandidates(files: DriveVideoFile[], orientation: VideoOrientation, cortes: readonly CorteRef[] = []): DriveVideoFile[] {
  return files.filter((f) => {
    if (!isStillImage(f)) return false;
    if (orientation === "vertical" && corteOfName(f.name, cortes) !== null) return false;
    const target = videoTargetOf(f.name.replace(/[()]/g, " "));
    return target !== null && targetOrientation(target) === orientation;
  });
}

/** #11950: as Stills de um corte (capa do `--cover` do modo corte). 2+ = o editor escolhe. */
export function corteCoverCandidates(files: DriveVideoFile[], corte: string, cortes: readonly CorteRef[] = []): DriveVideoFile[] {
  return files.filter((f) => isStillImage(f) && corteOfName(f.name, cortes) === corte);
}
