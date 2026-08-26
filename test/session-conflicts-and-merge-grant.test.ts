/**
 * test/session-conflicts-and-merge-grant.test.ts (#6168 Partes C/F + #6296)
 *
 * Três mecanismos que nasceram juntos porque um depende do outro:
 *
 *   - **`conflicts` (Parte C)** — CONSULTA "quem mais está mexendo nisto?".
 *     Nunca adquire nada, nunca cria arquivo (critério de aceite explícito da
 *     issue: nada além de `.merge-lock.json` aparece em `data/sessions/`).
 *   - **Ordenação de merge (Parte F)** — as duas pontas calculam o MESMO
 *     vencedor sozinhas, sem barganha e sem round-trip. E silêncio nunca é
 *     cessão.
 *   - **Concessão de janela (#6296)** — o que faltava pra conversa da Parte F
 *     ter efeito: medido ao vivo em 260826, o protocolo inteiro rodou, o peer
 *     concedeu a janela, o merge lock foi adquirido, e o `gh pr merge` foi
 *     bloqueado assim mesmo porque o guard do #5716 só olhava `session_id`
 *     contra o registro.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLOCK_SKEW_TOLERANCE_MS,
  MERGE_GRANT_TTL_MS,
  MERGE_LOCK_TTL_MS,
  beaconPathsOverlap,
  collapseTouchedPaths,
  consumeMergeGrant,
  decideMergeOrder,
  findLiveMergeGrant,
  findSessionConflicts,
  grantMergeWindow,
  machineTag,
  isMergeGrantLive,
  listActiveSessions,
  normalizeBeaconPath,
  registerSession,
  resolveMergeAdmission,
  type MergeAnnouncement,
  type SessionRecord,
} from "../scripts/lib/session-registry.ts";
import {
  CLOCK_SKEW_TOLERANCE_MS as HOOK_CLOCK_SKEW_TOLERANCE_MS,
  MERGE_GRANT_TTL_MS as HOOK_MERGE_GRANT_TTL_MS,
  MERGE_LOCK_TTL_MS as HOOK_MERGE_LOCK_TTL_MS,
  shouldBlockGhPrMerge,
} from "../.claude/hooks/block-gh-pr-merge-subagent.mjs";
import {
  findLiveMergeGrantFile,
  buildConsumedRecord,
} from "../.claude/hooks/consume-merge-grant-on-merge.mjs";

const CONSUME_HOOK_PATH = fileURLToPath(
  new URL("../.claude/hooks/consume-merge-grant-on-merge.mjs", import.meta.url),
);

/**
 * Tag da maquina REAL, nao um literal.
 *
 * `grantMergeWindow`/`findLiveMergeGrant`/`consumeMergeGrant` resolvem o path
 * do registro por `meta.tag ?? machineTag()`. Um teste que registra com um tag
 * HARDCODED e depois chama essas funcoes sem passar tag so passa numa maquina
 * cujo hostname seja exatamente esse literal — foi o que aconteceu: verde no
 * Windows do editor (hostname `Neo`), vermelho no runner do CI (#6303).
 */
const LOCAL_TAG = machineTag();

const NOW = Date.parse("2026-08-26T12:00:00.000Z");
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

function makeTempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "conflicts-"));
  mkdirSync(join(root, "data", "sessions"), { recursive: true });
  return root;
}

function peer(over: Partial<SessionRecord> & Pick<SessionRecord, "kind" | "sessionId">): SessionRecord {
  return {
    machineTag: "Neo",
    startedAt: isoAgo(60_000),
    lastHeartbeat: isoAgo(60_000),
    stale: false,
    ...over,
  } as SessionRecord;
}

// ─── Normalização e teto de caminhos ───────────────────────────────────────

