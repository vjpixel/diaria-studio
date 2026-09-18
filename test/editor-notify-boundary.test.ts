/**
 * test/editor-notify-boundary.test.ts (#7957 item 2)
 *
 * Guard mecânico do portão único de notificação ao editor
 * (`scripts/lib/editor-notify.ts`): reprova qualquer arquivo que importe
 * `sendGmailMessage` (`scripts/lib/gmail-send.ts`) diretamente, fora de uma
 * lista fechada de 3 arquivos que POR DESENHO precisam continuar chamando o
 * Gmail de baixo nível — mesmo estilo de scan estático (regex sobre
 * specifiers de import, sem executar módulos) de `test/lib-boundary.test.ts`.
 *
 * ─── Os 3 arquivos SEMPRE permitidos (não são dívida) ───────────────────────
 *
 *   - `scripts/lib/gmail-send.ts` — a própria definição.
 *   - `scripts/lib/push-notify.ts` — canal de baixo nível que `editor-notify.ts`
 *     usa por baixo (`sendPushNotification`) pra mandar o e-mail de verdade —
 *     não é um caminho concorrente ao portão, é uma peça DELE.
 *   - `scripts/lib/editor-notify.ts` — o portão em si (hoje não importa
 *     `gmail-send.ts` direto, usa `push-notify.ts`; permitido por precaução
 *     caso uma implementação futura precise do tipo/função diretamente).
 *
 * ─── ALLOWLIST — dívida a ZERAR, nunca a crescer (#7957 item 3) ────────────
 *
 * Os ~43 scripts abaixo chamavam `sendGmailMessage` direto ANTES do portão
 * existir — migrá-los pra `notifyEditor` é o item 3 da #7957, fora do
 * escopo desta unidade (guard + portão nascem juntos; a migração em massa é
 * follow-up). Remover uma entry daqui SEMPRE que o arquivo correspondente
 * migrar — o teste falha se uma entry parar de importar `sendGmailMessage`
 * (sinal de que a entry ficou obsoleta e precisa sair), então a lista fica
 * honesta por construção: nunca cresce sem motivo, e encolhe conforme a
 * migração avança.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(ROOT, "scripts");

/** Arquivos que POR DESENHO importam `sendGmailMessage` — nunca dívida. */
const NEVER_DEBT = new Set(["scripts/lib/gmail-send.ts", "scripts/lib/push-notify.ts", "scripts/lib/editor-notify.ts"]);

/** Dívida conhecida — ver docstring acima. Ordenada, 1 por linha, pra diff
 * pequeno a cada remoção. */
