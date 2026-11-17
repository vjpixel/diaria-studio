/**
 * scripts/lib/diaria/youtube-capa-benchmark.ts (#13217)
 *
 * Miolo puro do benchmark visual de capas em canais de IA. A CLI
 * (`scripts/youtube-capa-benchmark.ts`) busca os dados na YouTube Data API;
 * aqui fica só o que é decidível sem rede: lista de canais, duração ISO 8601,
 * filtro de vídeo longo e a separação "acima da média do próprio canal".
 *
 * Por que views ÷ mediana do canal: a taxa de cliques de outro canal não é
 * pública. O único sinal comparável é o vídeo que rendeu muito acima do normal
 * do próprio canal, o que neutraliza o tamanho do canal (um vídeo de 50 mil
 * views é fracasso num canal de 2 milhões de inscritos e sucesso num de 20
 * mil). O sinal mistura pauta, título e capa (#13195): serve para apontar
 * padrões a testar, não para provar que a capa causou o resultado.
 */

export interface BenchmarkChannel {
  /** Handle do YouTube, com @. */
  readonly handle: `@${string}`;
  readonly lang: "pt" | "en";
  /** Por que o canal entrou (registrado no doc). */
  readonly why: string;
}

/**
 * Canais do benchmark: PT-BR e inglês, portes diferentes, com prioridade para
 * notícia e análise de IA (o formato da diar.ia.br: notícias de IA) sobre tutorial
 * puro. Fora da 1ª rodada (16/11/2026): @TecMundo (os vídeos acima da média
 * são resumões de games/hardware, não IA) e @AsimovAcademy (só 7 vídeos longos).
 */
export const BENCHMARK_CHANNELS: readonly BenchmarkChannel[] = [
  { handle: "@aiexplained-official", lang: "en", why: "análise de notícia de IA, canal médio-grande" },
  { handle: "@mreflow", lang: "en", why: "notícias da semana em IA, rosto na capa" },
  { handle: "@WesRoth", lang: "en", why: "notícia diária de IA, ritmo parecido com o nosso" },
  { handle: "@TheAiGrid", lang: "en", why: "notícia de IA com tom de alerta" },
  { handle: "@matthew_berman", lang: "en", why: "notícia e teste de modelos" },
  { handle: "@TwoMinutePapers", lang: "en", why: "pesquisa de IA explicada, capa sem rosto" },
  { handle: "@Fireship", lang: "en", why: "tecnologia/IA com humor, referência de capa ilustrada" },
  { handle: "@FilipeDeschamps", lang: "pt", why: "notícia de tecnologia em PT-BR, rosto na capa" },
  { handle: "@codigofontetv", lang: "pt", why: "tecnologia e IA em PT-BR, canal grande" },
  { handle: "@LucasMontano", lang: "pt", why: "tecnologia e carreira, opinião sobre IA" },
  { handle: "@canalsandeco", lang: "pt", why: "IA em PT-BR, canal médio" },
  { handle: "@olhardigital", lang: "pt", why: "veículo de notícia de tecnologia em PT-BR" },
];

/** Vídeo com até isso (inclusive) conta como Short (o limite do YouTube é 3 min). */
export const SHORT_MAX_SECONDS = 180;
/** Vídeo mais novo que isso ainda está acumulando views; fica fora da conta. */
export const MIN_AGE_DAYS = 7;
/** Teto de vídeos longos por canal na amostra da mediana (o piso é `MIN_SAMPLE`). */
export const VIDEOS_PER_CHANNEL = 30;
/**
 * A partir de quantas vezes a MEDIANA do canal o vídeo conta como "acima da
 * média" (o nome no doc é coloquial; a referência é a mediana, que um único
 * viral não distorce).
 */
export const OUTLIER_RATIO = 2;
/** Canal com menos vídeos longos elegíveis que isso fica fora (mediana instável). */
export const MIN_SAMPLE = 10;