describe("#6168 — normalização de caminho é cross-máquina", () => {
  it("separador do Windows casa com o do Linux", () => {
    // `data/` é o MESMO OneDrive no Neo (Windows) e no helios (Linux). Sem
    // isto, a detecção de sobreposição seria cega exatamente no cenário que a
    // issue chama de caso normal.
    assert.equal(normalizeBeaconPath("scripts\\lib\\session-registry.ts"), "scripts/lib/session-registry.ts");
    assert.ok(beaconPathsOverlap("scripts\\lib\\a.ts", "scripts/lib/a.ts"));
  });

  it("prefixo de DIRETÓRIO sobrepõe; prefixo de STRING não", () => {
    assert.ok(beaconPathsOverlap("scripts/lib", "scripts/lib/session-registry.ts"));
    // O caso que o colapso por prefixo poderia estragar: `scripts/lib` não
    // pode casar `scripts/libreria`.
    assert.equal(beaconPathsOverlap("scripts/lib", "scripts/libreria/x.ts"), false);
  });

  it("caminho vazio nunca sobrepõe nada", () => {
    assert.equal(beaconPathsOverlap("", "scripts/a.ts"), false);
    assert.equal(beaconPathsOverlap("scripts/a.ts", ""), false);
  });
});

describe("#6168 — teto de touched_paths colapsa em vez de truncar", () => {
  it("abaixo do teto: preserva tudo, ordenado e sem duplicata", () => {
    const out = collapseTouchedPaths(["b.ts", "a.ts", "a.ts"], 10);
    assert.deepEqual(out, ["a.ts", "b.ts"]);
  });

  it("acima do teto: colapsa pra prefixo de diretório, preservando o sinal de área", () => {
    // Truncar perderia a informação de que a sessão mexeu naquela área —
    // que é justamente o que `findSessionConflicts` consome.
    const many = Array.from({ length: 50 }, (_, i) => `scripts/lib/mod${i}.ts`);
    const out = collapseTouchedPaths(many, 5);
    assert.ok(out.length <= 5);
    assert.ok(
      out.every((p) => "scripts/lib/mod0.ts".startsWith(p) || p.startsWith("scripts")),
      `colapso deveria manter o prefixo da área, veio: ${JSON.stringify(out)}`,
    );
    // E o sinal sobrevive: um caminho concreto daquela área ainda sobrepõe.
    assert.ok(out.some((p) => beaconPathsOverlap("scripts/lib/mod7.ts", p)));
  });

  it("é determinístico — mesma entrada, mesma saída", () => {
    const many = Array.from({ length: 40 }, (_, i) => `a/b/c/f${i}.ts`);
    assert.deepEqual(collapseTouchedPaths(many, 3), collapseTouchedPaths([...many].reverse(), 3));
  });
});

// ─── Parte C: conflicts ────────────────────────────────────────────────────

