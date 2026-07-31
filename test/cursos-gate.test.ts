/**
 * cursos-gate.test.ts (#4052)
 *
 * Cobre `workers/cursos/src/index.ts` fim-a-fim (fetch handler completo) +
 * `gate.ts` + `cookie.ts` + `subscribe.ts`: os dois caminhos de entrada
 * (?email= da newsletter e cookie de sessão), a tela de gate, verificação,
 * cadastro inline, e rate-limit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker, { type Env } from "../workers/cursos/src/index.ts";
import { subscriberKvKey, sha256Hex } from "../scripts/lib/shared/subscriber-verify.ts";
import { CURSOS_SESSION_COOKIE, issueSessionCookie, readSession } from "../workers/cursos/src/cookie.ts";
import { CURSOS_FULL_HTML } from "../workers/cursos/src/courses-full.generated.ts";
import { emailVerifyCooldownKey } from "../workers/cursos/src/gate.ts";

/** Decodifica o valor cru do cookie a partir do header `Set-Cookie` completo
 * (como devolvido pelo handler) — usado pelos testes do #4323 pra inspecionar
 * o estado pending/confirmed embutido no cookie assinado. */
function rawCookieValue(setCookieHeader: string): string {
  const pair = setCookieHeader.split(";")[0];
  const eq = pair.indexOf("=");
  return decodeURIComponent(pair.slice(eq + 1));
}

function makeMapKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      const v = m.get(key);
      return v === undefined ? null : v;
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
  } as unknown as KVNamespace;
}

const TEASER_HTML = "<html><body>teaser fallback</body></html>";
function makeAssets(): Fetcher {
  return {
    fetch: async () => new Response(TEASER_HTML, { headers: { "Content-Type": "text/html" } }),
  } as unknown as Fetcher;
}

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: makeAssets(),
    CURSOS_SUBSCRIBERS: makeMapKV(),
    COOKIE_HMAC_SECRET: "cookie-secret",
    ...overrides,
  };
}

function getCookieHeader(res: Response): string | null {
  return res.headers.get("Set-Cookie");
}

/** Wrapper de KV que conta quantas vezes `get` é chamado pra uma chave de
 * ASSINANTE (`subscriber:...`) — é essa a chamada que `checkGateSubscriber`
 * faz sempre no caminho barato (KV) antes de decidir se cai pro fallback ao
 * vivo da Beehiiv. Contar aqui mede diretamente "quantas vezes
 * `checkGateSubscriber` rodou", sem precisar mockar módulos inteiros.
 * Compartilhado pelos testes de cooldown do #4387 (cookie pending) e do #4390
 * (`?email=`) — os dois branches usam o MESMO mecanismo de throttle. */
function makeCountingKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  let subscriberGetCalls = 0;
  const kv = {
    async get(key: string) {
      if (key.startsWith("subscriber:")) subscriberGetCalls++;
      const v = m.get(key);
      return v === undefined ? null : v;
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
  } as unknown as KVNamespace;
  return { kv, map: m, getSubscriberGetCalls: () => subscriberGetCalls };
}

