/**
 * select-eia-edition.ts (#1912)
 *
 * Seleciona, dentro de um mês `YYMM`, a edição diária cujo poll do É IA? teve
 * a taxa de acerto mais próxima de 50% — o poll que mais DIVIDIU os leitores
 * (ambiguidade máxima). Esse é o melhor É IA? pra um recap mensal: metade achou
 * IA, metade achou real.
 *
 * Substitui o critério antigo do `/diaria-mensal` (Etapa 3), que fixava o
 * ÚLTIMO DIA do mês — escolha arbitrária sem relação com qual imagem foi a mais
 * interessante.
 *
 * Fonte de dados: worker `poll` → `GET /stats?edition=AAMMDD` →
 *   { total, correct_pct, correct_answer, ... }
 * `correct_pct` é null sem votos; `correct_answer` é null se o gabarito ainda
 * não foi definido (admin/correct). Edições sem É IA? retornam total:0 →
 * naturalmente filtradas.
 *
 * Uso:
 *   npx tsx scripts/select-eia-edition.ts --month 2605 [--threshold 5] \
 *     [--base https://poll.diaria.workers.dev] [--cycle 2605-06] \
 *     [--out-json data/monthly/2605-06/_internal/03-eia-selection.json]
 *
 * stdout = a edição AAMMDD escolhida (uma linha, pra capturar na skill) —
 *   contrato inalterado desde #1912, back-compat com `EAI_EDITION=$(...)`.
 * stderr = tabela de candidatos + decisão (auditoria no gate).
 * --out-json (#2869), se passado, grava o `EiaSelectionResult` completo
 *   (selection/pct_correct/reason/fetch_errors) — consumido por
 *   `eia-compose.ts` pra rastreabilidade em `01-eia-meta.json` e pela skill
 *   pra montar o item de aviso no gate/resumo do stage.
 *
 * Fallback (sempre imprime ALGO em stdout, exit 0 — É IA? mensal é opcional):
 * se nenhuma edição do mês tiver poll elegível (gabarito + ≥ threshold votos),
 * imprime o último dia do mês (comportamento legado) e — #2869, nunca calado —
 * loga warn em stderr E em `data/run-log.jsonl` (via `logEvent`), além de
 * gravar `selection: "fallback_last"` no `--out-json` se fornecido.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logEvent } from "./lib/run-log.ts";
import { isMainModule } from "./lib/cli-args.ts";

const DEFAULT_BASE = "https://poll.diaria.workers.dev";
// Mínimo de votos pra um poll ser sinal e não ruído. Alinhado ao threshold de
// `compute-eia-poll-stats.ts` (#107). O volume diário do É IA? é baixo (~3-11
// votos/edição), então um piso de 5 mantém elegíveis os polls realmente
// ambíguos sem premiar uma edição de 2-3 votos por acaso.
const DEFAULT_THRESHOLD = 5;

export interface EditionPollStat {
  edition: string;
  total: number;
  correct_pct: number | null;
  /** Gabarito definido (admin/correct). null = sem gabarito → inelegível. */
  correct_answer: string | null;
  /**
   * Só CLI (#1913 review): true se o GET /stats falhou (rede/5xx/timeout), pra
   * distinguir "0 votos" de "não consegui ler". O seletor puro ignora este
   * campo — ele existe só pra o main() avisar quando a seleção pode estar
   * comprometida por falha de fetch (em vez de mascarar como fallback).
   */
  fetchError?: boolean;
}

/**
 * Pure: lista os AAMMDD de todos os dias do mês `YYMM`.
 * Ex: "2605" → ["260501", ..., "260531"].
 */
export function monthDays(yymm: string): string[] {
  if (!/^\d{4}$/.test(yymm)) throw new Error(`YYMM inválido: ${yymm}`);
  const yy = yymm.slice(0, 2);
  const mm = Number(yymm.slice(2, 4));
  if (mm < 1 || mm > 12) throw new Error(`mês inválido: ${yymm}`);
  // Dia 0 do mês seguinte = último dia deste mês (UTC, sem DST).
  const last = new Date(Date.UTC(2000 + Number(yy), mm, 0)).getUTCDate();
  const out: string[] = [];
  for (let d = 1; d <= last; d++) {
    out.push(`${yy}${String(mm).padStart(2, "0")}${String(d).padStart(2, "0")}`);
  }
  return out;
}

/**
 * Pure: dado o último dia do mês, retorna o AAMMDD legado (comportamento antigo
 * do skill). Usado como fallback quando não há poll elegível.
 */
export function lastDayOfMonth(yymm: string): string {
  const days = monthDays(yymm);
  return days[days.length - 1];
}

/**
 * Pure: seleciona a edição com `correct_pct` mais próximo de 50% entre as
 * elegíveis (gabarito definido + total ≥ threshold + correct_pct não-nulo).
 *
 * Desempate:
 *   1. menor |correct_pct − 50| (mais ambíguo)
 *   2. maior total (sinal mais forte)
 *   3. edição mais recente (AAMMDD maior)
 *
 * Retorna `null` se nenhuma elegível — caller decide o fallback.
 */
