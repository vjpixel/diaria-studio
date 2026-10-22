/**
 * test/hermes-continuo-multirepo-10900.test.ts (#10900, resíduo da #10618)
 *
 * O loop do contínuo que roda de fato no `300` é a skill do Hermes
 * (`hermes/skills/hermes-diaria-continuo/SKILL.md`, consumidor externo — ver
 * `test/continuo-infra-consumidor-externo.test.ts`). Até a v0.5.17 ela varria
 * com `gh issue list` cru no studio e reivindicava por número: issue do
 * diaria-design nunca era vista, apesar do default ligado no #10895. Este teste
 * trava a varredura multi-repo, o claim por ref e o caminho do item 32 — e que
 * nada da infra de antes foi removido no caminho (gate de coerência, claim com
 * `--kind continuo`, renovador de heartbeat, proibição de merge).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIR = join(ROOT, "hermes", "skills", "hermes-diaria-continuo");
const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");

describe("#10900 — hermes-diaria-continuo varre e reivindica issues de todos os repos", () => {
  it("varredura via fetch-open-issues-for-triage --repos all, não gh issue list cru", () => {
    assert.match(skill, /npx tsx scripts\/fetch-open-issues-for-triage\.ts --repos all/);
    assert.doesNotMatch(skill, /gh issue list --state open --json number,labels,body,state/);
  });

  it("exit 3 (parcial) e exit 1 têm instrução explícita", () => {
    assert.match(skill, /`exit 3` = parcial/);
    assert.match(skill, /`exit 1` = falha do studio/);
  });

  it("claim e unclaim por ref de outro repo", () => {
    assert.match(skill, /claim-issue --kind continuo --issue \{N\|ref\}/);
    assert.match(skill, /--issue vjpixel\/diaria-design#N/);
    assert.match(skill, /unclaim-issue/);
  });

  it("issue do design segue o item 32 (checkout ../diaria-design, worktree de origin/main, PR no design)", () => {
    assert.match(skill, /item 32\s+de `context\/overnight-dispatch-rules\.md`/);
    assert.match(skill, /\.\.\/diaria-design/);
    assert.match(skill, /origin\/main/);
    assert.match(skill, /gh pr create -R\s+vjpixel\/diaria-design --base main/);
    assert.match(skill, /NUNCA implementar num worktree do studio/);
  });

  it("teto de PR continuo/* no design e merge humano declarados", () => {
    assert.match(skill, /gh pr list -R vjpixel\/diaria-design --state open/);
    assert.match(skill, /merge dessa PR NÃO é automático/);
  });

  it("nada da infra anterior foi removido (consumidor externo)", () => {
    for (const marker of [
      "scripts/check-continuo-coherence.ts --issue N",
      "--kind continuo",
      "HEARTBEAT_PID",
      "claude-delegate.sh",
      "NUNCA baixar o `--budget`",
      "**NÃO mergear.**",
      "check-continuo-pr-cap.ts",
      "rescue-continuo-orphaned-work.ts",
    ]) {
      assert.ok(skill.includes(marker), `marcador sumiu do SKILL.md: ${marker}`);
    }
  });

  it("todo ponteiro pra rationale-extraido-10900.md aponta pra seção que existe", () => {
    const refPath = join(SKILL_DIR, "references", "rationale-extraido-10900.md");
    assert.ok(existsSync(refPath));
    const ref = readFileSync(refPath, "utf8");
    const cited = [...skill.matchAll(/rationale-extraido-10900\.md` (§\d+)/g)].map((m) => m[1]);
    assert.ok(cited.length >= 4, `esperava >= 4 ponteiros, achei ${cited.length}`);
    for (const sec of cited) assert.match(ref, new RegExp(`^## ${sec} `, "m"), `seção ${sec} ausente`);
  });
});
