/**
 * #7702 — `continuo` é rodada, mas não tem AUTORIDADE DE MERGE.
 *
 * O BUG: `COORDINATOR_KINDS` respondia duas perguntas diferentes com um
 * conjunto só — "há rodada ativa?" (que protege contra o subagente
 * implementador mergear o próprio PR, #5716) e "quem decide que um merge
 * entra?" (que bloqueia peers e concede janela via `grant-merge`).
 *
 * `continuo` só responde à primeira. `hermes/skills/hermes-diaria-continuo/
 * SKILL.md` — o skill que o cron do Hermes de fato roda, e o único consumidor
 * real do kind — diz em dois lugares que `continuo-pr-review.sh` é a **única
 * autoridade de merge**. O tick abre PR e para.
 *
 * A consequência era uma inversão: o kind que nunca mergeia bloqueava o
 * `gh pr merge` de todo mundo, e o que de fato mergeia (`continuo-review`)
 * não bloqueia ninguém. Como o cron roda `attended: false`, ele também não
 * respondia a `grant-merge` — toda sessão interativa que quisesse mergear com
 * o contínuo no ar (a maior parte do dia) era empurrada pro escape hatch do
 * #7303. Medido ao vivo em 09/09/2026 ao mergear a PR #7696.
 *
 * A REGRESSÃO QUE ESTA SUÍTE PROTEGE, e é a que importa: afrouxar o guard
 * pro caso interativo não pode afrouxá-lo pro SUBAGENTE. O discriminador é
 * o registro `interactive`, que subagente nunca tem (roda em worktree
 * vinculado, e `session-beacon.mjs` recusa registrar de lá).
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  classifyMergeBlockCause,
  everyActiveRoundLacksMergeAuthority,
  onlyUnreachableCoordinatorsActive,
  readLiveInteractiveRegistrationFor,
  sessionsDir,
  machineTag,
} from "../.claude/hooks/block-gh-pr-merge-subagent.mjs";
import { grantMergeWindow, requireCoordinatorKind } from "../scripts/lib/session-registry.ts";

const HOOK_PATH = fileURLToPath(
  new URL("../.claude/hooks/block-gh-pr-merge-subagent.mjs", import.meta.url),
);

describe("#7702 everyActiveRoundLacksMergeAuthority — pura", () => {
  const scanOf = (pairs: Array<[string, string]>) => ({ kinds: new Map(pairs) });

  it("só continuo ativo -> true (ninguém ativo decide merge)", () => {
    assert.equal(everyActiveRoundLacksMergeAuthority(scanOf([["c1", "continuo"]])), true);
  });

  it("overnight ativa -> false, mesmo com continuo junto", () => {
    assert.equal(
      everyActiveRoundLacksMergeAuthority(scanOf([["c1", "continuo"], ["o1", "overnight"]])),
      false,
    );
  });

  it("develop ativa -> false", () => {
    assert.equal(everyActiveRoundLacksMergeAuthority(scanOf([["d1", "develop"]])), false);
  });

  it("nenhuma rodada -> false (não é o caso desta leniência; quem trata é o ramo size===0)", () => {
    assert.equal(everyActiveRoundLacksMergeAuthority(scanOf([])), false);
    assert.equal(everyActiveRoundLacksMergeAuthority({}), false);
  });

  it("NÃO é a mesma pergunta de onlyUnreachableCoordinatorsActive (#7546)", () => {
    // overnight --unattended: INALCANÇÁVEL (não dá pra pedir janela) mas COM
    // autoridade de merge (há a quem pedir, em princípio). Precisa continuar
    // bloqueando — o caminho dela é o escape hatch do #7303, não esta
    // leniência. Colapsar as duas funções reabriria um bypass real.
    const scan = {
      kinds: new Map([["o1", "overnight"]]),
      attended: new Map([["o1", false]]),
    };
    assert.equal(onlyUnreachableCoordinatorsActive(scan), true, "é inalcançável");
    assert.equal(everyActiveRoundLacksMergeAuthority(scan), false, "MAS tem autoridade de merge");
  });
});

describe("#7702 classifyMergeBlockCause — a leniência destrava IDENTIDADE, não TEMPO", () => {
  const continuoOnly = new Set(["cron-1"]);
  const lenient = { roundsLackMergeAuthority: true, callerIsLiveInteractive: true };

  it("interativa registrada + só continuo ativo + lock livre -> passa a identidade, mas o lock ainda serializa", () => {
    // `contention-grantee` = "tem direito, falta pegar o lock". ANTES do
    // #7702 o motivo era `not-authorized` — direito nenhum, e a saída
    // documentada (pedir janela ao cron) era inalcançável.
    const cause = classifyMergeBlockCause(continuoOnly, "sess-interativa", {
      ...lenient,
      mergeLockHolder: null,
    });
    assert.equal(cause, "contention-grantee");
  });

  it("MESMO cenário com o lock já na mão da própria chamadora -> permite", () => {
    const cause = classifyMergeBlockCause(continuoOnly, "sess-interativa", {
      ...lenient,
      mergeLockHolder: "sess-interativa",
    });
    assert.equal(cause, null);
  });

  it("lock na mão de OUTRA sessão -> bloqueia antes de tudo (continuo-pr-review.sh mergeando agora)", () => {
    const cause = classifyMergeBlockCause(continuoOnly, "sess-interativa", {
      ...lenient,
      mergeLockHolder: "continuo-pr-review",
    });
    assert.equal(cause, "lock-held-other");
  });

  it("REGRESSÃO CRÍTICA: subagente (sem registro interactive) continua not-authorized", () => {
    // É a proteção inteira do #5716. Subagente roda em worktree vinculado e
    // o beacon recusa registrá-lo, então `callerIsLiveInteractive` é false —
    // a leniência não o alcança nem com o lock em mãos.
    const cause = classifyMergeBlockCause(continuoOnly, "subagente-da-rodada", {
      roundsLackMergeAuthority: true,
      callerIsLiveInteractive: false,
      mergeLockHolder: "subagente-da-rodada",
    });
    assert.equal(cause, "not-authorized");
  });

  it("REGRESSÃO: varredura DEGRADADA não pode habilitar a leniência", () => {
    // "só tem continuo" pode ser uma overnight que o I/O do OneDrive não
    // deixou ler. A regra deste guard é bloquear na dúvida.
    //
    // O motivo é `not-authorized` e não `scan-degraded` porque a leniência
    // desligada faz a chamada cair na PORTA DE IDENTIDADE, que é avaliada
    // antes do ramo de varredura degradada. O que importa aqui é que
    // BLOQUEIA — qual dos dois motivos nomeia o bloqueio é detalhe de ordem.
    const cause = classifyMergeBlockCause(continuoOnly, "sess-interativa", {
      ...lenient,
      scanDegraded: true,
      mergeLockHolder: "sess-interativa",
    });
    assert.equal(cause, "not-authorized");
    assert.notEqual(cause, null, "varredura degradada jamais pode PERMITIR");
  });

  it("REGRESSÃO: overnight ativa junto -> leniência desligada, volta a not-authorized", () => {
    const cause = classifyMergeBlockCause(new Set(["cron-1", "over-1"]), "sess-interativa", {
      roundsLackMergeAuthority: false,
      callerIsLiveInteractive: true,
      mergeLockHolder: "sess-interativa",
    });
    assert.equal(cause, "not-authorized");
  });
});

describe("#7702 readLiveInteractiveRegistrationFor", () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  function makeRoot(): string {
    const root = join(tmpdir(), `hook-7702-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    mkdirSync(sessionsDir(root), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: root });
    return root;
  }

  it("registro interactive vivo -> true", () => {
    const root = makeRoot();
    writeFileSync(
      join(sessionsDir(root), `interactive-${machineTag()}-sess-a.json`),
      JSON.stringify({
        kind: "interactive",
        sessionId: "sess-a",
        machineTag: machineTag(),
        lastHeartbeat: new Date().toISOString(),
      }),
      "utf8",
    );
    assert.equal(readLiveInteractiveRegistrationFor(root, "sess-a"), true);
  });

  it("sem registro nenhum (o caso do subagente) -> false", () => {
    assert.equal(readLiveInteractiveRegistrationFor(makeRoot(), "subagente"), false);
  });

  it("registro de kind COORDENADOR com o mesmo sessionId não conta como interactive", () => {
    const root = makeRoot();
    writeFileSync(
      join(sessionsDir(root), `continuo-${machineTag()}-sess-b.json`),
      JSON.stringify({
        kind: "continuo",
        sessionId: "sess-b",
        machineTag: machineTag(),
        lastHeartbeat: new Date().toISOString(),
      }),
      "utf8",
    );
    assert.equal(readLiveInteractiveRegistrationFor(root, "sess-b"), false);
  });

  it("registro interactive VELHO (> 15 min) não conta", () => {
    const root = makeRoot();
    writeFileSync(
      join(sessionsDir(root), `interactive-${machineTag()}-sess-c.json`),
      JSON.stringify({
        kind: "interactive",
        sessionId: "sess-c",
        machineTag: machineTag(),
        lastHeartbeat: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      }),
      "utf8",
    );
    assert.equal(readLiveInteractiveRegistrationFor(root, "sess-c"), false);
  });

  it("sessionId vazio/ausente -> false, nunca lança", () => {
    const root = makeRoot();
    assert.equal(readLiveInteractiveRegistrationFor(root, ""), false);
    assert.equal(readLiveInteractiveRegistrationFor(root, undefined as unknown as string), false);
  });
});

describe("#7702 grantMergeWindow / requireCoordinatorKind — continuo não concede o que não tem", () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  function makeRoot(): string {
    const root = join(tmpdir(), `hook-7702-grant-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    mkdirSync(join(root, "data", "sessions"), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: root });
    return root;
  }

  /** Registro em disco da concedente — `grantMergeWindow` escreve a
   *  concessão DENTRO do record dela, então sem arquivo sai
   *  `no-op-session-missing` antes de qualquer checagem de kind. */
  function writeCoordinatorRecord(root: string, kind: string, sessionId: string) {
    writeFileSync(
      join(root, "data", "sessions", `${kind}-${machineTag()}-${sessionId}.json`),
      JSON.stringify({
        kind,
        sessionId,
        machineTag: machineTag(),
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
      }),
      "utf8",
    );
  }

  it("continuo tentando conceder janela -> recusa 'not-a-coordinator'", () => {
    // Antes do #7702 isto SUCEDIA: continuo era coordenadora e podia
    // conceder uma janela de merge que ela própria nunca teve autoridade
    // pra dar. Era o que sustentava a ficção de que "peça a janela à
    // coordenadora ativa" era um caminho real quando a única ativa era o cron.
    const root = makeRoot();
    writeCoordinatorRecord(root, "continuo", "cron-1");
    const res = grantMergeWindow(root, "continuo", "cron-1", "sess-interativa", { pr: 7696 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "not-a-coordinator");
  });

  it("overnight e develop seguem concedendo normalmente", () => {
    for (const kind of ["overnight", "develop"] as const) {
      const root = makeRoot();
      writeCoordinatorRecord(root, kind, `coord-${kind}`);
      const res = grantMergeWindow(root, kind, `coord-${kind}`, "sess-interativa", { pr: 7696 });
      assert.equal(res.ok, true, `${kind} deveria continuar podendo conceder janela`);
    }
  });

  it("o gate de CLI concorda com grantMergeWindow — não aceita um kind que a função abaixo recusa", () => {
    // O gate dizia "só overnight/develop/continuo podem executar esta
    // operação" e deixava passar `--kind continuo`, que então falhava mais
    // fundo com `not-a-coordinator`. Validação afirmando permitido +
    // execução recusando = a inconsistência que este teste tranca.
    assert.equal(requireCoordinatorKind("overnight"), "overnight");
    assert.equal(requireCoordinatorKind("develop"), "develop");
    assert.throws(() => requireCoordinatorKind("continuo"), /não tem autoridade de merge/);
    assert.throws(() => requireCoordinatorKind("interactive"), /não tem autoridade de merge/);
  });
});

