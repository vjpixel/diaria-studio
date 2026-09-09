/**
 * test/continuo-labels.test.ts (#7704)
 *
 * Regressão do bug que deixou `continuo-escalado` e `continuo-rejeitado`
 * SEM EXISTIR no repo desde que foram introduzidos (#7446 item 2 / #7567):
 * as três descrições de label passavam do teto de 100 caracteres do GitHub,
 * `gh label create` respondia `HTTP 422: description is too long`, e o erro
 * era engolido em todos os call sites (`|| true` no bash, `catch {}` no TS).
 * O `gh pr edit --add-label` seguinte falhava por label inexistente —
 * também em silêncio. Efeito: o pickup de PR rejeitada do §3 passo 1 de
 * `hermes-diaria-continuo/SKILL.md`, que dispara AO ACHAR o label, nunca
 * teve o que achar.
 *
 * Os testes aqui cobrem as 3 metades do conserto:
 *  1. cada descrição cabe no teto (o guard que faltava);
 *  2. `ensureContinuoLabel` distingue "já existe" de erro real, e recusa
 *     descrição longa ANTES de gastar a chamada;
 *  3. nenhum call site voltou a usar `gh label create`/`gh pr edit
 *     --add-label` — os dois comandos são o modo de falha, não o conserto.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTINUO_LABEL_SPECS,
  GITHUB_LABEL_DESCRIPTION_MAX,
  ensureContinuoLabel,
  type ContinuoLabelSpec,
} from "../scripts/lib/continuo-labels.ts";
import { CONTINUO_ESCALATED_LABEL } from "../scripts/lib/continuo-escalate-owner.ts";
import { CONTINUO_REJECTED_LABEL } from "../scripts/lib/continuo-reject-owner.ts";
import { CI_FIX_ATTEMPTED_LABEL } from "../scripts/lib/continuo-ci-fixer-eligibility.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fakeGh(status: number, stdout = "", stderr = "") {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return { status, stdout, stderr };
  };
  return { run, calls };
}

describe("specs dos labels do contínuo (#7704)", () => {
  it("as 3 descrições cabem no teto de 100 chars do GitHub — o 422 que deixou os labels sem existir", () => {
    for (const spec of CONTINUO_LABEL_SPECS) {
      assert.ok(
        spec.description.length <= GITHUB_LABEL_DESCRIPTION_MAX,
        `descrição de "${spec.name}" tem ${spec.description.length} chars (teto ${GITHUB_LABEL_DESCRIPTION_MAX}) — ` +
          `a API responderia 422 e o label nunca existiria (#7704)`,
      );
      assert.ok(spec.description.trim().length > 0, `descrição de "${spec.name}" não pode ser vazia`);
    }
  });

  it("o teto travado aqui é o do GitHub (100), não um número escolhido à toa", () => {
    assert.equal(GITHUB_LABEL_DESCRIPTION_MAX, 100);
  });

  it("nomes vêm das libs de decisão — criar e detectar leem o MESMO literal", () => {
    const names = CONTINUO_LABEL_SPECS.map((s) => s.name);
    assert.deepEqual(
      [...names].sort(),
      [CI_FIX_ATTEMPTED_LABEL, CONTINUO_ESCALATED_LABEL, CONTINUO_REJECTED_LABEL].sort(),
    );
  });

  it("cores são hex de 6 dígitos SEM '#' (formato que a API aceita)", () => {
    for (const spec of CONTINUO_LABEL_SPECS) {
      assert.match(spec.color, /^[0-9A-Fa-f]{6}$/, `cor inválida em "${spec.name}": ${spec.color}`);
    }
  });
});

describe("ensureContinuoLabel (#7704)", () => {
  it("descrição acima do teto falha ANTES de chamar gh — não gasta a chamada nem depende do 422", () => {
    const gh = fakeGh(0);
    const tooLong: ContinuoLabelSpec = {
      name: "x",
      color: "FFFFFF",
      description: "a".repeat(GITHUB_LABEL_DESCRIPTION_MAX + 1),
    };
    const res = ensureContinuoLabel(tooLong, ROOT, gh.run);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /acima do teto/);
    assert.equal(gh.calls.length, 0, "não deveria ter chamado gh");
  });

  it("criação bem-sucedida usa REST (POST .../labels), nunca `gh label create`", () => {
    const gh = fakeGh(0);
    const res = ensureContinuoLabel(CONTINUO_LABEL_SPECS[0], ROOT, gh.run);
    assert.equal(res.ok, true);
    assert.equal(res.outcome, "created");
    assert.deepEqual(gh.calls[0].slice(0, 4), ["api", "-X", "POST", "repos/{owner}/{repo}/labels"]);
    assert.ok(!gh.calls[0].includes("label"), "não pode cair no subcomando `gh label`");
  });

  it("422 'already_exists' é sucesso (idempotência), não erro", () => {
    const gh = fakeGh(1, "", 'HTTP 422: Validation Failed\n{"code":"already_exists"}');
    const res = ensureContinuoLabel(CONTINUO_LABEL_SPECS[0], ROOT, gh.run);
    assert.equal(res.ok, true);
    assert.equal(res.outcome, "exists");
  });

  it("422 de OUTRA natureza (descrição longa vinda do servidor) é falha real — o `|| true` do bash não fazia essa distinção", () => {
    const gh = fakeGh(1, "", "HTTP 422: Validation Failed\ndescription is too long (maximum is 100 characters)");
    const res = ensureContinuoLabel(CONTINUO_LABEL_SPECS[0], ROOT, gh.run);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /description is too long/);
  });

  it("falha de rede/auth é falha real", () => {
    const gh = fakeGh(1, "", "could not connect to api.github.com");
    const res = ensureContinuoLabel(CONTINUO_LABEL_SPECS[0], ROOT, gh.run);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /could not connect/);
  });
});

describe("call sites não voltam a usar os comandos que falhavam calados (#7704)", () => {
  const CALL_SITES = [
    "scripts/check-continuo-reject-label.ts",
    "scripts/check-continuo-escalate-label.ts",
    "scripts/mark-continuo-ci-fix-attempted.ts",
    "hermes/scripts/continuo-pr-review.sh",
  ];

  for (const rel of CALL_SITES) {
    it(`${rel} não executa \`gh pr edit --add-label\` nem \`gh label create\``, () => {
      const src = readFileSync(resolve(ROOT, rel), "utf8");
      // Só linhas de CÓDIGO: as docstrings/comentários explicam de propósito
      // por que esses comandos saíram, e citá-los ali é o registro do bug.
      const code = src
        .split("\n")
        .filter((line) => {
          const t = line.trim();
          return t !== "" && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("//") && !t.startsWith("#");
        })
        .join("\n");
      assert.ok(!/--add-label/.test(code), `${rel} ainda usa --add-label — use addPrLabelsRest (#6292/#7704)`);
      assert.ok(
        !/gh["'\s]+label["'\s]+create|"label",\s*\n?\s*"create"/.test(code),
        `${rel} ainda usa \`gh label create\` — use ensureContinuoLabel (#7704)`,
      );
    });
  }

  it("os 2 wrappers de label aplicam via addPrLabelsRest + ensureContinuoLabel", () => {
    for (const rel of ["scripts/check-continuo-reject-label.ts", "scripts/check-continuo-escalate-label.ts"]) {
      const src = readFileSync(resolve(ROOT, rel), "utf8");
      assert.match(src, /addPrLabelsRest/, `${rel} precisa aplicar o label por REST`);
      assert.match(src, /ensureContinuoLabel/, `${rel} precisa garantir que o label existe antes de aplicar`);
    }
  });

  it("continuo-pr-review.sh trata labelApplied=false como erro de infra, não segue em silêncio", () => {
    const src = readFileSync(resolve(ROOT, "hermes/scripts/continuo-pr-review.sh"), "utf8");
    assert.match(src, /escalate_label_not_applied/);
    assert.match(src, /reject_label_not_applied/);
  });
});
