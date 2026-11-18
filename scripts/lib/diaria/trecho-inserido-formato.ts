/**
 * scripts/lib/diaria/trecho-inserido-formato.ts (#13437, PR 1 = formato)
 *
 * Formato de `trechoInserido` (o trecho de outro vídeo que entra no
 * horizontal depois de uma fala, formato react, campo da #13397). Decisão do
 * editor de 17/11/2026 (#13437): campos estruturados
 *
 *   { "video": "youtu.be/ID" | "AAMMDD", "inicio": "3:42", "fim": "4:00", "texto": "…" }
 *
 * no lugar do texto livre `origem` ("Vídeo de 10/11, youtu.be/…, 3:42 a 4:00"),
 * para a montagem ler vídeo e intervalo sem adivinhar e o validador pegar erro
 * de digitação. `video` é o link do YouTube (youtu.be/ID, watch?v=ID,
 * shorts/ID, live/ID) ou a edição do vídeo (AAMMDD, a pasta que tem o
 * `05-youtube-published.json` e o SRT). `inicio`/`fim` são "m:ss", "h:mm:ss",
 * com fração opcional ("3:54,88" ou "3:54.88"), ou segundos (número).
 *
 * Migração: o formato antigo `{ origem, texto }` segue lido, convertido aqui
 * (`lerTrechoInserido`, `migrarTrechoInserido`) quando a `origem` tem o link
 * do YouTube e um intervalo legível; sem isso o validador recusa e pede o
 * formato novo. `scripts/migrar-trecho-inserido.ts` regrava o JSON no formato
 * novo.
 *
 * Módulo folha (sem import do projeto): `roteiro-gravacao.ts`,
 * `roteiro-react.ts`, `roteiro-pagina.ts` e `video-trecho-inserido.ts` leem
 * daqui sem fechar ciclo com `video-montage.ts`.
 */

/** O formato novo, como vai no `roteiro-falas.json`. */
export interface TrechoInseridoEstruturado {
  /** Link do YouTube do vídeo de origem ou a edição dele (AAMMDD). */
  video: string;
  /** Início do trecho no vídeo de origem ("m:ss", "h:mm:ss", fração opcional, ou segundos). */
  inicio: string | number;
  /** Fim do trecho, no mesmo formato. */
  fim: string | number;
  /** A fala do trecho, transcrita do SRT do vídeo publicado. */
  texto: string;
}

/** O formato antigo (até a #13437): origem em texto livre. Lido por migração. */
export interface TrechoInseridoLegado {
  origem: string;
  texto: string;
}

export type TrechoInseridoCampo = TrechoInseridoEstruturado | TrechoInseridoLegado;

/** O trecho já lido e conferido, nos dois formatos. */
export interface TrechoInseridoLido {
  /** `youtu.be/ID` (normalizado) ou a edição AAMMDD. */
  video: string;
  /** Id do vídeo no YouTube, quando `video` é link. */
  youtubeId: string | null;
  /** Edição do vídeo (AAMMDD), quando `video` é a edição. */
  edicao: string | null;
  inicioS: number;
  fimS: number;
  texto: string;
  /** Veio do formato antigo (`origem` em texto livre). */
  migrado: boolean;
}

export type LeituraTrecho = { ok: true; trecho: TrechoInseridoLido } | { ok: false; problemas: string[] };

const SETA = /[→←]/;
const YT_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^\s,)]*&)?v=|shorts\/|live\/))([\w-]{11})(?![\w-])/u;
const EDICAO_RE = /^(\d{2})(\d{2})(\d{2})$/u;
const TEMPO = String.raw`\d{1,2}(?::\d{2}){1,2}(?:[,.]\d{1,3})?`;
const INTERVALO_RE = new RegExp(`(${TEMPO})\\s*(?:a|até|-|–|—)\\s*(${TEMPO})`, "u");

