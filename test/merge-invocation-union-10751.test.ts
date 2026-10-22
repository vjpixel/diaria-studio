/**
 * #10751 — o detector do merge guard (#5716) devolve uma UNIÃO DISCRIMINADA
 * (`via`: `pr-merge` | `api-rest` | `api-graphql` | `opaque`) em vez de
 * `string[][]` com `targetUnknown` não-enumerável, onde `[]` tinha seis
 * sentidos indistinguíveis. "Nenhum merge" continua sendo a lista VAZIA.
 *
 * Refactor puro: as decisões (é merge? qual PR? quais repos? estrito?) são as
 * mesmas de antes — travadas pelas suítes do #10681/#10689/#10618/#10716. Aqui
 * se trava a FORMA de cada variante e o invariante "só `pr-merge` sai do modo
 * estrito" (`requiresStrict`), agora no tipo e não num comentário.
 *
 * Tudo sintético: nenhum merge é executado, nenhum config real do gh é lido
 * (todo caso passa `aliases` explícito).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractGhPrMergeTargetPr,
  findGhPrMergeInvocations,
  invocationTargetPr,
  isGhPrMergeCommand,
  mergeTargetHints,
  requiresStrict,
  type GhMergeInvocation,
} from "../.claude/hooks/lib/gh-pr-merge-command.mjs";
import * as targetRepo from "../.claude/hooks/lib/gh-target-repo.mjs";

const noAliases = { aliases: new Map<string, string | null>() };
const DESIGN = "vjpixel/diaria-design";
const STUDIO = "vjpixel/diaria-studio";
const noGit = () => {
  throw new Error("sem git");
};

function only(cmd: string, opts: { aliases: Map<string, string | null> } = noAliases): GhMergeInvocation {
  const all = findGhPrMergeInvocations(cmd, opts);
  assert.equal(all.length, 1, `${cmd} → ${JSON.stringify(all)}`);
  return all[0];
}

describe("#10751 — variante pr-merge", () => {
  it("gh pr merge literal: args depois de `merge`, não exige estrito", () => {
    const inv = only("gh pr merge 5 --squash");
    assert.deepEqual(inv, { via: "pr-merge", args: ["5", "--squash"] });
    assert.equal(requiresStrict(inv), false);
    assert.equal(invocationTargetPr(inv), 5);
  });

  it("-R global vai na frente dos args", () => {
    assert.deepEqual(only(`gh -R ${DESIGN} pr merge 7`), { via: "pr-merge", args: ["-R", DESIGN, "7"] });
  });

  it("sem número (o gh infere pela branch): pr-merge com args sem PR — nunca confundido com PR conhecida", () => {
    const inv = only("gh pr merge --squash");
    assert.deepEqual(inv, { via: "pr-merge", args: ["--squash"] });
    assert.equal(invocationTargetPr(inv), undefined);
  });

  it("alias legível que expande pra `pr merge` é pr-merge", () => {
    const inv = only("gh m 9", { aliases: new Map([["m", "pr merge"]]) });
    assert.deepEqual(inv, { via: "pr-merge", args: ["9"] });
  });
});

describe("#10751 — variante api-rest", () => {
  it("repo literal do caminho", () => {
    const inv = only(`gh api -X PUT repos/${DESIGN}/pulls/7/merge`);
    assert.deepEqual(inv, { via: "api-rest", repo: { kind: "literal", slug: DESIGN }, pr: 7 });
    assert.equal(requiresStrict(inv), true);
    assert.deepEqual(mergeTargetHints(`gh api -X PUT repos/${DESIGN}/pulls/7/merge`, noAliases), { repos: [DESIGN], unknown: false });
  });

  it("{owner}/{repo} = repo do diretório (não entra nos hints, não é indeterminado)", () => {
    const cmd = "gh api -X PUT repos/{owner}/{repo}/pulls/7/merge";
    assert.deepEqual(only(cmd), { via: "api-rest", repo: { kind: "cwd" }, pr: 7 });
    assert.deepEqual(mergeTargetHints(cmd, noAliases), { repos: [], unknown: false });
  });

  it("repo opaco, PR legível", () => {
    const cmd = "gh api -X PUT repos/$R/pulls/5/merge";
    assert.deepEqual(only(cmd), { via: "api-rest", repo: { kind: "unknown" }, pr: 5 });
    assert.equal(extractGhPrMergeTargetPr(cmd, noAliases), 5);
    assert.equal(mergeTargetHints(cmd, noAliases).unknown, true);
  });

  it("endpoint inteiro opaco: repo e PR desconhecidos", () => {
    const cmd = 'gh api -X PUT "$URL"';
    assert.deepEqual(only(cmd), { via: "api-rest", repo: { kind: "unknown" }, pr: null });
    assert.equal(extractGhPrMergeTargetPr(cmd, noAliases), undefined);
  });

  it("merge de branch (`merges`) e escrita em git/refs/heads: api-rest sem PR", () => {
    assert.deepEqual(only(`gh api -X POST repos/${DESIGN}/merges -f base=master -f head=x`), {
      via: "api-rest",
      repo: { kind: "literal", slug: DESIGN },
      pr: null,
    });
    assert.deepEqual(only(`gh api -X PATCH repos/${DESIGN}/git/refs/heads/master -f sha=abc`), {
      via: "api-rest",
      repo: { kind: "literal", slug: DESIGN },
      pr: null,
    });
  });
});

describe("#10751 — variante api-graphql", () => {
  it("mutation de merge: api-graphql, sem PR, repo indeterminado", () => {
    const cmd = "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'";
    const inv = only(cmd);
    assert.deepEqual(inv, { via: "api-graphql" });
    assert.equal(requiresStrict(inv), true);
    assert.equal(invocationTargetPr(inv), undefined);
    assert.deepEqual(mergeTargetHints(cmd, noAliases), { repos: [], unknown: true });
  });

  it("query ilegível (@arquivo) também é api-graphql (fail-closed)", () => {
    assert.deepEqual(only("gh api graphql -F query=@q.graphql"), { via: "api-graphql" });
  });
});

describe("#10751 — variante opaque (cada reason)", () => {
  const cases: Array<[string, string, string[], Map<string, string | null>?]> = [
    ["echo 5 | xargs gh", "xargs", []],
    ["echo 5 | xargs gh pr", "xargs", []],
    ["echo repos/o/r/pulls/5/merge | xargs gh api", "endpoint", []],
    ["gh $S merge 5", "subcommand", []],
    ["gh pr $M 5", "subcommand", ["5"]],
    ["gh m 5", "alias-unreadable", [], new Map([["m", null]])],
    ["gh alias import a.yml && gh foo 5", "alias-import", []],
    ["gh self 5", "alias-loop", [], new Map([["self", "self"]])],
  ];
  for (const [cmd, reason, args, aliases] of cases) {
    it(`${JSON.stringify(cmd)} → opaque/${reason}`, () => {
      const inv = only(cmd, { aliases: aliases ?? new Map() });
      assert.deepEqual(inv, { via: "opaque", reason, args });
      assert.equal(requiresStrict(inv), true);
      assert.equal(mergeTargetHints(cmd, { aliases: aliases ?? new Map() }).unknown, true);
    });
  }

  it("aninhamento além do teto → opaque/depth", () => {
    const cmd = `${"$(".repeat(12)}gh pr merge 5${")".repeat(12)}`;
    const all = findGhPrMergeInvocations(cmd, noAliases);
    assert.ok(all.length > 0);
    assert.ok(all.some((i) => i.via === "opaque" && i.reason === "depth"), JSON.stringify(all));
  });

  it("`gh pr $M 5`: o nº legível continua extraído (mesmo comportamento de antes)", () => {
    assert.equal(extractGhPrMergeTargetPr("gh pr $M 5", noAliases), 5);
  });

  it("opaque com -R legível ainda alimenta os repos dos hints", () => {
    assert.deepEqual(mergeTargetHints(`gh -R ${DESIGN} $S merge 5`, noAliases), { repos: [DESIGN], unknown: true });
  });
});

describe("#10751 — nenhum merge (lista vazia)", () => {
  for (const cmd of ["gh pr view 5", 'echo "gh pr merge 5"', "git merge origin/master", "gh api repos/o/r/pulls/5/merge"]) {
    it(`${JSON.stringify(cmd)} → []`, () => {
      assert.deepEqual(findGhPrMergeInvocations(cmd, noAliases), []);
      assert.equal(isGhPrMergeCommand(cmd, noAliases), false);
      assert.equal(extractGhPrMergeTargetPr(cmd, noAliases), undefined);
      assert.deepEqual(mergeTargetHints(cmd, noAliases), { repos: [], unknown: false });
      assert.equal(targetRepo.detectorConfirmsPlainMerge(cmd, noAliases), false);
    });
  }
});

describe("#10751 — requiresStrict / invocationTargetPr fail-closed em forma desconhecida", () => {
  it("objeto sem `via` conhecido exige estrito e não tem PR", () => {
    for (const bad of [undefined, null, {}, { via: "outra" }, ["5"]]) {
      assert.equal(requiresStrict(bad as unknown as GhMergeInvocation), true, JSON.stringify(bad));
      assert.equal(invocationTargetPr(bad as unknown as GhMergeInvocation), undefined);
    }
  });
});

describe("#10751 — comando encadeado/ambíguo continua no modo ESTRITO", () => {
  it("pr-merge seguido de GraphQL: detector não confirma merge simples; resolveMergeTargets estrito", () => {
    const cmd = "gh pr merge 5 --squash && gh api graphql -F query=@q.graphql";
    const all = findGhPrMergeInvocations(cmd, noAliases);
    assert.deepEqual(
      all.map((i) => i.via),
      ["pr-merge", "api-graphql"],
    );
    assert.equal(targetRepo.detectorConfirmsPlainMerge(cmd, noAliases), false);
    const res = targetRepo.resolveMergeTargets(cmd, "/x", { allowed: new Set([DESIGN]), env: {}, execFn: noGit, aliases: new Map() });
    assert.equal(res.mode, "strict");
    assert.equal(res.grantRepo, null);
    assert.ok(res.targets.includes(STUDIO) && res.targets.includes(DESIGN), res.targets.join(","));
  });

  it("dois `gh pr merge` encadeados: os dois são pr-merge; o último dá o nº", () => {
    const cmd = "gh pr merge 1; gh pr merge 2";
    assert.deepEqual(
      findGhPrMergeInvocations(cmd, noAliases).map((i) => i.via),
      ["pr-merge", "pr-merge"],
    );
    assert.equal(extractGhPrMergeTargetPr(cmd, noAliases), 2);
  });

  it("detector com opts inválido (aliases não-Map) → não confirma (fail-closed)", () => {
    assert.equal(
      targetRepo.detectorConfirmsPlainMerge("gh pr merge 5", { aliases: {} as unknown as Map<string, string | null> }),
      false,
    );
  });

  it("forma da whitelist estrita segue saindo do estrito (comportamento inalterado)", () => {
    assert.equal(targetRepo.detectorConfirmsPlainMerge("gh pr merge 5 --squash", noAliases), true);
    const res = targetRepo.resolveMergeTargets(`gh pr merge 5 --squash -R ${STUDIO}`, "/x", {
      allowed: new Set([DESIGN]),
      env: {},
      execFn: noGit,
      aliases: new Map(),
    });
    assert.equal(res.mode, "studio-plain");
    const foreign = targetRepo.resolveMergeTargets(`gh pr merge 23 --squash -R ${DESIGN}`, undefined, {
      allowed: new Set([DESIGN]),
      env: {},
      execFn: noGit,
      aliases: new Map(),
    });
    assert.equal(foreign.mode, "foreign-whitelist");
  });
});
