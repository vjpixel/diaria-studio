/**
 * Regressão #11886 — a re-humanização do Stage 4 (§4d.1 passo 6) aplica as
 * sugestões do `mcp__clarice__correct_text` à mão. Os dois fluxos (SCOPED e
 * FULL-FILE) têm de passar as sugestões por `scripts/clarice-filter.ts` antes
 * de aplicar, senão o ruído do MCP (#11798) chega ao `03-social.md`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const PLAYBOOK = readFileSync(".claude/agents/orchestrator-stage-4.md", "utf8");

/** Trecho do playbook entre dois marcadores (o 1º inclusive, o 2º exclusive). */
function between(start: string, end: string): string {
  const i = PLAYBOOK.indexOf(start);
  assert.ok(i >= 0, `marcador ausente no playbook: ${start}`);
  const j = PLAYBOOK.indexOf(end, i + start.length);
  assert.ok(j > i, `marcador ausente no playbook: ${end}`);
  return PLAYBOOK.slice(i, j);
}

const SCOPED = between("**Fluxo SCOPED (`legacy: false`):**", "**6.4**");
const FULL_FILE = between("**Fluxo FULL-FILE (fallback", "**Os dois fluxos convergem aqui:**");

for (const [nome, trecho] of [["SCOPED", SCOPED], ["FULL-FILE", FULL_FILE]] as const) {
  test(`Stage 4 fluxo ${nome}: Clarice passa pelo clarice-filter antes de aplicar`, () => {
    const clarice = trecho.indexOf("mcp__clarice__correct_text");
    const filtro = trecho.indexOf("scripts/clarice-filter.ts");
    const registro = trecho.indexOf("--record-run --step clarice");
    assert.ok(clarice >= 0, `fluxo ${nome} sem a chamada da Clarice`);
    assert.ok(filtro > clarice, `fluxo ${nome} aplica as sugestões sem clarice-filter.ts`);
    assert.ok(registro > filtro, `fluxo ${nome} registra a Clarice antes de filtrar`);
    assert.match(trecho, /exit ≠ 0 = não aplicar/, `fluxo ${nome} sem a regra de falha do filtro`);
  });
}

test("Stage 4 SCOPED: aplica o arquivo filtrado, nunca a lista crua", () => {
  assert.match(SCOPED, /--out \{EDITION_DIR\}\/_internal\/clarice-stage4-\{seção\}-filtrado\.json/);
  assert.match(SCOPED, /aplicar todas as sugestões do filtrado/);
  assert.doesNotMatch(SCOPED, /`changed_sections`\*\*, aplicar todas as sugestões \(#4514\)/);
});

test("Stage 3a-bis (descrição do É IA?): Clarice passa pelo clarice-filter antes de aplicar", () => {
  const stage3 = readFileSync(".claude/agents/orchestrator-stage-3.md", "utf8");
  const i = stage3.indexOf("### 3a-bis.");
  const j = stage3.indexOf("### 3b.", i);
  assert.ok(i >= 0 && j > i, "seção 3a-bis ausente no playbook do Stage 3");
  const secao = stage3.slice(i, j);
  const clarice = secao.indexOf("mcp__clarice__correct_text");
  const filtro = secao.indexOf("scripts/clarice-filter.ts");
  const aplica = secao.indexOf("apply-eia-description.ts");
  assert.ok(clarice >= 0, "3a-bis sem a chamada da Clarice");
  assert.ok(filtro > clarice && aplica > filtro, "3a-bis aplica a Clarice sem clarice-filter.ts");
  assert.match(secao, /exit ≠ 0 = não aplicar nada/);
});

test("clarice-filter no caso do Stage 4: ruído de seção social sai, correção real fica", () => {
  const dir = mkdtempSync(join(tmpdir(), "clarice-stage4-"));
  const inp = join(dir, "clarice-stage4-main_d1.json");
  const out = join(dir, "clarice-stage4-main_d1-filtrado.json");
  const real = { from: "as empresa", to: "as empresas", rule: "Concordância" };
  writeFileSync(
    inp,
    JSON.stringify([
      { from: "A Anthropic", to: "\n\nA Anthropic", rule: "", explanation: "" },
      { from: ".", to: '."}]}]);\n}', explanation: "ponto final dentro das aspas" },
      real,
    ]),
  );
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/clarice-filter.ts", "--suggestions", inp, "--out", out],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), [real]);
  assert.equal(JSON.parse(r.stdout).dropped, 2);
});