describe("workers/cursos GET / (#4052)", () => {
  it("sem ?email= e sem cookie → serve o teaser (ASSETS.fetch)", async () => {
    const env = baseEnv();
    const res = await worker.fetch(new Request("https://cursos.diar.ia.br/"), env);
    assert.equal(await res.text(), TEASER_HTML);
  });

  it("?email= de assinante ativo → serve o HTML completo E seta cookie", async () => {
    const email = "assinante@example.com";
    const key = await subscriberKvKey(email);
    const env = baseEnv({ CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }) });
    const res = await worker.fetch(
      new Request(`https://cursos.diar.ia.br/?email=${encodeURIComponent(email)}`),
      env,
    );
    assert.equal(await res.text(), CURSOS_FULL_HTML);
    assert.match(getCookieHeader(res) ?? "", /HttpOnly/);
  });

  // #4320: sem esta linha, o alarme de erro do worker (scripts/cursos-error-alarm.ts)
  // não tinha denominador pra calcular a taxa de "?email= não confirmado" — só
  // o numerador (o branch de falha logo abaixo já logava). Mesmo cuidado de
  // redação dos `console.warn` de falha: NUNCA interpolar o e-mail no log.
  it("?email= de assinante ativo → loga a confirmação (console.log), SEM vazar o e-mail (#4320)", async () => {
    const email = "assinante-log@example.com";
    const key = await subscriberKvKey(email);
    const env = baseEnv({ CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }) });

    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await worker.fetch(
        new Request(`https://cursos.diar.ia.br/?email=${encodeURIComponent(email)}`),
        env,
      );
    } finally {
      console.log = originalLog;
    }

    assert.equal(lines.length, 1, `esperava exatamente 1 console.log, obteve ${lines.length}: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /\?email= confirmado como assinante ativo/);
    assert.doesNotMatch(lines[0], new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("?email= de e-mail NÃO assinante → cai pro teaser, sem vazar o sinal negativo", async () => {
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/?email=ninguem@example.com"),
      env,
    );
    assert.equal(await res.text(), TEASER_HTML);
    assert.equal(getCookieHeader(res), null);
  });

  it("cookie de sessão válido → serve o HTML completo sem precisar de ?email=", async () => {
    const cookieValue = await issueSessionCookie("cookie-secret", "leitor@example.com");
    const cookiePair = cookieValue.split(";")[0];
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/", { headers: { Cookie: cookiePair } }),
      env,
    );
    assert.equal(await res.text(), CURSOS_FULL_HTML);
  });

  it("cookie inválido (secret errado) → cai pro teaser", async () => {
    const cookieValue = await issueSessionCookie("outro-secret", "leitor@example.com");
    const cookiePair = cookieValue.split(";")[0];
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/", { headers: { Cookie: cookiePair } }),
      env,
    );
    assert.equal(await res.text(), TEASER_HTML);
  });
});

describe("workers/cursos GET /gate (#4052)", () => {
  it("responde HTML com o form de gate", async () => {
    const env = baseEnv();
    const res = await worker.fetch(new Request("https://cursos.diar.ia.br/gate"), env);
    const body = await res.text();
    assert.match(body, /gate-form/);
    assert.equal(res.headers.get("Content-Type"), "text/html;charset=utf-8");
  });
});

describe("workers/cursos POST /gate/verify (#4052)", () => {
  it("assinante ativo → ok:true + cookie", async () => {
    const email = "ativo@example.com";
    const key = await subscriberKvKey(email);
    const env = baseEnv({ CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }) });
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }),
      env,
    );
    const data = (await res.json()) as { ok: boolean };
    assert.equal(data.ok, true);
    assert.match(getCookieHeader(res) ?? "", /HttpOnly/);
  });

  it("não-assinante → ok:false, error not_active, SEM cookie", async () => {
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "ninguem@example.com" }),
      }),
      env,
    );
    const data = (await res.json()) as { ok: boolean; error: string };
    assert.equal(data.ok, false);
    assert.equal(data.error, "not_active");
    assert.equal(getCookieHeader(res), null);
  });

  it("e-mail inválido → 400", async () => {
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "não-é-email" }),
      }),
      env,
    );
    assert.equal(res.status, 400);
  });

  it("honeypot preenchido → resposta fake-fail 200, sem revelar ao bot", async () => {
    const email = "ativo@example.com";
    const key = await subscriberKvKey(email);
    const env = baseEnv({ CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }) });
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, website: "http://spam.example.com" }),
      }),
      env,
    );
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean };
    assert.equal(data.ok, false);
  });

  it("rate-limit: 9ª tentativa do mesmo IP em 1h é bloqueada (limite 8)", async () => {
    const env = baseEnv();
    const mkReq = () =>
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "9.9.9.9" },
        body: JSON.stringify({ email: "x@example.com" }),
      });
    let last: Response | null = null;
    for (let i = 0; i < 9; i++) last = await worker.fetch(mkReq(), env);
    assert.equal(last!.status, 429);
  });

  /**
   * #4322 item 1: `checkGateRateLimit` era consumido ANTES de parsear/validar
   * o e-mail — um typo repetido 8× trancava o IP por 1h sem que nenhuma
   * tentativa tivesse alcançado `checkGateSubscriber` (aconteceu ao vivo com
   * o editor testando o #4305). O rate-limit existe contra força-bruta de
   * e-mail; requisição que nem chega a consultar assinante não é tentativa
   * de força-bruta.
   */
  it("erro de FORMATO de e-mail não consome o rate-limit (#4322 item 1)", async () => {
    const env = baseEnv();
    const ip = "7.7.7.7";
    const invalidReq = () =>
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify({ email: "isso-nao-e-um-email" }),
      });
    // 8 tentativas com e-mail sintaticamente inválido — antes do fix, cada uma
    // consumia o mesmo balde do rate-limit (limite 8/h) mesmo sem nunca
    // consultar um assinante de verdade.
    for (let i = 0; i < 8; i++) {
      const res = await worker.fetch(invalidReq(), env);
      assert.equal(res.status, 400, `tentativa ${i + 1} deveria ser 400 (formato inválido), nunca 429`);
    }
    // a 9ª tentativa, com e-mail bem formado (mas não-assinante), NÃO pode vir
    // 429 — só viria se as 8 tentativas de formato inválido tivessem contado.
    const validRes = await worker.fetch(
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify({ email: "formato-valido@example.com" }),
      }),
      env,
    );
    assert.notEqual(validRes.status, 429, "erro de formato não deveria ter consumido o rate-limit real");
    const data = (await validRes.json()) as { ok: boolean; error?: string };
    assert.equal(data.ok, false);
    assert.equal(data.error, "not_active");
  });
});

describe("workers/cursos POST /gate/subscribe (#4052)", () => {
  function subReq(body: unknown) {
    return new Request("https://cursos.diar.ia.br/gate/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("sem opt-in → 400 optin_required", async () => {
    const env = baseEnv();
    const res = await worker.fetch(subReq({ email: "x@example.com", optin: false }), env);
    assert.equal(res.status, 400);
  });

  it("Beehiiv não configurado (secrets ausentes) → 503 subscribe_unavailable", async () => {
    const env = baseEnv();
    const res = await worker.fetch(subReq({ email: "x@example.com", optin: true }), env);
    assert.equal(res.status, 503);
    const data = (await res.json()) as { error: string };
    assert.equal(data.error, "subscribe_unavailable");
  });

  it("sucesso (secrets configurados) → 200 + cookie de sessão", async () => {
    const env = baseEnv({
      BEEHIIV_API_KEY: "test-key",
      BEEHIIV_PUBLICATION_ID: "pub_test",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { id: "sub_1" } }), { status: 201 })) as typeof fetch;
    try {
      const res = await worker.fetch(subReq({ email: "novo@example.com", optin: true }), env);
      assert.equal(res.status, 200);
      assert.match(getCookieHeader(res) ?? "", /HttpOnly/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /**
   * #4323: `handleGateSubscribe` tratava qualquer 2xx do `POST /subscriptions`
   * como sucesso e emitia direto um cookie de sessão de 30 dias com acesso
   * COMPLETO — `subscribeToBeehiiv` nunca lia o `status` do corpo da
   * resposta. O mock acima (`{data:{id:"sub_1"}}`, sem `status`) é exatamente
   * o caso que travava esse comportamento no CI; os dois testes abaixo
   * verificam o estado real do cookie emitido (via `readSession`, não só a
   * presença de `HttpOnly`) nos dois ramos que passaram a existir.
   */
  it("Beehiiv responde 2xx mas SEM confirmar status:active → cookie sai PENDING, não concede acesso completo (#4323)", async () => {
    const env = baseEnv({
      BEEHIIV_API_KEY: "test-key",
      BEEHIIV_PUBLICATION_ID: "pub_test",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { id: "sub_1" } }), { status: 201 })) as typeof fetch;
    try {
      const res = await worker.fetch(subReq({ email: "pendente@example.com", optin: true }), env);
      assert.equal(res.status, 200, "cadastro em si continua ok:true — só o ESTADO da sessão muda");
      const setCookie = getCookieHeader(res) ?? "";
      assert.match(setCookie, /HttpOnly/);
      const session = await readSession("cookie-secret", `${CURSOS_SESSION_COOKIE}=${encodeURIComponent(rawCookieValue(setCookie))}`);
      assert.ok(session, "cookie precisa ser um valor válido/verificável");
      assert.equal(session!.email, "pendente@example.com");
      assert.equal(session!.pending, true, "sem status:active confirmado, a sessão não pode sair como confirmada");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Beehiiv confirma status:active na própria resposta → cookie sai CONFIRMED, sem fricção extra (#4323)", async () => {
    const env = baseEnv({
      BEEHIIV_API_KEY: "test-key",
      BEEHIIV_PUBLICATION_ID: "pub_test",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { id: "sub_1", status: "active" } }), { status: 201 })) as typeof fetch;
    try {
      const res = await worker.fetch(subReq({ email: "ativo-na-hora@example.com", optin: true }), env);
      assert.equal(res.status, 200);
      const setCookie = getCookieHeader(res) ?? "";
      assert.match(setCookie, /HttpOnly/);
      const session = await readSession("cookie-secret", `${CURSOS_SESSION_COOKIE}=${encodeURIComponent(rawCookieValue(setCookie))}`);
      assert.ok(session);
      assert.equal(session!.email, "ativo-na-hora@example.com");
      assert.equal(session!.pending, false, "status:active na resposta é o caminho comum — nunca deve ganhar fricção extra");
      // #4323 acceptance (c): confirma que a sessão CONFIRMED de fato libera
      // o conteúdo completo numa visita seguinte, sem precisar de /gate/verify.
      const cookiePair = setCookie.split(";")[0];
      const homeRes = await worker.fetch(
        new Request("https://cursos.diar.ia.br/", { headers: { Cookie: cookiePair } }),
        env,
      );
      assert.equal(await homeRes.text(), CURSOS_FULL_HTML);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sessão PENDING não libera o conteúdo completo em / até ser promovida (#4323)", async () => {
    const email = "ainda-pendente@example.com";
    const cookieValue = await issueSessionCookie("cookie-secret", email, "pending");
    const cookiePair = cookieValue.split(";")[0];
    // KV vazio (assinante ainda não sincronizado) e sem secrets Beehiiv — checkGateSubscriber
    // não tem como confirmar "active", então a promoção não acontece nesta visita.
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/", { headers: { Cookie: cookiePair } }),
      env,
    );
    assert.equal(await res.text(), TEASER_HTML, "sessão pending sem confirmação disponível deve continuar vendo o teaser");
  });

  it("sessão PENDING é promovida a CONFIRMED em / quando checkGateSubscriber já confirma active (#4323)", async () => {
    const email = "promovido@example.com";
    const key = await subscriberKvKey(email);
    const cookieValue = await issueSessionCookie("cookie-secret", email, "pending");
    const cookiePair = cookieValue.split(";")[0];
    // KV já populado (sync rodou depois do cadastro) — a próxima visita deve promover.
    const env = baseEnv({ CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }) });
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/", { headers: { Cookie: cookiePair } }),
      env,
    );
    assert.equal(await res.text(), CURSOS_FULL_HTML, "sessão pending confirmada via KV deve ser promovida a conteúdo completo");
    assert.match(getCookieHeader(res) ?? "", /HttpOnly/, "promoção deve reemitir um cookie CONFIRMED novo");
  });

  it("honeypot preenchido → 200 fake-success, nenhuma chamada à Beehiiv", async () => {
    const env = baseEnv({ BEEHIIV_API_KEY: "test-key", BEEHIIV_PUBLICATION_ID: "pub_test" });
    let called = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("não deveria ser chamado");
    }) as typeof fetch;
    try {
      const res = await worker.fetch(
        subReq({ email: "x@example.com", optin: true, website: "http://spam.example.com" }),
        env,
      );
      assert.equal(res.status, 200);
      assert.equal(called, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("workers/cursos POST /gate/logout (#4052)", () => {
  it("limpa o cookie de sessão", async () => {
    const env = baseEnv();
    const res = await worker.fetch(new Request("https://cursos.diar.ia.br/gate/logout", { method: "POST" }), env);
    assert.match(getCookieHeader(res) ?? "", /Max-Age=0/);
  });
});

/**
 * #4305 — regressões do follow-up. Os casos abaixo só passaram a importar
 * quando `run_worker_first` fez o script de fato rodar em `/`: antes disso o
 * asset era servido sem `handleIndex` existir na prática, e nada aqui podia
 * ser observado em produção.
 */

/** Captura `console.error`/`console.warn` pra afirmar que uma degradação
 * deixou rastro. Necessário porque quase todo caminho de falha aqui responde
 * 200/teaser ou um 4xx/5xx genérico — sem o log, o único jeito de saber que
 * algo quebrou seria um leitor reclamando. `error` = quebrou; `warn` = caminho
 * de degradação esperado, cuja TAXA é o sinal (1% é normal, 100% é o gate
 * quebrado). */
function captureErrorLogs() {
  const originalError = console.error;
  const originalWarn = console.warn;
  const lines: string[] = [];
  const warns: string[] = [];
  const fmt = (args: unknown[]) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
  console.error = (...args: unknown[]) => {
    lines.push(fmt(args));
  };
  console.warn = (...args: unknown[]) => {
    warns.push(fmt(args));
  };
  return {
    lines,
    warns,
    restore() {
      console.error = originalError;
      console.warn = originalWarn;
    },
  };
}

describe("workers/cursos: gate no follow-up #4305", () => {
  it("/index.html é gateado igual a / — mesmo asset, mesmo tratamento", async () => {
    const email = "assinante@example.com";
    const cookie = await issueSessionCookie("cookie-secret", email);
    const env = baseEnv();
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/index.html", {
        headers: { Cookie: cookie.split(";")[0] },
      }),
      env,
    );
    // Antes do #4305, `fetch` só casava `pathname === "/"`, então este request
    // caía no `env.ASSETS.fetch` do fim e devolvia o teaser cru mesmo com
    // cookie válido — `run_worker_first` prometia cobrir `/index.html` e o
    // roteamento não entregava.
    assert.equal(await res.text(), CURSOS_FULL_HTML);
  });

  it("/index.html?email= de assinante ativo também desbloqueia e seta cookie", async () => {
    const email = "assinante@example.com";
    const key = await subscriberKvKey(email);
    const env = baseEnv({ CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }) });
    const res = await worker.fetch(
      new Request(`https://cursos.diar.ia.br/index.html?email=${encodeURIComponent(email)}`),
      env,
    );
    assert.equal(await res.text(), CURSOS_FULL_HTML);
    assert.match(getCookieHeader(res) ?? "", /HttpOnly/);
  });

  it("KV lançando exceção degrada pro teaser, não derruba a home", async () => {
    // `run_worker_first` acoplou a home ao sucesso de `handleIndex`. Sem o
    // fail-soft, um throw do KV subiria pro `fetch` e a página inteira cairia
    // — pior que o bug original, que ao menos sempre mostrava o teaser.
    const explodingKV = {
      get: async () => {
        throw new Error("KV indisponível");
      },
      put: async () => {},
      delete: async () => {},
    } as unknown as KVNamespace;
    const env = baseEnv({ CURSOS_SUBSCRIBERS: explodingKV });
    const logs = captureErrorLogs();
    let res: Response;
    try {
      res = await worker.fetch(new Request("https://cursos.diar.ia.br/?email=alguem@example.com"), env);
    } finally {
      logs.restore();
    }
    assert.equal(res.status, 200);
    assert.equal(await res.text(), TEASER_HTML);
    // O 200 silencioso some do gráfico de erro nativo do Cloudflare, que um
    // 500 daria de graça. O log é o ÚNICO sinal que sobra — se alguém apagar
    // o `console.error`, a degradação vira invisível e nada mais avisa.
    assert.equal(logs.lines.length, 1, "a degradação precisa deixar rastro");
    assert.match(logs.lines[0], /handleIndex falhou/);
    assert.match(logs.lines[0], /url=/, "sem contexto de request não dá pra distinguir 1 request de 100%");
    // 3º passe de review (fb030eda): o `catch` é genérico — qualquer exceção
    // não tratada no handler cai aqui, inclusive com `?email=` de assinante
    // real na URL. `request.url` cru vazaria PII pro log de plataforma; o
    // param precisa vir redigido.
    assert.ok(!logs.lines[0].includes("alguem@example.com"), "e-mail não pode vazar no log de exceção genérica");
    assert.match(
      logs.lines[0],
      /email=%5Bredacted%5D/,
      "o param redigido ainda precisa aparecer (url-encoded) pra sinalizar que havia email na URL",
    );
  });

  it("?email= não-ativo loga a taxa SEM o endereço — merge tag quebrada é indistinguível sem isso", async () => {
    // A resposta continua idêntica a "não mandou email nenhum" (anti-probing
    // do #4052 preservado); o log é servidor-side e invisível pro visitante.
    // Sem ele, uma merge tag quebrada produz este caminho em 100% dos cliques
    // da newsletter e some no meio do tráfego normal.
    const env = baseEnv();
    const logs = captureErrorLogs();
    let res: Response;
    try {
      res = await worker.fetch(new Request("https://cursos.diar.ia.br/?email=ninguem@example.com"), env);
    } finally {
      logs.restore();
    }
    assert.equal(await res.text(), TEASER_HTML, "resposta não pode mudar — anti-probing");
    assert.equal(logs.warns.length, 1);
    assert.match(logs.warns[0], /não confirmado como assinante ativo/);
    assert.ok(
      !logs.warns[0].includes("ninguem@example.com"),
      "endereço de assinante não pode ir parar em log de plataforma (PII a troco de nada)",
    );
  });

  it("?email= malformado loga como provável merge tag não resolvida", async () => {
    const env = baseEnv();
    const logs = captureErrorLogs();
    try {
      await worker.fetch(new Request("https://cursos.diar.ia.br/?email=%7B%7Bemail%7D%7D"), env);
    } finally {
      logs.restore();
    }
    assert.equal(logs.warns.length, 1);
    assert.match(logs.warns[0], /malformado/);
  });

  it("falha do cadastro na Beehiiv loga — 502 mudo derrubaria todo signup sem rastro", async () => {
    const env = baseEnv({ BEEHIIV_API_KEY: "k", BEEHIIV_PUBLICATION_ID: "pub_1" });
    const { handleGateSubscribe } = await import("../workers/cursos/src/subscribe.ts");
    const logs = captureErrorLogs();
    let res: Response;
    try {
      res = await handleGateSubscribe(
        new Request("https://cursos.diar.ia.br/gate/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "novo@example.com", optin: true }),
        }),
        env,
        { fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch },
      );
    } finally {
      logs.restore();
    }
    assert.equal(res.status, 502);
    assert.ok(
      logs.lines.some((l) => /cadastro na Beehiiv falhou/.test(l)),
      "sem log, Beehiiv fora do ar mata todo cadastro do gate em silêncio",
    );
  });

  it("fetch pra Beehiiv lançando (rede caída) loga — ramo distinto de resposta HTTP não-ok", async () => {
    // 3º passe de review (fb030eda): o `catch` de `subscribeToBeehiiv` cobre o
    // `fetch` LANÇANDO (DNS/rede), não só devolvendo status não-ok — ramo
    // testado acima. Sem este teste, um `fetchImpl` que rejeita nunca exercita
    // o `console.error("[cursos] fetch pra Beehiiv lançou:", err)`.
    const env = baseEnv({ BEEHIIV_API_KEY: "k", BEEHIIV_PUBLICATION_ID: "pub_1" });
    const { handleGateSubscribe } = await import("../workers/cursos/src/subscribe.ts");
    const logs = captureErrorLogs();
    let res: Response;
    try {
      res = await handleGateSubscribe(
        new Request("https://cursos.diar.ia.br/gate/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "novo@example.com", optin: true }),
        }),
        env,
        {
          fetchImpl: (async () => {
            throw new Error("network down");
          }) as unknown as typeof fetch,
        },
      );
    } finally {
      logs.restore();
    }
    assert.equal(res.status, 502);
    assert.ok(
      logs.lines.some((l) => /fetch pra Beehiiv lançou/.test(l)),
      "exceção de rede no fetch da Beehiiv precisa deixar rastro distinto de resposta não-ok",
    );
  });

  it("sem COOKIE_HMAC_SECRET, / loga — é o ramo que NÃO passa pelo catch", async () => {
    // Desvio de fluxo, não exceção: sem log próprio, um deploy sem o secret
    // serviria teaser pra assinante ativo vindo da newsletter com zero sinal
    // em qualquer camada — nem status HTTP, nem log.
    const env = baseEnv({ COOKIE_HMAC_SECRET: undefined as unknown as string });
    const logs = captureErrorLogs();
    try {
      await worker.fetch(new Request("https://cursos.diar.ia.br/?email=alguem@example.com"), env);
    } finally {
      logs.restore();
    }
    assert.equal(logs.lines.length, 1);
    assert.match(logs.lines[0], /COOKIE_HMAC_SECRET ausente/);
  });

  it("sem COOKIE_HMAC_SECRET, / serve o teaser (degradação explícita, não exceção)", async () => {
    // A primeira versão deste guard foi escrita com a justificativa errada
    // ("cookie assinado com chave vazia, forjável"). Não é o que acontece:
    // `TextEncoder().encode(undefined)` de fato não lança, mas o
    // `crypto.subtle.importKey` seguinte rejeita chave de tamanho zero com
    // `DataError` (spec da WebCrypto — verificado em Node). Sem o guard isto
    // QUEBRA, não vaza. O guard existe pra trocar a exceção por degradação
    // explícita e logada, não pra fechar um bypass.
    const email = "assinante@example.com";
    const key = await subscriberKvKey(email);
    const env = baseEnv({
      CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }),
      COOKIE_HMAC_SECRET: undefined as unknown as string,
    });
    const res = await worker.fetch(
      new Request(`https://cursos.diar.ia.br/?email=${encodeURIComponent(email)}`),
      env,
    );
    assert.equal(await res.text(), TEASER_HTML);
    assert.equal(getCookieHeader(res), null);
  });

  it("sem COOKIE_HMAC_SECRET, /gate/verify responde 503 em vez de estourar exceção", async () => {
    const email = "assinante@example.com";
    const key = await subscriberKvKey(email);
    const env = baseEnv({
      CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }),
      COOKIE_HMAC_SECRET: undefined as unknown as string,
    });
    const res = await worker.fetch(
      new Request("https://cursos.diar.ia.br/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }),
      env,
    );
    assert.equal(res.status, 503);
    assert.equal(getCookieHeader(res), null);
  });

  it("sem COOKIE_HMAC_SECRET, /gate/subscribe recusa ANTES de criar assinante na Beehiiv", async () => {
    // Ordem importa: cadastrar e só depois falhar deixaria a pessoa dentro da
    // Beehiiv e fora da página, sem nada a fazer.
    let beehiivChamada = false;
    const env = baseEnv({
      COOKIE_HMAC_SECRET: undefined as unknown as string,
      BEEHIIV_API_KEY: "k",
      BEEHIIV_PUBLICATION_ID: "pub_1",
    });
    const { handleGateSubscribe } = await import("../workers/cursos/src/subscribe.ts");
    const res = await handleGateSubscribe(
      new Request("https://cursos.diar.ia.br/gate/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "novo@example.com", optin: true }),
      }),
      env,
      {
        fetchImpl: (async () => {
          beehiivChamada = true;
          return new Response(JSON.stringify({ data: { id: "sub_1" } }), { status: 201 });
        }) as unknown as typeof fetch,
      },
    );
    assert.equal(res.status, 503);
    assert.equal(beehiivChamada, false, "não pode chamar a Beehiiv se o cadastro não vai poder entrar");
  });
});

