/**
 * test/onboarding-welcome-run-enabled.test.ts (#5957)
 *
 * Regressão: `platform.config.json` → `onboarding.enabled: false` era um
 * kill-switch morto — a interface `OnboardingConfig` declarava o campo, mas
 * `onboarding-welcome-run.ts` nunca o lia. Mesmo padrão de guard do
 * `data/clarice-novos-enabled.json` em `clarice-novos-run.ts`: checar
 * ANTES de qualquer chamada externa (Beehiiv/Brevo).
 *
 * Estratégia de teste (subprocesso real via `npx tsx`, não import direto de
 * `main()` — a função não é exportada e o script é pensado pra rodar como
 * CLI): removemos `BEEHIIV_API_KEY` do env do subprocesso, que é a PRIMEIRA
 * dependência externa que o script checa depois do guard (`resolveBeehiivConfig`).
 * Isso torna os dois casos distinguíveis sem qualquer chamada de rede real:
 *
 *   - `enabled: false`  → guard dispara ANTES do check de credencial. exit 0,
 *     mensagem de pausa no stdout, stderr vazio (nunca chegou no Beehiiv).
 *   - `enabled: true` (ou campo ausente) → guard não dispara, o script segue
 *     e esbarra no check de `BEEHIIV_API_KEY` ausente. exit 2, mensagem de
 *     credencial ausente no stderr — prova que o comportamento pré-#5957
 *     (script tenta seguir) continua intacto quando não pausado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runScript(configPath: string) {
  const env = { ...process.env };
  delete env.BEEHIIV_API_KEY;
  delete env.BEEHIIV_PUBLICATION_ID;
  return spawnSync(
    "npx",
    ["tsx", resolve(__ROOT, "scripts/onboarding-welcome-run.ts"), "--config", configPath],
    {
      cwd: __ROOT,
      encoding: "utf8",
      env,
      shell: process.platform === "win32",
    },
  );
}

describe("onboarding-welcome-run.ts — kill-switch platform.config.json onboarding.enabled", () => {
  it("enabled: false — sai cedo (exit 0), sem tentar nenhuma chamada externa", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-onboarding-enabled-false-"));
    try {
      const configPath = join(dir, "platform.config.json");
      writeFileSync(configPath, JSON.stringify({ onboarding: { enabled: false } }));

      const result = runScript(configPath);

      assert.equal(result.status, 0, `esperava exit 0, obteve ${result.status}. stderr: ${result.stderr}`);
      assert.ok(
        (result.stdout ?? "").includes("PAUSADA"),
        `stdout deveria anunciar pausa: ${result.stdout}`,
      );
      assert.equal(
        (result.stderr ?? "").includes("BEEHIIV_API_KEY"),
        false,
        "guard deve disparar ANTES do check de credencial Beehiiv — não deveria nem chegar lá",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enabled: true — comportamento inalterado, segue além do guard (esbarra no check de credencial)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-onboarding-enabled-true-"));
    try {
      const configPath = join(dir, "platform.config.json");
      writeFileSync(configPath, JSON.stringify({ onboarding: { enabled: true } }));

      const result = runScript(configPath);

      assert.equal(result.status, 2, `esperava exit 2 (credencial ausente), obteve ${result.status}. stdout: ${result.stdout}`);
      assert.ok(
        (result.stderr ?? "").includes("BEEHIIV_API_KEY"),
        `stderr deveria reclamar de credencial ausente (prova que passou do guard): ${result.stderr}`,
      );
      assert.equal(
        (result.stdout ?? "").includes("PAUSADA"),
        false,
        "não deveria imprimir mensagem de pausa quando enabled: true",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("campo enabled ausente — mesmo comportamento de enabled: true (default seguro, não pausa)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-onboarding-enabled-absent-"));
    try {
      const configPath = join(dir, "platform.config.json");
      writeFileSync(configPath, JSON.stringify({ onboarding: {} }));

      const result = runScript(configPath);

      assert.equal(result.status, 2, `esperava exit 2 (credencial ausente), obteve ${result.status}. stdout: ${result.stdout}`);
      assert.ok(
        (result.stderr ?? "").includes("BEEHIIV_API_KEY"),
        `stderr deveria reclamar de credencial ausente: ${result.stderr}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
