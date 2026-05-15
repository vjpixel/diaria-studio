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
    // #999: Image cache populado pra evitar abort do fail-fast novo.
    writeFileSync(
      resolve(editionDir, "06-public-images.json"),
      JSON.stringify({
        images: {
          d1: { url: "https://example.com/d1.jpg" },
          d2: { url: "https://example.com/d2.jpg" },
          d3: { url: "https://example.com/d3.jpg" },
        },
      }),
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

describe("#999 publish-linkedin.ts fail-fast quando 06-public-images.json ausente em --schedule", () => {
  function runCli(args: string[], extraEnv: Record<string, string> = {}) {
    const projectRoot = resolve(import.meta.dirname, "..");
    const scriptPath = resolve(projectRoot, "scripts", "publish-linkedin.ts");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MAKE_LINKEDIN_WEBHOOK_URL: "https://hook.example.com/test",
      DIARIA_LINKEDIN_CRON_URL: "https://test.workers.dev",
      DIARIA_LINKEDIN_CRON_TOKEN: "test-token",
      ...extraEnv,
    };
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, ...args],
      { cwd: projectRoot, encoding: "utf8", env },
    );
    return {
      exitCode: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  it("aborta com exit 2 quando 06-public-images.json não existe + --schedule", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "no-img-cache-"));
    const editionDir = resolve(tmp, "260999");
    mkdirSync(editionDir, { recursive: true });
    writeFileSync(
      resolve(editionDir, "03-social.md"),
      "# LinkedIn\n\n## d1\nLI d1.\n\n## d2\nLI d2.\n\n## d3\nLI d3.\n",
    );

    const result = runCli(["--edition-dir", editionDir, "--schedule"]);
    rmSync(tmp, { recursive: true, force: true });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /06-public-images\.json não tem URL pra destaque/);
    assert.match(result.stderr, /upload-images-public\.ts/);
  });

  it("aborta com exit 2 quando 06-public-images.json existe mas está faltando d2 url", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "partial-img-cache-"));
    const editionDir = resolve(tmp, "260999");
    mkdirSync(editionDir, { recursive: true });
    writeFileSync(
      resolve(editionDir, "03-social.md"),
      "# LinkedIn\n\n## d1\nLI d1.\n\n## d2\nLI d2.\n\n## d3\nLI d3.\n",
    );
    writeFileSync(
      resolve(editionDir, "06-public-images.json"),
      JSON.stringify({
        images: {
          d1: { url: "https://example.com/d1.jpg" },
          d3: { url: "https://example.com/d3.jpg" },
        },
      }),
    );

    const result = runCli(["--edition-dir", editionDir, "--schedule"]);
    rmSync(tmp, { recursive: true, force: true });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /06-public-images\.json não tem URL pra destaque/);
    assert.match(result.stderr, /d2/);
  });

  // #1275: fail-fast roda SEMPRE (inclusive --fire-now). Antes do #1275, --fire-now
  // bypassava o check com a justificativa de "safety net pra post sem imagem".
  // Na prática gerou 12 comments na DLQ em 260513+260514 — safety net pior que abort.
  it("ABORTA também com --fire-now quando imagens missing (#1275 — antes bypassava)", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "fire-now-no-img-"));
    const editionDir = resolve(tmp, "260999");
    mkdirSync(editionDir, { recursive: true });
    writeFileSync(
      resolve(editionDir, "03-social.md"),
      "# LinkedIn\n\n## d1\nLI d1.\n\n## d2\nLI d2.\n\n## d3\nLI d3.\n",
    );

    const result = runCli(["--edition-dir", editionDir, "--fire-now"]);
    rmSync(tmp, { recursive: true, force: true });
    assert.equal(result.exitCode, 2, "fail-fast deveria disparar em --fire-now (#1275)");
    assert.match(result.stderr, /#1275 fail-fast|06-public-images\.json não tem URL/);
  });

  // #1275: cenário do incidente real — cache só com keys de newsletter mode (cover/eia)
  // sem keys de social mode (d1/d2/d3). Fail-fast deve disparar mesmo cache existindo.
  it("ABORTA com cache só de newsletter mode (cover/eia, sem d1/d2/d3) — repro #1275", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "newsletter-only-cache-"));
    const editionDir = resolve(tmp, "260999");
    mkdirSync(editionDir, { recursive: true });
    writeFileSync(
      resolve(editionDir, "03-social.md"),
      "# LinkedIn\n\n## d1\nLI d1.\n\n## d2\nLI d2.\n\n## d3\nLI d3.\n",
    );
    // Cache estado real do bug — só keys de newsletter mode
    writeFileSync(
      resolve(editionDir, "06-public-images.json"),
      JSON.stringify({
        images: {
          cover: { url: "https://example.com/cover.jpg" },
          eia_a: { url: "https://example.com/eia_a.jpg" },
          eia_b: { url: "https://example.com/eia_b.jpg" },
        },
      }),
    );

    const result = runCli(["--edition-dir", editionDir, "--schedule"]);
    rmSync(tmp, { recursive: true, force: true });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /d1|d2|d3/);
    // Mensagem deve mencionar as keys presentes (audit visível)
    assert.match(result.stderr, /Keys presentes.*cover.*eia/);
  });

  it("default = agendar (#1101) — SEM --fire-now, schedule aplicado, fail-fast dispara sem imagens", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "default-schedule-"));
    const editionDir = resolve(tmp, "260999");
    mkdirSync(editionDir, { recursive: true });
    writeFileSync(
      resolve(editionDir, "03-social.md"),
      "# LinkedIn\n\n## d1\nLI d1.\n\n## d2\nLI d2.\n\n## d3\nLI d3.\n",
    );
    // Default = agendar (sem --fire-now) → mesmo path do --schedule legado.
    // Sem 06-public-images.json: fail-fast dispara (incident #999 protection).
    const result = runCli(["--edition-dir", editionDir]);
    rmSync(tmp, { recursive: true, force: true });
    // Esperamos exit code != 0 (fail-fast por 06-public-images ausente, ou env vars worker)
    assert.notEqual(result.exitCode, 0, `default deveria agendar e fail-fast, mas exit code = 0. stderr=${result.stderr.slice(0, 300)}`);
  });
});

