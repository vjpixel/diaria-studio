/**
 * test/pending-research-invariant-4990.test.ts (#4990)
 *
 * Cobre o invariant `pending-research-unresolved` em STAGE_5_RULES — o caso
 * EXATO do incidente #4990 (edição 260811): editor pede pesquisa adicional
 * pra USE MELHOR no gate do Stage 4, ela nunca é completada, e antes deste
 * fix nada avisava — a seção simplesmente sumia da edição publicada.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  checkPendingResearchUnresolved,
  STAGE_5_RULES,
} from "../scripts/lib/invariant-checks/stage-5.ts";
import { writePendingResearch, resolvePendingResearch } from "../scripts/lib/pending-research.ts";
import { makeEditionDir } from "./_helpers/make-edition-dir.ts";

function writeApproved(dir: string, buckets: Record<string, unknown[]>): void {
  writeFileSync(
    resolve(dir, "_internal", "01-approved.json"),
    JSON.stringify(buckets),
  );
}

describe("pending-research-unresolved registrado em STAGE_5_RULES (#4990)", () => {
  it("rule presente, severity warning (nunca bloqueia dispatch), não postDispatchOnly", () => {
    const rule = STAGE_5_RULES.find((r) => r.id === "pending-research-unresolved");
    assert.ok(rule, "pending-research-unresolved deve estar em STAGE_5_RULES");
    assert.equal(rule?.stage, 5);
    // #4516: precisa rodar em §5a (pre-dispatch) — não pode ser postDispatchOnly,
    // senão o warning só apareceria DEPOIS da publicação, tarde demais pro editor.
    assert.ok(!rule?.postDispatchOnly);
  });
});

describe("checkPendingResearchUnresolved (#4990 — regressão do incidente 260811)", () => {
  it(
    "REGRESSÃO: pesquisa pedida no gate Stage 4 + use_melhor:[] ao entrar no Stage 5 → warning explícito (nunca silencioso)",
    () => {
      const dir = makeEditionDir("pending-research-invariant-");
      try {
        // Reproduz o incidente: editor pede pesquisa no ajustar do Stage 4.
        writePendingResearch(
          dir,
          "use_melhor",
          "mais 2 tutoriais de RAG — pedido pelo editor no gate",
        );
        // A pesquisa nunca foi completada — use_melhor segue vazio ao entrar no Stage 5.
        writeApproved(dir, { use_melhor: [], radar: [{ url: "https://x.com/1" }] });

        const violations = checkPendingResearchUnresolved(dir);
        assert.equal(violations.length, 1);
        const v = violations[0];
        assert.equal(v.rule, "pending-research-unresolved");
        assert.equal(v.severity, "warning"); // nunca bloqueia — #4990 item 2, "avisar", não "impedir"
        assert.equal(v.source_issue, "#4990");
        assert.match(v.message, /use_melhor/);
        assert.match(v.message, /mais 2 tutoriais de RAG/);
      } finally {
        rmSync(dir, { recursive: true });
      }
    },
  );

  it("sem marker (fluxo normal, sem pesquisa pedida) → zero violations", () => {
    const dir = makeEditionDir("pending-research-invariant-");
    try {
      writeApproved(dir, { use_melhor: [] });
      const violations = checkPendingResearchUnresolved(dir);
      assert.equal(violations.length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("marker pending mas bucket já populado (pesquisa completada) → zero violations (auto-resolvido)", () => {
    const dir = makeEditionDir("pending-research-invariant-");
    try {
      writePendingResearch(dir, "use_melhor", "mais tutoriais");
      writeApproved(dir, { use_melhor: [{ url: "https://x.com/tutorial-novo" }] });
      const violations = checkPendingResearchUnresolved(dir);
      assert.equal(violations.length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("marker resolvido manualmente (editor desistiu do pedido) → zero violations", () => {
    const dir = makeEditionDir("pending-research-invariant-");
    try {
      writePendingResearch(dir, "use_melhor", "mais tutoriais");
      resolvePendingResearch(dir, "editor decidiu não perseguir");
      writeApproved(dir, { use_melhor: [] });
      const violations = checkPendingResearchUnresolved(dir);
      assert.equal(violations.length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
