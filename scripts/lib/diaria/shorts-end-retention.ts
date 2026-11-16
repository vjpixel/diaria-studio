/**
 * shorts-end-retention.ts — medição da queda de retenção nos últimos segundos
 * dos Shorts, separada pelo jeito como o vertical termina (#13190).
 *
 * Miolo puro, sem I/O: a CLI `scripts/shorts-end-retention.ts` lê o snapshot
 * do YouTube Analytics (`data/youtube-analytics/{videos,retention}.jsonl`,
 * #12075), os registros de publicação (`06-shorts-published.json` da edição e
 * dos cortes) e a transcrição da sequência montada
 * (`_internal/video-montagem/seq-*.transcript.json`), e passa tudo para cá.
 *
 * O fim de cada vertical sai da transcrição, não do `roteiro-falas.json`: o
 * roteiro só existe a partir de 261116, e a transcrição da montagem existe
 * para todo vertical montado pelo `/diaria-video-montagem` desde 261028.
 *
 * Só mede. Nenhuma regra de roteiro muda a partir daqui sem decisão do editor
 * (#13190, briefing 261116b).
 */

/** Como o vertical termina, lido da fala dos últimos segundos. */
export type FimVertical =
  /** Chamada falada para o vídeo completo no YouTube (#12735). */
  | "video-completo"
  /** Encerramento convencional: "gostou? dá um like, segue a diar.ia.br". */
  | "like-segue"
  /** Termina numa pergunta ao público, sem chamada. */
  | "pergunta"
  /** Termina no conteúdo, sem chamada nem pergunta. */
  | "sem-chamada"
  /** Sem transcrição da montagem para esse vídeo. */
  | "desconhecido";

export const FIM_LABEL: Record<FimVertical, string> = {
  "video-completo": "chamada para o vídeo completo",
  "like-segue": "chamada like/segue",
  pergunta: "pergunta ao público",
  "sem-chamada": "sem chamada",
  desconhecido: "sem transcrição",
};

/** Os fins que contam como "com chamada final" na comparação binária. */
export const FINS_COM_CHAMADA: readonly FimVertical[] = ["video-completo", "like-segue"];

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface SequenceTranscript {
  /** Duração da sequência montada, em segundos. */
  duration: number;
  segments: TranscriptSegment[];
}

export interface FimClassificado {
  fim: FimVertical;
  /** Início (s) do trecho final que é chamada ou pergunta; `null` sem chamada. */
  inicioChamadaS: number | null;
  /** Texto do trecho final classificado (para conferência à mão). */
  texto: string;
}

/** Janela (s) do fim em que a chamada é procurada. */
export const JANELA_FIM_S = 12;
/**
 * Segmento final mais curto que isto é sobra da montagem ("E aí", "Música",
 * a repetição truncada de uma frase), não fala que vai ao ar.
 */
const SEGMENTO_SOBRA_S = 0.6;

const RE_VIDEO_COMPLETO = /video completo|no youtube|link na bio|canal da diaria/;
const RE_LIKE_SEGUE = /\bum like\b|\bsegu[ei] a diaria\b|\bsiga a diaria\b|\bgostou desse\b|\binscrev/;