// #1310 — comments são manuais por default. Make não suporta CreateComment,
// e enfileirar items com action:"comment" gera DLQ + spam de email no editor.
describe("#1310 publish-linkedin.ts — comments skipped por default", () => {
  function runCli(args: string[], extraEnv: Record<string, string> = {}) {
    const projectRoot = resolve(import.meta.dirname, "..");
    const scriptPath = resolve(projectRoot, "scripts", "publish-linkedin.ts");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MAKE_LINKEDIN_WEBHOOK_URL: "https://hook.example.com/test",
      DIARIA_LINKEDIN_CRON_URL: "https://test.workers.dev",
      DIARIA_LINKEDIN_CRON_TOKEN: "test-token",
      ...extraEnv,
    };
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, ...args],
      { cwd: projectRoot, encoding: "utf8", env },
    );
    return {
      exitCode: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  function setupEditionDir(): { tmp: string; editionDir: string } {
    const tmp = mkdtempSync(resolve(tmpdir(), "comments-default-"));
    const editionDir = resolve(tmp, "261201");
    mkdirSync(editionDir, { recursive: true });
    writeFileSync(
      resolve(editionDir, "03-social.md"),
      "# LinkedIn\n\n## d1\nLI d1.\n\n### comment_diaria\nCD d1.\n\n### comment_pixel\nCP d1.\n\n## d2\nLI d2.\n\n### comment_diaria\nCD d2.\n\n### comment_pixel\nCP d2.\n\n## d3\nLI d3.\n\n### comment_diaria\nCD d3.\n\n### comment_pixel\nCP d3.\n",
    );
    writeFileSync(
      resolve(editionDir, "06-public-images.json"),
      JSON.stringify({
        images: {
          d1: { url: "https://example.com/d1.jpg" },
          d2: { url: "https://example.com/d2.jpg" },
          d3: { url: "https://example.com/d3.jpg" },
        },
      }),
    );
    return { tmp, editionDir };
  }

  it("default (sem flag): comments d1/d2/d3 são pulados — só mains enfileirados", () => {
    const { tmp, editionDir } = setupEditionDir();
    const result = runCli(["--edition-dir", editionDir, "--only", "d1"]);
    rmSync(tmp, { recursive: true, force: true });
    // Não deve enqueueing comments
    assert.match(
      result.stdout,
      /linkedin\/d1: comments pulados/,
      "default deveria pular comments, stdout=" + result.stdout.slice(0, 400),
    );
  });

  it("legacy --no-comments emite warn mas mantém comments skipped (back-compat)", () => {
    const { tmp, editionDir } = setupEditionDir();
    const result = runCli([
      "--edition-dir", editionDir, "--only", "d1", "--no-comments",
    ]);
    rmSync(tmp, { recursive: true, force: true });
    assert.match(
      result.stderr,
      /--no-comments é no-op em #1310/,
      "warn deveria aparecer no stderr, stderr=" + result.stderr.slice(0, 400),
    );
    assert.match(result.stdout, /linkedin\/d1: comments pulados/);
  });

  it("--with-comments força enqueue de comments (opt-in raro)", () => {
    const { tmp, editionDir } = setupEditionDir();
    const result = runCli([
      "--edition-dir", editionDir, "--only", "d1", "--with-comments",
    ]);
    rmSync(tmp, { recursive: true, force: true });
    // Com flag explícito, NÃO deve aparecer "comments pulados"
    assert.doesNotMatch(
      result.stdout,
      /linkedin\/d1: comments pulados/,
      "--with-comments NÃO deveria pular comments, stdout=" + result.stdout.slice(0, 400),
    );
  });
});
