import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveEffort,
  buildReviewInstruction,
  isOvernightRoundActive,
} from "../.claude/hooks/pr-create-review.mjs";

// #2754: overnight (token-sensitive) usa /code-review low; develop/manual
// (velocidade > tokens) mantém max. Regressão do PR que introduziu essa
// branch-detection — sem isso, todo PR (inclusive overnight/*) volta a pagar
// o custo do review multi-agente max por cima do self-review interno da skill.
//
// Todos os testes de resolveEffort injetam `checkRoundActive: () => false`
// explicitamente — sem isso, o default real (isOvernightRoundActive) leria
// `data/overnight/` do disco desta máquina, tornando o teste dependente de
// estado externo (uma rodada overnight genuinamente em progresso na máquina
// que roda a suíte mudaria o resultado).
const noActiveRound = () => false;
const activeRound = () => true;

describe("resolveEffort (#2754)", () => {
  it("branch overnight/* → low, sem warning", () => {
    const execFn = () => "overnight/fix-1234\n";
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "low");
    assert.equal(result.warning, null);
  });

  it("branch overnight/batch-social-1234 → low (prefixo, não match exato)", () => {
    const execFn = () => "overnight/batch-social-1234\n";
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "low");
  });

  it("branch develop/fix-1234, sem rodada ativa → max", () => {
    const execFn = () => "develop/fix-1234\n";
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "max");
    assert.equal(result.warning, null);
  });

  it("branch sem prefixo especial (manual), sem rodada ativa → max", () => {
    const execFn = () => "fix-something\n";
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "max");
  });

  it("gh indisponível/erro → fail-safe max", () => {
    const execFn = () => {
      throw new Error("gh: command not found");
    };
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "max");
    assert.equal(result.warning, null);
  });

  it("URL sem número de PR reconhecível → fail-safe max (nem chama execFn)", () => {
    let called = false;
    const execFn = () => {
      called = true;
      return "overnight/fix-1\n";
    };
    const result = resolveEffort("https://github.com/o/r/not-a-pr-url", execFn, noActiveRound);
    assert.equal(result.effort, "max");
    assert.equal(called, false, "não deveria invocar gh sem número de PR");
  });

  it("branch com substring 'overnight' mas não como prefixo, sem rodada ativa → max (evita false-positive)", () => {
    const execFn = () => "feature/overnight-related-refactor\n";
    const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
    assert.equal(result.effort, "max");
  });

  // #3322: guard determinístico independente de naming — regressão direta do
  // incidente #3321 (rodada 260710: ~50 PRs, zero com prefixo overnight/,
  // gating nunca disparou low a noite inteira).
  describe("guard de sessão ativa (#3322)", () => {
    it("branch sem prefixo overnight/ + rodada ativa → low, COM warning", () => {
      const execFn = () => "fix-3321-branch-naming\n";
      const result = resolveEffort("https://github.com/o/r/pull/1", execFn, activeRound);
      assert.equal(result.effort, "low");
      assert.match(result.warning, /não usa o prefixo overnight\//);
      assert.match(result.warning, /#3321/);
    });

    it("branch overnight/* + rodada ativa → low, SEM warning (naming já correto, nada a avisar)", () => {
      const execFn = () => "overnight/fix-1234\n";
      const result = resolveEffort("https://github.com/o/r/pull/1", execFn, activeRound);
      assert.equal(result.effort, "low");
      assert.equal(result.warning, null);
    });

    it("branch sem prefixo + SEM rodada ativa → max (guard não força low fora de rodada overnight)", () => {
      const execFn = () => "fix-something\n";
      const result = resolveEffort("https://github.com/o/r/pull/1", execFn, noActiveRound);
      assert.equal(result.effort, "max");
      assert.equal(result.warning, null);
    });

    it("checkRoundActive lançando erro → fail-safe max (mesma direção do resto do hook)", () => {
      const execFn = () => "fix-something\n";
      const throwingCheck = () => {
        throw new Error("disco indisponível");
      };
      const result = resolveEffort("https://github.com/o/r/pull/1", execFn, throwingCheck);
      assert.equal(result.effort, "max");
    });
  });
});

