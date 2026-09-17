#!/usr/bin/env node
/**
 * scripts/fix-ads-2608-pause-hora.ts (#8242)
 *
 * Script AVULSO (não uma nova CLI reusável) — corrige o registro da hora da
 * pausa de 09/09/2026 do teste 2608 (Google/Meta/Microsoft), gravada como
 * "09h10 BRT" em 3 arquivos quando a hora real (tirada da transcrição da
 * sessão que pausou) foi 16h05:36 (Meta), 16h05:49 (Google) e 16h18:21
 * (Microsoft — PMax pausada às 16h18:01, Search às 16h18:21). A hora errada
 * foi DIGITADA à mão, não derivada do relógio, ao escrever `edicoes.jsonl`.
 *
 * O que muda:
 *   1. `data/aquisicao/teste-2608/run-state.json`:
 *      - `revisao.pausa.inicio`: "2026-09-09T09:10:00-03:00" ->
 *        "2026-09-09T16:05:36-03:00" (1º braço pausado, Meta).
 *      - novo `revisao.pausa.inicio_por_braco` (Google/Meta/Microsoft).
 *      - `revisao.motivo`: troca o texto "09/09 09h10" pela hora real.
 *      Gravado via `planRunStateWrite` (`--force`, com `reason` citando
 *      esta issue) — preserva o estado anterior em
 *      `run-state-history.jsonl` ANTES do overwrite (nunca depois).
 *   2. `data/aquisicao/teste-2608/edicoes.jsonl`: as linhas 12 e 14
 *      (formato antigo, "09h10") NUNCA são editadas — só um `append` de
 *      1 linha nova `tipo: "correcao-de-registro"` (via
 *      `scripts/ads-registrar-edicao.ts`), citando a correção + os ritmos
 *      recalculados + a transcrição como fonte.
 *   3. `data/aquisicao/clicks-2608.csv`: nas 23 linhas cujo campo `fonte`
 *      cita "09h10", troca só o TEXTO pela hora real — nenhum número
 *      muda, nenhuma linha é adicionada/removida.
 *
 * O que NÃO muda: `d0`, `fim_janela`, `religar_brevo`, `coorte_madura`,
 * `apuracao_snapshot`, `bracos`, `registrado_em` — nem qualquer gasto,
 * clique, impressão ou cadastro registrado no CSV.
 *
 * Idempotente: rodar 2x não duplica nada — o passo 1 usa `assertValidRunState`
 * pra detectar se a hora já foi corrigida (aborta com exit 0, "nada a
 * fazer") antes de tentar gravar de novo; o passo 3 conta ocorrências de
 * "09h10"/"09:10:00-03:00" antes de escrever e só toca o arquivo se > 0.
 *
 * Uso: npx tsx scripts/fix-ads-2608-pause-hora.ts [--dry-run]
 *
 * Exit codes: 0 = aplicado (ou nada a fazer); 1 = validação falhou (nada
 * foi escrito); 2 = erro de I/O.
 */
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { assertValidRunState, planRunStateWrite, type AdsTestRunState } from "./lib/ads-test-run-state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_STATE_PATH = resolve(ROOT, "data/aquisicao/teste-2608/run-state.json");
const HISTORY_PATH = resolve(ROOT, "data/aquisicao/teste-2608/run-state-history.jsonl");
const EDICOES_PATH = resolve(ROOT, "data/aquisicao/teste-2608/edicoes.jsonl");
const CLICKS_CSV_PATH = resolve(ROOT, "data/aquisicao/clicks-2608.csv");
const LOG_PREFIX = "[fix-ads-2608-pause-hora]";

const OLD_INICIO = "2026-09-09T09:10:00-03:00";
const NEW_INICIO = "2026-09-09T16:05:36-03:00"; // 1º braço pausado (Meta)
const INICIO_POR_BRACO = {
  "Google Ads (teste 2608)": "2026-09-09T16:05:49-03:00",
  "Meta Ads (teste 2608)": "2026-09-09T16:05:36-03:00",
  "Microsoft Ads (teste 2608)": "2026-09-09T16:18:21-03:00", // Search (PMax às 16:18:01)
} as const;

