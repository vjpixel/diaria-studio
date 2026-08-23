/**
 * test/onboarding-welcome-run-enabled.test.ts (#5957, isolamento corrigido em #5966)
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
 *
 * #5966 — BUG CRÍTICO encontrado ao vivo em produção: `delete env.X` NÃO
 * isola de credencial real. `scripts/lib/env-loader.ts` → `loadProjectEnv()`
 * chama `dotenvConfig({ path: envFile, override: false })`, e `override: false`
 * só preserva vars JÁ PRESENTES — uma var DELETADA (ausente) é recarregada
 * normalmente do `.env` real do repo. Numa máquina com `.env` populado (setup
 * padrão do projeto), os 2 casos que "deletavam" `BEEHIIV_API_KEY` na
 * verdade rodavam o script COM credenciais reais, e — como nenhum caso
 * passava `--store` isolado — usando `data/onboarding/store.json` de
 * PRODUÇÃO real. Confirmado ao vivo: esse arquivo foi criado/mutado por essa
 * execução não-autorizada, e o script chegou a fazer uma chamada real à API
 * da Beehiiv.
 *
 * Fix (#5966), dois pilares:
 *   1. TODOS os casos passam `--store <tmp-path>` isolado (`mkdtempSync`) —
 *      nunca cai no `DEFAULT_STORE_PATH` real, com ou sem bug de dotenv.
 *   2. Em vez de `delete env.BEEHIIV_API_KEY`, setamos `env.BEEHIIV_API_KEY = ""`.
 *      Verificado empiricamente (ver comentário em `runScript`): `dotenvConfig`
 *      com `override: false` só recarrega vars AUSENTES — uma var setada pra
 *      string vazia permanece vazia, o reload nunca a sobrescreve. Isso
 *      bloqueia o reload mesmo numa máquina com `.env` populado.
 *
 * O 4º caso ("regressão do próprio bug") prova a técnica de string vazia
 * contra um `.env` fixture LOCAL (isolado em tmpdir, nunca o `.env` real do
 * repo) contendo uma credencial fake — simula fielmente a condição do bug
 * (dotenv reload de arquivo populado) sem qualquer risco ao `.env` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Roda o script num subprocesso, sempre com `--store` isolado (nunca toca
 * `data/onboarding/store.json` real).
 *
 * `beehiivApiKeyOverride: ""` simula "credencial ausente" de forma que
 * sobrevive ao reload do `.env` real via `loadProjectEnv()`
 * (`override: false` só preenche vars AUSENTES do `process.env` — uma var
 * já presente, mesmo vazia, nunca é sobrescrita; verificado empiricamente
 * contra o comportamento real de `dotenv` antes deste fix, não assumido).
 * `delete env.X`, ao contrário, NÃO isola: torna a var ausente, e
 * `override: false` recarrega ausentes a partir do `.env` real do repo —
 * era exatamente esse o bug do #5966.
 *
 * `envFileCwd`, quando passado, roda o subprocesso com esse diretório como
 * cwd — usado só pelo caso de regressão explícita, que aponta pra um
 * `.env` FIXTURE local (nunca o `.env` real do repo).
 */
function runScript(
  configPath: string,
  storePath: string,
  opts: { beehiivApiKeyOverride?: string; cwdOverride?: string } = {},
) {
  const env = { ...process.env };
  if (opts.beehiivApiKeyOverride !== undefined) {
    env.BEEHIIV_API_KEY = opts.beehiivApiKeyOverride;
  }
  if (opts.beehiivApiKeyOverride !== undefined) {
    env.BEEHIIV_PUBLICATION_ID = opts.beehiivApiKeyOverride;
  }
  return spawnSync(
    "npx",
    [
      "tsx",
      resolve(__ROOT, "scripts/onboarding-welcome-run.ts"),
      "--config",
      configPath,
      "--store",
      storePath,
    ],
    {
      cwd: opts.cwdOverride ?? __ROOT,
      encoding: "utf8",
      env,
      shell: process.platform === "win32",
    },
  );
}

