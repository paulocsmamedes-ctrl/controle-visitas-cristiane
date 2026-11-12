# Operação da sincronização

O GitHub executa `node run-sync.cjs`. O controle guarda apenas `lastFullSyncAt` e `retryAfter` no cache de Actions; não armazena clientes, eventos ou credenciais.

- Disparos frequentes continuam enviando edições/exclusões do CRM e concluindo visitas pelo horário, quando o Firebase permite acesso.
- Importação e reconciliação completa de exclusões do Google são executadas uma vez por hora após um ciclo completo saudável. Essa opção reduz as leituras do histórico, mas pode atrasar a chegada de alterações do Google ao CRM em até uma hora, além dos atrasos do agendador.
- Código Firestore 8 (RESOURCE_EXHAUSTED) inicia pausa de uma hora. Durante a pausa não se acessa o Firebase. O horário de nova tentativa fica no resumo do Actions.
- Uma execução verde com aviso de cota significa que o controle de pausa funcionou; NÃO confirma sincronização, fila zerada ou recuperação da cota. Verificar o resumo e meta/googleSync depois de um ciclo completo bem-sucedido.
- Erros de autenticação, permissão, testes e demais falhas continuam encerrando a execução com erro.
- Perda do cache provoca nova tentativa/ciclo completo, sem perder dados ou pendências. Não limpar o cache para insistir em um banco sem cota.

## Orçamento diário dentro da cota grátis (`quota.cjs`)

- A cota grátis do Firestore é do projeto: 50.000 leituras e 20.000 gravações por dia, zerando à meia-noite do Pacífico (05h em Brasília; 04h durante o horário de verão dos EUA). Site e app gastam da mesma cota, e o sync não vê esse gasto.
- Por isso o sync se limita a **metade**: 25.000 leituras e 10.000 gravações por dia.
- Cada ciclo mede o que leu e gravou (consulta = 1 leitura por documento, mínimo 1; cada gravação = 1) e soma ao dia. O contador fica no cache do Actions e em `meta/googleSync.cotaDoSync`; vale o maior dos dois, então perder o cache não zera a conta.
- Ciclo completo só roda se o custo medido do último completo couber abaixo de 80% do orçamento. Acima disso, só a fila do CRM e a conclusão por horário.
- Em 100% o sync não acessa o Firebase até a virada da cota. O aviso no Actions diz "gastou o orçamento diário".
- Cada execução mostra no resumo: "Cota do sync hoje: X de 25.000 leituras e Y de 10.000 gravações".

A causa exata da cota deve ser verificada em Uso do Firestore no Firebase Console. Não ativar cobrança automaticamente. A pausa reduz tentativas, mas não aumenta limites do Firebase.

Validação de 11/11/2026: 36 testes do servidor aprovados.
