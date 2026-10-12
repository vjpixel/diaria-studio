/**
 * test/route-marker-staleness-reconciler-10062.test.ts (#10062 item 4)
 *
 * Regressão: `route-marker-staleness` lia a assinatura do reconciliador
 * diário ("reconciliação diária (#6198): ...") como "razão cita issue
 * fechada #6198" e contava cada passada dele como renovação do agendamento
 * — falso positivo em #5995, #8543, #9265, #9846, #4554, #8548. Os
 * comentários abaixo reproduzem o formato real (#5995, 28/08 e 01/10).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRouteIssueMarker } from "../scripts/lib/issue-route.ts";
import { BACKLOG_RECONCILE_REASON_PREFIX } from "../scripts/lib/backlog-reconcile.ts";
import { findRouteMarkerStaleness, type IssueLookupState } from "../scripts/lib/route-marker-staleness.ts";

const NOW = new Date("2026-10-12T12:00:00Z");

function agendada(reason: string): string {
  return [formatRouteIssueMarker("agendada"), "", `Roteado para **agendada** — ${reason}`].join("\n");
}

function reconciler(date: string): string {
  return agendada(
    `${BACKLOG_RECONCILE_REASON_PREFIX} marcador aguardando-ate: ${date} coexistia com not-this-week — marcador ainda futuro, vence sobre o deferimento vago.`,
  );
}

const consultor = (states: Record<number, IssueLookupState>) => ({ getIssueState: (n: number) => states[n] ?? "UNKNOWN" });

function issueWith(comments: string[]) {
  return {
    number: 5995,
    labels: [],
    body: "<!-- aguardando-ate: 2026-10-14 -->",
    state: "OPEN" as const,
    comments,
  };
}

describe("route-marker-staleness ignora o reconciliador diário (#10062 item 4)", () => {
  it("caso real #5995: 2 roteamentos de sessão + 2 do reconciliador → nenhum achado", () => {
    const findings = findRouteMarkerStaleness(
      [
        issueWith([
          reconciler("2026-09-30"),
          agendada("marcador aguardando-ate corrigido de colchetes para comentario HTML"),
          agendada("servidor 300 só tem edições até 260911 — reavaliar em 14/10"),
          reconciler("2026-10-14"),
        ]),
      ],
      consultor({ 6198: "CLOSED" }),
      NOW,
    );
    assert.deepEqual(findings, []);
  });

  it("razão da última passada de SESSÃO continua sendo avaliada (o reconciliador posterior não a esconde)", () => {
    const findings = findRouteMarkerStaleness(
      [issueWith([agendada("aguarda #777 fechar"), reconciler("2026-10-14")])],
      consultor({ 777: "CLOSED", 6198: "CLOSED" }),
      NOW,
    );
    assert.deepEqual(
      findings.map((f) => f.category),
      ["agendada-motivo-cita-issue-fechada"],
    );
    assert.match(findings[0]!.detail, /#777/);
  });

  it("3 roteamentos de SESSÃO ainda contam como renovação múltipla", () => {
    const findings = findRouteMarkerStaleness(
      [issueWith([agendada("a"), reconciler("2026-10-14"), agendada("b"), agendada("c")])],
      consultor({}),
      NOW,
    );
    assert.deepEqual(
      findings.map((f) => f.category),
      ["agendada-renovada-multiplas-vezes"],
    );
    assert.match(findings[0]!.detail, /^3 comentários/);
  });

  it("backlog-reconcile.ts usa a mesma assinatura (fonte única)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../scripts/backlog-reconcile.ts", import.meta.url), "utf8");
    assert.match(src, /\$\{BACKLOG_RECONCILE_REASON_PREFIX\} marcador aguardando-ate:/);
  });
});
