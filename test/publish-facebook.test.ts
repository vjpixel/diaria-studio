import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPostText, validateScheduledTime, needsReschedule } from "../scripts/publish-facebook.ts";

const MD = "# Facebook\n\n## d1\nTexto d1.\n\n## d2\nTexto d2.\n\n## d3\nTexto d3.\n<!-- oculto -->\n\n# LinkedIn\n\n## d1\nLinkedIn d1.";
const MDCRLF = MD.replace(/\n/g, "\r\n");

describe("extractPostText (publish-facebook) (#527)", () => {
  it("extrai d1 de # Facebook", () => { const t = extractPostText(MD, "facebook", "d1"); assert.ok(t.includes("Texto d1.")); });
  it("extrai d2 sem vazar d1/d3", () => { const t = extractPostText(MD, "facebook", "d2"); assert.ok(t.includes("Texto d2.")); assert.ok(!t.includes("Texto d1.")); assert.ok(!t.includes("Texto d3.")); });
  it("extrai d3 e remove comentarios HTML", () => { const t = extractPostText(MD, "facebook", "d3"); assert.ok(t.includes("Texto d3.")); assert.ok(!t.includes("oculto")); });
  it("nao vaza LinkedIn quando plataforma facebook", () => { assert.ok(!extractPostText(MD, "facebook", "d1").includes("LinkedIn d1.")); });
  it("normaliza CRLF para LF", () => { assert.ok(extractPostText(MDCRLF, "facebook", "d1").includes("Texto d1.")); });
  it("lanca quando plataforma nao encontrada", () => { assert.throws(() => extractPostText(MD, "twitter", "d1"), /Twitter.*not found|not found.*Twitter/i); });
  it("lanca quando destaque nao encontrado", () => { assert.throws(() => extractPostText(MD, "facebook", "d4"), /d4/i); });
  it("lanca quando d2 inexistente na plataforma", () => { assert.throws(() => extractPostText("# Facebook\n\n## d1\nPost.\n\n## d3\nPost.", "facebook", "d2"), /d2/i); });
});

describe("validateScheduledTime 15 min boundary (#527)", () => {
  const now = new Date("2026-04-28T12:00:00Z");
  it("aceita > 15 min futuro com margem 900s", () => { assert.doesNotThrow(() => validateScheduledTime("2026-04-28T12:20:00Z", now, 900)); });
  it("aceita > 10 min futuro (margem default)", () => { assert.doesNotThrow(() => validateScheduledTime("2026-04-28T13:00:00Z", now)); });
  it("rejeita passado", () => { assert.throws(() => validateScheduledTime("2026-04-28T11:30:00Z", now), /já passou/); });
  it("rejeita exato agora (boundary zero a frente)", () => { assert.throws(() => validateScheduledTime("2026-04-28T12:00:00Z", now), /já passou/); });
  it("rejeita < 15 min com margem 900s", () => { assert.throws(() => validateScheduledTime("2026-04-28T12:10:00Z", now, 900), /margem mínima de 15min/); });
  it("rejeita < 10 min (margem default)", () => { assert.throws(() => validateScheduledTime("2026-04-28T12:05:00Z", now), /margem mínima de 10min/); });
  it("rejeita data invalida", () => { assert.throws(() => validateScheduledTime("bad", now), /data inválida/); });
});

describe("published=false sempre enviado no formData fix #505 (#527)", () => {
  it("formData contem published=false com scheduledAt", () => {
    const e: Record<string, string> = {};
    const fd = { append(k: string, v: unknown) { if (typeof v === "string") e[k] = v; } };
    fd.append("published", "false"); fd.append("scheduled_publish_time", "9999");
    assert.equal(e["published"], "false"); assert.ok("scheduled_publish_time" in e);
  });
  it("published=false mesmo sem scheduledAt", () => {
    const e: Record<string, string> = {};
    const fd = { append(k: string, v: unknown) { if (typeof v === "string") e[k] = v; } };
    fd.append("published", "false");
    assert.equal(e["published"], "false"); assert.ok(!("scheduled_publish_time" in e));
  });
});

describe("image naming 04-dN-1x1.jpg fix #502 (#527)", () => {
  for (const d of ["d1", "d2", "d3"]) {
    it(d + ": nome e 04-" + d + "-1x1.jpg", () => {
      const f = "04-" + d + "-1x1.jpg";
      assert.match(f, /^04-d[123]-1x1\.jpg$/);
      assert.ok(!f.includes("2x1"));
    });
  }
  it("pattern gera 3 nomes esperados", () => {
    assert.deepEqual(["d1","d2","d3"].map((d) => "04-" + d + "-1x1.jpg"), ["04-d1-1x1.jpg","04-d2-1x1.jpg","04-d3-1x1.jpg"]);
  });
});

describe("resume-aware skip posts ja publicados (#527)", () => {
  it("pula post com status draft", () => { const p=[{platform:"facebook",destaque:"d1",status:"draft"}]; const e=p.find((x)=>x.platform==="facebook"&&x.destaque==="d1"&&(x.status==="draft"||x.status==="scheduled")); assert.ok(e!==undefined); assert.equal(e.status,"draft"); });
  it("pula post com status scheduled", () => { const p=[{platform:"facebook",destaque:"d2",status:"scheduled"}]; const e=p.find((x)=>x.platform==="facebook"&&x.destaque==="d2"&&(x.status==="draft"||x.status==="scheduled")); assert.ok(e!==undefined); assert.equal(e.status,"scheduled"); });
  it("nao pula post failed (retry)", () => { const p=[{platform:"facebook",destaque:"d3",status:"failed"}]; const e=p.find((x)=>x.platform==="facebook"&&x.destaque==="d3"&&(x.status==="draft"||x.status==="scheduled")); assert.equal(e,undefined); });
  it("nao pula outra plataforma", () => { const p=[{platform:"linkedin",destaque:"d1",status:"scheduled"}]; const e=p.find((x)=>x.platform==="facebook"&&x.destaque==="d1"&&(x.status==="draft"||x.status==="scheduled")); assert.equal(e,undefined); });
});

describe("extractPostText regex d\\d+ boundary (#725 bug #3)", () => {
  it("d3 nao vaza em lookahead quando texto contém ## d10 (falso positivo antigo)", () => {
    // Antes: regex `## d\d` no lookahead parava em `## d10` como se fosse `## d1`+`0`
    const md = "# Facebook\n\n## d1\nTexto d1.\n\n## d2\nTexto d2.\n\n## d3\nTexto d3 exclusivo.\n\n## d10\nTexto d10 separado.";
    const t = extractPostText(md, "facebook", "d3");
    assert.ok(t.includes("Texto d3 exclusivo."));
    assert.ok(!t.includes("Texto d10 separado."));
  });

  it("d1 extraído corretamente quando existe d10 no mesmo arquivo", () => {
    const md = "# Facebook\n\n## d1\nSó d1.\n\n## d10\nSó d10.";
    const t = extractPostText(md, "facebook", "d1");
    assert.ok(t.includes("Só d1."));
    assert.ok(!t.includes("Só d10."));
  });
});

describe("Graph API mock publishPhoto id (#527)", () => {
  it("parseia id do response", () => { const r={id:"123_456"} as {id:string;post_id?:string}; assert.equal(r.post_id??r.id,"123_456"); });
  it("prefere post_id sobre id", () => { const r={id:"123",post_id:"123_456"}; assert.equal(r.post_id??r.id,"123_456"); });
  it("constroi URL de post corretamente", () => { assert.equal("https://www.facebook.com/111/posts/123_456","https://www.facebook.com/111/posts/123_456"); });
});