describe("#7702 entrypoint CLI — cenário real da PR #7696", () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  function makeRoot(): string {
    const root = join(tmpdir(), `hook-7702-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    mkdirSync(sessionsDir(root), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: root });
    return root;
  }

  function runHook(root: string, payload: Record<string, unknown>) {
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      cwd: root,
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10_000,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  function writeContinuoCron(root: string, now: string) {
    writeFileSync(
      join(sessionsDir(root), `continuo-${machineTag()}-cron-1.json`),
      JSON.stringify({
        kind: "continuo",
        sessionId: "cron-1",
        machineTag: machineTag(),
        lastHeartbeat: now,
        attended: false,
      }),
      "utf8",
    );
  }

  it("interativa registrada + cron continuo + lock adquirido -> PERMITE, sem self-authorize-merge", () => {
    const root = makeRoot();
    const now = new Date().toISOString();
    writeContinuoCron(root, now);
    writeFileSync(
      join(sessionsDir(root), `interactive-${machineTag()}-editor.json`),
      JSON.stringify({
        kind: "interactive",
        sessionId: "editor",
        machineTag: machineTag(),
        lastHeartbeat: now,
      }),
      "utf8",
    );
    writeFileSync(
      join(sessionsDir(root), ".merge-lock.json"),
      JSON.stringify({ heldBy: "editor", acquiredAt: now, pr: 7696 }),
      "utf8",
    );

    const res = runHook(root, {
      session_id: "editor",
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 7696 --squash --delete-branch" },
    });
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout.trim(),
      "",
      "REGRESSÃO #7702: sessão interativa voltou a ser bloqueada por um cron que não mergeia nada",
    );
  });

  it("MESMO root, mas a chamada vem de um subagente (sem registro) -> BLOQUEIA", () => {
    const root = makeRoot();
    const now = new Date().toISOString();
    writeContinuoCron(root, now);
    writeFileSync(
      join(sessionsDir(root), ".merge-lock.json"),
      // `heldBy`, não `sessionId` — é o campo real de `MergeLockRecord`. Com
      // a chave errada o lock parseia como CORROMPIDO e o bloqueio vinha do
      // ramo `lock-held-other`, não da porta de identidade que este teste diz
      // provar: passava pelo motivo errado, e um bypass real do #5716 não
      // seria detectado aqui (achado do pr-test-analyzer nesta PR).
      JSON.stringify({ heldBy: "subagente", acquiredAt: now, pr: 7696 }),
      "utf8",
    );

    const res = runHook(root, {
      session_id: "subagente",
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 7696 --squash" },
    });
    assert.equal(res.status, 0);
    assert.ok(
      res.stdout.trim() !== "",
      "REGRESSÃO #5716: subagente da rodada continua tendo que ser bloqueado",
    );
    assert.equal(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, "deny");
  });
});
