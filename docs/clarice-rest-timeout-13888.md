# Clarice REST: diagnóstico de 24/11/2026 (#13888)

Fonte: registros `clarice_rest_attempt` em `data/run-log.jsonl`, edição
261124, Stage 4. Horários UTC; bytes são o payload registrado pelo cliente.

| Horário | Bytes | Duração | Resultado |
| --- | ---: | ---: | --- |
| 14:49–14:51 | 3864 | 60s × 3 | timeout do cliente |
| 14:54:04 | 1547 | 7,563s | sucesso |
| 14:54:10 | 1590 | 6,006s | sucesso |
| 14:54:17 | 1664 | 6,397s | sucesso |
| 14:55–14:57 | 1707 | 60s × 3 | timeout do cliente |

Todos registram `chunksInFlight: 0` (nenhuma OUTRA chamada em voo no
processo). A afirmação inicial de que nenhum payload passou não corresponde
ao log: a rodada pequena avançou três chunks antes de falhar.

Os sucessos autenticados na mesma rodada enfraquecem chave inválida e falha
TLS persistente; não há erro HTTP, de certificado ou de rede nesses registros.
Concorrência local tampouco explica essas falhas. Os dados não separam tempo
de conexão/TLS, fila remota e processamento do conteúdo; não permitem excluir
problema intermitente de transporte/keep-alive nem atribuir causa ao servidor.
Também não provam que 120s bastam. Não foi feita chamada paga de diagnóstico.

## Política adotada

O resume com chunks de até 1800 caracteres passa a usar UMA tentativa de
120s por chunk. Reiniciar três vezes aos 60s nunca permitia observar uma
resposta após esse limite. O máximo por chunk cai de 195s (com backoff) para
120s; o deadline da rodada e o orçamento global de 540s continuam valendo.
O caminho inicial com chunks normais permanece com a política anterior.
Não há evidência de endpoint alternativo suportado que justifique migrar.

O log existente já mede horário, bytes, duração, resultado e concorrência
por tentativa. Após novas edições, comparar esses campos, incluindo sucessos,
para avaliar a janela maior. Não se introduz polling agendado de API paga:
as próprias execuções editoriais fornecem as amostras por dia. Falha continua
preservando o marcador pendente e o aviso no gate; saída parcial nunca é
tratada como revisão completa. A aprovação sem Clarice segue sendo humana.
