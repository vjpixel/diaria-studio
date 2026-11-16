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
  handle: string;
  lang: "pt" | "en";
  /** Por que o canal entrou (registrado no doc). */
  why: string;
}

/**
 * Canais do benchmark: PT-BR e inglês, portes diferentes, com prioridade para
 * notícia e análise de IA (o formato da diar.ia.br comentada) sobre tutorial
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

/** Vídeo com menos que isso é Short (o limite do YouTube é 3 min). */
export const SHORT_MAX_SECONDS = 180;
/** Vídeo mais novo que isso ainda está acumulando views; fica fora da conta. */
export const MIN_AGE_DAYS = 7;
/** Quantos vídeos longos por canal entram na mediana. */
export const VIDEOS_PER_CHANNEL = 30;
/** A partir de quantas vezes a mediana o vídeo conta como "acima da média". */
export const OUTLIER_RATIO = 2;

/** `PT1H2M3S` → 3723. Formato desconhecido → null. */
export function parseIsoDuration(iso: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso.trim());
  if (!m || iso.trim() === "P" || iso.trim() === "PT") return null;
  const [, d, h, min, s] = m;
  return (Number(d ?? 0) * 86400) + (Number(h ?? 0) * 3600) + (Number(min ?? 0) * 60) + Math.round(Number(s ?? 0));
}

export interface BenchmarkVideo {
  id: string;
  title: string;
  publishedAt: string;
  durationSeconds: number;
  views: number;
  thumbnailUrl: string;
}

export interface RankedVideo extends BenchmarkVideo {
  /** views ÷ mediana do canal. */
  ratio: number;
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
    .filter((v) => v.durationSeconds > SHORT_MAX_SECONDS && Date.parse(v.publishedAt) <= cutoff)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, VIDEOS_PER_CHANNEL);
}

export interface ChannelRanking {
  medianViews: number;
  sample: number;
  /** ratio ≥ OUTLIER_RATIO, maior primeiro. */
  outliers: RankedVideo[];
  /** Os vídeos mais perto da mediana (grupo de controle visual). */
  typical: RankedVideo[];
}

/** Separa os acima da média e os típicos de um canal. `typicalCount` típicos, os mais perto de ratio 1. */
export function rankChannel(videos: readonly BenchmarkVideo[], typicalCount = 3): ChannelRanking {
  const med = median(videos.map((v) => v.views));
  const ranked: RankedVideo[] = videos.map((v) => ({ ...v, ratio: med > 0 ? v.views / med : 0 }));
  const outliers = ranked.filter((v) => v.ratio >= OUTLIER_RATIO).sort((a, b) => b.ratio - a.ratio);
  const typical = ranked
    .filter((v) => v.ratio < OUTLIER_RATIO)
    .sort((a, b) => Math.abs(Math.log(a.ratio || 1e-9)) - Math.abs(Math.log(b.ratio || 1e-9)))
    .slice(0, typicalCount);
  return { medianViews: med, sample: videos.length, outliers, typical };
}

/** Melhor miniatura disponível do `snippet.thumbnails`. */
export function bestThumbnail(thumbs: Record<string, { url?: string } | undefined> | undefined): string {
  for (const k of ["maxres", "standard", "high", "medium", "default"]) {
    const u = thumbs?.[k]?.url;
    if (u) return u;
  }
  return "";
}