describe("#6168 Parte C — conflicts é consulta, e nunca cria arquivo", () => {
  it("rodar conflicts não escreve NADA em data/sessions/", () => {
    // Critério de aceite explícito da issue: nada além de `.merge-lock.json`
    // pode aparecer ali. `conflicts` responde, nunca adquire.
    const root = makeTempRepo();
    try {
      registerSession(root, "develop", "eu", { tag: LOCAL_TAG });
      const antes = readdirSync(join(root, "data", "sessions")).sort();
      findSessionConflicts(listActiveSessions(root, NOW), {
        sessionId: "eu",
        paths: ["scripts/lib/a.ts"],
        branch: "develop/fix-1",
      });
      assert.deepEqual(readdirSync(join(root, "data", "sessions")).sort(), antes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sobreposição de caminho com peer VIVO → conflito", () => {
    const conflicts = findSessionConflicts(
      [peer({ kind: "overnight", sessionId: "outro", touched_paths: ["scripts/lib/session-registry.ts"] })],
      { sessionId: "eu", paths: ["scripts/lib/session-registry.ts"] },
    );
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.kind, "path-overlap");
    assert.equal(conflicts[0]!.peer?.sessionId, "outro");
  });

  it("o MESMO peer, mas STALE → nenhum conflito", () => {
    // Mesma semântica que `isIssueClaimedByOther` já aplica (#5474).
    const conflicts = findSessionConflicts(
      [
        peer({
          kind: "overnight",
          sessionId: "outro",
          touched_paths: ["scripts/lib/session-registry.ts"],
          stale: true,
        }),
      ],
      { sessionId: "eu", paths: ["scripts/lib/session-registry.ts"] },
    );
    assert.deepEqual(conflicts, []);
  });

  it("dirty_paths (não commitado) é reportado como o sinal mais forte", () => {
    // Evidência 2 da issue: um tick terminou deixando 4 arquivos sem commit em
    // master num checkout compartilhado e reportou "concluído". Um beacon que
    // só dissesse `last_action: "commit"` não distinguiria isso.
    const conflicts = findSessionConflicts(
      [peer({ kind: "continuo", sessionId: "tick", dirty_paths: ["scripts/lib/x.ts"] })],
      { sessionId: "eu", paths: ["scripts/lib/x.ts"] },
    );
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0]!.detail, /NÃO COMMITADA/);
  });

  it("nunca conflita consigo mesma", () => {
    const conflicts = findSessionConflicts(
      [peer({ kind: "develop", sessionId: "eu", touched_paths: ["a.ts"], branch: "b" })],
      { sessionId: "eu", paths: ["a.ts"], branch: "b" },
    );
    assert.deepEqual(conflicts, []);
  });

  it("branch-drift: a branch registrada não é mais a do checkout", () => {
    // Evidência 5 da issue: entre o `checkout -b` e o `commit`, outra sessão
    // trocou o checkout pra master e deu pull. O commit caiu em master, e
    // `commit`/`push` reportaram SUCESSO — nenhum sinal de erro em lugar
    // nenhum. Esta é a checagem barata de "a branch ainda é minha?".
    const conflicts = findSessionConflicts([], {
      sessionId: "eu",
      branch: "master",
      ownRecord: peer({ kind: "develop", sessionId: "eu", branch: "fix/6193-teste" }),
    });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.kind, "branch-drift");
    assert.equal(conflicts[0]!.peer, undefined, "branch-drift é sobre o próprio registro, não sobre peer");
  });

  it("branch-shared só conta na MESMA máquina", () => {
    // Máquinas diferentes têm checkouts diferentes; homônimo de branch ali
    // não colide.
    const mesma = findSessionConflicts([peer({ kind: "develop", sessionId: "o", branch: "x", machineTag: "Neo" })], {
      sessionId: "eu",
      branch: "x",
      machineTag: "Neo",
    });
    assert.equal(mesma.some((c) => c.kind === "branch-shared"), true);

    const outra = findSessionConflicts(
      [peer({ kind: "develop", sessionId: "o", branch: "x", machineTag: "helios" })],
      { sessionId: "eu", branch: "x", machineTag: "Neo" },
    );
    assert.equal(outra.some((c) => c.kind === "branch-shared"), false);
  });

  it("sem caminhos e sem branch → nenhum conflito (consulta vazia é silenciosa)", () => {
    assert.deepEqual(
      findSessionConflicts([peer({ kind: "overnight", sessionId: "o", touched_paths: ["a.ts"] })], {
        sessionId: "eu",
      }),
      [],
    );
  });
});

// ─── Parte F: ordenação determinística e "silêncio nunca é cessão" ─────────

describe("#6168 Parte F — ordenação de merge", () => {
  const ann = (sessionId: string, at: string): MergeAnnouncement => ({ sessionId, announcedAt: at });

  it("timestamp mais ANTIGO vence", () => {
    const a = ann("zzz", "2026-08-26T12:00:00.000Z");
    const b = ann("aaa", "2026-08-26T12:00:05.000Z");
    assert.equal(decideMergeOrder(a, b).sessionId, "zzz");
  });

  it("empate de timestamp resolve pelo sessionId lexicograficamente MENOR", () => {
    const a = ann("zzz", "2026-08-26T12:00:00.000Z");
    const b = ann("aaa", "2026-08-26T12:00:00.000Z");
    assert.equal(decideMergeOrder(a, b).sessionId, "aaa");
  });

  it("AS DUAS PONTAS chegam ao MESMO vencedor, em qualquer ordem de argumento", () => {
    // É a propriedade que substitui o lock como mecanismo primário sem
    // introduzir deadlock: cada ponta calcula sozinha e nenhuma precisa
    // esperar resposta pra saber quem venceu.
    const a = ann("neo-abc", "2026-08-26T12:00:03.000Z");
    const b = ann("helios-xyz", "2026-08-26T12:00:01.000Z");
    assert.equal(decideMergeOrder(a, b).sessionId, decideMergeOrder(b, a).sessionId);
    assert.equal(decideMergeOrder(a, b).sessionId, "helios-xyz");
  });

  it("timestamp ilegível de um lado perde pro legível do outro (total, nunca indefinido)", () => {
    const bom = ann("bom", "2026-08-26T12:00:00.000Z");
    const ruim = ann("ruim", "não-é-data");
    assert.equal(decideMergeOrder(bom, ruim).sessionId, "bom");
    assert.equal(decideMergeOrder(ruim, bom).sessionId, "bom");
  });
});

