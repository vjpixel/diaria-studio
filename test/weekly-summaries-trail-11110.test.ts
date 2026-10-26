/**
 * #11110: o agente `weekly-summary-writer` regrava `06-summaries.json` inteiro
 * só com {url,title,summary}, inclusive quando o SKILL pede (SendMessage) pra
 * reescrever UM item. Antes, o `snapshot` seguinte gravava o texto já
 * humanizado + corrigido dos outros itens como `summary_raw` e os mandava pelo
 * Humanizador e pela Clarice de novo. Regressão: reescrever 1 item preserva o
 * rastro dos outros, e eles não gastam Clarice de novo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  snapshotRaw,
  markHumanized,
  applyClarice,
  markClariceFailed,
  runClariceRest,
  manuallyEdited,
  trailPath,
  loadTrail,
} from "../scripts/weekly-summaries-passes.ts";
import type { WeeklySummariesFile } from "../scripts/lib/weekly-summaries.ts";

const URL_A = "https://example.com/a";
const URL_B = "https://example.com/b";

function agentOutput(bSummary = "Dois em cada três médicos já usam IA no consultório, e hospitais passam a responder pela auditoria."): WeeklySummariesFile {
  return {
    carouselKey: "261024-clicked",
    items: [
      { url: URL_A, title: "Mistral desafia ElevenLabs com voz mais barata", summary: "O Voxtral 3 monta atendentes que falam portugues por US$ 0,04 o minuto." },
      { url: URL_B, title: "CFM dá ao médico a palavra final sobre a máquina", summary: bSummary },
    ],
  };
}

/** Rodada completa: snapshot → Humanizador (edita A) → humanized → Clarice (corrige A). */
function fullRound(): WeeklySummariesFile {
  const d = agentOutput();
  snapshotRaw(d);
  d.items[0].summary = "O Voxtral 3 monta atendentes que falam portugues e ligam por US$ 0,04 o minuto.";
  markHumanized(d);
  applyClarice(d, { [URL_A]: [{ from: "portugues", to: "português" }], [URL_B]: [] }, "mcp");
  return d;
}

/** O agente reescreve só B, mas regrava o arquivo inteiro sem rastro. */
function agentRewritesB(trail: WeeklySummariesFile): WeeklySummariesFile {
  return {
    carouselKey: trail.carouselKey,
    items: trail.items.map((it) =>
      it.url === URL_B
        ? { url: it.url, title: it.title, summary: "Dois de cada três médicos já usam IA, e o hospital responde pela auditoria." }
        : { url: it.url, title: it.title, summary: it.summary },
    ),
  };
}

