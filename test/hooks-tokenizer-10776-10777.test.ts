/**
 * #10776 / #10777 — achados do review consolidado diário nos hooks do #10618
 * (tokenizer de `gh pr create`/merge lock) e no detector de merge do
 * #10681/#10688.
 *
 * #10776:
 *   1. `splitShellWords` fechava a aspa dupla na 1ª `"` do corpo de um
 *      `--body "$(cat <<'EOF' … EOF)"` — o resto do corpo virava argumento do
 *      `gh pr create` e o guard de PII recusava PR legítima;
 *   2. `isForeignRepoGhCommand` olhava o texto do corpo — PR do diaria-design
 *      citando `vjpixel/diaria-studio#N` voltava a rodar os guards do studio;
 *   3. `combineMergeLockHolders` punha "indeterminado" acima de "livre".
 * #10777:
 *   1. `function f { gh pr merge 5; }` e `coproc gh pr merge 5` não eram vistos;
 *   2. a whitelist de heredoc-como-dado recusava o prefixo `cd X && `.
 *
 * Cada correção tem o falso positivo E o bypass que ela não pode abrir.
 * Nenhum `gh` é executado: só funções puras e `execFn` falso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as targetRepo from "../.claude/hooks/lib/gh-target-repo.mjs";
import { isGhPrMergeCommand, isHeredocDataCommand } from "../.claude/hooks/lib/gh-pr-merge-command.mjs";

// Hooks sem `.d.mts`: import por URL computada (evita TS7016 na catraca).
const { repoMismatchReason } = (await import(
  new URL("../.claude/hooks/block-pr-create-pii-runtime-artifacts.mjs", import.meta.url).href
)) as { repoMismatchReason: (command: string, cwd: string, originOf: (cwd: string) => string | null) => string | null };
type Holder = string | null | undefined;
const guard = (await import(new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url).href)) as {
  combineMergeLockHolders: (holders: Holder[], caller: string) => Holder;
  classifyMergeBlockCause: (coords: Set<string>, caller: string, ctx?: Record<string, unknown>) => string | null;
};

const DESIGN = "vjpixel/diaria-design";
const STUDIO = "vjpixel/diaria-studio";
const allowed = new Set([DESIGN]);
const originOf = (repo: string) => () => `https://github.com/${repo}.git`;
const noAliases = { aliases: new Map<string, string>() };

/** `gh pr create … --body "$(cat <<'EOF' <corpo> EOF)"` — a forma das rodadas. */
const createWithBody = (body: string, extra = "") =>
  `gh pr create --title "t"${extra} --body "$(cat <<'EOF'\n${body}\nEOF\n)"`;

