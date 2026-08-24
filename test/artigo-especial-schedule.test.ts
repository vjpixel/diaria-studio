import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  toAammdd,
  validateExplicitAt,
  resolveArtigoEspecialScheduledAt,
  resolveArtigoEspecialScheduledAts,
} from "../scripts/lib/artigo-especial-schedule.ts";

const CONFIG = {
  publishing: {
    social: {
      fallback_schedule: { d3_time: "17:30", day_offset: 0 },
      timezone: "America/Sao_Paulo",
    },
  },
};

describe("toAammdd (#5979)", () => {
  it("formata um instante em AAMMDD no fuso BRT (default)", () => {
    // 23/ago/2026 meio-dia BRT — instante explícito com offset, não
    // componentes locais do Date (evita o bug corrigido abaixo).
    assert.equal(toAammdd(new Date("2026-08-23T12:00:00-03:00")), "260823");
  });
  it("preenche zero a esquerda em mes/dia de 1 digito", () => {
    assert.equal(toAammdd(new Date("2026-01-05T12:00:00-03:00")), "260105");
  });

  it("#5979 review, PR #6000 — usa o fuso configurado (Intl), NUNCA os componentes locais do processo", () => {
    // 23:30 UTC de 23/ago/2026 == 20:30 BRT do MESMO dia (UTC-3) — ainda
    // "23" em BRT, apesar de já ser tarde em UTC. Antes da correção,
    // `toAammdd` lia `date.getMonth()/getDate()` no fuso LOCAL do processo
    // (não necessariamente BRT) — um processo rodando em UTC leria esse
    // mesmo instante como "23" também neste caso específico (por
    // coincidência, ainda dia 23 em ambos), então o teste abaixo usa um
    // horário que SÓ diverge se o fuso for realmente respeitado.
    const instant = new Date("2026-08-23T23:30:00-03:00"); // 23:30 BRT, 24/ago 02:30 UTC
    assert.equal(toAammdd(instant, "America/Sao_Paulo"), "260823"); // ainda dia 23 em BRT
    assert.equal(toAammdd(instant, "UTC"), "260824"); // já dia 24 em UTC
  });

  it("default do timeZone e America/Sao_Paulo quando omitido", () => {
    const instant = new Date("2026-08-23T23:30:00-03:00");
    assert.equal(toAammdd(instant), toAammdd(instant, "America/Sao_Paulo"));
  });
});

describe("validateExplicitAt (#5979)", () => {
  const now = Date.parse("2026-08-23T12:00:00-03:00");
  it("aceita ISO valido no futuro", () => {
    assert.equal(validateExplicitAt("2026-09-02T17:30:00-03:00", now), "2026-09-02T17:30:00-03:00");
  });
  it("rejeita string nao-ISO", () => {
    assert.throws(() => validateExplicitAt("not-a-real-iso-date", now), /não é um ISO 8601/);
  });
  it("rejeita data no passado", () => {
    assert.throws(() => validateExplicitAt("2026-01-01T00:00:00-03:00", now), /passado/);
  });
  it("rejeita o proprio 'now' (nao estritamente futuro)", () => {
    assert.throws(() => validateExplicitAt(new Date(now).toISOString(), now), /passado/);
  });
});

describe("resolveArtigoEspecialScheduledAt (#5979)", () => {
  it("--at explicito tem precedencia, sem tocar em computeScheduledAt", () => {
    const now = Date.parse("2026-08-23T12:00:00-03:00");
    const iso = resolveArtigoEspecialScheduledAt(CONFIG, { at: "2026-09-02T17:30:00-03:00", now });
    assert.equal(iso, "2026-09-02T17:30:00-03:00");
  });

  it("default: D+1 09:00 BRT (pagina) a partir de 'now' (#6014 item 1)", () => {
    // 23/ago/2026 (domingo) 10:00 BRT -> D+1 = 24/ago 09:00 BRT.
    const now = Date.parse("2026-08-23T10:00:00-03:00");
    const iso = resolveArtigoEspecialScheduledAt(CONFIG, { now });
    assert.equal(iso, "2026-08-24T09:00:00-03:00");
  });

  it("default respeita virada de mes/ano (D+1 de 31/dez)", () => {
    const now = Date.parse("2026-12-31T10:00:00-03:00");
    const iso = resolveArtigoEspecialScheduledAt(CONFIG, { now });
    assert.equal(iso, "2027-01-01T09:00:00-03:00");
  });

  it("#6014: NAO lanca sem fallback_schedule.d3_time — horarios default sao fixos (09:00/09:30)", () => {
    const now = Date.parse("2026-08-23T10:00:00-03:00");
    const iso = resolveArtigoEspecialScheduledAt(
      { publishing: { social: { timezone: "America/Sao_Paulo" } } },
      { now },
    );
    assert.equal(iso, "2026-08-24T09:00:00-03:00");
  });
});

describe("resolveArtigoEspecialScheduledAts (#6014 item 1)", () => {
  it("--at explicito aplica aos DOIS canais", () => {
    const now = Date.parse("2026-08-23T12:00:00-03:00");
    const r = resolveArtigoEspecialScheduledAts(CONFIG, { at: "2026-09-02T17:30:00-03:00", now });
    assert.equal(r.pagina, "2026-09-02T17:30:00-03:00");
    assert.equal(r.perfil, "2026-09-02T17:30:00-03:00");
  });

  it("default #6014: pagina D+1 09:00, perfil D+2 09:30 — sem colidir com d3 17:30", () => {
    // 23/ago/2026 (domingo) 10:00 BRT -> pagina 24/ago 09:00; perfil 25/ago 09:30.
    const now = Date.parse("2026-08-23T10:00:00-03:00");
    const r = resolveArtigoEspecialScheduledAts(CONFIG, { now });
    assert.equal(r.pagina, "2026-08-24T09:00:00-03:00");
    assert.equal(r.perfil, "2026-08-25T09:30:00-03:00");
  });

  it("horarios derivados NAO dependem do d3_time do config compartilhado", () => {
    const now = Date.parse("2026-08-23T10:00:00-03:00");
    const r = resolveArtigoEspecialScheduledAts(
      { publishing: { social: { fallback_schedule: { d3_time: "23:59", day_offset: 5 }, timezone: "America/Sao_Paulo" } } },
      { now },
    );
    assert.equal(r.pagina, "2026-08-24T09:00:00-03:00");
    assert.equal(r.perfil, "2026-08-25T09:30:00-03:00");
  });

  it("singular e compativel: devolve o horario da PAGINA", () => {
    const now = Date.parse("2026-08-23T10:00:00-03:00");
    const par = resolveArtigoEspecialScheduledAts(CONFIG, { now });
    const so = resolveArtigoEspecialScheduledAt(CONFIG, { now });
    assert.equal(so, par.pagina);
  });
});
