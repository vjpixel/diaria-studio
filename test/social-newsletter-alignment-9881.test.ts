/**
 * Guard de prompt (#9881, social-rewrite): no re-disparo do Stage 4, o
 * `social-writer` E o `social-curto` recebem `newsletter_md_path` e alinham
 * FATOS e FECHO ao corpo da newsletter que o editor aprovou.
 *
 * Medição sobre as edições 261005-261007 (as citadas na issue): as reescritas
 * de social que ainda não tinham regra correspondente eram cascata da
 * reescrita da newsletter no gate 4 — o social (e o `# Curto`) ficava com o
 * ângulo velho (Cloudflare Clef sem a comparação com o Jev, textGrain ainda
 * citando o Claude e sem escopo/fragilidade). O `social-curto` nem recebia o
 * corpo da newsletter no re-disparo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("#9881 — social alinhado ao corpo da newsletter no re-disparo do Stage 4", () => {
  it("social-writer.md diz o que é alinhar: mesmos fatos (inclusive cortes) e mesmo fecho", () => {
    const md = read(".claude/agents/social-writer.md");
    assert.match(md, /Com `newsletter_md_path`: o corpo da newsletter é a versão do destaque que o editor aprovou \(#9881\)/);
    assert.match(md, /o que o editor cortou do corpo sai do social também/);
    assert.match(md, /o 3º parágrafo segue a consequência prática que o corpo escreveu/);
  });

  it("social-curto.md declara newsletter_md_path e a mesma regra de alinhamento", () => {
    const md = read(".claude/agents/social-curto.md");
    assert.match(md, /`newsletter_md_path` \(opcional, #9881\)/);
    assert.match(md, /o que ele cortou sai, mesmo que esteja no `summary` ou na fonte/);
  });

  it("orchestrator-stage-4.md §e passa newsletter_md_path também ao social-curto", () => {
    const md = read(".claude/agents/orchestrator-stage-4.md");
    const e = md.split("\n").find((l) => l.startsWith("**e. Dispatchar `social-writer`"));
    assert.ok(e, "§e não encontrado");
    assert.match(e!, /social-curto[^\n]*MESMO `newsletter_md_path` \(#9881\)/);
  });
});