const ALLOWLIST: string[] = [
  // #7960: ads-daily-digest.ts (severidade "info" — precisa da integração
  // com registerReport do Studio, item 4 da #7957, ainda não feita),
  // ads-kill-switch-alarm.ts e ads-test-watch.ts (severidade "urgente", mas
  // injetam `sendEmail`/`GmailSendResult` via DI própria com cobertura de
  // teste extensa em cima desse shape exato — migrar exige trocar a forma
  // do dep e reescrever os testes correspondentes, deixado pra uma unidade
  // dedicada) ficam de fora por ora.
  "scripts/ads-daily-digest.ts",
  "scripts/ads-kill-switch-alarm.ts",
  "scripts/ads-test-watch.ts",

  // #7960: os scripts abaixo usam `planAlarmReconciliation`/
  // `applyAlarmReconciliation` (`scripts/lib/alarm-issues.ts`), não
  // `ensureAlarmIssue` direto como os já migrados nas PRs #7965/#7973/#8251/
  // #8285 — chamar `notifyEditor()` neles chamaria `ensureAlarmIssue` UMA 2ª
  // VEZ pro mesmo achado, o que pode reabrir uma issue que a reconciliação
  // acabou de FECHAR ou disputar o mesmo fingerprint com resultado
  // divergente. Abordagem correta (piloto #linkedin-weekly-staleness-alarm.ts/
  // meta-capi-staleness-alarm.ts, generalizada nas fatias 3/4): manter
  // `applyAlarmReconciliation` INTOCADO e decidir só o E-MAIL a partir do
  // `AlarmFindingOutcome[]` via `notifyEditorForOutcomes(outcomes, severity,
  // buildMessage, deps)` (`scripts/lib/editor-notify.ts`).
  //
  // 4ª fatia (#8295+, este PR): mais 13 migrados. `legacyResendIntent`
  // decidido lendo o gate de e-mail antigo de CADA script (nunca por padrão
  // de nome — mesmo critério das fatias anteriores):
  //   - `"dedupe-new-occurrences-only"` (11 — gate próprio era um fingerprint
  //     AGREGADO comparado contra `state.lastAlarmedFingerprint`; o outcome
  //     da issue reproduz a mesma idempotência): `apoios-diff-alarm.ts`,
  //     `clarice-postmaster-alarm.ts` (2 achados independentes no mesmo
  //     arquivo, ambos fingerprint CONSTANTE — dedup por streak, não por
  //     conteúdo), `dmarc-drain.ts` (já filtrava `created`/`reopened` antes
  //     da migração — swap 1:1), `geo-citation-staleness-alarm.ts` (2
  //     achados), `home-meta-check.ts`, `hub-drift-check.ts`,
  //     `hub-staleness-check.ts`, `kit-doi-orphan-guard.ts`,
  //     `robots-txt-drift-check.ts`, `studio-liveness-alarm.ts` (fingerprint
  //     CONSTANTE "unreachable" — dedup por streak, mesmo caso de
  //     clarice-postmaster-alarm.ts), `subscribe-redirect-drift-check.ts`.
  //   - default `"resend-every-run"` (2 — sem gate de dedup PRÓPRIO nenhum;
  //     o script sempre e-mailiava toda execução com achado presente, então
  //     o default já reproduz o comportamento literal):
  //     `check-metrics-health.ts`, `clarice-guardrail-alarm.ts` (idempotência
  //     real aqui é `markEvaluated` — campanha nunca reavaliada, então o
  //     e-mail já sai no máximo 1x na vida por campanha independente do
  //     `legacyResendIntent` escolhido).
  //
  // `systemd-failed-units-alarm.ts` e `task-never-armed-alarm.ts` migrados
  // (5ª fatia, #7960): o 1º tinha `ALARM_DEDUP_EXPIRY_MS` (reenvio
  // periódico independente do conjunto mudar) — mantido como gate CUSTOM
  // externo a `notifyEditorForOutcomes` (que usa `"resend-every-run"`,
  // porque o gate externo já decide o dedup de verdade). O 2º não tinha
  // TTL, só comparação pura de conjunto — migrou como os 13 anteriores,
  // `"dedupe-new-occurrences-only"`, sem state file próprio.
  //
  // Fica 1, com motivo PRÓPRIO pra não entrar nesta fatia:
  // `worker-drift-check.ts`: tem 2 fluxos de e-mail distintos no mesmo
  // arquivo — o alarme de drift (issue-based, migraria como os 13 acima)
  // E o alarme de falha SUSTENTADA da API Cloudflare (`shouldAlarmApiError`),
  // que NUNCA passa por `ensureAlarmIssue`/`applyAlarmReconciliation` (sem
  // AlarmFinding, sem issue) — não há outcome pra alimentar
  // `notifyEditorForOutcomes`. Migrar exigiria decidir se esse 2º alarme
  // passa a abrir issue própria (mudança de comportamento além do escopo
  // desta fatia) ou ganha um caminho de e-mail direto fora do portão —
  // decisão que merece unidade dedicada, não um encaixe forçado aqui.
  "scripts/worker-drift-check.ts",

  // #7960 (item 4 da #7957): implementação de baixo nível de
  // `dispatchReportEmail`/`buildReportEmail` — o canal de e-mail que
  // `registerReport()` (agora `notify: false` por default, ver
  // `scripts/studio-ui/studio-reports.ts`) usa quando ALGUÉM passa
  // `notify: true` explícito. Papel análogo a `scripts/lib/push-notify.ts`
  // (canal de baixo nível de `notifyEditor`, por isso NEVER_DEBT) — mas
  // fica na allowlist e não em NEVER_DEBT porque, ao contrário de
  // `push-notify.ts`, este módulo NÃO é usado por `editor-notify.ts`; é uma
  // superfície paralela e mais antiga (#4475/#3714) que hoje só serve
  // relatórios (severidade "info"), nunca alarmes. Migrar de vez exigiria
  // decidir se `registerReport` deve delegar pra `notifyEditor`
  // (severidade "info" -> log, nunca e-mail) em vez de manter seu próprio
  // canal de e-mail paralelo — não implementado aqui, ver a "nota de
  // arquitetura" da #7960 sobre `editor-notify.ts` não poder importar de
  // `studio-ui/**` (regra 4 de `test/lib-boundary.test.ts`).
  "scripts/studio-ui/studio-reports.ts",
].sort();

