#!/usr/bin/env node
/**
 * openrouter-billing-leak-check.ts (#6716 escopo 3)
 *
 * Guard de VAZAMENTO PAGO lido do billing do gateway OpenRouter — não da
 * tabela local. Lógica pura em `scripts/lib/openrouter-billing-leak.ts`
 * (leia o docblock de lá: explica por que a fonte tem que ser o gateway, e
 * por que este check é D-1 e não pós-tick).
 *
 * Resumo do que ele fecha: o detector que já existia
 * (`vazamento_pago`/`_is_leak` em `hermes/scripts/hermes-model-cost-report.py`,
 * rodado diariamente pelo `watch-continuo-health.sh`) diz "custo ok (sem
 * vazamento pago em 24h)" lendo `session_model_usage` — tabela onde as
 * chamadas do vazamento do #6716 NUNCA aparecem. Medido em 01/09/2026: zero
 * linhas de `anthropic/claude-sonnet-5` em todo o histórico da tabela,
 * contra US$ 1,21 + 0,39 + 0,96 cobrados pelo gateway em 29–31/08.
 *
 * Uso:
 *   npx tsx scripts/openrouter-billing-leak-check.ts             # avalia + persiste + alarma se achado NOVO
 *   npx tsx scripts/openrouter-billing-leak-check.ts --dry-run   # avalia + imprime, não persiste nem alarma
 *   npx tsx scripts/openrouter-billing-leak-check.ts --days 7    # janela (default 3)
 *   npx tsx scripts/openrouter-billing-leak-check.ts --to email@x
 *
 * Env: `OPENROUTER_MANAGEMENT_KEY` (Doppler/.env) pro endpoint de activity;
 * `data/.credentials.json` com scope `gmail.send` só quando há alarme a
 * enviar. Estado: `data/openrouter-billing-leak/state.json`.
 *
 * Exit codes: 0 = sem vazamento; 1 = erro de execução OU **indeterminado**
 * (sem key, HTTP não-ok, janela vazia, leitura parcial, **presença parcial
 * de dias (#6992)** — nunca 0, porque "não consegui medir" jamais pode
 * virar "está limpo"); **3 = vazamento encontrado** — distinto de 1 de
 * propósito, pra um runner poder tratar "achou" diferente de "quebrou".
 *
 * **`--dry-run` NÃO força exit 0** (#6983 review, achado 2 — a redação
 * anterior dizia "0 = sem vazamento (ou dry-run)" e o código nunca fez
 * isso). Dry-run suprime só os EFEITOS (não persiste estado, não envia
 * e-mail); o veredito continua saindo no exit code, senão um preview de
 * vazamento sairia indistinguível de uma janela limpa.
 *
 * Sem convenção global de exit code neste repo — cada script documenta o
 * seu. (Uma versão anterior deste bloco citava `check-pr-checks-gate.ts`
 * como "mesma disciplina"; lá o 3 é o OPOSTO — erro/indeterminado. Citação
 * removida em vez de corrigida: não havia padrão compartilhado a herdar.)
 *
 * Fuso: o `/api/v1/activity` agrega por dias UTC COMPLETOS, e o `cutoff`
 * abaixo é derivado de `toISOString()` — os dois lados da comparação vivem
 * em UTC de propósito. Não trocar por data local (BRT) sem reconferir o
 * referencial do endpoint.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import {
  evaluateBillingLeak,
  shouldAlarmBillingLeak,
  newBillingLeakKeys,
  advanceBillingLeakAlarmState,
  emptyBillingLeakAlarmState,
  buildBillingLeakAlarmEmail,
  computeExpectedDays,
  hasPartialCoverage,
  type BillingRow,
  type BillingLeakAlarmState,
} from "./lib/openrouter-billing-leak.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "openrouter-billing-leak", "state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[openrouter-billing-leak]";
const ACTIVITY_URL = "https://openrouter.ai/api/v1/activity";
const ACTIVITY_TIMEOUT_MS = 30_000;
/** Exit code dedicado pra "achou vazamento" — nunca confundir com erro. */
export const LEAK_FOUND_EXIT_CODE = 3;

/** #7211: forma anterior do estado, salva em disco antes desta issue — só
 * pra migração tolerante em `loadState`, nunca escrita de novo. */
interface LegacyBillingLeakAlarmState {
  lastAlarmedFingerprint: string | null;
  lastCheckedAt: string | null;
}

