import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const prompt = readFileSync(new URL("../.claude/agents/scorer-chunk.md", import.meta.url), "utf8");
const settings = JSON.parse(readFileSync(new URL("../.claude/settings.json", import.meta.url), "utf8"));

describe("scorer-chunk: contexto obrigatório após Bash negado (#11560)", () => {
  it("tem Read disponível e autorizado sem ampliar permissões de shell", () => {
    assert.match(prompt, /^tools: .*\bRead\b/m);
    assert.ok(settings.permissions.allow.includes("Read"));
    assert.ok(!settings.permissions.deny.includes("Read"));
  });

  it("manda ler contexto e input com Read e recuperar uma negativa de Bash", () => {
    const context = prompt.split("## Contexto obrigatório")[1].split("## Processo")[0];
    assert.match(context, /releia \*\*com a ferramenta `Read`\*\*/);
    for (const file of ["context/audience-profile.md", "context/editorial-rules.md"]) {
      assert.ok(context.includes(file));
    }
    assert.match(context, /JSON de input/);
    assert.match(context, /Não use `Bash`/);
    assert.match(context, /Bash` já tiver sido negado.*refaça a leitura com `Read`/);
    assert.match(context, /offset`\/`limit/);
  });

  it("interrompe sem scores se Read falhar, sem usar perfil de memória", () => {
    assert.match(prompt, /Se `Read` falhar, \*\*não pontue nem grave scores\*\*/);
    assert.match(prompt, /erro explícito com o path e o motivo/);
    assert.match(prompt, /Nunca substitua o perfil atual por memória/);
  });
});
