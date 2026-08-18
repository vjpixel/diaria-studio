import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ARM_RETENTION_SPECS,
  RETENTION_MIN,
  RETENTION_MAX_SPREAD,
  RETENTION_SMALL_SAMPLE,
  referrerHost,
  hostMatchesBucket,
  computeArmRetention,
  evaluateRetentionCut,
  exitCodeForOutcome,
  countInatribuiveis,
  renderRetentionMarkdown,
  type ArmRetention,
} from "../scripts/lib/utm-retention.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";

function sub(overrides: Partial<BeehiivBackupSubscriber> = {}): BeehiivBackupSubscriber {
  return {
    email: "x@example.com",
    status: "active",
    created: 1700000000,
    utm_source: "",
    utm_medium: "",
    utm_campaign: "",
    referring_site: "",
    stats: null,
    ...overrides,
  };
}

const META = ARM_RETENTION_SPECS.find((s) => s.utmSource === "meta-ads")!;
const GOOGLE = ARM_RETENTION_SPECS.find((s) => s.utmSource === "google-ads")!;

describe("referrerHost", () => {
  it("extrai host de URL completa e remove www.", () => {
    assert.equal(referrerHost("https://www.facebook.com/algo?x=1"), "facebook.com");
    assert.equal(referrerHost("https://l.facebook.com/"), "l.facebook.com");
  });

  it("aceita host cru sem esquema", () => {
    assert.equal(referrerHost("instagram.com"), "instagram.com");
  });

  it("aceita token sem TLD (android.googlequicksearchbox)", () => {
    assert.equal(referrerHost("android.googlequicksearchbox"), "android.googlequicksearchbox");
  });

  it("vazio/whitespace vira string vazia (nunca crash)", () => {
    assert.equal(referrerHost(""), "");
    assert.equal(referrerHost("   "), "");
  });
});

describe("hostMatchesBucket", () => {
  it("casa host exato e subdomínio", () => {
    assert.equal(hostMatchesBucket("facebook.com", "facebook.com"), true);
    assert.equal(hostMatchesBucket("m.facebook.com", "facebook.com"), true);
  });

  it("NÃO casa por substring solta — o bug clássico deste tipo de balde", () => {
    assert.equal(hostMatchesBucket("notfacebook.com", "facebook.com"), false);
    assert.equal(hostMatchesBucket("facebook.com.br", "facebook.com"), false);
  });

  it("vazio nunca casa", () => {
    assert.equal(hostMatchesBucket("", "facebook.com"), false);
    assert.equal(hostMatchesBucket("facebook.com", ""), false);
  });
});

describe("computeArmRetention", () => {
  it("conta atribuídos pelo utm_source do braço", () => {
    const r = computeArmRetention([sub({ utm_source: "meta-ads" }), sub({ utm_source: "meta-ads" })], META);
    assert.equal(r.atribuidos, 2);
    assert.equal(r.orfaos, 0);
    assert.equal(r.retencao, 1);
  });

  it("conta como órfão só quem tem utm_source VAZIO e referrer da plataforma", () => {
    const r = computeArmRetention(
      [
        sub({ utm_source: "meta-ads" }),
        sub({ utm_source: "", referring_site: "https://l.facebook.com/" }),
        sub({ utm_source: "", referring_site: "https://instagram.com/" }),
      ],
      META,
    );
    assert.equal(r.atribuidos, 1);
    assert.equal(r.orfaos, 2);
    assert.equal(r.retencao, 1 / 3);
  });

  it("cadastro com utm_source de OUTRO braço não vira órfão deste", () => {
    // Regressão: contá-lo aqui inflaria o denominador do Meta e deprimiria a
    // retenção dele por causa de um cadastro que é do Google.
    const r = computeArmRetention(
      [sub({ utm_source: "meta-ads" }), sub({ utm_source: "google-ads", referring_site: "https://facebook.com/" })],
      META,
    );
    assert.equal(r.atribuidos, 1);
    assert.equal(r.orfaos, 0);
    assert.equal(r.retencao, 1);
  });

  it("referrer fora do balde do braço é ignorado", () => {
    const r = computeArmRetention([sub({ utm_source: "", referring_site: "https://bing.com/" })], META);
    assert.equal(r.orfaos, 0);
    assert.equal(r.retencao, null);
  });

  it("denominador 0 produz retenção null — nunca 1,0 otimista por omissão", () => {
    const r = computeArmRetention([], META);
    assert.equal(r.retencao, null);
    assert.equal(r.amostraPequena, false);
  });

  it("marca amostra pequena abaixo do limiar, sem esconder o número", () => {
    const r = computeArmRetention([sub({ utm_source: "meta-ads" })], META);
    assert.equal(r.retencao, 1);
    assert.equal(r.amostraPequena, true);

    const muitos = Array.from({ length: RETENTION_SMALL_SAMPLE }, () => sub({ utm_source: "meta-ads" }));
    assert.equal(computeArmRetention(muitos, META).amostraPequena, false);
  });

  it("agrega órfãos por host pra investigação", () => {
    const r = computeArmRetention(
      [
        sub({ utm_source: "", referring_site: "https://l.facebook.com/" }),
        sub({ utm_source: "", referring_site: "https://l.facebook.com/" }),
        sub({ utm_source: "", referring_site: "https://instagram.com/" }),
      ],
      META,
    );
    assert.deepEqual(r.orfaosPorHost, { "l.facebook.com": 2, "instagram.com": 1 });
  });

  it("balde do Google pega android.googlequicksearchbox", () => {
    const r = computeArmRetention([sub({ utm_source: "", referring_site: "android.googlequicksearchbox" })], GOOGLE);
    assert.equal(r.orfaos, 1);
  });
});

