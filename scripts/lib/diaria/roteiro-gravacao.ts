/**
 * scripts/lib/diaria/roteiro-gravacao.ts (#12754)
 *
 * Primeira passada DETERMINÍSTICA do passo "conferir a gravação contra o
 * roteiro" do `/diaria-video-roteiro`: o editor grava, dita a transcrição no
 * Claude Code e a skill diz, por fala numerada (`H1`, `H2`…, mais as falas
 * "gravar à parte"), se o que foi gravado serve.
 *
 * O que este módulo resolve sozinho: casar cada fala com o trecho da
 * transcrição que mais se parece com ela (por CONTEÚDO, nunca por posição: a
 * ordem da gravação pode não ser a do roteiro), medir a cobertura das
 * palavras de conteúdo, apontar número do roteiro que não apareceu no trecho,
 * nome de veículo dito em voz alta e trechos da transcrição que nenhuma fala
 * explica (improviso ou fala nova).
 *
 * O que ele NÃO resolve: se outras palavras mantêm o mesmo sentido e o mesmo
 * fato, se uma diferença é erro do ditado por voz, se a fala ainda funciona
 * sozinha num vertical. Por isso todo veredito diferente de `ok` sai com
 * `confirmar: true`: é sugestão para o modelo confirmar lendo o trecho, nunca
 * ordem de regravar (na dúvida, a skill pergunta ao editor).
 */

import { isBlockKey, normalizeToken, type BlockKey } from "./video-montage.ts";

export type VideoRoteiro = "horizontal" | "vertical1" | "vertical2";
export const VIDEOS_ROTEIRO: readonly VideoRoteiro[] = ["horizontal", "vertical1", "vertical2"];

export const VIDEO_LABEL: Record<VideoRoteiro, string> = {
  horizontal: "horizontal",
  vertical1: "vertical 1",
  vertical2: "vertical 2",
};

export interface FalaRoteiro {
  /** Número da fala no roteiro: `H1`, `H2`…, ou o id da fala gravada à parte. */
  id: string;
  texto: string;
  /** Vídeos que usam a fala. */
  videos: VideoRoteiro[];
  /** Fala gravada à parte (gancho do vertical 2, chamada final do vertical 1). */
  gravarAParte?: boolean;
  /**
   * Bloco da montagem (`BlockKey` do `/diaria-video-montagem`) em que a fala
   * entra no horizontal, ou no vertical quando ela não está no horizontal
   * (#12751): `gancho`, `abertura`, `resumo`, `comentario`, `cta_vertical`…
   * A proposta de blocos (`scripts/lib/diaria/roteiro-videos.ts`) lê daqui.
   */
  bloco?: BlockKey;
  /**
   * Texto curto que vai escrito na tela durante a fala (#13120): o nome exato
   * de um arquivo ou modelo que a fala descreve sem citar, os números, uma
   * comparação. A página mostra num box "Na tela" ao lado da fala; levar o
   * texto ao XML da montagem é a #13140. Sem seta (#9721).
   */
  tela?: string;
  /**
   * Tópicos da fala, para o editor gravar sem ler: bullets de até
   * `TOPICO_MAX_PALAVRAS` palavras cada (pedido do editor, 17/11/2026). Só a
   * página mostra, numa coluna ao lado da fala, em todos os vídeos que a usam;
   * não vai para o XML nem para a legenda.
   */
  topicos?: string[];
  /**
   * Trecho de outro vídeo que entra logo depois desta fala, no horizontal
   * (formato react, pedido do editor em 17/11/2026): `origem` diz de onde
   * vem e o intervalo ("Vídeo de 10/11, youtu.be/…, 3:42 a 4:00") e `texto`
   * é a fala do trecho, transcrita. Só a página mostra, entre aspas, depois
   * da fala; a montagem insere o trecho à mão.
   */
  trechoInserido?: { origem: string; texto: string };
  /**
   * Corte parcial da fala por vertical (#13129): o trecho exato a tirar só
   * naquele vídeo (o horizontal fica intacto: o validador recusa `horizontal`). `reserva: true` = só entra se o
   * vídeo passar do alvo de duração.
   */
  cortes?: Partial<Record<VideoRoteiro, string | CorteFala>>;
  /** Fontes do que a fala afirma, quando o fato não está na fonte do D1 (#13132). */
  fontes?: FonteFala[];
}

/** Um corte parcial (#13129): o trecho exato da fala e se é só de reserva. */
export interface CorteFala {
  trecho: string;
  reserva?: boolean;
}

/** Fonte de uma fala (#13132): a URL e o que ela sustenta. */
export interface FonteFala {
  url: string;
  sustenta: string;
}

/** Título, texto da capa, card de CTA e (só nos verticais) ordem de um vídeo do roteiro (#12751, #13128). */
export interface PecaVideo {
  /** #13164: fala onde começa o trecho para compartilhar (só horizontal). */
  trechoCompartilhar?: { inicio: string; rotulo: string };
  titulo?: string;
  capa?: string;
  /**
   * Só nos verticais (#13128): a sequência das falas daquele corte, por id.
   * Sem o campo, vale a ordem do horizontal (a das falas no JSON).
   */
  ordem?: string[];
  /** Texto do card de CTA do vídeo na página (#13120); ausente = o card padrão. */
  cta?: string;
  /**
   * Só no vertical 1 (#13280, decisão do editor no briefing 261116b): o
   * vertical pertence ao horizontal da edição, e a legenda dele chama para o
   * vídeo completo ("Vídeo completo: link na bio" e, no TikTok sem link na
   * bio, a chamada pelo @). Decide no lugar da comparação de títulos do
   * #13209, que nunca casa quando o horizontal usa o título do roteiro.
   * Ausente = vale a comparação de títulos. O vertical 2 sai como corte
   * avulso, sem horizontal, e não leva o campo.
   */
  pertenceAoHorizontal?: boolean;
}

/** O corte de uma fala num vídeo, normalizado (string vira `{ trecho }`). */
export function corteDaFala(f: Pick<FalaRoteiro, "cortes">, v: VideoRoteiro): CorteFala | null {
  const c = f.cortes?.[v];
  if (c === undefined) return null;
  return typeof c === "string" ? { trecho: c } : c;
}

