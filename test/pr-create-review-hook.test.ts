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

// #3322: isOvernightRoundActive lida com o disco de verdade (via repoRoot/machineTag/now
// injetados), não com o hook em si. O marker é um arquivo dedicado por máquina
// (`data/overnight/.active-session-{tag}.json`) — não `plan.json` — então cada teste só
// precisa escrever esse único arquivo, sem se preocupar com "qual dir é mais recente"
// (a limitação que motivou uma raiz tmpdir isolada por caso na revisão anterior deste
// teste não existe mais aqui, mas mantemos raízes isoladas por clareza/hermeticidade).
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

  function writeMarker(root, tag, marker) {
    const dir = join(root, "data", "overnight");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `.active-session-${tag}.json`), JSON.stringify(marker), "utf8");
  }

  const NOW = Date.parse("2026-07-11T12:00:00.000Z");
  const ONE_HOUR_MS = 60 * 60 * 1000;

  it("sem marker no disco → false", () => {
    assert.equal(isOvernightRoundActive(freshRoot(), "host-a", NOW), false);
  });

  it("marker fresco (started_at recente) → true", () => {
    const root = freshRoot();
    writeMarker(root, "host-a", { started_at: new Date(NOW - ONE_HOUR_MS).toISOString() });
    assert.equal(isOvernightRoundActive(root, "host-a", NOW), true);
  });

  it("marker de OUTRA máquina (tag diferente no filename) → false, mesmo fresco", () => {
    const root = freshRoot();
    writeMarker(root, "host-b", { started_at: new Date(NOW - ONE_HOUR_MS).toISOString() });
    assert.equal(isOvernightRoundActive(root, "host-a", NOW), false);
  });

  it("marker mais velho que MAX_SESSION_AGE_MS (24h) → false (round abandonado não fica ativo pra sempre)", () => {
    const root = freshRoot();
    writeMarker(root, "host-a", { started_at: new Date(NOW - 25 * ONE_HOUR_MS).toISOString() });
    assert.equal(isOvernightRoundActive(root, "host-a", NOW), false);
  });

  // Achado da verificação adversarial pós-redesign: sem o guard `ageMs >= 0`, um
  // started_at no FUTURO (clock skew, marker corrompido/editado à mão) produz idade
  // negativa, que passa trivialmente em `<= MAX_SESSION_AGE_MS` — invertendo a
  // direção de fail-safe (deveria cair pro default caro/max, não pro barato/low).
  it("marker com started_at no FUTURO → false (clock skew/corrupção não pode virar 'ativo')", () => {
    const root = freshRoot();
    writeMarker(root, "host-a", { started_at: new Date(NOW + 10 * ONE_HOUR_MS).toISOString() });
    assert.equal(isOvernightRoundActive(root, "host-a", NOW), false);

    const rootFarFuture = freshRoot();
    writeMarker(rootFarFuture, "host-a", { started_at: new Date(NOW + 1000 * 24 * ONE_HOUR_MS).toISOString() }); // ~1000 dias no futuro
    assert.equal(isOvernightRoundActive(rootFarFuture, "host-a", NOW), false);
  });

  it("marker no limite (23h59) ainda conta como fresco; 24h01 já não conta", () => {
    const root = freshRoot();
    writeMarker(root, "host-a", { started_at: new Date(NOW - (24 * ONE_HOUR_MS - 60_000)).toISOString() });
    assert.equal(isOvernightRoundActive(root, "host-a", NOW), true);

    const root2 = freshRoot();
    writeMarker(root2, "host-a", { started_at: new Date(NOW - (24 * ONE_HOUR_MS + 60_000)).toISOString() });
    assert.equal(isOvernightRoundActive(root2, "host-a", NOW), false);
  });

  it("started_at ausente/malformado → false (nunca finge que está ativo por dado corrompido)", () => {
    const root = freshRoot();
    writeMarker(root, "host-a", { started_at: "not-a-real-date" });
    assert.equal(isOvernightRoundActive(root, "host-a", NOW), false);

    const root2 = freshRoot();
    writeMarker(root2, "host-a", {});
    assert.equal(isOvernightRoundActive(root2, "host-a", NOW), false);
  });

  it("JSON malformado no marker → fail-safe false", () => {
    const root = freshRoot();
    const dir = join(root, "data", "overnight");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".active-session-host-a.json"), "{not valid json", "utf8");
    assert.equal(isOvernightRoundActive(root, "host-a", NOW), false);
  });

  // Regressão direta do bug encontrado na revisão do PR: a versão anterior desta função
  // resolvia a raiz do repo a partir de `import.meta.url` (localização do PRÓPRIO arquivo
  // do hook), que aponta pro WORKTREE quando o hook roda de dentro de um worktree
  // linkado (exatamente o contexto de todo subagente implementador do overnight,
  // `isolation: "worktree"`) — e o worktree não tem a junction `data/`. A cobertura
  // dessa regressão específica (via `git rev-parse --git-common-dir` real, dentro de um
  // worktree real) está fora do escopo de um teste unitário puro (exige um worktree git
  // de verdade) — foi verificada manualmente durante a revisão deste PR. Este teste cobre
  // só a metade testável em unidade: `repoRoot` é sempre um parâmetro explícito, nunca
  // hardcoded, então o caller (produção: `resolveMainRepoRoot()`) é livre de resolver
  // corretamente sem exigir mudança nesta função.
  it("repoRoot é sempre parâmetro explícito — não há caminho hardcoded pro checkout principal", () => {
    const root = freshRoot();
    writeMarker(root, "any-tag", { started_at: new Date(NOW).toISOString() });
    assert.equal(isOvernightRoundActive(root, "any-tag", NOW), true);
    assert.equal(isOvernightRoundActive(freshRoot(), "any-tag", NOW), false);
  });
});
