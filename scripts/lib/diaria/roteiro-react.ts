/**
 * scripts/lib/diaria/roteiro-react.ts (#13433, #13434)
 *
 * Avisos do formato react do `/diaria-video-roteiro`: o editor reage a
 * trechos de um vídeo anterior do canal, que entram no horizontal depois de
 * uma fala (`trechoInserido`, #13397). As decisões do editor sobre o formato
 * (roteiro da 261118, versões v5 a v9) estão no Passo 2 da skill; este módulo
 * confere o que dá para conferir sem ler:
 *
 *   - `avisosReactVertical`: fala que vem logo depois de um trecho no
 *     horizontal, reaproveitada num vertical, e que começa apoiada no trecho
 *     ("Essa ainda não dá pra cravar"). O vertical não leva o trecho, então a
 *     fala tem de dizer ela mesma o que foi previsto (v7 da 261118).
 *   - `avisosReacaoPergunta`: a reação abre repetindo o trecho em forma de
 *     pergunta ("Perder o cargo?", v6 da 261118, cortado pelo editor na v7.1).
 *   - `avisosTrechoContraSrt`: o `texto` do trecho não bate com o SRT do vídeo
 *     citado, ou o `inicio` do trecho come a primeira palavra (na 261118 o
 *     trecho 3 começava em 3:54,88, e não em 3:55). Só quando o SRT existe.
 *   - `avisosFactCheckRoteiroDefasado` (#13434): o `02-reviewed.md` mudou
 *     depois do roteiro ou do fact-check do roteiro (na 261118 o D1 trocou
 *     de fonte depois de o roteiro ser escrito).
 *
 * Tudo é aviso: nunca invalida o roteiro nem muda o exit dos CLIs.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { VERTICAIS_ROTEIRO, VIDEO_LABEL, type FalaRoteiro, type RoteiroFalas } from "./roteiro-gravacao.ts";
import { contentWords } from "./youtube-title-research.ts";
import { parseSrtCues, type SrtCue } from "./short-cover-caption.ts";
import { fmtTempoTrecho, lerTrechoInserido, type TrechoInseridoLido } from "./trecho-inserido-formato.ts";

/** Saída do fact-check do roteiro antes da gravação (#13434), relativa à pasta da edição. */
export const FACT_CHECK_ROTEIRO_FILE = "_internal/fact-check-roteiro.md";

/** As falas do horizontal, na ordem do JSON (a ordem da gravação). */
function falasDoHorizontal(roteiro: Pick<RoteiroFalas, "falas">): FalaRoteiro[] {
  return roteiro.falas.filter((f) => f.videos.includes("horizontal"));
}

/** Pares (fala com trecho, fala seguinte) no horizontal. */
function reacoesAoTrecho(roteiro: Pick<RoteiroFalas, "falas">): Array<{ comTrecho: FalaRoteiro; seguinte: FalaRoteiro }> {
  const h = falasDoHorizontal(roteiro);
  const out: Array<{ comTrecho: FalaRoteiro; seguinte: FalaRoteiro }> = [];
  for (let i = 0; i + 1 < h.length; i++) if (h[i].trechoInserido) out.push({ comTrecho: h[i], seguinte: h[i + 1] });
  return out;
}

/** Primeira frase da fala, sem o conectivo do começo ("E", "Mas", "Aí", "Então"). */
function primeiraFraseSemConectivo(texto: string): string {
  const frase = texto.trim().match(/^[^.!?…]*[.!?…]?/u)?.[0] ?? "";
  return frase.replace(/^(?:e|mas|aí|então)[,\s]+/iu, "").trim();
}

/**
 * Começo que só faz sentido depois do trecho: pronome sem antecedente
 * ("Essa", "Isso"), o veredito sem o que foi previsto ("Acertei") e o tempo
 * relativo ao vídeo antigo ("Dois dias depois"). O tempo relativo só conta
 * quando a frase não nomeia ninguém: "Dois dias depois, o Jensen Huang saiu
 * mesmo" (v9 da 261118) diz o fato sozinho.
 */