/** Path do store real de produção — nunca deve ser tocado por este arquivo. */
const REAL_STORE_PATH = resolve(__ROOT, "data/onboarding/store.json");

describe("onboarding-welcome-run.ts — kill-switch platform.config.json onboarding.enabled", () => {
  it("enabled: false — sai cedo (exit 0), sem tentar nenhuma chamada externa, store isolado", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-onboarding-enabled-false-"));
    try {
      const configPath = join(dir, "platform.config.json");
      const storePath = join(dir, "store.json");
      writeFileSync(configPath, JSON.stringify({ onboarding: { enabled: false } }));

      const result = runScript(configPath, storePath);

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
      assert.equal(existsSync(REAL_STORE_PATH), false, "store real de produção não deve ser tocado");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enabled: true, credencial vazia — comportamento inalterado, segue além do guard (esbarra no check de credencial), store isolado", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-onboarding-enabled-true-"));
    try {
      const configPath = join(dir, "platform.config.json");
      const storePath = join(dir, "store.json");
      writeFileSync(configPath, JSON.stringify({ onboarding: { enabled: true } }));

      const result = runScript(configPath, storePath, { beehiivApiKeyOverride: "" });

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
      assert.equal(existsSync(REAL_STORE_PATH), false, "store real de produção não deve ser tocado");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("campo enabled ausente, credencial vazia — mesmo comportamento de enabled: true (default seguro, não pausa), store isolado", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-onboarding-enabled-absent-"));
    try {
      const configPath = join(dir, "platform.config.json");
      const storePath = join(dir, "store.json");
      writeFileSync(configPath, JSON.stringify({ onboarding: {} }));

      const result = runScript(configPath, storePath, { beehiivApiKeyOverride: "" });

      assert.equal(result.status, 2, `esperava exit 2 (credencial ausente), obteve ${result.status}. stdout: ${result.stdout}`);
      assert.ok(
        (result.stderr ?? "").includes("BEEHIIV_API_KEY"),
        `stderr deveria reclamar de credencial ausente: ${result.stderr}`,
      );
      assert.equal(existsSync(REAL_STORE_PATH), false, "store real de produção não deve ser tocado");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#5966 regressão — mesmo com .env FIXTURE populado (credencial fake) no cwd, string vazia bloqueia o reload e o guard/isolamento seguram", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-onboarding-5966-regression-"));
    try {
      const configPath = join(dir, "platform.config.json");
      const storePath = join(dir, "store.json");
      writeFileSync(configPath, JSON.stringify({ onboarding: { enabled: true } }));

      // .env FIXTURE local — nunca o .env real do repo. Simula a condição
      // exata do bug (loadProjectEnv encontra um .env populado no cwd) sem
      // qualquer risco de usar credencial real.
      writeFileSync(
        join(dir, ".env"),
        "BEEHIIV_API_KEY=fixture_fake_key_do_not_use\nBEEHIIV_PUBLICATION_ID=fixture_fake_pub\n",
      );

      const result = runScript(configPath, storePath, {
        beehiivApiKeyOverride: "",
        cwdOverride: dir,
      });

      // Se o bug do #5966 tivesse voltado (delete em vez de string vazia,
      // ou --store não isolado), este caso teria BEEHIIV_API_KEY recarregado
      // do .env fixture e tentaria uma chamada de rede real (não exit 2 por
      // credencial ausente). A string vazia prova que o reload não ocorre.
      assert.equal(
        result.status,
        2,
        `esperava exit 2 (credencial ausente, PROVANDO que o .env fixture não vazou) — obteve ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`,
      );
      assert.ok(
        (result.stderr ?? "").includes("BEEHIIV_API_KEY"),
        `stderr deveria reclamar de credencial ausente, nunca tentar a chamada real: ${result.stderr}`,
      );
      assert.equal(existsSync(REAL_STORE_PATH), false, "store real de produção não deve ser tocado");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
