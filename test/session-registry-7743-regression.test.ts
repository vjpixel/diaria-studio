// #7743 — regressão: record `continuo` sem o campo `attended` (legado,
// anterior ao #7546) precisa ser tratado como INALCANÇÁVEL nos DOIS lados
// que precisam concordar — `selfAuthorizeMerge` (scripts/lib/session-
// registry.ts) e `onlyUnreachableCoordinatorsActive` (.claude/hooks/block-
// gh-pr-merge-subagent.mjs). Chama as funções REAIS de produção (não
// reimplementa a fórmula) contra um record escrito cru em disco, exatamente
// como uma sessão `continuo` de longa duração que nunca passou por um
// `registerSession` desde o #7546 ficaria.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerSession, selfAuthorizeMerge, sessionsDir } from "../scripts/lib/session-registry.ts";
import { onlyUnreachableCoordinatorsActive } from "../.claude/hooks/block-gh-pr-merge-subagent.mjs";

function makeTempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "session-registry-7743-"));
  mkdirSync(sessionsDir(root), { recursive: true });
  return root;
}

describe("#7743 — selfAuthorizeMerge concorda com onlyUnreachableCoordinatorsActive sobre continuo sem attended", () => {
  const roots: string[] = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it("selfAuthorizeMerge: continuo com attended AUSENTE do disco não conta como coordenadora responsiva → autoriza", () => {
    const root = makeTempRepo();
    roots.push(root);
    // Record cru, sem a chave `attended` — o cenário real: uma sessão
    // `continuo` registrada antes do #7546 e ainda viva só de heartbeat
    // (`heartbeat()` nunca recomputa `attended`; só `registerSession` faz).
    writeFileSync(
      join(sessionsDir(root), "continuo-300-legado.json"),
      JSON.stringify({
        kind: "continuo",
        sessionId: "legado",
        machineTag: "300",
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
      }),
      "utf8",
    );
    registerSession(root, "interactive", "eu", {});

    const r = selfAuthorizeMerge(root, "eu", { reason: "#7743 regressão — continuo legado sem attended" });
    assert.equal(r.ok, true);
    assert.equal(r.reason, "authorized");
  });

  it("onlyUnreachableCoordinatorsActive concorda: mesmo scan (continuo, attended ausente) → true", () => {
    // Mesmo cenário do teste acima, mas contra a função REAL do hook — as
    // duas cópias da precedência de 3 níveis precisam bater sobre o mesmo
    // input, que é justamente o que o #7743 encontrou divergindo.
    assert.equal(
      onlyUnreachableCoordinatorsActive({
        kinds: new Map([["legado", "continuo"]]),
        attended: new Map(),
      }),
      true,
    );
  });

  it("controle: overnight com attended AUSENTE continua responsiva nas duas funções (fallback por kind só vale pra continuo)", () => {
    const root = makeTempRepo();
    roots.push(root);
    writeFileSync(
      join(sessionsDir(root), "overnight-300-legado.json"),
      JSON.stringify({
        kind: "overnight",
        sessionId: "legado",
        machineTag: "300",
        startedAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
      }),
      "utf8",
    );
    registerSession(root, "interactive", "eu", {});

    const r = selfAuthorizeMerge(root, "eu", { reason: "#7743 regressão — overnight legado sem attended, controle" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "responsive-coordinator-active");

    assert.equal(
      onlyUnreachableCoordinatorsActive({
        kinds: new Map([["legado", "overnight"]]),
        attended: new Map(),
      }),
      false,
    );
  });
});