/** Id do vídeo do YouTube num texto ("youtu.be/ID", "youtube.com/watch?v=ID", "/shorts/ID", "/live/ID"). */
export function videoIdDaOrigem(texto: string): string | null {
  return YT_RE.exec(texto)?.[1] ?? null;
}

/** Tempo "m:ss", "h:mm:ss" ou com fração ("3:54,88"), ou segundos (número ≥ 0). `null` se ilegível. */
export function segundosTrecho(t: unknown): number | null {
  if (typeof t === "number") return Number.isFinite(t) && t >= 0 ? t : null;
  if (typeof t !== "string") return null;
  const m = t.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[,.](\d{1,3}))?$/u);
  if (!m) return null;
  const min = Number(m[2]);
  const seg = Number(m[3]);
  if (seg > 59 || (m[1] !== undefined && min > 59)) return null;
  return Number(m[1] ?? 0) * 3600 + min * 60 + seg + (m[4] ? Number(m[4].padEnd(3, "0")) / 1000 : 0);
}

/** O intervalo de uma `origem` antiga ("de 3:42 a 3:46", "3:42-4:00", "3:54,88 a 4:27"), em segundos. */
export function intervaloDaOrigem(origem: string): { inicio: number; fim: number } | null {
  const m = INTERVALO_RE.exec(origem);
  if (!m) return null;
  const inicio = segundosTrecho(m[1]);
  const fim = segundosTrecho(m[2]);
  return inicio === null || fim === null || fim <= inicio ? null : { inicio, fim };
}

/** "m:ss" com fração em centésimos quando houver ("3:54,88"); acima de uma hora, "h:mm:ss". */
export function fmtTempoTrecho(s: number): string {
  const cent = Math.round(s * 100);
  const inteiro = Math.floor(cent / 100);
  const frac = cent % 100;
  const h = Math.floor(inteiro / 3600);
  const min = Math.floor((inteiro % 3600) / 60);
  const seg = inteiro % 60;
  const base = h ? `${h}:${String(min).padStart(2, "0")}:${String(seg).padStart(2, "0")}` : `${min}:${String(seg).padStart(2, "0")}`;
  return frac ? `${base},${String(frac).padStart(2, "0")}` : base;
}

/** Valida e normaliza o `video`: link do YouTube vira `youtu.be/ID`; AAMMDD fica como está. */
function lerVideo(v: unknown): { video: string; youtubeId: string | null; edicao: string | null } | string {
  if (typeof v !== "string" || !v.trim()) return "video deve ser o link do YouTube (youtu.be/ID) ou a edição do vídeo (AAMMDD)";
  const s = v.trim();
  const ed = EDICAO_RE.exec(s);
  if (ed) {
    const mes = Number(ed[2]);
    const dia = Number(ed[3]);
    if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return `video "${s}" não é uma edição AAMMDD válida`;
    return { video: s, youtubeId: null, edicao: s };
  }
  const id = videoIdDaOrigem(s);
  if (!id) return `video "${s}" não é link do YouTube (youtu.be/ID, youtube.com/watch?v=ID) nem edição AAMMDD`;
  return { video: `youtu.be/${id}`, youtubeId: id, edicao: null };
}

function lerTexto(t: unknown, problemas: string[]): string | null {
  if (typeof t !== "string" || !t.trim()) {
    problemas.push("texto deve ser texto não vazio");
    return null;
  }
  if (SETA.test(t)) {
    problemas.push("texto usa seta (→/←), proibida na página (#9721)");
    return null;
  }
  return t.trim();
}

/**
 * Lê `trechoInserido` nos dois formatos. Os problemas saem sem prefixo
 * (`video deve ser…`); quem chama põe o rótulo da fala. O formato antigo só
 * passa com link do YouTube e intervalo legíveis na `origem`.
 */