/**
 * Os trechos que sobram da fala depois de tirar `trecho` (#13129): um, se o
 * corte está no começo ou no fim (no fim, o que sobra ganha a pontuação final);
 * dois, se está no meio, sem pontuação nem maiúscula forçadas. Espaço antes de
 * pontuação e vírgula solta na emenda saem. Trecho vazio ou ausente no texto =
 * `null`; trecho que é a fala inteira = `[]`. Corta a primeira ocorrência: o
 * validador recusa trecho que aparece mais de uma vez (`ocorrenciasDoTrecho`).
 */
export function segmentosSemTrecho(texto: string, trecho: string): string[] | null {
  const t = trecho.trim();
  if (!t) return null;
  const i = posicoesDoTrecho(texto, t)[0] ?? -1;
  if (i < 0) return null;
  const limpa = (s: string) => s.replace(/\s+([.,;:!?…])/g, "$1").replace(/\s+/g, " ").trim();
  const antes = limpa(texto.slice(0, i)).replace(/[\s,;:]+$/, "");
  const depois = texto.slice(i + t.length);
  // Corte no fim: o que sobra antes ganha a pontuação final do texto original.
  if (!/[\p{L}\p{N}]/u.test(depois)) {
    if (!antes) return [];
    // A pontuação final vem do que sobrou depois do trecho, ou do próprio trecho; sem nenhuma, ponto.
    const fim = depois.match(/[.!?…]/u)?.[0] ?? t.match(/[.!?…]$/u)?.[0] ?? ".";
    return [/[.!?…]$/u.test(antes) ? antes : antes + fim];
  }
  // Corte no meio: os dois lados ficam como estavam (sem ponto nem maiúscula forçados),
  // porque a fala gravada é contínua; cada um vira um item que casa sozinho na decupagem.
  const resto = limpa(depois).replace(/^[\s,;:]+/, "");
  return [antes, resto].filter(Boolean);
}

/** Seta proibida no texto que chega ao leitor (#9721). */
export const SETA = /[→←]/;

/** Tamanho máximo de cada tópico da fala (`topicos`), em palavras. */
export const TOPICO_MAX_PALAVRAS = 4;

/** Palavras de um tópico: sequências separadas por espaço; pontuação solta não conta. */
export function contarPalavrasTopico(t: string): number {
  return t.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/**
 * As posições em que o trecho aparece no texto como palavras inteiras (#13129):
 * uma ocorrência no meio de uma palavra ("Hydro" de "Hydrogen") não conta.
 * Validador, corte e página usam esta mesma busca, para nunca discordarem.
 */
export function posicoesDoTrecho(texto: string, trecho: string): number[] {
  const t = trecho.trim();
  if (!t) return [];
  const letra = /[\p{L}\p{N}]/u;
  const out: number[] = [];
  for (let i = texto.indexOf(t); i >= 0; i = texto.indexOf(t, i + 1)) {
    const antes = i > 0 ? texto[i - 1] : "";
    const depois = texto[i + t.length] ?? "";
    if ((antes && letra.test(antes) && letra.test(t[0])) || (depois && letra.test(depois) && letra.test(t[t.length - 1]))) continue;
    out.push(i);
  }
  return out;
}

/** Quantas vezes o trecho aparece no texto como palavras inteiras (#13129). */
export function ocorrenciasDoTrecho(texto: string, trecho: string): number {
  return posicoesDoTrecho(texto, trecho).length;
}

export interface RoteiroFalas {
  edicao?: string;
  /** Nomes de veículo que não podem ser ditos (regra "nunca citar o veículo"). */
  veiculos?: string[];
  falas: FalaRoteiro[];
  /**
   * Título e texto da capa de cada vídeo, como a página do roteiro os traz
   * (#12751). A montagem usa o título dos verticais na tela; o
   * `/diaria-publica` usa o título do horizontal no YouTube e os textos da capa.
   */
  porVideo?: Partial<Record<VideoRoteiro, PecaVideo>>;
  /** Itens a mais da caixa "Gravação" no topo da página (#13120), ex.: o que conferir antes de gravar. */
  gravacao?: string[];
  /** "Notas para a edição" livres, no fim da página (#13120); cortes, ordem e fontes saem dos campos próprios. */
  notas?: string[];
}

/**
 * - `ok`: dita como no roteiro.
 * - `diferente-mas-cabe`: reformulação; o modelo confirma que o sentido e o fato ficaram (muda o texto da página).
 * - `regravar`: número do roteiro ausente ou veículo citado no trecho (o veículo
 *   que o próprio texto da fala cita, a empresa que também é veículo, não conta, #12781).
 * - `faltou`: nenhum trecho da transcrição se parece com a fala.
 */
export type VereditoFala = "ok" | "diferente-mas-cabe" | "regravar" | "faltou";

export interface ConferenciaFala {
  id: string;
  videos: VideoRoteiro[];
  gravarAParte: boolean;
  texto: string;
  veredito: VereditoFala;
  /** Fração (0..1) das palavras de conteúdo da fala achadas no melhor trecho. */
  cobertura: number;
  /** Trecho da transcrição casado com a fala (vazio em `faltou`). */
  trecho: string;
  /** Números da fala que não aparecem no trecho (nem por extenso). */
  numerosAusentes: string[];
  /** Veículos ditos dentro do trecho. */
  veiculosCitados: string[];
  motivos: string[];
  /** true = sugestão do passo determinístico; o modelo confirma lendo o trecho. */
  confirmar: boolean;
  /**
   * true = a fala só casou na segunda passada (#13178), com um trecho que
   * nenhuma fala explicava, por radical comum e termos-chave. Sai
   * `diferente-mas-cabe` (ou `regravar`, se o trecho citou o veículo), nunca `ok`.
   */
  resgatada?: boolean;
}

export interface ResultadoConferencia {
  falas: ConferenciaFala[];
  /** Trechos da transcrição que nenhuma fala explica (improviso, fala nova, outra tomada). */
  trechosSemFala: string[];
  /** Veículos ditos fora de qualquer trecho casado. */
  veiculosForaDeFala: string[];
  /** Falas `regravar`/`faltou`, na ordem do roteiro. */
  pendencias: ConferenciaFala[];
  /** Vídeos afetados por alguma pendência. */
  videosAfetados: VideoRoteiro[];
  /** Sem pendência no passo determinístico. */
  pronto: boolean;
}

/** Limiares de cobertura (palavras de conteúdo da fala achadas no trecho). */
export const COBERTURA_OK = 0.85;
export const COBERTURA_MINIMA = 0.5;
/** Tamanho mínimo, em palavras de conteúdo, de um trecho sem fala que vale apontar. */
export const TRECHO_SEM_FALA_MIN = 5;
/**
 * Segunda chance antes do `faltou` (#13178): cobertura mínima da fala num
 * trecho que nenhuma fala explica, contando radical comum ("falsas"/"falsos",
 * "cansada"/"cansaço") e número dito em dígito ou por extenso ("nove"/"9").
 * Mais baixa que `COBERTURA_MINIMA` porque o trecho já é o resto da
 * transcrição, sem dono, e a fala reformulada troca muitas palavras.
 */
export const COBERTURA_RESGATE = 0.35;
/** Palavras de conteúdo (ou números) da fala que o trecho tem de trazer para o resgate valer. */
export const RESGATE_MIN_TERMOS = 4;

const STOPWORDS = new Set(
  (
    "a o as os um uma uns umas de do da dos das e em no na nos nas num numa " +
    "por pra pro pras pros para com sem que se ao aos à às é é eu tu ele ela " +
    "eles elas me te lhe isso isto esse essa este esta aquele aquela " +
    "mas ou ja la ai entao tambem so mais muito bem tipo ne ta tá"
  )
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean),
);

