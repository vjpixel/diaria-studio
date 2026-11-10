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

import { normalizeToken } from "./video-montage.ts";

export type VideoRoteiro = "horizontal" | "vertical1" | "vertical2";

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
}

export interface RoteiroFalas {
  edicao?: string;
  /** Nomes de veículo que não podem ser ditos (regra "nunca citar o veículo"). */
  veiculos?: string[];
  falas: FalaRoteiro[];
}

/**
 * - `ok`: dita como no roteiro.
 * - `diferente-mas-cabe`: outras palavras; o modelo confirma que o sentido e o fato ficaram.
 * - `regravar`: número do roteiro ausente ou veículo citado no trecho.
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

function numeroPresente(num: string, janela: Set<string>): boolean {
  if (janela.has(num)) return true;
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
}

/** Melhor janela da transcrição para a fala, por cobertura das palavras de conteúdo. */
function melhorJanela(fala: Tok[], trans: Tok[]): Janela | null {
  // Números ficam fora da cobertura: podem vir por extenso no ditado e são
  // conferidos à parte (`numerosAusentes`), que é o que decide `regravar`.
  const conteudo = fala.map((t) => t.norm).filter((w) => isConteudo(w) && !/^\d+$/.test(w));
  const alvo = conteudo.length > 0 ? conteudo : fala.map((t) => t.norm);
  if (alvo.length === 0 || trans.length === 0) return null;
  const precisa = new Map<string, number>();
  for (const w of alvo) precisa.set(w, (precisa.get(w) ?? 0) + 1);

  const largura = Math.min(trans.length, Math.max(4, Math.ceil(fala.length * 1.5)));
  let melhor: Janela | null = null;
  for (let i = 0; i + largura <= trans.length; i++) {
    const conta = new Map<string, number>();
    for (let k = i; k < i + largura; k++) {
      const w = trans[k].norm;
      if (precisa.has(w)) conta.set(w, (conta.get(w) ?? 0) + 1);
    }
    let achadas = 0;
    for (const [w, n] of precisa) achadas += Math.min(n, conta.get(w) ?? 0);
    const cobertura = achadas / alvo.length;
    if (!melhor || cobertura > melhor.cobertura) melhor = { inicio: i, fim: i + largura, cobertura };
  }
  if (!melhor) return null;
  // Aparar as pontas da janela até a primeira/última palavra da fala.
  const set = new Set(fala.map((t) => t.norm));
  let { inicio, fim } = melhor;
  while (inicio < fim && !set.has(trans[inicio].norm)) inicio++;
  while (fim > inicio && !set.has(trans[fim - 1].norm)) fim--;
  return { inicio, fim, cobertura: melhor.cobertura };
}

/** Confere a transcrição ditada contra as falas do roteiro. */
export function conferirGravacao(roteiro: RoteiroFalas, transcricao: string): ResultadoConferencia {
  const trans = toks(transcricao);
  const transNorm = trans.map((t) => t.norm);
  const coberto = new Array<boolean>(trans.length).fill(false);
  const veiculos = (roteiro.veiculos ?? []).filter((v) => v.trim());

  const falas: ConferenciaFala[] = roteiro.falas.map((f) => {
    const ft = toks(f.texto);
    const j = melhorJanela(ft, trans);
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
    const janelaNorm = transNorm.slice(j.inicio, j.fim);
    const janelaSet = new Set(janelaNorm);
    const numerosAusentes = numerosDaFala(f.texto).filter((n) => !numeroPresente(n, janelaSet));
    const veiculosCitados = veiculos.filter((v) => contemFrase(janelaNorm, v));
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

  const veiculosNasFalas = new Set(falas.flatMap((f) => f.veiculosCitados));
  const veiculosForaDeFala = veiculos.filter((v) => !veiculosNasFalas.has(v) && contemFrase(transNorm, v));

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
  });
  if (r.veiculos !== undefined && (!Array.isArray(r.veiculos) || !r.veiculos.every((v) => typeof v === "string"))) {
    problemas.push("`veiculos` deve ser lista de strings");
  }
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
