/**
 * test/stage-playbook-byte-budget-14033.test.ts (#14033)
 *
 * Teto de BYTES por playbook de stage. O teto de linhas de
 * `test/orchestrator-prompt.test.ts` (#3445) não pegava o crescimento real:
 * o `orchestrator-stage-4.md` foi de 75 KB (#4816) a 218 KB com o mesmo
 * número de linhas subindo pouco, porque as linhas ficaram longas. Cada
 * releitura do playbook no gate custa o arquivo inteiro de contexto, então o
 * que pesa é o tamanho em bytes.
 *
 * Cada teto é o tamanho medido em 26/11/2026 (depois da divisão do Stage 4)
 * com ~5% de folga. Estourar exige decisão consciente: mover narrativa para
 * `docs/orchestrator-stage-narrative-history.md`, separar uma seção em
 * arquivo de referência citado explicitamente, ou subir o teto aqui com o
 * motivo no comentário.
 *
 * O cartão de receitas do gate (`context/stage-4-gate-receitas.md`) tem teto
 * fixo de 20 KB: ele é relido a cada pedido do editor no loop, e só compensa
 * enquanto for muito menor que o playbook que substitui.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ORCHESTRATOR_FILES } from "../scripts/lib/orchestrator-files.ts";
import { STAGE4_GATE_RECIPES_FILE, STAGE4_PLAYBOOK_FILES } from "../scripts/lib/stage4-playbook.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = resolve(ROOT, ".claude/agents");

const PER_FILE_BYTE_BUDGET: Record<string, number> = {
  "orchestrator.md": 18_500,
  // #14030: principal 20,1 KB / 41,7 KB; fallback e §0-replies em arquivos
  // próprios (tetos finos em test/stage01-playbook-split-14030.test.ts).
  "orchestrator-stage-0-preflight.md": 21_500,
  "orchestrator-stage-0-fallback.md": 39_500,
  "orchestrator-stage-0-replies.md": 17_700,
  "orchestrator-stage-1-research.md": 44_000,
  "orchestrator-stage-1-fallback.md": 46_500,
  "orchestrator-stage-2.md": 100_500,
  "orchestrator-stage-3.md": 23_000,
  "orchestrator-stage-4.md": 113_000,
  "orchestrator-stage-4-gate.md": 116_000,
  "orchestrator-stage-5.md": 92_000, // #14037 (PR #14082): wrapper concorrente + Brevo em background, ~87,5 KB
  "orchestrator-stage-6.md": 66_500,
};

const RECIPES_BYTE_BUDGET = 20 * 1024;

describe("#14033: teto de bytes dos playbooks de stage", () => {
  for (const file of ORCHESTRATOR_FILES) {
    it(`${file} cabe no teto de bytes`, () => {
      const budget = PER_FILE_BYTE_BUDGET[file];
      assert.ok(budget !== undefined, `${file} sem teto em PER_FILE_BYTE_BUDGET (#14033)`);
      const bytes = statSync(resolve(AGENTS_DIR, file)).size;
      assert.ok(bytes <= budget, `${file} tem ${bytes} bytes (teto ${budget}, #14033)`);
    });
  }

  it("todo arquivo com teto ainda existe na lista de playbooks", () => {
    for (const file of Object.keys(PER_FILE_BYTE_BUDGET)) {
      assert.ok((ORCHESTRATOR_FILES as readonly string[]).includes(file), `${file} tem teto mas saiu de ORCHESTRATOR_FILES`);
    }
  });

  it(`cartão de receitas do gate fica em até ${RECIPES_BYTE_BUDGET} bytes`, () => {
    const bytes = statSync(resolve(ROOT, STAGE4_GATE_RECIPES_FILE)).size;
    assert.ok(bytes <= RECIPES_BYTE_BUDGET, `${STAGE4_GATE_RECIPES_FILE} tem ${bytes} bytes (teto ${RECIPES_BYTE_BUDGET})`);
  });
});

describe("#14033: divisão do playbook da Etapa 4", () => {
  const pre = readFileSync(resolve(ROOT, STAGE4_PLAYBOOK_FILES[0]), "utf8");
  const gate = readFileSync(resolve(ROOT, STAGE4_PLAYBOOK_FILES[1]), "utf8");
  const recipes = readFileSync(resolve(ROOT, STAGE4_GATE_RECIPES_FILE), "utf8");

  it("pré-gate termina no §4c e manda ler o arquivo do gate, inclusive em auto_approve", () => {
    assert.ok(pre.includes("### 4c."), "pré-gate precisa ter o §4c");
    assert.ok(!pre.includes("### 4d. Gate humano"), "§4d saiu do pré-gate");
    assert.ok(!pre.includes("### 4e."), "§4e saiu do pré-gate");
    assert.match(pre, /orchestrator-stage-4-gate\.md/);
    assert.match(pre, /auto_approve = true[^\n]*§4e/);
    assert.match(pre, /stage-4-gate-receitas\.md/);
  });

  it("arquivo do gate tem §4d, §4d.1, §4d.1a, §4d.1b, §4e e a fronteira pós-gate, nessa ordem", () => {
    const markers = [
      "### 4d. Gate humano (#1694)",
      "### 4d.1 — Edição inline",
      "### 4d.1a — Cascata",
      "### 4d.1b — Promover item do pool",
      "### 4e. Escrever sentinel",
      "## Fluxo pós-gate — fronteira de contexto (#6171)",
    ];
    let last = -1;
    for (const m of markers) {
      const idx = gate.indexOf(m);
      assert.ok(idx > last, `${m} ausente ou fora de ordem no arquivo do gate`);
      last = idx;
    }
    assert.match(gate, /^---\nname: orchestrator-stage-4-gate\n/);
    assert.match(gate, /stage-4-gate-receitas\.md/);
  });

  it("narrativa movida para docs/ continua lá, citada pela âncora", () => {
    const history = readFileSync(resolve(ROOT, "docs/orchestrator-stage-narrative-history.md"), "utf8");
    for (const anchor of ["stage-4-pesquisa-nova-sincrona", "stage-4-fronteira-pos-gate-6171"]) {
      assert.ok(history.includes(`### ${anchor}`), `docs/ sem a seção ${anchor}`);
      assert.ok(gate.includes(`#${anchor}`), `o gate não cita ${anchor}`);
    }
  });

  it("cartão cobre os tipos de pedido da issue com os scripts do playbook", () => {
    const required = [
      "swap-destaque-link.ts",       // trocar link
      "remove-pool-item.ts",         // cortar item
      "move-pool-item.ts",           // mover item
      "reorder-destaques.ts",        // reordenar
      "swap-destaque.ts",            // trocar destaque (pool)
      "swap-destaques.ts",           // trocar destaque (URL nova)
      "promote-to-destaque.ts",      // promover (2 destaques)
      "splice-social-sections.ts",   // reescrever social
      "run-fact-checker.ts",         // refazer fact-check
      "stage4-cascade-status.ts",    // cascata
      "check-humanizer-social.ts",   // re-humanização
    ];
    for (const s of required) {
      assert.ok(recipes.includes(s), `cartão sem ${s}`);
      assert.ok(pre.includes(s) || gate.includes(s), `${s} citado no cartão mas ausente dos playbooks`);
    }
    assert.match(recipes, /vale o playbook|o playbook vence o cartão/);
  });
});