/** Lista .ts recursivamente sob `dir` (paths relativos à raiz do repo). */
function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: false })
    .map(String)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f).slice(ROOT.length + 1).split("\\").join("/"));
}

/** Specifiers de import estático, re-export e import() dinâmico. */
function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  const re = /(?:from|import\s*\()\s*['"]([^'"]+)['"]/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1]);
  return out;
}

/**
 * `true` se `relPath` importa (estático ou dinâmico) um specifier que
 * resolve pra `scripts/lib/gmail-send.ts` E o identificador
 * `sendGmailMessage` aparece no arquivo (cobre tanto `import {
 * sendGmailMessage } from "./lib/gmail-send.ts"` quanto `const {
 * sendGmailMessage } = await import("./lib/gmail-send.ts")`, usado por
 * `codex-credential-alarm.ts`). Heurística por texto — mesmo padrão de
 * `test/lib-boundary.test.ts` — não uma AST real; um falso positivo custa
 * uma entry a mais na allowlist, nunca um guard que deixa passar.
 */
function importsSendGmailMessage(relPath: string): boolean {
  const abs = join(ROOT, relPath);
  const src = readFileSync(abs, "utf8");
  if (!src.includes("sendGmailMessage")) return false;
  const specifiers = importSpecifiers(src);
  return specifiers.some((spec) => {
    if (!spec.includes("gmail-send")) return false;
    const target = resolve(dirname(abs), spec);
    return target === join(ROOT, "scripts", "lib", "gmail-send") || target === join(ROOT, "scripts", "lib", "gmail-send.ts");
  });
}

describe("editor-notify boundary (#7957 item 2)", () => {
  it("nenhum arquivo fora da allowlist importa sendGmailMessage direto", () => {
    const allTs = [...tsFilesUnder(SCRIPTS)];
    const importers = allTs.filter((f) => !NEVER_DEBT.has(f) && importsSendGmailMessage(f));
    const allowedSet = new Set(ALLOWLIST);
    const unexpected = importers.filter((f) => !allowedSet.has(f));
    assert.deepEqual(
      unexpected,
      [],
      `Arquivo(s) novo(s) importando sendGmailMessage direto, fora do portão notifyEditor ` +
        `(scripts/lib/editor-notify.ts) e fora da allowlist de dívida conhecida (#7957 item 2/3): ` +
        `${unexpected.join(", ")}. Migre pra notifyEditor() em vez de sendGmailMessage() direto.`,
    );
  });

  it("allowlist não carrega entry obsoleta (arquivo já migrado, mas esquecido na lista)", () => {
    const stale = ALLOWLIST.filter((f) => !importsSendGmailMessage(f));
    assert.deepEqual(
      stale,
      [],
      `Entry(s) na allowlist que NÃO importam mais sendGmailMessage — já foram migradas pra ` +
        `notifyEditor() e devem ser removidas de ALLOWLIST (dívida encolhe, nunca fica parada): ${stale.join(", ")}.`,
    );
  });

  it("allowlist não cita arquivo inexistente", () => {
    const missing = ALLOWLIST.filter((f) => !existsSync(join(ROOT, f)));
    assert.deepEqual(missing, [], `Entry(s) na allowlist apontando pra arquivo que não existe: ${missing.join(", ")}.`);
  });
});
