# Operação da sincronização

O GitHub executa `node run-sync.cjs`. O controle guarda apenas `lastFullSyncAt` e `retryAfter` no cache de Actions; não armazena clientes, eventos ou credenciais.

- Disparos frequentes continuam enviando edições/exclusões do CRM e concluindo visitas pelo horário, quando o Firebase permite acesso.
- Importação e reconciliação completa de exclusões do Google são executadas uma vez por hora após um ciclo completo saudável. Essa opção reduz as leituras do histórico, mas pode atrasar a chegada de alterações do Google ao CRM em até uma hora, além dos atrasos do agendador.
- Código Firestore 8 (RESOURCE_EXHAUSTED) inicia pausa de uma hora. Durante a pausa não se acessa o Firebase. O horário de nova tentativa fica no resumo do Actions.
- Uma execução verde com aviso de cota significa que o controle de pausa funcionou; NÃO confirma sincronização, fila zerada ou recuperação da cota. Verificar o resumo e meta/googleSync depois de um ciclo completo bem-sucedido.
- Erros de autenticação, permissão, testes e demais falhas continuam encerrando a execução com erro.
- Perda do cache provoca nova tentativa/ciclo completo, sem perder dados ou pendências. Não limpar o cache para insistir em um banco sem cota.

A causa exata da cota deve ser verificada em Uso do Firestore no Firebase Console. Não ativar cobrança automaticamente. A pausa reduz tentativas, mas não aumenta limites do Firebase.

Validação de 11/11/2026: 36 testes do servidor aprovados.