describe("#6168 Parte F — silêncio NUNCA é cessão", () => {
  const mine: MergeAnnouncement = { sessionId: "eu", announcedAt: "2026-08-26T12:00:00.000Z" };

  it("peer sem ACK explícito → fallback-to-lock, nunca proceed", () => {
    // Regra dura da issue. Sem isto, a conversa vira canal de falso consenso:
    // "ninguém reclamou, então é meu".
    const r = resolveMergeAdmission(mine, [{ sessionId: "outro", announcedAt: "" }]);
    assert.equal(r.admission, "fallback-to-lock");
    assert.match(r.reason, /silêncio NUNCA é cessão/);
  });

  it("peer com acked:false também é silêncio", () => {
    const r = resolveMergeAdmission(mine, [{ sessionId: "outro", announcedAt: "", acked: false }]);
    assert.equal(r.admission, "fallback-to-lock");
  });

  it("nenhum peer alcançável → fallback-to-lock (o piso), nunca proceed", () => {
    const r = resolveMergeAdmission(mine, []);
    assert.equal(r.admission, "fallback-to-lock");
  });

  it("todos deram ACK e ninguém anunciou merge concorrente → proceed", () => {
    const r = resolveMergeAdmission(mine, [{ sessionId: "outro", announcedAt: "", acked: true }]);
    assert.equal(r.admission, "proceed");
  });

  it("anúncio concorrente que VENCE a ordenação → yield, mesmo com ACK", () => {
    // Anúncio concorrente é sinal independente do ACK: quem perde a
    // ordenação cede e espera o aviso de "mergeado" pra dar git pull ANTES
    // do próprio CI — que é o que o lock nunca deu (ele solta a janela sem
    // dizer O QUE mudou).
    const r = resolveMergeAdmission(mine, [
      { sessionId: "outro", announcedAt: "2026-08-26T11:59:00.000Z", acked: true, pr: 42 },
    ]);
    assert.equal(r.admission, "yield");
    assert.equal(r.winner?.sessionId, "outro");
  });

  it("anúncio concorrente que PERDE a ordenação não impede proceed", () => {
    const r = resolveMergeAdmission(mine, [
      { sessionId: "outro", announcedAt: "2026-08-26T12:01:00.000Z", acked: true, pr: 42 },
    ]);
    assert.equal(r.admission, "proceed");
  });
});

// ─── #6296: concessão de janela de merge ───────────────────────────────────

