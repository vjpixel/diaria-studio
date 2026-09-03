/**
 * test/stage-4-intentional-error-present-in-final.test.ts (#7243)
 *
 * Cobre o registro do guard `intentional-error-present-in-final` em
 * `invariant-checks/stage-4.ts` — mesmo padrão de
 * test/stage-4-box-divulgacao-alt-invariant.test.ts (#4086).
 *
 * Reproduz o incidente real que motivou a #7243: edição 260902, um item de
 * RADAR carregava o erro intencional declarado ("Anthropik" em vez de
 * "Anthropic"), o editor podou o RADAR de 7 pra 3 itens no gate do Stage 4 e
 * levou junto o item com o erro — nada acusou, e o reveal da edição seguinte
 * ia publicar uma afirmação falsa. `checkIntentionalErrorPresentInFinal`
 * cruza `wrong_value` (#7243, campo novo — a grafia/valor ERRADO plantado,
 * irmão de `correct_value`) contra o texto final de `02-reviewed.md`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkIntentionalErrorPresentInFinal,
  STAGE_4_RULES,
} from "../scripts/lib/invariant-checks/stage-4.ts";
import type { IntentionalErrorJson } from "../scripts/lib/intentional-errors.ts";

/** MD com o item que carrega o erro ("Anthropik") ainda presente no RADAR. */
const MD_WITH_ERROR_ITEM = `Para esta edição, selecionamos 10 itens.

---

**RADAR**

**[Anthropik vai permitir que IA opere dispositivos físicos](https://example.com/a)**

---

**ERRO INTENCIONAL**

Nessa edição, há um erro proposital em algum lugar do texto. Responda este e-mail e concorra ao sorteio do mês.
`;

/**
 * Mesmo MD, mas o item com "Anthropik" foi removido (poda de RADAR real do
 * incidente 260902) e substituído por outro — o bloco ERRO INTENCIONAL
 * permanece intacto (só o item portador do erro sumiu).
 */
const MD_WITHOUT_ERROR_ITEM = `Para esta edição, selecionamos 10 itens.

---

**RADAR**

**[Claude escapou de testes e agiu na internet real](https://example.com/b)**

---

**ERRO INTENCIONAL**

Nessa edição, há um erro proposital em algum lugar do texto. Responda este e-mail e concorra ao sorteio do mês.
`;

/** MD sem nenhuma declaração de erro intencional (nem seção nem narrativa). */
const MD_NO_DECLARATION = `Para esta edição, selecionamos 10 itens.

---

**RADAR**

**[Alguma notícia qualquer](https://example.com/c)**
`;

