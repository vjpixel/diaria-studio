/**
 * test/wait-until-sync.test.ts (#5724)
 *
 * Cobre `scripts/lib/wait-until-sync.ts`. Casos exigidos pela issue:
 *   1. marcador inserido quando ausente.
 *   2. marcador ATUALIZADO (não duplicado) quando já existe.
 *   3. a data escrita nunca fica ANTES do `until` real.
 *   4. falha de rede/`gh` não impede a gravação local do override
 *      (`clarice-envio-override.ts --set`).
 *
 * Nenhum teste chama rede — `GhRunFn` é sempre um stub em memória, mesmo
 * padrão de `spawnGhSync` injetável já usado em `scripts/lib/alarm-issues.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseWaitUntil } from "../scripts/lib/issue-exec-track.ts";
import {
  clearWaitUntilMarkerOnIssue,
  computeWaitUntilMarkerDate,
  readIssueRefForClear,
  removeWaitUntilMarker,
  syncWaitUntilMarkerOnIssue,
  upsertWaitUntilMarker,
  type GhRunFn,
} from "../scripts/lib/wait-until-sync.ts";
import { setClariceEnvioOverride } from "../scripts/lib/clarice-envio-override.ts";

function freshRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `wait-until-sync-${label}-`));
}

/** Stub de `GhRunFn` que serve `gh issue view --json body` a partir de um
 * corpo em memória e grava `gh issue edit --body` de volta nele — sem
 * nenhuma chamada de rede/processo real. */