const ABRE_COM_DEITICO = /^(?:essa|esse|esta|este|isso|isto|aquilo|aquela|aquele|ela|ele|acertei|errei|acertou|errou|aconteceu)(?![\p{L}\p{N}])/iu;
const ABRE_COM_TEMPO_RELATIVO = /^(?:(?:[\p{L}\d]+\s+)?(?:dias?|semanas?|meses|horas?)\s+depois|logo depois|depois disso|depois|no dia seguinte)(?![\p{L}\p{N}])/iu;

/** A frase cita um nome próprio: palavra com inicial maiúscula fora da primeira posição (sem "Eu"). */
function citaNomeProprio(frase: string): boolean {
  const palavras = frase.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  return palavras.slice(1).some((w) => /^\p{Lu}/u.test(w) && w !== "Eu");
}

/**
 * #13433, decisão 7: fala de vertical que vem logo depois de um trecho no
 * horizontal e começa apoiada nele. O vertical não leva o trecho: a fala tem
 * de dizer o que foi previsto ("o Jensen Huang saiu mesmo", "A terceira era o
 * preço…").
 */
export function avisosReactVertical(roteiro: Pick<RoteiroFalas, "falas">): string[] {
  const avisos: string[] = [];
  for (const { comTrecho, seguinte } of reacoesAoTrecho(roteiro)) {
    const verticais = VERTICAIS_ROTEIRO.filter((v) => seguinte.videos.includes(v));
    if (!verticais.length) continue;
    const frase = primeiraFraseSemConectivo(seguinte.texto);
    const deitico = ABRE_COM_DEITICO.test(frase);
    const tempo = !deitico && ABRE_COM_TEMPO_RELATIVO.test(frase) && !citaNomeProprio(frase);
    if (!deitico && !tempo) continue;
    avisos.push(
      `${seguinte.id}: vem logo depois do trecho inserido em ${comTrecho.id} e está no ${verticais.map((v) => VIDEO_LABEL[v]).join(" e no ")}, que não leva o trecho; "${frase}" se apoia nele. A fala tem de dizer ela mesma o que foi previsto (#13433).`,
    );
  }
  return avisos;
}

/**
 * #13433, decisão 3: a reação não repete a previsão em forma de pergunta. A
 * primeira frase depois do trecho é uma pergunta com palavra do próprio trecho
 * ("Perder o cargo?" depois de "pode chegar a perder o cargo atual dele").
 */
export function avisosReacaoPergunta(roteiro: Pick<RoteiroFalas, "falas">): string[] {
  const avisos: string[] = [];
  for (const { comTrecho, seguinte } of reacoesAoTrecho(roteiro)) {
    const frase = seguinte.texto.trim().match(/^[^.!?…]*[.!?…]?/u)?.[0] ?? "";
    if (!frase.trim().endsWith("?")) continue;
    const doTrecho = new Set(contentWords(comTrecho.trechoInserido!.texto));
    const comuns = contentWords(frase).filter((w) => doTrecho.has(w));
    if (!comuns.length) continue;
    avisos.push(`${seguinte.id}: a reação ao trecho de ${comTrecho.id} abre repetindo a previsão em pergunta ("${frase.trim()}"); o trecho acabou de dizer, comentar direto (#13433).`);
  }
  return avisos;
}

export { intervaloDaOrigem, videoIdDaOrigem } from "./trecho-inserido-formato.ts";

/** Texto para comparar: minúsculas, sem acento, só letras e dígitos separados por espaço. */
function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Folga (s) do intervalo do trecho ao escolher as legendas que ele cobre. */
const FOLGA_INTERVALO_S = 1;

/**
 * #13433, decisão 2: o `texto` do trecho é o do SRT do vídeo publicado, e o
 * `inicio` não come a primeira palavra. `srtDoVideo(ref)` devolve o conteúdo
 * do SRT do vídeo citado (pelo id do YouTube ou pela edição, #13437), ou
 * `null` (sem SRT: nada a conferir). Trecho que não passa na leitura do
 * formato fica para o validador, que já o recusa.
 */