const EXTENSO: Record<string, string[]> = {
  "0": ["zero"], "1": ["um", "uma"], "2": ["dois", "duas"], "3": ["tres"],
  "4": ["quatro"], "5": ["cinco"], "6": ["seis"], "7": ["sete"], "8": ["oito"],
  "9": ["nove"], "10": ["dez"], "11": ["onze"], "12": ["doze"], "13": ["treze"],
  "14": ["catorze", "quatorze"], "15": ["quinze"], "16": ["dezesseis"],
  "17": ["dezessete"], "18": ["dezoito"], "19": ["dezenove"], "20": ["vinte"],
  "30": ["trinta"], "40": ["quarenta"], "50": ["cinquenta"], "60": ["sessenta"],
  "70": ["setenta"], "80": ["oitenta"], "90": ["noventa"], "100": ["cem"],
  "200": ["duzentos", "duzentas"], "300": ["trezentos", "trezentas"],
  "400": ["quatrocentos"], "500": ["quinhentos", "quinhentas"],
  "600": ["seiscentos"], "700": ["setecentos"], "800": ["oitocentos"],
  "900": ["novecentos"], "1000": ["mil"],
};

interface Tok {
  norm: string;
  raw: string;
}

function toks(text: string): Tok[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => ({ raw, norm: normalizeToken(raw) }))
    .filter((t) => t.norm);
}

function isConteudo(norm: string): boolean {
  return !STOPWORDS.has(norm);
}

/** Números da fala, normalizados ("2.000" → "2000", "40%" → "40"). */
export function numerosDaFala(texto: string): string[] {
  const out: string[] = [];
  for (const m of texto.matchAll(/\d[\d.,]*/g)) {
    const n = m[0].replace(/[.,]+$/, "");
    // "2.000" é milhar; "1,5" é decimal: manter os dígitos, sem separador.
    out.push(n.replace(/[.,]/g, ""));
  }
  return [...new Set(out)];
}

/** Valor de cada palavra de número por extenso (compostos montados em `numerosPorExtenso`). */
const VALOR_EXTENSO: Record<string, number> = { cento: 100 };
for (const [n, ws] of Object.entries(EXTENSO)) for (const w of ws) VALOR_EXTENSO[w] = Number(n);
const MULTIPLICADOR: Record<string, number> = {
  mil: 1000,
  milhao: 1_000_000, milhoes: 1_000_000,
  bilhao: 1_000_000_000, bilhoes: 1_000_000_000,
};
const CONECTOR_NUMERO = new Set(["e", "virgula", "meio", "meia"]);

function ehPalavraDeNumero(norm: string): boolean {
  return norm in VALOR_EXTENSO || norm in MULTIPLICADOR || /^\d+$/.test(norm);
}

/**
 * Números compostos ditos por extenso na sequência de tokens, já na forma de
 * `numerosDaFala` (só dígitos): "dois mil e vinte e seis" → "2026", "trinta e
 * sete" → "37", "um e meio" / "um vírgula cinco" → "15" (o "1,5" do roteiro).
 * Também aceita dígito com multiplicador ("2 mil" → "2000").
 */
export function numerosPorExtenso(normTokens: string[]): string[] {
  const out = new Set<string>();
  let i = 0;
  while (i < normTokens.length) {
    if (!(normTokens[i] in VALOR_EXTENSO) && !(normTokens[i] in MULTIPLICADOR) && !/^\d+$/.test(normTokens[i])) {
      i++;
      continue;
    }
    let total = 0;
    let atual = 0;
    let decimal = "";
    let k = i;
    let ultimoFoiNumero = false;
    while (k < normTokens.length) {
      const w = normTokens[k];
      if (w in MULTIPLICADOR) {
        total += (atual || 1) * MULTIPLICADOR[w];
        atual = 0;
        ultimoFoiNumero = true;
      } else if (w in VALOR_EXTENSO || /^\d+$/.test(w)) {
        // Dois valores colados sem "e" ("vinte seis") começam outro número, exceto
        // depois de multiplicador ("dois mil vinte e seis" continua o mesmo).
        if (ultimoFoiNumero && !(normTokens[k - 1] in MULTIPLICADOR)) break;
        atual += w in VALOR_EXTENSO ? VALOR_EXTENSO[w] : Number(w);
        ultimoFoiNumero = true;
      } else if (w === "e" && ultimoFoiNumero && (normTokens[k + 1] === "meio" || normTokens[k + 1] === "meia")) {
        decimal = "5";
        k += 2;
        break;
      } else if (w === "e" && ultimoFoiNumero && k + 1 < normTokens.length && ehPalavraDeNumero(normTokens[k + 1])) {
        ultimoFoiNumero = false;
      } else if (w === "virgula" && ultimoFoiNumero && k + 1 < normTokens.length) {
        const frac = normTokens[k + 1];
        if (/^\d+$/.test(frac)) decimal = frac;
        else if (frac in VALOR_EXTENSO && VALOR_EXTENSO[frac] < 100) decimal = String(VALOR_EXTENSO[frac]);
        if (decimal) k += 2;
        break;
      } else break;
      k++;
    }
    const inteiro = total + atual;
    out.add(`${inteiro}${decimal}`);
    i = Math.max(k, i + 1);
  }
  return [...out];
}

