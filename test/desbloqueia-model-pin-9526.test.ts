/**
 * test/desbloqueia-model-pin-9526.test.ts (#9526)
 *
 * Guard: o frontmatter de `.claude/skills/diaria-desbloqueia/SKILL.md` fixa
 * exatamente `model: claude-opus-5-5` + `effort: medium` (mesmo perfil do
 * coordenador do /diaria-develop, #8941) — ID pinado, nunca alias (#9003).
 * Também trava que a limitação de escopo-de-turno do pin (#9124) segue
 * documentada no corpo da skill.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = resolve(ROOT, ".claude/skills/diaria-desbloqueia/SKILL.md");

function frontmatter(content: string): string {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, "SKILL.md sem frontmatter");
  return m[1];
}

function field(fm: string, key: string): string[] {
  const re = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "gm");
  return [...fm.matchAll(re)].map((m) => m[1].replace(/^["']|["']$/g, ""));
}

describe("#9526 — /diaria-desbloqueia pina model/effort no frontmatter", () => {
  const content = readFileSync(SKILL, "utf8");
  const fm = frontmatter(content);

  it("declara exatamente model: claude-opus-5-5 (ID pinado, uma vez)", () => {
    assert.deepEqual(field(fm, "model"), ["claude-opus-5-5"]);
  });

  it("declara exatamente effort: medium (uma vez)", () => {
    assert.deepEqual(field(fm, "effort"), ["medium"]);
  });

  it("documenta a limitação de escopo-de-turno do pin (#9124)", () => {
    const body = content.slice(content.indexOf("---", 3) + 3);
    assert.match(body, /#9124/);
    assert.match(body, /fim do turno/);
    assert.match(body, /AskUserQuestion/);
  });
});

describe("#9526 — /diaria-desbloqueia projetada para um único turno (pin não cai em task-notification)", () => {
  const content = readFileSync(SKILL, "utf8");
  const fm = frontmatter(content);
  const [expectModel] = field(fm, "model");
  const [expectEffort] = field(fm, "effort");
  /** Whitespace colapsado — quebra de linha no meio da prosa não pode esconder o comando. */
  const flat = content.replace(/\s+/g, " ");

  it("a receita de dispatch usa adhoc-opus-medium e run_in_background: false na MESMA linha", () => {
    const lines = content.split(/\r?\n/).filter((l) => /subagent_type: "adhoc-opus-medium"/.test(l));
    assert.ok(lines.length >= 1, "receita de dispatch com subagent_type adhoc-opus-medium ausente");
    for (const l of lines) assert.match(l, /run_in_background: false/);
  });

  it("não despacha mais general-purpose nem diz que o effort é herdado do turno", () => {
    assert.doesNotMatch(content, /subagent_type: "general-purpose"/);
    assert.doesNotMatch(flat, /herda o effort do turno/i);
    assert.doesNotMatch(flat, /effort do subagente herda/i);
  });

  it("nunca instrui run_in_background ligado (qualquer grafia)", () => {
    assert.doesNotMatch(content, /run_in_background[`"']?\s*[:=]\s*[`"']?true/i);
  });

  it("explica o mecanismo: notificação com o turno JÁ encerrado abre turno novo (#9527)", () => {
    assert.match(content, /task-notification/);
    assert.match(content, /#9527/);
    assert.match(flat, /projetada para rodar num único turno/);
    assert.match(flat, /nunca encerrar o turno esperando notificação/);
    assert.match(flat, /JÁ ENCERRADO/);
    // ressalva: mensagem livre / pausa fora do AskUserQuestion também quebra o pin
    assert.match(flat, /mensagem livre do editor ou qualquer pausa fora do `AskUserQuestion`/);
    // caso Bash-em-background marcado como inferido, não observado
    assert.match(flat, /por inferência \(não observado ao vivo\)/);
  });

  it("Bash longo roda em foreground com timeout: 600000 e timeout nunca vira background", () => {
    assert.match(flat, /timeout: 600000/);
    assert.match(flat, /dividir por `--issues N,M`/);
    assert.match(flat, /nunca perguntar nada a partir de saída parcial/);
  });

  it("cita a sonda do par efetivo com os --expect-* derivados do frontmatter", () => {
    assert.ok(expectModel && expectEffort);
    assert.ok(
      flat.includes(
        `npx tsx scripts/lib/effective-model-probe.ts --expect-model ${expectModel} --expect-effort ${expectEffort}`,
      ),
      "comando da sonda com o par do frontmatter ausente",
    );
  });

  it("o span inline da sonda é um comando standalone (sem &&, | nem ;)", () => {
    const spans = [...content.matchAll(/`([^`\n]*effective-model-probe[^`\n]*)`/g)].map((m) => m[1]);
    assert.ok(spans.length >= 1, "span inline da sonda ausente");
    for (const sp of spans) assert.doesNotMatch(sp, /&&|\||;/);
  });

  it("a sonda não vem em bloco cercado (o hook não injeta --session-id em comando multi-linha)", () => {
    const fences = [...content.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
    for (const f of fences) assert.doesNotMatch(f, /effective-model-probe/);
  });

  it("o template do resumo final sempre traz a linha Par efetivo (sonda pulada não some)", () => {
    const tpl = content.match(/```\r?\n(\/diaria-desbloqueia — resumo[\s\S]*?)```/);
    assert.ok(tpl, "template do resumo ausente");
    assert.match(tpl[1], /^Par efetivo: .*ok .*saiu do pinado .*sonda indisponível/m);
  });
});
