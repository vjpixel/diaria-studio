/**
 * scripts/lib/test-context-guard.ts (#8290)
 *
 * Barreira mecânica pura, consumida por `scripts/lib/alarm-issues.ts`
 * (`defaultAlarmGhRun`) e `scripts/lib/push-notify.ts`
 * (`sendPushNotification`) — nunca chamada diretamente por um script de
 * alarme.
 *
 * ─── O incidente (#8287, achado 260917c) ────────────────────────────────
 *
 * Um subagente rodou uma variante de teste que chamava `main()` de
 * `scripts/check-acquisition-health.ts` **sem `--dry-run`**. A instrução
 * "proibido EXECUTAR qualquer `*-alarm.ts` [...] nem 'só pra testar'"
 * (`context/overnight-dispatch-rules.md` item 1) existia, foi lida, e ainda
 * assim foi contornada por um caminho que não *parece* execução de alarme:
 * chamar `main()` de dentro de um teste. Resultado: `notifyEditor` real, a
 * issue #8287 aberta no GitHub (fechada em minutos, sem dano — o worktree
 * não tinha credencial de Gmail).
 *
 * A instrução em prosa não é uma barreira — precisa de mecanismo. `main()`
 * não decide notificar sozinho: ele delega pra `notifyEditor` ->
 * `ensureAlarmIssue`, que por sua vez usa `defaultAlarmGhRun` (spawna `gh`
 * de verdade) e `sendPushNotification` (envia e-mail de verdade) como
 * IMPLEMENTAÇÕES DEFAULT sempre que o caller não injeta um mock — e nenhum
 * teste deveria depender de lembrar de injetar um mock pra ficar seguro.
 *
 * ─── Detecção: `NODE_TEST_CONTEXT` ──────────────────────────────────────
 *
 * O test runner nativo do Node seta este env var automaticamente em todo
 * worker/child sob o isolamento padrão (`process`) — SEM nenhum opt-in do
 * arquivo de teste. Confirmado ao vivo (Node 24, `npx tsx --test`): o
 * valor é `"child-v8"`. Como a chamada acidental do incidente foi DIRETA
 * (`main()` invocado dentro do próprio processo de teste, não um
 * subprocess spawnado), o env var já está presente por herança natural de
 * `process.env` — nenhum wiring extra é necessário pra este módulo detectar
 * o contexto certo.
 *
 * Cobertura honesta: um teste que rodasse `gh`/`sendGmailMessage` como
 * SUBPROCESSO deliberado (spawnando um binário/script à parte) herdaria
 * este env var também — a barreira bloquearia esse subprocess igual, que é
 * o comportamento CERTO (nenhum teste deste repo deveria disparar `gh`/
 * e-mail real, dentro ou fora do processo — regra 1 de
 * `context/overnight-dispatch-rules.md`). Um `gh`/`sendGmailMessage`
 * chamado por uma sessão de Claude Code fora do test runner (produção,
 * dispatch agendado, dev manual) nunca carrega este env var — a barreira
 * nunca dispara fora de teste.
 */

/**
 * `true` quando o processo atual está rodando sob o test runner nativo do
 * Node (`node --test` / `npx tsx --test`). Pura — sem I/O; aceita `env`
 * injetável só pra teste direto desta função (produção sempre lê
 * `process.env` real).
 */
export function isNodeTestContext(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_TEST_CONTEXT != null && env.NODE_TEST_CONTEXT !== "";
}

/**
 * Mensagem de recusa padronizada — usada tanto pro `console.error` (sinal
 * imediato, visível no terminal/journal) quanto pro `error`/`stderr`
 * devolvido no formato fail-soft de cada caller (`GhSpawnResult.stderr`,
 * `PushNotifyResult.error`), pra um teste conseguir `assert.match` no
 * motivo exato em vez de só observar "falhou".
 */
export function testContextRefusalMessage(detail: string): string {
  return (
    `RECUSADO (#8290): contexto de teste detectado (NODE_TEST_CONTEXT presente) — ` +
    `${detail} não pode rodar de dentro de um teste sem mock/injeção explícita. ` +
    `Injete o dep correspondente (ghRun/sendPush/sendFn), ou rode fora do test runner.`
  );
}
