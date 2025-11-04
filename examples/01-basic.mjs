// examples/01-basic.mjs
// Uso mínimo: strategy 'auto' y respuesta de texto.
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

const ai = new CostOptimizer(GoogleGenAI, process.env.GEMINI_API_KEY, {
  strategy: 'auto',
  debugSaveDir: './_debug_examples_basic', // opcional: guarda PNG y HTML
  printTokenStats: true,
  verboseAutoLogs: true,
});

const config = {
  generationConfig: { temperature: 0.3, maxOutputTokens: 900 },
  systemInstruction: [
    { text: 'Eres “AURA”, una AE B2B. Mantén español, tono claro y enfocado a ROI.' },
  ],
};

// Historial pequeño + última pregunta
const contents = [
  { role: 'user', parts: [{ text: 'Hola, ¿qué hace NexaCloud?' }] },
  { role: 'model', parts: [{ text: 'Unificamos datos y automatizamos operaciones comerciales.' }] },
  { role: 'user', parts: [{ text: 'Dame un resumen ejecutivo con fases y KPIs, y un CTA claro.' }] },
];

try {
  console.log('\n=== 01-basic (auto) ===\n');
  const res = await ai.models.generateContent({ model, config, contents });
  console.log('\n--- OUTPUT ---\n');
  console.log(res?.text ?? JSON.stringify(res, null, 2));
} catch (err) {
  console.error('Error:', err?.message || err);
  process.exit(1);
}
