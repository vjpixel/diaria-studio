# Por que o passo 0 (recuperação de tick interrompido, #7130) existe

Medição ao vivo (#6908, 02/09/2026): 2 de 3 ticks longos produziram diff real
e não fecharam o laço. Não houve claim, commit nem PR, e a árvore de trabalho
ficou suja em `master` no checkout compartilhado (#6952: 498 linhas nunca
commitadas, enquanto a sessão anterior reportava "concluído"). Extraído do
SKILL.md no #11315 para mantê-lo abaixo do teto de tamanho (#6712).
