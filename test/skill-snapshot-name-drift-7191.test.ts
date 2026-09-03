/**
 * test/skill-snapshot-name-drift-7191.test.ts (#7191, regressão #633)
 *
 * `.claude/skills/diaria-2-escrita/SKILL.md` gravava o snapshot pré-humanizador
 * do social como `03-social.pre-humanize.md` (ponto + "humanize"), enquanto
 * `scripts/lib/assert-humanized.ts`/`invariant-checks/stage-2.ts` lêem
 * `03-social-pre-humanizador.md` (hífen + "humanizador"). O `cp` sempre
 * "funcionava", mas o snapshot era ignorado pelo guard — o invariante de
 * humanização do social passava a depender de um arquivo criado por outro
 * caminho, e a discordância era silenciosa.
 *
 * Este teste é o GUARD CONTRA REINCIDÊNCIA (item 3 do #7191): parseia os
 * paths de snapshot citados no SKILL.md e exige que cada um esteja entre os
 * snapshots que `assert-humanized.ts` conhece. Sem isso, o próximo rename
 * volta a divergir em silêncio — mesma classe do drift-guard que
 * `test/encerramento-social-apoio-3219.test.ts` já faz pro encerramento.
 *
 * Escopo honesto: cobre o SKILL.md da Etapa 2 (o único call site do drift
 * confirmado). O newsletter (`02-draft.pre-humanize.md`) é um snapshot de
 * rollback do humanize-agent, não o snapshot que `assert-humanized.ts`
 * verifica (`02-humanized.md`) — os dois são artefatos distintos, então o
 * newsletter não é um par do checker e não há drift ali (auditoria #7191).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SNAPSHOT_PAIRS } from "../scripts/lib/assert-humanized.ts";

const ROOT = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const SKILL_MD = join(ROOT, ".claude", "skills", "diaria-2-escrita", "SKILL.md");

// Snapshots pré-humanizador que o checker de fato conhece (fonte de verdade
// executável). Qualquer path de snapshot gravado pelo SKILL.md deve bater
// com um desses — o SKILL.md é a documentação, o .ts é o que roda.
// `DEFAULT_SNAPSHOT_PAIRS` vem com o prefixo `_internal/`; `extractSnapshotCandidates`
// abaixo devolve só o basename (o prefixo é variável no SKILL.md, `cp ...` ou
// `{EDIR}/...`), então normalizamos os dois lados pro basename pra comparar.
const KNOWN_SNAPSHOTS = new Set(
  DEFAULT_SNAPSHOT_PAIRS.map((p) => p.snapshot.replace(/^_internal\//, "")),
);

/** Extrai paths de `_internal/*` do SKILL.md que se parecem com um snapshot
 * pré-humanizador do SOCIAL (contêm "03-social" + "humaniz"). Devolve o
 * basename, sem o `_internal/` prefixo, pra comparar com os valores de
 * `DEFAULT_SNAPSHOT_PAIRS` (que já vêm sem o prefixo).
 *
 * Escopo deliberado: só o social. O newsletter tem um snapshot de rollback
 * (`02-draft.pre-humanize.md`, §3c) que NÃO é um snapshot do checker — o
 * checker lê `02-humanized.md`, a SAÍDA do humanizador. Incluir o newsletter
 * aqui geraria um falso-positivo (o #7191 auditou os dois pares e confirmou
 * que só o social divergia). */
function extractSocialSnapshotCandidates(md: string): string[] {
  const found = new Set<string>();
  // Casam `cp ... _internal/03-social.pre-humanize.md` e
  // `{EDIR}/_internal/03-social-pre-humanizador.md` — o prefixo {EDIR}/ é
  // variável, então o regex âncora em `_internal/` e captura o restante.
  const re = /_internal\/(03-social[A-Za-z0-9_.-]*humaniz[A-Za-z0-9_.-]*\.md)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    found.add(m[1]);
  }
  return [...found];
}

describe("#7191 — SKILL.md snapshot names devem bater com assert-humanized.ts (drift-guard)", () => {
  const md = readFileSync(SKILL_MD, "utf8");

  it("SKILL.md existe e cita o snapshot do social", () => {
    assert.ok(md.length > 0, "SKILL.md vazio");
    assert.match(md, /03-social/);
  });

  it("o snapshot do social citado no SKILL.md é o que assert-humanized.ts conhece", () => {
    const candidates = extractSocialSnapshotCandidates(md);
    assert.ok(
      candidates.length > 0,
      "nenhum path de snapshot pré-humanizador encontrado no SKILL.md",
    );
    const unknown = candidates.filter((c) => !KNOWN_SNAPSHOTS.has(c));
    assert.equal(
      unknown.length,
      0,
      `SKILL.md citou snapshot(s) que assert-humanized.ts NÃO conhece: ${unknown.join(", ")}. ` +
        `Conhecidos: ${[...KNOWN_SNAPSHOTS].join(", ")}.`,
    );
  });

  it("o snapshot do social é exatamente 03-social-pre-humanizador.md (não 03-social.pre-humanize.md)", () => {
    // Regressão direta do #7191: a forma antiga (ponto + "humanize") NUNCA
    // deve reaparecer no SKILL.md.
    assert.doesNotMatch(md, /03-social\.pre-humanize\.md/);
    assert.match(md, /03-social-pre-humanizador\.md/);
  });
});

/**
 * Escopo honesto do drift-guard (documentado pra não parecer que o teste é
 * mais amplo do que é): ele cobre a DIREÇÃO do drift que o #7191 tem — o
 * SKILL.md gravando um nome que o checker NÃO conhece. A direção inversa
 * (checker conhecendo um snapshot que o SKILL.md nem cita) NÃO é coberta,
 * e não deveria ser: o par do newsletter em `assert-humanized.ts`
 * (`02-reviewed.md` vs `_internal/02-humanized.md`) não é um snapshot que o
 * SKILL.md crie. O `02-draft.pre-humanize.md` citado no SKILL.md é o snapshot
 * de rollback do humanize-agent (§3c); o `02-humanized.md` que o checker
 * lê é a SAÍDA do humanizador, gravada pelo orchestrator-stage-2
 * (`.claude/agents/orchestrator-stage-2.md` §"Humanizar"). São artefatos
 * distintos, então o SKILL.md não citar `02-humanized.md` é correto — não é
 * drift. O #7191 auditou os dois pares e confirmou que só o social divergia.
 */