export function normalizarFala(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tipoChamada(texto: string): "video-completo" | "like-segue" | null {
  const t = normalizarFala(texto);
  if (RE_VIDEO_COMPLETO.test(t)) return "video-completo";
  if (RE_LIKE_SEGUE.test(t)) return "like-segue";
  return null;
}

/**
 * Classifica o fim do vertical pela transcrição da sequência montada.
 *
 * Descarta as sobras curtas do fim da montagem, depois anda para trás pelos
 * segmentos da janela final: o bloco contíguo que é chamada (vídeo completo
 * vence like/segue quando os dois aparecem) define o tipo e o início da
 * chamada. Sem chamada, um último segmento terminado em "?" vira `pergunta`,
 * com o bloco de perguntas finais como trecho.
 */
export function classificarFim(t: SequenceTranscript | null, janelaS = JANELA_FIM_S): FimClassificado {
  if (!t || !Array.isArray(t.segments) || !t.segments.length) return { fim: "desconhecido", inicioChamadaS: null, texto: "" };
  const segs = [...t.segments].sort((a, b) => a.start - b.start);
  while (segs.length > 1 && segs[segs.length - 1].end - segs[segs.length - 1].start < SEGMENTO_SOBRA_S) segs.pop();
  const fimFala = segs[segs.length - 1].end;
  const janela = segs.filter((s) => s.end > fimFala - janelaS);

  const chamada: TranscriptSegment[] = [];
  let tipo: "video-completo" | "like-segue" | null = null;
  for (let i = janela.length - 1; i >= 0; i--) {
    const tp = tipoChamada(janela[i].text);
    // "Gostou desse vídeo?" sozinho já abre o bloco; um segmento sem marca
    // depois de um bloco iniciado encerra a busca.
    if (!tp) break;
    chamada.unshift(janela[i]);
    if (tp === "video-completo" || !tipo) tipo = tp;
  }
  if (tipo) {
    return { fim: tipo, inicioChamadaS: chamada[0].start, texto: chamada.map((s) => s.text.trim()).join(" ") };
  }

  const pergunta: TranscriptSegment[] = [];
  for (let i = janela.length - 1; i >= 0; i--) {
    if (!janela[i].text.trim().endsWith("?")) break;
    pergunta.unshift(janela[i]);
  }
  if (pergunta.length) {
    return { fim: "pergunta", inicioChamadaS: pergunta[0].start, texto: pergunta.map((s) => s.text.trim()).join(" ") };
  }
  return { fim: "sem-chamada", inicioChamadaS: null, texto: janela[janela.length - 1].text.trim() };
}

/**
 * Retenção relativa (`audienceWatchRatio`) num ponto da duração, por
 * interpolação linear entre os pontos da curva (passo de 0,01). Antes do
 * primeiro ponto vale o primeiro; depois do último, o último.
 */
export function retencaoEm(points: ReadonlyArray<readonly [number, number]>, ratio: number): number | null {
  if (!points.length) return null;
  const p = [...points].sort((a, b) => a[0] - b[0]);
  if (ratio <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++) {
    const [x1, y1] = p[i];
    if (ratio <= x1) {
      const [x0, y0] = p[i - 1];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (ratio - x0)) / (x1 - x0);
    }
  }
  return p[p.length - 1][1];
}

export interface ShortInput {
  videoId: string;
  title: string | null;
  /** Edição de origem (AAMMDD), quando conhecida. */
  edition: string | null;
  /** `vertical1` = o vertical da edição; `corte` = vertical 2/extra ou corte avulso. */
  peca: "vertical1" | "corte" | "desconhecida";
  views: number;
  averageViewPercentage: number;
  averageViewDuration: number;
  points: ReadonlyArray<readonly [number, number]>;
  /** Transcrição da sequência montada, ou `null`. */
  transcript: SequenceTranscript | null;
}

export type FonteDuracao = "api" | "montagem";

/**
 * Divergência máxima entre a duração da montagem e a da API para a fala do fim
 * da montagem valer como o fim do vídeo publicado. Acima disso o editor
 * reexportou outro corte (261028: sequência de 211 s, Short de 75 s).
 */
export const DIVERGENCIA_MONTAGEM_MAX = 0.15;

export interface ShortMedido {
  videoId: string;
  title: string | null;
  edition: string | null;
  peca: ShortInput["peca"];
  views: number;
  averageViewPercentage: number;
  fim: FimVertical;
  textoFim: string;
  duracaoS: number | null;
  fonteDuracao: FonteDuracao | null;
  /** Duração da sequência montada (s), quando há transcrição. */
  duracaoMontagemS: number | null;
  /**
   * A montagem bate com o vídeo publicado (divergência de duração até
   * `DIVERGENCIA_MONTAGEM_MAX`)? `null` sem uma das duas. `false` tira o Short
   * dos grupos: o fim lido da montagem pode não ser o que foi ao ar.
   */
  montagemConfere: boolean | null;
  /** Ritmo da fala na montagem (palavras por minuto de fala), quando há transcrição. */
  palavrasPorMin: number | null;
  r50: number | null;
  r90: number | null;
  r100: number | null;
  /** Retenção no início da cauda (`1 - caudaS/duração`). */
  rInicioCauda: number | null;
  /** Queda absoluta na cauda: `rInicioCauda - r100`. */
  quedaCauda: number | null;
  /** Queda relativa na cauda: `quedaCauda / rInicioCauda` (fração de quem chegou à cauda e saiu). */
  quedaCaudaRel: number | null;
  /** Queda por segundo na cauda dividida pela queda por segundo no corpo (50%→90%). */
  razaoCaudaCorpo: number | null;
  /** Duração (s) da chamada/pergunta final, quando há. */
  chamadaS: number | null;
  /** Queda relativa do início da chamada ao fim. */
  quedaChamadaRel: number | null;
}

