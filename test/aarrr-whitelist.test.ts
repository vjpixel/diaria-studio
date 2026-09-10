import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyExecTrackWithRule } from "../scripts/lib/issue-exec-track.ts";
import {
  aarrrStagesOf,
  isBlockedByAarrrWhitelist,
  parseAarrrWhitelist,
  loadAarrrWhitelist,
  AARRR_STAGES,
} from "../scripts/lib/aarrr-whitelist.ts";
import { resolveDesbloqueioEscopo } from "../scripts/lib/desbloqueia-scan.ts";

const NOW = new Date("2026-09-10T12:00:00Z");
const classify = (labels: string[], wl: string[], body = "") =>
  classifyExecTrackWithRule({ labels, body, now: NOW, aarrrWhitelist: new Set(wl) });

describe("whitelist AAARRR no classificador", () => {
  it("issue sem label aarrr:* não é afetada, mesmo com whitelist vazia", () => {
    assert.equal(classify(["bug", "P2"], []).track, "overnight");
    assert.equal(classify(["windows"], []).track, "develop");
  });

  it("issue com etapa fora da whitelist fica bloqueada", () => {
    const r = classify(["enhancement", "aarrr:retention"], []);
    assert.deepEqual(r, { track: "bloqueada", matched: "label:aarrr-fora-da-whitelist" });
  });

  it("#7945 — label bug nunca é vetada pela whitelist, tenha ou não etapa liberada", () => {
    assert.equal(classify(["bug", "aarrr:retention"], []).track, "overnight");
    assert.equal(classify(["bug", "P1", "aarrr:activation"], []).track, "overnight");
    assert.equal(classify(["bug", "aarrr:retention"], ["retention"]).track, "overnight");
  });

  it("#7945 — bug não desarma bloqueio real coexistindo", () => {
    assert.equal(classify(["bug", "aarrr:retention", "external-blocker"], []).track, "bloqueada");
    assert.equal(classify(["bug", "aarrr:revenue", "on-hold"], []).track, "fora-de-rodada");
  });

  it("vence sobre develop/overnight/agendada", () => {
    assert.equal(classify(["aarrr:revenue", "develop-track"], ["retention"]).track, "bloqueada");
    assert.equal(classify(["aarrr:revenue", "alarm-evento"], []).track, "bloqueada");
    assert.equal(classify(["aarrr:revenue"], [], "<!-- aguardando-ate: 2026-12-01 -->").track, "bloqueada");
  });

  it("etapa liberada segue as regras normais", () => {
    assert.equal(classify(["aarrr:retention"], ["retention"]).track, "overnight");
    assert.equal(classify(["aarrr:retention", "develop-track"], ["retention"]).track, "develop");
  });

  it("basta UMA das etapas estar liberada", () => {
    assert.equal(classify(["aarrr:acquisition", "aarrr:revenue"], ["revenue"]).track, "overnight");
  });

  it("on-hold e épica continuam vencendo", () => {
    assert.equal(classify(["aarrr:revenue", "on-hold"], []).track, "fora-de-rodada");
    assert.equal(classify(["aarrr:revenue", "epic-guarda-chuva"], []).track, "epica");
  });
});

describe("caminho de produção (whitelist não injetada)", () => {
  const blocked = AARRR_STAGES.find((s) => !loadAarrrWhitelist().has(s));

  it("classificador usa aarrr-whitelist.json por default", { skip: !blocked }, () => {
    const r = classifyExecTrackWithRule({ labels: [`aarrr:${blocked}`], body: "", now: NOW });
    assert.equal(r.matched, "label:aarrr-fora-da-whitelist");
  });

  it("desbloqueia não pergunta sobre issue vetada pela whitelist", { skip: !blocked }, () => {
    assert.equal(resolveDesbloqueioEscopo({ labels: [`aarrr:${blocked}`], body: "", state: "OPEN", now: NOW }), null);
  });
});

describe("helpers", () => {
  it("aarrrStagesOf extrai as etapas", () => {
    assert.deepEqual(aarrrStagesOf(["P1", "aarrr:activation", "aarrr:revenue"]), ["activation", "revenue"]);
  });

  it("isBlockedByAarrrWhitelist", () => {
    assert.equal(isBlockedByAarrrWhitelist([], new Set()), false);
    assert.equal(isBlockedByAarrrWhitelist(["aarrr:referral"], new Set()), true);
    assert.equal(isBlockedByAarrrWhitelist(["aarrr:referral"], new Set(["referral"])), false);
  });

  it("parse é fail-closed e descarta etapa inválida", () => {
    assert.equal(parseAarrrWhitelist("não é json").size, 0);
    assert.equal(parseAarrrWhitelist("{}").size, 0);
    assert.deepEqual([...parseAarrrWhitelist('{"whitelist":["retention","foo",3]}')], ["retention"]);
  });

  it("arquivo versionado é válido e loader bate com ele", () => {
    const raw = readFileSync(new URL("../aarrr-whitelist.json", import.meta.url), "utf8");
    assert.ok(Array.isArray(JSON.parse(raw).whitelist));
    assert.deepEqual([...loadAarrrWhitelist()], [...parseAarrrWhitelist(raw)]);
  });
});