export function loadState(statePath: string = STATE_PATH): BillingLeakAlarmState {
  if (!existsSync(statePath)) return emptyBillingLeakAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<BillingLeakAlarmState> &
      Partial<LegacyBillingLeakAlarmState>;
    const at = typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt : null;
    if (Array.isArray(raw.alarmedKeys)) {
      return { alarmedKeys: raw.alarmedKeys.filter((k): k is string => typeof k === "string"), lastCheckedAt: at ?? null };
    }
    // #7211: estado no formato ANTERIOR (`lastAlarmedFingerprint` — um
    // fingerprint de CONJUNTO, `date:model` join por vírgula) — migração
    // tolerante, sem re-alarmar o que já foi avisado: semeia `alarmedKeys`
    // com o split do fingerprint em vez de descartar o histórico.
    if (typeof raw.lastAlarmedFingerprint === "string" && raw.lastAlarmedFingerprint.length > 0) {
      return { alarmedKeys: raw.lastAlarmedFingerprint.split(",").filter((k) => k.length > 0), lastCheckedAt: at ?? null };
    }
    return { alarmedKeys: [], lastCheckedAt: at ?? null };
  } catch (e) {
    // #6983 (review): antes era `catch {}` mudo. A direção é segura (estado
    // vazio re-alarma, nunca silencia), mas um problema PERSISTENTE de I/O
    // (permissão errada no diretório) ficava invisível pra sempre,
    // "recuperando" em silêncio a cada execução.
    console.error(`${LOG_PREFIX} estado ilegível em ${statePath} (${(e as Error).message}) — seguindo com estado vazio; se repetir, é I/O, não corrupção pontual.`);
    return emptyBillingLeakAlarmState();
  }
}