const arred = (v: number | null, casas = 3): number | null => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** casas) / 10 ** casas);

/**
 * Duração do vertical publicado: `averageViewDuration / (averageViewPercentage/100)`
 * da própria API. As duas métricas são médias sobre as mesmas views, então a
 * razão devolve a duração do vídeo, com erro de ~1 s pelo arredondamento de
 * `averageViewDuration` (conferido contra a duração real de 5 Shorts lida no
 * YouTube Studio em 16/11/2026, inclusive o Nubank, com replay). Sem as
 * métricas, cai na duração da sequência montada, que difere da exportada.
 */
export function duracaoDoShort(s: Pick<ShortInput, "transcript" | "averageViewDuration" | "averageViewPercentage">): { duracaoS: number | null; fonte: FonteDuracao | null } {
  if (s.averageViewPercentage > 0 && s.averageViewDuration > 0) return { duracaoS: s.averageViewDuration / (s.averageViewPercentage / 100), fonte: "api" };
  if (s.transcript && s.transcript.duration > 0) return { duracaoS: s.transcript.duration, fonte: "montagem" };
  return { duracaoS: null, fonte: null };
}

/** Palavras por minuto entre o início da 1ª fala e o fim da última. */
export function palavrasPorMinuto(t: SequenceTranscript | null): number | null {
  if (!t?.segments?.length) return null;
  const palavras = t.segments.reduce((n, s) => n + s.text.trim().split(/\s+/).filter(Boolean).length, 0);
  const inicio = Math.min(...t.segments.map((s) => s.start));
  const fim = Math.max(...t.segments.map((s) => s.end));
  return fim > inicio ? (palavras / (fim - inicio)) * 60 : null;
}

export function medirShort(s: ShortInput, caudaS = 3): ShortMedido {
  const fim = classificarFim(s.transcript);
  const { duracaoS, fonte } = duracaoDoShort(s);
  const r = (x: number) => retencaoEm(s.points, x);
  const r50 = r(0.5);
  const r90 = r(0.9);
  const r100 = r(1);
  let rInicioCauda: number | null = null;
  let quedaCauda: number | null = null;
  let quedaCaudaRel: number | null = null;
  let razaoCaudaCorpo: number | null = null;
  let chamadaS: number | null = null;
  let quedaChamadaRel: number | null = null;
  const duracaoMontagemS = s.transcript && s.transcript.duration > 0 ? s.transcript.duration : null;
  const montagemConfere = duracaoMontagemS !== null && fonte === "api" && duracaoS ? Math.abs(duracaoMontagemS - duracaoS) / duracaoS <= DIVERGENCIA_MONTAGEM_MAX : null;
  if (duracaoS && r100 !== null) {
    rInicioCauda = r(Math.max(0, 1 - caudaS / duracaoS));
    if (rInicioCauda !== null) {
      quedaCauda = rInicioCauda - r100;
      quedaCaudaRel = rInicioCauda > 0 ? quedaCauda / rInicioCauda : null;
      if (r50 !== null && r90 !== null) {
        const corpoPorS = (r50 - r90) / (0.4 * duracaoS);
        razaoCaudaCorpo = corpoPorS > 0 ? quedaCauda / caudaS / corpoPorS : null;
      }
    }
    if (fim.inicioChamadaS !== null && s.transcript && montagemConfere !== false) {
      // A chamada é o fim do vídeo: conta-se a duração dela para trás a partir
      // do fim do vídeo publicado, que resiste a cortes do editor no meio.
      // Montagem que não confere com o publicado não posiciona chamada nenhuma.
      chamadaS = Math.max(0, s.transcript.duration - fim.inicioChamadaS);
      const rc = r(Math.max(0, 1 - chamadaS / duracaoS));
      quedaChamadaRel = rc !== null && rc > 0 ? (rc - r100) / rc : null;
    }
  }
  return {
    videoId: s.videoId,
    title: s.title,
    edition: s.edition,
    peca: s.peca,
    views: s.views,
    averageViewPercentage: s.averageViewPercentage,
    fim: fim.fim,
    textoFim: fim.texto,
    duracaoS: arred(duracaoS, 1),
    fonteDuracao: fonte,
    duracaoMontagemS: arred(duracaoMontagemS, 1),
    montagemConfere,
    palavrasPorMin: montagemConfere === false ? null : arred(palavrasPorMinuto(s.transcript), 0),
    r50: arred(r50),
    r90: arred(r90),
    r100: arred(r100),
    rInicioCauda: arred(rInicioCauda),
    quedaCauda: arred(quedaCauda),
    quedaCaudaRel: arred(quedaCaudaRel),
    razaoCaudaCorpo: arred(razaoCaudaCorpo, 2),
    chamadaS: arred(chamadaS, 1),
    quedaChamadaRel: arred(quedaChamadaRel),
  };
}