describe("weekly-summaries-passes: rastro sobrevive à reescrita parcial (#11110)", () => {
  it("reescrita de 1 item preserva summary_raw/humanized/clarice dos outros", () => {
    const trail = fullRound();
    const a = structuredClone(trail.items[0]);
    const d = agentRewritesB(structuredClone(trail));
    const r = snapshotRaw(d, trail);
    assert.deepEqual(r, { snapshotted: 1, restored: 1 });
    assert.equal(d.items[0].summary_raw, agentOutput().items[0].summary, "A mantém a versão do agente, não o texto final");
    assert.equal(d.items[0].summary_humanized, a.summary_humanized);
    assert.equal(d.items[0].summary_clarice, a.summary_clarice);
    assert.equal(d.items[1].summary_raw, d.items[1].summary, "B (reescrito) recebe snapshot fresco");
    assert.equal(d.items[1].summary_humanized, undefined);
    assert.equal(d.passes, undefined, "há item novo: passes zerados");
  });

  it("A não passa de novo pelo humanized nem pela Clarice; B passa", () => {
    const trail = fullRound();
    const a = structuredClone(trail.items[0]);
    const d = agentRewritesB(structuredClone(trail));
    snapshotRaw(d, trail);
    markHumanized(d);
    assert.equal(d.items[0].summary_humanized, a.summary_humanized, "humanized não sobrescreve A com o texto pós-Clarice");
    assert.deepEqual(manuallyEdited(d), [], "A finalizado não conta como ajuste manual");
    // Sugestões só pra B: A não precisa de chamada à Clarice.
    applyClarice(d, { [URL_B]: [{ from: "Dois de cada", to: "Dois em cada" }] }, "mcp");
    assert.equal(d.items[0].summary, a.summary);
    assert.equal(d.items[0].summary_clarice, a.summary_clarice);
    assert.match(d.items[1].summary, /^Dois em cada/);
    assert.equal(d.passes?.clarice, "ok");
  });

  it("REST: nenhuma chamada pra item já corrigido", async () => {
    const trail = fullRound();
    const d = agentRewritesB(structuredClone(trail));
    snapshotRaw(d, trail);
    markHumanized(d);
    const bodies: string[] = [];
    const fetchImpl = (async (_u: unknown, init?: { body?: string }) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ suggestions: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r = await runClariceRest(d, { apiKey: "x", fetchImpl, sleepFn: async () => {} });
    assert.equal(r.ok, true);
    assert.ok(bodies.length >= 1);
    assert.ok(bodies.every((b) => !b.includes("Voxtral")), "A (finalizado) não foi enviado à Clarice");
  });

  it("Clarice falhando não descarta a correção anterior de A", () => {
    const trail = fullRound();
    const a = structuredClone(trail.items[0]);
    const d = agentRewritesB(structuredClone(trail));
    snapshotRaw(d, trail);
    markHumanized(d);
    markClariceFailed(d, "MCP e REST fora");
    assert.equal(d.items[0].summary, a.summary);
    assert.equal(d.items[0].summary_clarice, a.summary_clarice);
  });

  it("agente regrava sem mudar nada: rastro e passes voltam do trail", () => {
    const trail = fullRound();
    const d: WeeklySummariesFile = {
      carouselKey: trail.carouselKey,
      items: trail.items.map((it) => ({ url: it.url, title: it.title, summary: it.summary })),
    };
    assert.deepEqual(snapshotRaw(d, trail), { snapshotted: 0, restored: 2 });
    assert.deepEqual(d.passes, trail.passes);
    // humanized de novo sem item novo mantém o registro da Clarice.
    markHumanized(d);
    assert.equal(d.passes?.clarice, "ok");
  });

  it("trail de outro carrossel é ignorado", () => {
    const trail = fullRound();
    const d = agentRewritesB(structuredClone(trail));
    d.carouselKey = "261031-clicked";
    assert.deepEqual(snapshotRaw(d, trail), { snapshotted: 2, restored: 0 });
  });

  it("CLI: o save grava o trail e o snapshot seguinte o usa", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-11110-"));
    const path = join(dir, "06-summaries.json");
    assert.equal(trailPath(path), join(dir, "06-summaries.trail.json"));
    writeFileSync(path, JSON.stringify(agentOutput()), "utf8");
    const run = () =>
      spawnSync(process.execPath, ["--import", "tsx", "scripts/weekly-summaries-passes.ts", "snapshot", "--path", path], { encoding: "utf8" });
    const r1 = run();
    assert.equal(r1.status, 0, r1.stderr);
    assert.ok(existsSync(trailPath(path)));
    assert.equal(loadTrail(path)?.items[0].summary_raw, agentOutput().items[0].summary);
    // Agente regrava o arquivo (B reescrito) sem rastro.
    writeFileSync(path, JSON.stringify(agentOutput("Hospitais passam a responder pela auditoria da IA usada por dois em cada três médicos.")), "utf8");
    const r2 = run();
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /1 resumo\(s\) do agente.*1 com rastro recuperado/);
    const after = JSON.parse(readFileSync(path, "utf8")) as WeeklySummariesFile;
    assert.equal(after.items[0].summary_raw, agentOutput().items[0].summary);
  });

  it("trail ilegível: aviso e snapshot fresco (sem lançar)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-11110-"));
    const path = join(dir, "06-summaries.json");
    writeFileSync(trailPath(path), "{ quebrado", "utf8");
    assert.equal(loadTrail(path), null);
  });
});