function makeEdition(md: string | null, record: IntentionalErrorJson | null): string {
  const dir = mkdtempSync(join(tmpdir(), "stage4-intentional-error-final-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  if (md !== null) writeFileSync(resolve(dir, "02-reviewed.md"), md);
  if (record !== null) {
    writeFileSync(
      resolve(dir, "_internal", "intentional-error.json"),
      JSON.stringify(record, null, 2),
    );
  }
  return dir;
}

const RECORD_WITH_WRONG_VALUE: IntentionalErrorJson = {
  description: "Grafia errada do nome de uma empresa de IA no RADAR",
  location: "RADAR, item 1",
  category: "ortografico",
  correct_value: 'Anthropic (não "Anthropik")',
  wrong_value: "Anthropik",
  reveal: "Na última edição, escrevi Anthropik onde o correto é Anthropic.",
};

describe("checkIntentionalErrorPresentInFinal (#7243)", () => {
  it("retorna [] quando 02-reviewed.md não existe (stage não chegou lá)", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-ierr-no-md-"));
    try {
      assert.deepEqual(checkIntentionalErrorPresentInFinal(dir), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("retorna [] quando _internal/intentional-error.json não existe (nada declarado ainda)", () => {
    const dir = makeEdition(MD_WITH_ERROR_ITEM, null);
    try {
      assert.deepEqual(checkIntentionalErrorPresentInFinal(dir), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("retorna [] quando record.no_error === true (edição sem erro é estado legítimo, #2016/#2037)", () => {
    const dir = makeEdition(MD_WITHOUT_ERROR_ITEM, { no_error: true });
    try {
      assert.deepEqual(checkIntentionalErrorPresentInFinal(dir), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("retorna [] quando a edição não declara erro nenhum no texto (sem seção ERRO INTENCIONAL nem narrativa)", () => {
    // Record presente (ex: sessão retomada de checkpoint antigo) mas o MD
    // atual não tem nenhuma declaração visível — fora de escopo deste guard.
    const dir = makeEdition(MD_NO_DECLARATION, RECORD_WITH_WRONG_VALUE);
    try {
      assert.deepEqual(checkIntentionalErrorPresentInFinal(dir), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("warning quando wrong_value está ausente do record (não dá pra verificar mecanicamente)", () => {
    const dir = makeEdition(MD_WITH_ERROR_ITEM, {
      description: "algo",
      location: "RADAR",
      category: "ortografico",
      correct_value: "Anthropic",
      reveal: "Na última edição, escrevi X.",
      // wrong_value ausente de propósito
    });
    try {
      const v = checkIntentionalErrorPresentInFinal(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.equal(v[0].rule, "intentional-error-present-in-final");
      assert.equal(v[0].source_issue, "#7243");
      assert.match(v[0].message, /wrong_value/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("warning quando wrong_value é placeholder {PREENCHER...} não preenchido", () => {
    const dir = makeEdition(MD_WITH_ERROR_ITEM, {
      ...RECORD_WITH_WRONG_VALUE,
      wrong_value: "{PREENCHER — grafia/valor ERRADO plantado no texto, ex: Anthropik}",
    });
    try {
      const v = checkIntentionalErrorPresentInFinal(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("retorna [] quando wrong_value declarado ainda está presente no texto final", () => {
    const dir = makeEdition(MD_WITH_ERROR_ITEM, RECORD_WITH_WRONG_VALUE);
    try {
      assert.deepEqual(checkIntentionalErrorPresentInFinal(dir), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#7243 — reproduz o incidente 260902: error (GATE-BLOCKING) quando o item com wrong_value some do texto final", () => {
    const dir = makeEdition(MD_WITHOUT_ERROR_ITEM, RECORD_WITH_WRONG_VALUE);
    try {
      const v = checkIntentionalErrorPresentInFinal(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "error");
      assert.equal(v[0].rule, "intentional-error-present-in-final");
      assert.equal(v[0].source_issue, "#7243");
      assert.match(v[0].message, /Anthropik/);
      assert.match(v[0].message, /no_error/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("match é verbatim/case-sensitive — grafia com case diferente ainda conta como ausente", () => {
    const dir = makeEdition(
      `Para esta edição, selecionamos 10 itens.

---

**RADAR**

**[anthropik vai permitir algo](https://example.com/a)**

---

**ERRO INTENCIONAL**

Nessa edição, há um erro proposital em algum lugar do texto.
`,
      RECORD_WITH_WRONG_VALUE, // wrong_value: "Anthropik" (maiúsculo)
    );
    try {
      const v = checkIntentionalErrorPresentInFinal(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "error");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("STAGE_4_RULES registry (#7243)", () => {
  it("inclui intentional-error-present-in-final", () => {
    const ids = STAGE_4_RULES.map((r) => r.id);
    assert.ok(ids.includes("intentional-error-present-in-final"));
  });

  it("intentional-error-present-in-final está registrado no stage 4, source_issue #7243", () => {
    const entry = STAGE_4_RULES.find((r) => r.id === "intentional-error-present-in-final");
    assert.ok(entry);
    assert.equal(entry!.stage, 4);
    assert.equal(entry!.source_issue, "#7243");
  });
});
