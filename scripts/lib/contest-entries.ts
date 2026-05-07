/**
 * contest-entries.ts (#597)
 *
 * Pure helpers para o sorteio mensal "ache o erro, ganhe um número". O
 * editor antes processava cada email manualmente: lia, validava, calculava
 * o próximo número, respondia. Agora o pipeline drena threads do Gmail,
 * apresenta cada uma pro editor decidir, e ao aprovar atribui número
 * sequencial + cria rascunho automático.
 *
 * Storage: `data/contest-entries.jsonl` — JSONL append-only com 1 linha
 * por participante confirmado. Schema preservado da bootstrap manual
 * (entradas em 260504, 260505 já existem).
 *
 * Effort budget: o sorteio acontece 1×/mês com ~5-20 participantes.
 * Otimização (caching, etc) não é prioridade — código simples, claro.
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Tipos de erro — mantidos abertos como string union expansível pra não
 * forçar atualização do tipo a cada novo padrão observado. Casos comuns:
 * "factual" (erro factual), "version_inconsistency" (versão divergente),
 * "typo", "math", "outdated".
 */
export type ErrorType = string;

/**
 * Schema de uma entry — exatamente o formato observado em
 * `data/contest-entries.jsonl` no bootstrap manual (260504-260505).
 */
export interface ContestEntry {
  /** "YYYY-MM" — mês do sorteio (geralmente edition_month + 1). */
  draw_month: string;
  /** Número sequencial atribuído ao leitor (1, 2, 3, ...). */
  number: number;
  reader_email: string;
  reader_name: string;
  /** "AAMMDD" — edição em que o erro foi encontrado. */
  edition: string;
  error_type: ErrorType;
  /** Descrição curta do erro reportado. */
  detail: string;
  /** Gmail thread ID — usado pra rastrear a conversa e evitar duplicação. */
  reply_thread_id: string;
  /** ISO timestamp UTC. */
  confirmed_at: string;
}

/**
 * Lê todas as entries do arquivo. Retorna [] se arquivo não existe.
 * Linhas malformadas são silenciosamente puladas (defensive — preserva
 * histórico mesmo com corruption parcial).
 */
export function loadEntries(path: string): ContestEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const entries: ContestEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as ContestEntry;
      if (
        typeof parsed.draw_month === "string" &&
        typeof parsed.number === "number" &&
        typeof parsed.reader_email === "string"
      ) {
        entries.push(parsed);
      }
    } catch {
      // Linha malformada — pular silenciosamente
    }
  }
  return entries;
}

/**
 * Calcula o próximo número sequencial para um sorteio. Retorna `1` se
 * não há entries ainda nesse `draw_month`. Caso contrário, max+1.
 *
 * Não considera `number` zero/negativo (defensive).
 */
export function nextNumber(entries: ContestEntry[], drawMonth: string): number {
  const monthEntries = entries.filter((e) => e.draw_month === drawMonth);
  if (monthEntries.length === 0) return 1;
  const max = Math.max(...monthEntries.map((e) => e.number).filter((n) => n > 0));
  if (!Number.isFinite(max) || max < 1) return 1;
  return max + 1;
}

/**
 * Detecta se um Gmail thread já foi processado (entry com mesmo
 * `reply_thread_id` existe). Idempotência: rodar `add` duas vezes pra
 * mesma thread retorna `null` na segunda.
 */
export function findByThreadId(
  entries: ContestEntry[],
  threadId: string,
): ContestEntry | null {
  return entries.find((e) => e.reply_thread_id === threadId) ?? null;
}

/**
 * Append-only write — adiciona 1 linha JSONL no final do arquivo.
 * Cria o diretório se não existir. Usa rename atômico via `.tmp` no
 * caso especial de arquivo novo (1ª entry); appends subsequentes vão
 * direto pro arquivo (perda parcial mid-write é extremamente rara em
 * append < 1KB).
 */
export function appendEntry(path: string, entry: ContestEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  const line = JSON.stringify(entry) + "\n";
  if (!existsSync(path)) {
    // Atomic create
    const tmp = path + ".tmp";
    writeFileSync(tmp, line, "utf8");
    renameSync(tmp, path);
  } else {
    appendFileSync(path, line, "utf8");
  }
}

