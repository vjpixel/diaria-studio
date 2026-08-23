/**
 * test/claude-settings-headless-permissions.test.ts
 *
 * Regressão pro achado ao vivo 260823: `run-edition-stages.ts` spawna cada
 * stage headless como `claude --print --permission-mode acceptEdits ...`
 * (`scripts/lib/edition-stage-runner.ts`). Nesse modo, `.claude/settings.json`
 * → `permissions.allow` é a ÚNICA fonte de auto-aprovação (o
 * `defaultMode: "auto"` do `~/.claude/settings.json` do usuário não se
 * aplica — `--permission-mode` explícito na invocação o sobrepõe).
 *
 * `.claude/settings.json` tinha `Bash(npx tsx scripts/*.ts)` SEM a variante
 * com `*` final pros argumentos — e virtualmente todo comando real do
 * pipeline leva flags (`npx tsx scripts/foo.ts --edition 260824 ...`), então
 * NENHUM script real batia com o padrão. Repro ao vivo: `/diaria-edicao`
 * spawnou o Stage 1 em background, que morreu em 46s com "This command is
 * being blocked by a permission prompt that I can't resolve on my own" — o
 * processo `claude --print` filho não tinha ninguém pra aprovar o prompt.
 * Confirmado via repro isolado (`claude --print --permission-mode acceptEdits
 * ... "rode npx tsx scripts/log-event.ts --edition ... --stage 0 ..."`):
 * bloqueado antes do fix, passou depois de acrescentar
 * `Bash(npx tsx scripts/*.ts *)` (mesmo padrão que `node scripts/*.js *` já
 * tinha ao lado do `node scripts/*.js` bare).
 *
 * Isto não é só o Stage 1 manual — `run-scheduled-edicao.ts` (a task diária
 * agendada) usa o MESMO `runEditionStages`/`edition-stage-runner.ts`, então
 * sem este fix TODA edição headless (manual em background OU agendada)
 * ficaria bloqueada no primeiro `npx tsx scripts/*.ts <args>` do preflight.
 *
 * O teste é deliberadamente mecânico (contém pattern X?) — não é possível
 * exercitar o `claude --print` real em CI (precisa do binário + auth), então
 * a garantia viável é: a allowlist nunca regride pra "só bare, sem args".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SETTINGS_PATH = resolve(REPO_ROOT, ".claude/settings.json");

function loadAllowList(): string[] {
  const raw = readFileSync(SETTINGS_PATH, "utf8");
  const parsed = JSON.parse(raw) as { permissions?: { allow?: unknown } };
  const allow = parsed.permissions?.allow;
  assert.ok(Array.isArray(allow), "permissions.allow deve ser um array");
  return allow as string[];
}

describe("claude-settings-headless-permissions", () => {
  it(".claude/settings.json é JSON válido com permissions.allow", () => {
    const allow = loadAllowList();
    assert.ok(allow.length > 0);
  });

  it("permite `npx tsx scripts/*.ts` com argumentos (não só bare)", () => {
    const allow = loadAllowList();
    assert.ok(
      allow.includes("Bash(npx tsx scripts/*.ts *)"),
      "faltando 'Bash(npx tsx scripts/*.ts *)' — sem isso, todo comando " +
        "`npx tsx scripts/foo.ts --flag ...` (a esmagadora maioria do " +
        "pipeline) fica de fora da allowlist em sessões headless " +
        "(`claude --print --permission-mode acceptEdits`), travando " +
        "`run-edition-stages.ts`/`run-scheduled-edicao.ts` no primeiro " +
        "script chamado com flags",
    );
  });

  it("permite `node scripts/*.ts` com argumentos (mesma classe de gap)", () => {
    const allow = loadAllowList();
    assert.ok(
      allow.includes("Bash(node scripts/*.ts *)"),
      "faltando 'Bash(node scripts/*.ts *)' — mesmo gap do npx tsx, só que " +
        "pro invocador `node` direto",
    );
  });
});