/** `PT1H2M3S` → 3723. Formato desconhecido → null. */
export function parseIsoDuration(iso: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso.trim());
  if (!m || iso.trim() === "P" || iso.trim().endsWith("T")) return null;
  const [, d, h, min, s] = m;
  return (Number(d ?? 0) * 86400) + (Number(h ?? 0) * 3600) + (Number(min ?? 0) * 60) + Math.round(Number(s ?? 0));
}

export interface BenchmarkVideo {
  readonly id: string;
  readonly title: string;
  /** ISO 8601, como a API devolve. Data impossível de ler deixa o vídeo de fora. */
  readonly publishedAt: string;
  readonly durationSeconds: number;
  readonly views: number;
  /** `null` = a API não trouxe miniatura. */
  readonly thumbnailUrl: string | null;
}

/** Só `rankChannel` constrói: o ratio é relativo à mediana do canal ranqueado. */
export interface RankedVideo extends BenchmarkVideo {
  /** views ÷ mediana do canal. */
  readonly ratio: number;
}

export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Vídeos que entram na conta: longos (acima do limite de Short), com pelo
 * menos `MIN_AGE_DAYS` de publicados, os `VIDEOS_PER_CHANNEL` mais recentes.
 */
export function eligibleVideos(videos: readonly BenchmarkVideo[], now: Date): BenchmarkVideo[] {
  const cutoff = now.getTime() - MIN_AGE_DAYS * 86400_000;
  return videos
    .map((v) => ({ v, t: Date.parse(v.publishedAt) }))
    .filter(({ v, t }) => Number.isFinite(t) && v.durationSeconds > SHORT_MAX_SECONDS && t <= cutoff)
    .sort((a, b) => b.t - a.t)
    .slice(0, VIDEOS_PER_CHANNEL)
    .map(({ v }) => v);
}

export interface ChannelRanking {
  readonly medianViews: number;
  readonly sample: number;
  /** ratio ≥ OUTLIER_RATIO, maior primeiro. */
  readonly outliers: readonly RankedVideo[];
  /**
   * Os vídeos mais perto da mediana (grupo de controle visual). "Perto" é em
   * escala log: 0,5x e 2x estão à mesma distância de 1x.
   */
  readonly typical: readonly RankedVideo[];
}

/**
 * Separa os acima da média e os típicos de um canal: `typicalCount` típicos,
 * os mais perto de ratio 1. Mediana 0 não tem ratio definido: devolve os dois
 * grupos vazios (a CLI trata como erro do canal).
 */
export function rankChannel(videos: readonly BenchmarkVideo[], typicalCount = 3): ChannelRanking {
  const med = median(videos.map((v) => v.views));
  if (med <= 0) return { medianViews: med, sample: videos.length, outliers: [], typical: [] };
  const ranked: RankedVideo[] = videos.map((v) => ({ ...v, ratio: v.views / med }));
  const outliers = ranked.filter((v) => v.ratio >= OUTLIER_RATIO).sort((a, b) => b.ratio - a.ratio);
  // ratio 0 (vídeo sem views) fica no fim dos típicos.
  const dist = (r: number) => (r > 0 ? Math.abs(Math.log(r)) : Number.POSITIVE_INFINITY);
  const typical = ranked
    .filter((v) => v.ratio < OUTLIER_RATIO)
    .sort((a, b) => dist(a.ratio) - dist(b.ratio))
    .slice(0, Math.max(0, typicalCount));
  return { medianViews: med, sample: videos.length, outliers, typical };
}

/** Melhor miniatura disponível do `snippet.thumbnails`; `null` se nenhuma. */
export function bestThumbnail(thumbs: Record<string, { url?: string } | undefined> | undefined): string | null {
  for (const k of ["maxres", "standard", "high", "medium", "default"]) {
    const u = thumbs?.[k]?.url;
    if (u) return u;
  }
  return null;
}