function fakeGh(initialBody: string, opts: { failView?: boolean; failEdit?: boolean } = {}): {
  run: GhRunFn;
  editedBodies: string[];
} {
  let body = initialBody;
  const editedBodies: string[] = [];
  const run: GhRunFn = (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      if (opts.failView) return { status: 1, stdout: "", stderr: "gh: not authenticated" };
      // `gh issue view --json body -q .body` real SEMPRE anexa 1 "\n" extra
      // ao stdout, mesmo quando o corpo de verdade não termina em newline —
      // reproduzido aqui de propósito (achado ao vivo contra a #5724) pra
      // testar que `fetchIssueBody` (`stripGhJqTrailingNewline`) desfaz isso
      // e nenhum ciclo fetch→edit acumula linha em branco.
      return { status: 0, stdout: `${body}\n`, stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "edit") {
      if (opts.failEdit) return { status: 1, stdout: "", stderr: "gh: rate limited" };
      const idx = args.indexOf("--body");
      const nextBody = args[idx + 1];
      body = nextBody;
      editedBodies.push(nextBody);
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  return { run, editedBodies };
}

describe("computeWaitUntilMarkerDate — nunca arredonda pra antes do until real", () => {
  it("until com hora não-zero sobe pro dia SEGUINTE", () => {
    // Caso real da #5673: until 09:00Z, marcador não pode implicar
    // meia-noite do MESMO dia (que ficaria 9h ANTES do prazo real).
    assert.equal(computeWaitUntilMarkerDate("2026-08-21T09:00:00.000Z"), "2026-08-22");
  });

  it("until exatamente à meia-noite UTC usa o próprio dia (já é o piso seguro)", () => {
    assert.equal(computeWaitUntilMarkerDate("2026-08-21T00:00:00.000Z"), "2026-08-21");
  });

  it("propriedade: Date(marker + T00:00:00Z) nunca é anterior ao until real", () => {
    const samples = [
      "2026-08-21T09:00:00.000Z",
      "2026-01-01T00:00:00.001Z",
      "2026-12-31T23:59:59.999Z",
      "2026-02-28T12:00:00.000Z",
    ];
    for (const iso of samples) {
      const ymd = computeWaitUntilMarkerDate(iso);
      const markerMs = Date.parse(`${ymd}T00:00:00Z`);
      assert.ok(
        markerMs >= Date.parse(iso),
        `marcador ${ymd} (${markerMs}) ficou ANTES do until real ${iso} (${Date.parse(iso)})`,
      );
    }
  });

  it("until não-parseável lança (mesmo contrato de setClariceEnvioOverride)", () => {
    assert.throws(() => computeWaitUntilMarkerDate("não é uma data"));
  });
});

describe("upsertWaitUntilMarker — insere quando ausente, atualiza sem duplicar quando presente", () => {
  it("insere no topo quando o corpo não tem marcador", () => {
    const body = "Contexto original da issue, sem marcador nenhum.";
    const next = upsertWaitUntilMarker(body, "2026-08-22");
    assert.equal(next, "<!-- aguardando-ate: 2026-08-22 -->\n\nContexto original da issue, sem marcador nenhum.");
    // e o classificador real reconhece o resultado:
    assert.equal(parseWaitUntil(next)?.toISOString().slice(0, 10), "2026-08-22");
  });

  it("substitui o marcador existente em vez de duplicar", () => {
    const body = "<!-- aguardando-ate: 2026-08-20 -->\n\nTexto original.";
    const next = upsertWaitUntilMarker(body, "2026-08-22");
    assert.equal(next, "<!-- aguardando-ate: 2026-08-22 -->\n\nTexto original.");
    // só 1 ocorrência do marcador — nunca 2 linhas concorrentes.
    const matches = next.match(/aguardando-ate:/g) ?? [];
    assert.equal(matches.length, 1);
  });

  it("chamar 2x com o mesmo until é idempotente byte-a-byte", () => {
    const body = "Prosa qualquer.";
    const once = upsertWaitUntilMarker(body, "2026-08-22");
    const twice = upsertWaitUntilMarker(once, "2026-08-22");
    assert.equal(once, twice);
  });
});

describe("removeWaitUntilMarker", () => {
  it("remove o marcador e a linha em branco seguinte", () => {
    const body = "<!-- aguardando-ate: 2026-08-22 -->\n\nTexto original.";
    assert.equal(removeWaitUntilMarker(body), "Texto original.");
  });

  it("no-op quando não há marcador", () => {
    const body = "Sem marcador aqui.";
    assert.equal(removeWaitUntilMarker(body), body);
  });
});

describe("syncWaitUntilMarkerOnIssue — I/O via GhRunFn injetado (sem rede)", () => {
  it("insere o marcador numa issue sem marcador prévio", () => {
    const { run, editedBodies } = fakeGh("Corpo original da issue.");
    const result = syncWaitUntilMarkerOnIssue(5673, "2026-08-21T09:00:00.000Z", "/repo", run);
    assert.equal(result.ok, true);
    assert.equal(result.action, "inserted");
    assert.equal(editedBodies.length, 1);
    assert.match(editedBodies[0], /^<!-- aguardando-ate: 2026-08-22 -->\n\nCorpo original da issue\.$/);
  });

  it("atualiza (não duplica) quando a issue já tem o marcador com outra data", () => {
    const { run, editedBodies } = fakeGh("<!-- aguardando-ate: 2026-08-19 -->\n\nCorpo original.");
    const result = syncWaitUntilMarkerOnIssue(5673, "2026-08-21T09:00:00.000Z", "/repo", run);
    assert.equal(result.action, "updated");
    assert.equal(editedBodies.length, 1);
    const matches = editedBodies[0].match(/aguardando-ate:/g) ?? [];
    assert.equal(matches.length, 1);
    assert.match(editedBodies[0], /aguardando-ate: 2026-08-22/);
  });

  it("noop (sem gh issue edit) quando o marcador já bate com a data esperada", () => {
    const { run, editedBodies } = fakeGh("<!-- aguardando-ate: 2026-08-22 -->\n\nCorpo original.");
    const result = syncWaitUntilMarkerOnIssue(5673, "2026-08-21T09:00:00.000Z", "/repo", run);
    assert.equal(result.action, "noop");
    assert.equal(editedBodies.length, 0);
  });

  it("falha de gh (view) devolve {ok:false}, nunca lança", () => {
    const { run } = fakeGh("Corpo original.", { failView: true });
    const result = syncWaitUntilMarkerOnIssue(5673, "2026-08-21T09:00:00.000Z", "/repo", run);
    assert.equal(result.ok, false);
    assert.equal(result.action, "failed");
    assert.match(result.error ?? "", /not authenticated/);
  });

  it("falha de gh (edit) devolve {ok:false}, nunca lança", () => {
    const { run } = fakeGh("Corpo original.", { failEdit: true });
    const result = syncWaitUntilMarkerOnIssue(5673, "2026-08-21T09:00:00.000Z", "/repo", run);
    assert.equal(result.ok, false);
    assert.equal(result.action, "failed");
    assert.match(result.error ?? "", /rate limited/);
  });

  it("regressão: extensões sucessivas do until NÃO acumulam linha em branco (o \\n que gh -q .body sempre anexa)", () => {
    const { run, editedBodies } = fakeGh("Corpo original.");
    // 1ª chamada: insere o marcador.
    const first = syncWaitUntilMarkerOnIssue(5673, "2026-08-21T09:00:00.000Z", "/repo", run);
    assert.equal(first.action, "inserted");
    // 2ª chamada: estende o prazo — se `fetchIssueBody` não descontasse o
    // "\n" artificial que `gh -q .body` sempre anexa, o corpo reusado aqui
    // já carregaria 1 linha em branco a mais, e esta 2ª edição escreveria
    // de volta 2.
    const second = syncWaitUntilMarkerOnIssue(5673, "2026-08-25T09:00:00.000Z", "/repo", run);
    assert.equal(second.action, "updated");
    // 3ª extensão, pra garantir que o padrão se mantém estável, não só na
    // 2ª iteração.
    const third = syncWaitUntilMarkerOnIssue(5673, "2026-08-30T09:00:00.000Z", "/repo", run);
    assert.equal(third.action, "updated");

    assert.equal(editedBodies.length, 3);
    for (const body of editedBodies) {
      assert.equal(
        (body.match(/\n{2,}/g) ?? []).length,
        1,
        `esperado exatamente 1 bloco de linha(s) em branco (entre marcador e prosa), achou: ${JSON.stringify(body)}`,
      );
    }
    assert.equal(editedBodies[2], "<!-- aguardando-ate: 2026-08-31 -->\n\nCorpo original.");
  });
});

describe("clearWaitUntilMarkerOnIssue", () => {
  it("remove o marcador quando presente", () => {
    const { run, editedBodies } = fakeGh("<!-- aguardando-ate: 2026-08-22 -->\n\nCorpo original.");
    const result = clearWaitUntilMarkerOnIssue(5673, "/repo", run);
    assert.equal(result.action, "removed");
    assert.equal(editedBodies[0], "Corpo original.");
  });

  it("noop quando não há marcador", () => {
    const { run, editedBodies } = fakeGh("Corpo sem marcador.");
    const result = clearWaitUntilMarkerOnIssue(5673, "/repo", run);
    assert.equal(result.action, "noop");
    assert.equal(editedBodies.length, 0);
  });
});

describe("readIssueRefForClear", () => {
  let root: string;

  it("lê issueRef do override em disco", () => {
    root = freshRoot("read-ref");
    mkdirSync(resolve(root, "data"), { recursive: true });
    setClariceEnvioOverride(root, {
      until: "2026-08-21T09:00:00.000Z",
      reason: "teste",
      decidedBy: "teste",
      issueRef: 5673,
      createdAt: "2026-08-19T01:03:00.000Z",
    });
    assert.equal(readIssueRefForClear(root), 5673);
    rmSync(root, { recursive: true, force: true });
  });

  it("arquivo ausente devolve undefined, sem lançar", () => {
    root = freshRoot("read-ref-missing");
    assert.equal(readIssueRefForClear(root), undefined);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("falha de rede/gh NUNCA impede a gravação local do override (#738)", () => {
  it("setClariceEnvioOverride grava o JSON local mesmo se a sincronização do marcador falhar depois", () => {
    const root = freshRoot("local-write-survives");
    const state = setClariceEnvioOverride(root, {
      until: "2026-08-21T09:00:00.000Z",
      reason: "teste — falha de rede não pode reverter isto",
      decidedBy: "teste",
      issueRef: 5673,
      createdAt: "2026-08-19T01:03:00.000Z",
    });
    assert.equal(state.issueRef, 5673);
    assert.ok(
      readFileSync(resolve(root, "data", "clarice-envio-override.json"), "utf8").includes("5673"),
      "override deveria ter sido persistido em disco ANTES de qualquer tentativa de sync com o GitHub",
    );

    // Simula exatamente o que o wiring do CLI faz em seguida: tenta
    // sincronizar o marcador, gh falha, e isso não desfaz nada acima.
    const { run } = fakeGh("Corpo original.", { failView: true });
    const marker = syncWaitUntilMarkerOnIssue(state.issueRef, state.until, root, run);
    assert.equal(marker.ok, false);

    // o override local continua intacto e legível após a falha de rede.
    const stillThere = JSON.parse(readFileSync(resolve(root, "data", "clarice-envio-override.json"), "utf8"));
    assert.equal(stillThere.issueRef, 5673);
    assert.equal(stillThere.until, "2026-08-21T09:00:00.000Z");
    rmSync(root, { recursive: true, force: true });
  });
});