const REASON = "#8242 — hora da pausa de 09/09 registrada errada (09h10, digitada à mão); real 16h05:36–16h18:21 BRT, tirada da transcrição da sessão que pausou.";

interface FixResult {
  runStateChanged: boolean;
  edicoesAppended: boolean;
  clicksChanged: boolean;
}

/** @pure — decide o novo texto de `revisao.motivo`, sem I/O. */
export function fixMotivo(motivo: string): string {
  return motivo.replace(
    "pausa simetrica dos 3 bracos 09/09 09h10 ->",
    "pausa simetrica dos 3 bracos 09/09 16h05 (Google/Meta) / 16h18 (Microsoft) ->",
  );
}

/** @pure — decide o novo texto de um campo `fonte` do CSV, sem I/O. */
export function fixFonteText(fonte: string): string {
  return fonte
    .replaceAll("~09h10 BRT", "16h05 BRT (Google/Meta) / 16h18 (Microsoft)")
    .replaceAll("09h10 BRT", "16h05 BRT (Google/Meta) / 16h18 (Microsoft)");
}

function step1FixRunState(dryRun: boolean): boolean {
  if (!existsSync(RUN_STATE_PATH)) {
    throw new Error(`run-state.json não encontrado em ${RUN_STATE_PATH}`);
  }
  const raw = JSON.parse(readFileSync(RUN_STATE_PATH, "utf8"));
  assertValidRunState(raw);
  const existing = raw as AdsTestRunState & {
    revisao?: { pausa?: { inicio?: string; fim?: string | null; inicio_por_braco?: Record<string, string> }; motivo?: string };
  };

  const pausa = existing.revisao?.pausa;
  if (!pausa || pausa.inicio !== OLD_INICIO) {
    console.log(`${LOG_PREFIX} run-state.json: hora já corrigida (ou pausa ausente) — nada a fazer.`);
    return false;
  }

  const nextRevisao = {
    ...existing.revisao,
    motivo: fixMotivo(existing.revisao?.motivo ?? ""),
    pausa: {
      ...pausa,
      inicio: NEW_INICIO,
      inicio_por_braco: INICIO_POR_BRACO,
    },
  };
  const next = { ...existing, revisao: nextRevisao } as AdsTestRunState;

  const plan = planRunStateWrite(existing as AdsTestRunState, next, {
    force: true,
    reason: REASON,
    nowIso: new Date().toISOString(),
  });
  if (plan.action !== "write-with-history") {
    throw new Error(`planRunStateWrite retornou ação inesperada: "${plan.action}" (esperava "write-with-history").`);
  }

  assertValidRunState(plan.state);

  if (dryRun) {
    console.log(`${LOG_PREFIX} [dry-run] run-state.json seria regravado — inicio ${OLD_INICIO} -> ${NEW_INICIO}.`);
    return true;
  }

  // Histórico ANTES do overwrite — nunca depois (planRunStateWrite.md).
  appendFileSync(HISTORY_PATH, `${JSON.stringify(plan.historyEntry)}\n`, "utf8");
  writeFileAtomic(RUN_STATE_PATH, `${JSON.stringify(plan.state, null, 2)}\n`);
  console.log(`${LOG_PREFIX} run-state.json corrigido (histórico gravado em ${HISTORY_PATH}).`);
  return true;
}