export function lerTrechoInserido(raw: unknown): LeituraTrecho {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problemas: ["deve ser objeto { video, inicio, fim, texto }"] };
  const o = raw as Record<string, unknown>;
  const problemas: string[] = [];
  const estruturado = "video" in o || "inicio" in o || "fim" in o;
  if (!estruturado && "origem" in o) {
    const texto = lerTexto(o.texto, problemas);
    if (typeof o.origem !== "string" || !o.origem.trim()) {
      problemas.push("origem (formato antigo) deve ser texto não vazio; use { video, inicio, fim, texto }");
      return { ok: false, problemas };
    }
    const origem = o.origem.trim();
    if (SETA.test(origem)) problemas.push("origem usa seta (→/←), proibida na página (#9721)");
    const id = videoIdDaOrigem(origem);
    const iv = intervaloDaOrigem(origem);
    if (!id || !iv) {
      problemas.push(
        `origem "${origem}" (texto livre, formato antigo) sem ${!id ? "link do YouTube" : ""}${!id && !iv ? " nem " : ""}${!iv ? 'intervalo legível ("3:42 a 4:00")' : ""}; use { video, inicio, fim, texto } (#13437)`,
      );
    }
    if (problemas.length || texto === null || !id || !iv) return { ok: false, problemas };
    return { ok: true, trecho: { video: `youtu.be/${id}`, youtubeId: id, edicao: null, inicioS: iv.inicio, fimS: iv.fim, texto, migrado: true } };
  }
  if ("origem" in o) problemas.push("origem é do formato antigo; com video/inicio/fim, tire a origem");
  const desconhecidas = Object.keys(o).filter((k) => !["video", "inicio", "fim", "texto", "origem"].includes(k));
  if (desconhecidas.length) problemas.push(`campos desconhecidos: ${desconhecidas.join(", ")} (o formato é { video, inicio, fim, texto })`);
  const video = lerVideo(o.video);
  if (typeof video === "string") problemas.push(video);
  const inicioS = segundosTrecho(o.inicio);
  const fimS = segundosTrecho(o.fim);
  if (inicioS === null) problemas.push(`inicio ${JSON.stringify(o.inicio ?? null)} deve ser "m:ss" (fração opcional, "3:54,88") ou segundos`);
  if (fimS === null) problemas.push(`fim ${JSON.stringify(o.fim ?? null)} deve ser "m:ss" (fração opcional, "3:54,88") ou segundos`);
  if (inicioS !== null && fimS !== null && fimS <= inicioS) problemas.push(`fim (${fmtTempoTrecho(fimS)}) deve vir depois do inicio (${fmtTempoTrecho(inicioS)})`);
  const texto = lerTexto(o.texto, problemas);
  if (problemas.length || typeof video === "string" || inicioS === null || fimS === null || texto === null) return { ok: false, problemas };
  return { ok: true, trecho: { ...video, inicioS, fimS, texto, migrado: false } };
}

/**
 * O trecho no formato novo, para regravar o JSON: o antigo convertido (com
 * `inicio`/`fim` em "m:ss"), o novo como está. `null` = não dá para migrar
 * (`lerTrechoInserido` diz por quê).
 */
export function migrarTrechoInserido(raw: unknown): TrechoInseridoEstruturado | null {
  const r = lerTrechoInserido(raw);
  if (!r.ok) return null;
  if (!r.trecho.migrado) return raw as TrechoInseridoEstruturado;
  return { video: r.trecho.video, inicio: fmtTempoTrecho(r.trecho.inicioS), fim: fmtTempoTrecho(r.trecho.fimS), texto: r.trecho.texto };
}

/** Rótulo do trecho na página e no marcador do XML: "Vídeo de 10/11 (261110), 3:42 a 4:00" ou "youtu.be/ID, 3:42 a 4:00". */
export function rotuloTrecho(t: Pick<TrechoInseridoLido, "video" | "edicao" | "inicioS" | "fimS">): string {
  const intervalo = `${fmtTempoTrecho(t.inicioS)} a ${fmtTempoTrecho(t.fimS)}`;
  if (t.edicao) return `Vídeo de ${t.edicao.slice(4, 6)}/${t.edicao.slice(2, 4)} (${t.edicao}), ${intervalo}`;
  return `${t.video}, ${intervalo}`;
}
