# Experimento D3 vs slot 1 do Radar (#4846)

**Status:** PRÉ-REGISTRADO, mecanismo implementado e **DESLIGADO**. `platform.config.json` → `experiment_d3_radar.enabled` está em `false` — nenhuma edição foi randomizada até agora. Ativar em produção é uma decisão SEPARADA do editor, tomada depois deste pré-registro existir (ver `CLAUDE.md` — decisão do editor 260810 autoriza o desenho mas não a ativação). Este documento precede a 1ª edição randomizada, conforme exigido pela própria decisão de autorização.

**Pré-requisito:** #4841 (`_internal/link-layout.json` + `_internal/published-links.json`) — mergeado antes desta unidade. Sem eles a alocação não seria auditável.

**Mecanismo:** `scripts/experiment-d3-radar.ts` (#633 — testes em `test/experiment-d3-radar.test.ts`). Wiring no orchestrator: `.claude/agents/orchestrator-stage-1-research.md` §"Experimento D3 vs slot 1 do Radar", passo 1y, logo após os invariants pós-gate-apply e antes do sentinel do Stage 1.

---

## Por que este experimento

Metade dos achados da auditoria de cliques de 260810 morre no mesmo confundimento: **posição e conteúdo são atribuídos juntos** — o pipeline decide a posição a partir do score, então nenhuma análise observacional consegue separar os dois. Só randomização rompe esse confundimento.

Este é o desenho mais barato que faz isso, porque randomiza **posição mantendo o conteúdo fixo**: o mesmo artigo, escolhido pelo mesmo `scorer-select` e pelo mesmo gate humano, sai em duas apresentações diferentes conforme o braço sorteado.

Contexto que motiva a hipótese: o D3 rende **3× menos que links não-destaque na mesma faixa de posição** (0,278% contra 0,850%, auditoria 260810), o que falsifica uma explicação puramente posicional — a suspeita é que o problema seja o **estoque** que sobra para o terceiro slot (menor score médio, tema menos forte), não o slot em si.

## Hipótese

O item que hoje ocupa o **terceiro slot de destaque** (D3) rende mais clique no **slot 1 do Radar** do que como D3, com o mesmo processo de seleção — isolando *posição* de *estoque*.

## Desenho

- **Unidade de randomização:** a edição.
- **Momento do sorteio:** Stage 1, DEPOIS do gate humano — `apply-gate-edits.ts` já escreveu `_internal/01-approved.json` com os 3 destaques que o editor aprovou. O sorteio não influencia o que o editor vê nem aprova no gate; ele decide como o conteúdo já aprovado é DISTRIBUÍDO na newsletter.
- **Seed:** determinístico por edição (`sha256("diaria-d3-radar-v1:" + AAMMDD)`, primeiro byte mod 2). A mesma edição sempre produz o mesmo braço — inclusive em resumes do Stage 1 (a decisão é persistida na primeira invocação e nunca re-sorteada).
- **Registro:** `_internal/.experiment-d3.json` por edição — `{ edition, arm, decided_at, applied, reason, promoted_url, applied_at }`.
- **Braço A (controle):** o 3º destaque sai como D3, como hoje. No-op — `01-approved.json` não é tocado.
- **Braço B (tratamento):** o **mesmo item** de rank 3 (mesmo `scorer-select`, mesmo gate humano) sai da lista de destaques e é inserido como **primeiro item do Radar**; a edição vai ao ar com 2 destaques — configuração já permitida pelo #3369 (edge case #2316/#2343) e, até 260810, **nunca exercida em produção** (0 de 81 edições em abr–ago/2026).
- **Alocação:** 1:1 por edição. Sem estratificação (o n não sustenta subgrupos).
- **Edge case:** se o gate humano já produziu só 2 destaques (demoção manual de D3 pelo editor, decisão editorial independente do experimento), não há D3 para o experimento demover — o braço B vira no-op automático (`reason: "insufficient_highlights"`) e a edição segue com os 2 destaques que o editor escolheu, sem interferência do experimento.

## Medição

- **Primário:** cliques únicos no item sorteado, denominador `unique_opens` da edição. Poisson exato de razão de taxas. **Unidade de variância = edição** — nada de binomial sobre aberturas (o mesmo erro que produziu o falso "11,1×" da auditoria 260810).
- **Secundário:** cliques editoriais totais da edição (detecta canibalização — se mover o item rouba clique de outro item do Radar, o ganho é ilusório e a comparação correta é contra o total, não contra o item isolado).
- **Guardrails, não desfechos** (nunca decidem sozinhos, só param o experimento se degradarem): abertura da edição seguinte, unsubscribe, taxa de resposta ao "É IA?".
- **Auditoria de posição:** `_internal/link-layout.json` + `_internal/published-links.json` (#4841) cruzados com `_internal/.experiment-d3.json` — nenhuma reconstrução heurística de posição a partir do HTML publicado (a fonte da falha de 24–35% de recuperabilidade que motivou o #4841 nunca entra nesta análise).

## Poder — sem maquiagem

Partida: D3 ≈ 0,26 clique/edição; Radar slot 1 ≈ 0,70. RR esperado ≈ 2,6.

Para RR = 2,6 com 80% de poder e α = 0,05 bilateral: **~37 eventos ≈ 80 edições ≈ 4 meses**. Com 60 edições o poder cai para ~70%, e para **~25%** se o efeito real for RR = 1,5.

**Este experimento distingue "muito melhor" de "nada" e não mede diferenças moderadas.** Nenhum desenho com ~575 assinantes e ~7 cliques editoriais por edição mede diferenças finas. Um resultado nulo **não** prova equivalência — prova que o efeito, se existe, é menor que o custo de detectá-lo, e a decisão volta a ser editorial (o D3 consome `writer-destaque` + imagem 1×1 + 3 opções de título por ~1 clique a cada 4–12 edições, no ritmo atual).

## Regras de parada (pré-registradas)

1. Após 60 edições randomizadas, se o IC95 da razão de taxas contiver 1,0 **e** o ponto estimado for < 1,5 → mover não paga; manter 3 destaques (encerrar o experimento, braço A vira o padrão permanente).
2. Se cliques editoriais totais caírem no braço B com IC excluindo zero → canibalização; encerrar e investigar antes de repetir.
3. Se qualquer guardrail degradar (abertura da edição seguinte, unsubscribe, resposta ao É IA?) → parar imediatamente, independentemente do que o desfecho primário mostrar até ali.

Nenhuma dessas regras é avaliada automaticamente pelo mecanismo desta unidade — a decisão de encerrar/continuar/promover é sempre do editor, lendo `_internal/.experiment-d3.json` de cada edição randomizada acumulada. Automatizar essa leitura é trabalho futuro, fora do escopo do #4846.

## Ativação (checklist para o editor, quando decidir começar)

1. Confirmar que este documento reflete o desenho que será de fato rodado (nenhuma mudança de protocolo sem atualizar o pré-registro antes da 1ª edição randomizada).
2. Setar `platform.config.json` → `experiment_d3_radar.enabled: true`.
3. A partir da 1ª edição com o flag ligado, `_internal/.experiment-d3.json` passa a existir por edição — usar como fonte de verdade do braço sorteado.
4. Acompanhar as regras de parada acima a cada N edições acumuladas; registrar decisões no "Log de decisões" abaixo (mesma convenção de `docs/experiments/cta-ab-mensal-2606-07.md`).

## Segundo experimento (depois deste, fora de escopo aqui)

Randomizar a ordem **dentro** do Radar identificaria o efeito de slot em geral — mais valioso a longo prazo, mas exige ~67 edições por braço. Não implementado nesta unidade.

## Log de decisões

- 2026-08-10 — issue #4846 aberta a partir da auditoria retrospectiva de cliques (260810). Editor autoriza o desenho (randomização 1:1 por edição, seed determinístico, pré-registro obrigatório antes da 1ª edição randomizada) — alternativa de rodar o braço A pelo Beehiiv e o braço B pelo canal Brevo foi considerada e descartada por não medir o que a issue pede.
- 2026-08-10 — mecanismo implementado (`scripts/experiment-d3-radar.ts`, wiring no `orchestrator-stage-1-research.md`, flag `experiment_d3_radar.enabled: false` em `platform.config.json`) e este pré-registro escrito. **Experimento permanece DESLIGADO** — ativação é decisão separada do editor, ainda não tomada.

---

Origem: auditoria retrospectiva do histórico de cliques, 260810 — https://claude.ai/code/artifact/4a03dea3-5fdb-4794-ae2e-dcf5385f2870