// ─── Estatística ─────────────────────────────────────────────────────────────

export function mediana(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

function postos(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const posto = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = posto;
    i = j + 1;
  }
  return out;
}

export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  return pearson(postos(xs.slice(0, n)), postos(ys.slice(0, n)));
}

export interface ResumoGrupo {
  grupo: string;
  n: number;
  views: number;
  medianaPctVisualizada: number | null;
  medianaDuracaoS: number | null;
  medianaQuedaCaudaRel: number | null;
  medianaRazaoCaudaCorpo: number | null;
}

function resumir(grupo: string, rows: readonly ShortMedido[]): ResumoGrupo {
  const nums = (f: (r: ShortMedido) => number | null) => rows.map(f).filter((v): v is number => v !== null);
  return {
    grupo,
    n: rows.length,
    views: rows.reduce((a, r) => a + r.views, 0),
    medianaPctVisualizada: arred(mediana(nums((r) => r.averageViewPercentage)), 1),
    medianaDuracaoS: arred(mediana(nums((r) => r.duracaoS)), 1),
    medianaQuedaCaudaRel: arred(mediana(nums((r) => r.quedaCaudaRel))),
    medianaRazaoCaudaCorpo: arred(mediana(nums((r) => r.razaoCaudaCorpo)), 2),
  };
}

export interface AnaliseFim {
  caudaS: number;
  minViews: number;
  shorts: ShortMedido[];
  /**
   * Grupos por tipo de fim, só com Shorts de `views >= minViews`, fim conhecido
   * e montagem que confere com o vídeo publicado.
   */
  porFim: ResumoGrupo[];
  /** Comparação binária: com chamada final (vídeo completo + like/segue) x sem. */
  binario: ResumoGrupo[];
  /** Duração x % visualizada média, Shorts com duração conhecida e `views >= minViews`. */
  duracaoXPct: { n: number; pearson: number | null; spearman: number | null };
}

/** Entra nos grupos por fim? */
export function elegivelParaGrupo(s: ShortMedido, minViews: number): boolean {
  return s.views >= minViews && s.fim !== "desconhecido" && s.montagemConfere !== false;
}

export function analisarFins(inputs: readonly ShortInput[], opts: { caudaS?: number; minViews?: number } = {}): AnaliseFim {
  const caudaS = opts.caudaS ?? 3;
  const minViews = opts.minViews ?? 100;
  const shorts = inputs.map((s) => medirShort(s, caudaS)).sort((a, b) => b.views - a.views);
  const elegiveis = shorts.filter((s) => elegivelParaGrupo(s, minViews));
  const ordem: FimVertical[] = ["video-completo", "like-segue", "pergunta", "sem-chamada"];
  const porFim = ordem.map((f) => resumir(FIM_LABEL[f], elegiveis.filter((s) => s.fim === f))).filter((g) => g.n > 0);
  const com = elegiveis.filter((s) => FINS_COM_CHAMADA.includes(s.fim));
  const sem = elegiveis.filter((s) => !FINS_COM_CHAMADA.includes(s.fim));
  const binario = [resumir("com chamada final", com), resumir("sem chamada final", sem)];
  const comDuracao = shorts.filter((s) => s.views >= minViews && s.duracaoS !== null);
  const xs = comDuracao.map((s) => s.duracaoS as number);
  const ys = comDuracao.map((s) => s.averageViewPercentage);
  return {
    caudaS,
    minViews,
    shorts,
    porFim,
    binario,
    duracaoXPct: { n: comDuracao.length, pearson: arred(pearson(xs, ys), 2), spearman: arred(spearman(xs, ys), 2) },
  };
}

