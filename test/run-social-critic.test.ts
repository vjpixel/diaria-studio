/**
 * test/run-social-critic.test.ts (#4505 item 3)
 *
 * Testes unitários para scripts/run-social-critic.ts — o wiring
 * determinístico ao redor do subagente OPCIONAL `social-critic`.
 *
 * O julgamento em si ("isso ainda soa de IA?") é feito por um subagente LLM
 * — não unit-testável aqui (precisaria do Agent tool, #207 impede dispatch
 * de dentro de um subagente overnight). O que É testável e vive aqui:
 *
 *  (a) readSocialCriticConfig / isSocialCriticEnabled: leitura fail-soft do
 *      flag opt-in em platform.config.json.
 *  (b) normalizeSocialCriticResult: valida/normaliza o output do subagente.
 *  (c) formatGateSummary: formata a seção do gate (sempre warning-only).
 *  (d) CLI (modo descoberta + modo --input-json): wiring determinístico,
 *      exit codes, persistência do JSON.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import {
  readSocialCriticConfig,
  isSocialCriticEnabled,
  normalizeSocialCriticResult,
  formatGateSummary,
  type SocialCriticResult,
} from "../scripts/run-social-critic.ts";

function runCli(editionDir: string, extraArgs: string[] = []) {
  const projectRoot = join(import.meta.dirname, "..");
  const scriptPath = join(projectRoot, "scripts", "run-social-critic.ts");
  return spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, "--edition-dir", editionDir, ...extraArgs],
    { cwd: projectRoot, encoding: "utf8" },
  );
}

function makeTmpEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "social-critic-test-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

function writeConfig(dir: string, config: unknown): string {
  const path = join(dir, "platform.config.json");
  writeFileSync(path, JSON.stringify(config), "utf8");
  return path;
}

// ---------------------------------------------------------------------------
// readSocialCriticConfig / isSocialCriticEnabled — fail-soft por design
// ---------------------------------------------------------------------------

describe("readSocialCriticConfig / isSocialCriticEnabled (#4505 item 3)", () => {
  it("enabled: true → habilitado", () => {
    const dir = mkdtempSync(join(tmpdir(), "social-critic-cfg-"));
    try {
      const path = writeConfig(dir, { social_critic_pass: { enabled: true } });
      assert.equal(isSocialCriticEnabled(path), true);
      assert.deepEqual(readSocialCriticConfig(path), { enabled: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enabled: false → desabilitado", () => {
    const dir = mkdtempSync(join(tmpdir(), "social-critic-cfg-"));
    try {
      const path = writeConfig(dir, { social_critic_pass: { enabled: false } });
      assert.equal(isSocialCriticEnabled(path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chave social_critic_pass ausente → desabilitado (default seguro)", () => {
    const dir = mkdtempSync(join(tmpdir(), "social-critic-cfg-"));
    try {
      const path = writeConfig(dir, { newsletter: "beehiiv" });
      assert.equal(isSocialCriticEnabled(path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arquivo de config ausente → desabilitado (fail-soft, nunca lança)", () => {
    assert.equal(isSocialCriticEnabled(join(tmpdir(), "nao-existe-" + Date.now(), "platform.config.json")), false);
  });

  it("JSON malformado → desabilitado (fail-soft, nunca lança)", () => {
    const dir = mkdtempSync(join(tmpdir(), "social-critic-cfg-"));
    try {
      const path = join(dir, "platform.config.json");
      writeFileSync(path, "{ not valid json", "utf8");
      assert.equal(isSocialCriticEnabled(path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enabled ausente dentro de social_critic_pass → desabilitado (não trata undefined como true)", () => {
    const dir = mkdtempSync(join(tmpdir(), "social-critic-cfg-"));
    try {
      const path = writeConfig(dir, { social_critic_pass: {} });
      assert.equal(isSocialCriticEnabled(path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeSocialCriticResult
// ---------------------------------------------------------------------------

describe("normalizeSocialCriticResult (#4505 item 3)", () => {
  it("normaliza output bem-formado com findings", () => {
    const raw = {
      checked_at: "2026-08-03T10:00:00.000Z",
      findings: [
        { section: "d1", trecho: "não é sorte: é estratégia", motivo: "antítese-revelação via dois-pontos" },
      ],
    };
    const result = normalizeSocialCriticResult(raw, "260803");
    assert.equal(result.edition, "260803");
    assert.equal(result.sounds_ai, true);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].section, "d1");
  });

  it("findings vazio → sounds_ai false", () => {
    const result = normalizeSocialCriticResult({ findings: [] }, "260803");
    assert.equal(result.sounds_ai, false);
    assert.deepEqual(result.findings, []);
  });

  it("deriva sounds_ai de findings.length, ignora um sounds_ai inconsistente do subagente", () => {
    // Subagente mandou sounds_ai:false mas com findings presentes — o script
    // nunca confia nesse campo, sempre recalcula (mesmo racional de
    // normalizeCropReviewResult recalcular summary a partir de results, #3951).
    const raw = {
      sounds_ai: false,
      findings: [{ section: "post_pixel", trecho: "x", motivo: "y" }],
    };
    const result = normalizeSocialCriticResult(raw, "260803");
    assert.equal(result.sounds_ai, true, "sounds_ai deve ser derivado de findings.length, não copiado do raw");
  });

  it("filtra findings inválidos (campos faltando ou tipo errado) e avisa via console.warn (self-review #4505)", () => {
    // Failure scenario coberto: se o filtro de schema descartar itens
    // malformados SEM avisar, um caso em que TODOS os findings vierem
    // malformados faria sounds_ai=false silenciosamente (a própria rede de
    // segurança do critic pass falhando calada) — o warn é o que torna
    // essa perda auditável em vez de invisível.
    const warnings: string[] = [];
    mock.method(console, "warn", (...args: unknown[]) => warnings.push(String(args[0])));

    const raw = {
      findings: [
        { section: "d1", trecho: "x", motivo: "y" },
        { section: "d2", trecho: "x" }, // motivo ausente
        { section: 123, trecho: "x", motivo: "y" }, // section não é string
        null,
      ],
    };
    const result = normalizeSocialCriticResult(raw, "260803");
    assert.equal(result.findings.length, 1, "deve filtrar findings inválidos");
    assert.equal(result.findings[0].section, "d1");
    assert.ok(
      warnings.some((w) => w.includes("3 finding(s) descartado")),
      `deve avisar quantos findings foram descartados por schema inválido; avisos: ${JSON.stringify(warnings)}`,
    );
  });

  it("não avisa quando todos os findings são válidos", () => {
    const warnings: string[] = [];
    mock.method(console, "warn", (...args: unknown[]) => warnings.push(String(args[0])));

    normalizeSocialCriticResult(
      { findings: [{ section: "d1", trecho: "x", motivo: "y" }] },
      "260803",
    );
    assert.equal(warnings.length, 0, "não deve avisar quando nenhum finding foi descartado");
  });

  it("lança erro se raw não é objeto", () => {
    assert.throws(() => normalizeSocialCriticResult(null, "260803"), /não é um objeto JSON/);
    assert.throws(() => normalizeSocialCriticResult("string", "260803"), /não é um objeto JSON/);
  });

  it("checked_at ausente → usa timestamp atual (ISO válido)", () => {
    const result = normalizeSocialCriticResult({ findings: [] }, "260803");
    assert.ok(!Number.isNaN(Date.parse(result.checked_at)));
  });
});

// ---------------------------------------------------------------------------
// formatGateSummary — sempre warning-only
// ---------------------------------------------------------------------------

const EMPTY_RESULT: SocialCriticResult = {
  edition: "260803",
  checked_at: "2026-08-03T10:00:00Z",
  sounds_ai: false,
  findings: [],
};

describe("formatGateSummary (#4505 item 3)", () => {
  it("sem findings → mensagem positiva, sem ⚠️", () => {
    const s = formatGateSummary(EMPTY_RESULT);
    assert.ok(s.includes("CRITIC PASS SOCIAL"));
    assert.ok(s.includes("✅"));
    assert.ok(!s.includes("⚠️"));
  });

  it("com findings → ⚠️ + seção + trecho + motivo, sempre warning-only", () => {
    const result: SocialCriticResult = {
      ...EMPTY_RESULT,
      sounds_ai: true,
      findings: [
        { section: "d1", trecho: "não é sorte: é estratégia", motivo: "antítese-revelação via dois-pontos" },
      ],
    };
    const s = formatGateSummary(result);
    assert.ok(s.includes("⚠️"));
    assert.ok(s.includes("[d1]"));
    assert.ok(s.includes("não é sorte: é estratégia"));
    assert.ok(s.includes("antítese-revelação via dois-pontos"));
    // "nunca bloqueia" é reassurance LEGÍTIMA (warning-only) — o que não pode
    // aparecer é linguagem que TRATE isso como impedimento de fato (GATE-BLOCKING,
    // abortar a edição, "não pode publicar").
    assert.ok(
      !/gate-blocking|abortar a edi[çc][aã]o|n[aã]o pode publicar/i.test(s),
      `não deve conter linguagem de bloqueio de fato: ${s}`,
    );
    assert.ok(/nunca bloqueia/i.test(s), "deve reassegurar explicitamente que é warning-only");
    assert.ok(s.includes("Decisão final"), "deve remeter a decisão final ao editor");
  });

  it("mostra 1 linha por finding, mesmo com múltiplas seções", () => {
    const result: SocialCriticResult = {
      ...EMPTY_RESULT,
      sounds_ai: true,
      findings: [
        { section: "d1", trecho: "trecho 1", motivo: "motivo 1" },
        { section: "post_pixel", trecho: "trecho 2", motivo: "motivo 2" },
      ],
    };
    const s = formatGateSummary(result);
    assert.ok(s.includes("[d1]") && s.includes("trecho 1"));
    assert.ok(s.includes("[post_pixel]") && s.includes("trecho 2"));
  });
});

// ---------------------------------------------------------------------------
// CLI — modo descoberta (default)
// ---------------------------------------------------------------------------

describe("run-social-critic CLI — modo descoberta (#4505 item 3)", () => {
  it("desabilitado (default) → exit 2, sem tratar como erro", () => {
    const dir = makeTmpEdition();
    try {
      writeFileSync(join(dir, "03-social.md"), "# LinkedIn\n\n## d1\n\ntexto\n");
      const configPath = writeConfig(dir, { social_critic_pass: { enabled: false } });
      const result = runCli(dir, ["--config", configPath]);
      assert.equal(result.status, 2, `exit 2 esperado (desabilitado). stderr: ${result.stderr}`);
      assert.ok(result.stderr.includes("desabilitado"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem config (usa platform.config.json real do repo, default enabled:false) → exit 2", () => {
    const dir = makeTmpEdition();
    try {
      writeFileSync(join(dir, "03-social.md"), "# LinkedIn\n\n## d1\n\ntexto\n");
      const result = runCli(dir);
      assert.equal(result.status, 2, `esperava exit 2 (default do repo é enabled:false). stderr: ${result.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("habilitado + 03-social.md presente → exit 0 + JSON de dispatch no stdout", () => {
    const dir = makeTmpEdition();
    try {
      writeFileSync(join(dir, "03-social.md"), "# LinkedIn\n\n## d1\n\ntexto\n");
      const configPath = writeConfig(dir, { social_critic_pass: { enabled: true } });
      const result = runCli(dir, ["--config", configPath]);
      assert.equal(result.status, 0, `exit 0 esperado. stderr: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout) as { edition: string; social_path: string; out_path: string };
      assert.ok(parsed.social_path.endsWith("03-social.md"));
      assert.ok(parsed.out_path.includes("social-critic.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("habilitado mas 03-social.md ausente → exit 1", () => {
    const dir = makeTmpEdition();
    try {
      const configPath = writeConfig(dir, { social_critic_pass: { enabled: true } });
      const result = runCli(dir, ["--config", configPath]);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes("03-social.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falha com exit 1 se --edition-dir não fornecido", () => {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "run-social-critic.ts");
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("edition-dir"));
  });
});

// ---------------------------------------------------------------------------
// CLI — modo --input-json (integração com output do subagente)
// ---------------------------------------------------------------------------

describe("run-social-critic CLI --input-json (#4505 item 3)", () => {
  it("grava social-critic.json e mostra o achado no stdout — sempre exit 0", () => {
    const dir = makeTmpEdition();
    try {
      const agentOutput = {
        checked_at: "2026-08-03T10:00:00Z",
        findings: [
          { section: "d1", trecho: "não é sorte: é estratégia", motivo: "antítese-revelação via dois-pontos" },
        ],
      };
      const inputJsonPath = join(dir, "agent-output.json");
      writeFileSync(inputJsonPath, JSON.stringify(agentOutput), "utf8");

      const result = runCli(dir, ["--input-json", inputJsonPath]);
      // Warning-only: mesmo com finding presente, exit deve ser sempre 0.
      assert.equal(result.status, 0, `exit 0 esperado (warning-only). stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes("⚠️"), "stdout deve conter ⚠️ para o finding");
      assert.ok(result.stdout.includes("[d1]"));

      const outPath = join(dir, "_internal", "social-critic.json");
      assert.ok(existsSync(outPath), "social-critic.json deve ter sido gravado");
      const saved = JSON.parse(readFileSync(outPath, "utf8"));
      assert.equal(saved.sounds_ai, true);
      assert.equal(saved.findings.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem findings → exit 0 + stdout sem ⚠️", () => {
    const dir = makeTmpEdition();
    try {
      const agentOutput = { findings: [] };
      const inputJsonPath = join(dir, "agent-output.json");
      writeFileSync(inputJsonPath, JSON.stringify(agentOutput), "utf8");

      const result = runCli(dir, ["--input-json", inputJsonPath]);
      assert.equal(result.status, 0);
      assert.ok(!result.stdout.includes("⚠️"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--input-json apontando pra arquivo inexistente → exit 1", () => {
    const dir = makeTmpEdition();
    try {
      const result = runCli(dir, ["--input-json", join(dir, "nao-existe.json")]);
      assert.equal(result.status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--input-json NÃO checa o flag opt-in (uma vez dispatchado, sempre persiste o resultado)", () => {
    // O gate opt-in só se aplica ao modo descoberta (decide SE dispatcha o
    // subagente). Uma vez que o subagente já rodou e produziu output, o
    // --input-json deve sempre normalizar/persistir — não há razão pra
    // descartar um resultado já pago.
    const dir = makeTmpEdition();
    try {
      const configPath = writeConfig(dir, { social_critic_pass: { enabled: false } });
      const agentOutput = { findings: [] };
      const inputJsonPath = join(dir, "agent-output.json");
      writeFileSync(inputJsonPath, JSON.stringify(agentOutput), "utf8");

      const result = runCli(dir, ["--input-json", inputJsonPath, "--config", configPath]);
      assert.equal(result.status, 0);
      assert.ok(existsSync(join(dir, "_internal", "social-critic.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
