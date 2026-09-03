import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseClaudeBinaryLayout } from "../scripts/lib/claude-binary-layout.ts";
import { run as runCheckClaudeBinaryLayout } from "../scripts/check-claude-binary-layout.ts";

// ─── Reprodução do incidente real (#7189) ───────────────────────────────────
//
// Rodada `/diaria-overnight` 260902: 4 ocorrências de
// `Error: claude native binary not installed.` saindo no lugar do resultado
// de comandos — inclusive `check-pr-checks-gate.ts`, cujo veredito decide
// se um PR pode mergear. Estado medido ao vivo no install global
// (`~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/`): `bin/`
// continha SÓ `claude.exe` (binário Windows) numa máquina Linux —
// reproduzido de novo, ao vivo, durante a investigação desta issue.

test("bin/ com só claude.exe numa máquina linux-x64 — reproduz e nomeia o achado do #7189", () => {
  const diagnosis = diagnoseClaudeBinaryLayout({
    platformKey: "linux-x64",
    binEntries: ["claude.exe"],
    installRoot: "/home/vjpixel/.npm-global/lib/node_modules/@anthropic-ai/claude-code",
  });

  assert.equal(diagnosis.verdict, "wrong-platform-layout");
  assert.match(diagnosis.message, /sobrescrito por outro layout de plataforma/);
  assert.match(diagnosis.message, /claude\.exe/);
  // A instrução PADRÃO do erro do pacote ("node node_modules/@anthropic-ai/claude-code/install.cjs")
  // usa um caminho LOCAL relativo que não existe em install global (achado
  // da #7189: rodar isso não corrigiu nada) — o fixCommand aqui precisa ser
  // o caminho GLOBAL absoluto de verdade.
  assert.equal(
    diagnosis.fixCommand,
    "node /home/vjpixel/.npm-global/lib/node_modules/@anthropic-ai/claude-code/install.cjs",
  );
});

test("bin/ com o binário certo (claude) numa máquina linux-x64 — ok, sem fix sugerido", () => {
  const diagnosis = diagnoseClaudeBinaryLayout({
    platformKey: "linux-x64",
    binEntries: ["claude"],
    installRoot: "/home/vjpixel/.npm-global/lib/node_modules/@anthropic-ai/claude-code",
  });

  assert.equal(diagnosis.verdict, "ok");
  assert.equal(diagnosis.fixCommand, null);
});

test("bin/ com o binário certo (claude.exe) numa máquina win32 — ok", () => {
  const diagnosis = diagnoseClaudeBinaryLayout({
    platformKey: "win32-x64",
    binEntries: ["claude.exe"],
    installRoot: "C:\\Users\\editor\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code",
  });

  assert.equal(diagnosis.verdict, "ok");
});

test("layout cruzado no sentido inverso — bin/ só com claude (linux) numa máquina win32", () => {
  const diagnosis = diagnoseClaudeBinaryLayout({
    platformKey: "win32-x64",
    binEntries: ["claude"],
    installRoot: "C:\\npm-global\\node_modules\\@anthropic-ai\\claude-code",
  });

  assert.equal(diagnosis.verdict, "wrong-platform-layout");
  assert.match(diagnosis.message, /claude(?!\.exe)/);
});

test("bin/ vazio — postinstall genuinamente não rodou, distinto de layout cruzado", () => {
  const diagnosis = diagnoseClaudeBinaryLayout({
    platformKey: "linux-x64",
    binEntries: [],
    installRoot: "/opt/claude-code",
  });

  assert.equal(diagnosis.verdict, "missing");
  assert.match(diagnosis.message, /postinstall que não rodou/);
  assert.equal(diagnosis.fixCommand, "node /opt/claude-code/install.cjs");
});

test("bin/ com entradas desconhecidas (nem claude nem claude.exe) — missing, não wrong-platform", () => {
  const diagnosis = diagnoseClaudeBinaryLayout({
    platformKey: "linux-x64",
    binEntries: ["README.md"],
    installRoot: "/opt/claude-code",
  });

  assert.equal(diagnosis.verdict, "missing");
});

test("platformKey vazio — unknown-platform, sem fixCommand acionável", () => {
  const diagnosis = diagnoseClaudeBinaryLayout({
    platformKey: "",
    binEntries: ["claude"],
    installRoot: "/opt/claude-code",
  });

  assert.equal(diagnosis.verdict, "unknown-platform");
  assert.equal(diagnosis.fixCommand, null);
});

test("installRoot null — diagnóstico segue funcionando, só sem fixCommand", () => {
  const diagnosis = diagnoseClaudeBinaryLayout({
    platformKey: "linux-x64",
    binEntries: ["claude.exe"],
    installRoot: null,
  });

  assert.equal(diagnosis.verdict, "wrong-platform-layout");
  assert.equal(diagnosis.fixCommand, null);
});

// ─── CLI (scripts/check-claude-binary-layout.ts) ────────────────────────────
//
// `run()` só é exercitada aqui contra argv/env controlados por fixture —
// nunca contra o install global real (regra #633: bugfix exige teste de
// regressão testável contra fixtures, não contra estado externo ao vivo).

test("CLI: sem $CLAUDE_CODE_EXECPATH e sem --exec-path — exit 3, mensagem clara", () => {
  const original = process.env.CLAUDE_CODE_EXECPATH;
  delete process.env.CLAUDE_CODE_EXECPATH;
  try {
    const { exitCode, output } = runCheckClaudeBinaryLayout([]);
    assert.equal(exitCode, 3);
    assert.match(output, /não foi possível localizar o install/);
  } finally {
    if (original !== undefined) process.env.CLAUDE_CODE_EXECPATH = original;
  }
});

test("CLI: --exec-path apontando pra bin/ inexistente — exit 3, não lança", () => {
  const { exitCode, output } = runCheckClaudeBinaryLayout([
    "--exec-path",
    "/tmp/definitely-not-a-real-claude-install-7189/bin/claude",
  ]);
  assert.equal(exitCode, 3);
  assert.match(output, /não existe/);
});
