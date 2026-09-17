/**
 * scripts/lib/social-followers.ts (#8260)
 *
 * Núcleo PURO de "seguidores ganhos por dia" no Instagram (@diar.ia.br) e no
 * Facebook — Fase 1 da issue: o saldo LÍQUIDO diário (`followers_count` de
 * hoje − `followers_count` do último dia coletado), derivado de um arquivo
 * append-only, `data/metrics/social-followers.jsonl`, escrito 1×/dia por
 * `scripts/social-followers-collect.ts` (a task agendada). Nenhuma chamada de
 * rede aqui — só parsing + cálculo, mesmo espírito de
 * `scripts/lib/ads-campaign-economics.ts` (núcleo puro, fetch é outro
 * arquivo).
 *
 * ## Por que "saldo", não "ganhos brutos" (Fase 1 da issue #8260)
 *
 * `followers_count` do Graph API é um TOTAL, não um evento — o saldo do dia
 * é sempre `hoje − ontem` (ou `hoje − última coleta`, se um dia faltou), e é
 * necessariamente LÍQUIDO (ganhos − perdidos), nunca o bruto (isso é Fase 2,
 * que depende de escopo `instagram_manage_insights`/`read_insights` que o
 * token atual não tem — ver corpo da issue).
 *
 * ## Dia faltando não quebra o cálculo, só amplia a janela do saldo
 *
 * A task pode não rodar num dia (máquina desligada, OneDrive sem sync,
 * etc.) — `computeDailyBalances` NUNCA assume "ontem" como a amostra
 * anterior; usa a amostra IMEDIATAMENTE anterior na série ordenada,
 * qualquer que seja a distância em dias, e reporta `daysSincePrevious` pra
 * quem consome saber que aquele saldo é a soma de N dias, não de 1.
 *
 * ## Nunca 0 quando o dado é ausente (mesmo invariante do resto da `/ads`)
 *
 * A 1ª amostra de uma plataforma (sem nenhuma anterior) tem `delta: null`,
 * nunca `0` — não dá pra saber quantos seguidores foram ganhos ANTES da
 * coleta começar. Dia sem NENHUMA amostra simplesmente não aparece na série
 * (não existe "saldo 0 inventado" pra um dia que a task não rodou).
 */

export type SocialPlatform = "instagram" | "facebook";

/** 1 linha do JSONL — 1 leitura de `followers_count` de 1 plataforma em 1
 *  dia. `date` é `YYYY-MM-DD` (dia de CALENDÁRIO da coleta, não o instante —
 *  a task roda 1×/dia, então a granularidade é dia, igual ao resto da
 *  `/ads`). */
export interface SocialFollowerSample {
  date: string;
  platform: SocialPlatform;
  followersCount: number;
}

/** Resultado de parsear o JSONL inteiro — fail-soft POR LINHA (mesmo
 *  padrão do resto do repo, ex: `readSpendCsv`/`SpendRowError`): uma linha
 *  corrompida nunca derruba as outras, só entra em `errors` com o número da
 *  linha (1-based) e o motivo. */
export interface SocialFollowersParseResult {
  samples: SocialFollowerSample[];
  errors: Array<{ line: number; reason: string }>;
}

function isValidPlatform(v: unknown): v is SocialPlatform {
  return v === "instagram" || v === "facebook";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parseia o conteúdo bruto de `social-followers.jsonl`. Linha vazia é
 * pulada silenciosamente (comum em arquivo editado à mão / trailing
 * newline); linha não-vazia mas inválida (JSON malformado, campo ausente,
 * tipo errado, `followersCount` negativo, `date` fora do formato) vira 1
 * entrada em `errors`, nunca lança. @pure
 */
export function parseSocialFollowersJsonl(content: string): SocialFollowersParseResult {
  const samples: SocialFollowerSample[] = [];
  const errors: Array<{ line: number; reason: string }> = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === "") continue;
    const lineNo = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      errors.push({ line: lineNo, reason: "JSON inválido" });
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      errors.push({ line: lineNo, reason: "linha não é um objeto" });
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.date !== "string" || !DATE_RE.test(obj.date)) {
      errors.push({ line: lineNo, reason: "date ausente ou fora do formato YYYY-MM-DD" });
      continue;
    }
    if (!isValidPlatform(obj.platform)) {
      errors.push({ line: lineNo, reason: `platform inválida: ${String(obj.platform)}` });
      continue;
    }
    if (typeof obj.followersCount !== "number" || !Number.isFinite(obj.followersCount) || obj.followersCount < 0) {
      errors.push({ line: lineNo, reason: "followersCount ausente ou inválido" });
      continue;
    }
    samples.push({ date: obj.date, platform: obj.platform, followersCount: obj.followersCount });
  }
  return { samples, errors };
}

