const fs = require('node:fs');
const path = require('node:path');
const HOUR = 60 * 60 * 1000;
function readState(file) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' ? value : {}; }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return {}; throw error; }
}
async function runControlled({ sync, file, now = Date.now(), report = () => {} }) {
  const state = readState(file);
  const save = () => { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, JSON.stringify(state)); };
  if (Number.isFinite(state.retryAfter) && state.retryAfter > now) {
    const result = {state:'paused', retryAfter:state.retryAfter}; report(result); return result;
  }
  const fullSync = !Number.isFinite(state.lastFullSyncAt) || now - state.lastFullSyncAt >= HOUR;
  try {
    const outcome = await sync({fullSync});
    delete state.retryAfter;
    if (fullSync && outcome?.healthy && outcome?.leituraCompleta) state.lastFullSyncAt = now;
    save();
    const result = {state:outcome?.healthy ? 'completed' : 'partial', fullSync}; report(result); return result;
  } catch (error) {
    if (Number(error.code) !== 8) throw error;
    state.retryAfter = now + HOUR; save();
    const result = {state:'quota_exceeded', retryAfter:state.retryAfter}; report(result); return result;
  }
}
function report(result) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `state=${result.state}\n`);
  let message;
  if (result.retryAfter) {
    message = `Sincronização NÃO concluída: Firebase sem cota disponível. Nova tentativa após ${new Date(result.retryAfter).toISOString()}. As pendências permanecem preservadas.`;
    console.warn(`::warning::${message}`);
  } else message = `Ciclo ${result.fullSync ? 'com histórico completo' : 'de envio de pendências'}: ${result.state}. A importação e verificação de exclusões do Google ocorrem no ciclo completo, no máximo uma vez por hora.`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Estado da sincronização\n\n${message}\n`);
}
if (require.main === module) {
  runControlled({sync:require('./sync.js').main, file:path.join(__dirname,'.sync-control/state.json'), report})
    .catch(error => { console.error('Sincronização falhou:', error.message); process.exitCode=1; });
}
module.exports = {runControlled};
