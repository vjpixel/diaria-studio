/**
 * test/onboarding-kit-transport-enabled-7922.test.ts (#7922, fleet review PR #8136)
 *
 * Regressão dedicada do kill switch `onboarding.kit_transport.enabled` em
 * `scripts/onboarding-kit-transport-run.ts` — mesmo racional e mesma
 * estratégia de `test/onboarding-welcome-run-enabled.test.ts` (#5957/#5966):
 * este projeto JÁ enviou uma vez um kill switch que a interface declarava
 * mas o script nunca lia de fato (#5957). O guard AQUI (linha
 * `if (writeRequested && kitTransportCfg.enabled !== true)`) foi lido e
 * confirmado correto por inspeção manual durante o review do #8136 — mas
 * nenhum teste provava isso antes deste arquivo (achado do
 * pr-test-analyzer, fleet review PR #8137→#8136, severidade P1/8).
 *
 * Subprocesso real via `npx tsx` (script não exporta `main()`, é pensado
 * pra rodar como CLI) — nunca import direto. `--store`/`--config` sempre
 * isolados em tmpdir; nunca o `data/onboarding/store.json` real.
 *
 * Distinção sem qualquer chamada de rede real: `KIT_API_KEY` fake (fixture,
 * nunca usada — o guard do kill switch dispara ANTES de qualquer chamada ao
 * Kit) + `publishing.newsletter.subscriber_backend: "kit"` (senão o script
 * aborta antes mesmo de chegar no kill switch, por backend errado — ver
 * `resolveNewsletterSubscriberBackend`).
 *
 *   - `kit_transport.enabled: false` (ou ausente) + `--send` → guard dispara,
 *     exit 2, stderr cita "kill switch dedicado", store isolado nunca criado
 *     com lotes (nenhuma escrita).
 *   - `kit_transport.enabled: true` + `--send`, store SEM candidatos
 *     elegíveis → guard NÃO dispara (stderr não cita "kill switch"), script
 *     segue até o fim do plano vazio, exit 0 — prova que `enabled: true`
 *     de fato desarma o guard, sem precisar mockar a API do Kit inteira.
 *   - `--reconcile` (leitura, não escrita) com `enabled: false` → NUNCA passa
 *     pelo guard (o código só checa `writeRequested`), mas com store vazio
 *     não há lote a reconciliar — exit 0, sem menção ao kill switch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_STORE_PATH = resolve(__ROOT, "data/onboarding/store.json");

/** Mesma técnica de `onboarding-welcome-run-enabled.test.ts` (#6206) —
 * compara conteúdo antes/depois em vez de só existência, pra pegar
 * escrita+restauração e funcionar igual em CI (sem `data/`) e na máquina
 * do editor (`data/` é junction OneDrive com store real). */
function fingerprintRealStore(): string | null {
  if (!existsSync(REAL_STORE_PATH)) return null;
  const { size } = statSync(REAL_STORE_PATH);
  const hash = createHash("sha256").update(readFileSync(REAL_STORE_PATH)).digest("hex");
  return `${size}:${hash}`;
}

let realStoreBaseline: string | null | undefined;

function assertRealStoreUntouched(): void {
  if (realStoreBaseline === undefined) realStoreBaseline = fingerprintRealStore();
  assert.equal(fingerprintRealStore(), realStoreBaseline, "store real de produção não deve ser tocado");
}

function runScript(configPath: string, storePath: string, extraArgs: string[] = []) {
  const env = { ...process.env, KIT_API_KEY: "fixture_fake_kit_key_do_not_use" };
  const args = [
    "tsx",
    resolve(__ROOT, "scripts/onboarding-kit-transport-run.ts"),
    "--config",
    configPath,
    "--store",
    storePath,
    ...extraArgs,
  ];
  if (realStoreBaseline === undefined) realStoreBaseline = fingerprintRealStore();
  return spawnSync("npx", args, {
    cwd: __ROOT,
    encoding: "utf8",
    env,
    shell: process.platform === "win32",
  });
}

