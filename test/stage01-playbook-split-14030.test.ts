/**
 * #14030: os playbooks das Etapas 0 e 1 viraram caminho principal (runner +
 * passos fora dele) e fallback (prosa dos passos que o runner executa), lido
 * só quando o runner falha fora dos codes previstos ou quando o principal
 * cita uma seção. Este teste trava:
 *
 *   1. o teto de bytes de cada arquivo (o ganho da issue é o principal ficar
 *      pequeno; crescer de novo precisa de decisão consciente);
 *   2. o ponteiro para o fallback no ponto exato em que o runner manda ler
 *      (passo de fallback e HALT do code 2);
 *   3. que cada passo DELEGADO pelos runners (`DELEGATED_STEPS` de
 *      `stage-0-run.ts`/`stage-1-run.ts`) tem a sua seção no arquivo
 *      principal, nunca só no fallback;
 *   4. que cada passo que o bloco do runner diz cobrir tem a sua seção no
 *      conjunto principal + fallback (nenhuma regra perdida no corte);
 *   5. que nem `orchestrator.md` nem a skill puxam o fallback por `@see`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readStage0Playbook, readStage1Playbook } from "../scripts/lib/stage01-playbook.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS = resolve(ROOT, ".claude/agents");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const agent = (f: string) => readFileSync(resolve(AGENTS, f), "utf8");

const S0_MAIN = "orchestrator-stage-0-preflight.md";
const S0_FALLBACK = "orchestrator-stage-0-fallback.md";
const S0_REPLIES = "orchestrator-stage-0-replies.md";
const S1_MAIN = "orchestrator-stage-1-research.md";
const S1_FALLBACK = "orchestrator-stage-1-fallback.md";

// Medido no #14030 + ~5-7% de folga. Antes: 71.042 (stage 0) e 81.422 (stage 1).
const BYTE_BUDGET: Record<string, number> = {
  [S0_MAIN]: 21_500,
  [S0_REPLIES]: 17_700,
  [S0_FALLBACK]: 39_500,
  [S1_MAIN]: 44_000,
  [S1_FALLBACK]: 46_500,
};

/** Bloco do runner: do cabeçalho "Runner determinístico" até o primeiro `---`. */
function runnerBlock(md: string): string {
  const start = md.indexOf("### Runner determinístico");
  assert.ok(start >= 0, "bloco do runner ausente");
  const end = md.indexOf("\n---\n", start);
  return md.slice(start, end === -1 ? undefined : end);
}

