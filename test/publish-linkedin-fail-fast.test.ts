/**
 * Tests for #923 — publish-linkedin.ts aborts when --schedule passed without
 * Cloudflare Worker config (fail-fast vs silent fire-now).
 *
 * Reproduz o cenário 2026-05-07: rodar `--schedule` sem Worker configurado
 * fazia fallback silencioso pra Make.com (postava IMEDIATAMENTE em vez de
 * agendar). Agora aborta com exit 2 + mensagem clara.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { NPX, isWindows } from "./_helpers/spawn-npx.ts";

function runCli(args: string[], env: Record<string, string | undefined>): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  // Limpar env vars de Worker pra simular .env.local não carregado.
  const cleanEnv = { ...process.env, ...env };
  const result = spawnSync(
    NPX,
    ["tsx", "scripts/publish-linkedin.ts", ...args],
    { encoding: "utf8", stdio: "pipe", shell: isWindows, env: cleanEnv },
  );
  if (result.error) throw result.error;
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

describe("#923 publish-linkedin.ts fail-fast em --schedule sem Worker", () => {
  it("aborta com exit 2 quando --schedule passado mas DIARIA_LINKEDIN_CRON_TOKEN ausente", () => {
    // Setup: edição minimal com 03-social.md
    const tmp = mkdtempSync(resolve(tmpdir(), "publish-linkedin-fail-fast-"));
    const editionDir = resolve(tmp, "260999");
    mkdirSync(editionDir, { recursive: true });
    writeFileSync(
      resolve(editionDir, "03-social.md"),
      "# Facebook\n\n## d1\nFB d1.\n\n## d2\nFB d2.\n\n## d3\nFB d3.\n\n# LinkedIn\n\n## d1\nLI d1.\n\n## d2\nLI d2.\n\n## d3\nLI d3.\n",
    );

    const result = runCli(
      ["--edition-dir", editionDir, "--schedule"],
      {
        // Webhook URL presente (caso contrário script aborta antes do fail-fast)
        MAKE_LINKEDIN_WEBHOOK_URL: "https://hook.example.com/test",
        // Worker URL + token AUSENTES — simula .env.local não carregado
        DIARIA_LINKEDIN_CRON_URL: "",
        DIARIA_LINKEDIN_CRON_TOKEN: "",
      },
    );

    rmSync(tmp, { recursive: true, force: true });

    assert.equal(result.exitCode, 2, `esperava exit 2, recebeu ${result.exitCode}. stderr=${result.stderr}`);
    assert.match(result.stderr, /--schedule passado mas Cloudflare Worker não está configurado/);
    assert.match(result.stderr, /MISSING/);
    assert.match(result.stderr, /\.env\.local não carregada/);
  });

  it("NÃO aborta quando --schedule + Worker configurado (caminho feliz alcançável)", () => {
    // Não vamos rodar até o final (faltaria network), mas confirma que o
    // fail-fast bloco específico do #923 não dispara.
    const tmp = mkdtempSync(resolve(tmpdir(), "publish-linkedin-fail-fast-2-"));
    const editionDir = resolve(tmp, "260998");
    mkdirSync(editionDir, { recursive: true });
    writeFileSync(
      resolve(editionDir, "03-social.md"),
      "# Facebook\n\n## d1\nFB d1.\n\n## d2\nFB d2.\n\n## d3\nFB d3.\n\n# LinkedIn\n\n## d1\nLI d1.\n\n## d2\nLI d2.\n\n## d3\nLI d3.\n",
    );

    const result = runCli(
      ["--edition-dir", editionDir, "--schedule"],
      {
        MAKE_LINKEDIN_WEBHOOK_URL: "https://hook.example.com/test",
        DIARIA_LINKEDIN_CRON_URL: "https://nonexistent.workers.dev",
        DIARIA_LINKEDIN_CRON_TOKEN: "fake-token-for-test",
      },
    );

    rmSync(tmp, { recursive: true, force: true });

    // Exit code não deve ser 2 (que é especifico do fail-fast). Pode ser 0,
    // 1 (network errors → entries failed mas script termina OK), ou similar.
    assert.notEqual(result.exitCode, 2, `não deveria abortar com exit 2. stderr=${result.stderr}`);
    // E a mensagem específica não deve aparecer
    assert.doesNotMatch(result.stderr, /--schedule passado mas Cloudflare Worker não está configurado/);
  });
});