/** Serializa 1 amostra pra 1 linha JSONL (usado pelo coletor ao gravar). @pure */
export function serializeSocialFollowerSample(sample: SocialFollowerSample): string {
  return JSON.stringify(sample);
}

/** 1 ponto da série de saldo diário de 1 plataforma. */
export interface DailyFollowerBalance {
  date: string;
  followersCount: number;
  /** `null` só na 1ª amostra da série (sem amostra anterior pra comparar —
   *  nunca inventa um saldo de "dia 0"). Pode ser negativo (perda líquida
   *  de seguidores no intervalo). */
  delta: number | null;
  /** `null` na 1ª amostra; `1` no caso normal (amostra do dia anterior
   *  existe); `>1` quando 1+ dias faltaram entre esta amostra e a anterior
   *  — o `delta` acima é o saldo acumulado desse intervalo inteiro, não de
   *  1 dia só. */
  daysSincePrevious: number | null;
}

export interface DailyFollowerBalanceResult {
  platform: SocialPlatform;
  points: DailyFollowerBalance[];
  /** Total atual = `followersCount` da amostra mais recente. `null` se não
   *  há nenhuma amostra desta plataforma. */
  currentTotal: number | null;
  /** Soma de todos os `delta` não-nulos da série — "ganhos líquidos no
   *  período inteiro coletado" (não confundir com o card de referência da
   *  issue, que é uma janela específica; este total cobre TODA a série
   *  disponível). `null` se não há nenhum `delta` calculável (0 ou 1
   *  amostra). */
  totalDelta: number | null;
  /** Data da amostra mais antiga/mais recente — `null` se a série está
   *  vazia. Útil pra UI dizer "coletando desde X". */
  firstDate: string | null;
  lastDate: string | null;
}

/** Diferença em dias de calendário entre duas datas `YYYY-MM-DD` (UTC puro,
 *  mesma convenção de `dateRangeInclusive` em `ads-campaign-economics.ts` —
 *  nunca fuso local/`Date.now()`). @pure */
function daysBetweenDates(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / msPerDay);
}

/**
 * Constrói a série de saldo diário de UMA plataforma a partir de TODAS as
 * amostras (de todas as plataformas — filtra internamente). Amostras
 * duplicadas pro mesmo dia (task rodou 2× no mesmo dia, ou reprocessamento)
 * usam a ÚLTIMA ocorrência na ordem de entrada (`samples` não precisa vir
 * ordenado — a função ordena por `date` internamente). @pure
 */
export function computeDailyBalances(
  samples: SocialFollowerSample[],
  platform: SocialPlatform,
): DailyFollowerBalanceResult {
  const byDate = new Map<string, number>();
  for (const s of samples) {
    if (s.platform !== platform) continue;
    byDate.set(s.date, s.followersCount); // última ocorrência vence
  }
  const dates = [...byDate.keys()].sort();

  const points: DailyFollowerBalance[] = [];
  let totalDelta: number | null = null;
  let previousDate: string | null = null;
  let previousCount: number | null = null;

  for (const date of dates) {
    const followersCount = byDate.get(date)!;
    if (previousDate === null || previousCount === null) {
      points.push({ date, followersCount, delta: null, daysSincePrevious: null });
    } else {
      const delta = followersCount - previousCount;
      const daysSincePrevious = daysBetweenDates(previousDate, date);
      points.push({ date, followersCount, delta, daysSincePrevious });
      totalDelta = (totalDelta ?? 0) + delta;
    }
    previousDate = date;
    previousCount = followersCount;
  }

  return {
    platform,
    points,
    currentTotal: dates.length > 0 ? byDate.get(dates[dates.length - 1])! : null,
    totalDelta,
    firstDate: dates.length > 0 ? dates[0] : null,
    lastDate: dates.length > 0 ? dates[dates.length - 1] : null,
  };
}