export function saveState(state: BillingLeakAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Normaliza a resposta do `/api/v1/activity` em `BillingRow[]`, descartando
 * o que não dá pra interpretar.
 *
 * Linha com `usage` não-numérico é DESCARTADA, nunca coagida pra 0: um `0`
 * fabricado aqui viraria "sem vazamento" — exatamente o falso "ok" que este
 * guard existe pra não repetir. O caller conta quantas foram descartadas e
 * trata isso como indeterminado, não como limpo.
 */
/**
 * Converte um campo numérico do payload SEM coagir falsy pra 0.
 *
 * #6983 (review, CRÍTICO): a 1ª versão fazia `Number(o.usage)` no `else`, e
 * `Number(null)`, `Number(false)` e `Number("")` são **0**, todos passando
 * por `Number.isFinite`. Ou seja: linha com `usage` AUSENTE ou corrompido
 * virava `usageUsd: 0` — e `isBillingLeak` trata custo 0 como "nunca é
 * vazamento". Um modelo pago vazando, com o campo de custo nulo, era
 * relatado como limpo. É exatamente o falso "ok" que este guard existe pra
 * não repetir, reintroduzido por outra porta (parsing, em vez de fonte
 * errada) — e o docstring já prometia o comportamento certo enquanto o
 * código fazia o oposto.
 */
function numericField(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN; // null, false, "", [], {}, undefined → shape inválido
}

export function parseActivityRows(payload: unknown): { rows: BillingRow[]; skipped: number } {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return { rows: [], skipped: 0 };
  const rows: BillingRow[] = [];
  let skipped = 0;
  for (const item of data) {
    // #6991 (pr-test-analyzer, P2): null/undefined/string/number no array
    // `data` faziam `o.date` lançar TypeError — crash silencioso no meio do
    // parse, antes de chegar no skip-count. Guard de objeto primeiro.
    if (typeof item !== "object" || item === null) {
      skipped++;
      continue;
    }
    const o = item as Record<string, unknown>;
    const date = typeof o.date === "string" ? o.date : null;
    const model = typeof o.model === "string" ? o.model : null;
    const usage = numericField(o.usage);
    const requests = numericField(o.requests);
    if (!date || !model || !Number.isFinite(usage)) {
      skipped++;
      continue;
    }
    rows.push({ date, model, usageUsd: usage, requests: Number.isFinite(requests) ? requests : 0 });
  }
  return { rows, skipped };
}

/**
 * Pura — traduz o resultado da rodada em exit code.
 *
 * Extraída de `main()` no #6983 (review, achado 3) só pra virar testável: a
 * regra que importa é que **leitura parcial nunca sai 0**. `main()` é I/O
 * puro (fetch + Gmail + disco) e nenhum teste a exercita, então a decisão
 * mais fácil de regredir em silêncio era justamente a que ninguém cobria.
 *
 * `hasLeaks` vence sobre `partialRead`: achado positivo é informação mais
 * forte que "faltou dado" — as duas condições saem diferente de 0 de todo
 * jeito, e o 3 diz ao runner que há gasto concreto a olhar.
 */
export function resolveExitCode({
  hasLeaks,
  partialRead,
  emptyWindow,
  partialCoverage,
}: {
  hasLeaks: boolean;
  partialRead: boolean;
  /** Nenhuma linha sobrou na janela — o endpoint pode simplesmente não ter
   *  consolidado ainda. Ver `JANELA VAZIA` abaixo. */
  emptyWindow: boolean;
  /** #6992: algum dia esperado na janela está ausente do dado retornado —
   *  presença parcial da janela lida como cobertura completa pelo guard
   *  original. Ausência de dias recentes (onde um vazamento fresco seria
   *  visível) vira INDETERMINADO, não "sem vazamento". */
  partialCoverage: boolean;
}): number {
  if (hasLeaks) return LEAK_FOUND_EXIT_CODE;
  if (partialRead || emptyWindow || partialCoverage) return 1;
  return 0;
}

/**
 * Pura — exit code do catch de topo, PRESERVANDO um "achou vazamento" já
 * decidido.
 *
 * #6983 (review independente, P1 reproduzido por execução): o catch fazia
 * `process.exitCode = 1` incondicional e sobrescrevia o 3 que `main()` já
 * tinha setado de propósito antes de alarmar. Rodando o script real com
 * vazamento verdadeiro e sem credencial do Gmail — o que faz
 * `sendGmailMessage` lançar como lançaria em produção com token expirado —
 * saía:
 *
 *     janela=2026-08-31 vazado=US$1.2064 achados=1
 *     erro: GoogleAuthError: Credenciais não encontradas...
 *     EXIT_CODE=1        ← devia ser 3
 *
 * Ou seja: o vazamento aparecia no log, e o canal que o docstring deste
 * arquivo chama de autoritativo (o exit code) colapsava "achou" em
 * "quebrou". Um runner que só olha o código de saída — que é o ponto de ter
 * um código dedicado — trataria o dia do vazamento como um erro qualquer.
 *
 * A ironia que o review nomeou, e que vale deixar escrita: `resolveExitCode`
 * foi extraída pra tornar testável "traduzir avaliação → exit code", e esta
 * função existe porque "o processo termina com o código que aquela disse"
 * era um segundo passo, igualmente não testado, na mesma cadeia.
 */
// O parâmetro é largo de propósito: `process.exitCode` é tipado
// `string | number | null | undefined` no Node, e estreitar pra `number`
// obrigaria um cast no call site — que é exatamente onde um valor
// inesperado precisa ser tratado, não silenciado. Só o 3 EXATO (número)
// preserva; qualquer outra coisa, inclusive `"3"` string, vira 1.
export function resolveFatalExitCode(current: string | number | null | undefined): number {
  return current === LEAK_FOUND_EXIT_CODE ? LEAK_FOUND_EXIT_CODE : 1;
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getStringArg(argv, "to");
  const daysRaw = getStringArg(argv, "days");
  const days = daysRaw ? Number(daysRaw) : 3;
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`--days precisa ser um número positivo, recebido "${daysRaw}"`);
  }

  const key = process.env.OPENROUTER_MANAGEMENT_KEY;
  if (!key) {
    // Sem chave o guard não sabe NADA — nunca imprimir "ok" nesse estado.
    console.error(
      `${LOG_PREFIX} INDETERMINADO — OPENROUTER_MANAGEMENT_KEY ausente. Sem ela este guard não consegue ler o billing e NÃO pode afirmar que não há vazamento.`,
    );
    process.exitCode = 1;
    return;
  }

  // #6983 (review): sem timeout, um hang de rede pendura o processo
  // indefinidamente — sem exit code, sem e-mail, sem log. Falha silenciosa
  // por AUSÊNCIA de sinal, que é o pior tipo pra um guard agendado.
  const res = await fetch(ACTIVITY_URL, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(ACTIVITY_TIMEOUT_MS),
  });
  if (!res.ok) {
    console.error(`${LOG_PREFIX} INDETERMINADO — activity respondeu HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }

  const { rows: allRows, skipped } = parseActivityRows(await res.json());
  // #6983 (review, CRÍTICO): antes isto era SÓ um console.error, e o fluxo
  // seguia — com linhas sobreviventes limpas, o processo saía 0, gravava
  // `lastAlarmedFingerprint: null` e implicava "sem vazamento" sobre uma
  // medição admitidamente PARCIAL. Se o gateway mudasse o shape justo da
  // linha que está vazando (e só dela), o guard reportaria limpo pra sempre
  // — o mesmo modo de falha do detector que esta PR substitui.
  //
  // Descartar linha é perder visibilidade sobre gasto, e este guard não pode
  // afirmar ausência do que não conseguiu ler. Segue avaliando (um vazamento
  // achado nas linhas ÍNTEGRAS continua valendo e ainda alarma), mas a
  // execução nunca termina como "limpa".
  const partialRead = skipped > 0;
  if (partialRead) {
    console.error(
      `${LOG_PREFIX} PARCIAL — ${skipped} linha(s) do activity descartada(s) por shape inválido. Não dá pra afirmar ausência de vazamento sobre dado incompleto.`,
    );
  }

  // Janela: o endpoint não cobre o dia corrente (~1 dia de consolidação),
  // então "últimos N dias" aqui é sempre N dias que TERMINAM ontem.
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const rows = allRows.filter((r) => r.date.slice(0, 10) >= cutoff);

  const evaluation = evaluateBillingLeak(rows);
  console.log(
    `${LOG_PREFIX} janela=${evaluation.daysCovered.join(",") || "(vazia)"} total=US$${evaluation.totalUsd.toFixed(4)} vazado=US$${evaluation.leakedUsd.toFixed(4)} achados=${evaluation.leaks.length}`,
  );
  for (const l of evaluation.leaks) {
    console.log(`${LOG_PREFIX}   ${l.date} ${l.model} — ${l.requests} req US$${l.usageUsd.toFixed(4)}`);
  }

  // JANELA VAZIA — o modo de falha que mais aparece nesta família de guards
  // (#6966: `LIKE` casando zero linhas e o watchdog imprimindo "tick ok";
  // #6927: sinal que some por construção quando o updater desliga). Aqui
  // "zero linhas" tem DUAS causas indistinguíveis daqui: gasto realmente
  // zero, ou o endpoint ainda não ter consolidado a janela pedida (ele
  // agrega por dias UTC completos e NÃO cobre o dia corrente). Como não dá
  // pra separar, nunca sai 0.
  if (evaluation.daysCovered.length === 0) {
    console.error(
      `${LOG_PREFIX} INDETERMINADO — nenhuma linha na janela (cutoff ${cutoff}, --days ${days}). Pode ser gasto zero de verdade OU o endpoint não ter consolidado; este guard não distingue, e não afirma "ok".`,
    );
    process.exitCode = resolveExitCode({ hasLeaks: false, partialRead, emptyWindow: true, partialCoverage: false });
    return;
  }

  // #6992: além de "janela 100% vazia", o guard também detecta PRESENÇA
  // PARCIAL — dias esperados ausentes no dado retornado. Um dia com gasto
  // realmente zero não aparece no activity, então `partialCoverage` pode
  // sinalizar indeterminado num dia ocioso — ruído aceito de propósito
  // (#6992: prevenir falso-negativo de vazamento pesa mais que alarme extra
  // num dia quieto). O cálculo de dias esperados usa o mesmo referencial UTC
  // do `cutoff` acima para não divergir do filtro aplicado.
  const expectedDays = computeExpectedDays(days);
  const partialCoverage = hasPartialCoverage(evaluation.daysCovered, expectedDays);
  if (partialCoverage) {
    const covered = new Set(evaluation.daysCovered);
    const missing = expectedDays.filter((d) => !covered.has(d));
    console.error(
      `${LOG_PREFIX} PARCIAL — dias esperados ausentes: ${missing.join(", ")}. Não dá pra afirmar ausência de vazamento sobre janela de ${days} dias com apenas ${evaluation.daysCovered.length} presente(s).`,
    );
  }

  // #6983 (review): o exit code de "achou vazamento" é setado ANTES de
  // tentar alarmar/gravar. Se `sendGmailMessage` ou `saveState` lançar, a
  // exceção sobe pro catch de `main()` — que setava 1 e apagava a distinção
  // entre "quebrou" e "achou vazamento E quebrou ao avisar". O runner
  // precisa saber que havia vazamento pendente mesmo quando o aviso falhou.
  process.exitCode = resolveExitCode({
    hasLeaks: evaluation.leaks.length > 0,
    partialRead,
    emptyWindow: false, // já retornou acima se fosse vazia
    partialCoverage,
  });

  const state = loadState();
  // #7211: idempotência por CHAVE acumulada, não mais por fingerprint de
  // conjunto — ver o docblock de `shouldAlarmBillingLeak`/`newBillingLeakKeys`
  // em scripts/lib/openrouter-billing-leak.ts.
  const newKeys = newBillingLeakKeys(evaluation, state);
  if (shouldAlarmBillingLeak(state, evaluation)) {
    const { subject, body } = buildBillingLeakAlarmEmail(evaluation, new Date(), newKeys);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria pra ${to}:\n--- ${subject} ---\n${body}`);
    } else {
      // Sem try/catch — se o envio falhar, o cursor abaixo não avança e a
      // próxima execução tenta de novo, em vez de marcar como "já avisado"
      // sem o editor ter recebido nada (molde dos demais alarmes).
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to} (${newKeys.length} achado(s) novo(s)).`);
    }
  } else if (evaluation.leaks.length > 0) {
    console.log(`${LOG_PREFIX} vazamento(s) já alarmado(s) antes (nenhuma chave nova) — sem e-mail novo.`);
  }

  if (!isDryRun) saveState(advanceBillingLeakAlarmState(evaluation, new Date(), state));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = resolveFatalExitCode(process.exitCode);
  });
}