function numeroPresente(num: string, janela: Set<string>, compostos: Set<string> = new Set()): boolean {
  if (janela.has(num) || compostos.has(num)) return true;
  const ext = EXTENSO[num];
  if (ext && ext.some((w) => janela.has(w))) return true;
  // "2000" dito "dois mil": aceitar quando aparecem "mil" e a primeira parte por extenso.
  const milhar = /^(\d+)000$/.exec(num);
  if (milhar && janela.has("mil")) {
    const cab = milhar[1];
    if (janela.has(cab) || (EXTENSO[cab] ?? []).some((w) => janela.has(w))) return true;
  }
  return false;
}

function contemFrase(normTokens: string[], frase: string): boolean {
  const alvo = toks(frase).map((t) => t.norm);
  if (alvo.length === 0) return false;
  for (let i = 0; i + alvo.length <= normTokens.length; i++) {
    if (alvo.every((a, k) => normTokens[i + k] === a)) return true;
  }
  return false;
}

interface Janela {
  inicio: number;
  fim: number; // exclusivo
  cobertura: number;
  /** Posições da transcrição que contaram para a cobertura (as que a fala reclama, #12781). */
  usados: number[];
}

/**
 * Melhor janela da transcrição para a fala, por cobertura das palavras de
 * conteúdo. Posições já reclamadas por outra fala (`ocupado`, #12781) não
 * contam: a mesma palavra dita uma vez não serve a duas falas. Entre janelas de
 * mesma cobertura, vence a de trecho mais curto depois de aparada (a mais
 * densa), para a fala reclamar as próprias palavras e não as da vizinha.
 */
function melhorJanela(fala: Tok[], trans: Tok[], ocupado?: readonly boolean[]): Janela | null {
  // Números ficam fora da cobertura: podem vir por extenso no ditado e são
  // conferidos à parte (`numerosAusentes`), que é o que decide `regravar`.
  const conteudo = fala.map((t) => t.norm).filter((w) => isConteudo(w) && !/^\d+$/.test(w));
  const alvo = conteudo.length > 0 ? conteudo : fala.map((t) => t.norm);
  if (alvo.length === 0 || trans.length === 0) return null;
  const precisa = new Map<string, number>();
  for (const w of alvo) precisa.set(w, (precisa.get(w) ?? 0) + 1);
  const livre = (k: number) => !ocupado?.[k];
  const set = new Set(fala.map((t) => t.norm));

  const largura = Math.min(trans.length, Math.max(4, Math.ceil(fala.length * 1.5)));
  let melhor: Janela | null = null;
  for (let i = 0; i + largura <= trans.length; i++) {
    const conta = new Map<string, number>();
    for (let k = i; k < i + largura; k++) {
      const w = trans[k].norm;
      if (precisa.has(w) && livre(k)) conta.set(w, (conta.get(w) ?? 0) + 1);
    }
    let achadas = 0;
    for (const [w, n] of precisa) achadas += Math.min(n, conta.get(w) ?? 0);
    const cobertura = achadas / alvo.length;
    if (melhor && cobertura < melhor.cobertura) continue;
    // Aparar as pontas da janela até a primeira/última palavra livre da fala.
    let inicio = i;
    let fim = i + largura;
    while (inicio < fim && !(set.has(trans[inicio].norm) && livre(inicio))) inicio++;
    while (fim > inicio && !(set.has(trans[fim - 1].norm) && livre(fim - 1))) fim--;
    if (melhor && cobertura === melhor.cobertura && fim - inicio >= melhor.fim - melhor.inicio) continue;
    // As posições que contaram: cada palavra da fala até o número de vezes que ela pede.
    const resta = new Map(precisa);
    const usados: number[] = [];
    for (let k = inicio; k < fim; k++) {
      const w = trans[k].norm;
      const n = resta.get(w) ?? 0;
      if (n > 0 && livre(k)) {
        usados.push(k);
        resta.set(w, n - 1);
      }
    }
    melhor = { inicio, fim, cobertura, usados };
  }
  return melhor;
}

/**
 * Atribui a cada fala a sua janela sem que duas falas reclamem as mesmas
 * palavras (#12781). Primeiro cada fala acha a melhor janela sozinha; depois,
 * da maior cobertura para a menor (empate: ordem do roteiro), cada uma refaz a
 * busca só com as posições que as anteriores não reclamaram. Assim uma fala
 * que não foi gravada, cujas palavras aparecem nas vizinhas, perde essas
 * palavras para as vizinhas e sai `faltou` em vez de `diferente-mas-cabe`.
 */
function atribuirJanelas(falas: Tok[][], trans: Tok[]): Array<Janela | null> {
  const sozinha = falas.map((ft) => melhorJanela(ft, trans));
  const ordem = falas
    .map((_, i) => i)
    .sort((a, b) => (sozinha[b]?.cobertura ?? 0) - (sozinha[a]?.cobertura ?? 0) || a - b);
  const ocupado = new Array<boolean>(trans.length).fill(false);
  const out = new Array<Janela | null>(falas.length).fill(null);
  for (const i of ordem) {
    const j = melhorJanela(falas[i], trans, ocupado);
    out[i] = j;
    // Só reclama quem casou de verdade: uma fala `faltou` não tira palavra de ninguém.
    if (j && j.cobertura >= COBERTURA_MINIMA && j.fim > j.inicio) for (const k of j.usados) ocupado[k] = true;
  }
  return out;
}

/** Número por extenso de uma palavra só vira dígito ("nove" e "9" casam); o resto fica como está. */
function canonResgate(norm: string): string {
  return norm in VALOR_EXTENSO && !STOPWORDS.has(norm) ? String(VALOR_EXTENSO[norm]) : norm;
}

/**
 * Duas palavras com o mesmo radical (#13178): iguais, ou com as primeiras 4
 * letras em comum ("falsas"/"falsos", "cansada"/"cansaço", "golpe"/"golpes"),
 * ou a curta (3 letras) como começo da longa ("pai"/"pais"). Número só casa igual.
 */
