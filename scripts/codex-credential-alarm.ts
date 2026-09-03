#!/usr/bin/env node
/**
 * scripts/codex-credential-alarm.ts (#7250)
 *
 * Alarme das contas OpenAI Codex do Hermes. Só I/O — toda a decisão é pura e
 * testada em `scripts/lib/codex-credential-pool.ts`. Mesmo molde de
 * `scripts/kit-doi-orphan-guard.ts` e `scripts/subscribe-redirect-drift-check.ts`.
 *
 * ─── O que este alarme resolve ──────────────────────────────────────────────
 *
 * As contas Codex são acessadas por **OAuth**, não por API key: não existe
 * endpoint de saldo. O único sinal possível é o resultado da última tentativa
 * de uso — e o Hermes já o persiste, por conta, em
 * `~/.hermes/auth.json` → `credential_pool["openai-codex"]`.
 *
 * **Consequência que fica no desenho:** sem uso, não há sinal. Se ninguém
 * delegar nada, as contas podem estar zeradas e este alarme não acusa. Ele
 * detecta "esgotado ao tentar usar", nunca "esgotado". É por isso que ele roda
 * agendado e não sob demanda: o tick do contínuo é o que produz o sinal.
 *
 * ─── Por que a urgência é maior do que parece ───────────────────────────────
 *
 * Medição de 03/09/2026 (a que motivou este script): 2 das 3 contas
 * `exhausted`, com retorno em 29/09 e 02/10 — datas que a PRÓPRIA OpenAI
 * devolve no corpo do 429 (`resets_at`), não estimativa nossa. Nas 6 amostras
 * registradas em `~/.hermes/sessions/`, o `resets_in_seconds` que acompanha
 * essas respostas ficou entre 21,9 e 29,2 dias.
 *
 * A volta, portanto, é medida em SEMANAS. Se a última conta esgotar, a
 * delegação Codex não fica fora por algumas horas — e hoje nada avisa: o
 * editor descobriria pela ausência de trabalho entregue.
 *
 * ─── Onde roda ──────────────────────────────────────────────────────────────
 *
 * No `helios`, que é onde `~/.hermes/auth.json` existe e onde as tasks
 * agendadas do projeto rodam desde 11/08. `--auth-json` permite apontar para
 * outro caminho (teste, ou leitura de fora via cópia) — mas o caminho padrão
 * é o local, e o script NUNCA tenta SSH: se o arquivo não existe, ele diz
 * isso e sai, em vez de fingir que mediu.
 *
 * ─── O que este script NÃO faz, de propósito ────────────────────────────────
 *
 * Não recarrega conta, não troca plano, não rotaciona credencial, não escreve
 * em `auth.json`. Detecta e avisa; a ação é do editor. Escrever num arquivo
 * que guarda token OAuth de 3 contas é blast radius que um alarme não precisa
 * ter.
 *
 * Uso:
 *   npx tsx scripts/codex-credential-alarm.ts              # avalia + alarma se NOVO
 *   npx tsx scripts/codex-credential-alarm.ts --dry-run    # avalia + imprime, não alarma
 *   npx tsx scripts/codex-credential-alarm.ts --json       # saída programática
 *   npx tsx scripts/codex-credential-alarm.ts --auth-json /caminho/auth.json
 *   npx tsx scripts/codex-credential-alarm.ts --to editor@exemplo   # override do destinatário
 *
 * Exit codes: 0 sempre que a avaliação rodou e, se havia alarme, ele saiu. 1 em
 * uso inválido de CLI, em arquivo ilegível, e também quando o ENVIO falha — nem
 * falha de leitura nem falha de entrega pode virar "está tudo bem" em silêncio.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import {
  evaluateCodexPool,
  computeCodexPoolFingerprint,
  buildCodexAlarmMessage,
  type CodexCredentialEntry,
  type CodexPoolVerdict,
} from "./lib/codex-credential-pool.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_PATH = join(REPO_ROOT, "data", "codex-credential-alarm", "state.json");
const DEFAULT_AUTH_JSON = join(homedir(), ".hermes", "auth.json");
const POOL_KEY = "openai-codex";

interface AlarmState {
  last_fingerprint: string | null;
  last_alarmed_at: string | null;
}

function emptyState(): AlarmState {
  return { last_fingerprint: null, last_alarmed_at: null };
}

/**
 * Exportada, e com o path por parâmetro, pelo mesmo motivo que `loadState` em
 * `scripts/lib/alarm-issues.ts`: permitir o roundtrip em tmpdir sem tocar no
 * estado real sob `data/` — que é junction do OneDrive, não pasta descartável.
 */
