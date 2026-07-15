# Regras obrigatórias de dispatch (overnight + develop)

Checklist canônico das regras que **todo subagente implementador** de
`/diaria-overnight` e `/diaria-develop` deve seguir. Extraído do boilerplate
que os dois `SKILL.md` reproduziam em cada prompt de dispatch (#3453 Rec 4 /
#3454 Rec 2, análises `docs/overnight-token-analysis-3327.md` §4 e
`docs/develop-token-analysis-3328.md` §5).

**Como usar:** o coordenador **cita este path** no prompt de dispatch e instrui
o subagente a lê-lo no início da própria sessão (`Read context/overnight-dispatch-rules.md`),
em vez de reproduzir o texto completo das regras a cada dispatch. O ganho de
token é do lado do **coordenador** (prompt de dispatch mais curto, menos texto
crescendo na conversa do coordenador ao longo da noite) — o subagente ainda
carrega o conteúdo via `Read`, mas uma vez, da fonte única. Fonte da verdade
única também reduz a classe de incidente #3321 (convenção seguida só porque
estava em prosa narrativa, não em checklist acionável no ponto de uso).

> Nota de sincronia: alguns destes itens também aparecem em prosa nos dois
> `SKILL.md` (e alguns são travados por `test/overnight-skill-npm-test-scope.test.ts`).
> Ao editar uma regra aqui, conferir se a versão do `SKILL.md` correspondente
> precisa acompanhar — este arquivo é o checklist canônico; o `SKILL.md` é a
> instrução ao coordenador.

---

## 1. Guard de publicação (INVARIANTE)

Editar código de publisher **é ok**; **EXECUTAR é proibido**. Nunca rodar
`scripts/publish-*`, `clarice-schedule-sends`, `clarice-import-*`, `close-poll`
ou qualquer script que toque Beehiiv/LinkedIn/Facebook/Brevo ao vivo — nem em
"teste". (Exceção controlada, só no `/diaria-develop` e só pelo coordenador
top-level, nunca pelo subagente: `publish-*.ts --dry-run` para validar token
recém-colado, cat. A.)

## 2. Convenção de branch (#3321 — instrução literal, não implícita)

- Overnight: `overnight/fix-{issue}-{slug}` (solo) ou `overnight/batch-{slug}` (lote).
- Develop: `develop/fix-NNNN` (solo) ou `develop/blast-NNNN` (cat. D, sempre solo).

O prefixo é o sinal que `.claude/hooks/pr-create-review.mjs` (`resolveEffort`)
usa pra dar `low` effort no `/code-review` pós-`gh pr create`, e é o que o
cleanup de fim de rodada usa pra deletar a branch remota corretamente.

## 3. Bootstrap do worktree

Primeiro passo é **`npm ci`** — worktree novo não tem `node_modules/` nem a
junction `data/`.

## 4. Disciplina de testes (#2959) — NUNCA a suíte completa local

Testes locais = **`npx tsc --noEmit`** (typecheck) **+ só os arquivos de teste
afetados/novos** (`npx tsx --test test/<arquivo-tocado>.test.ts test/lib-boundary.test.ts`).
**NUNCA `npm test` completo local** — o CI já roda a suíte inteira como gate
autoritativo antes do merge (#636/#633); repetir os ~11k testes/~3min no
worktree é redundante e é justamente o comando que dispara o auto-background do
harness (subagente entra em Monitor-loop e não retorna → stall).

`npx tsc --noEmit` e os testes afetados rodam **SEMPRE em FOREGROUND**,
aguardando o resultado antes de retornar — nunca em background. Se um full-run
local for genuinamente necessário (raro), pipe por `| tail -40` pra forçar o
resultado a voltar na própria chamada. Subagente que tocar
`.claude/agents/orchestrator-*.md` roda `NODE_TEST_SNAPSHOTS=1 npx tsx --test test/orchestrator-prompt.test.ts`
antes do push (#634).

## 5. Teste de regressão em bugfix (#633)

Fix de bug **exige teste novo** demonstrando que o bug não voltaria. Sem teste →
não merge. Se não for testável (ex: prompt de agent), justificar explicitamente
no PR body.

## 6. Marcador `no-regression-test` proativo para PRs sem código executável (#3327 Rec 7)

Se a unidade é **só docs/comentário/prompt sem código executável**, incluir
desde o início no PR body o marcador literal `no-regression-test: <razão>` — não
esperar o hook `check-pr-bugfix.ts` reclamar (ele pegou o coordenador de
surpresa 2× na rodada 260711). Reduz latência, não tokens; praticamente
gratuito.

## 7. Self-review obrigatório antes de retornar (#2038) — tratado como ETAPA DE LISTAGEM

Após o `gh pr create`, o subagente faz UMA passada adversarial no próprio
`git diff` contra a(s) issue(s) + briefing: o diff cobre TODOS os pontos (não só
os fáceis)? Sobrou referência órfã de refactor? O arquivo carrega? O cenário
REAL da issue tem teste? **O output esperado são os findings listados como
comentários inline no PR** (não fixes imediatos). Retornar: o número do PR **+ a
linha "self-review: N findings"**.

## 8. Não executar review multi-agente pós-`gh pr create`

Se um hook pós-`gh pr create` exigir code-review multi-agente, **não executar** —
o self-review acima é a resposta; anotar no body do PR e retornar (subagente não
pode dispatchar Agent, #207; o review pesado roda UMA vez, consolidado, na
Fase 1.5).

## 9. Convenções de commit/PR do repo

Seguir as convenções de commit/PR do `CLAUDE.md`. PR abre com `Closes #NNNN` (um
`closes` por issue do lote). Título com `(#NNNN)` / `(#A, #B, ...)`.