// ─── Relatório ───────────────────────────────────────────────────────────────

const fmt = (v: number | null, casas = 2): string => (v === null ? "—" : v.toFixed(casas).replace(".", ","));
const pct = (v: number | null): string => (v === null ? "—" : `${(v * 100).toFixed(0)}%`);
const cel = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export function renderRelatorio(a: AnaliseFim, meta: { snapshotDate: string; janela: string }): string {
  const l: string[] = [];
  l.push(`# Queda de retenção no fim dos Shorts (#13190)`, "");
  l.push(
    `Snapshot ${meta.snapshotDate} (janela ${meta.janela}). Cauda = últimos ${a.caudaS} s. Grupos só com Shorts de ${a.minViews}+ views, fim conhecido e montagem que confere com o publicado (duração até ${Math.round(DIVERGENCIA_MONTAGEM_MAX * 100)}% de diferença).`,
    "",
  );
  l.push(`## Por Short`, "");
  l.push(`| Short | Edição | Peça | Views | % vis. | Duração (montagem) | Palavras/min | Fim | 90% | início cauda | 100% | Queda cauda | Cauda/corpo | Queda na chamada |`);
  l.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const s of a.shorts) {
    const dur = s.duracaoS === null ? "—" : `${Math.round(s.duracaoS)} s${s.fonteDuracao === "montagem" ? " (só montagem)" : ""}`;
    const mont = s.duracaoMontagemS === null || s.fonteDuracao === "montagem" ? "" : ` (${Math.round(s.duracaoMontagemS)} s${s.montagemConfere === false ? ", não confere" : ""})`;
    const chamada = s.quedaChamadaRel === null ? "—" : `${pct(s.quedaChamadaRel)} em ${fmt(s.chamadaS, 1)} s`;
    l.push(
      `| ${cel(s.title ?? s.videoId)} | ${s.edition ?? "—"} | ${s.peca} | ${s.views} | ${fmt(s.averageViewPercentage, 1)} | ${dur}${mont} | ${s.palavrasPorMin ?? "—"} | ${FIM_LABEL[s.fim]} | ${fmt(s.r90)} | ${fmt(s.rInicioCauda)} | ${fmt(s.r100)} | ${pct(s.quedaCaudaRel)} | ${fmt(s.razaoCaudaCorpo)} | ${chamada} |`,
    );
  }
  l.push("", `## Por tipo de fim (medianas)`, "");
  const tabelaGrupos = (gs: readonly ResumoGrupo[]) => {
    l.push(`| Grupo | n | Views | % vis. | Duração | Queda cauda | Cauda/corpo |`, `|---|---|---|---|---|---|---|`);
    for (const g of gs) l.push(`| ${g.grupo} | ${g.n} | ${g.views} | ${fmt(g.medianaPctVisualizada, 1)} | ${fmt(g.medianaDuracaoS, 0)} s | ${pct(g.medianaQuedaCaudaRel)} | ${fmt(g.medianaRazaoCaudaCorpo)} |`);
  };
  tabelaGrupos(a.porFim);
  l.push("", `## Com x sem chamada final (medianas)`, "");
  tabelaGrupos(a.binario);
  l.push("", `## Duração x % visualizada`, "");
  l.push(`n = ${a.duracaoXPct.n} (Shorts de ${a.minViews}+ views, duração do vídeo publicado). Pearson ${fmt(a.duracaoXPct.pearson)}, Spearman ${fmt(a.duracaoXPct.spearman)}.`, "");
  l.push(`## Fim de cada vertical (texto da montagem)`, "");
  for (const s of a.shorts.filter((x) => x.fim !== "desconhecido")) {
    const aviso = s.montagemConfere === false ? " (montagem não confere com o publicado: fora dos grupos)" : "";
    l.push(`- ${cel(s.title ?? s.videoId)}: ${FIM_LABEL[s.fim]}${aviso}. "${cel(s.textoFim)}"`);
  }
  l.push("");
  return l.join("\n");
}
