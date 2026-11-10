/**
 * test/intentional-error-30d-12612.test.ts (#12612)
 *
 * Regressão do caso 261030 → 261110: a 261110 declarou "DeepMing" (DeepMind),
 * entidade já usada como erro em 261030 ("DeepMinde"). O invariante só avisou
 * (warning) e o `replant-intentional-error.ts` devolveu `no_candidate` porque
 * o catálogo #5742 (10 marcas, 1 grafia cada) estava esgotado pela janela.
 *
 * Fixtures próprias — `data/` é gitignored e pode estar ausente no clone.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkIntentionalErrorNotRecentRepeat } from "../scripts/lib/intentional-error-repeat.ts";
import {
  listIntentionalErrorCandidates,
  proposeIntentionalErrorCandidate,
} from "../scripts/lib/propose-intentional-error-candidate.ts";
import { plantIntentionalError } from "../scripts/lib/plant-intentional-error.ts";
import { main as replantMain } from "../scripts/replant-intentional-error.ts";
import type { IntentionalError } from "../scripts/lib/intentional-errors.ts";

/** Recorte do histórico real dos 30 dias anteriores à 261110. */
const HISTORY: IntentionalError[] = [
  { edition: "261027", error_type: "ortografico", is_feature: true, correct_value: "ChatGPT", reveal: 'Na última edição, escrevi "ChatGTP" onde o correto é "ChatGPT".' },
  { edition: "261028", error_type: "ortografico", is_feature: true, correct_value: "Claude", reveal: 'Na última edição, escrevi "Craude" onde o correto é "Claude".' },
  { edition: "261029", error_type: "ortografico", is_feature: true, correct_value: "Anthropic", reveal: 'Na última edição, escrevi "Anthropik" onde o correto é "Anthropic".' },
  { edition: "261030", error_type: "ortografico", is_feature: true, correct_value: "DeepMind", reveal: 'Na última edição, escrevi "DeepMinde" onde o correto é "DeepMind".' },
  { edition: "261103", error_type: "ortografico", is_feature: true, correct_value: "Copilot", reveal: 'Na última edição, escrevi "Copilto" onde o correto é "Copilot".' },
  { edition: "261106", error_type: "ortografico", is_feature: true, correct_value: "Gemini", reveal: 'Na última edição, escrevi "Gemeni" onde o correto é "Gemini".' },
  { edition: "261109", error_type: "ortografico", is_feature: true, correct_value: "METR", wrong_value: "MTER", reveal: 'Na última edição, escrevi "MTER" onde o correto é "METR".' },
];
const JSONL = HISTORY.map((h) => JSON.stringify(h)).join("\n") + "\n";

const DEEPMING = {
  description: "Nome do DeepMind grafado errado no RADAR",
  location: "RADAR",
  category: "ortografico",
  correct_value: "DeepMind",
  wrong_value: "DeepMing",
  reveal: 'Na última edição, escrevi "DeepMing" onde o correto é "DeepMind".',
};

function editionFixture(record: object, jsonl: string | null, md?: string): { root: string; dir: string; jsonlPath: string } {
  const root = mkdtempSync(join(tmpdir(), "ie-12612-"));
  const dir = join(root, "data", "editions", "2611", "261110");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "intentional-error.json"), JSON.stringify(record));
  const jsonlPath = join(root, "data", "intentional-errors.jsonl");
  if (jsonl !== null) writeFileSync(jsonlPath, jsonl);
  if (md !== undefined) writeFileSync(join(dir, "02-reviewed.md"), md, "utf8");
  return { root, dir, jsonlPath };
}

const MD = (radar: string) => `**DESTAQUE 1 | 🤖 MODELOS**

**[O DeepMind e o Google](https://example.com/a)**

O DeepMind, a Nvidia e o Google aparecem aqui, mas é destaque.

---

**📡 RADAR**

**[Notícia lateral](https://example.com/b)**
${radar}

---

**ERRO INTENCIONAL**

Nessa edição, uma marca saiu grafada errada na seção RADAR.
`;

function captured<T>(fn: () => T): { result: T; stdout: string } {
  const [l, e] = [console.log, console.error];
  const out: string[] = [];
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = () => {};
  try {
    return { result: fn(), stdout: out.join("\n") };
  } finally {
    console.log = l;
    console.error = e;
  }
}