export function selectEiaEdition(
  stats: EditionPollStat[],
  threshold: number = DEFAULT_THRESHOLD,
): EditionPollStat | null {
  const eligible = stats.filter(
    (s) =>
      s.correct_answer != null &&
      s.correct_pct != null &&
      s.total >= threshold,
  );
  if (eligible.length === 0) return null;

  return eligible.reduce((best, cur) => {
    const db = Math.abs((best.correct_pct as number) - 50);
    const dc = Math.abs((cur.correct_pct as number) - 50);
    if (dc < db) return cur;
    if (dc > db) return best;
    // empate em |pct−50| → mais votos
    if (cur.total > best.total) return cur;
    if (cur.total < best.total) return best;
    // empate em votos → edição mais recente
    return cur.edition > best.edition ? cur : best;
  });
}

/**
 * Resultado estruturado da seleção — #2869 (traceability + no-silent-fallback).
 *
 * `selection: "criterion"` = escolha pelo critério (mais próximo de 50%, piso
 * de votos respeitado). `selection: "fallback_last"` = NENHUMA edição do mês
 * teve poll elegível (sem gabarito, ou nenhuma acima do piso de votos) — o
 * pipeline caiu no último dia do mês, e ISSO PRECISA ser sinalizado ao editor
 * (nunca escolher errado calado, #2869). `reason` é sempre uma frase legível
 * pronta pra virar warning/log/item de gate; nunca deixar o caller adivinhar
 * o motivo a partir só do edition escolhido.
 */
export interface EiaSelectionResult {
  edition: string;
  selection: "criterion" | "fallback_last";
  pct_correct: number | null;
  total_votes: number | null;
  threshold: number;
  reason: string;
  /** Edições cujo fetch de /stats falhou (rede/5xx/timeout) — sinal parcial
   *  mesmo quando `selection: "criterion"` teve sucesso (#1913 review). */
  fetch_errors: string[];
}

/**
 * Pure: dado o conjunto de stats do mês, decide a edição — pelo critério ou
 * fallback — e monta o resultado estruturado completo (nunca só a string do
 * AAMMDD). Substitui o padrão anterior onde `main()` escolhia e só LOGAVA o
 * porquê em stderr (fácil de perder num terminal de pipeline) — agora o
 * motivo é um dado que o caller pode persistir/gatear/logar (#2869).
 */
export function resolveEiaSelection(
  stats: EditionPollStat[],
  yymm: string,
  threshold: number = DEFAULT_THRESHOLD,
  fetchErrors: string[] = [],
): EiaSelectionResult {
  const chosen = selectEiaEdition(stats, threshold);
  if (chosen) {
    return {
      edition: chosen.edition,
      selection: "criterion",
      pct_correct: chosen.correct_pct,
      total_votes: chosen.total,
      threshold,
      reason:
        `Escolhida ${chosen.edition} — ${chosen.correct_pct}% acertaram ` +
        `(${chosen.total} votos, ≥${threshold} piso, mais próxima de 50% no mês ${yymm}).`,
      fetch_errors: fetchErrors,
    };
  }
  const fallback = lastDayOfMonth(yymm);
  return {
    edition: fallback,
    selection: "fallback_last",
    pct_correct: null,
    total_votes: null,
    threshold,
    reason:
      `Nenhuma edição do mês ${yymm} teve poll elegível (gabarito definido + ` +
      `≥${threshold} votos) — fallback ao último dia (${fallback}). Sem sinal ` +
      `confiável de qual edição foi a mais dividida; revisar manualmente se ` +
      `quiser trocar o É IA? do recap.`,
    fetch_errors: fetchErrors,
  };
}

/**
 * Emite o sinal de fallback (#2869) — nunca silencioso: stderr (visível no
 * terminal do pipeline) + `data/run-log.jsonl` via `logEvent` (persistido,
 * auditável fora da sessão que rodou, lido por `/diaria-log`). No-op quando
 * `result.selection === "criterion"` (nada a sinalizar).
 *
 * Extraído de `main()` pra ser testável sem precisar stubar fetch/rede
 * (#633) — regression test cobre que o warn REALMENTE é persistido, não só
 * comentado no código.
 *
 * `rootDir` é passado adiante pra `logEvent` (default cwd; tests injetam
 * tmpdir pra não sujar `data/run-log.jsonl` de produção).
 */
