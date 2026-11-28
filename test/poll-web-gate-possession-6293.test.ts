/**
 * test/poll-web-gate-possession-6293.test.ts (#6293)
 *
 * `handleJogarGateVerify` (web-gate.ts) promovia a sessão `confirmed` — o
 * marcador que `handleVote` (vote.ts) usa pra SOBREPOR a identidade do voto —
 * pra qualquer e-mail que `checkWebSubscriber` visse como "active". Isso
 * deixou de provar posse do e-mail desde o #5095: `subscribeToBeehiiv` manda
 * `double_opt_override: "off"`, então "existe e está active" só significa
 * "alguém digitou este e-mail e marcou a caixinha de opt-in" — nunca "esta
 * pessoa é dona dele". Composto com `POST /jogar/gate/subscribe` (que cria a
 * subscription), duas chamadas públicas ao gate bastavam pra herdar a
 * identidade de voto de qualquer e-mail alheio — exatamente a vulnerabilidade
 * que o #4121 achou que tinha fechado. Confirmado ao vivo em produção contra
 * `eia.diar.ia.br` em 26/08/2026.
 *
 * ## O desenho (decisão do editor, #6293)
 *
 * "Existe e está active" continua liberando o JOGO (pending já libera —
 * `handleJogarPage`), mas só passa a sobrepor identidade quando o e-mail já
 * PROVOU posse — via magic link (#3996): `handleConfirmMerge` (magic-link.ts)
 * é o único ponto do worker que sabe que uma pessoa de fato clicou num link
 * enviado àquele endereço. Até o #14138 a prova era um marcador POR E-MAIL,
 * o que deixava qualquer navegador que digitasse um e-mail já provado
 * receber `confirmed`; desde o #14138 ela é amarrada ao DISPOSITIVO
 * (`markDevicePossessionProven`/`hasDevicePossessionProof`, cookie de nonce
 * do navegador que pediu o link) — ver test/poll-web-gate-device-possession-14138.test.ts.
 *
 * `handleJogarGateVerify` passa a consultar esse marcador: com ele, emite
 * `confirmed`; sem ele, `pending` (nunca mais o default implícito da função).
 *
 * ## O que este arquivo cobre
 *   1. Invariante ESTRUTURAL: nenhuma porta fora de `web-gate.ts` chama
 *      `issueWebSessionCookie`, e dentro de `web-gate.ts` o único call site
 *      que pode resolver pra `"confirmed"` está condicionado a
 *      `hasDevicePossessionProof` (ou é a porta do clique no link,
 *      `issueConfirmedSessionAfterMagicLink`, #14138) — pega uma 4ª porta futura que emita
 *      `confirmed` sem essa checagem, seja em `web-gate.ts` ou em qualquer
 *      arquivo novo.
 *   2. Comportamento: verify com e-mail ativo e SEM marcador → `pending`
 *      (o bug corrigido); verify com marcador → `confirmed`, e o override de
 *      identidade em `vote.ts` volta a funcionar só nesse caso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTrackedKv, makeTrackedKvNamespace } from "./_helpers/make-tracked-kv.ts";

// mesmo fix de #5095/beehiiv-double-opt-override — `new URL("..", import.meta.url).pathname`
// dobra a drive letter no Windows.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_GATE_PATH = join(REPO_ROOT, "workers/poll/src/web-gate.ts");

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".wrangler") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("#6293: invariante estrutural — só web-gate.ts emite sessão, e só com posse provada vira confirmed", () => {
  it("nenhum arquivo de workers/poll/src FORA de web-gate.ts chama issueWebSessionCookie", () => {
    const files = walk(join(REPO_ROOT, "workers/poll/src"));
    const offenders: string[] = [];
    for (const file of files) {
      if (file === WEB_GATE_PATH) continue;
      const src = readFileSync(file, "utf8");
      if (/issueWebSessionCookie\s*\(/.test(src)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], "uma 4ª porta emitindo o cookie de sessão fora de web-gate.ts precisa passar por ESTE guard antes de existir");
  });

  it("todo call site de issueWebSessionCookie que pode virar 'confirmed' está condicionado à prova de posse", () => {
    // #6293 (review): `issueWebSessionCookie` NÃO tem mais default pro 3º
    // argumento — um call site que o omitisse hoje é ERRO DE COMPILAÇÃO
    // (`npx tsc`), não algo que este teste em runtime precise checar. O que
    // sobra pra checar aqui, e que o compilador não garante, é semântico:
    // QUAL valor o 3º argumento resolve, não SE ele foi passado.
    //
    // HONESTIDADE SOBRE O QUE ESTA REGEX GARANTE (review, achado de
    // comment-analyzer): isto é casamento de padrão sobre NOMES DE VARIÁVEL
    // (`possessionProven`), não uma prova
    // semântica de que o valor realmente veio do KV. Renomear a variável
    // (refactor correto) QUEBRA este teste — falso positivo. Um
    // `const possessionProven = true;` hardcoded PASSA este teste — falso
    // negativo. É defesa em profundidade sobre o teste comportamental
    // fim-a-fim abaixo (que exercita o caminho real), não substituto dele —
    // exatamente o tipo de comentário que promete mais do que entrega que a
    // #6293 existe pra corrigir; não empreste a este guard mais confiança
    // do que ele tem.
    const src = readFileSync(WEB_GATE_PATH, "utf8");
    // #14138: a porta do clique no link mágico (`issueConfirmedSessionAfterMagicLink`)
    // é o ÚNICO call site com `"confirmed"` literal permitido — o clique em
    // si é a prova. Ela é tirada da varredura aqui e travada à parte abaixo
    // (só `handleConfirmMerge` a chama, depois de consumir o token).
    const magicLinkDoor = /export function issueConfirmedSessionAfterMagicLink\([^)]*\)[^{]*\{\s*return issueWebSessionCookie\(secret, email, "confirmed"\);\s*\}/;
    assert.match(src, magicLinkDoor, "porta do magic link mudou de forma — revisar este guard");
    const scanned = src.replace(magicLinkDoor, "");
    const callSites = [...scanned.matchAll(/issueWebSessionCookie\([^;]*?\);/gs)];
    assert.ok(callSites.length >= 3, "esperado >=3 call sites conhecidos (verify, subscribe sem optin, subscribe com optin)");

    for (const match of callSites) {
      const call = match[0];
      const resolvesToConfirmedLiteral = /"confirmed"/.test(call);
      const resolvesViaTernary = /possessionProven/.test(call);
      if (resolvesToConfirmedLiteral || resolvesViaTernary) {
        assert.match(
          call,
          /possessionProven/,
          `call site que pode resolver pra "confirmed" sem checar a prova de posse: ${call}`,
        );
      }
    }
  });

  it("hasDevicePossessionProof é de fato chamado antes de qualquer call site condicionado a ele", () => {
    const src = readFileSync(WEB_GATE_PATH, "utf8");
    assert.match(src, /await hasDevicePossessionProof\(/, "o guard estrutural acima só vale se o valor for realmente consultado, não só citado em comentário");
  });

  it("#14138: issueConfirmedSessionAfterMagicLink só é chamada por handleConfirmMerge, depois de consumir o token", () => {
    const files = walk(join(REPO_ROOT, "workers/poll/src"));
    const callers = files.filter((f) => f !== WEB_GATE_PATH && /issueConfirmedSessionAfterMagicLink\s*\(/.test(readFileSync(f, "utf8")));
    assert.deepEqual(callers.map((f) => f.slice(REPO_ROOT.length + 1)), ["workers/poll/src/magic-link.ts"]);
    const ml = readFileSync(join(REPO_ROOT, "workers/poll/src/magic-link.ts"), "utf8");
    const consumeAt = ml.indexOf("await consumePendingMerge(bEnv, token)");
    const issueAt = ml.indexOf("await issueConfirmedSessionAfterMagicLink(");
    assert.ok(consumeAt > 0 && issueAt > consumeAt, "a sessão confirmed do clique só pode sair depois do token one-time-use consumido");
  });
});

describe("#6293: handleJogarGateVerify — comportamento fim-a-fim", () => {
  it("e-mail ATIVO (Beehiiv/KV) sem marcador de posse → cookie PENDING, override de vote.ts NÃO dispara", async () => {
    const worker = (await import("../workers/poll/src/index.ts")).default;
    const { subscriberKvKey } = await import("../scripts/lib/shared/subscriber-verify.ts");
    const { readWebSession, WEB_SESSION_COOKIE } = await import("../workers/poll/src/web-gate.ts");

    const email = "so-existe@example.com";
    const key = await subscriberKvKey(email);
    const env = {
      POLL: makeTrackedKv(),
      POLL_SECRET: "poll-secret",
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
      COOKIE_HMAC_SECRET: "cookie-secret",
      SUBSCRIBERS_KV: makeTrackedKvNamespace({ [key]: "1" }),
    };

    const res = await worker.fetch(
      new Request("https://poll.test/jogar/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }),
      env as never,
    );
    assert.equal(res.status, 200);
    const setCookie = res.headers.get("Set-Cookie")!;
    const raw = setCookie.split(";")[0].split("=")[1];
    const session = await readWebSession("cookie-secret", `${WEB_SESSION_COOKIE}=${raw}`);
    assert.deepEqual(session, { email, pending: true }, "'active' sozinho não é mais prova de posse (#5095 anulou essa garantia)");
  });

  it("navegador com prova de posse (nonce do magic link já clicado) → cookie CONFIRMED", async () => {
    const worker = (await import("../workers/poll/src/index.ts")).default;
    const idx = await import("../workers/poll/src/index.ts");
    const { subscriberKvKey } = await import("../scripts/lib/shared/subscriber-verify.ts");
    const { readWebSession, WEB_SESSION_COOKIE } = await import("../workers/poll/src/web-gate.ts");
    const { markDevicePossessionProven, POSSESSION_NONCE_COOKIE } = await import("../workers/poll/src/magic-link.ts");
    const nonce = "9b2f7c1e-4d3a-4f5b-8c6d-1a2b3c4d5e6f";

    const email = "provou-posse@example.com";
    const key = await subscriberKvKey(email);
    const pollKv = makeTrackedKv({ [key]: "1" });
    const env = {
      POLL: pollKv,
      POLL_SECRET: "poll-secret",
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
      COOKIE_HMAC_SECRET: "cookie-secret",
      SUBSCRIBERS_KV: makeTrackedKvNamespace({ [key]: "1" }),
    };
    // #14138: a prova é do nonce do navegador, gravada sob o prefixo `web:`
    // (é o `bEnv` de `/confirm-merge?brand=web` que a grava).
    await markDevicePossessionProven(idx.brandedNamespace(pollKv as unknown as KVNamespace, "web:"), nonce, email);

    const res = await worker.fetch(
      new Request("https://poll.test/jogar/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `${POSSESSION_NONCE_COOKIE}=${nonce}` },
        body: JSON.stringify({ email }),
      }),
      env as never,
    );
    assert.equal(res.status, 200);
    const setCookie = res.headers.get("Set-Cookie")!;
    const raw = setCookie.split(";")[0].split("=")[1];
    const session = await readWebSession("cookie-secret", `${WEB_SESSION_COOKIE}=${raw}`);
    assert.deepEqual(session, { email, pending: false }, "com posse provada, o gate volta a emitir confirmed");
  });

  it("cookie CONFIRMED só emitido pós-posse-provada sobrepõe identidade em GET /vote (brand=web)", async () => {
    const worker = (await import("../workers/poll/src/index.ts")).default;
    const { subscriberKvKey } = await import("../scripts/lib/shared/subscriber-verify.ts");
    const idx = await import("../workers/poll/src/index.ts");
    const { markDevicePossessionProven, POSSESSION_NONCE_COOKIE } = await import("../workers/poll/src/magic-link.ts");
    const nonce = "9b2f7c1e-4d3a-4f5b-8c6d-1a2b3c4d5e6f";

    const email = "dono-real@example.com";
    const key = await subscriberKvKey(email);
    const pollKv = makeTrackedKv();
    const env = {
      POLL: pollKv,
      POLL_SECRET: "poll-secret",
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
      COOKIE_HMAC_SECRET: "cookie-secret",
      SUBSCRIBERS_KV: makeTrackedKvNamespace({ [key]: "1" }),
    };
    await markDevicePossessionProven(idx.brandedNamespace(pollKv as unknown as KVNamespace, "web:"), nonce, email);

    const verifyRes = await worker.fetch(
      new Request("https://poll.test/jogar/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `${POSSESSION_NONCE_COOKIE}=${nonce}` },
        body: JSON.stringify({ email }),
      }),
      env as never,
    );
    const setCookie = verifyRes.headers.get("Set-Cookie")!.split(";")[0];

    const anonEmail = "3fa85f64-5717-4562-b3fc-2c963f66afa6@web.eia.diaria.local";
    const voteRes = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(anonEmail)}&edition=260701&choice=A&brand=web`, {
        headers: { Cookie: setCookie },
      }),
      env as never,
    );
    assert.equal(voteRes.status, 200);
    assert.ok(pollKv._map.has(`web:vote:260701:${email}`), "voto deve gravar sob o e-mail da sessão confirmed (posse provada)");
    assert.ok(!pollKv._map.has(`web:vote:260701:${anonEmail}`), "não deve mais gravar sob o token anônimo — a sessão confirmed sobrepõe");
  });
});