export function mesmoRadical(a: string, b: string): boolean {
  const x = canonResgate(a);
  const y = canonResgate(b);
  if (x === y) return true;
  if (/^\d+$/.test(x) || /^\d+$/.test(y)) return false;
  const menor = Math.min(x.length, y.length);
  if (menor < 3) return false;
  let p = 0;
  while (p < menor && x[p] === y[p]) p++;
  return p >= Math.min(4, menor);
}

interface Resgate {
  inicio: number;
  fim: number; // exclusivo
  cobertura: number;
  usados: number[];
  termos: string[];
}

/**
 * Segunda passada antes do `faltou` (#13178): procura a fala só nas posições
 * que nenhuma fala reclamou (`livre`), por radical e número, numa janela do
 * tamanho da fala. Na 261117 as quatro falas que saíram `faltou` (H5, H10c,
 * H13d, V2-G) estavam ditas com outras palavras, inteiras na lista de trechos
 * sem fala correspondente.
 */
function resgatarFala(fala: Tok[], trans: Tok[], livre: readonly boolean[]): Resgate | null {
  const alvo = fala.map((t) => t.norm).filter(isConteudo);
  if (alvo.length === 0) return null;
  const largura = Math.min(trans.length, Math.max(4, Math.ceil(fala.length * 1.5)));
  let melhor: Resgate | null = null;
  for (let i = 0; i < trans.length; i++) {
    if (!livre[i]) continue;
    // A janela não atravessa palavra que outra fala reclamou: o trecho fica num pedaço só, sem dono.
    let ate = i;
    while (ate < trans.length && ate < i + largura && livre[ate]) ate++;
    const usados: number[] = [];
    const termos: string[] = [];
    const tomado = new Set<number>();
    for (const w of alvo) {
      for (let k = i; k < ate; k++) {
        if (tomado.has(k) || !isConteudo(trans[k].norm) || !mesmoRadical(w, trans[k].norm)) continue;
        tomado.add(k);
        usados.push(k);
        termos.push(w);
        break;
      }
    }
    if (usados.length === 0) continue;
    const cobertura = usados.length / alvo.length;
    const inicio = Math.min(...usados);
    const fim = Math.max(...usados) + 1;
    if (melhor && (cobertura < melhor.cobertura || (cobertura === melhor.cobertura && fim - inicio >= melhor.fim - melhor.inicio))) continue;
    melhor = { inicio, fim, cobertura, usados, termos };
  }
  if (!melhor || melhor.cobertura < COBERTURA_RESGATE || melhor.usados.length < RESGATE_MIN_TERMOS) return null;
  return melhor;
}