describe("#12612: entidade repetida em 30 dias é erro bloqueante", () => {
  it("261110 'DeepMing' repete a entidade de 261030 com outra grafia → error, não warning", () => {
    const { root, dir } = editionFixture(DEEPMING, JSONL);
    try {
      const v = checkIntentionalErrorNotRecentRepeat(dir);
      assert.equal(v.length, 1, "só a entidade repete; a grafia é nova");
      assert.equal(v[0].severity, "error");
      assert.equal(v[0].source_issue, "#12612");
      assert.match(v[0].message, /correct_value="DeepMind"/);
      assert.match(v[0].message, /261030/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("erro declarado à mão fora do catálogo (METR) também bloqueia dentro da janela", () => {
    const rec = { ...DEEPMING, correct_value: "METR", wrong_value: "MERT", reveal: "escrevi MERT no RADAR" };
    const { root, dir } = editionFixture(rec, JSONL);
    try {
      const v = checkIntentionalErrorNotRecentRepeat(dir);
      assert.deepEqual(v.map((x) => x.severity), ["error"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("mesma entidade fora da janela (31+ dias) → sem violação", () => {
    const old: IntentionalError[] = [{ ...HISTORY[3], edition: "261009" }];
    const { root, dir } = editionFixture(DEEPMING, null);
    try {
      assert.deepEqual(checkIntentionalErrorNotRecentRepeat(dir, { history: old }), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#12612: proposer nunca sugere entidade da janela e amplia o catálogo", () => {
  it("DeepMind na janela nunca é proposto, nem com outra grafia", () => {
    const all = [...listIntentionalErrorCandidates(MD("O DeepMind lançou algo."), { history: HISTORY, edition: "261110" })];
    assert.deepEqual(all, []);
  });

  it("com o tier 1 esgotado, cai no tier 2 (marca de tecnologia) em vez de no_candidate", () => {
    const c = proposeIntentionalErrorCandidate(MD("O DeepMind e o Google lançaram algo."), {
      history: HISTORY,
      edition: "261110",
    });
    assert.equal(c?.correct_value, "Google");
    assert.match(c!.description, /marca de tecnologia/);
  });

  it("tier 1 vem antes do tier 2 mesmo aparecendo depois no texto", () => {
    const c = proposeIntentionalErrorCandidate(MD("O Google e a Nvidia lançaram algo."), {
      history: HISTORY,
      edition: "261110",
    });
    assert.equal(c?.correct_value, "Nvidia");
  });

  it("grafia já usada (qualquer edição) cede a vez à próxima grafia da mesma marca", () => {
    const old: IntentionalError[] = [
      { edition: "260601", error_type: "ortografico", is_feature: true, correct_value: "Claude", reveal: "escrevi Craude no Radar" },
    ];
    const c = proposeIntentionalErrorCandidate(MD("Só o Claude."), { history: old, edition: "261110" });
    assert.equal(c?.correct_value, "Claude");
    assert.equal(c?.wrong_value, "Claudi");
  });

  it("narrativa do plantio acompanha o tipo da marca", () => {
    const md = MD("O Google lançou algo.").replace(/^Nessa edição,.*$/m, "Nessa edição, {PREENCHER_NARRATIVA_DO_ERRO}.");
    const c = proposeIntentionalErrorCandidate(md, { history: HISTORY, edition: "261110" })!;
    const planted = plantIntentionalError(md, c)!;
    assert.match(planted.md, /Nessa edição, o nome de uma marca de tecnologia bem conhecida/);
    assert.ok(planted.md.includes(`O ${c.wrong_value} lançou algo.`));
  });
});

describe("#12612: replant 261110 com DeepMind vetado", () => {
  it("replanta em outra marca (nunca DeepMind) e o resultado passa no invariante", () => {
    const { root, dir, jsonlPath } = editionFixture(DEEPMING, JSONL, MD("O DeepMind e o Google lançaram algo."));
    try {
      const { result, stdout } = captured(() => replantMain(["--edition-dir", dir, "--jsonl", jsonlPath]));
      assert.equal(result, 0, stdout);
      const json = JSON.parse(readFileSync(join(dir, "_internal", "intentional-error.json"), "utf8"));
      assert.equal(json.correct_value, "Google");
      const md = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      assert.match(md, /Nessa edição, o nome de uma marca de tecnologia bem conhecida saiu grafado errado na seção RADAR\./);
      assert.ok(md.includes("O DeepMind e o"), "DeepMind intacto no RADAR");
      assert.deepEqual(checkIntentionalErrorNotRecentRepeat(dir), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--entity DeepMind → vetado_pelo_historico, nada gravado", () => {
    const md = MD("O DeepMind e o Google lançaram algo.");
    const { root, dir, jsonlPath } = editionFixture(DEEPMING, JSONL, md);
    try {
      const { result, stdout } = captured(() =>
        replantMain(["--edition-dir", dir, "--jsonl", jsonlPath, "--entity", "DeepMind"]),
      );
      assert.equal(result, 1);
      assert.equal(JSON.parse(stdout).reason, "vetado_pelo_historico");
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), md);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
