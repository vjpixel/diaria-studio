/**
 * #9615: três falsos positivos do sinal (C) do event-dedup (#8666), achados no
 * review consolidado de 03/10 (PR #9560):
 *   1. `invadiu`/`invadida` eram fortes sem contexto — "ChatGPT invadiu as
 *      escolas" (figurativo) casava com uma invasão real da OpenAI;
 *   2. a pista `usuários` do LEAK valia em qualquer posição — vazamento de
 *      PRODUTO "para usuários beta" virava vazamento de dados;
 *   3. `check-highlight-themes` (crossEditionMode, até 10 edições passadas)
 *      recebia `SAME_EDITION` e o (C) disparava fora da janela de ≤2 dias.
 * Os títulos são os reproduzidos no corpo da issue em HEAD (ed8f58fe5).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sameEvent, strongEventConcepts } from "../scripts/lib/event-dedup.ts";
import { isIntraEditionDuplicate } from "../scripts/dedup-intra-edition.ts";
import { checkFullBodyThemes } from "../scripts/check-highlight-themes.ts";

const DISTANCES = [0, 1, 2];

test("#9615 (1): 'invadiu' figurativo não casa com invasão real da mesma empresa", () => {
  for (const d of DISTANCES) {
    assert.equal(
      sameEvent("ChatGPT invadiu as escolas brasileiras", "OpenAI foi invadida por hackers", { distanceDays: d }),
      null,
      `d=${d}`,
    );
  }
  assert.equal(strongEventConcepts("ChatGPT invadiu as escolas brasileiras").size, 0);
  assert.equal(strongEventConcepts("Assistentes de IA invadiram as salas de aula").size, 0);
  assert.equal(strongEventConcepts("Escolas invadidas pelo ChatGPT").size, 0);
});

test("#9615 (1): pretérito/particípio com contexto de segurança seguem fortes", () => {
  for (const t of [
    "OpenAI foi invadida por hackers",
    "Microsoft é invadida por hackers chineses",
    "Hackers invadiram a Microsoft",
    "Contas da OpenAI foram invadidas",
    "Grupo invadiu servidores da Meta",
    "Criminosos invadiram contas do ChatGPT",
  ]) {
    assert.ok(strongEventConcepts(t).has("HACK"), t);
  }
  const m = sameEvent("Hackers invadiram a OpenAI", "OpenAI foi invadida por hackers", { distanceDays: 1 });
  assert.ok(m);
  assert.equal(m.removable, true);
});

test("#9615 (2): 'usuários' longe do termo de vazamento não acende LEAK", () => {
  for (const d of DISTANCES) {
    assert.equal(
      sameEvent("Google vaza recurso do Gemini para usuários beta", "Google sofre vazamento de dados", { distanceDays: d }),
      null,
      `d=${d}`,
    );
  }
  assert.equal(strongEventConcepts("Google vaza recurso do Gemini para usuários beta").size, 0);
  // Mesmo perto, "para usuários" é destinatário, não dado vazado.
  assert.equal(strongEventConcepts("Meta vaza novo app para usuários").size, 0);
});

test("#9615 (2): vazamento de dados de usuários segue forte", () => {
  for (const t of [
    "Google sofre vazamento de dados",
    "Meta vazou dados de usuários do Instagram",
    "Senhas de usuários do ChatGPT vazaram",
    "Vazamento expõe conversas de usuários do ChatGPT",
    "OpenAI leaked user data",
    "Meta data leak exposes millions of accounts",
  ]) {
    assert.ok(strongEventConcepts(t).has("LEAK"), t);
  }
});

test("#9615 (3): crossEditionMode não liga o (C) — distância real desconhecida", () => {
  const article = { title: "OpenAI foi invadida por hackers que usaram rival do ChatGPT", url: "https://example.com/a" };
  const past = [{ title: "Claude ajudou a invadir a OpenAI em menos de 3 dias", url: "https://example.com/b" }];
  // Intra-edição (sem crossEditionMode) continua casando pelo (C).
  const intra = isIntraEditionDuplicate(article, past);
  assert.ok(intra);
  assert.equal(intra.match_type, "event");
  // Cross-edição (até 10 edições atrás) não pode usar o (C).
  const cross = isIntraEditionDuplicate(article, past, { crossEditionMode: true });
  assert.notEqual(cross?.match_type, "event");

  const res = checkFullBodyThemes(
    [{ rank: 1, title: article.title, url: article.url }],
    [{ edition: "260921", bucket: "destaque", title: past[0].title, url: past[0].url }],
  );
  assert.equal(res.full_body_warnings.filter((w) => w.match_type === "event").length, 0);
});
