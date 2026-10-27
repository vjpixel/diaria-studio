/**
 * #11116/#11244 (pool-cut recorrente): item do pool com a MESMA HISTÓRIA de
 * incidente de um destaque da edição (ou de outro item do pool) chegava à
 * newsletter e o editor cortava no gate 4. O aviso do Stage 4 (#11173) só
 * avisava; `curatePool` (#10794) agora manda o item para `pool_reserve` antes
 * do writer, e o próximo do bucket ocupa a vaga.
 *
 * Fixtures = textos reais do `01-approved.json` de 261023 (títulos, resumos e
 * URLs como estão, inclusive entidades HTML). Sem dependência de `data/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { curatePool } from "../scripts/lib/pool-quality.ts";
import { applyStage2Caps } from "../scripts/lib/apply-stage2-caps.ts";
import { createStoryIndex, findIntraEditionFactRecurrences, type IntraEditionItem } from "../scripts/lib/fact-recurrence.ts";

const WIZ = "https://www.wiz.io/blog/php2shell-php-rce";
const G1 = "https://g1.globo.com/tecnologia/noticia/2026/10/22/o-que-e-php-e-a-falha-grave-de-seguranca-detectada-por-ia-que-tirou-sites-do-ar.ghtml";
const CANALTECH_PHP = "https://canaltech.com.br/seguranca/ia-revela-falhas-escondidas-ha-mais-de-10-anos-no-php-entenda-a-descoberta/";
const CHROME = "https://canaltech.com.br/seguranca/chrome-reforca-ia-para-alertar-usuarios-sobre-golpes-e-lojas-falsas/";
const GEMINI_MENU = "https://canaltech.com.br/apps/gemini-ganha-menu-para-conectar-apps-e-criar-funcoes-sob-medida/";

const d1 = {
  rank: 1,
  bucket: "radar",
  article: {
    url: WIZ,
    title: "Sites de governos saem do ar após IA ajudar a revelar falhas no código usado por 70% da web",
    summary: "Serviços públicos e provedores de hospedagem dos países baixos interromperam acessos para aplicar correções; Cloudflare relata tentativas de ataque",
  },
};
const g1 = {
  url: G1,
  title: "O que é PHP e a falha grave de segurança que tirou sites do ar",
  summary: "Durante mais de uma década, falhas graves passaram despercebidas em uma tecnologia usada por grande parte da internet. Foi preciso que a inteligência artificial as trouxesse à tona, causando um alerta global de segurança cibernética.",
  score: 82,
};
const chrome = {
  url: CHROME,
  title: "Chrome reforça IA para alertar usuários sobre golpes e lojas falsas",
  summary: "O Google Chrome ganhou uma nova medida de seguran&ccedil;a para alertar sobre sites suspeitos . Agora, o navegador exibe um aviso na tela para sinalizar que uma p&aacute;gina tem padr&otilde;es similares a outros links associados com tentativas de phishing, malwares e outras amea&ccedil;as.",
  score: 80,
};
// Espelho do D1 no RADAR (mesma URL): o caps já tira, e o texto dele soma ao D1.
const wizMirror = {
  url: WIZ,
  title: "PHP2Shell: AI uncovers critical RCE vulnerabilities affecting 70% of the Internet",
  summary: "Core PHP engine flaws enable remote code execution and Heartbleed-style memory disclosure across the web.",
  score: 90,
};
const geminiMenu = {
  url: GEMINI_MENU,
  title: "Gemini ganha menu para conectar apps e criar funções sob medida",
  summary: "O Google anunciou em 21 de outubro um novo menu para personalizar o Gemini.",
  score: 78,
};
const canaltechPhp = {
  url: CANALTECH_PHP,
  title: "IA revela falhas escondidas há mais de 10 anos no PHP",
  summary: "Ferramentas de intelig&ecirc;ncia artificial (IA) ajudaram pesquisadores a descobrir como explorar falhas de seguran&ccedil;a presentes no PHP h&aacute; mais de uma d&eacute;cada . As vulnerabilidades, que podem permitir invas&otilde;es de servidores, provocaram um alerta mundial nesta quarta-feira (21) e levaram governos e empresas a retirar sites do ar preventivamente.",
  score: 75,
};

const approved261023 = () => ({
  highlights: [d1],
  radar: [wizMirror, g1, chrome, geminiMenu],
  use_melhor: [canaltechPhp],
});

type Reserve = Array<{ bucket: string; article: { url?: string }; reason: string; matched_url?: string }>;

test("#11116 261023: G1 e Canaltech sobre o PHP vão para a reserva como same-story do D1", () => {
  const out = curatePool(approved261023());
  const reserve = out.pool_reserve as Reserve;
  const byUrl = new Map(reserve.map((r) => [r.article.url, r]));
  for (const url of [G1, CANALTECH_PHP]) {
    const r = byUrl.get(url);
    assert.ok(r, `${url} devia ir para a reserva`);
    assert.equal(r.reason, "same-story");
    assert.equal(r.matched_url, WIZ);
  }
  assert.ok(!out.radar?.some((a) => a.url === G1));
  assert.equal(out.use_melhor?.length, 0);
  // Controles: golpe no Chrome é outra história, Gemini não é incidente, e o
  // espelho do D1 fica para o dedup por URL do caps (não é reserva).
  assert.deepEqual(out.radar?.map((a) => a.url), [WIZ, CHROME, GEMINI_MENU]);
  assert.equal(reserve.length, 2, JSON.stringify(reserve, null, 1));
});

test("#11116: pelo applyStage2Caps, o item da mesma história sai e o espelho do D1 também", () => {
  const { approved } = applyStage2Caps(approved261023());
  const radarUrls = approved.radar?.map((a) => a.url) ?? [];
  assert.ok(!radarUrls.includes(G1));
  assert.ok(!radarUrls.includes(WIZ));
  assert.ok(radarUrls.includes(CHROME));
});

test("#11116: pool × pool — o 1º item da história fica, o seguinte vai para a reserva", () => {
  const out = curatePool({ radar: [g1, chrome], use_melhor: [canaltechPhp] });
  assert.deepEqual(out.radar?.map((a) => a.url), [G1, CHROME]);
  const reserve = out.pool_reserve as Reserve;
  assert.equal(reserve.length, 1);
  assert.equal(reserve[0].article.url, CANALTECH_PHP);
  assert.equal(reserve[0].matched_url, G1);
});

test("#11116: item reservado não derruba o próximo (só os mantidos viram referência)", () => {
  // O G1 sai por formato (listicle forçado no título); o Canaltech, sem o G1
  // como referência e sem destaque, fica.
  const listicleG1 = { ...g1, title: "5 melhores fatos sobre a falha grave de segurança no PHP" };
  const out = curatePool({ radar: [listicleG1], use_melhor: [canaltechPhp] });
  const reserve = out.pool_reserve as Reserve;
  assert.equal(reserve.length, 1);
  assert.equal(reserve[0].reason, "listicle");
  assert.equal(out.use_melhor?.length, 1);
});

test("#11116: item pinado pelo editor nunca vai para a reserva por mesma história", () => {
  const pinned = { ...canaltechPhp, flag: "editor_submitted" };
  const out = curatePool({ highlights: [d1], radar: [wizMirror, chrome], use_melhor: [pinned] });
  assert.equal(out.use_melhor?.length, 1);
  assert.equal((out.pool_reserve as Reserve).length, 0);
});

test("#11116: destaque de edição ANTERIOR não manda para a reserva por esta regra (segue só aviso, #11083)", () => {
  const past = [{
    aammdd: "261023",
    n: 1,
    url: WIZ,
    title: "Falhas no PHP colocam a internet em alerta global",
    text: "IA revelou falhas no PHP; sites saíram do ar.",
  }];
  const guardian = {
    url: "https://www.theguardian.com/technology/2026/oct/23/cybersecurity-ai-hacking-php-vulnerability",
    title: "‘Black October’: cybersecurity experts sound the alarm over new era of AI-enabled hacking",
    summary: "The PHP vulnerability exposed how AI changes cybersecurity.",
  };
  const out = curatePool({ radar: [guardian] }, past);
  assert.equal(out.radar?.length, 1, JSON.stringify(out.pool_reserve));
});

test("#11116: findIntraEditionFactRecurrences segue igual depois de virar wrapper do createStoryIndex", () => {
  const hl: IntraEditionItem[] = [{ label: "D1", title: d1.article.title, summary: d1.article.summary, url: WIZ }];
  const pool: IntraEditionItem[] = [canaltechPhp, g1, chrome, wizMirror, geminiMenu].map((a, i) => ({ label: i === 0 ? "use_melhor" : "radar", title: a.title, summary: a.summary, url: a.url }));
  const warnings = findIntraEditionFactRecurrences(hl, pool);
  assert.deepEqual(warnings.map((w) => w.item_url).sort(), [CANALTECH_PHP, G1].sort());
  // Índice: sem add, o 2º item do pool não é comparado ao 1º.
  const idx = createStoryIndex([], pool);
  assert.equal(idx.match(pool[1]), null);
  idx.add(pool[0]);
  assert.equal(idx.match(pool[1])?.matched_url, CANALTECH_PHP);
});
