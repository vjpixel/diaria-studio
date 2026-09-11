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
  "scripts/ads-spend-ingest-alarm.ts",
  "scripts/ads-test-watch.ts",
  "scripts/apoios-diff-alarm.ts",
  "scripts/check-metrics-health.ts",
  "scripts/clarice-envio-alarm.ts",
  "scripts/clarice-envio-guard-alarm.ts",
  "scripts/clarice-guardrail-alarm.ts",
  "scripts/clarice-opens-catchup-alarm.ts",
  "scripts/clarice-postmaster-alarm.ts",
  "scripts/dmarc-drain.ts",
  "scripts/edicao-diaria-staleness-alarm.ts",
  "scripts/geo-citation-staleness-alarm.ts",
  "scripts/home-meta-check.ts",
  "scripts/hub-drift-check.ts",
  "scripts/hub-staleness-check.ts",
  "scripts/kit-doi-orphan-guard.ts",
  "scripts/kit-subscriber-limit-alarm.ts",
  // #7960: severidade "silencio" (decisão do editor, #7957) — mas este
  // arquivo hoje bundla e-mail COM criação de issue via
  // applyAlarmReconciliation/latch de retry; "silencio" exige remover a
  // issue também, não só o e-mail — refactor maior que o de
  // codex-credential-alarm.ts (que era só e-mail), deixado pra unidade
  // dedicada.
  "scripts/kit-subscriber-state-transition-alarm.ts",
  "scripts/linkedin-weekly-staleness-alarm.ts",
  "scripts/meta-capi-staleness-alarm.ts",
  "scripts/onboarding-continuity-alarm.ts",
  "scripts/onedrive-sync-alarm.ts",
  "scripts/robots-txt-drift-check.ts",
  "scripts/studio-liveness-alarm.ts",
  "scripts/studio-ui/studio-reports.ts",
  "scripts/subscribe-redirect-drift-check.ts",
  "scripts/systemd-failed-units-alarm.ts",
  "scripts/task-never-armed-alarm.ts",
  "scripts/worker-drift-check.ts",
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