/**
 * #4321 — `checkGateSubscriber` deixa de colapsar "verificado negativo" e
 * "não conseguimos verificar" no mesmo `not_active`. Critério de aceite
 * central: a resposta HTTP ao visitante É IDÊNTICA nos dois casos (anti-
 * probing do #4052 intacto) — só o log distingue. Os 2 call sites afetados:
 * `handleIndex` (caminho `?email=` da newsletter) e `/gate/verify`.
 */
describe("workers/cursos: checkGateSubscriber distingue verification_failed (#4321)", () => {
  /** KV sempre vazio (chave ausente) — força `checkGateSubscriber` a cair no
   * caminho secundário (Beehiiv `by_email`), que é o único que produz
   * `verification_failed`. */
  function beehiivEnv(): Env {
    return baseEnv({ BEEHIIV_API_KEY: "test-key", BEEHIIV_PUBLICATION_ID: "pub_test" });
  }

  const FAILURE_STATUSES = [401, 429, 503] as const;

  for (const status of FAILURE_STATUSES) {
    it(`/gate/verify: Beehiiv responde ${status} → resposta not_active IDÊNTICA ao negativo confirmado, mas loga diferente`, async () => {
      const env = beehiivEnv();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response("err", { status })) as typeof fetch;
      const logs = captureErrorLogs();
      let res: Response;
      try {
        res = await worker.fetch(
          new Request("https://cursos.diar.ia.br/gate/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "talvez-assinante@example.com" }),
          }),
          env,
        );
      } finally {
        globalThis.fetch = originalFetch;
        logs.restore();
      }
      const data = (await res.json()) as { ok: boolean; error: string };
      // Resposta ao visitante: byte-idêntica ao caso "confirmed_negative"
      // (ver teste "não-assinante → ok:false, error not_active" acima) — o
      // status HTTP e o corpo NÃO podem entregar que houve uma falha de
      // verificação em vez de um negativo real.
      assert.equal(res.status, 200);
      assert.equal(data.ok, false);
      assert.equal(data.error, "not_active");
      assert.equal(getCookieHeader(res), null);
      // Log distingue: precisa mencionar a falha de verificação, não o texto
      // genérico de "não confirmado como assinante ativo".
      assert.ok(
        logs.lines.some((l) => /verificação Beehiiv falhou/.test(l)),
        `esperava log de verification_failed pro status ${status}`,
      );
    });
  }

  it("/gate/verify: Beehiiv responde 404 (negativo confirmado) → não loga como verification_failed", async () => {
    const env = beehiivEnv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    const logs = captureErrorLogs();
    let res: Response;
    try {
      res = await worker.fetch(
        new Request("https://cursos.diar.ia.br/gate/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "ninguem@example.com" }),
        }),
        env,
      );
    } finally {
      globalThis.fetch = originalFetch;
      logs.restore();
    }
    const data = (await res.json()) as { ok: boolean; error: string };
    assert.equal(data.ok, false);
    assert.equal(data.error, "not_active");
    assert.ok(
      !logs.lines.some((l) => /verificação Beehiiv falhou/.test(l)),
      "404 é negativo confirmado — não deve logar como falha de verificação",
    );
  });

  it("handleIndex (?email=): Beehiiv responde 500 → cai pro teaser IDÊNTICO ao negativo confirmado, loga diferente (error, não warn)", async () => {
    const env = beehiivEnv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("err", { status: 500 })) as typeof fetch;
    const logs = captureErrorLogs();
    let res: Response;
    try {
      res = await worker.fetch(
        new Request("https://cursos.diar.ia.br/?email=talvez-assinante@example.com"),
        env,
      );
    } finally {
      globalThis.fetch = originalFetch;
      logs.restore();
    }
    // Resposta idêntica ao caso "?email= de e-mail NÃO assinante" acima —
    // teaser, sem cookie, sem qualquer sinal do tipo de falha.
    assert.equal(await res.text(), TEASER_HTML);
    assert.equal(getCookieHeader(res), null);
    assert.ok(
      logs.lines.some((l) => /verificação Beehiiv falhou/.test(l)),
      "esperava log error de verification_failed",
    );
    assert.equal(logs.warns.length, 0, "não deve emitir o warn genérico de negativo confirmado neste ramo");
  });
});

