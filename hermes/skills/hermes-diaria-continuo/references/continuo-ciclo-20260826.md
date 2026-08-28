---
name: hermes-diaria-continuo-reporting
description: Relatório final do ciclo contínuo da Diária deve ser compacto: incluir só o que protege a continuidade (operacional — issues trabalhadas, PRs pendentes, decisões registradas, motivo de parada, próxima ação), e só mencionar auditivo (tabela completa do backlog, git status, runtime state, URLs merged) quando anormal.
version: 1.0
license: MIT
---

# Relatório compacto — Ciclo contínuo

O usuário corrigiu o formato do relatório durante uma execução da `hermes-diaria-continuo`: "qual o modelo?" / "por que as mensagens são tão longas?" / "degrada?". A correção (v0.4.1): relatório **operacional**, não auditivo.

## Regra

**Sempre incluir (operacional — protege o próximo tick):**
- Issues trabalhadas neste tick (número, ExecTrack, ação tomada, estado);
- PRs abertos pendentes (número, URL via `gh pr view`, checks, veredito review);
- Decisões/bloqueios registrados (issue, label aplicada, comentário);
- Respostas editor processadas (issue, decisão, link do comentário);
- Motivo de parada objetivo ("overnight ativo: N sessões" / "fila vazia" / "orçamento acabou");
- Próxima ação esperada no próximo tick.

**Só se anormal (auditivo — rederivado do zero pelo próximo tick):**
- Tabela completa do backlog — só listar issues cujo `ExecTrack` mudou;
- `git status` / `worktree list` — só se dirty/worktree inesperado;
- Estado do runtime (`cron 5d791ef6fc2c`) — só se não configurado ou mudou;
- URLs de PRs já merged — só número + "merged".

**Formato sugerido:**
```
## Tick HH:MM
### Trabalhado: #N (ExecTrack) → ação | PR #N (checks)
### Pendente: PR #N (review independente); #N batch X/5
### Decisões: #N → label aplicada, comentário registrado
### Parada: overnight ativo / fila vazia / orçamento
### Próxima ação: ...
```
Se fila vazia + sem PR + sem perguntas: uma linha: "Tick HH:MM — fila overnight vazia, nada a fazer."

## Pitfalls

- **Relatórios inchaçados mascaram continuidade.** Reimprimir tabela completa do backlog, `git status`, `worktree list`, URLs merged e declaração do runtime como texto obrigatório não protege o próximo tick — ele rederiva isso via `gh issue list`, `classifyExecTrack`, `git status` do zero. Só incluir auditivo se anormal; caso contrário, o relatório deve ser uma linha quando não há trabalho.
- Se uma `overnight` foi implementada mas ainda precisa de review/merge, listar como "parcial" no relatório — não declarar ciclo encerrado até a fila (a) estar realmente vazia.