export function avisosTrechoContraSrt(
  roteiro: Pick<RoteiroFalas, "falas">,
  srtDoVideo: (ref: Pick<TrechoInseridoLido, "youtubeId" | "edicao">) => string | null,
): string[] {
  const avisos: string[] = [];
  for (const f of falasDoHorizontal(roteiro)) {
    if (!f.trechoInserido) continue;
    const lido = lerTrechoInserido(f.trechoInserido);
    if (!lido.ok) continue;
    const t = lido.trecho;
    const nome = t.youtubeId ?? t.edicao;
    const srt = srtDoVideo(t);
    if (srt === null) continue;
    const cues = parseSrtCues(srt);
    if (!cues.length) continue;
    const alvo = normalizar(t.texto);
    if (!alvo) continue;
    const intervalo = { inicio: t.inicioS, fim: t.fimS };
    const todas = normalizar(cues.map((c) => c.text).join(" "));
    const janela = cues.filter((c) => c.end > intervalo.inicio - FOLGA_INTERVALO_S && c.start < intervalo.fim + FOLGA_INTERVALO_S);
    if (!normalizar(janela.map((c) => c.text).join(" ")).includes(alvo)) {
      avisos.push(
        todas.includes(alvo)
          ? `${f.id}: trechoInserido.texto está no SRT do vídeo ${nome}, mas fora do intervalo do trecho (${fmtTempoTrecho(intervalo.inicio)} a ${fmtTempoTrecho(intervalo.fim)}); conferir o tempo (#13433).`
          : `${f.id}: trechoInserido.texto não bate com o SRT do vídeo ${nome} entre ${fmtTempoTrecho(intervalo.inicio)} e ${fmtTempoTrecho(intervalo.fim)}; transcrever do SRT, nunca de memória (#13433).`,
      );
      continue;
    }
    const primeira = primeiraLegendaDoTrecho(janela, alvo);
    if (primeira && intervalo.inicio > primeira.start) {
      avisos.push(`${f.id}: o trecho começa em ${fmtTempoTrecho(intervalo.inicio)}, mas a legenda com a primeira palavra começa em ${fmtTempoTrecho(primeira.start)}; o corte come o começo da fala (#13433).`);
    }
  }
  return avisos;
}

/** A legenda em que o trecho começa: a primeira da janela a partir da qual o texto casa. */
function primeiraLegendaDoTrecho(janela: SrtCue[], alvo: string): SrtCue | null {
  for (let i = janela.length - 1; i >= 0; i--) {
    if (normalizar(janela.slice(i).map((c) => c.text).join(" ")).includes(alvo)) return janela[i];
  }
  return null;
}

/**
 * Todos os avisos do formato react (#13433), na ordem: vertical sem o trecho,
 * reação em pergunta, trecho contra o SRT (procurado em `editionsRootDir`).
 * Roteiro sem `trechoInserido` não lê nada do disco.
 */
export function avisosFormatoReact(roteiro: Pick<RoteiroFalas, "falas">, editionsRootDir: string): string[] {
  if (!roteiro.falas.some((f) => f.trechoInserido)) return [];
  const cache = new Map<string, string | null>();
  const srt = (ref: Pick<TrechoInseridoLido, "youtubeId" | "edicao">) => {
    const chave = ref.edicao ? `ed:${ref.edicao}` : `yt:${ref.youtubeId}`;
    if (!cache.has(chave)) cache.set(chave, ref.edicao ? srtDaEdicao(editionsRootDir, ref.edicao) : ref.youtubeId ? srtDoVideoPublicado(editionsRootDir, ref.youtubeId) : null);
    return cache.get(chave) ?? null;
  };
  return [...avisosReactVertical(roteiro), ...avisosReacaoPergunta(roteiro), ...avisosTrechoContraSrt(roteiro, srt)];
}

/**
 * O SRT do vídeo `videoId` publicado pelo canal: a edição cujo
 * `_internal/05-youtube-published.json` tem esse `videoId`, e nela o
 * `diaria-comentada-{AAMMDD}.srt` (o SRT que subiu com o horizontal). Sem
 * registro ou sem SRT, `null`. Fail-soft: arquivo ilegível vira ausência.
 */