function arm(canal: string, atribuidos: number, orfaos: number): ArmRetention {
  const den = atribuidos + orfaos;
  return {
    canal,
    utmSource: `${canal}-src`,
    atribuidos,
    orfaos,
    retencao: den > 0 ? atribuidos / den : null,
    amostraPequena: den > 0 && den < RETENTION_SMALL_SAMPLE,
    orfaosPorHost: {},
  };
}

describe("evaluateRetentionCut", () => {
  it("passa quando TODOS os braços estão medidos, acima do mínimo e juntos", () => {
    const v = evaluateRetentionCut([arm("A", 95, 5), arm("B", 96, 4), arm("C", 94, 6)]);
    assert.equal(v.outcome, "passa");
    assert.deepEqual(v.motivos, []);
  });

  it("reprova braço abaixo de RETENTION_MIN", () => {
    const v = evaluateRetentionCut([arm("A", 80, 20), arm("B", 95, 5)]);
    assert.equal(v.outcome, "reprova");
    assert.ok(v.motivos.some((m) => m.includes("A") && m.includes("reten")));
  });

  it("limiar do mínimo é exclusivo: exatamente RETENTION_MIN passa", () => {
    const exato = arm("A", 85, 15);
    assert.equal(exato.retencao, RETENTION_MIN);
    assert.equal(evaluateRetentionCut([exato]).outcome, "passa");
  });

  it("limiar do spread é exclusivo: exatamente RETENTION_MAX_SPREAD passa", () => {
    // O corte é `spread > RETENTION_MAX_SPREAD`. Sem este teste, trocar `>` por
    // `>=` passaria despercebido — o mínimo tinha teste de borda e o spread não
    // tinha (achado da revisão do PR #5643).
    const v = evaluateRetentionCut([arm("A", 1000, 0), arm("B", 850, 150)]);
    assert.equal(Math.round(v.spread! * 1000) / 1000, RETENTION_MAX_SPREAD);
    assert.equal(v.outcome, "passa", "exatamente 15 pontos NAO reprova");
  });

  it("reprova divergência acima de RETENTION_MAX_SPREAD", () => {
    const v = evaluateRetentionCut([arm("A", 1000, 0), arm("B", 840, 160)]);
    assert.equal(v.outcome, "reprova");
    assert.ok(v.motivos.some((m) => m.includes("diverg")));
  });

  it("anota amostra pequena no motivo quando o braço que reprova tem n baixo", () => {
    const v = evaluateRetentionCut([arm("A", 1, 4)]);
    assert.equal(v.outcome, "reprova");
    assert.ok(v.motivos[0].includes("amostra pequena"), v.motivos[0]);
  });

  it("braço sem dado NÃO aprova — vira incompleto, mesmo com os outros limpos", () => {
    // P1 da revisão: com `passa: boolean`, 2 de 3 braços limpos devolvia
    // aprovação e um canal inteiro sumia da comparação em silêncio.
    const v = evaluateRetentionCut([arm("A", 95, 5), arm("B", 96, 4), arm("C", 0, 0)]);
    assert.equal(v.outcome, "incompleto");
    assert.deepEqual(v.semDado, ["C"]);
  });

  it("ZERO braços medidos é incompleto, nunca passa", () => {
    assert.equal(evaluateRetentionCut([arm("A", 0, 0), arm("B", 0, 0)]).outcome, "incompleto");
  });

  it("lista vazia de braços também é incompleto — recusar é a resposta conservadora", () => {
    assert.equal(evaluateRetentionCut([]).outcome, "incompleto");
  });

  it("reprova vence incompleto: violação real importa mais que dado faltando", () => {
    assert.equal(evaluateRetentionCut([arm("A", 50, 50), arm("B", 0, 0)]).outcome, "reprova");
  });

  it("spread é null com menos de 2 braços medidos", () => {
    assert.equal(evaluateRetentionCut([arm("A", 95, 5)]).spread, null);
  });
});