function step2AppendCorrecaoEdicoes(dryRun: boolean): boolean {
  const line = {
    ts: new Date().toISOString(),
    braco: "todos",
    tipo: "correcao-de-registro",
    efeito: "registro",
    origem: "agente",
    corrige:
      'a linha 12 (tipo "pausa-total-anuncios", ts "2026-09-09T09:10:00-03:00") e a linha 14 (tipo "retomada-pre-registro", cita "09/09 09h10") registraram a hora da pausa errada — foi digitada à mão, não derivada do relógio.',
    hora_real_por_braco: {
      "Meta Ads (teste 2608)": "2026-09-09T16:05:36-03:00",
      "Google Ads (teste 2608)": "2026-09-09T16:05:49-03:00",
      "Microsoft Ads (teste 2608) - PMax": "2026-09-09T16:18:01-03:00",
      "Microsoft Ads (teste 2608) - Search": "2026-09-09T16:18:21-03:00",
    },
    ritmo_gasto_09_09_recalculado: {
      "Google Ads (teste 2608)": "1,13x (era 1,99x com a hora errada)",
      "Microsoft Ads (teste 2608)": "0,96x (era 1,70x com a hora errada)",
      "Meta Ads (teste 2608)": "0,52x (era 0,91x com a hora errada)",
    },
    fonte: "transcrição da sessão que pausou (a62e23e8-22dd-4384-b07b-8ec2240ea267.jsonl, máquina Neo) — issue #8242",
    issue: 8242,
  };

  const existingRaw = existsSync(EDICOES_PATH) ? readFileSync(EDICOES_PATH, "utf8") : "";
  if (existingRaw.includes('"issue":8242') || existingRaw.includes('"issue": 8242')) {
    console.log(`${LOG_PREFIX} edicoes.jsonl: correção da #8242 já registrada — nada a fazer.`);
    return false;
  }

  if (dryRun) {
    console.log(`${LOG_PREFIX} [dry-run] edicoes.jsonl receberia append: ${JSON.stringify(line)}`);
    return true;
  }
  appendFileSync(EDICOES_PATH, `${JSON.stringify(line)}\n`, "utf8");
  console.log(`${LOG_PREFIX} edicoes.jsonl: linha de correção adicionada (linhas 12/14 originais intactas).`);
  return true;
}

function step3FixClicksCsv(dryRun: boolean): boolean {
  if (!existsSync(CLICKS_CSV_PATH)) {
    throw new Error(`clicks-2608.csv não encontrado em ${CLICKS_CSV_PATH}`);
  }
  const original = readFileSync(CLICKS_CSV_PATH, "utf8");
  const occurrences = (original.match(/09h10/g) ?? []).length;
  if (occurrences === 0) {
    console.log(`${LOG_PREFIX} clicks-2608.csv: nenhuma ocorrência de "09h10" — nada a fazer.`);
    return false;
  }
  const fixed = fixFonteText(original);
  const remaining = (fixed.match(/09h10/g) ?? []).length;
  if (remaining !== 0) {
    throw new Error(`clicks-2608.csv: ${remaining} ocorrência(s) de "09h10" restante(s) após a substituição — padrão não coberto.`);
  }
  if (dryRun) {
    console.log(`${LOG_PREFIX} [dry-run] clicks-2608.csv teria ${occurrences} ocorrência(s) de "09h10" corrigidas.`);
    return true;
  }
  // writeFileSync direto (não atomic-write) — precisamos preservar
  // byte-a-byte o resto do arquivo (fins de linha inclusive); atomic-write
  // é equivalente em segurança (tmp + rename), só não usado aqui porque o
  // conteúdo já é a string completa lida+substituída, sem reconstrução.
  writeFileSync(CLICKS_CSV_PATH, fixed, "utf8");
  console.log(`${LOG_PREFIX} clicks-2608.csv: ${occurrences} ocorrência(s) de "09h10" corrigidas (nenhum número mudou).`);
  return true;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const dryRun = hasFlag(argv, "dry-run");
  try {
    const result: FixResult = {
      runStateChanged: step1FixRunState(dryRun),
      edicoesAppended: step2AppendCorrecaoEdicoes(dryRun),
      clicksChanged: step3FixClicksCsv(dryRun),
    };
    console.log(`${LOG_PREFIX} concluído.`, dryRun ? "(dry-run — nada foi escrito)" : "", result);
    return 0;
  } catch (e) {
    console.error(`${LOG_PREFIX} falhou: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