describe("buildReviewInstruction (#2754)", () => {
  it("effort=low menciona LOW effort e branch overnight", () => {
    const msg = buildReviewInstruction("https://github.com/o/r/pull/1", "low");
    assert.match(msg, /\/code-review low --comment/);
    assert.match(msg, /LOW effort/);
    assert.match(msg, /overnight branch/);
  });

  it("effort=max menciona ULTRACODE / maximum effort", () => {
    const msg = buildReviewInstruction("https://github.com/o/r/pull/1", "max");
    assert.match(msg, /\/code-review max --comment/);
    assert.match(msg, /ULTRACODE/);
  });

  it("nunca sugere cloud ultra, em nenhum effort", () => {
    for (const effort of ["low", "max"]) {
      const msg = buildReviewInstruction("https://github.com/o/r/pull/1", effort);
      assert.match(msg, /Do NOT use cloud `ultra`/);
    }
  });

  // #3322
  it("warning ausente (default) → nenhuma nota extra no texto", () => {
    const msg = buildReviewInstruction("https://github.com/o/r/pull/1", "low");
    assert.doesNotMatch(msg, /\[aviso:/);
  });

  it("warning presente → aparece anexado ao final da instrução", () => {
    const msg = buildReviewInstruction("https://github.com/o/r/pull/1", "low", "branch divergente do padrão");
    assert.match(msg, /\[aviso: branch divergente do padrão\]$/);
  });
});

// #3322: isOvernightRoundActive lida com o disco de verdade (via cwd injetado),
// não com o hook em si — cobre o schema de plan.json (issues terminais/não-terminais,
// machine_id cross-machine) isoladamente do resolveEffort acima.
//
// Cada caso usa sua PRÓPRIA raiz tmpdir (não uma pasta `data/overnight/` compartilhada
// com vários dirs AAMMDD): readTodayPlan sempre retorna o dir MAIS RECENTE com
// issues não-vazio, então reusar uma raiz entre casos faria um plan.json de um
// teste anterior "vazar" como fallback do caso seguinte.
describe("isOvernightRoundActive (#3322)", () => {
  const roots = [];

  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function freshRoot() {
    const root = join(tmpdir(), `pr-create-review-hook-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    return root;
  }

  function writePlan(root, dirName, plan) {
    const dir = join(root, "data", "overnight", dirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan.json"), JSON.stringify(plan), "utf8");
  }

  it("sem data/overnight/ no disco → false", () => {
    assert.equal(isOvernightRoundActive(freshRoot(), "host-a"), false);
  });

  it("plan.json com issue não-terminal (elegivel) → true", () => {
    const root = freshRoot();
    writePlan(root, "260710", {
      machine_id: "host-a",
      issues: [{ number: 1, status: "elegivel" }],
    });
    assert.equal(isOvernightRoundActive(root, "host-a"), true);
  });

  it("plan.json com TODAS as issues terminais → false (rodada encerrada)", () => {
    const root = freshRoot();
    writePlan(root, "260711", {
      machine_id: "host-a",
      issues: [
        { number: 1, status: "mergeada" },
        { number: 2, status: "pulada" },
      ],
    });
    assert.equal(isOvernightRoundActive(root, "host-a"), false);
  });

  it("plan.json de OUTRA máquina (machine_id diferente) → false, mesmo com issue não-terminal", () => {
    const root = freshRoot();
    writePlan(root, "260712", {
      machine_id: "host-b",
      issues: [{ number: 1, status: "elegivel" }],
    });
    assert.equal(isOvernightRoundActive(root, "host-a"), false);
  });

  it("plan.json sem machine_id (legado) → fail-open, não filtra por máquina", () => {
    const root = freshRoot();
    writePlan(root, "260713", {
      issues: [{ number: 1, status: "elegivel" }],
    });
    assert.equal(isOvernightRoundActive(root, "host-a"), true);
  });

  it("issues vazio → false (readTodayPlan não considera plan sem issues uma rodada real)", () => {
    const root = freshRoot();
    writePlan(root, "260714", { machine_id: "host-a", issues: [] });
    assert.equal(isOvernightRoundActive(root, "host-a"), false);
  });
});