export function srtDoVideoPublicado(editionsRootDir: string, videoId: string): string | null {
  const pub = edicaoDoVideoPublicado(editionsRootDir, videoId);
  if (!pub) return null;
  const srt = join(pub.dir, `diaria-comentada-${pub.edicao}.srt`);
  try {
    return existsSync(srt) ? readFileSync(srt, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * A edição que publicou o vídeo `videoId` no canal: a que tem o `videoId` no
 * `_internal/05-youtube-published.json`, com a pasta dela e o `video_path` do
 * registro (o export que subiu; pode ser de outra máquina). Sem registro,
 * `null`. Fail-soft: registro ilegível conta como ausente (#13437).
 */
export function edicaoDoVideoPublicado(editionsRootDir: string, videoId: string): { edicao: string; dir: string; videoPath: string | null } | null {
  let meses: string[];
  try {
    meses = readdirSync(editionsRootDir).filter((d) => /^\d{4}$/.test(d));
  } catch {
    return null;
  }
  for (const mes of meses.sort().reverse()) {
    let edicoes: string[];
    try {
      edicoes = readdirSync(join(editionsRootDir, mes)).filter((d) => /^\d{6}$/.test(d));
    } catch {
      continue;
    }
    for (const ed of edicoes) {
      const dir = join(editionsRootDir, mes, ed);
      const reg = join(dir, "_internal", "05-youtube-published.json");
      if (!existsSync(reg)) continue;
      const r = lerRegistroPublicado(reg);
      if (!r || r.videoId !== videoId) continue;
      return { edicao: ed, dir, videoPath: r.videoPath };
    }
  }
  return null;
}

/** O `05-youtube-published.json` lido (`videoId` e `video_path`); ilegível = `null`. */
function lerRegistroPublicado(reg: string): { videoId: unknown; videoPath: string | null } | null {
  try {
    const r = JSON.parse(readFileSync(reg, "utf8")) as { videoId?: unknown; video_path?: unknown } | null;
    if (!r || typeof r !== "object") return null;
    return { videoId: r.videoId, videoPath: typeof r.video_path === "string" && r.video_path.trim() ? r.video_path : null };
  } catch {
    return null;
  }
}

/**
 * O registro de publicação da edição `aammdd` (`video` do trecho como edição,
 * #13437): `{AAMM}/{AAMMDD}/_internal/05-youtube-published.json`, com o
 * caminho dele e o `video_path` (o export que subiu). `registro: false` =
 * arquivo ausente ou ilegível; `videoPath: null` = registro sem `video_path`.
 */
export function registroDaEdicao(editionsRootDir: string, aammdd: string): { path: string; registro: boolean; videoPath: string | null } {
  const path = join(editionsRootDir, aammdd.slice(0, 4), aammdd, "_internal", "05-youtube-published.json");
  const r = existsSync(path) ? lerRegistroPublicado(path) : null;
  return { path, registro: r !== null, videoPath: r?.videoPath ?? null };
}

/**
 * O SRT do horizontal da edição `aammdd` (`video` do trecho como edição,
 * #13437): `{AAMM}/{AAMMDD}/diaria-comentada-{AAMMDD}.srt`. Sem arquivo, `null`.
 */
export function srtDaEdicao(editionsRootDir: string, aammdd: string): string | null {
  const srt = join(editionsRootDir, aammdd.slice(0, 4), aammdd, `diaria-comentada-${aammdd}.srt`);
  try {
    return existsSync(srt) ? readFileSync(srt, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * #13434: o fact-check do roteiro usa o D1 atual da edição. Avisa quando o
 * `02-reviewed.md` mudou depois do `roteiro-falas.json` (o roteiro pode ter
 * sido escrito sobre outro D1, como na 261118) ou depois do
 * `fact-check-roteiro.md` (o fact-check ficou velho). Sem o `02-reviewed.md`,
 * nada a comparar.
 */
export function avisosFactCheckRoteiroDefasado(editionDirPath: string, falasPath: string): string[] {
  const mtime = (p: string): number | null => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return null;
    }
  };
  const d1 = mtime(join(editionDirPath, "02-reviewed.md"));
  if (d1 === null) return [];
  const avisos: string[] = [];
  const roteiro = mtime(falasPath);
  if (roteiro !== null && d1 > roteiro) avisos.push("02-reviewed.md mudou depois do roteiro-falas.json: conferir se o D1 é o mesmo e refazer o fact-check do roteiro (#13434).");
  const fc = mtime(join(editionDirPath, FACT_CHECK_ROTEIRO_FILE));
  if (fc !== null && d1 > fc) avisos.push(`02-reviewed.md mudou depois do ${FACT_CHECK_ROTEIRO_FILE}: refazer o fact-check do roteiro contra o D1 atual (#13434).`);
  return avisos;
}
