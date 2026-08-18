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
  it("passa quando todos os braços estão acima do mínimo e juntos", () => {
    const v = evaluateRetentionCut([arm("A", 95, 5), arm("B", 96, 4), arm("C", 94, 6)]);
    assert.equal(v.passa, true);
    assert.deepEqual(v.motivos, []);
  });

  it("reprova braço abaixo de RETENTION_MIN", () => {
    const v = evaluateRetentionCut([arm("A", 80, 20), arm("B", 95, 5)]);
    assert.equal(v.passa, false);
    assert.ok(v.motivos.some((m) => m.includes("A") && m.includes("retenção")));
  });

  it("limiar é exclusivo: exatamente RETENTION_MIN passa", () => {
    const exato = arm("A", 85, 15);
    assert.equal(exato.retencao, RETENTION_MIN);
    const v = evaluateRetentionCut([exato]);
    assert.equal(v.passa, true);
  });

  it("reprova divergência acima de RETENTION_MAX_SPREAD mesmo com todos acima do mínimo", () => {
    // 100% e 86% — os dois passam no mínimo, mas divergem 14 pontos... ok;
    // 100% e 84% divergem 16 e um deles já falha. Construir o caso puro:
    const v = evaluateRetentionCut([arm("A", 100, 0), arm("B", 86, 14)]);
    assert.equal(v.spread! > 0.13, true);
    // 14 pontos < 15 -> ainda passa
    assert.equal(v.passa, true);

    const v2 = evaluateRetentionCut([arm("A", 1000, 0), arm("B", 840, 160)]);
    assert.equal(v2.passa, false);
    assert.ok(v2.motivos.some((m) => m.includes("divergência")));
  });

  it("braço sem dado não aprova nem reprova — aparece em semDado", () => {
    const v = evaluateRetentionCut([arm("A", 95, 5), arm("B", 0, 0)]);
    assert.equal(v.passa, true);
    assert.deepEqual(v.semDado, ["B"]);
    // e não entra no spread
    assert.equal(v.spread, null);
  });

  it("spread é null com menos de 2 braços medidos", () => {
    assert.equal(evaluateRetentionCut([arm("A", 95, 5)]).spread, null);
  });
});

describe("renderRetentionMarkdown", () => {
  it("declara o limite inferior e o veredito", () => {
    const arms = [arm("A", 95, 5), arm("B", 90, 10)];
    const md = renderRetentionMarkdown(arms, evaluateRetentionCut(arms));
    assert.ok(md.includes("limite inferior"), "tem de avisar que o número é conservador");
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

  it("com ZERO braços medidos não diz PASSA — aprovação por ausência de dado é o bug que a §8.4 mata", () => {
    const arms = [arm("A", 0, 0), arm("B", 0, 0), arm("C", 0, 0)];
    const v = evaluateRetentionCut(arms);
    assert.equal(v.passa, true, "não há violação a reportar...");
    const md = renderRetentionMarkdown(arms, v);
    assert.ok(!md.includes("PASSA"), "...mas o markdown NÃO pode dizer PASSA");
    assert.ok(md.includes("NÃO AVALIADO"));
    assert.ok(md.includes("Isto não é aprovação"));
  });

  it("braço sem dado aparece explicitamente, nunca some da tabela", () => {
    const arms = [arm("A", 95, 5), arm("B", 0, 0)];
    const md = renderRetentionMarkdown(arms, evaluateRetentionCut(arms));
    assert.ok(md.includes("sem dado"));
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