/** Confere a transcrição ditada contra as falas do roteiro. */
export function conferirGravacao(roteiro: RoteiroFalas, transcricao: string): ResultadoConferencia {
  const trans = toks(transcricao);
  const transNorm = trans.map((t) => t.norm);
  const coberto = new Array<boolean>(trans.length).fill(false);
  const veiculos = (roteiro.veiculos ?? []).filter((v) => v.trim());
  const falaToks = roteiro.falas.map((f) => toks(f.texto));
  const janelas = atribuirJanelas(falaToks, trans);
  // #12781: veículo que o próprio roteiro cita (a empresa que também é o
  // veículo, citada de propósito) não é "citou o veículo" na fala que o traz.
  const citaNoRoteiro = (texto: string, v: string) => contemFrase(toks(texto).map((t) => t.norm), v);
  const veiculosDoRoteiro = veiculos.filter((v) => roteiro.falas.some((f) => citaNoRoteiro(f.texto, v)));
  /** Números da fala que faltam no trecho [inicio, fim) e veículos ditos nele. */
  const analisar = (texto: string, inicio: number, fim: number) => {
    const janelaNorm = transNorm.slice(inicio, fim);
    // A janela é aparada nas palavras da fala, então um número por extenso na
    // ponta ("caiu trinta e sete por cento") fica de fora: estender a leitura de
    // números pelas palavras de número/conectores vizinhas.
    let ni = inicio;
    let nf = fim;
    while (ni > 0 && (ehPalavraDeNumero(transNorm[ni - 1]) || CONECTOR_NUMERO.has(transNorm[ni - 1]))) ni--;
    while (nf < transNorm.length && (ehPalavraDeNumero(transNorm[nf]) || CONECTOR_NUMERO.has(transNorm[nf]))) nf++;
    const numerosJanela = transNorm.slice(ni, nf);
    const janelaNumSet = new Set(numerosJanela);
    const compostos = new Set(numerosPorExtenso(numerosJanela));
    return {
      numerosAusentes: numerosDaFala(texto).filter((n) => !numeroPresente(n, janelaNumSet, compostos)),
      veiculosCitados: veiculos.filter((v) => !citaNoRoteiro(texto, v) && contemFrase(janelaNorm, v)),
    };
  };

  const falas: ConferenciaFala[] = roteiro.falas.map((f, idx) => {
    const j = janelas[idx];
    const cobertura = j ? Math.round(j.cobertura * 100) / 100 : 0;
    const base = {
      id: f.id,
      videos: f.videos,
      gravarAParte: Boolean(f.gravarAParte),
      texto: f.texto,
      cobertura,
    };
    if (!j || j.cobertura < COBERTURA_MINIMA || j.fim <= j.inicio) {
      return {
        ...base,
        veredito: "faltou" as const,
        trecho: "",
        numerosAusentes: [],
        veiculosCitados: [],
        motivos: ["nenhum trecho da transcrição se parece com a fala"],
        confirmar: true,
      };
    }
    for (let k = j.inicio; k < j.fim; k++) coberto[k] = true;
    const { numerosAusentes, veiculosCitados } = analisar(f.texto, j.inicio, j.fim);
    const motivos: string[] = [];
    let veredito: VereditoFala;
    if (numerosAusentes.length > 0) motivos.push(`número do roteiro ausente no trecho: ${numerosAusentes.join(", ")}`);
    if (veiculosCitados.length > 0) motivos.push(`citou o veículo: ${veiculosCitados.join(", ")}`);
    if (motivos.length > 0) veredito = "regravar";
    else if (j.cobertura >= COBERTURA_OK) veredito = "ok";
    else {
      veredito = "diferente-mas-cabe";
      motivos.push("outras palavras: conferir se o sentido e o fato ficaram");
    }
    return {
      ...base,
      veredito,
      trecho: trans.slice(j.inicio, j.fim).map((t) => t.raw).join(" "),
      numerosAusentes,
      veiculosCitados,
      motivos,
      confirmar: veredito !== "ok",
    };
  });

  // Segunda passada antes do `faltou` (#13178): a fala reformulada pode estar
  // num trecho que nenhuma fala explicou. A de maior cobertura escolhe primeiro;
  // cada trecho resgatado deixa de estar livre para as próximas.
  const pendentes = new Set(falas.flatMap((f, i) => (f.veredito === "faltou" ? [i] : [])));
  while (pendentes.size > 0) {
    let escolhido: { i: number; r: Resgate } | null = null;
    for (const i of pendentes) {
      const r = resgatarFala(falaToks[i], trans, coberto.map((c) => !c));
      if (r && (!escolhido || r.cobertura > escolhido.r.cobertura)) escolhido = { i, r };
    }
    if (!escolhido) break;
    const { i, r } = escolhido;
    pendentes.delete(i);
    for (let k = r.inicio; k < r.fim; k++) coberto[k] = true;
    const f = roteiro.falas[i];
    const { numerosAusentes, veiculosCitados } = analisar(f.texto, r.inicio, r.fim);
    const pct = Math.round(r.cobertura * 100);
    const motivos = [
      `casou só na segunda passada, com um trecho sem fala correspondente (cobertura ${pct}% por radical e números; termos: ${[...new Set(r.termos)].join(", ")}): conferir se o sentido e o fato ficaram`,
    ];
    // Número que mudou aqui é ressalva para confirmar, não regravar automático: o
    // casamento é frouxo, e precisão sem mudança de sentido cabe (Passo 8).
    if (numerosAusentes.length > 0) motivos.push(`número do roteiro ausente no trecho: ${numerosAusentes.join(", ")} (conferir se muda o sentido)`);
    if (veiculosCitados.length > 0) motivos.push(`citou o veículo: ${veiculosCitados.join(", ")}`);
    falas[i] = {
      ...falas[i],
      veredito: veiculosCitados.length > 0 ? "regravar" : "diferente-mas-cabe",
      cobertura: Math.round(r.cobertura * 100) / 100,
      trecho: trans.slice(r.inicio, r.fim).map((t) => t.raw).join(" "),
      numerosAusentes,
      veiculosCitados,
      motivos,
      confirmar: true,
      resgatada: true,
    };
  }

  // Trechos que nenhuma fala explica.
  const trechosSemFala: string[] = [];
  let corrida: Tok[] = [];
  const fecha = () => {
    if (corrida.filter((t) => isConteudo(t.norm)).length >= TRECHO_SEM_FALA_MIN) {
      trechosSemFala.push(corrida.map((t) => t.raw).join(" "));
    }
    corrida = [];
  };
  trans.forEach((t, k) => {
    if (coberto[k]) fecha();
    else corrida.push(t);
  });
  fecha();

  // Veículo dito fora das falas casadas. O que o roteiro cita de propósito
  // (#12781) só conta se aparecer nas palavras que nenhuma fala cobre: dentro
  // da fala que o cita, é o roteiro; numa fala que não o cita, já saiu acima.
  const veiculosNasFalas = new Set(falas.flatMap((f) => f.veiculosCitados));
  const foraDasFalas = transNorm.map((w, k) => (coberto[k] ? "" : w));
  const veiculosForaDeFala = veiculos.filter((v) => {
    if (veiculosNasFalas.has(v)) return false;
    return veiculosDoRoteiro.includes(v) ? contemFrase(foraDasFalas, v) : contemFrase(transNorm, v);
  });

  const pendencias = falas.filter((f) => f.veredito === "regravar" || f.veredito === "faltou");
  const ordem: VideoRoteiro[] = ["horizontal", "vertical1", "vertical2"];
  const afetados = new Set(pendencias.flatMap((p) => p.videos));
  return {
    falas,
    trechosSemFala,
    veiculosForaDeFala,
    pendencias,
    videosAfetados: ordem.filter((v) => afetados.has(v)),
    pronto: pendencias.length === 0 && veiculosForaDeFala.length === 0,
  };
}

