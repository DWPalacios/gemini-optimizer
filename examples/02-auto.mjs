// examples/02-auto.mjs
// Compara 'never' vs 'always' vs 'auto' con el mismo historial.
// Requiere: GEMINI_API_KEY en .env
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
// Para probar local sin publicar a npm, comenta la línea de arriba y usa:
// import { CostOptimizer } from '../src/index.js';
import { CostOptimizer } from '@dylitan/gemini-optimizer';

if (!process.env.GEMINI_API_KEY) {
  console.error('❌ Falta GEMINI_API_KEY en .env');
  process.exit(1);
}

const model = 'gemini-2.5-flash';

const config = {
  generationConfig: { temperature: 0.2, maxOutputTokens: 1000 },
  systemInstruction: [{ text: 'Eres AURA, AE B2B. Responde en español, concisa y con CTA.' }],
};

// Historial más largo para ver beneficios de compresión
const contents = [
  { role: 'user',  parts: [{ text: 'Hola, vi NexaCloud. ¿Qué hace exactamente?' }] },
  { role: 'model', parts: [{ text: 'Plataforma SaaS de analítica y automatización comercial.' }] },
  { role: 'user',  parts: [{ text: 'Tenemos 3 CRMs, 40 vendedores y 25k leads/mes. Duplicados y reportes lentos.' }] },
  { role: 'model', parts: [{ text: 'Propondría deduplicación + enrutamiento y BI acelerado en fases.' }] },
  { role: 'user',  parts: [{ text: '¿Riesgos y mitigaciones?' }] },
  { role: 'model', parts: [{ text: 'Calidad de fuentes, cambio, latencias; mitigamos con reglas, champions y staging.' }] },
  // Última solicitud del usuario (se manda siempre en texto)
  { role: 'user',  parts: [{ text: 'Dame un resumen ejecutivo Fases 1–3, KPIs por fase y un CTA para esta semana.' }] },
];

const divider = (label) => {
  console.log('\n' + '='.repeat(80));
  console.log(`> ${label}`);
  console.log('='.repeat(80));
};

try {
  // NEVER (baseline)
  divider('NEVER (baseline)');
  const aiNever = new CostOptimizer(GoogleGenAI, process.env.GEMINI_API_KEY, {
    strategy: 'never',
    printTokenStats: true,
  });
  const rNever = await aiNever.models.generateContent({ model, config, contents });
  console.log('\n--- RESPUESTA NEVER ---\n');
  console.log(rNever?.text ?? JSON.stringify(rNever, null, 2));

  // ALWAYS (siempre comprimir historial → imágenes 768×N)
  divider('ALWAYS (comprimido)');
  const aiAlways = new CostOptimizer(GoogleGenAI, process.env.GEMINI_API_KEY, {
    strategy: 'always',
    printTokenStats: true,
    debugSaveDir: './_debug_examples_always',
  });
  const rAlways = await aiAlways.models.generateContent({ model, config, contents });
  console.log('\n--- RESPUESTA ALWAYS ---\n');
  console.log(rAlways?.text ?? JSON.stringify(rAlways, null, 2));

  // AUTO (elige según tokens reales)
  divider('AUTO (decisión por tokens)');
  const aiAuto = new CostOptimizer(GoogleGenAI, process.env.GEMINI_API_KEY, {
    strategy: 'auto',
    printTokenStats: true,
    verboseAutoLogs: true,
    debugSaveDir: './_debug_examples_auto',
  });
  const rAuto = await aiAuto.models.generateContent({ model, config, contents });
  console.log('\n--- RESPUESTA AUTO ---\n');
  console.log(rAuto?.text ?? JSON.stringify(rAuto, null, 2));
} catch (err) {
  console.error('Error:', err?.message || err);
  process.exit(1);
}