/**
 * #4387 — regressão: a promoção `pending`→`confirmed` em `handleIndex` (#4323,
 * PR #4384) chamava `checkGateSubscriber` em TODO reload de `/`, sem
 * rate-limit nenhum. `checkGateSubscriber` cai pra uma chamada AO VIVO da
 * Beehiiv quando o KV do sync diário (09:15) ainda não tem a chave — um
 * assinante pending podia ficar até ~24h nessa janela disparando uma chamada
 * Beehiiv por reload. Os testes abaixo simulam exatamente esse cenário: uma
 * sessão pending batendo em `/` repetidamente dentro da janela de cooldown.
 */
describe("workers/cursos: cooldown da promoção pending→confirmed (#4387)", () => {
  it("sessão pending recarregando / repetidamente dentro do cooldown: checkGateSubscriber roda no máximo 1x", async () => {
    const email = "pending-reload@example.com";
    const cookieValue = await issueSessionCookie("cookie-secret", email, "pending");
    const cookiePair = cookieValue.split(";")[0];
    const { kv, getSubscriberGetCalls } = makeCountingKV();
    const env = baseEnv({ CURSOS_SUBSCRIBERS: kv });
    const req = () => new Request("https://cursos.diar.ia.br/", { headers: { Cookie: cookiePair } });

    // 5 reloads seguidos, ainda dentro da mesma janela de cooldown — antes do
    // fix, cada um disparava um `checkGateSubscriber` novo (e, sem KV
    // sincronizado, uma chamada Beehiiv ao vivo por reload).
    const responses: Response[] = [];
    for (let i = 0; i < 5; i++) responses.push(await worker.fetch(req(), env));

    for (const res of responses) {
      assert.equal(await res.text(), TEASER_HTML, "sem confirmação disponível, cada reload continua vendo o teaser");
    }
    assert.equal(
      getSubscriberGetCalls(),
      1,
      `checkGateSubscriber deveria ter rodado 1x só, rodou ${getSubscriberGetCalls()}x`,
    );
  });

  it("assinante sincroniza no KV DENTRO da janela de cooldown: promoção só acontece depois que o cooldown expira", async () => {
    const email = "promovido-apos-cooldown@example.com";
    const cookieValue = await issueSessionCookie("cookie-secret", email, "pending");
    const cookiePair = cookieValue.split(";")[0];
    const { kv, map, getSubscriberGetCalls } = makeCountingKV();
    const env = baseEnv({ CURSOS_SUBSCRIBERS: kv });
    const req = () => new Request("https://cursos.diar.ia.br/", { headers: { Cookie: cookiePair } });

    // 1ª visita: KV ainda não sincronizou — cai pro teaser, mas já consome o
    // cooldown (marca a sessão como "acabou de rechecar").
    const first = await worker.fetch(req(), env);
    assert.equal(await first.text(), TEASER_HTML);
    assert.equal(getSubscriberGetCalls(), 1);

    // Sync diário roda "no meio da janela" (simulado): o assinante agora está
    // ativo no KV.
    const subKey = await subscriberKvKey(email);
    map.set(subKey, "1");

    // 2ª visita, ainda dentro do cooldown: NÃO deve promover — é exatamente
    // essa a janela que o bug original deixava aberta (recheck em todo
    // reload). O fix explicitamente aceita ficar até 1 cooldown atrasado pra
    // não gastar uma chamada por reload.
    const second = await worker.fetch(req(), env);
    assert.equal(
      await second.text(),
      TEASER_HTML,
      "dentro do cooldown, a promoção não deve acontecer mesmo com o assinante já ativo no KV",
    );
    assert.equal(getSubscriberGetCalls(), 1, "checkGateSubscriber não deveria ter rodado de novo dentro do cooldown");

    // Cooldown expira (simulado apagando a chave — equivalente a esperar o
    // TTL): a PRÓXIMA visita finalmente recheca e promove.
    const emailHash = await sha256Hex(email);
    map.delete(emailVerifyCooldownKey(emailHash));

    const third = await worker.fetch(req(), env);
    assert.equal(await third.text(), CURSOS_FULL_HTML, "após o cooldown expirar, a promoção deve acontecer");
    assert.match(getCookieHeader(third) ?? "", /HttpOnly/, "promoção deve reemitir cookie CONFIRMED");
    assert.equal(getSubscriberGetCalls(), 2, "checkGateSubscriber deveria ter rodado de novo só após o cooldown expirar");
  });

  it("sessão CONFIRMED nunca aciona o cooldown/checkGateSubscriber — só sessão pending passa por essa checagem", async () => {
    const email = "ja-confirmado@example.com";
    const cookieValue = await issueSessionCookie("cookie-secret", email); // state default = "confirmed"
    const cookiePair = cookieValue.split(";")[0];
    const { kv, map, getSubscriberGetCalls } = makeCountingKV();
    const env = baseEnv({ CURSOS_SUBSCRIBERS: kv });
    const req = () => new Request("https://cursos.diar.ia.br/", { headers: { Cookie: cookiePair } });

    for (let i = 0; i < 3; i++) {
      const res = await worker.fetch(req(), env);
      assert.equal(await res.text(), CURSOS_FULL_HTML, "sessão confirmed sempre serve o conteúdo completo direto");
    }

    assert.equal(getSubscriberGetCalls(), 0, "sessão confirmed nunca deveria chamar checkGateSubscriber");
    const emailHash = await sha256Hex(email);
    assert.equal(
      map.has(emailVerifyCooldownKey(emailHash)),
      false,
      "sessão confirmed nunca deveria tocar a chave de cooldown — o rate-limit é exclusivo do caminho pending",
    );
  });
});

