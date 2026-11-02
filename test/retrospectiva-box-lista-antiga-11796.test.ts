/**
 * #11796 — `update-retrospectiva-box.ts` num snippet no formato novo (#9845)
 * que ainda traz a LISTA de benefícios gravada até 261101 (ex.: restaurado de
 * `data/snippets/_arquivo`): a lista tem de virar o `TIER_BLOCK` atual (texto
 * geral). Antes do fix o script trocava título, temas e CTA e deixava a lista
 * velha intacta — na edição 261103 foi preciso editar o snippet à mão.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RETROSPECTIVA_BOX_HEADER,
  TIER_BLOCK,
  applyRetrospectivaBoxUpdate,
  buildDefaultRetrospectivaBox,
  hasLegacyTierList,
  runUpdateRetrospectivaBox,
} from "../scripts/update-retrospectiva-box.ts";

const INPUT = {
  mesLabel: "Outubro",
  temas: ["tema a", "tema b", "tema c"],
  url: "https://retrospectiva.diar.ia.br/2610",
};

/** Lista exatamente como o `TIER_BLOCK` do #9845 a gravava (versão pós-#11205). */
const LEGACY_LIST = [
  "Quem apoia a partir de R$25/mês recebe:",
  "",
  "- a Retrospectiva do Mês por e-mail, com a edição completa na web",
  "- o Artigo Especial mensal",
  "- voto no tema do próximo Artigo Especial",
  '- nome na página "Apoiadores(as)" (opcional)',
].join("\n");

/** Snippet restaurado de `_arquivo`: formato novo, ciclo anterior, lista antiga. */
const RESTORED = `${RETROSPECTIVA_BOX_HEADER}

**Retrospectiva de Setembro**

Três temas marcaram o mês: **um**, **dois** e **três**. A Retrospectiva liga esses pontos e mostra as tendências por trás deles.

${LEGACY_LIST}

[Ler a Retrospectiva](https://retrospectiva.diar.ia.br/2609)
`;

describe("#11796 — lista antiga de benefícios vira o texto geral", () => {
  it("snippet restaurado com a lista: resultado idêntico ao seed do ciclo (lista some, TIER_BLOCK entra)", () => {
    assert.ok(hasLegacyTierList(RESTORED));
    const next = applyRetrospectivaBoxUpdate(RESTORED, INPUT);
    assert.equal(next, buildDefaultRetrospectivaBox(INPUT));
    assert.ok(!next.includes("Quem apoia"));
    assert.ok(!/^- /m.test(next), "nenhum item da lista antiga sobra");
    assert.equal((next.match(new RegExp(TIER_BLOCK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 1);
    assert.ok(!hasLegacyTierList(next));
    // idempotente
    assert.equal(applyRetrospectivaBoxUpdate(next, INPUT), next);
  });

  it("variante pré-#11205 (nome antigo da página) e valor diferente de R$25 também convertem", () => {
    const old = RESTORED.replace('"Apoiadores(as)"', '"Quem torna a Diar.ia possível"').replace("R$25", "R$30");
    assert.equal(applyRetrospectivaBoxUpdate(old, INPUT), buildDefaultRetrospectivaBox(INPUT));
  });

  it("CRLF: a conversão mantém CRLF em todas as linhas", () => {
    const crlf = RESTORED.replace(/\n/g, "\r\n");
    const next = applyRetrospectivaBoxUpdate(crlf, INPUT);
    assert.equal(next, buildDefaultRetrospectivaBox(INPUT).replace(/\n/g, "\r\n"));
    assert.ok(!/[^\r]\n/.test(next));
  });

  it("texto geral editado à mão (sem a lista) continua intocado", () => {
    const edited = buildDefaultRetrospectivaBox(INPUT).replace(TIER_BLOCK, "Apoiadores recebem tudo (editado à mão).");
    assert.ok(!hasLegacyTierList(edited));
    assert.ok(applyRetrospectivaBoxUpdate(edited, INPUT).includes("Apoiadores recebem tudo (editado à mão)."));
  });

  it("runner: snippet restaurado no disco sai convertido", () => {
    const tmp = mkdtempSync(join(tmpdir(), "retro-11796-"));
    try {
      const configPath = join(tmp, "platform.config.json");
      writeFileSync(configPath, JSON.stringify({ boxes_divulgacao: { slot2: "x.md" } }, null, 2) + "\n");
      const snippetsFile = join(tmp, "snippets", "retrospectiva-apoiadores.md");
      mkdirSync(join(tmp, "snippets"), { recursive: true });
      writeFileSync(snippetsFile, RESTORED);
      const r = runUpdateRetrospectivaBox({
        cycle: "2610-11",
        temas: INPUT.temas,
        unpin: false,
        pin: false,
        force: false,
        dryRun: false,
        snippetsFile,
        configPath,
        cycleDir: tmp,
      });
      assert.equal(r.action, "updated");
      assert.equal(readFileSync(snippetsFile, "utf8"), buildDefaultRetrospectivaBox(INPUT));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