describe("exitCodeForOutcome", () => {
  it("mapeia os 3 estados pra códigos DISTINTOS — 2 e 3 exigem ações humanas diferentes", () => {
    assert.equal(exitCodeForOutcome("passa"), 0);
    assert.equal(exitCodeForOutcome("reprova"), 2);
    assert.equal(exitCodeForOutcome("incompleto"), 3);
  });

  it("só 'passa' sai com 0 — regressão do bug de aprovação silenciosa", () => {
    for (const o of ["reprova", "incompleto"] as const) {
      assert.notEqual(exitCodeForOutcome(o), 0, o + " nao pode sair com 0");
    }
  });

  it("nenhum colide com o exit 1, reservado a erro de operação", () => {
    for (const o of ["passa", "reprova", "incompleto"] as const) {
      assert.notEqual(exitCodeForOutcome(o), 1);
    }
  });
});

describe("countInatribuiveis", () => {
  it("conta cadastro sem utm_source e sem referrer reconhecido", () => {
    const n = countInatribuiveis([
      sub({ utm_source: "", referring_site: "" }),
      sub({ utm_source: "", referring_site: "https://algum-blog.com.br/" }),
    ]);
    assert.equal(n, 2);
  });

  it("não conta quem tem utm_source, nem quem cai em balde conhecido", () => {
    const n = countInatribuiveis([
      sub({ utm_source: "meta-ads" }),
      sub({ utm_source: "organico-qualquer" }),
      sub({ utm_source: "", referring_site: "https://l.facebook.com/" }),
      sub({ utm_source: "", referring_site: "bing.com" }),
    ]);
    assert.equal(n, 0);
  });

  it("é o buraco que faz a retenção medida ser SUPERESTIMADA, não subestimada", () => {
    const subs = [sub({ utm_source: "meta-ads" }), sub({ utm_source: "", referring_site: "" })];
    assert.equal(computeArmRetention(subs, META).retencao, 1, "medida diz 100%...");
    assert.equal(countInatribuiveis(subs), 1, "...mas 1 cadastro sumiu da conta");
  });
});

describe("renderRetentionMarkdown", () => {
  it("declara o limite inferior e o veredito", () => {
    const arms = [arm("A", 95, 5), arm("B", 90, 10)];
    const md = renderRetentionMarkdown(arms, evaluateRetentionCut(arms));
    assert.ok(md.includes("opostas"), "tem de declarar as DUAS fontes de erro");
    assert.ok(md.includes("PASSA"));
  });

  it("na reprovação, cita a regra (a) da §3.3 e lista os motivos", () => {
    const arms = [arm("A", 50, 50), arm("B", 95, 5)];
    const v = evaluateRetentionCut(arms);
    const md = renderRetentionMarkdown(arms, v);
    assert.ok(md.includes("REPROVA"));
    assert.ok(md.includes("§3.3"));
    for (const m of v.motivos) assert.ok(md.includes(m));
  });

  it("com ZERO braços medidos não diz PASSA — e o exit code concorda com a prosa", () => {
    const arms = [arm("A", 0, 0), arm("B", 0, 0), arm("C", 0, 0)];
    const v = evaluateRetentionCut(arms);
    const md = renderRetentionMarkdown(arms, v);
    assert.ok(!md.includes("PASSA"), "markdown NAO pode dizer PASSA");
    assert.ok(md.includes("INCOMPLETO"));
    assert.ok(md.includes("Isto não é aprovação"));
    assert.notEqual(exitCodeForOutcome(v.outcome), 0, "e o exit code tambem nao pode aprovar");
  });

  it("declara os inatribuíveis quando há, avisando que a tabela está superestimada", () => {
    const arms = [arm("A", 95, 5)];
    const md = renderRetentionMarkdown(arms, evaluateRetentionCut(arms), 42);
    assert.ok(md.includes("Inatribuíveis: 42"));
    assert.ok(md.includes("SUPERESTIMADA"));
  });

  it("omite o bloco de inatribuíveis quando é zero", () => {
    const arms = [arm("A", 95, 5)];
    assert.ok(!renderRetentionMarkdown(arms, evaluateRetentionCut(arms), 0).includes("Inatribu"));
  });

  it("braço sem dado aparece explicitamente, nunca some da tabela", () => {
    const arms = [arm("A", 95, 5), arm("B", 0, 0)];
    const md = renderRetentionMarkdown(arms, evaluateRetentionCut(arms));
    assert.ok(md.includes("Sem denominador"));
    assert.ok(md.includes("B"));
  });
});

describe("ARM_RETENTION_SPECS", () => {
  it("cobre os 3 braços do teste com os utm_source que as URLs finais usam", () => {
    assert.deepEqual(
      ARM_RETENTION_SPECS.map((s) => s.utmSource).sort(),
      ["google-ads", "meta-ads", "microsoft-ads"],
    );
  });

  it("nenhum balde é compartilhado entre braços — senão um órfão contaria em dois", () => {
    const vistos = new Set<string>();
    for (const spec of ARM_RETENTION_SPECS) {
      for (const b of spec.referrerBuckets) {
        assert.equal(vistos.has(b), false, `balde duplicado entre braços: ${b}`);
        vistos.add(b);
      }
    }
  });

  it("os limiares são os da §8.4", () => {
    assert.equal(RETENTION_MIN, 0.85);
    assert.equal(RETENTION_MAX_SPREAD, 0.15);
  });
});
