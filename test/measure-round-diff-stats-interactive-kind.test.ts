/**
 * test/measure-round-diff-stats-interactive-kind.test.ts (#7292, defeito 1)
 *
 * Regressão CLI, não só de lib: antes deste fix,
 * `scripts/measure-round-diff-stats.ts` definia sua própria lista
 * `VALID_SESSION_KINDS = ["overnight", "develop", "continuo"]` — uma
 * sessão interativa coordenada (protocolo de `docs/coordenacao-merges.md`)
 * não tinha `--session-kind` válido pra se declarar, então
 * `round_diff_stats` nunca era emitido por esse fluxo, mesmo com o `git
 * diff` calculado corretamente. `--dry-run` evita tocar `data/run-log.jsonl`
 * real — mesma disciplina de `round-diff-stats-report.test.ts` (dado
 * sintético, sem bater em estado real do repo).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(ROOT, "scripts/measure-round-diff-stats.ts");

function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
    cwd: ROOT,
  });
}

describe("measure-round-diff-stats CLI --session-kind interactive (#7292)", () => {
  it("aceita 'interactive' e calcula o diff normalmente (--dry-run, sem persistir)", () => {
    const r = run(["--base", "HEAD", "--head", "HEAD", "--session-kind", "interactive", "--dry-run"]);
    assert.equal(r.status, 0, `esperava exit 0, saiu ${r.status}. stderr: ${r.stderr}`);
    assert.match(r.stdout, /interactive HEAD\.\.HEAD/);
    assert.match(r.stdout, /--dry-run: nada persistido/);
  });

  it("continua rejeitando kind desconhecido (comportamento pré-existente preservado)", () => {
    const r = run(["--base", "HEAD", "--session-kind", "nao-existe", "--dry-run"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /session-kind inválido/);
    assert.match(r.stderr, /interactive/); // lista de esperados agora inclui 'interactive'
  });
});