/** Primeiro token (id de seção) de cada string de DELEGATED_STEPS do script. */
function delegatedIds(scriptPath: string): string[] {
  const src = read(scriptPath);
  const start = src.indexOf("const DELEGATED_STEPS = [");
  assert.ok(start >= 0, `${scriptPath}: DELEGATED_STEPS ausente`);
  const block = src.slice(start, src.indexOf("];", start));
  const ids = [...block.matchAll(/^\s*"(§?[0-9][0-9a-z.\-]*)/gm)].map((m) => m[1].replace(/^§/, ""));
  assert.ok(ids.length > 0, `${scriptPath}: nenhum passo delegado extraído`);
  return ids;
}

/** A seção do id existe como cabeçalho `### {id}` ou item em negrito `**{id}`. */
function hasSection(md: string, id: string): boolean {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^### ${esc}(?![0-9a-z-])|\\*\\*${esc}(?![0-9a-z-]))`, "m").test(md);
}

describe("#14030: teto de bytes dos playbooks das Etapas 0 e 1", () => {
  for (const [file, max] of Object.entries(BYTE_BUDGET)) {
    it(`${file} ≤ ${max} bytes`, () => {
      const size = Buffer.byteLength(agent(file), "utf8");
      assert.ok(size <= max, `${file} tem ${size} bytes (teto ${max}). Prosa de fallback volta para ${file.includes("fallback") ? "o próprio fallback" : "o arquivo de fallback"}, não para o caminho principal.`);
    });
  }
});

describe("#14030: ponteiro para o fallback no ponto em que o runner manda ler", () => {
  it("Stage 0: passo 4 (Fallback) manda ler orchestrator-stage-0-fallback.md", () => {
    const block = runnerBlock(agent(S0_MAIN));
    const step4 = block.slice(block.indexOf("4. **Fallback**"));
    assert.match(step4.slice(0, 600), /orchestrator-stage-0-fallback\.md/);
  });
  it("Stage 0: HALT do code 2 cita §0d.bis no fallback, e a seção existe lá", () => {
    const block = runnerBlock(agent(S0_MAIN));
    const code2 = block.slice(block.indexOf("- `code: 2`"), block.indexOf("- `pendingAgentDispatch[]`"));
    assert.match(code2, /orchestrator-stage-0-fallback\.md` §0d\.bis/);
    assert.ok(agent(S0_FALLBACK).includes("### 0d.bis Maintain `valid_editions`"));
  });
  it("Stage 0: §0-replies no principal aponta para orchestrator-stage-0-replies.md e guarda a condição e o log de skip", () => {
    const main = agent(S0_MAIN);
    const sec = main.slice(main.indexOf("### 0-replies."), main.indexOf("### 0m."));
    assert.match(sec, /orchestrator-stage-0-replies\.md/);
    assert.match(sec, /pre_gate === true/);
    assert.match(sec, /0-replies skipped: headless --no-gates/);
    assert.match(sec, /0-replies skipped: Gmail MCP unavailable/);
  });
  it("§0-replies passo 1 traz o comando que imprime a query real (Stage 6 e Stage 1 interativo seguem os passos 1-5)", () => {
    const replies = agent(S0_REPLIES);
    const step1 = replies.slice(replies.indexOf("\n1. Buscar"), replies.indexOf("\n2. Para cada thread"));
    assert.ok(step1.includes(`npx tsx -e "import { buildRepliesSearchQuery } from './scripts/lib/newsletter-reply-addresses.ts'; console.log(buildRepliesSearchQuery())"`));
  });
  it("Stage 1: parágrafo Fallback manda ler orchestrator-stage-1-fallback.md", () => {
    const block = runnerBlock(agent(S1_MAIN));
    const fb = block.slice(block.indexOf("**Fallback**"));
    assert.match(fb.slice(0, 600), /orchestrator-stage-1-fallback\.md/);
  });
  it("Stage 1: HALT do code 2 cita as seções do fallback, e elas existem lá", () => {
    const block = runnerBlock(agent(S1_MAIN));
    const code2 = block.slice(block.indexOf("- `code: 2`"), block.indexOf("- `pendingAgentDispatch[]`"));
    const fallback = agent(S1_FALLBACK);
    for (const id of ["1h.7", "1w-quint", "1w-bis", "1w-quat"]) {
      assert.ok(code2.includes(`§${id}`), `code 2 não cita §${id}`);
      assert.ok(hasSection(fallback, id), `§${id} ausente do fallback`);
    }
  });
});

describe("#14030: passos delegados pelos runners ficam no arquivo principal", () => {
  const cases: Array<[string, string]> = [
    ["scripts/stage-0-run.ts", S0_MAIN],
    ["scripts/stage-1-run.ts", S1_MAIN],
  ];
  for (const [script, main] of cases) {
    for (const id of delegatedIds(script)) {
      it(`${script}: §${id} tem seção em ${main}`, () => {
        assert.ok(hasSection(agent(main), id), `§${id} é delegado pelo runner mas não tem seção em ${main} (só no fallback o orchestrator não o veria)`);
      });
    }
  }
  it("Stage 1: derive-stage1 roda na fase post-gate do runner, antes do sentinel, e o §1y diz isso", () => {
    const main = agent(S1_MAIN);
    const y = main.slice(main.indexOf("### 1y."));
    assert.match(y, /derive-editor-requests\.ts derive-stage1/);
    assert.match(y, /antes do sentinel desde o #14030/);
    const src = read("scripts/stage-1-run.ts");
    const deriveIdx = src.indexOf('"derive-stage1"');
    const sentinelIdx = src.indexOf('["write", "--edition", opts.edition, "--step", "1"');
    assert.ok(deriveIdx > -1 && sentinelIdx > deriveIdx, "runner deve chamar derive-stage1 antes de gravar o sentinel do Stage 1");
  });
});

describe("#14030: cada passo que o bloco do runner cobre tem seção no principal ou no fallback", () => {
  it("Stage 0: 0a, 0b-bis, 0c, 0d, 0d.bis, 0e-0h, 0i, 0j, 0k, 0l, 0o e 0z", () => {
    const all = readStage0Playbook(ROOT);
    // O bloco do runner lista os passos cobertos em prosa; "0e-0h" é a seção
    // "0e–0h" (travessão) e as subseções 0e, 0f, 0g, 0h.
    for (const id of ["0a", "0b-bis", "0c", "0d", "0d.bis", "0e", "0f", "0g", "0h", "0i", "0j", "0k", "0l", "0o", "0z"]) {
      assert.ok(hasSection(all, id), `§${id} sem seção no conjunto do Stage 0`);
    }
    assert.ok(all.includes("### 0e–0h."), "seção 0e–0h ausente");
  });
  it("Stage 1: todo §id citado nas fases do runner tem seção", () => {
    const main = agent(S1_MAIN);
    const all = readStage1Playbook(ROOT);
    const block = runnerBlock(main);
    // Numeração do runner que não bate com o cabeçalho do playbook (o runner
    // renumerou §1c/§1d/§1d-bis do playbook original como 1d/1e/1e-bis).
    const alias: Record<string, string> = { "1d": "1c", "1e": "1d", "1e-bis": "1d-bis" };
    // Já sem seção própria antes do corte (só descrito na lista de fases do
    // runner, #13341/#13662); não é perda do #14030.
    const knownWithoutSection = new Set(["1u-quinquies-b"]);
    const ids = new Set([...block.matchAll(/§(1[a-z](?:[.0-9]+|-[a-z]+)*)/g)].map((m) => m[1].replace(/\.\..*$/, "").replace(/\.$/, "")));
    const missing: string[] = [];
    for (const id of ids) {
      if (knownWithoutSection.has(id)) continue;
      const target = alias[id] ?? id;
      if (!hasSection(all, target) && !all.includes(`### ${target} `) && !all.includes(`/ ${target} `) && !all.includes(`/ ${target}.`)) missing.push(id);
    }
    assert.deepEqual(missing, [], `ids do runner sem seção: ${missing.join(", ")}`);
  });
});

describe("#14030: o fallback não é puxado por padrão", () => {
  it("orchestrator.md não faz @see dos arquivos de fallback/replies", () => {
    const root = agent("orchestrator.md");
    for (const f of [S0_FALLBACK, S0_REPLIES, S1_FALLBACK]) {
      assert.ok(!root.includes(`@see .claude/agents/${f}`), `orchestrator.md faz @see de ${f}`);
    }
  });
  it("cada arquivo de fallback se declara fora do caminho normal", () => {
    for (const f of [S0_FALLBACK, S1_FALLBACK]) {
      assert.match(agent(f), /não ler no caminho normal/);
    }
  });
});