export function signalEiaFallback(
  result: EiaSelectionResult,
  yymm: string,
  cycleLabel?: string,
  rootDir?: string,
): void {
  if (result.selection === "criterion") {
    console.error(`\n✓ ${result.reason}`);
    return;
  }
  console.error(`\n⚠ ${result.reason}`);
  logEvent(
    {
      edition: cycleLabel ?? yymm,
      stage: 3,
      agent: "select-eia-edition",
      level: "warn",
      message: `É IA? mensal (${yymm}): fallback ao último dia — ${result.reason}`,
      details: result,
    },
    rootDir,
  );
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function fetchStat(
  base: string,
  edition: string,
): Promise<EditionPollStat> {
  try {
    // Timeout (#1913 review): sem ele, um worker pendurado travaria o
    // Promise.all — e a Etapa 3 do mensal — indefinidamente.
    const r = await fetch(`${base}/stats?edition=${edition}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      return { edition, total: 0, correct_pct: null, correct_answer: null, fetchError: true };
    }
    const j = (await r.json()) as {
      total?: number;
      correct_pct?: number | null;
      correct_answer?: string | null;
    };
    return {
      edition,
      total: j.total ?? 0,
      correct_pct: j.correct_pct ?? null,
      correct_answer: j.correct_answer ?? null,
    };
  } catch {
    // Rede/timeout/JSON inválido → marca fetchError pra o main() distinguir de
    // "0 votos" e avisar que a seleção pode estar incompleta (#1913 review).
    return { edition, total: 0, correct_pct: null, correct_answer: null, fetchError: true };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const yymm = get("--month");
  if (!yymm || !/^\d{4}$/.test(yymm)) {
    console.error("ERRO: --month YYMM obrigatório (ex: --month 2605)");
    process.exit(1);
  }
  const threshold = Number(get("--threshold") ?? DEFAULT_THRESHOLD);
  // `??` não cobre NaN (ex: `--threshold abc`) → validar explicitamente, senão
  // `total >= NaN` filtra tudo e cai em fallback silencioso (#1913 review).
  if (!Number.isFinite(threshold) || threshold < 0) {
    console.error(`ERRO: --threshold deve ser um número ≥ 0 (recebi "${get("--threshold")}")`);
    process.exit(1);
  }
  const base = get("--base") ?? DEFAULT_BASE;
  // #3311: override SÓ pra isolamento de teste — repassado a signalEiaFallback.
  // Sem essa flag, logEvent (dentro de signalEiaFallback) cai no default
  // process.cwd() — inofensivo em produção (roda da raiz do repo). Não há
  // hoje nenhum teste que spawne este CLI via subprocess até o fallback
  // path, mas a flag existe por consistência com o mesmo padrão adotado em
  // resolve-edition-url.ts (#3310), verify-accessibility.ts, dedup.ts e
  // publish-linkedin.ts (#3311).
  const logRootDir = get("--log-root-dir");

  const days = monthDays(yymm);
  // Busca em paralelo — 28-31 GETs leves no worker.
  const stats = await Promise.all(days.map((d) => fetchStat(base, d)));

  // Falha de fetch ≠ "0 votos": se algum GET caiu, a seleção pode ter perdido a
  // verdadeira vencedora. Avisa explícito em vez de mascarar como fallback (#1913).
  const failed = stats.filter((s) => s.fetchError);
  if (failed.length > 0) {
    console.error(
      `⚠ ${failed.length}/${stats.length} edições falharam no fetch de /stats ` +
        `(${failed.map((s) => s.edition).join(", ")}). A seleção pode estar incompleta.`,
    );
  }

  // Tabela de auditoria (só edições com algum voto) → stderr.
  const withVotes = stats
    .filter((s) => s.total > 0)
    .sort((a, b) => a.edition.localeCompare(b.edition));
  console.error(`Candidatos com votos no mês ${yymm}:`);
  for (const s of withVotes) {
    const dist = s.correct_pct != null ? Math.abs(s.correct_pct - 50) : null;
    console.error(
      `  ${s.edition}  total=${s.total}  pct_correct=${s.correct_pct ?? "—"}` +
        `  gabarito=${s.correct_answer ?? "—"}` +
        (dist != null ? `  |pct−50|=${dist}` : ""),
    );
  }

  const fetchErrors = failed.map((s) => s.edition);
  const result = resolveEiaSelection(stats, yymm, threshold, fetchErrors);

  // #2869: sem fallback silencioso — stderr + data/run-log.jsonl (no-op se
  // selection === "criterion").
  signalEiaFallback(result, yymm, get("--cycle"), logRootDir);

  const outJson = get("--out-json");
  if (outJson) {
    mkdirSync(dirname(resolve(outJson)), { recursive: true });
    writeFileSync(resolve(outJson), JSON.stringify(result, null, 2) + "\n");
  }

  process.stdout.write(result.edition);
}

// CLI guard (#cli-guard): só roda main() quando invocado direto, não em import.
// #2834: isMainModule() compara contra o próprio import.meta.url do módulo em
// execução — cobre .ts e .js (se algum dia compilado) automaticamente, sem
// precisar do dual endsWith(".ts"/".js") manual.
const isMain = isMainModule(import.meta.url);
if (isMain) {
  main();
}
