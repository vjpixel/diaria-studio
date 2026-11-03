/**
 * test/review-test-email-kit-self-contained-11848.test.ts (#11848)
 *
 * O Processo Kit do `review-test-email` dizia ser "o Processo Beehiiv acima
 * (seções 1 a 4) com estas substituições": os lints determinísticos e os
 * guards de leitura do e-mail só existiam no bloco Beehiiv. Remover o bloco
 * Beehiiv (prosa morta desde o #11225) quebraria a revisão do teste do Kit,
 * que roda todo dia na Etapa 5. Este teste trava a seção Kit como
 * autossuficiente: ela mesma chama cada lint e carrega os guards, e não
 * remete mais ao bloco Beehiiv.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agent = readFileSync(resolve(ROOT, ".claude/agents/review-test-email.md"), "utf8");

function section(heading: string): string {
  const start = agent.indexOf(heading);
  assert.ok(start !== -1, `seção ${heading} ausente`);
  const next = agent.indexOf("\n## ", start + 1);
  return agent.slice(start, next === -1 ? undefined : next);
}

const kit = section("## Processo Kit");

describe("review-test-email: Processo Kit autossuficiente (#11848)", () => {
  it("não remete ao Processo Beehiiv para os passos comuns", () => {
    assert.doesNotMatch(kit, /Processo Beehiiv acima \(seções 1 a 4\)/);
    assert.doesNotMatch(kit, /Resto igual à seção 1/);
    assert.doesNotMatch(kit, /substitui (a seção 1|o item 0 da seção 3)/);
    assert.doesNotMatch(kit, /seção 3c-guard|passo 3c\b/);
  });

  it("chama ele mesmo cada lint determinístico e o helper de completude do fetch", () => {
    for (const script of [
      "scripts/check-fetch-completeness.ts",
      "scripts/lint-test-email.ts",
      "scripts/lint-test-email-structure.ts",
      "scripts/lint-test-email-encoding.ts",
      "scripts/lint-test-email-link-tracking.ts",
      "scripts/lint-test-email-image-freshness.ts",
      "scripts/lint-test-email-size.ts",
    ]) {
      assert.ok(kit.includes(`npx tsx ${script}`), `Processo Kit deve rodar ${script}`);
    }
  });

  it("carrega os guards de leitura: fail-closed, fetch truncado, decode do dump, tamanho só info:", () => {
    assert.match(kit, /"reason": "mcp_unavailable"/);
    assert.match(kit, /"reason": "not_found_timeout"/);
    assert.match(kit, /NUNCA retornar `status: ok`/);
    assert.match(kit, /"reason": "truncated_fetch"/);
    assert.match(kit, /info:link_decode_artifact/);
    assert.match(kit, /todos com `info:`, nunca `email:`/);
    assert.match(kit, /#4629 — ordem literal/);
    assert.match(kit, /email:encoding_drop: \{codepoint\} '\{char\}' em '…\{source_context\}…'/);
  });

  it("o marcador do leaderboard no Kit é o mesmo do check 19 (renderer, #9247)", () => {
    const line19 = agent.split("\n").find((l) => l.startsWith("**19."));
    assert.ok(line19);
    const markers = line19.match(/marcadores (.+?) aparece no body/)?.[1];
    assert.ok(markers);
    assert.ok(kit.includes(`marcadores ${markers} aparece no body`), "Kit e Beehiiv devem citar os mesmos marcadores");
  });

  it("o bloco Beehiiv continua no arquivo (só a dependência do Kit saiu)", () => {
    const beehiiv = section("## Processo Beehiiv");
    assert.match(beehiiv, /### 1c\. Sanidade de tamanho do fetch/);
    assert.match(beehiiv, /### 3c-guard\./);
    assert.match(beehiiv, /autossuficiente desde o #11848/);
  });
});