function writeIsolatedConfig(dir: string, kitTransportEnabled: boolean | undefined): string {
  const configPath = join(dir, "platform.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      publishing: { newsletter: { subscriber_backend: "kit" } },
      onboarding: kitTransportEnabled === undefined ? {} : { kit_transport: { enabled: kitTransportEnabled } },
    }),
  );
  return configPath;
}

describe("onboarding-kit-transport-run.ts — kill-switch platform.config.json onboarding.kit_transport.enabled (#7922)", () => {
  it("enabled: false + --send → guard dispara, exit 2, nunca chega em nenhuma chamada ao Kit", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-kit-transport-enabled-false-"));
    try {
      const configPath = writeIsolatedConfig(dir, false);
      const storePath = join(dir, "store.json");

      const result = runScript(configPath, storePath, ["--send"]);

      assert.equal(result.status, 2, `esperava exit 2, obteve ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`);
      assert.ok(
        (result.stderr ?? "").includes("kill switch dedicado"),
        `stderr deveria citar o kill switch dedicado: ${result.stderr}`,
      );
      assertRealStoreUntouched();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("campo kit_transport ausente (default) + --send → mesmo comportamento de enabled: false — default é SEGURO (nunca escreve por omissão)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-kit-transport-enabled-absent-"));
    try {
      const configPath = writeIsolatedConfig(dir, undefined);
      const storePath = join(dir, "store.json");

      const result = runScript(configPath, storePath, ["--send"]);

      assert.equal(result.status, 2, `esperava exit 2 (default seguro), obteve ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`);
      assert.ok(
        (result.stderr ?? "").includes("kill switch dedicado"),
        `stderr deveria citar o kill switch dedicado mesmo com o campo ausente: ${result.stderr}`,
      );
      assertRealStoreUntouched();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enabled: true + --send, store sem candidatos elegíveis → guard NÃO dispara, script conclui exit 0 sem citar o kill switch", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-kit-transport-enabled-true-"));
    try {
      const configPath = writeIsolatedConfig(dir, true);
      const storePath = join(dir, "store.json");
      // Store vazio (nunca criado) — sem lotes vencidos, o script conclui
      // o plano sem precisar de nenhuma chamada real ao Kit além da leitura
      // de config (KIT_API_KEY é só validada como presente, nunca chamada).
      writeFileSync(storePath, JSON.stringify({ subscribers: {}, kit_transport: { lots: {} } }));

      const result = runScript(configPath, storePath, ["--send"]);

      assert.equal(result.status, 0, `esperava exit 0 (store vazio, nada a enviar), obteve ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`);
      assert.equal(
        (result.stderr ?? "").includes("kill switch dedicado"),
        false,
        `enabled: true não deveria disparar o guard: ${result.stderr}`,
      );
      assertRealStoreUntouched();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--reconcile (leitura) com enabled: false, store vazio → nunca depende do kill switch (writeRequested é false), exit 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-kit-transport-reconcile-"));
    try {
      const configPath = writeIsolatedConfig(dir, false);
      const storePath = join(dir, "store.json");
      writeFileSync(storePath, JSON.stringify({ subscribers: {}, kit_transport: { lots: {} } }));

      const result = runScript(configPath, storePath, ["--reconcile"]);

      assert.equal(result.status, 0, `esperava exit 0, obteve ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`);
      assert.equal(
        (result.stderr ?? "").includes("kill switch dedicado"),
        false,
        `--reconcile é leitura, nunca deveria bater no guard de escrita: ${result.stderr}`,
      );
      assertRealStoreUntouched();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backend != kit aborta ANTES do kill switch — mensagem de backend, não de kill switch", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-kit-transport-wrong-backend-"));
    try {
      const configPath = join(dir, "platform.config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          publishing: { newsletter: { subscriber_backend: "beehiiv" } },
          onboarding: { kit_transport: { enabled: true } },
        }),
      );
      const storePath = join(dir, "store.json");

      const result = runScript(configPath, storePath, ["--send"]);

      assert.equal(result.status, 2, `esperava exit 2 (backend errado), obteve ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`);
      assert.ok(
        (result.stderr ?? "").includes('não "kit"'),
        `stderr deveria reclamar do backend, não do kill switch: ${result.stderr}`,
      );
      assertRealStoreUntouched();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
