const fs = require('node:fs');
const path = require('node:path');
const cota = require('./quota.cjs');
const HOUR = 60 * 60 * 1000;
function readState(file) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' ? value : {}; }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return {}; throw error; }
}
// O controle guarda só horários e contadores: nenhum cliente, evento ou segredo.
async function runControlled({ sync, file, now = Date.now(), report = () => {} }) {
  const state = readState(file);
  const save = () => { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, JSON.stringify(state)); };
  if (Number.isFinite(state.retryAfter) && state.retryAfter > now) {
    const result = {state:'paused', retryAfter:state.retryAfter, motivo:state.motivo, uso:state.uso}; report(result); return result;
  }
  delete state.motivo;
  const uso = cota.usoDeHoje(state.uso, now);
  if (cota.esgotado(uso, now)) {
    // Orçamento do dia gasto: nenhum acesso ao Firebase até a cota zerar.
    Object.assign(state, {uso, retryAfter:cota.proximaVirada(now), motivo:'orcamento'}); save();
    const result = {state:'budget_paused', retryAfter:state.retryAfter, motivo:'orcamento', uso}; report(result); return result;
  }
  const horaDoCompleto = !Number.isFinite(state.lastFullSyncAt) || now - state.lastFullSyncAt >= HOUR;
  const fullSync = horaDoCompleto && cota.cabeCicloCompleto(uso, state.custoCompleto, now);
  try {
    const outcome = await sync({fullSync, usoAnterior:uso, custoCompleto:state.custoCompleto || null, ultimoCompleto:Number.isFinite(state.lastFullSyncAt) ? state.lastFullSyncAt : null});
    delete state.retryAfter;
    const fezCompleto = outcome?.fullSync ?? fullSync;
    if (outcome?.uso) state.uso = cota.usoDeHoje(outcome.uso, now);
    if (fezCompleto && outcome?.custoCiclo) state.custoCompleto = {leituras:outcome.custoCiclo.leituras, gravacoes:outcome.custoCiclo.gravacoes};
    if (fezCompleto && outcome?.healthy && outcome?.leituraCompleta) state.lastFullSyncAt = now;
    if (outcome?.orcamentoEsgotado || (state.uso && cota.esgotado(state.uso, now))) {
      Object.assign(state, {retryAfter:cota.proximaVirada(now), motivo:'orcamento'}); save();
      const result = {state:'budget_paused', retryAfter:state.retryAfter, motivo:'orcamento', uso:state.uso}; report(result); return result;
    }
    save();
    const economia = horaDoCompleto && !fezCompleto;
    const result = {state:outcome?.healthy ? 'completed' : 'partial', fullSync:fezCompleto, economia, uso:state.uso}; report(result); return result;
  } catch (error) {
    if (error.uso) state.uso = cota.usoDeHoje(error.uso, now);
    if (Number(error.code) !== 8) { save(); throw error; }
    // Cota real do projeto estourou (o site e o app também gastam dela).
    Object.assign(state, {retryAfter:now + HOUR, motivo:'cota'}); save();
    const result = {state:'quota_exceeded', retryAfter:state.retryAfter, motivo:'cota', uso:state.uso}; report(result); return result;
  }
}
function report(result) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `state=${result.state}\n`);
  let message;
  if (result.retryAfter && result.motivo === 'orcamento') {
    message = `Sincronização em pausa: o sync gastou o orçamento diário dele dentro da cota grátis do Firebase. Volta após ${new Date(result.retryAfter).toISOString()} (virada da cota). As pendências permanecem preservadas.`;
    console.warn(`::warning::${message}`);
  } else if (result.retryAfter) {
    message = `Sincronização NÃO concluída: Firebase sem cota disponível. Nova tentativa após ${new Date(result.retryAfter).toISOString()}. As pendências permanecem preservadas.`;
    console.warn(`::warning::${message}`);
  } else {
    message = `Ciclo ${result.fullSync ? 'com histórico completo' : 'de envio de pendências'}: ${result.state}. A importação e verificação de exclusões do Google ocorrem no ciclo completo, no máximo uma vez por hora.`;
    if (result.economia) message += ' Ciclo completo adiado para economizar a cota do dia.';
  }
  if (result.uso) message += ' ' + cota.resumoDoUso(result.uso);
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Estado da sincronização\n\n${message}\n`);
}
if (require.main === module) {
  runControlled({sync:require('./sync.js').main, file:path.join(__dirname,'.sync-control/state.json'), report})
    .catch(error => { console.error('Sincronização falhou:', error.message); process.exitCode=1; });
}
module.exports = {runControlled};