describe("#10776 defeito 1 — splitShellWords trata $(…)/heredoc como palavra opaca", () => {
  it("aspa dupla no corpo do heredoc não fecha a aspa do --body", () => {
    const cmd = createWithBody(`Monitor de 27" em https://github.com/${DESIGN}/pull/23`);
    const words = targetRepo.splitShellWords(cmd);
    assert.equal(words.length, 7, JSON.stringify(words));
    assert.match(words[6], /^\$\(cat <<'EOF'\nMonitor de 27" em[\s\S]*\nEOF\n\)$/);
    assert.deepEqual(targetRepo.ghPrSegments(cmd, ["create"]), [{ repo: null, source: null, cd: null }]);
  });

  it("corpo citando `-R x/y` entre aspas não vira repo ilegível", () => {
    const cmd = createWithBody(`Antes "gh pr merge -R x/y" passava.`);
    assert.deepEqual(targetRepo.ghPrSegments(cmd, ["create"]), [{ repo: null, source: null, cd: null }]);
  });

  it("repoMismatchReason não recusa as duas PRs da issue (checkout do studio)", () => {
    const exec = () => STUDIO;
    assert.equal(repoMismatchReason(createWithBody(`Monitor de 27" em https://github.com/${DESIGN}/pull/23`), "/s", exec), null);
    assert.equal(repoMismatchReason(createWithBody(`Antes "gh pr merge -R x/y" passava.`), "/s", exec), null);
  });

  it("$( aninhado, aspas dentro da substituição e heredoc fechado em `D)`", () => {
    assert.deepEqual(targetRepo.splitShellWords(`gh pr create --body "$(echo "a -R x/y" $(echo ")"))" -R ${DESIGN}`), [
      "gh",
      "pr",
      "create",
      "--body",
      `$(echo "a -R x/y" $(echo ")"))`,
      "-R",
      DESIGN,
    ]);
    const early = `gh pr create --body "$(cat <<'EOF'\nx " y\nEOF)" -R ${DESIGN}`;
    assert.deepEqual(targetRepo.ghPrSegments(early, ["create"]), [{ repo: DESIGN, source: "flag", cd: null }]);
  });

  it("-R/URL FORA do corpo continuam lidos", () => {
    const cmd = createWithBody(`x " y`, ` -R ${DESIGN}`);
    assert.deepEqual(targetRepo.ghPrSegments(cmd, ["create"]), [{ repo: DESIGN, source: "flag", cd: null }]);
    assert.match(String(repoMismatchReason(cmd, "/s", () => STUDIO)), /mira vjpixel\/diaria-design/);
  });

  it("bypass: $(…)/crase em posição de argumento (pode render -R) é ilegível, não 'sem repo'", () => {
    for (const cmd of [
      `gh pr create $(echo -R ${DESIGN})`,
      "gh pr create `echo -R x/y`",
      `gh pr create --title t "$(printf -- '-R x/y')"`,
      `GH_REPO="$(echo ${DESIGN})" gh pr create`,
    ]) {
      assert.equal(targetRepo.ghPrSegments(cmd, ["create"])[0].source, "unparseable", cmd);
      assert.match(String(repoMismatchReason(cmd, "/s", () => STUDIO)), /ilegível/, cmd);
    }
  });

  it("--body=… colado não é lido como argumento", () => {
    const cmd = `gh pr create "--body=veja https://github.com/${DESIGN}/pull/1"`;
    assert.deepEqual(targetRepo.ghPrSegments(cmd, ["create"]), [{ repo: null, source: null, cd: null }]);
  });
});

describe("#10776 defeito 2 — isForeignRepoGhCommand ignora o texto inerte de --body/--title", () => {
  const isForeign = (cmd: string) => targetRepo.isForeignRepoGhCommand(cmd, "/design", { allowed, execFn: originOf(DESIGN) });

  it("PR do design cujo corpo cita a issue de origem no studio pula as regras do studio", () => {
    assert.equal(isForeign(createWithBody(`Origem: ${STUDIO}#10618`)), true);
    assert.equal(
      isForeign(`cd /design && gh pr create --title "fix (${STUDIO}#1)" --body "$(cat <<'EOF'\nOrigem: ${STUDIO}#10618\nEOF\n)"`),
      true,
    );
  });

  it("bypass: -R/GH_REPO do studio fora do corpo continua contando", () => {
    assert.equal(isForeign(createWithBody("x", ` -R ${STUDIO}`)), false);
    assert.equal(isForeign(`GH_REPO=${STUDIO} ${createWithBody("x")}`), false);
    assert.equal(isForeign(`bash -c "gh pr create -R ${STUDIO} --body x" && ${createWithBody("x")}`), false);
  });

  it("bypass: corpo que EXECUTA algo (delimitador sem aspas, outra substituição) segue contando", () => {
    assert.equal(isForeign(`gh pr create --title t --body "$(cat <<EOF\n${STUDIO} $(date)\nEOF\n)"`), false);
    assert.equal(isForeign(`gh pr create --title t --body "$(gh pr view 1 -R ${STUDIO})"`), false);
    // heredoc fecha cedo e outro comando roda dentro da substituição
    assert.equal(isForeign(`gh pr create --title t --body "$(cat <<'EOF'\nx\nEOF\ngh pr list -R ${STUDIO}\n)"`), false);
  });

  it("isInertMessageValue", () => {
    assert.equal(targetRepo.isInertMessageValue("texto com $VAR e vjpixel/diaria-studio"), true);
    assert.equal(targetRepo.isInertMessageValue("$(cat <<'EOF'\nOrigem \" ( )\nEOF\n)"), true);
    assert.equal(targetRepo.isInertMessageValue('$(cat <<"EOF"\nx\nEOF)'), true);
    assert.equal(targetRepo.isInertMessageValue("$(cat <<EOF\nx\nEOF\n)"), false);
    assert.equal(targetRepo.isInertMessageValue("$(cat <<'EOF'\nx\nEOF\n)sufixo"), false);
    assert.equal(targetRepo.isInertMessageValue("$(cat body.md)"), false);
    assert.equal(targetRepo.isInertMessageValue("`date`"), false);
  });
});

describe("#10776 defeito 3 — lock livre de um repo prevalece sobre indeterminado de outro", () => {
  it("combineMergeLockHolders: outra sessão > null > undefined > própria", () => {
    assert.equal(guard.combineMergeLockHolders([null, undefined], "c"), null);
    assert.equal(guard.combineMergeLockHolders([undefined, null], "c"), null);
    assert.equal(guard.combineMergeLockHolders([undefined, "c"], "c"), undefined);
    assert.equal(guard.combineMergeLockHolders([null, undefined, "outra"], "c"), "outra");
    assert.equal(guard.combineMergeLockHolders(["c", "c"], "c"), "c");
  });

  it("cenário da issue: studio livre + design indeterminado com 2 coordenadoras → bloqueia por contenção", () => {
    const holder = guard.combineMergeLockHolders([null, undefined], "coord-a");
    const cause = guard.classifyMergeBlockCause(new Set(["coord-a", "coord-b"]), "coord-a", { mergeLockHolder: holder });
    assert.equal(cause, "contention-multi-coordinator");
  });
});

describe("#10777 defeito 1 — function/coproc antes do gh pr merge", () => {
  for (const cmd of [
    "function f { gh pr merge 5; }; f",
    "function f {\n  gh pr merge 5 --squash\n}",
    "function f\n{ gh pr merge 5; }",
    "coproc gh pr merge 5",
    "coproc M { gh pr merge 5; }",
    "coproc { gh pr merge 5; }",
    "coproc M while true; do gh pr merge 5; done",
    "coproc env X=1 gh pr merge 5",
  ]) {
    it(`detecta: ${JSON.stringify(cmd)}`, () => assert.equal(isGhPrMergeCommand(cmd, noAliases), true));
  }
  for (const cmd of ["echo function f { gh pr merge 5; }", "function f { echo gh pr merge 5; }", "echo coproc gh pr merge 5"]) {
    it(`não detecta: ${JSON.stringify(cmd)}`, () => assert.equal(isGhPrMergeCommand(cmd, noAliases), false));
  }
});

describe("#10777 defeito 2 — whitelist de heredoc aceita prefixo `cd X && `", () => {
  const body = "Exemplo:\n```\ngh pr merge 5 --squash\n```";
  const withCd = (cd: string) => `${cd}gh pr create --title "t" --body "$(cat <<'EOF'\n${body}\nEOF\n)"`;

  it("corpo citando o merge, com e sem `cd`, não é merge", () => {
    for (const cd of ["", "cd /home/x/wt && ", 'cd "/c/Users/x/wt" && ', "cd C:/Users/x && "]) {
      assert.equal(isHeredocDataCommand(withCd(cd)), true, cd);
      assert.equal(isGhPrMergeCommand(withCd(cd), noAliases), false, cd);
    }
    const commit = `cd /wt && git commit -m "$(cat <<'EOF'\n${body}\nEOF\n)" && git push`;
    assert.equal(isGhPrMergeCommand(commit, noAliases), false);
  });

  it("bypass: cd com expansão, `;`, wrapper ou merge depois do fecho segue fail-closed", () => {
    for (const cmd of [
      withCd('cd "$(gh pr merge 5)" && '),
      withCd("cd $D && "),
      withCd("cd /wt; "),
      withCd("cd /wt && cd /x && "),
      withCd("env X=1 "),
      `cd /wt && gh pr create --title "t" --body "$(cat <<'EOF'\nx\nEOF\n)"; gh pr merge 5`,
    ]) {
      assert.equal(isGhPrMergeCommand(cmd, noAliases), true, cmd);
    }
  });
});
