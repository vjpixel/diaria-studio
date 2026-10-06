/**
 * test/use-melhor-gate-brand-9756.test.ts (#9756)
 *
 * Regressão: o Stage 5 pula o 4º post USE MELHOR quando o `## um` de
 * `# Social` cita a marca/URL diar.ia (#9628), mas o status do gate 4
 * (`describeUseMelhorPostStatus`, alimentado por `gatherUseMelhorStatusInput`)
 * mostrava "ok" — o editor só descobria o pulo depois do gate, sem poder
 * reescrever. Agora as duas pontas usam a mesma regra
 * (`useMelhorUmMentionsBrand`) e o teste de paridade abaixo trava que, pra
 * mesma edição em disco, gate e dispatch concordam.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  USE_MELHOR_BRAND_RE,
  describeUseMelhorPostStatus,
  useMelhorPostConfigState,
  useMelhorUmMentionsBrand,
  writeUseMelhorPostState,
} from "../scripts/lib/use-melhor-post.ts";
import { gatherUseMelhorStatusInput } from "../scripts/lib/use-melhor-status.ts";
import { planUseMelhorDispatch } from "../scripts/lib/use-melhor-dispatch.ts";

const ITEM = { url: "https://exame.com/guia-planilhas", title: "Guia de planilhas com IA", summary: "Resumo.", score: 88 };
const APPROVED = { use_melhor: [{ ...ITEM }] };
const REVIEWED = `**USE MELHOR**\n\n[${ITEM.title}](${ITEM.url})\nResumo do guia.\n`;
const UM_CLEAN = [
  "Um guia prático para planilhas, com exemplos de fórmulas.",
  "Como pedir fórmulas sem errar e revisar o resultado.",
  "Quando não confiar na resposta do modelo.",
  "#Planilhas #Produtividade",
].join("\n\n");
const CONFIG_ON = { publishing: { social: { use_melhor_time: "08:00" } } };

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function edition(umSocial: string): string {
  const dir = mkdtempSync(join(tmpdir(), "um-brand-9756-"));
  dirs.push(dir);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), REVIEWED);
  writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(APPROVED));
  writeFileSync(
    join(dir, "03-social.md"),
    ["# Social", "", "## d1", "", "Texto d1.", "", "## um", "", umSocial, "", "# Curto", "", "## um", "", "Curto do item. #Planilhas", ""].join("\n"),
  );
  writeUseMelhorPostState(dir, { enabled: true, time: "08:00", item: ITEM, generated_at: "x" });
  return dir;
}

describe("gate 4 avisa o pulo do 4º post por menção à marca (#9756)", () => {
  it("regex única: casa 'Diar.ia' e 'diar.ia.br', não casa texto sem a marca", () => {
    assert.ok(useMelhorUmMentionsBrand("Leia mais na Diar.ia."));
    assert.ok(useMelhorUmMentionsBrand("Tudo em https://diar.ia.br/p/x"));
    assert.ok(useMelhorUmMentionsBrand("veja a diar.ia.br"));
    assert.equal(useMelhorUmMentionsBrand(UM_CLEAN), false);
    assert.equal(useMelhorUmMentionsBrand(null), false);
    assert.equal(useMelhorUmMentionsBrand(""), false);
    assert.equal(USE_MELHOR_BRAND_RE.flags.includes("g"), false, "regex sem /g — .test() não pode ter estado");
  });

  for (const um of [`${UM_CLEAN}\n\nLeia mais na Diar.ia.`, `${UM_CLEAN}\n\nTudo em https://diar.ia.br/p/x`]) {
    it(`'## um' com a marca → gate warn E dispatch skip (paridade): ${um.slice(-30)}`, () => {
      const dir = edition(um);
      const cfg = useMelhorPostConfigState(CONFIG_ON);
      const input = gatherUseMelhorStatusInput(dir, cfg);
      assert.equal(input.socialUmMentionsBrand, true);
      const st = describeUseMelhorPostStatus(input);
      assert.equal(st.level, "warn");
      assert.ok(
        st.lines.some((l) => l.includes("4º post será pulado") && l.includes("cita a marca")),
        st.lines.join("\n"),
      );
      const plan = planUseMelhorDispatch(dir, CONFIG_ON);
      assert.equal(plan.status, "skip");
      assert.match(plan.status === "skip" ? plan.reason : "", /marca\/URL/);
    });
  }

  it("'## um' sem a marca → sem aviso de marca no gate e dispatch não pula por isso", () => {
    const dir = edition(UM_CLEAN);
    const input = gatherUseMelhorStatusInput(dir, useMelhorPostConfigState(CONFIG_ON));
    assert.equal(input.socialUmMentionsBrand, false);
    const st = describeUseMelhorPostStatus(input);
    assert.ok(!st.lines.some((l) => l.includes("cita a marca")), st.lines.join("\n"));
    const plan = planUseMelhorDispatch(dir, CONFIG_ON);
    assert.equal(plan.status, "ready");
  });

  it("input sem o campo (consumidores antigos) segue sem aviso de marca", () => {
    const st = describeUseMelhorPostStatus({
      config: useMelhorPostConfigState(CONFIG_ON),
      state: { enabled: true, time: "08:00", item: ITEM, generated_at: "x" },
      reviewedMd: REVIEWED,
      approved: APPROVED,
      hasSocialSection: true,
      hasCurtoSection: true,
      carouselSlots: ["cover", "p1", "cta"],
    });
    assert.ok(!st.lines.some((l) => l.includes("cita a marca")));
  });
});
