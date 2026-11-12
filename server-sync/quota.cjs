// Orçamento diário do sync dentro da cota GRÁTIS do Firestore (plano Spark).
//
// A cota grátis é do projeto inteiro: 50.000 leituras e 20.000 gravações por dia,
// zerando à meia-noite do horário do Pacífico (05h ou 04h em Brasília, conforme o
// horário de verão dos EUA). O site e o app de celular gastam da MESMA cota, e o
// sync não enxerga esse gasto. Por isso o sync só pode usar metade de cada limite.
//
// Faixas do orçamento do sync:
//   - ciclo completo (relê o histórico) só se couber abaixo de 80%, no ritmo das
//     horas já passadas do dia (o gasto se espalha pelas 24 h);
//   - acima disso, só envia pendências do CRM e conclui visitas pelo horário;
//   - em 100%, não toca no Firebase até a virada do dia da cota.
const COTA_GRATIS = Object.freeze({ leituras: 50000, gravacoes: 20000 });
const LIMITE = Object.freeze({ leituras: COTA_GRATIS.leituras / 2, gravacoes: COTA_GRATIS.gravacoes / 2 });
const FAIXA_COMPLETO = 0.8;
// Estimativa até o primeiro ciclo completo ser medido.
const CUSTO_COMPLETO_PADRAO = Object.freeze({ leituras: 3000, gravacoes: 300 });
const FUSO_DA_COTA = 'America/Los_Angeles';

const fmtDia = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_DA_COTA, year: 'numeric', month: '2-digit', day: '2-digit' });
function diaDaCota(now = Date.now()) { return fmtDia.format(new Date(now)); }

// Próxima meia-noite do Pacífico, com precisão de minuto e correta no horário de verão.
function proximaVirada(now = Date.now()) {
  const hoje = diaDaCota(now);
  let t = now;
  while (diaDaCota(t) === hoje) t += 3600000;
  t -= 3600000;
  while (diaDaCota(t) === hoje) t += 60000;
  return Math.floor(t / 60000) * 60000;
}

function usoVazio(now) { return { dia: diaDaCota(now), leituras: 0, gravacoes: 0 }; }

// Uso de hoje; um registro de outro dia da cota vale zero.
function usoDeHoje(uso, now = Date.now()) {
  if (!uso || uso.dia !== diaDaCota(now)) return usoVazio(now);
  return { dia: uso.dia, leituras: Number(uso.leituras) || 0, gravacoes: Number(uso.gravacoes) || 0 };
}

// Junta duas fontes do mesmo dia (cache do Actions e meta/googleSync) pelo maior valor:
// perder uma delas nunca faz o contador voltar para trás.
function maiorUso(a, b, now = Date.now()) {
  const x = usoDeHoje(a, now), y = usoDeHoje(b, now);
  return { dia: x.dia, leituras: Math.max(x.leituras, y.leituras), gravacoes: Math.max(x.gravacoes, y.gravacoes) };
}

function somarUso(uso, ciclo, now = Date.now()) {
  const base = usoDeHoje(uso, now);
  return { dia: base.dia, leituras: base.leituras + (ciclo?.leituras || 0), gravacoes: base.gravacoes + (ciclo?.gravacoes || 0) };
}

function esgotado(uso, now = Date.now()) {
  const u = usoDeHoje(uso, now);
  return u.leituras >= LIMITE.leituras || u.gravacoes >= LIMITE.gravacoes;
}

const DIA_MS = 24 * 60 * 60 * 1000;
const FOLGA_RITMO_MS = 2 * 60 * 60 * 1000;

// Fração do dia da cota já passada (0 à meia-noite do Pacífico, 1 na virada seguinte).
function fracaoDoDia(now = Date.now()) {
  const fim = proximaVirada(now);
  return Math.min(1, Math.max(0, 1 - (fim - now) / DIA_MS));
}

// Ritmo: o ciclo completo só roda se o gasto acumulado ficar dentro da parte do
// orçamento proporcional às horas já passadas (mais 2 h de folga). Assim o gasto
// se espalha pelas 24 h e a cota não acaba de madrugada deixando a noite parada.
function cabeCicloCompleto(uso, custo, now = Date.now()) {
  const u = usoDeHoje(uso, now);
  const c = { ...CUSTO_COMPLETO_PADRAO, ...(custo || {}) };
  const ritmo = Math.min(1, fracaoDoDia(now) + FOLGA_RITMO_MS / DIA_MS);
  return u.leituras + c.leituras <= LIMITE.leituras * FAIXA_COMPLETO * ritmo &&
    u.gravacoes + c.gravacoes <= LIMITE.gravacoes * FAIXA_COMPLETO * ritmo;
}

function percentual(uso, now = Date.now()) {
  const u = usoDeHoje(uso, now);
  return Math.round(100 * Math.max(u.leituras / LIMITE.leituras, u.gravacoes / LIMITE.gravacoes));
}

function resumoDoUso(uso, now = Date.now()) {
  const u = usoDeHoje(uso, now);
  const n = v => v.toLocaleString('pt-BR');
  return `Cota do sync hoje (${u.dia}, Pacífico): ${n(u.leituras)} de ${n(LIMITE.leituras)} leituras e ${n(u.gravacoes)} de ${n(LIMITE.gravacoes)} gravações (${percentual(u, now)}%).`;
}

// Conta leituras e gravações feitas por este processo no Firestore.
// Regra de cobrança: consulta = 1 leitura por documento devolvido (mínimo 1);
// documento lido = 1; cada criação/alteração/exclusão = 1 gravação.
function medirFirestore(firestoreNs) {
  const contador = { leituras: 0, gravacoes: 0 };
  const instalados = [];
  function trocar(proto, nome, embrulho) {
    const original = proto && proto[nome];
    if (typeof original !== 'function') return;
    proto[nome] = embrulho(original);
    instalados.push(() => { proto[nome] = original; });
  }
  const leiturasDe = snap => (snap && typeof snap.size === 'number') ? Math.max(1, snap.size) : 1;
  trocar(firestoreNs.Query.prototype, 'get', original => async function (...args) {
    const snap = await original.apply(this, args); contador.leituras += leiturasDe(snap); return snap;
  });
  trocar(firestoreNs.DocumentReference.prototype, 'get', original => async function (...args) {
    const snap = await original.apply(this, args); contador.leituras += 1; return snap;
  });
  trocar(firestoreNs.Transaction.prototype, 'get', original => async function (...args) {
    const snap = await original.apply(this, args); contador.leituras += leiturasDe(snap); return snap;
  });
  // No SDK, doc.set/update/create/delete e as gravações de transação passam todas
  // pelo WriteBatch: contar só aqui evita contagem dobrada. Gravação de transação
  // que não chega ao commit também conta, o que superestima: é o lado seguro.
  for (const nome of ['create', 'set', 'update', 'delete']) {
    trocar(firestoreNs.WriteBatch.prototype, nome, original => function (...args) {
      contador.gravacoes += 1; return original.apply(this, args);
    });
  }
  return { contador, desligar() { while (instalados.length) instalados.pop()(); } };
}

module.exports = { COTA_GRATIS, LIMITE, FAIXA_COMPLETO, CUSTO_COMPLETO_PADRAO, diaDaCota, proximaVirada, fracaoDoDia, usoDeHoje,
  maiorUso, somarUso, esgotado, cabeCicloCompleto, percentual, resumoDoUso, medirFirestore };