export function readState(path: string): AlarmState {
  if (!existsSync(path)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      last_fingerprint: typeof parsed?.last_fingerprint === "string" ? parsed.last_fingerprint : null,
      last_alarmed_at: typeof parsed?.last_alarmed_at === "string" ? parsed.last_alarmed_at : null,
    };
  } catch {
    // Estado ilegível é tratado como ausente: o pior caso é um alarme
    // repetido, nunca um alarme suprimido.
    return emptyState();
  }
}

export function writeState(path: string, state: AlarmState): void {
  // `writeFileAtomic` NÃO cria o diretório-pai — ele escreve o temporário ao
  // lado do alvo, e sem a pasta a escrita estoura com ENOENT. Numa máquina
  // onde `data/codex-credential-alarm/` ainda não existe (toda primeira
  // execução), isso significaria estado nunca persistido e alarme repetindo
  // para sempre. O mkdir vem antes, de propósito.
  mkdirSync(dirname(path), { recursive: true });
  // Atômico como nos scripts irmãos (`alarm-issues.ts` → `writeFileAtomic`):
  // um kill no meio da escrita deixaria JSON truncado. `readState` já degrada
  // ilegível para ausente, então o pior caso seria um alarme repetido — mas
  // não há razão para aceitar nem esse.
  writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Lê o pool do `auth.json`. Devolve `null` (nunca lista vazia) quando o
 * arquivo não existe, não parseia, ou não tem a chave — a distinção importa:
 * "não consegui ler" e "não há conta nenhuma" levariam a alarmes opostos.
 */
export function readCodexPool(authJsonPath: string): readonly CodexCredentialEntry[] | null {
  if (!existsSync(authJsonPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(authJsonPath, "utf8"));
  } catch {
    return null;
  }
  const pool = (parsed as { credential_pool?: Record<string, unknown> })?.credential_pool?.[POOL_KEY];
  if (!Array.isArray(pool)) return null;
  return pool as CodexCredentialEntry[];
}

function render(verdict: CodexPoolVerdict, nowIso: string): string {
  return buildCodexAlarmMessage(verdict, nowIso);
}

async function main(argv: string[]): Promise<number> {
  const dryRun = hasFlag(argv, "dry-run");
  const asJson = hasFlag(argv, "json");
  // `getArg` colapsa flag ausente em "" (não `undefined`), então `??` não
  // serve aqui — o fallback tem de ser sobre string vazia.
  const authPath = getArg(argv, "auth-json") || DEFAULT_AUTH_JSON;
  const nowIso = new Date().toISOString();

  const pool = readCodexPool(authPath);

  if (pool === null) {
    const msg =
      `[codex-credential-alarm] não foi possível ler o pool em ${authPath} ` +
      `(arquivo ausente, JSON inválido, ou sem credential_pool["${POOL_KEY}"]). ` +
      `Este script roda no helios, onde o arquivo existe — rodá-lo noutra máquina ` +
      `sem --auth-json não mede nada.`;
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ ok: false, reason: "pool_unreadable", path: authPath })}\n`);
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 1;
  }

  // #7320: mesmo relógio que `buildCodexAlarmMessage` recebe abaixo — a
  // classificação depende de `resets_at` vs. agora, e as duas leituras têm
  // de concordar sobre que hora é.
  const verdict = evaluateCodexPool(pool, undefined, nowIso);
  const fingerprint = computeCodexPoolFingerprint(verdict);
  const state = readState(STATE_PATH);
  const isNew = fingerprint !== state.last_fingerprint;
  const willAlarm = verdict.shouldAlarm && isNew && !dryRun;

  // O JSON só sai DEPOIS da tentativa de envio. A primeira versão imprimia
  // `alarmed: willAlarm` antes de chamar o Gmail — e `willAlarm` é intenção,
  // não entrega: um consumidor que lesse só o stdout concluiria que o editor
  // foi avisado enquanto o envio tinha estourado.
  const emitJson = (alarmSent: boolean, alarmError: string | null): void => {
    process.stdout.write(
      `${JSON.stringify({
        ok: alarmError === null,
        vivas: verdict.vivas,
        esgotadas: verdict.esgotadas,
        indeterminadas: verdict.indeterminadas,
        pool_vazio: verdict.poolVazio,
        should_alarm: verdict.shouldAlarm,
        all_exhausted: verdict.allExhausted,
        fingerprint_changed: isNew,
        alarm_attempted: willAlarm,
        alarm_sent: alarmSent,
        alarm_error: alarmError,
        contas: verdict.verdicts.map((v) => ({ label: v.label, state: v.state, resets_at: v.resetsAtIso })),
      })}\n`,
    );
  };

  if (!asJson) {
    process.stdout.write(`${render(verdict, nowIso)}\n`);
    if (!verdict.shouldAlarm) {
      process.stdout.write(`\n[codex-credential-alarm] acima do limiar — nada a alarmar.\n`);
    } else if (!isNew) {
      process.stdout.write(
        `\n[codex-credential-alarm] já alarmado para este mesmo estado em ${state.last_alarmed_at ?? "?"} — não repete.\n`,
      );
    } else if (dryRun) {
      process.stdout.write(`\n[codex-credential-alarm] --dry-run: não envia nem persiste.\n`);
    }
  }

  if (!willAlarm) {
    if (asJson) emitJson(false, null);
    return 0;
  }

  // O envio reusa a mesma infraestrutura dos demais alarmes do projeto.
  // Import dinâmico para que --dry-run e --json não exijam credencial de
  // e-mail: medir nunca deve depender de poder enviar.
  const { sendGmailMessage } = await import("./lib/gmail-send.ts");
  const { resolveEditorEmail } = await import("./lib/inbox-stats.ts");
  const to = getArg(argv, "to") || resolveEditorEmail(join(REPO_ROOT, "platform.config.json"));
  const assunto = verdict.poolVazio
    ? "[diar.ia.br] pool de contas Codex VAZIO — nada mais está sendo vigiado"
    : verdict.allExhausted
      ? "[diar.ia.br] TODAS as contas Codex esgotadas — delegação parada"
      : `[diar.ia.br] resta ${verdict.vivas} conta Codex viva de ${verdict.verdicts.length}`;

  try {
    await sendGmailMessage(to, assunto, render(verdict, nowIso));
  } catch (err) {
    const motivo = err instanceof Error ? (err.stack ?? err.message) : String(err);
    if (asJson) emitJson(false, motivo);
    else process.stderr.write(`\n[codex-credential-alarm] FALHA ao enviar para ${to}: ${motivo}\n`);
    // Estado NÃO é persistido: a próxima execução tenta de novo, em vez de
    // tratar um envio que estourou como "já avisado".
    return 1;
  }

  // Daqui em diante o editor JÁ foi avisado. Uma falha ao gravar o estado
  // custa um alarme duplicado na próxima rodada — nunca um alarme perdido —,
  // então ela não pode derrubar o exit code e fazer parecer que o aviso não
  // saiu. Este é o único ponto do script onde falhar em silêncio seria pior
  // do que a falha em si.
  try {
    writeState(STATE_PATH, { last_fingerprint: fingerprint, last_alarmed_at: nowIso });
  } catch (err) {
    const motivo = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(
      `[codex-credential-alarm] alarme ENVIADO, mas o estado não foi gravado (${motivo}). ` +
        `A próxima execução vai repetir o alarme.\n`,
    );
  }

  if (asJson) emitJson(true, null);
  else process.stdout.write(`\n[codex-credential-alarm] alarme enviado para ${to}.\n`);

  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      // Erro não-tratado nunca pode sair como sucesso silencioso: este alarme
      // existe exatamente para tornar visível um estado que ninguém observa.
      // Stack, não só `message`: este catch existe justamente para o erro que
      // ninguém previu, e é a stack que localiza a linha meses depois.
      process.stderr.write(
        `[codex-credential-alarm] erro não-tratado: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(1);
    });
}
