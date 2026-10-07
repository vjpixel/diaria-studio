/**
 * Regressões do lote #9820 / #9822 / #9823 (achados da edição 261007).
 *
 * #9820 — o D3 foi reescrito no gate do Stage 4 (lead novo, mesmo título), o
 *   03-social.md ficou com o ângulo antigo e o `.step-4-done` foi gravado mesmo
 *   assim. Agora `social-not-behind-reviewed` e `social-humanizer-seal-fresh`
 *   estão em STAGE_4_RULES com severity error → `pipeline-sentinel.ts write
 *   --step 4` (que roda essas regras, #6009) recusa o sentinel.
 * #9822 — `write --step 6` recusava sem `_internal/edition-report.html`, mas o
 *   report só nasce depois do sentinel (§6b-6). `edition-report-exists` virou
 *   `postDispatchOnly`: fora do write, dentro da checagem completa.
 * #9823 — prefixo UUID do conector Gmail resolvido de forma determinística.
 *   (O alarme de 95 KB do e-mail de teste está em publish-guards-9277-9278.test.ts.)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSocialNotBehindReviewed,
  checkSocialHumanizerSealFresh,
} from "../scripts/lib/invariant-checks/stage-4.ts";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";
import { writeSentinel } from "../scripts/check-humanizer-social.ts";
import { findSocialContentMismatches } from "../scripts/check-staleness.ts";
import {
  CONNECTORS,
  parseToolNames,
  resolveConnectorTools,
} from "../scripts/lib/mcp-connector-resolve.ts";
import { exitCodeFor } from "../scripts/resolve-mcp-connector.ts";

// ---------------------------------------------------------------------------
// Fixtures #9820
// ---------------------------------------------------------------------------

const D1 = {
  title: "Anthropic levanta rodada de US$ 2 bilhões",
  url: "https://example.com/anthropic-funding",
  body: "A Anthropic fechou uma rodada de investimento liderada por Google e Amazon, elevando o valuation da empresa para dezoito bilhões de dólares. Investidores citam segurança como diferencial competitivo em contratos governamentais.",
  why: "Cada rodada de capital nesse tamanho redefine as apostas do mercado sobre qual laboratório vai liderar a próxima geração de modelos de linguagem.",
};
const D2_ORIGINAL = {
  title: "Mistral lança modelo aberto para empresas",
  url: "https://example.com/mistral",
  body: "A Mistral apresentou um modelo de pesos abertos pensado para empresas europeias, com licença comercial permissiva e desempenho competitivo em benchmarks de programação.",
  why: "Empresas europeias ganham uma alternativa soberana aos modelos americanos sem abrir mão de qualidade em tarefas de código.",
};
// Reescrita do lead no gate (mesmo título, mesma URL) — o caso real da 261007.
const D2_REWRITTEN = {
  ...D2_ORIGINAL,
  body: "O governo francês anunciou subsídios bilionários para datacenters que hospedarem a Mistral, transformando a startup num instrumento de política industrial. Críticos apontam concentração de recursos públicos numa única companhia.",
  why: "Quando um Estado escolhe campeões nacionais em inteligência artificial, a concorrência entre startups locais muda de natureza.",
};

function reviewedMd(d2: typeof D2_ORIGINAL, intro = "Intro da edição."): string {
  const block = (n: number, d: typeof D1) =>
    [`**DESTAQUE ${n} | 💰 MERCADO**`, "", `**[${d.title}](${d.url})**`, "", d.body, "", "Por que isso importa:", "", d.why];
  return [intro, "", "---", "", ...block(1, D1), "", "---", "", ...block(2, d2)].join("\n");
}

const SOCIAL_D2_ORIGINAL =
  "A Mistral apresentou um modelo de pesos abertos para empresas europeias, com licença comercial permissiva e desempenho competitivo em programação. Uma alternativa soberana aos modelos americanos.";
const SOCIAL_D2_REWRITTEN =
  "O governo francês anunciou subsídios bilionários para datacenters que hospedarem a Mistral, transformando a startup num instrumento de política industrial. Críticos apontam concentração de recursos públicos numa única companhia, e a concorrência entre startups locais muda de natureza.";

const SOCIAL_MD = [
  "# Social",
  "",
  "## d1",
  "",
  "A Anthropic fechou uma rodada bilionária com Google e Amazon como investidores, elevando o valuation da empresa. O diferencial citado pelos investidores é segurança, ativo valorizado em contratos governamentais.",
  "",
  "## d2",
  "",
  SOCIAL_D2_ORIGINAL,
  "",
  "# Curto",
  "",
  "## d1",
  "",
  "Anthropic levanta rodada.",
  "",
  "## d2",
  "",
  "Mistral lança modelo aberto.",
  "",
].join("\n");

function setup(reviewed: string, socialMs: number, reviewedMs: number): string {
  const dir = mkdtempSync(join(tmpdir(), "guard-9820-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "03-social.md"), SOCIAL_MD);
  writeFileSync(join(dir, "02-reviewed.md"), reviewed);
  utimesSync(join(dir, "03-social.md"), socialMs / 1000, socialMs / 1000);
  utimesSync(join(dir, "02-reviewed.md"), reviewedMs / 1000, reviewedMs / 1000);
  return dir;
}

// 03-social.md 21:35, 02-reviewed.md 21:41 — os horários da 261007.
const SOCIAL_T = Date.parse("2026-10-07T00:35:00Z");
const REVIEWED_T = Date.parse("2026-10-07T00:41:00Z");

describe("#9820 social-not-behind-reviewed", () => {
  it("lead do D2 reescrito no gate depois do social → error nomeando d2", () => {
    const dir = setup(reviewedMd(D2_REWRITTEN), SOCIAL_T, REVIEWED_T);
    try {
      const v = checkSocialNotBehindReviewed(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "social-not-behind-reviewed");
      assert.equal(v[0].severity, "error");
      assert.match(v[0].message, /d2/);
      assert.deepEqual(findSocialContentMismatches(dir), ["d2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição cosmética fora dos destaques (mtime mais novo, conteúdo igual) → nada", () => {
    const dir = setup(reviewedMd(D2_ORIGINAL, "Intro retocada no gate."), SOCIAL_T, REVIEWED_T);
    try {
      assert.deepEqual(checkSocialNotBehindReviewed(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("social regenerado DEPOIS da reescrita (cascata rodou) → nada", () => {
    const dir = setup(reviewedMd(D2_REWRITTEN), REVIEWED_T + 60_000, REVIEWED_T);
    try {
      writeFileSync(join(dir, "03-social.md"), SOCIAL_MD.replace(SOCIAL_D2_ORIGINAL, SOCIAL_D2_REWRITTEN));
      utimesSync(join(dir, "03-social.md"), (REVIEWED_T + 60_000) / 1000, (REVIEWED_T + 60_000) / 1000);
      assert.deepEqual(findSocialContentMismatches(dir), []);
      assert.deepEqual(checkSocialNotBehindReviewed(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#9829: social MAIS NOVO que o reviewed mas com o ## d2 no ângulo antigo → error mesmo assim", () => {
    // Cenário da issue: D2 reescrito no gate; depois uma cascata de OUTRO
    // destaque (ou reorder, autofix do fact-check, save do Studio) regrava o
    // 03-social.md inteiro — o mtime fica mais novo, o ## d2 segue velho.
    const dir = setup(reviewedMd(D2_REWRITTEN), REVIEWED_T + 60_000, REVIEWED_T);
    try {
      assert.deepEqual(findSocialContentMismatches(dir), ["d2"]);
      const v = checkSocialNotBehindReviewed(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "social-not-behind-reviewed");
      assert.equal(v[0].severity, "error");
      assert.match(v[0].message, /d2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#9829: sem comparação de conteúdo e social mais novo → nada (fallback de mtime inalterado)", () => {
    const dir = setup(reviewedMd(D2_REWRITTEN), REVIEWED_T + 60_000, REVIEWED_T);
    try {
      writeFileSync(join(dir, "03-social.md"), "Texto social sem seções de destaque.\n");
      utimesSync(join(dir, "03-social.md"), (REVIEWED_T + 60_000) / 1000, (REVIEWED_T + 60_000) / 1000);
      assert.equal(findSocialContentMismatches(dir), undefined);
      assert.deepEqual(checkSocialNotBehindReviewed(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem # Social (comparação de conteúdo não roda, só mtime) → warning, nunca bloqueia o sentinel", () => {
    const dir = setup(reviewedMd(D2_REWRITTEN), SOCIAL_T, REVIEWED_T);
    try {
      writeFileSync(join(dir, "03-social.md"), "Texto social sem seções de destaque.\n");
      utimesSync(join(dir, "03-social.md"), SOCIAL_T / 1000, SOCIAL_T / 1000);
      assert.equal(findSocialContentMismatches(dir), undefined);
      const v = checkSocialNotBehindReviewed(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "social-not-behind-reviewed");
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /só mtime/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("está no conjunto que pipeline-sentinel write --step 4 roda (phase pre-dispatch)", () => {
    const ids = getRulesForStage(4, { phase: "pre-dispatch" }).map((r) => r.id);
    assert.ok(ids.includes("social-not-behind-reviewed"));
    assert.ok(ids.includes("social-humanizer-seal-fresh"));
  });
});

describe("#9820 social-humanizer-seal-fresh", () => {
  it("social reescrito depois do selo → error; selo regravado → nada", () => {
    const dir = setup(reviewedMd(D2_ORIGINAL), REVIEWED_T + 1000, REVIEWED_T);
    try {
      writeSentinel(dir);
      assert.deepEqual(checkSocialHumanizerSealFresh(dir), []);
      appendFileSync(join(dir, "03-social.md"), "\nParágrafo novo sem humanizar.\n");
      const v = checkSocialHumanizerSealFresh(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "error");
      assert.equal(v[0].rule, "social-humanizer-seal-fresh");
      writeSentinel(dir, "re-humanizado no teste");
      assert.deepEqual(checkSocialHumanizerSealFresh(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("selo ausente → warning (edição anterior ao #6305), nunca bloqueia", () => {
    const dir = setup(reviewedMd(D2_ORIGINAL), REVIEWED_T + 1000, REVIEWED_T);
    try {
      const v = checkSocialHumanizerSealFresh(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#9822 edition-report-exists fora do write --step 6", () => {
  it("o write (phase pre-dispatch) não exige o report; a checagem completa ainda exige", () => {
    const pre = getRulesForStage(6, { phase: "pre-dispatch" }).map((r) => r.id);
    const full = getRulesForStage(6).map((r) => r.id);
    assert.ok(!pre.includes("edition-report-exists"), "write --step 6 recusaria sem o report, que só nasce em §6b-6");
    assert.ok(full.includes("edition-report-exists"));
    // Só ela sai: as demais regras do Stage 6 continuam no write.
    assert.deepEqual(full.filter((id) => !pre.includes(id)), ["edition-report-exists"]);
  });
});

// ---------------------------------------------------------------------------
// #9823 — resolvedor do prefixo do conector Gmail
// ---------------------------------------------------------------------------

// Prefixos fictícios (o id real é por instalação e nunca vai pro texto versionado, #7307).
const GMAIL_UUID = "mcp__0000aaaa-1111-2222-3333-444455556666__";
const OTHER_UUID = "mcp__9999ffff-8888-7777-6666-555544443333__";
const gmailTools = (p: string) =>
  ["search_threads", "get_thread", "list_labels", "create_label", "create_draft"].map((t) => p + t);

describe("#9823 resolveConnectorTools (gmail)", () => {
  const spec = CONNECTORS.gmail;

  it("prefixo estável presente → stable", () => {
    const r = resolveConnectorTools(gmailTools("mcp__claude_ai_Gmail__"), spec);
    assert.equal(r.status, "stable");
    assert.equal(r.tools.search_threads, "mcp__claude_ai_Gmail__search_threads");
    assert.equal(exitCodeFor(r.status), 0);
  });

  it("caso 261007: só o prefixo UUID → renamed com os nomes exatos e o select pronto", () => {
    const r = resolveConnectorTools(gmailTools(GMAIL_UUID), spec);
    assert.equal(r.status, "renamed");
    assert.equal(r.prefix, GMAIL_UUID);
    assert.equal(r.tools.get_thread, `${GMAIL_UUID}get_thread`);
    assert.equal(r.select, `select:${GMAIL_UUID}search_threads,${GMAIL_UUID}get_thread`);
  });

  it("outro conector com search_threads/get_thread mas sem assinatura Gmail não é escolhido", () => {
    const other = [`${OTHER_UUID}search_threads`, `${OTHER_UUID}get_thread`];
    const r = resolveConnectorTools([...other, ...gmailTools(GMAIL_UUID)], spec);
    assert.equal(r.status, "renamed");
    assert.equal(r.prefix, GMAIL_UUID);
    assert.deepEqual(resolveConnectorTools(other, spec).status, "ambiguous");
  });

  it("empate de assinatura → ambiguous (exit 3), nunca chuta", () => {
    const r = resolveConnectorTools([...gmailTools(GMAIL_UUID), ...gmailTools(OTHER_UUID)], spec);
    assert.equal(r.status, "ambiguous");
    assert.equal(r.prefix, null);
    assert.equal(exitCodeFor(r.status), 3);
  });

  it("sem as tools exigidas → missing (exit 1 = mcp_unavailable)", () => {
    const r = resolveConnectorTools([`${GMAIL_UUID}list_labels`, "Read", "Bash"], spec);
    assert.equal(r.status, "missing");
    assert.equal(exitCodeFor(r.status), 1);
  });

  it("parseToolNames aceita a saída colada do ToolSearch (vírgula, espaço, linha) e ignora não-MCP", () => {
    const names = parseToolNames(`Read, ${GMAIL_UUID}search_threads\n${GMAIL_UUID}get_thread  Bash`);
    assert.deepEqual(names, [`${GMAIL_UUID}search_threads`, `${GMAIL_UUID}get_thread`]);
  });
});
