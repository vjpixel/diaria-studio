import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const skill = readFileSync(new URL("../.claude/skills/diaria-overnight/SKILL.md", import.meta.url), "utf8");
const train = skill.slice(skill.indexOf("   **Trem de merge (#6300"), skill.indexOf("   - Verde (CI verde"));

test("#10927: PRs prontas usam o trem sem exigir chegada simultânea ou inferir independência por arquivo", () => {
  assert.match(train, /usar obrigatoriamente `npx tsx scripts\/run-merge-train\.ts/);
  assert.doesNotMatch(train, /chegam ao Gate 2 verde ao mesmo tempo/);
  assert.match(train, /arquivos diferentes podem compartilhar símbolo, regex, contrato ou teste/);
  assert.match(train, /não esperar as que ainda estão implementando/);
  assert.match(train, /PR de outro repo nunca entra no trem/);
});

test("#10927: caminho serial valida a nova combinação e recusa base ou HEAD que mudaram", () => {
  const serial = train.slice(train.indexOf("**Validação da combinação (#10927)"));
  assert.match(serial, /npx tsx scripts\/gh-pr-update-branch\.ts --pr \{N\} \[--repo \{repo\}\]/);
  assert.match(serial, /testes consumidores dos símbolos\/contratos alterados/);
  assert.match(serial, /enrich-inbox-redirect-10796\.test\.ts/);
  assert.match(serial, /which-set-guards\.ts.*TODOS os `testFiles`/);
  assert.match(serial, /aguardar o CI desse HEAD; verde do HEAD anterior não conta/);
  assert.match(serial, /Com o merge lock adquirido, reler o SHA remoto da base/);
  assert.match(serial, /Se diferir de `validated_base_sha`, soltar o lock e repetir/);
  assert.match(serial, /--match-head-commit \{head_sha\}/);
  assert.match(serial, /Não segurar o lock enquanto aguarda CI/);
  assert.match(serial, /Depois de cada merge, a validação da próxima PR começa de novo/);
});
