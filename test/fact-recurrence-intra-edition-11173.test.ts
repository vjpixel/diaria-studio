/**
 * #11173: item do pool com a MESMA HISTÓRIA de um destaque da própria edição
 * (ou de outro item do pool) passava pelo dedup e o editor cortava no gate 4.
 * Fixtures = textos reais de `01-approved.json` das edições 261016 e 261023
 * (títulos, resumos e URLs copiados como estão, inclusive as entidades HTML).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findIntraEditionFactRecurrences, findFactRecurrences, type IntraEditionItem } from "../scripts/lib/fact-recurrence.ts";
import {
  checkIntraEditionFactRecurrence,
  readIntraEditionItems,
  STAGE_4_RULES,
} from "../scripts/lib/invariant-checks/stage-4.ts";

// --- 261023: D1 da Wiz (manchete em PT, sem "PHP") + pool ---------------------
const WIZ = "https://www.wiz.io/blog/php2shell-php-rce";
const D1_261023: IntraEditionItem = {
  label: "D1",
  title: "Sites de governos saem do ar após IA ajudar a revelar falhas no código usado por 70% da web",
  summary: "Serviços públicos e provedores de hospedagem dos países baixos interromperam acessos para aplicar correções; Cloudflare relata tentativas de ataque",
  url: WIZ,
};
const G1 = "https://g1.globo.com/tecnologia/noticia/2026/10/22/o-que-e-php-e-a-falha-grave-de-seguranca-detectada-por-ia-que-tirou-sites-do-ar.ghtml";
const CANALTECH_PHP = "https://canaltech.com.br/seguranca/ia-revela-falhas-escondidas-ha-mais-de-10-anos-no-php-entenda-a-descoberta/";
const CHROME = "https://canaltech.com.br/seguranca/chrome-reforca-ia-para-alertar-usuarios-sobre-golpes-e-lojas-falsas/";
const POOL_261023: IntraEditionItem[] = [
  {
    label: "use_melhor",
    title: "IA revela falhas escondidas há mais de 10 anos no PHP",
    summary: "Ferramentas de intelig&ecirc;ncia artificial (IA) ajudaram pesquisadores a descobrir como explorar falhas de seguran&ccedil;a presentes no PHP h&aacute; mais de uma d&eacute;cada . As vulnerabilidades, que podem permitir invas&otilde;es de servidores, provocaram um alerta mundial nesta quarta-feira (21) e levaram governos e empresas a retirar sites do ar preventivamente.",
    url: CANALTECH_PHP,
  },
  {
    label: "radar",
    title: "O que é PHP e a falha grave de segurança que tirou sites do ar",
    summary: "Durante mais de uma década, falhas graves passaram despercebidas em uma tecnologia usada por grande parte da internet. Foi preciso que a inteligência artificial as trouxesse à tona, causando um alerta global de segurança cibernética.",
    url: G1,
  },
  {
    label: "radar",
    title: "Chrome reforça IA para alertar usuários sobre golpes e lojas falsas",
    summary: "O Google Chrome ganhou uma nova medida de seguran&ccedil;a para alertar sobre sites suspeitos . Agora, o navegador exibe um aviso na tela para sinalizar que uma p&aacute;gina tem padr&otilde;es similares a outros links associados com tentativas de phishing, malwares e outras amea&ccedil;as.",
    url: CHROME,
  },
  {
    // Espelho do D1 no RADAR (mesma URL): não é história repetida, e o texto dele soma ao D1.
    label: "radar",
    title: "PHP2Shell: AI uncovers critical RCE vulnerabilities affecting 70% of the Internet",
    summary: "Core PHP engine flaws enable remote code execution and Heartbleed-style memory disclosure across the web.",
    url: WIZ,
  },
  {
    label: "radar",
    title: "Gemini ganha menu para conectar apps e criar funções sob medida",
    summary: "O Google anunciou em 21 de outubro um novo menu para personalizar o Gemini.",
    url: "https://canaltech.com.br/apps/gemini-ganha-menu-para-conectar-apps-e-criar-funcoes-sob-medida/",
  },
];

test("#11173 261023: Canaltech e G1 sobre a falha no PHP repetem o D1 da Wiz", () => {
  const warnings = findIntraEditionFactRecurrences([D1_261023], POOL_261023);
  const byUrl = new Map(warnings.map((w) => [w.item_url, w]));
  assert.ok(byUrl.has(CANALTECH_PHP), "Canaltech (USE MELHOR) devia avisar");
  assert.ok(byUrl.has(G1), "G1 (RADAR) devia avisar");
  for (const url of [CANALTECH_PHP, G1]) {
    const w = byUrl.get(url)!;
    assert.equal(w.matched_label, "D1");
    assert.ok(w.shared_entities.includes("php"), `entidade php em comum (${url})`);
  }
  // Controles: golpe no Chrome é outra história; o espelho do D1 não é comparado; Gemini não é incidente.
  assert.equal(warnings.length, 2, JSON.stringify(warnings, null, 1));
});

test("#11173 261023: sem o espelho, a sigla PHP no slug da URL do D1 ainda liga o G1", () => {
  const pool = POOL_261023.filter((p) => p.url !== WIZ);
  const w = findIntraEditionFactRecurrences([D1_261023], pool).find((x) => x.item_url === G1);
  assert.ok(w, "G1 devia avisar pelo slug php2shell-php-rce");
  assert.ok(w.url_entities.includes("php"));
});

// --- 261016: Android × Circle to Search (ambos do pool) ---------------------
const CIRCLE = "https://blog.google/innovation-and-ai/technology/safety-security/circle-to-search-android-text-message-scams/";
const ANDROID = "https://canaltech.com.br/inteligencia-artificial/android-ganha-superprotecao-por-ia-que-esconde-senhas-na-tela-e-barra-mensagens-falsas/";
const POOL_261016: IntraEditionItem[] = [
  {
    label: "radar",
    title: "Check if a text message is a scam using Circle to Search",
    summary: "Use Google Circle to Search to analyze suspicious texts for scams. Long-press your home button to get AI insights on messages. See how it works.",
    url: CIRCLE,
  },
  {
    label: "radar",
    title: "Como identificar vídeos feitos com IA e evitar golpes?",
    summary: "Aparência da imagem e contexto podem indicar uma falsificação; homem viajou mais de 2 mil quilômetros em busca de romance, mas pretendente era feita por IA",
    url: "https://www.cnnbrasil.com.br/nacional/brasil/como-identificar-videos-feitos-com-ia-e-evitar-golpes/",
  },
  {
    label: "radar",
    title: "Google DeepMind and Singapore Government collaborate to build fine-tuned AI model for scam detection",
    summary: "Learn how Google DeepMind and GovTech Singapore uses lightweight on-device Gemma models to intercept conversational scams in private chats with zero cloud data egress.",
    url: "https://deepmind.google/blog/on-device-ai-scam-detection-mddi/",
  },
  {
    label: "radar",
    title: "Android ganha superproteção por IA que esconde senhas na tela e barra mensagens falsas",
    summary: "O Google anunciou novas ferramentas de seguran&ccedil;a para o Android e o Google Messages com intelig&ecirc;ncia artificial (IA) para identificar mensagens suspeitas, combater golpes telef&ocirc;nicos e proteger dados pessoais. As novidades incluem a oculta&ccedil;&atilde;o autom&aacute;tica de senhas durante o compartilhamento de tela, a an&aacute;lise de conversas com poss&iacute;veis golpistas e o bloqueio de chamadas falsas que se passam por bancos.",
    url: ANDROID,
  },
];

test("#11173 261016: Android (Canaltech) repete o Circle to Search do blog do Google no mesmo pool", () => {
  const warnings = findIntraEditionFactRecurrences([], POOL_261016);
  assert.equal(warnings.length, 1, JSON.stringify(warnings, null, 1));
  assert.equal(warnings[0].item_url, ANDROID);
  assert.equal(warnings[0].matched_url, CIRCLE);
  assert.deepEqual(warnings[0].url_entities, ["android"]);
  // Ordem invertida: o par continua sendo achado (o aviso cai no item que vem depois).
  const reversed = findIntraEditionFactRecurrences([], [...POOL_261016].reverse());
  assert.equal(reversed.length, 1);
  assert.deepEqual([reversed[0].item_url, reversed[0].matched_url].sort(), [ANDROID, CIRCLE].sort());
});

test("#11173: manchete em Title Case não vira saco de entidades (260915, histórias distintas)", () => {
  const pool: IntraEditionItem[] = [
    { label: "radar", title: "Unbelievable: AI Breaches Are Exploding, And What It Means For You This Year", url: "https://forbes.com/ai-breaches-exploding-and-what-it-means-for-you" },
    { label: "radar", title: "What to know about recent dire AI predictions and calls for safeguards after hacks", url: "https://apnews.com/what-to-know-ai-predictions-and-safeguards" },
  ];
  assert.deepEqual(findIntraEditionFactRecurrences([], pool), []);
});

test("#11173: entidade comum isolada ou sem incidente não avisa; mesma URL é pulada", () => {
  const hl: IntraEditionItem = { label: "D1", title: "Microsoft sofre ataque de ransomware", url: "https://ms.com/a" };
  // Só "Microsoft" em comum (peso 1).
  assert.deepEqual(findIntraEditionFactRecurrences([hl], [{ label: "radar", title: "Falha no Teams da Microsoft é corrigida", url: "https://x.com/teams" }]), []);
  // Sem termo de incidente no item do pool.
  assert.deepEqual(findIntraEditionFactRecurrences([hl], [{ label: "radar", title: "Microsoft lança PHP 9 para Azure", url: "https://x.com/php9" }]), []);
});

test("#11173: o aviso entre edições (#11083) não ganhou os termos de golpe", () => {
  const past = '## 2026-10-20 — "Golpe com Pix e WhatsApp atinge clientes"\n';
  assert.deepEqual(findFactRecurrences([{ title: "Novo golpe no WhatsApp usa Pix falso", url: "https://x.com/g" }], past, "261026"), []);
});

// --- Stage 4: lê o 02-reviewed.md pré-gate ---------------------------------
const REVIEWED_261023 = `TÍTULO

Falhas no PHP colocam a internet em alerta global

---

**DESTAQUE 1 | 🔒 SEGURANÇA**

**[Falhas no PHP colocam a internet em alerta global](${WIZ})**

Duas falhas críticas no PHP, linguagem usada por cerca de 70% dos sites, levaram governos e empresas a desligar sistemas por precaução.

Batizadas de PHP2Shell, as falhas somam quatro bugs de memória e permitem executar código no servidor sem senha.

Por que isso importa:

Quando um modelo de linguagem acelera a pesquisa de falhas, encolhe o prazo entre a divulgação e a exploração.

---

**🛠️ USE MELHOR**

**[IA revela falhas escondidas há mais de 10 anos no PHP](${CANALTECH_PHP})**
Ferramentas de IA ajudaram pesquisadores a descobrir falhas de segurança presentes no PHP há mais de uma década. (5 min)

---

**📡 RADAR**

**[O que é PHP e a falha grave de segurança que tirou sites do ar](${G1})**
Durante mais de uma década, falhas graves passaram despercebidas em uma tecnologia usada por grande parte da internet.

**[Chrome reforça IA para alertar usuários sobre golpes e lojas falsas](${CHROME})**
O Google Chrome ganhou uma nova medida de segurança para alertar sobre sites suspeitos.

---
`;

test("#11173 Stage 4: parse do 02-reviewed.md separa destaque e pool", () => {
  const { highlights, pool } = readIntraEditionItems(REVIEWED_261023);
  assert.equal(highlights.length, 1);
  assert.equal(highlights[0].label, "D1");
  assert.equal(highlights[0].url, WIZ);
  assert.ok(!/DESTAQUE 1/.test(highlights[0].summary ?? ""), "rótulo do destaque não entra no texto (DESTAQUE/SEGURANÇA seriam siglas fortes)");
  assert.deepEqual(pool.map((p) => p.url), [CANALTECH_PHP, G1, CHROME]);
});

test("#11173 Stage 4: invariante warning-only aponta os dois itens do PHP", () => {
  assert.ok(STAGE_4_RULES.some((r) => r.id === "intra-edition-fact-recurrence" && r.stage === 4));
  const dir = mkdtempSync(join(tmpdir(), "intra-11173-"));
  try {
    const editionDir = join(dir, "261023");
    mkdirSync(editionDir);
    writeFileSync(join(editionDir, "02-reviewed.md"), REVIEWED_261023);
    const v = checkIntraEditionFactRecurrence(editionDir);
    assert.equal(v.length, 2, JSON.stringify(v, null, 1));
    assert.ok(v.every((x) => x.severity === "warning" && x.rule === "intra-edition-fact-recurrence" && /D1/.test(x.message)));
    assert.ok(v.some((x) => x.message.includes(G1)));
    assert.ok(v.some((x) => x.message.includes(CANALTECH_PHP)));
    // Sem o arquivo: nada.
    assert.deepEqual(checkIntraEditionFactRecurrence(join(dir, "inexistente")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
