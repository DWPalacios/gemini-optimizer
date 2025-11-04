// examples/03-transcribe.mjs
// Valida densidad OCR y costo comparando texto vs imagen.
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
  strategy: 'always',               // en transcribe siempre será imagen
  debugSaveDir: './_debug_examples_transcribe',
  printTokenStats: false,           // ya imprimimos nuestros propios cálculos
});

const text =
`La rapidez con la que deduplicamos y enrutamos leads impacta el SLA de asignación (<15min).
Fase 1: calidad de datos + enrutamiento. Fase 2: BI acelerado. Fase 3: orquestación.
Riesgos: calidad de fuentes, resistencia al cambio, latencias. Mitigación: reglas, champions, staging/monitor.`;

try {
  console.log('\n=== 03-transcribe (validación OCR y costo) ===\n');
  const r = await ai.models.transcribe({ model, text });

  const imgTok  = r.tokens.totalImagesPlusPrompt ?? 0;
  const txtTok  = r.tokens.plainText ?? 0;
  const ratio   = txtTok > 0 ? (imgTok / txtTok) : null;
  const savings = ratio !== null ? (1 - ratio) * 100 : null;

  console.log('--- TRANSCRIPCIÓN ---\n');
  console.log(r.transcription || '(sin texto)');

  console.log('\n--- TOKENS ---');
  console.log('Imagen (solo img):       ', r.tokens.imagesOnly);
  console.log('Imagen + prompt:         ', r.tokens.totalImagesPlusPrompt);
  console.log('Texto (plain):           ', r.tokens.plainText);
  console.log('Páginas lógicas (768×768):', r.pagesCount, '| Imágenes altas:', r.tallImages);

  console.log('\n--- AHORRO ESTIMADO ---');
  if (savings === null) console.log('No se pudo calcular (plainText no disponible)');
  else console.log(`Reducción aproximada vs texto: ${savings.toFixed(2)}%`);

  // Meta de imágenes generadas (por si quieres inspeccionar)
  if (r.imgMeta?.length) {
    console.log('\n--- IMÁGENES ---');
    for (const m of r.imgMeta) {
      console.log(`  - tag=${m.tag} pageNo=${m.pageNo} bytes=${m.bytes} sha=${m.sha.slice(0,8)}...`);
    }
  }

  console.log('\nListo. Revisa ./_debug_examples_transcribe para PNG + HTML.');
} catch (err) {
  console.error('Error:', err?.message || err);
  process.exit(1);
}