/** Valida o JSON de falas; devolve a lista de problemas (vazia = válido). */
export function validarRoteiroFalas(x: unknown): string[] {
  const problemas: string[] = [];
  if (!x || typeof x !== "object") return ["raiz não é objeto"];
  const r = x as Record<string, unknown>;
  if (!Array.isArray(r.falas) || r.falas.length === 0) return ["`falas` ausente ou vazio"];
  const ids = new Set<string>();
  r.falas.forEach((f, i) => {
    const o = (f ?? {}) as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id.trim()) problemas.push(`falas[${i}].id ausente`);
    else if (ids.has(o.id)) problemas.push(`falas[${i}].id repetido: ${o.id}`);
    else ids.add(o.id);
    if (typeof o.texto !== "string" || !o.texto.trim()) problemas.push(`falas[${i}].texto ausente`);
    if (
      !Array.isArray(o.videos) ||
      o.videos.length === 0 ||
      !o.videos.every((v) => v === "horizontal" || v === "vertical1" || v === "vertical2")
    ) {
      problemas.push(`falas[${i}].videos deve listar horizontal|vertical1|vertical2`);
    }
    if (o.bloco !== undefined && !(typeof o.bloco === "string" && isBlockKey(o.bloco))) {
      problemas.push(`falas[${i}].bloco deve ser um bloco da montagem (gancho, titulo, abertura, resumo, resumo_curto, comentario, cta_yt, cta_vertical, cta_ig, cta_out, fecho)`);
    }
    const rotulo = typeof o.id === "string" && o.id.trim() ? o.id : `falas[${i}]`;
    // A abertura não existe nos verticais: a fala ficaria fora da montagem, mas na página e na duração.
    if (o.bloco === "abertura" && Array.isArray(o.videos) && o.videos.some((v) => v === "vertical1" || v === "vertical2")) {
      problemas.push(`${rotulo}: bloco abertura não existe nos verticais; tire os verticais de \`videos\` ou troque o bloco`);
    }
    // #13120: texto de tela curto, sem seta (#9721).
    if (o.tela !== undefined) {
      if (typeof o.tela !== "string" || !o.tela.trim()) problemas.push(`${rotulo}.tela deve ser texto não vazio`);
      else if (SETA.test(o.tela)) problemas.push(`${rotulo}.tela usa seta (→/←), proibida no que chega ao leitor (#9721)`);
    }
    // Tópicos da fala (coluna da página): lista de textos curtos, até TOPICO_MAX_PALAVRAS palavras cada.
    if (o.topicos !== undefined) {
      if (!Array.isArray(o.topicos) || o.topicos.length === 0) problemas.push(`${rotulo}.topicos deve ser lista não vazia de textos`);
      else {
        o.topicos.forEach((t, j) => {
          const n = typeof t === "string" ? contarPalavrasTopico(t) : 0;
          if (n === 0) problemas.push(`${rotulo}.topicos[${j}] deve ser texto com pelo menos uma palavra`);
          else if (n > TOPICO_MAX_PALAVRAS) problemas.push(`${rotulo}.topicos[${j}] tem ${n} palavras ("${t}"); o máximo é ${TOPICO_MAX_PALAVRAS}`);
          else if (/[\r\n]/.test(t)) problemas.push(`${rotulo}.topicos[${j}] deve ficar em uma linha`);
          else if (SETA.test(t)) problemas.push(`${rotulo}.topicos[${j}] usa seta (→/←), proibida na página (#9721)`);
        });
      }
    }
    // Trecho de outro vídeo inserido depois da fala (react): só no horizontal.
    if (o.trechoInserido !== undefined) {
      const ti = o.trechoInserido as { origem?: unknown; texto?: unknown } | null;
      if (!ti || typeof ti !== "object" || Array.isArray(ti)) problemas.push(`${rotulo}.trechoInserido deve ser objeto com origem e texto`);
      else {
        for (const k of ["origem", "texto"] as const) {
          const val = ti[k];
          if (typeof val !== "string" || !val.trim()) problemas.push(`${rotulo}.trechoInserido.${k} deve ser texto não vazio`);
          else if (SETA.test(val)) problemas.push(`${rotulo}.trechoInserido.${k} usa seta (→/←), proibida na página (#9721)`);
        }
        if (Array.isArray(o.videos) && !o.videos.includes("horizontal")) problemas.push(`${rotulo}.trechoInserido só vale em fala do horizontal`);
      }
    }
    // #13129: corte parcial por vídeo, com o trecho exato do texto.
    if (o.cortes !== undefined) {
      if (!o.cortes || typeof o.cortes !== "object" || Array.isArray(o.cortes)) problemas.push(`${rotulo}.cortes deve ser objeto por vídeo`);
      else {
        for (const [v, c] of Object.entries(o.cortes as Record<string, unknown>)) {
          if (v === "horizontal") {
            problemas.push(`${rotulo}.cortes.horizontal: o horizontal fica com a fala inteira; corte só nos verticais (vertical1|vertical2)`);
            continue;
          }
          if (!(VIDEOS_ROTEIRO as readonly string[]).includes(v)) {
            problemas.push(`${rotulo}.cortes.${v}: vídeo desconhecido (vertical1|vertical2)`);
            continue;
          }
          if (Array.isArray(o.videos) && !o.videos.includes(v)) problemas.push(`${rotulo}.cortes.${v}: a fala não está no ${VIDEO_LABEL[v as VideoRoteiro]}`);
          const co = (typeof c === "string" ? { trecho: c } : c) as Record<string, unknown> | null;
          if (!co || typeof co !== "object" || typeof co.trecho !== "string" || !co.trecho.trim()) {
            problemas.push(`${rotulo}.cortes.${v} deve ser o trecho (texto) ou { trecho, reserva }`);
            continue;
          }
          if (co.reserva !== undefined && typeof co.reserva !== "boolean") problemas.push(`${rotulo}.cortes.${v}.reserva deve ser true/false`);
          if (typeof o.texto === "string") {
            const seg = segmentosSemTrecho(o.texto, co.trecho);
            const n = ocorrenciasDoTrecho(o.texto, co.trecho);
            if (seg === null || n === 0) problemas.push(`${rotulo}.cortes.${v}: trecho não aparece no texto da fala como palavras inteiras ("${co.trecho}")`);
            else if (n > 1) problemas.push(`${rotulo}.cortes.${v}: o trecho aparece ${n} vezes na fala; use um trecho que só apareça uma vez ("${co.trecho}")`);
            else if (seg.length === 0) problemas.push(`${rotulo}.cortes.${v}: o trecho é a fala inteira (tire a fala do vídeo em \`videos\`)`);
          }
        }
      }
    }
    // #13132: fontes do que a fala afirma.
    if (o.fontes !== undefined) {
      if (!Array.isArray(o.fontes)) problemas.push(`${rotulo}.fontes deve ser lista de { url, sustenta }`);
      else
        o.fontes.forEach((fo, k) => {
          const x = (fo ?? {}) as Record<string, unknown>;
          if (typeof x.url !== "string" || !/^https?:\/\/\S+$/.test(x.url)) problemas.push(`${rotulo}.fontes[${k}].url deve ser URL http(s)`);
          if (typeof x.sustenta !== "string" || !x.sustenta.trim()) problemas.push(`${rotulo}.fontes[${k}].sustenta deve dizer o que a fonte sustenta`);
        });
    }
  });
  if (r.veiculos !== undefined && (!Array.isArray(r.veiculos) || !r.veiculos.every((v) => typeof v === "string"))) {
    problemas.push("`veiculos` deve ser lista de strings");
  }
  for (const campo of ["gravacao", "notas"] as const) {
    if (r[campo] !== undefined && (!Array.isArray(r[campo]) || !(r[campo] as unknown[]).every((v) => typeof v === "string" && v.trim()))) {
      problemas.push(`\`${campo}\` deve ser lista de textos`);
    }
  }
  if (r.porVideo !== undefined) {
    if (!r.porVideo || typeof r.porVideo !== "object" || Array.isArray(r.porVideo)) problemas.push("`porVideo` deve ser objeto por vídeo");
    else {
      for (const [k, v] of Object.entries(r.porVideo as Record<string, unknown>)) {
        if (!(VIDEOS_ROTEIRO as readonly string[]).includes(k)) problemas.push(`porVideo.${k}: vídeo desconhecido (horizontal|vertical1|vertical2)`);
        const p = (v ?? {}) as Record<string, unknown>;
        if (!v || typeof v !== "object") problemas.push(`porVideo.${k} deve ser objeto { titulo, capa, cta, ordem }`);
        for (const campo of ["titulo", "capa", "cta"] as const) {
          if (p[campo] !== undefined && (typeof p[campo] !== "string" || !(p[campo] as string).trim())) problemas.push(`porVideo.${k}.${campo} deve ser texto não vazio`);
        }
        // #13280: a marcação de que o vertical pertence ao horizontal, só no vertical 1.
        if (p.pertenceAoHorizontal !== undefined) {
          if (k !== "vertical1") problemas.push(`porVideo.${k}.pertenceAoHorizontal: só vale no vertical 1 (o vertical 2 sai como corte avulso, sem horizontal)`);
          else if (typeof p.pertenceAoHorizontal !== "boolean") problemas.push("porVideo.vertical1.pertenceAoHorizontal deve ser true ou false");
        }
        if (p.trechoCompartilhar !== undefined) {
          const t = p.trechoCompartilhar as { inicio?: unknown; rotulo?: unknown } | null;
          if (k !== "horizontal") problemas.push(`porVideo.${k}.trechoCompartilhar: só vale no horizontal`);
          if (!t || typeof t.inicio !== "string" || !(r.falas as Array<Record<string, unknown>>).some((f) => f?.id === t.inicio && Array.isArray(f.videos) && f.videos.includes("horizontal"))) problemas.push("trechoCompartilhar.inicio deve ser id de fala do horizontal");
          if (!t || typeof t.rotulo !== "string" || !t.rotulo.trim() || /[\r\n]/.test(t.rotulo) || SETA.test(t.rotulo)) problemas.push("trechoCompartilhar.rotulo deve ser texto não vazio, em uma linha, sem seta");
        }
        // #13128: ordem própria do corte vertical = exatamente as falas daquele vídeo.
        if (p.ordem !== undefined) {
          if (k === "horizontal") problemas.push("porVideo.horizontal.ordem: a ordem do horizontal é a das falas no JSON; `ordem` só vale nos verticais");
          else if (!Array.isArray(p.ordem) || !p.ordem.every((x) => typeof x === "string")) problemas.push(`porVideo.${k}.ordem deve ser lista de ids de fala`);
          else if ((VIDEOS_ROTEIRO as readonly string[]).includes(k)) {
            const ordem = p.ordem as string[];
            const doVideo = (r.falas as Array<Record<string, unknown>>)
              .filter((f) => Array.isArray(f?.videos) && f.videos.includes(k) && typeof f.id === "string")
              .map((f) => f.id as string);
            const repetidos = [...new Set(ordem.filter((id, j) => ordem.indexOf(id) !== j))];
            const faltando = doVideo.filter((id) => !ordem.includes(id));
            const sobrando = ordem.filter((id) => !doVideo.includes(id));
            if (repetidos.length) problemas.push(`porVideo.${k}.ordem repete: ${repetidos.join(", ")}`);
            if (faltando.length) problemas.push(`porVideo.${k}.ordem não traz falas do ${VIDEO_LABEL[k as VideoRoteiro]}: ${faltando.join(", ")}`);
            if (sobrando.length) problemas.push(`porVideo.${k}.ordem traz falas que não estão no ${VIDEO_LABEL[k as VideoRoteiro]}: ${sobrando.join(", ")}`);
          }
        }
      }
    }
  }
  // #9721: nenhuma seta no que chega ao leitor (fala, tela, título, capa, card, página).
  const comSeta: string[] = [];
  const confere = (rotulo: string, s: unknown) => {
    if (typeof s === "string" && SETA.test(s)) comSeta.push(rotulo);
  };
  (r.falas as Array<Record<string, unknown>>).forEach((f, i) => {
    const rotulo = typeof f?.id === "string" && f.id.trim() ? f.id : `falas[${i}]`;
    confere(`${rotulo}.texto`, f?.texto);
    if (Array.isArray(f?.fontes)) f.fontes.forEach((fo, k) => confere(`${rotulo}.fontes[${k}].sustenta`, (fo as Record<string, unknown> | null)?.sustenta));
  });
  if (r.porVideo && typeof r.porVideo === "object") {
    for (const [k, v] of Object.entries(r.porVideo as Record<string, unknown>)) {
      for (const campo of ["titulo", "capa", "cta"]) confere(`porVideo.${k}.${campo}`, (v as Record<string, unknown> | null)?.[campo]);
    }
  }
  for (const campo of ["gravacao", "notas"] as const) if (Array.isArray(r[campo])) (r[campo] as unknown[]).forEach((s, j) => confere(`${campo}[${j}]`, s));
  if (comSeta.length) problemas.push(`seta (→/←) proibida no que chega ao leitor (#9721): ${comSeta.join(", ")}`);
  return problemas;
}