/**
 * Formata o texto de resposta automática enviado ao leitor confirmado.
 * Mês exibido em PT-BR (ex: "junho de 2026"). Data da edição vem como
 * frase relativa ("de ontem", "de anteontem") quando aplicável, fallback
 * pra "de DD de mês" pra deltas maiores que 2 dias (NUNCA AAMMDD em texto
 * pra leitor). Mantido simples — editor revisa o draft antes de enviar.
 */
export function formatReplyText(entry: ContestEntry): string {
  const monthName = drawMonthLabel(entry.draw_month);
  const editionPhrase = relativeEditionPhrase(entry.edition, entry.confirmed_at);
  return `Olá, ${entry.reader_name.split(" ")[0]}!\n\nObrigado por encontrar o erro da edição ${editionPhrase}. Seu número é ${entry.number} — sorteio no início de ${monthName}. Boa sorte!\n\n— Diar.ia`;
}

/**
 * Converte AAMMDD + confirmed_at ISO em frase relativa em PT-BR.
 * Comparação em BRT (UTC-3) — referência editorial.
 *   delta=0 → "de hoje"
 *   delta=1 → "de ontem"
 *   delta=2 → "de anteontem"
 *   delta≥3 → "de 7 de maio" (formato humano, NUNCA AAMMDD em texto pra leitor)
 *
 * Pura — sem dependência em Intl ou TZ libraries.
 */
export function relativeEditionPhrase(
  editionAAMMDD: string,
  confirmedAtIso: string,
): string {
  const fallback = `de ${humanEditionDate(editionAAMMDD)}`;
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(editionAAMMDD);
  if (!m) return fallback;
  const editionDayUtc = Date.UTC(
    2000 + parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
  );
  const confirmedMs = Date.parse(confirmedAtIso);
  if (Number.isNaN(confirmedMs)) return fallback;
  // Shift confirmed timestamp pra BRT (UTC-3) e pegar só a data calendar.
  const confirmedBrt = new Date(confirmedMs - 3 * 60 * 60 * 1000);
  const confirmedDayUtc = Date.UTC(
    confirmedBrt.getUTCFullYear(),
    confirmedBrt.getUTCMonth(),
    confirmedBrt.getUTCDate(),
  );
  const deltaDays = Math.floor(
    (confirmedDayUtc - editionDayUtc) / (24 * 60 * 60 * 1000),
  );
  if (deltaDays === 0) return "de hoje";
  if (deltaDays === 1) return "de ontem";
  if (deltaDays === 2) return "de anteontem";
  return fallback;
}

/**
 * "260507" → "7 de maio" (humano-readable).
 * Usado em comunicações com leitores quando data relativa não cabe
 * (delta ≥ 3 dias). NUNCA usar AAMMDD direto em texto pra assinante.
 */
export function humanEditionDate(editionAAMMDD: string): string {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(editionAAMMDD);
  if (!m) return editionAAMMDD;
  const day = parseInt(m[3], 10);
  const monthIdx = parseInt(m[2], 10) - 1;
  const months = [
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
  ];
  if (monthIdx < 0 || monthIdx > 11) return editionAAMMDD;
  return `${day} de ${months[monthIdx]}`;
}

/**
 * "2026-06" → "junho de 2026". Pura — sem dependência em Intl pra
 * garantir output determinístico (Intl pode variar com runtime).
 */
export function drawMonthLabel(drawMonth: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(drawMonth);
  if (!m) return drawMonth;
  const year = m[1];
  const monthIdx = parseInt(m[2], 10) - 1;
  const months = [
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
  ];
  if (monthIdx < 0 || monthIdx > 11) return drawMonth;
  return `${months[monthIdx]} de ${year}`;
}

/**
 * Sorteia um número aleatório entre as entries de um draw_month
 * específico. Usa Math.random() — não criptograficamente seguro, mas
 * suficiente pra um sorteio editorial (não há incentivo financeiro pra
 * gaming). Seed opcional pra testes determinísticos.
 */
export function drawWinner(
  entries: ContestEntry[],
  drawMonth: string,
  rng: () => number = Math.random,
): ContestEntry | null {
  const candidates = entries.filter((e) => e.draw_month === drawMonth);
  if (candidates.length === 0) return null;
  const idx = Math.floor(rng() * candidates.length);
  return candidates[idx];
}