/**
 * #4390 — mesmo gap de rate-limit do #4387, no OUTRO branch de `handleIndex`:
 * link de newsletter salvo/repassado com `?email=` re-dispara
 * `checkGateSubscriber` (fallback ao vivo da Beehiiv incluso) a cada reload,
 * sem nenhum throttle — o `?email=` é pré-existente desde #4305/#4321 e ficou
 * FORA de escopo do #4387 (que cobriu só o cookie `pending`). Os testes abaixo
 * espelham o padrão do #4387 pro branch `?email=`, e confirmam que a chave de
 * cooldown é COMPARTILHADA entre os dois branches (mesmo e-mail → mesmo
 * balde), como o próprio #4390 sugeriu.
 */
describe("workers/cursos: cooldown do branch ?email= (#4390)", () => {
  it("?email= recarregando / repetidamente dentro do cooldown: checkGateSubscriber roda no máximo 1x", async () => {
    const email = "email-param-reload@example.com";
    const { kv, getSubscriberGetCalls } = makeCountingKV();
    const env = baseEnv({ CURSOS_SUBSCRIBERS: kv });
    const req = () =>
      new Request(`https://cursos.diar.ia.br/?email=${encodeURIComponent(email)}`);

    // 5 reloads seguidos do MESMO link com ?email= (ex: aba salva/bookmark) —
    // antes do fix, cada um disparava um checkGateSubscriber novo (e, sem KV
    // sincronizado, uma chamada Beehiiv ao vivo por reload).
    const responses: Response[] = [];
    for (let i = 0; i < 5; i++) responses.push(await worker.fetch(req(), env));

    for (const res of responses) {
      assert.equal(await res.text(), TEASER_HTML, "sem confirmação disponível (KV vazio), cada reload continua vendo o teaser");
    }
    assert.equal(
      getSubscriberGetCalls(),
      1,
      `checkGateSubscriber deveria ter rodado 1x só, rodou ${getSubscriberGetCalls()}x`,
    );
  });

  it("assinante sincroniza no KV DENTRO da janela de cooldown: ?email= só reflete a confirmação depois que o cooldown expira", async () => {
    const email = "email-param-promovido@example.com";
    const { kv, map, getSubscriberGetCalls } = makeCountingKV();
    const env = baseEnv({ CURSOS_SUBSCRIBERS: kv });
    const req = () =>
      new Request(`https://cursos.diar.ia.br/?email=${encodeURIComponent(email)}`);

    // 1ª visita: KV ainda não sincronizou — cai pro teaser, mas já consome o
    // cooldown.
    const first = await worker.fetch(req(), env);
    assert.equal(await first.text(), TEASER_HTML);
    assert.equal(getSubscriberGetCalls(), 1);

    // Sync diário roda "no meio da janela" (simulado): o assinante agora está
    // ativo no KV.
    const subKey = await subscriberKvKey(email);
    map.set(subKey, "1");

    // 2ª visita, ainda dentro do cooldown: NÃO deve chamar checkGateSubscriber
    // de novo, mesmo com o assinante já ativo no KV — é exatamente a janela
    // que o bug original deixava aberta.
    const second = await worker.fetch(req(), env);
    assert.equal(
      await second.text(),
      TEASER_HTML,
      "dentro do cooldown, o branch ?email= não deve rechecar mesmo com o assinante já ativo no KV",
    );
    assert.equal(getCookieHeader(second), null);
    assert.equal(getSubscriberGetCalls(), 1, "checkGateSubscriber não deveria ter rodado de novo dentro do cooldown");

    // Cooldown expira (simulado apagando a chave — equivalente a esperar o
    // TTL): a PRÓXIMA visita finalmente recheca e desbloqueia.
    const emailHash = await sha256Hex(email);
    map.delete(emailVerifyCooldownKey(emailHash));

    const third = await worker.fetch(req(), env);
    assert.equal(await third.text(), CURSOS_FULL_HTML, "após o cooldown expirar, o branch ?email= deve desbloquear");
    assert.match(getCookieHeader(third) ?? "", /HttpOnly/, "desbloqueio deve emitir cookie de sessão");
    assert.equal(getSubscriberGetCalls(), 2, "checkGateSubscriber deveria ter rodado de novo só após o cooldown expirar");
  });

  it("cooldown é COMPARTILHADO entre o branch ?email= e o branch de cookie pending para o MESMO e-mail (#4390)", async () => {
    const email = "compartilhado@example.com";
    const { kv, getSubscriberGetCalls } = makeCountingKV();
    const env = baseEnv({ CURSOS_SUBSCRIBERS: kv });

    // 1ª visita via ?email= consome o cooldown do e-mail.
    const emailReq = new Request(`https://cursos.diar.ia.br/?email=${encodeURIComponent(email)}`);
    const first = await worker.fetch(emailReq, env);
    assert.equal(await first.text(), TEASER_HTML);
    assert.equal(getSubscriberGetCalls(), 1);

    // 2ª visita, MESMO e-mail, mas agora via cookie de sessão pending — deve
    // respeitar o MESMO cooldown (não gastar uma 2ª chamada Beehiiv só por
    // ter trocado de caminho de entrada).
    const cookieValue = await issueSessionCookie("cookie-secret", email, "pending");
    const cookiePair = cookieValue.split(";")[0];
    const pendingReq = new Request("https://cursos.diar.ia.br/", { headers: { Cookie: cookiePair } });
    const second = await worker.fetch(pendingReq, env);
    assert.equal(await second.text(), TEASER_HTML);
    assert.equal(
      getSubscriberGetCalls(),
      1,
      "o cooldown do branch ?email= deveria bloquear o recheck do branch pending pro mesmo e-mail",
    );
  });

  it("?email= de assinante ativo continua desbloqueando na 1ª visita (sem regressão de comportamento)", async () => {
    const email = "email-param-ok@example.com";
    const key = await subscriberKvKey(email);
    const env = baseEnv({ CURSOS_SUBSCRIBERS: makeMapKV({ [key]: "1" }) });
    const res = await worker.fetch(
      new Request(`https://cursos.diar.ia.br/?email=${encodeURIComponent(email)}`),
      env,
    );
    assert.equal(await res.text(), CURSOS_FULL_HTML);
    assert.match(getCookieHeader(res) ?? "", /HttpOnly/);
  });
});