/** Relatório em texto para o modelo partir dele (não é a resposta final ao editor). */
export function renderConferencia(r: ResultadoConferencia): string {
  const linhas: string[] = ["Conferência determinística (sugestão; vereditos != ok pedem confirmação):", ""];
  for (const f of r.falas) {
    const tag = f.gravarAParte ? " (gravar à parte)" : "";
    const vids = f.videos.map((v) => VIDEO_LABEL[v]).join(", ");
    linhas.push(`${f.id}${tag} [${vids}]: ${f.veredito} (cobertura ${Math.round(f.cobertura * 100)}%)`);
    for (const m of f.motivos) linhas.push(`  motivo: ${m}`);
    if (f.trecho && f.veredito !== "ok") linhas.push(`  trecho: "${f.trecho}"`);
  }
  if (r.trechosSemFala.length > 0) {
    linhas.push("", "Trechos sem fala correspondente (improviso, fala nova ou tomada repetida):");
    for (const t of r.trechosSemFala) linhas.push(`  "${t}"`);
  }
  if (r.veiculosForaDeFala.length > 0) {
    linhas.push("", `Veículo citado fora das falas: ${r.veiculosForaDeFala.join(", ")}`);
  }
  linhas.push("");
  if (r.pronto) linhas.push("Sem pendência no passo determinístico.");
  else {
    linhas.push("Pendências:");
    for (const p of r.pendencias) {
      linhas.push(`  ${p.id} (${p.veredito}, ${p.videos.map((v) => VIDEO_LABEL[v]).join(", ")}): "${p.texto}"`);
    }
    linhas.push(`Vídeos afetados: ${r.videosAfetados.map((v) => VIDEO_LABEL[v]).join(", ") || "nenhum"}`);
  }
  return linhas.join("\n");
}
