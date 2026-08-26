/**
 * test/poll-web-gate-4253.test.ts (#4253)
 *
 * Achados do editor jogando ao vivo o `/jogar` (aba anônima, caminho de
 * fora) em 260728: o gate por rodada (#4054/#4109/#4121) estava agressivo
 * demais e, no item 6, quebrado — quem cadastrava pelo gate não entrava no
 * ranking. Esta suíte cobre os 6 ajustes da issue (item 1, título da
 * sequência, já coberto em poll-jogar-cold-visitor-4005.test.ts; item 5,
 * maskEmail, já coberto em poll-batch-3118.test.ts e integração nos
 * arquivos de leaderboard):
 *
 *   2. Copy do gate — vende a vantagem (ranking), não cobra pedágio.
 *   3. Nudge só a partir da 5ª rodada, depois a cada 5 (contador
 *      ROUNDS_PLAYED_COOKIE em vez do binário FREE_ROUND_COOKIE).
 *   4. Opt-in de newsletter deixa de ser pré-requisito pra continuar.
 *   6. BUGFIX: cadastro/login pelo gate aciona POST /jogar/identify (mesma
 *      máquina do form de identidade do jogo, #3975) — mergeia o histórico
 *      anônimo, grava nickname a partir do nome, e persiste
 *      localStorage["eia_web_identified_email"]. Regressão de #633.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, { type Env } from "../workers/poll/src/index.ts";
import { subscriberKvKey } from "../workers/poll/src/subscriber-verify.ts";
import {
  ROUNDS_PLAYED_COOKIE,
  ROUNDS_NUDGE_INTERVAL,
  roundsHitNudgeThreshold,
  renderJogarGatePage,
  readWebSession,
  WEB_SESSION_COOKIE,
  issueWebSessionCookie,
} from "../workers/poll/src/web-gate.ts";

function makeMapKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      const v = m.get(key);
      return v === undefined ? null : v;
    },
    async getWithMetadata(key: string) {
      const v = m.get(key);
      return { value: v ?? null, metadata: null };
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string; cursor?: string } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
    _map: m,
  };
}

const makeEnv = (overrides: Partial<Env> = {}): Env & { POLL: ReturnType<typeof makeMapKV> } => ({
  POLL: makeMapKV(),
  POLL_SECRET: "poll-secret",
  ADMIN_SECRET: "admin-secret",
  ALLOWED_ORIGINS: "*",
  COOKIE_HMAC_SECRET: "cookie-secret",
  ...overrides,
});

function getCookieHeader(res: Response): string | null {
  return res.headers.get("Set-Cookie");
}

// ── item 2: copy do gate ─────────────────────────────────────────────────────

describe("#4253 item 2: copy do gate vende a vantagem, não cobra pedágio", () => {
  const html = renderJogarGatePage(null);

  it("h1 pergunta pelo ranking, não anuncia fim da rodada livre", () => {
    assert.match(html, /<h1>Quer disputar o ranking\?<\/h1>/);
    assert.doesNotMatch(html, /Você já jogou sua rodada livre/);
  });

  it("texto explicativo deixa claro que dá pra continuar jogando sem cadastrar", () => {
    assert.match(html, /Continuar jogando sem cadastrar também vale/);
  });

  it("botão principal é 'Entrar no ranking', não 'Continuar jogando'", () => {
    assert.match(html, /<button type="submit">Entrar no ranking<\/button>/);
  });

  it("link de skip é 'Continuar sem cadastrar', não 'Agora não, continuar jogando'", () => {
    assert.match(html, /Continuar sem cadastrar/);
    assert.doesNotMatch(html, /Agora não, continuar jogando/);
  });

  it("título da aba reflete a nova copy", () => {
    assert.match(html, /<title>É IA\? \| Entrar no ranking<\/title>/);
  });

  it("mensagem de opt-in obrigatório não existe mais no script (item 4)", () => {
    assert.doesNotMatch(html, /Marque a caixinha pra assinar e continuar/);
  });
});

// ── item 3: nudge por contador, não binário ─────────────────────────────────

describe("#4253 item 3: roundsHitNudgeThreshold (pure)", () => {
  it("ROUNDS_NUDGE_INTERVAL é 5", () => {
    assert.equal(ROUNDS_NUDGE_INTERVAL, 5);
  });

  it("0 rodadas → não gateia", () => {
    assert.equal(roundsHitNudgeThreshold(0), false);
  });

  it("1 a 4 rodadas → não gateia (nunca mais bloqueia na 1ª)", () => {
    for (const n of [1, 2, 3, 4]) assert.equal(roundsHitNudgeThreshold(n), false, `count=${n}`);
  });

  it("5 rodadas → gateia (1º nudge)", () => {
    assert.equal(roundsHitNudgeThreshold(5), true);
  });

  it("6 a 9 rodadas → não gateia (nudge é periódico, não permanente a partir da 5ª)", () => {
    for (const n of [6, 7, 8, 9]) assert.equal(roundsHitNudgeThreshold(n), false, `count=${n}`);
  });

  it("10, 15, 20 rodadas → gateiam (múltiplos seguintes)", () => {
    for (const n of [10, 15, 20]) assert.equal(roundsHitNudgeThreshold(n), true, `count=${n}`);
  });
});

describe("#4253 item 3: GET /jogar usa o contador ROUNDS_PLAYED_COOKIE, não um binário", () => {
  it("contador em 4 (abaixo do limiar) + SEM sessão → jogo normal, sem gate", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://poll.test/jogar", { headers: { Cookie: `${ROUNDS_PLAYED_COOKIE}=4` } }),
      env,
    );
    assert.equal(res.status, 200);
    assert.doesNotMatch(await res.text(), /Quer disputar o ranking\?/);
  });

  it("contador em 5 (no limiar) + SEM sessão → gate", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://poll.test/jogar", { headers: { Cookie: `${ROUNDS_PLAYED_COOKIE}=5` } }),
      env,
    );
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Quer disputar o ranking\?/);
  });

  it("contador em 9 (entre múltiplos) + SEM sessão → jogo normal, sem gate", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://poll.test/jogar", { headers: { Cookie: `${ROUNDS_PLAYED_COOKIE}=9` } }),
      env,
    );
    assert.equal(res.status, 200);
    assert.doesNotMatch(await res.text(), /Quer disputar o ranking\?/);
  });

  it("contador em 10 (2º múltiplo) + SEM sessão → gate de novo", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://poll.test/jogar", { headers: { Cookie: `${ROUNDS_PLAYED_COOKIE}=10` } }),
      env,
    );
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Quer disputar o ranking\?/);
  });

  it("cookie inválido/não-numérico → tratado como 0, nunca lança", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://poll.test/jogar", { headers: { Cookie: `${ROUNDS_PLAYED_COOKIE}=abc` } }),
      env,
    );
    assert.equal(res.status, 200);
    assert.doesNotMatch(await res.text(), /Quer disputar o ranking\?/);
  });
});

// ── item 4: opt-in deixa de ser pré-requisito ───────────────────────────────

describe("#4253 item 4: POST /jogar/gate/subscribe sem opt-in", () => {
  function subReq(body: unknown) {
    return new Request("https://poll.test/jogar/gate/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("sem optin → 200 + cookie de sessão PENDING (NUNCA confirmed), SEM tocar a Beehiiv", async () => {
    // Achado do review consolidado (findings convergentes de 4/5 agentes):
    // sem NENHUMA verificação (nem Beehiiv, nem KV), emitir "confirmed"
    // reabriria a vulnerabilidade do #4121 — vote.ts sobrepõe a identidade do
    // voto pra QUALQUER sessão confirmed, então "confirmed" sem prova de
    // posse permitiria a qualquer um digitar o e-mail de outra pessoa e
    // herdar a identidade de voto dela. "pending" ainda libera o gate
    // normalmente (#4121); a identidade de ranking de verdade vem do merge
    // via /jogar/identify (item 6), independente deste cookie.
    const env = makeEnv({ BEEHIIV_API_KEY: "test-key", BEEHIIV_PUBLICATION_ID: "pub_test" });
    let beehiivCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      beehiivCalled = true;
      throw new Error("não deveria chamar a Beehiiv sem opt-in");
    }) as typeof fetch;
    try {
      const res = await worker.fetch(subReq({ email: "semoptin@example.com", name: "Fulano", optin: false }), env);
      assert.equal(res.status, 200);
      assert.equal(beehiivCalled, false);
      const setCookie = getCookieHeader(res);
      assert.ok(setCookie, "deve emitir cookie de sessão mesmo sem opt-in");
      const raw = setCookie!.split(";")[0].split("=")[1];
      const session = await readWebSession("cookie-secret", `${WEB_SESSION_COOKIE}=${raw}`);
      assert.deepEqual(session, { email: "semoptin@example.com", pending: true }, "sem qualquer verificação, a sessão NUNCA pode sair confirmed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("SEGURANÇA (regressão #4121): sessão emitida sem opt-in NÃO sobrepõe a identidade do voto", async () => {
    const anonEmail = "3fa85f64-5717-4562-b3fc-2c963f66afa6@web.eia.diaria.local";
    const env = makeEnv({ COOKIE_HMAC_SECRET: "cookie-secret" });
    const res = await worker.fetch(subReq({ email: "vitima@example.com", optin: false }), env);
    const setCookie = getCookieHeader(res)!;
    const sessionCookie = setCookie.split(";")[0];
    const voteRes = await worker.fetch(
      new Request(
        `https://poll.test/vote?email=${encodeURIComponent(anonEmail)}&edition=260701&choice=A&brand=web`,
        { headers: { Cookie: sessionCookie } },
      ),
      env,
    );
    assert.equal(voteRes.status, 200);
    assert.ok(
      env.POLL._map.has(`web:vote:260701:${anonEmail}`),
      "voto deve continuar sob o token anônimo — a sessão sem opt-in não prova posse do e-mail",
    );
    assert.ok(
      !env.POLL._map.has("web:vote:260701:vitima@example.com"),
      "NUNCA deve gravar sob o e-mail da sessão sem verificação — reabriria o #4121",
    );
  });

  it("sem optin e sem COOKIE_HMAC_SECRET → 503 gate_unavailable (nunca 200 sem cookie)", async () => {
    const env = makeEnv({ COOKIE_HMAC_SECRET: undefined });
    const res = await worker.fetch(subReq({ email: "x@example.com", optin: false }), env);
    assert.equal(res.status, 503);
    assert.equal(getCookieHeader(res), null);
  });

  it("com optin, comportamento pré-#4253 INALTERADO: Beehiiv não configurado → 503", async () => {
    const env = makeEnv();
    const res = await worker.fetch(subReq({ email: "x@example.com", optin: true }), env);
    assert.equal(res.status, 503);
    const data = (await res.json()) as { error: string };
    assert.equal(data.error, "subscribe_unavailable");
  });

  it("com optin, sucesso → cookie PENDING (comportamento pré-#4253 preservado, ver #4121)", async () => {
    const env = makeEnv({ BEEHIIV_API_KEY: "test-key", BEEHIIV_PUBLICATION_ID: "pub_test" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { id: "sub_1" } }), { status: 201 })) as typeof fetch;
    try {
      const res = await worker.fetch(subReq({ email: "comoptin@example.com", optin: true }), env);
      assert.equal(res.status, 200);
      const setCookie = getCookieHeader(res);
      const raw = setCookie!.split(";")[0].split("=")[1];
      const session = await readWebSession("cookie-secret", `${WEB_SESSION_COOKIE}=${raw}`);
      assert.deepEqual(session, { email: "comoptin@example.com", pending: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("e-mail inválido ainda é rejeitado mesmo sem optin", async () => {
    const env = makeEnv();
    const res = await worker.fetch(subReq({ email: "não-é-email", optin: false }), env);
    assert.equal(res.status, 400);
  });

  it("rate-limit continua valendo pro caminho sem opt-in", async () => {
    const env = makeEnv();
    const mkReq = () =>
      new Request("https://poll.test/jogar/gate/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "y@example.com", optin: false }),
      });
    let last: Response | null = null;
    for (let i = 0; i < 9; i++) {
      last = await worker.fetch(
        new Request(mkReq(), { headers: { "Content-Type": "application/json", "CF-Connecting-IP": "8.8.4.4" } }),
        env,
      );
    }
    assert.equal(last!.status, 429);
  });
});

// ── item 6 (bugfix): gate aciona /jogar/identify — merge + nickname + localStorage ──

describe("#4253 item 6: gate script aciona POST /jogar/identify após verify/subscribe", () => {
  const html = renderJogarGatePage(null);

  it("script chama /jogar/identify?brand=web com email, name e anonEmail lido do token", () => {
    assert.match(html, /\/jogar\/identify\?brand=web/);
    assert.match(html, /name:\s*name,\s*email:\s*email,\s*anonEmail:\s*anonEmail/);
  });

  it("token anônimo é lido de localStorage/cookie eia_web_token (read-only, nunca cria)", () => {
    assert.match(html, /localStorage\.getItem\("eia_web_token"\)/);
    assert.match(html, /readCookie\("eia_web_token"\)/);
  });

  it("optin do POST /jogar/identify é SEMPRE false (Beehiiv já resolvida por verify/subscribe)", () => {
    assert.match(html, /optin:\s*false,\s*edition:\s*GATE_EDITION/);
  });

  it("identifyAfterGate resolve { pending: true } no histórico órfão, ANTES de tocar localStorage", () => {
    assert.match(html, /if \(d && d\.ok && d\.pending\) return \{ pending: true \};/);
    assert.match(html, /localStorage\.setItem\("eia_web_identified_email", email\)/);
  });

  it("SEGURANÇA (achado do review consolidado, silent-failure): pending NÃO redireciona em silêncio — mostra a mensagem de confirmação por e-mail antes de deixar continuar", () => {
    assert.match(html, /function afterIdentify\(result\) \{/);
    assert.match(html, /if \(result && result\.pending\) \{/);
    assert.match(html, /Enviamos um e-mail de confirmação/);
  });

  it("identifyAfterGate roda ANTES do redirect pro jogo, nos dois caminhos (verify OK e subscribe OK) — via afterIdentify", () => {
    assert.match(html, /if \(data\.ok\) \{ return identifyAfterGate\(email, name\)\.then\(afterIdentify\); \}/);
    assert.match(html, /if \(data2 && data2\.ok && !data2\.sessionUnavailable\) \{ return identifyAfterGate\(email, name\)\.then\(afterIdentify\); \}/);
  });

  it("edição representativa (?edition=) é repassada como GATE_EDITION pro merge mensal", () => {
    const htmlComEdicao = renderJogarGatePage("260701");
    assert.match(htmlComEdicao, /var GATE_EDITION = "260701";/);
    assert.match(html, /var GATE_EDITION = "";/);
  });

  it("verify agora envia 'name' no corpo (antes só mandava email+website)", () => {
    assert.match(html, /body: JSON\.stringify\(\{ email: email, name: name, website: website \}\)/);
  });

  // SEGURANÇA (achado do review consolidado — findings convergentes de 4/5
  // agentes): a 1ª versão deste PR tinha o campo "Nome" OPCIONAL no gate.
  // identify.ts só roda a checagem de histórico órfão (#3996) quando `name`
  // não é vazio (a premissa é que name="" só vem do re-sync silencioso
  // automático, nunca de um submit humano explícito) — um "Nome" opcional no
  // gate permitia bypassar #3996 pela UI normal (sem forjar request nenhuma):
  // bastava digitar o e-mail de alguém com histórico já estabelecido sob
  // OUTRO device e deixar o nome em branco pra mergear na hora, sem
  // confirmação por link mágico. Fix: nome é required (client + validação JS).

  it("SEGURANÇA (#3996): campo 'Nome' do gate é required — nunca mais opcional", () => {
    assert.match(html, /<input type="text" name="name" placeholder="[^"]*" required>/);
    assert.doesNotMatch(html, /placeholder="Nome \(opcional\)"/);
  });

  it("SEGURANÇA (#3996): submit com nome vazio é bloqueado no client ANTES de qualquer fetch", () => {
    assert.match(html, /if \(!name\) \{ setMsg\("Digite seu nome ou apelido\.", "err"\); return; \}/);
  });
});

describe("#4253 item 6 SEGURANÇA: proteção de histórico órfão (#3996) preservada via o gate", () => {
  it("e-mail com score PRÉ-EXISTENTE sob OUTRO token → pending:true, NÃO mergeia na hora (mesmo vindo do gate, com nome preenchido)", async () => {
    const attackerAnonEmail = "3fa85f64-5717-4562-b3fc-2c963f66afa6@web.eia.diaria.local";
    const env = makeEnv({
      POLL: makeMapKV({
        // vítima já tem histórico estabelecido sob um token DIFERENTE do atacante.
        "web:score:vitima@example.com": JSON.stringify({ total: 500, correct: 400, streak: 10, last_edition: "260701" }),
        [`web:score:${attackerAnonEmail}`]: JSON.stringify({ total: 3, correct: 1, streak: 1, last_edition: "260701" }),
      }) as unknown as ReturnType<typeof makeMapKV>,
    });
    const res = await worker.fetch(
      new Request("https://poll.test/jogar/identify?brand=web", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Atacante", // nome preenchido (agora obrigatório no gate) — NÃO deve bypassar a checagem
          email: "vitima@example.com",
          anonEmail: attackerAnonEmail,
          optin: false,
          edition: "",
        }),
      }),
      env,
    );
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean; pending?: boolean };
    assert.equal(data.ok, true);
    assert.equal(data.pending, true, "histórico órfão deve exigir confirmação por link mágico, nunca merge imediato");
    const scoreRaw = await env.POLL.get("web:score:vitima@example.com");
    const score = JSON.parse(scoreRaw!);
    assert.equal(score.total, 500, "score da vítima NUNCA deve ser alterado sem confirmação — reabriria o #3996");
  });
});

describe("#4253 item 6: POST /jogar/identify (máquina reusada, ver poll-jogar-identify-3975.test.ts pro resto da cobertura)", () => {
  it("merge imediato: histórico anônimo + nickname a partir de name aparecem em score:{email}", async () => {
    const anonEmail = "3fa85f64-5717-4562-b3fc-2c963f66afa6@web.eia.diaria.local";
    const env = makeEnv({
      POLL: makeMapKV({
        [`web:score:${anonEmail}`]: JSON.stringify({ total: 3, correct: 2, streak: 2, last_edition: "260701" }),
      }) as unknown as ReturnType<typeof makeMapKV>,
    });
    const res = await worker.fetch(
      new Request("https://poll.test/jogar/identify?brand=web", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Fulano", email: "fulano@example.com", anonEmail, optin: false, edition: "" }),
      }),
      env,
    );
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean; subscribed: boolean };
    assert.equal(data.ok, true);
    const scoreRaw = await env.POLL.get("web:score:fulano@example.com");
    assert.ok(scoreRaw, "score:{email} deve existir após o merge — este é o bug original: ficava vazio");
    const score = JSON.parse(scoreRaw!);
    assert.equal(score.total, 3);
    assert.equal(score.correct, 2);
    assert.equal(score.nickname, "Fulano", "nickname deve vir do name — este é o bug original: nome era descartado");
  });
});

describe("#4258 item 4: campo nome vem ANTES do e-mail no form do gate (consistência com identityFormScript)", () => {
  it("input name aparece antes do input email no HTML", () => {
    const html = renderJogarGatePage(null);
    const nameIdx = html.indexOf('<input type="text" name="name"');
    const emailIdx = html.indexOf('<input type="email" name="email"');
    assert.ok(nameIdx > -1 && emailIdx > -1, "ambos os campos devem existir");
    assert.ok(nameIdx < emailIdx, "campo nome deve vir antes do campo e-mail no markup");
  });
});

describe("#4268: gate no meio da sequência NUNCA joga o jogador pra fora dela (regressão, achado ao vivo)", () => {
  // Bug real reproduzido pelo editor 2x seguidas: goNext() em jogar.ts passa
  // `edition=editions[0]` pro gate (só pro CONTEXTO do identify — deriva o
  // índice mensal do merge, #4253 item 6). Antes do fix, tanto o link de
  // skip quanto o redirect pós-cadastro reusavam ESSE MESMO param como alvo
  // de navegação — handleJogarPage despacha pra página de UMA edição só
  // (sem next-round) sempre que a URL tem `?edition=`, então o jogador saía
  // da sequência de verdade e caía numa página sem "próxima rodada". Se
  // editions[0] já tinha voto de sessão anterior (comum pra quem testa o
  // jogo com frequência), /vote respondia "já votou" sem caminho de volta —
  // dead end. Fix: skipHref/goToGame nunca mais carregam `edition=`.
  it("link 'Continuar sem cadastrar' NUNCA leva edition= no href, mesmo quando a página recebeu uma edição (contexto do identify)", () => {
    const html = renderJogarGatePage("260601");
    const hrefMatch = html.match(/class="skip-link" href="([^"]+)"/);
    assert.ok(hrefMatch, "link de skip deve existir");
    const href = hrefMatch![1];
    assert.ok(
      !/[?&]edition=/.test(href),
      `#4268: href do skip-link não pode conter edition= (jogaria o jogador pra fora da sequência) — href real: ${href}`,
    );
    assert.match(href, /skip_gate=1/, "skip continua liberando esta navegação específica");
  });

  it("goToGame() (redirect pós-verify OU pós-subscribe bem-sucedidos — login E cadastro passam por aqui, ver docstring da função) NUNCA leva edition= no alvo de navegação", () => {
    const html = renderJogarGatePage("260601");
    const fnMatch = html.match(/function goToGame\(\) \{[\s\S]*?window\.location\.href = ([^;]+);/);
    assert.ok(fnMatch, "goToGame() deve existir no script");
    const expr = fnMatch![1];
    assert.ok(
      !/edition/.test(expr),
      `#4268: expressão de goToGame() não pode referenciar edition= (mesmo dead end do skip-link, só que depois de verify/subscribe) — expressão real: ${expr}`,
    );
  });

  it("GATE_EDITION (contexto do identify, propósito ORIGINAL do param) continua correto — só a navegação mudou", () => {
    const html = renderJogarGatePage("260601");
    assert.match(
      html,
      /var GATE_EDITION = "260601"/,
      "#4268: o fix não pode remover o contexto que o identify precisa pra derivar o índice mensal do merge (#4253 item 6) — só a navegação (skip/goToGame) parar de reusar esse valor",
    );
  });

  it("sem edition nenhuma (gate no carregamento inicial de /jogar, sem sequência em andamento): comportamento pré-existente intocado", () => {
    const html = renderJogarGatePage(null);
    const hrefMatch = html.match(/class="skip-link" href="([^"]+)"/);
    assert.ok(hrefMatch);
    assert.ok(!/edition=/.test(hrefMatch![1]));
    assert.match(html, /var GATE_EDITION = ""/);
  });

  // Achado do review consolidado (2 agentes convergentes): os 4 testes acima
  // só checam a STRING de saída de renderJogarGatePage — nunca a rota de
  // verdade (handleJogarPage, jogar.ts) que causou o dead end. Os 2 testes
  // abaixo fecham esse gap fim-a-fim via worker.fetch, seguindo o mesmo
  // padrão já usado em test/poll-web-gate-4054.test.ts:349-360 (?edition=
  // explícito + skip_gate=1). Distingue sequência de edição única pelo
  // <title> (única string sempre presente independente do KV/total de
  // rodadas — "seq-round-result" e afins só aparecem quando total > 0,
  // ver renderJogarSequencePageHtml em jogar.ts).
  const SEQUENCE_TITLE_MARKER = "qual imagem foi feita por IA?";
  const SINGLE_EDITION_TITLE_MARKER = "jogue e vote";

  it("fim-a-fim: skipHref extraído do gate no meio da sequência resolve pra sequência, NUNCA pra edição única", async () => {
    const env = makeEnv();
    // Simula goNext() (jogar.ts:1873, atualizado no #4271): gate no meio da
    // sequência repassa seq_ctx_edition=editions[0] (NUNCA edition=) só como
    // contexto do identify.
    const gateRes = await worker.fetch(
      new Request("https://poll.test/jogar?seq_ctx_edition=260601", {
        headers: { Cookie: `${ROUNDS_PLAYED_COOKIE}=5` },
      }),
      env,
    );
    assert.equal(gateRes.status, 200);
    assert.equal(gateRes.headers.get("X-Eia-Gate"), "1", "essa request deve mesmo cair no gate (contador no limiar, sem sessão)");
    const gateHtml = await gateRes.text();
    const hrefMatch = gateHtml.match(/class="skip-link" href="([^"]+)"/);
    assert.ok(hrefMatch, "gate deve ter o link de skip");
    const skipHref = hrefMatch![1];

    const nextRes = await worker.fetch(
      new Request(`https://poll.test${skipHref}`, { headers: { Cookie: `${ROUNDS_PLAYED_COOKIE}=5` } }),
      env,
    );
    assert.equal(nextRes.status, 200);
    const nextHtml = await nextRes.text();
    assert.match(
      nextHtml,
      new RegExp(SEQUENCE_TITLE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "#4268: skipHref deve resolver pra sequência (23 rodadas), não pra edição única — regressão reproduzida ao vivo",
    );
    assert.doesNotMatch(nextHtml, new RegExp(SINGLE_EDITION_TITLE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("fim-a-fim: goToGame() (pós-verify/subscribe, sessão já válida) resolve pra sequência, NUNCA pra edição única", async () => {
    const env = makeEnv();
    const gateRes = await worker.fetch(
      new Request("https://poll.test/jogar?seq_ctx_edition=260601", {
        headers: { Cookie: `${ROUNDS_PLAYED_COOKIE}=5` },
      }),
      env,
    );
    const gateHtml = await gateRes.text();
    const fnMatch = gateHtml.match(/function goToGame\(\) \{[\s\S]*?window\.location\.href = ([^;]+);/);
    assert.ok(fnMatch, "gate deve ter goToGame()");
    // avalia a expressão JS ("/jogar?v=" + Date.now()) do jeito que o
    // browser faria — sem Date.now() real (proibido em scripts, mas isto é
    // um teste comum, não um workflow script), então trocamos por um valor
    // fixo equivalente antes de avaliar.
    const expr = fnMatch![1].replace(/Date\.now\(\)/g, "1");
    // eslint-disable-next-line no-new-func
    const target = new Function(`return ${expr};`)() as string;

    // Sessão válida (simula pós-verify/subscribe bem-sucedidos) — gate não
    // deve reaparecer, então o dispatch cai direto no branch sem edition.
    const sessionCookie = (await issueWebSessionCookie("cookie-secret", "leitor@example.com", "confirmed")).split(";")[0];
    const nextRes = await worker.fetch(
      new Request(`https://poll.test${target}`, {
        headers: { Cookie: `${ROUNDS_PLAYED_COOKIE}=5; ${sessionCookie}` },
      }),
      env,
    );
    assert.equal(nextRes.status, 200);
    const nextHtml = await nextRes.text();
    assert.match(
      nextHtml,
      new RegExp(SEQUENCE_TITLE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "#4268: goToGame() deve resolver pra sequência (23 rodadas), não pra edição única — regressão reproduzida ao vivo",
    );
    assert.doesNotMatch(nextHtml, new RegExp(SINGLE_EDITION_TITLE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("#4271: gate via link de edição única de verdade preserva o destino pós-skip/cadastro", () => {
  // Follow-up do #4268/#4269 (tradeoff aceito então, resolvido agora): quem
  // chega no gate via um link de edição única de verdade (ponte
  // clarice/arquivo, jogar.ts ~linha 2190, #3524/#3578) — não via goNext() no
  // meio da sequência — precisa voltar pra ESSA edição específica após
  // skip/cadastro, não pra sequência genérica. Diferenciado agora por NOME de
  // param: `seq_ctx_edition=` (só goNext()) nunca vira destino de navegação;
  // `edition=` sobrevivendo na URL de entrada SEM `seq_ctx_edition=` é, de
  // fato, uma navegação real pra edição única.
  const SEQUENCE_TITLE_MARKER = "qual imagem foi feita por IA?";
  const SINGLE_EDITION_TITLE_MARKER = "jogue e vote";

  it("renderJogarGatePage(ctx, targetEdition) inclui edition= no skip-link quando targetEdition é passado", () => {
    const html = renderJogarGatePage("260601", "260601");
    const hrefMatch = html.match(/class="skip-link" href="([^"]+)"/);
    assert.ok(hrefMatch, "link de skip deve existir");
    assert.match(
      hrefMatch![1],
      /[?&]edition=260601\b/,
      "#4271: skip-link deve preservar edition= quando o gate veio de um link de edição única real",
    );
    assert.match(hrefMatch![1], /skip_gate=1/, "skip continua liberando esta navegação específica");
  });

  it("renderJogarGatePage(ctx, targetEdition) inclui edition= no alvo de goToGame() quando targetEdition é passado", () => {
    const html = renderJogarGatePage("260601", "260601");
    const fnMatch = html.match(/function goToGame\(\) \{[\s\S]*?window\.location\.href = ([^;]+);/);
    assert.ok(fnMatch, "goToGame() deve existir no script");
    const expr = fnMatch![1].replace(/Date\.now\(\)/g, "1");
    // eslint-disable-next-line no-new-func
    const target = new Function(`return ${expr};`)() as string;
    assert.match(target, /[?&]edition=260601\b/, "#4271: goToGame() deve preservar edition= quando o gate veio de um link de edição única real");
  });

  it("sem targetEdition (default, caso da sequência): skip-link e goToGame() continuam sem edition= — #4268 intocado", () => {
    const html = renderJogarGatePage("260601");
    const hrefMatch = html.match(/class="skip-link" href="([^"]+)"/);
    assert.ok(hrefMatch);
    assert.ok(!/[?&]edition=/.test(hrefMatch![1]));
    const fnMatch = html.match(/function goToGame\(\) \{[\s\S]*?window\.location\.href = ([^;]+);/);
    assert.ok(fnMatch);
    assert.ok(!/edition/.test(fnMatch![1]));
  });

  it("fim-a-fim: link de edição única de verdade no gate — skipHref preserva a edição pedida, NUNCA cai na sequência genérica", async () => {
    const env = makeEnv();
    // Navegação real pra 1 edição (sem seq_ctx_edition=) cruzando o nudge
    // sem sessão — o cenário descrito na issue #4271.
    const gateRes = await worker.fetch(
      new Request("https://poll.test/jogar?edition=260601", {
        headers: { Cookie: `${ROUNDS_PLAYED_COOKIE}=5` },
      }),
      env,
    );
    assert.equal(gateRes.status, 200);
    assert.equal(gateRes.headers.get("X-Eia-Gate"), "1", "essa request deve mesmo cair no gate (contador no limiar, sem sessão)");
    const gateHtml = await gateRes.text();
    const hrefMatch = gateHtml.match(/class="skip-link" href="([^"]+)"/);
    assert.ok(hrefMatch, "gate deve ter o link de skip");
    const skipHref = hrefMatch![1];
    assert.match(skipHref, /[?&]edition=260601\b/, "#4271: skipHref deve preservar a edição pedida");

    const nextRes = await worker.fetch(
      new Request(`https://poll.test${skipHref}`, { headers: { Cookie: `${ROUNDS_PLAYED_COOKIE}=5` } }),
      env,
    );
    assert.equal(nextRes.status, 200);
    const nextHtml = await nextRes.text();
    assert.match(
      nextHtml,
      new RegExp(SINGLE_EDITION_TITLE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "#4271: skipHref deve resolver pra edição única pedida, não pra sequência genérica",
    );
    assert.doesNotMatch(nextHtml, new RegExp(SEQUENCE_TITLE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("fim-a-fim: link de edição única de verdade no gate — goToGame() (pós-verify/subscribe) também preserva a edição pedida", async () => {
    const env = makeEnv();
    const gateRes = await worker.fetch(
      new Request("https://poll.test/jogar?edition=260601", {
        headers: { Cookie: `${ROUNDS_PLAYED_COOKIE}=5` },
      }),
      env,
    );
    const gateHtml = await gateRes.text();
    const fnMatch = gateHtml.match(/function goToGame\(\) \{[\s\S]*?window\.location\.href = ([^;]+);/);
    assert.ok(fnMatch, "gate deve ter goToGame()");
    const expr = fnMatch![1].replace(/Date\.now\(\)/g, "1");
    // eslint-disable-next-line no-new-func
    const target = new Function(`return ${expr};`)() as string;
    assert.match(target, /[?&]edition=260601\b/, "#4271: alvo de goToGame() deve preservar a edição pedida");

    const sessionCookie = (await issueWebSessionCookie("cookie-secret", "leitor@example.com", "confirmed")).split(";")[0];
    const nextRes = await worker.fetch(
      new Request(`https://poll.test${target}`, {
        headers: { Cookie: `${ROUNDS_PLAYED_COOKIE}=5; ${sessionCookie}` },
      }),
      env,
    );
    assert.equal(nextRes.status, 200);
    const nextHtml = await nextRes.text();
    assert.match(
      nextHtml,
      new RegExp(SINGLE_EDITION_TITLE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "#4271: goToGame() deve resolver pra edição única pedida, não pra sequência genérica",
    );
    assert.doesNotMatch(nextHtml, new RegExp(SEQUENCE_TITLE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("regressão #4268: sequência (seq_ctx_edition=, sem edition=) continua indo pra sequência, nunca pra edição única", async () => {
    const env = makeEnv();
    const gateRes = await worker.fetch(
      new Request("https://poll.test/jogar?seq_ctx_edition=260601", {
        headers: { Cookie: `${ROUNDS_PLAYED_COOKIE}=5` },
      }),
      env,
    );
    assert.equal(gateRes.status, 200);
    assert.equal(gateRes.headers.get("X-Eia-Gate"), "1");
    const gateHtml = await gateRes.text();
    const hrefMatch = gateHtml.match(/class="skip-link" href="([^"]+)"/);
    assert.ok(hrefMatch);
    assert.ok(!/[?&]edition=/.test(hrefMatch![1]), "#4271: seq_ctx_edition nunca deve vazar como edition= de navegação");

    const nextRes = await worker.fetch(
      new Request(`https://poll.test${hrefMatch![1]}`, { headers: { Cookie: `${ROUNDS_PLAYED_COOKIE}=5` } }),
      env,
    );
    const nextHtml = await nextRes.text();
    assert.match(nextHtml, new RegExp(SEQUENCE_TITLE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(nextHtml, new RegExp(SINGLE_EDITION_TITLE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});
