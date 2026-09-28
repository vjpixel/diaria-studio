/**
 * test/_helpers/with-rate-state-lock.ts (#8904)
 *
 * `DEFAULT_RATE_STATE_PATH` (data/brevo-rate-state.json, `scripts/lib/
 * brevo-rate-state.ts`) é um arquivo REAL em disco, sem path injetável nos
 * consumidores de produção (`assertCampaignQuotaHeadroom()` dentro de
 * `main()` de `clarice-audit-overlap.ts`/`audit-wave-no-duplicate-sends.ts`,
 * e dentro de `renderClariceDashboardLiveUncached()` em
 * `dashboard-clarice.ts`) — ver a docstring de
 * test/brevo-client-quota-wiring-5697.test.ts pro racional de por que isso
 * é aceito (acoplar um path de teste na API pública do client seria pior).
 *
 * Vários arquivos de teste escrevem/leem esse MESMO arquivo real
 * (test/audit-wave-no-duplicate-sends-7880.test.ts,
 * test/brevo-client-quota-wiring-5697.test.ts,
 * test/brevo-dashboard-studio-kv-readonly-4206.test.ts,
 * test/clarice-audit-overlap-5697.test.ts,
 * test/clarice-backfill-campaigns-cli-8115.test.ts,
 * test/clarice-build-segment-write-path-ignores-quota-reserve-5697.test.ts).
 * Cada um já tem seu próprio beforeEach/afterEach limpando o arquivo — mas
 * isso só protege contra o PRÓPRIO arquivo rodar 2x seguidas, nunca contra
 * OUTRO arquivo de teste, rodando num processo CONCORRENTE (`node --test`
 * roda arquivos em paralelo, `scripts/run-tests.ts`), escrever/apagar o
 * MESMO arquivo real no meio da janela. Achado ao vivo em CI (#8904, PR
 * #8893): `test/audit-wave-no-duplicate-sends-7880.test.ts` grava
 * `remaining=5` no path real pra testar seu próprio guard de cota;
 * `test/brevo-dashboard-studio-kv-readonly-4206.test.ts` lê esse MESMO path
 * (via `assertCampaignQuotaHeadroom()`, sem saber de nada disso) e falhou 2x
 * intermitentemente porque via `remaining=5` (esperava cota alta o bastante
 * pra tentar a rede) — nunca reproduz localmente rodando 1 arquivo por vez,
 * só em CI com concorrência real entre processos.
 *
 * Fix: TODO arquivo de teste que toque `DEFAULT_RATE_STATE_PATH` adquire
 * este MESMO lock (arquivo `.test-lock`, mesmo mecanismo de
 * `scripts/lib/file-lock.ts` — cria via `wx`, atômico entre processos) num
 * `before()`/`after()` de ESCOPO DE ARQUIVO (nunca por-teste: um lock
 * por-teste ainda deixaria dois ARQUIVOS diferentes rodando tests distintos
 * ao mesmo tempo, sem coordenação entre si) — serializa qualquer combinação
 * desses 6 arquivos entre processos concorrentes, sem exigir mudança nos
 * consumidores de produção.
 */
import { acquireLock, releaseLock } from "../../scripts/lib/file-lock.ts";
import { DEFAULT_RATE_STATE_PATH } from "../../scripts/lib/brevo-rate-state.ts";

export const RATE_STATE_TEST_LOCK_PATH = `${DEFAULT_RATE_STATE_PATH}.test-lock`;

/** `before()` hook — chamar 1x no topo do arquivo de teste. */
export function acquireRateStateTestLock(): void {
  acquireLock(RATE_STATE_TEST_LOCK_PATH, 30_000);
}

/** `after()` hook — chamar 1x no topo do arquivo de teste. */
export function releaseRateStateTestLock(): void {
  releaseLock(RATE_STATE_TEST_LOCK_PATH);
}