describe("#6296 — concessão de janela: só coordenadora, nunca a si mesma", () => {
  it("uma sessão NÃO concede janela a si mesma", () => {
    // É o invariante que preserva a propriedade que o #5716 protege (a
    // coordenadora decide quando entra merge) em vez de contorná-la — sem
    // ele, "conceder a si mesma" seria relabel com outro nome.
    const root = makeTempRepo();
    try {
      registerSession(root, "develop", "eu", { tag: LOCAL_TAG });
      const r = grantMergeWindow(root, "develop", "eu", "eu");
      assert.equal(r.ok, false);
      assert.equal(r.reason, "self-grant-refused");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sessão interativa NÃO concede janela a ninguém", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "interactive", "i1", { tag: LOCAL_TAG });
      const r = grantMergeWindow(root, "interactive", "i1", "outra");
      assert.equal(r.ok, false);
      assert.equal(r.reason, "not-a-coordinator");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("coordenadora concede, o beneficiário encontra, e é USO ÚNICO", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "overnight", "coord", { tag: LOCAL_TAG });
      assert.equal(grantMergeWindow(root, "overnight", "coord", "interativa", { pr: 6278 }).ok, true);

      const found = findLiveMergeGrant(root, "interativa");
      assert.ok(found, "beneficiário deveria encontrar a janela viva");
      assert.equal(found?.grant.pr, 6278);

      assert.equal(consumeMergeGrant(root, "interativa"), true);
      assert.equal(findLiveMergeGrant(root, "interativa"), null, "consumida não vale mais");
      assert.equal(consumeMergeGrant(root, "interativa"), false, "consumir de novo é no-op honesto");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a janela expira pelo TTL", () => {
    const grant = { grantedTo: "x", grantedBy: "coord", grantedAt: new Date(NOW).toISOString() };
    assert.equal(isMergeGrantLive(grant, "x", NOW), true);
    assert.equal(isMergeGrantLive(grant, "x", NOW + MERGE_GRANT_TTL_MS + 1), false);
  });

  it("janela emitida pra OUTRA sessão não vale pra mim", () => {
    const grant = { grantedTo: "outra", grantedBy: "coord", grantedAt: new Date(NOW).toISOString() };
    assert.equal(isMergeGrantLive(grant, "eu", NOW), false);
  });

  it("auto-concessão gravada À MÃO no arquivo continua sem valer", () => {
    // Defesa em profundidade: o guard de `grantMergeWindow` impede criar,
    // este impede honrar uma que apareça por outro caminho.
    const grant = { grantedTo: "eu", grantedBy: "eu", grantedAt: new Date(NOW).toISOString() };
    assert.equal(isMergeGrantLive(grant, "eu", NOW), false);
  });

  it("nenhum ARQUIVO novo aparece em data/sessions/ — a concessão é campo do record", () => {
    // Critério de aceite do #6168 combinado com a proposta do #6296
    // ("arquivo dedicado OU campo no próprio record"): campo satisfaz os dois.
    const root = makeTempRepo();
    try {
      registerSession(root, "develop", "coord", { tag: LOCAL_TAG });
      const antes = readdirSync(join(root, "data", "sessions")).sort();
      grantMergeWindow(root, "develop", "coord", "outra", { pr: 1 });
      assert.deepEqual(readdirSync(join(root, "data", "sessions")).sort(), antes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── #6296: o guard passa a compor com lock e concessão ────────────────────

describe("#6296 — o guard de merge compõe com o lock e com a concessão", () => {
  const coords = new Set(["coord-a"]);

  it("sem coordenadora ativa → nunca bloqueia (comportamento pré-#6296)", () => {
    assert.equal(shouldBlockGhPrMerge(new Set(), "qualquer", {}), false);
  });

  it("caller sem session_id → nunca bloqueia (fail-open, inalterado)", () => {
    assert.equal(shouldBlockGhPrMerge(coords, "", {}), false);
  });

  it("não-coordenadora SEM concessão → bloqueia (comportamento pré-#6296)", () => {
    assert.equal(shouldBlockGhPrMerge(coords, "interativa", { mergeLockHolder: null }), true);
  });

  it("não-coordenadora COM concessão viva → PERMITE — é o caso medido em 260826", () => {
    // O protocolo inteiro da Parte F rodou (peer achado, SendMessage
    // entregue, colisão por arquivo conferida, janela concedida, lock
    // adquirido) e o merge foi bloqueado assim mesmo. Este é o teste que
    // trava a correção.
    assert.equal(shouldBlockGhPrMerge(coords, "interativa", { hasLiveGrant: true, mergeLockHolder: "interativa" }), false);
  });

  it("coordenadora com o lock nas mãos → permite", () => {
    assert.equal(shouldBlockGhPrMerge(coords, "coord-a", { mergeLockHolder: "coord-a" }), false);
  });

  it("coordenadora com o lock de OUTRA sessão → BLOQUEIA (defeito 1 do #6296)", () => {
    // `grep -c 'mergeLock\|merge-lock'` no hook devolvia 0: dois mecanismos
    // governavam a mesma ação sem se compor.
    assert.equal(shouldBlockGhPrMerge(coords, "coord-a", { mergeLockHolder: "outra-coord" }), true);
  });

  it("lock AUSENTE + ÚNICA coordenadora ativa → permite (rodada solo não quebra)", () => {
    assert.equal(shouldBlockGhPrMerge(coords, "coord-a", { mergeLockHolder: null }), false);
  });

  it("lock AUSENTE + DUAS coordenadoras ativas → bloqueia (há contenção real)", () => {
    const duas = new Set(["coord-a", "coord-b"]);
    assert.equal(shouldBlockGhPrMerge(duas, "coord-a", { mergeLockHolder: null }), true);
  });

  it("estado do lock INDETERMINADO → permite, nunca vira bloqueio", () => {
    // `undefined` = não deu pra ler (I/O do OneDrive, JSON corrompido).
    // Nunca transformar falha transitória de leitura em bloqueio de merge
    // legítimo — é a razão de `readMergeLockHolder` distinguir `null` de
    // `undefined`.
    const duas = new Set(["coord-a", "coord-b"]);
    assert.equal(shouldBlockGhPrMerge(duas, "coord-a", { mergeLockHolder: undefined }), false);
  });
});

// ─── as constantes duplicadas no hook não divergem do módulo (#6303 L/M/J) ─

describe("#6303 — as cópias duplicadas em block-gh-pr-merge-subagent.mjs concordam com session-registry.ts", () => {
  // O hook é self-contained (.mjs, sem import de .ts) e mantém cópias
  // PRÓPRIAS de 3 constantes. Duas cópias sem teste que as compare de
  // verdade é a mesma dívida que o fleet review da #6303 (Findings L/M/J)
  // apontou noutros pares deste repo — mudar o valor num lado sozinho
  // deixaria os dois testes (cada um comparando só contra um literal)
  // verdes por coincidência. Aqui os dois módulos são importados lado a
  // lado e comparados de verdade.
  it("CLOCK_SKEW_TOLERANCE_MS", () => {
    assert.equal(HOOK_CLOCK_SKEW_TOLERANCE_MS, CLOCK_SKEW_TOLERANCE_MS);
  });
  it("MERGE_GRANT_TTL_MS", () => {
    assert.equal(HOOK_MERGE_GRANT_TTL_MS, MERGE_GRANT_TTL_MS);
  });
  it("MERGE_LOCK_TTL_MS", () => {
    assert.equal(HOOK_MERGE_LOCK_TTL_MS, MERGE_LOCK_TTL_MS);
  });
});

// ─── #6303 Finding T: consumo automático da concessão pós-merge ───────────

describe("#6303 Finding T — findLiveMergeGrantFile/buildConsumedRecord (funções puras)", () => {
  it("sem concessão nenhuma → null", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "overnight", "coord", { tag: LOCAL_TAG });
      assert.equal(findLiveMergeGrantFile(root, "interativa"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("concessão viva → acha o arquivo, o record e o grant", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "overnight", "coord", { tag: LOCAL_TAG });
      grantMergeWindow(root, "overnight", "coord", "interativa", { pr: 6303 });
      const found = findLiveMergeGrantFile(root, "interativa");
      assert.ok(found);
      assert.equal(found.grant.grantedTo, "interativa");
      assert.equal(found.grant.pr, 6303);
      assert.ok(found.path.includes("overnight-Neo-coord.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("buildConsumedRecord marca consumedAt e preserva o resto do grant/record", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "overnight", "coord", { tag: LOCAL_TAG });
      grantMergeWindow(root, "overnight", "coord", "interativa", { pr: 6303 });
      const found = findLiveMergeGrantFile(root, "interativa");
      const nowIso = new Date(NOW).toISOString();
      const updated = buildConsumedRecord(found, nowIso);
      assert.equal(updated.merge_grant.consumedAt, nowIso);
      assert.equal(updated.merge_grant.grantedTo, "interativa");
      assert.equal(updated.merge_grant.pr, 6303);
      assert.equal(updated.sessionId, "coord", "o resto do record da coordenadora sobrevive");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("concessão já consumida não é achada de novo (uso único de fato)", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "overnight", "coord", { tag: LOCAL_TAG });
      grantMergeWindow(root, "overnight", "coord", "interativa", { pr: 6303 });
      assert.equal(consumeMergeGrant(root, "interativa"), true);
      assert.equal(findLiveMergeGrantFile(root, "interativa"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#6303 Finding T — CLI end-to-end via stdin real (mesmo padrão do #5161 item 10)", () => {
  function makeGitRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "consume-grant-e2e-"));
    mkdirSync(join(root, "data", "sessions"), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: root });
    return root;
  }

  it("session_id com concessão viva → consumedAt é gravado no arquivo da coordenadora", () => {
    const root = makeGitRepo();
    try {
      // Usa o relógio REAL (não o `NOW` fixo de 2026-08-26 usado no resto do
      // arquivo) porque o hook, spawnado como processo separado, resolve
      // `now = Date.now()` de verdade — misturar os dois faria a concessão
      // parecer expirada/no-futuro dependendo de quando a suíte rodar.
      const grantedAt = new Date().toISOString();
      const record = {
        kind: "overnight",
        machineTag: "Neo",
        sessionId: "coord",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        lastHeartbeat: new Date(Date.now() - 1_000).toISOString(),
        merge_grant: { grantedTo: "interativa", grantedBy: "coord", grantedAt, pr: 6303 },
      };
      const path = join(root, "data", "sessions", "overnight-Neo-coord.json");
      writeFileSync(path, JSON.stringify(record), "utf8");

      const payload = { session_id: "interativa", tool_name: "Bash", tool_input: { command: "gh pr merge 6303 --squash" } };
      const result = spawnSync(process.execPath, [CONSUME_HOOK_PATH], {
        cwd: root,
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout.trim(), "", "PostToolUse aqui nunca emite saída — side-effect puro");

      const updated = JSON.parse(readFileSync(path, "utf8"));
      assert.ok(updated.merge_grant.consumedAt, "consumedAt deveria ter sido gravado");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("session_id SEM concessão viva → no-op silencioso, arquivo intocado", () => {
    const root = makeGitRepo();
    try {
      const record = {
        kind: "overnight",
        machineTag: "Neo",
        sessionId: "coord",
        startedAt: isoAgo(60_000),
        lastHeartbeat: isoAgo(1_000),
      };
      const path = join(root, "data", "sessions", "overnight-Neo-coord.json");
      const before = JSON.stringify(record);
      writeFileSync(path, before, "utf8");

      const payload = { session_id: "ninguem-tem-grant", tool_name: "Bash", tool_input: { command: "gh pr merge 1 --squash" } };
      const result = spawnSync(process.execPath, [CONSUME_HOOK_PATH], {
        cwd: root,
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.equal(readFileSync(path, "utf8"), before, "arquivo não deveria ser tocado sem concessão viva");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("payload SEM session_id → nada é escrito, nunca lança", () => {
    const root = makeGitRepo();
    try {
      const payload = { tool_name: "Bash", tool_input: { command: "gh pr merge 1" } };
      const result = spawnSync(process.execPath, [CONSUME_HOOK_PATH], {
        cwd: root,
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.deepEqual(readdirSync(join(root, "data", "sessions")), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── #6303 review cruzado: dois bypasses P1 ────────────────────────────────

describe("#6303 P1·a — a concessão destrava IDENTIDADE, nunca TEMPO", () => {
  const coords = new Set(["coord-a"]);

  it("concessão NÃO pula o merge lock de outra sessão", () => {
    // Era o bypass: o ramo da concessão dava `return false` ANTES da checagem
    // de lock. Somado a `grantMergeWindow` não validar o kind de `grantedTo`,
    // uma coordenadora podia receber concessão de outra e pular a
    // serialização — reabrindo a corrida de merge duplo que o §DEFEITO 1
    // desta mesma unidade fecha.
    assert.equal(
      shouldBlockGhPrMerge(coords, "beneficiada", {
        hasLiveGrant: true,
        mergeLockHolder: "outra-sessao",
      }),
      true,
    );
  });

  it("concessão + lock nas mãos da própria beneficiada → permite", () => {
    assert.equal(
      shouldBlockGhPrMerge(coords, "beneficiada", {
        hasLiveGrant: true,
        mergeLockHolder: "beneficiada",
      }),
      false,
    );
  });

  it("concessão + lock AUSENTE + 1 coordenadora → bloqueia: há 2 sessões, logo contenção", () => {
    // A beneficiada não é a coordenadora, então existem duas sessões em jogo.
    // Ela também precisa passar pelo lock — corolário de "identidade, não tempo".
    assert.equal(
      shouldBlockGhPrMerge(coords, "beneficiada", { hasLiveGrant: true, mergeLockHolder: null }),
      true,
    );
  });

  it("coordenadora sozinha, lock ausente → segue permitindo (rodada solo não quebrou)", () => {
    assert.equal(shouldBlockGhPrMerge(coords, "coord-a", { mergeLockHolder: null }), false);
  });

  it("grantMergeWindow RECUSA conceder a outra coordenadora ATIVA", () => {
    // Defesa em profundidade: esta recusa responde "quem pode RECEBER"; a
    // reordenação no guard responde "quando pode USAR". Fechar só uma
    // deixaria a outra metade aberta a um merge_grant gravado por outro
    // caminho.
    const root = makeTempRepo();
    try {
      registerSession(root, "overnight", "coord-a", { tag: LOCAL_TAG });
      registerSession(root, "develop", "coord-b", { tag: LOCAL_TAG });
      const r = grantMergeWindow(root, "overnight", "coord-a", "coord-b", { pr: 1 });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "grantee-is-coordinator-refused");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("grantMergeWindow CONCEDE normalmente a sessão não-coordenadora", () => {
    const root = makeTempRepo();
    try {
      registerSession(root, "overnight", "coord-a", { tag: LOCAL_TAG });
      registerSession(root, "interactive", "interativa", { tag: LOCAL_TAG });
      assert.equal(grantMergeWindow(root, "overnight", "coord-a", "interativa", { pr: 1 }).ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#6303 P1·b — varredura degradada a ZERO coordenadoras não permite", () => {
  it("size 0 + scan DEGRADADO → BLOQUEIA (pior caso de degradação)", () => {
    // O ramo `size === 0` rodava ANTES de `scanDegraded` ser lido em lugar
    // nenhum: `readdirSync` lançando, ou toda entrada falhando no parse,
    // era tratado igual a "não há rodada ativa" — com rodada real ativa e
    // apenas ilegível naquele instante.
    assert.equal(shouldBlockGhPrMerge(new Set(), "qualquer", { scanDegraded: true }), true);
  });

  it("size 0 + scan CONFIÁVEL → permite (sessão interativa comum, #5251)", () => {
    assert.equal(shouldBlockGhPrMerge(new Set(), "qualquer", { scanDegraded: false }), false);
  });

  it("lock INDETERMINADO + scan degradado → bloqueia (os dois sinais moram no mesmo diretório)", () => {
    assert.equal(
      shouldBlockGhPrMerge(new Set(["coord-a"]), "coord-a", {
        mergeLockHolder: undefined,
        scanDegraded: true,
      }),
      true,
    );
  });

  it("lock INDETERMINADO + scan saudável → PERMITE: 'indeterminado nunca bloqueia' segue valendo", () => {
    // O review pediu cruzar `undefined` com `scanDegraded`, não transformar
    // toda leitura falha em bloqueio — isso quebraria o fail-safe declarado
    // desta função desde o #6296.
    assert.equal(
      shouldBlockGhPrMerge(new Set(["coord-a", "coord-b"]), "coord-a", { mergeLockHolder: undefined }),
      false,
    );
  });
});
