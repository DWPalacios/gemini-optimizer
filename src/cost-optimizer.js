// cost-optimizer.js
// Compresión de historial a imagen "tall" (768×N), con auto-decisión por costo real.
// - SystemInstruction SIEMPRE en texto
// - Último USER SIEMPRE en texto
// - Historial previo comprimido a imagen
// - Estrategia: 'never' | 'always' | 'auto' (auto usa countTokens + 259 tok/imagen por defecto)

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// IMPORT correcto para @napi-rs/canvas
import napiCanvas from '@napi-rs/canvas';
const { createCanvas, registerFont } = napiCanvas;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== ENV overrides =====
const ENV_TOKENS_PER_IMAGE = Number(process.env.IMAGE_TOKENS_PER_IMAGE ?? 259);
const ENV_TALL_MAX_PAGES_PER_IMAGE = Number(process.env.TALL_MAX_PAGES_PER_IMAGE ?? 40);

// ===== Defaults =====
const DEFAULTS = {
  // tipografía / layout (perfil transcripción / densidad)
  canvasW: 768,
  pageH: 768,
  marginPx: 0,
  fontPx: 9,
  fontFamily: 'Arial',
  lineHeight: 1.10,
  letterSpacing: 0,

  // formato (PNG ideal para OCR)
  imageFormat: 'image/png',
  jpegQuality: 0.92,
  webpQuality: 92,

  // estrategia
  strategy: 'auto', // 'never' | 'always' | 'auto'

  // tall images
  tallMaxPagesPerImage: ENV_TALL_MAX_PAGES_PER_IMAGE, // p.ej. 40 → alto máximo 40*768

  // sistema / comportamiento
  languageConsistency: true, // intenta responder en el idioma del último USER
  // logs y depuración
  debugSaveDir: null,       // ej: './_debug'
  debugGenerateHTML: true,
  debugFilePrefix: 'coimg',
  onImage: null,            // (buf, meta) => void
  printTokenStats: true,    // logs de tokens en cada llamada
  verboseAutoLogs: true,    // logs del razonamiento 'auto'

  // caché base64
  cacheImages: true,
  lruSize: 200,

  // auto (precisión del cálculo)
  autoAccurateBaseline: true, // usa countTokens para baseline y tail (2 llamadas)
};

// ===== Heurística coste imagen =====
const TOKENS_PER_IMAGE = ENV_TOKENS_PER_IMAGE; // ~259

// ===== Utils =====
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

class SimpleLRU {
  constructor(limit = 200) { this.limit = limit; this.map = new Map(); }
  get(k) { if (!this.map.has(k)) return; const v = this.map.get(k); this.map.delete(k); this.map.set(k, v); return v; }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
  }
}

function ensureDir(dir) { if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function stamp() {
  const d = new Date(), p = (n)=> String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
function saveImageDebug(buf, dir, prefix, index, tag, pageStart, pageEnd, ext) {
  const name = `${stamp()}_${prefix}_${String(index).padStart(4,'0')}_${tag}_p${String(pageStart).padStart(2,'0')}-${String(pageEnd).padStart(2,'0')}.${ext}`;
  const filepath = path.join(dir, name);
  fs.writeFileSync(filepath, buf);
  return filepath;
}

// ===== Texto: normalización y escapes =====
function literalizeNewlines(s) {
  if (!s) return '';
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\\n');
}
function escapeSeparatorsAndHeaders(s) {
  if (!s) return '';
  return s.replace(/\|/g, '¦'); // evita romper separadores de segmento
}
function sanitizeForSegments(s) {
  return escapeSeparatorsAndHeaders(literalizeNewlines(s));
}

function detectLanguageOf(text) {
  if (!text) return 'en';
  const s = text.toLowerCase();
  if (/[áéíóúñ¡¿]/.test(s) || /([\u00C0-\u017F])/.test(s)) return 'es';
  return 'en';
}
function lastUserText(contents) {
  for (let i = contents.length - 1; i >= 0; i--) {
    if (contents[i]?.role === 'user') {
      const t = (contents[i].parts || []).map(p => typeof p.text === 'string' ? p.text : '').join('\n');
      if (t?.trim()) return t;
    }
  }
  return '';
}

// ===== Transcript =====
function systemTextFromConfig(config) {
  if (!config || !config.systemInstruction) return '';
  const si = config.systemInstruction;
  if (typeof si === 'string') return si;
  if (Array.isArray(si)) return si.map(p => p?.text ?? '').join('\n\n').trim();
  if (typeof si === 'object' && si.text) return String(si.text || '');
  return '';
}

function conversationToSingleString(contents, keepLastUserTrue = true) {
  // Construye transcript de TODO lo anterior al último USER
  const segs = [];
  const lastUserIdx = (() => {
    for (let i = contents.length - 1; i >= 0; i--) if (contents[i]?.role === 'user') return i;
    return -1;
  })();

  for (let i = 0; i < contents.length; i++) {
    if (keepLastUserTrue && i === lastUserIdx) break; // no incluir el último USER
    const c = contents[i];
    const textParts = c.parts?.filter(p => typeof p?.text === 'string') ?? [];
    const otherParts = c.parts?.filter(p => !('text' in p) || p.inlineData || p.fileData) ?? [];

    let text = textParts.map(p => p.text).join('\n');
    text = sanitizeForSegments(text);

    if (otherParts.length) {
      const tags = otherParts.map(p => {
        if (p.inlineData?.mimeType) return `[ATTACH:${p.inlineData.mimeType}]`;
        if (p.fileData?.mimeType)  return `[FILE:${p.fileData.mimeType}]`;
        return `[ATTACH]`;
      }).join(' ');
      text = text ? `${text} ${tags}` : tags;
    }

    const role = (c.role || '').toUpperCase();
    let label = 'USER';
    if (role === 'USER' || role === 'MODEL' || role === 'TOOL' || role === 'FUNCTION') label = role;
    segs.push(`${label}: ${text} |`);
  }

  let final = segs.join(' ');
  if (!final.trim().endsWith('|')) final += ' |';
  return final;
}

// ===== Medidas y paginado (768×768 por página lógica) =====
function measureWithLetterSpacing(ctx, text, letterSpacing) {
  return ctx.measureText(text).width + Math.max(0, text.length - 1) * letterSpacing;
}
function wrapLines(ctx, text, maxW, letterSpacing) {
  const words = (text || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const cand = line ? line + ' ' + w : w;
    if (measureWithLetterSpacing(ctx, cand, letterSpacing) <= maxW) line = cand;
    else {
      if (line) lines.push(line);
      if (measureWithLetterSpacing(ctx, w, letterSpacing) <= maxW) line = w;
      else {
        let chunk = '';
        for (const ch of w) {
          const next = chunk + ch;
          if (measureWithLetterSpacing(ctx, next, letterSpacing) <= maxW) chunk = next;
          else { lines.push(chunk); chunk = ch; }
        }
        line = chunk;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

function paginateToPages(text, opt) {
  const o = opt;
  const tmp = createCanvas(16, 16);
  const ctx = tmp.getContext('2d');
  ctx.font = `${o.fontPx}px "${o.fontFamily}"`;

  const areaW = o.canvasW - o.marginPx * 2;
  const areaH = o.pageH - o.marginPx * 2;

  // respetar saltos de párrafo (visual)
  const paragraphs = (text || '').split(/\n+/);
  const lines = [];
  paragraphs.forEach((p, i) => {
    const linesP = wrapLines(ctx, p, areaW, o.letterSpacing);
    lines.push(...linesP);
    // en este perfil max densidad: sin gap adicional
  });

  const perPage = Math.max(1, Math.floor(areaH / (o.fontPx * o.lineHeight)));
  const pages = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  return { pages, perPage };
}

function renderTallImagesFromPages(pages, opt, debugCtx) {
  // Corta el arreglo de páginas lógicas en bloques de hasta N páginas por imagen "tall"
  const o = opt;
  const maxPerTall = Math.max(1, o.tallMaxPagesPerImage);
  const chunks = [];
  for (let i = 0; i < pages.length; i += maxPerTall) chunks.push(pages.slice(i, i + maxPerTall));

  const parts = [];
  const metaList = [];
  const ext = o.imageFormat === 'image/jpeg' ? 'jpg'
            : o.imageFormat === 'image/webp' ? 'webp'
            : 'png';

  let imgCounter = 0;

  for (let c = 0; c < chunks.length; c++) {
    const block = chunks[c];
    const tallH = block.length * o.pageH;
    const W = o.canvasW, H = tallH;

    const cnv = createCanvas(W, H);
    const ctx = cnv.getContext('2d');

    // fondo
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000000';
    ctx.font = `${o.fontPx}px "${o.fontFamily}"`;
    ctx.textBaseline = 'top';

    // dibujar página por página
    for (let p = 0; p < block.length; p++) {
      const lines = block[p];
      let y = o.marginPx + p * o.pageH;
      for (const line of lines) {
        let x = o.marginPx;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          ctx.fillText(ch, x, y);
          x += ctx.measureText(ch).width + o.letterSpacing;
        }
        y += o.fontPx * o.lineHeight;
      }
    }

    const buf = (o.imageFormat === 'image/jpeg')
      ? cnv.toBuffer('image/jpeg', { quality: o.jpegQuality })
      : (o.imageFormat === 'image/webp')
        ? cnv.toBuffer('image/webp', { quality: o.webpQuality })
        : cnv.toBuffer('image/png');

    const sha = sha1(buf);
    const b64 = buf.toString('base64');

    const part = { inlineData: { mimeType: o.imageFormat, data: b64 } };
    parts.push(part);

    const pageStart = c * maxPerTall + 1;
    const pageEnd = c * maxPerTall + block.length;
    const meta = { tag: 'hist', tallIndex: c + 1, pageStart, pageEnd, sha, bytes: buf.length, mimeType: o.imageFormat, height: H };
    metaList.push(meta);

    imgCounter++;
    if (debugCtx && o.debugSaveDir) {
      ensureDir(o.debugSaveDir);
      const fp = saveImageDebug(buf, o.debugSaveDir, o.debugFilePrefix, imgCounter, 'hist', pageStart, pageEnd, ext);
      meta.filePath = fp;
    }
    if (o.onImage && typeof o.onImage === 'function') {
      try { o.onImage(buf, meta); } catch {}
    }
  }

  return { parts, metaList, tallImages: metaList.length };
}

// ===== Conteos aproximados =====
function roughTextTokensOf(partsArr) {
  const plain = partsArr
    .map(p => (typeof p?.text === 'string' ? p.text : ''))
    .join('\n');
  return Math.ceil(plain.length / 4);
}

// ===== Decisión AUTO =====
async function decideAutoAndEstimate({ client, model, config, contents, options, cache }) {
  // baselineTok: countTokens de TODO en TEXTO
  // tailTok: countTokens de (system + último USER) en TEXTO
  // estImgTok: tallImages * TOKENS_PER_IMAGE
  // decisión: usar imagen si (tailTok + estImgTok) < baselineTok

  // 1) armar baseline payload (texto plano)
  const baselinePayload = { model, contents, config };
  let baselineTok = null;

  // 2) extraer tail (último USER + system)
  const systemStr = systemTextFromConfig(config);
  const lastUser = contents[contents.length - 1];
  const tailContents = [
    ...(systemStr?.trim() ? [{ role: 'user', parts: [{ text: systemStr }]}] : []),
    lastUser
  ].filter(Boolean);

  let tailTok = null;

  if (options.autoAccurateBaseline) {
    try {
      const rBase = await client.models.countTokens({ model, contents, /* config NO se envía en countTokens */ });
      baselineTok = rBase?.totalTokens ?? null;
    } catch { baselineTok = roughTextTokensOf(contents.flatMap(c => c.parts || [])); }

    try {
      const rTail = await client.models.countTokens({ model, contents: tailContents });
      tailTok = rTail?.totalTokens ?? null;
    } catch { tailTok = roughTextTokensOf(tailContents.flatMap(c => c.parts || [])); }
  } else {
    baselineTok = roughTextTokensOf(contents.flatMap(c => c.parts || [])) + Math.ceil(systemStr.length / 4);
    tailTok = roughTextTokensOf(tailContents.flatMap(c => c.parts || []));
  }

  // 3) construir transcript del historial (sin el último USER)
  const histString = conversationToSingleString(contents, true); // true ⇒ corta antes del último USER

  // 4) paginar y estimar imágenes "tall"
  const transProfile = {
    canvasW: options.canvasW,
    pageH: options.pageH,
    marginPx: options.marginPx,
    fontPx: options.fontPx,
    fontFamily: options.fontFamily,
    lineHeight: options.lineHeight,
    letterSpacing: options.letterSpacing,
    imageFormat: options.imageFormat,
    jpegQuality: options.jpegQuality,
    webpQuality: options.webpQuality,
    tallMaxPagesPerImage: options.tallMaxPagesPerImage,
    debugSaveDir: options.debugSaveDir,
    debugFilePrefix: options.debugFilePrefix,
  };

  const { pages } = paginateToPages(histString, transProfile);
  const pagesCount = pages.length;
  const perTall = Math.max(1, options.tallMaxPagesPerImage);
  let tallImages = Math.max(1, Math.ceil(pagesCount / perTall));
  // Fallback anti-NaN:
  if (!Number.isFinite(tallImages) || tallImages <= 0) tallImages = 1;

  const estImgTok = tallImages * TOKENS_PER_IMAGE;
  const estCompressed = (tailTok || 0) + estImgTok;

  if (options.verboseAutoLogs) {
    console.log(`[CostOptimizer:auto] baseline(text)=${baselineTok} | tail(text)=${tailTok} | pages=${pagesCount} | tallImages=${tallImages} | estImgTok=${estImgTok} | estCompressed=${estCompressed} | decision=${estCompressed < baselineTok ? 'image' : 'text'}`);
    const breakeven = estCompressed;
    console.log(`[CostOptimizer:auto] breakeven: usar imagen si baseline > ${breakeven} (imgs=${tallImages}, ${TOKENS_PER_IMAGE} tok/imagen, tail=${tailTok})`);
  }

  return {
    decision: estCompressed < baselineTok ? 'image' : 'text',
    baselineTok,
    tailTok,
    estImgTok,
    estCompressed,
    pages, // reusar
  };
}

// ===== Build payload transformado =====
function buildTransformedPayload({ model, config = {}, contents = [] }, options, debug) {
  // Mantener system en config (texto). NO lo movemos.
  const systemStr = systemTextFromConfig(config);

  // Separar último USER
  let lastIdx = -1;
  for (let i = contents.length - 1; i >= 0; i--) if (contents[i]?.role === 'user') { lastIdx = i; break; }
  if (lastIdx < 0) lastIdx = contents.length - 1; // fallback
  const lastUserMsg = contents[lastIdx];

  // Construir transcript del historial anterior al último USER
  const histString = conversationToSingleString(contents, true);

  // Render a tall image(s)
  const transProfile = {
    canvasW: options.canvasW,
    pageH: options.pageH,
    marginPx: options.marginPx,
    fontPx: options.fontPx,
    fontFamily: options.fontFamily,
    lineHeight: options.lineHeight,
    letterSpacing: options.letterSpacing,
    imageFormat: options.imageFormat,
    jpegQuality: options.jpegQuality,
    webpQuality: options.webpQuality,
    tallMaxPagesPerImage: options.tallMaxPagesPerImage,
    debugSaveDir: options.debugSaveDir,
    debugFilePrefix: options.debugFilePrefix,
  };

  const { pages } = paginateToPages(histString, transProfile);
  const { parts: histParts, metaList, tallImages } = renderTallImagesFromPages(pages, transProfile, true);

  // Minimal hint para que el modelo use bien las imágenes (en español)
  const lang = options.languageConsistency ? detectLanguageOf(lastUserText(contents)) : 'es';
  const hintText = (lang === 'es')
    ? 'Las imágenes adjuntas contienen TODO el historial previo a mi último mensaje. Úsalas como contexto y respóndeme SOLO a mi último mensaje. No repitas etiquetas de rol.'
    : 'The attached images contain ALL prior conversation before my last message. Use them as context and reply ONLY to my last user message. Do not repeat role labels.';

  const msgHist = { role: 'user', parts: [ ...histParts, { text: hintText } ] };

  // Último USER tal cual (mantenemos archivos si los hubiera)
  const msgLast = lastUserMsg;

  const newContents = [ msgHist, msgLast ];
  // Nota: systemInstruction permanece en config, no lo duplicamos en mensajes.

  return {
    payload: { model, config, contents: newContents },
    imgMeta: metaList,
    tallImages,
    pagesCount: pages.length,
  };
}

// ===== Debug HTML simple =====
function writeDebugHTML(metaList, dir) {
  if (!dir || !metaList?.length) return;
  ensureDir(dir);
  const rows = metaList.map(m => {
    const rel = m.filePath ? path.basename(m.filePath) : '(inline)';
    return `<figure><img src="${rel}" alt="hist p${m.pageStart}-${m.pageEnd}"/><figcaption>${rel}<br/><small>${m.sha} • ${m.bytes} bytes • p${m.pageStart}-${m.pageEnd}</small></figcaption></figure>`;
  }).join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>CostOptimizer Debug</title>
<style>body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;background:#0b0b0b;color:#ddd;margin:0}
header{padding:12px 16px;border-bottom:1px solid #333;background:#101010;position:sticky;top:0}
h1{font-size:16px;margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;padding:12px}
figure{margin:0;background:#111;padding:8px;border-radius:10px;border:1px solid #333}
img{width:100%;height:auto;border-radius:6px;background:#fff}
figcaption{font-size:12px;color:#aaa;margin-top:6px;word-break:break-all}
</style></head><body><header><h1>CostOptimizer — Debug</h1></header><main class="grid">${rows}</main></body></html>`;
  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
}

// ===== Cliente drop-in =====
export class CostOptimizer {
  constructor(GoogleGenAIClass, apiKeyOrAuth, options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this._cache = this.options.cacheImages ? new SimpleLRU(this.options.lruSize) : null;

    // credenciales
    let authArg;
    if (typeof apiKeyOrAuth === 'string') authArg = { apiKey: apiKeyOrAuth };
    else if (apiKeyOrAuth && typeof apiKeyOrAuth === 'object') authArg = apiKeyOrAuth;
    else authArg = {};
    const hasApiKey = !!authArg.apiKey;
    const hasAuth   = !!authArg.auth;
    if (!hasApiKey && !hasAuth) {
      throw new Error('CostOptimizer: missing credentials. Pass apiKey (string|{ apiKey }) o GoogleAuth via { auth }.');
    }
    this._client = new GoogleGenAIClass(authArg);
  }

  // ===== helpers =====
  _baselinePayload(args) {
    const { model, config, contents } = args;
    return { model, config, contents };
  }

  async _decideAndBuild(args) {
    const { model, config, contents } = args;
    const { strategy } = this.options;

    if (strategy === 'never') {
      return { decision: 'text', payload: this._baselinePayload(args), imgMeta: [], tallImages: 0, pagesCount: 0, est: null };
    }

    if (strategy === 'always') {
      const t = buildTransformedPayload({ model, config, contents }, this.options, true);
      return { decision: 'image', ...t, est: null };
    }

    // strategy === 'auto'
    const auto = await decideAutoAndEstimate({
      client: this._client,
      model, config, contents,
      options: this.options,
      cache: this._cache,
    });

    if (auto.decision === 'image') {
      const t = buildTransformedPayload({ model, config, contents }, this.options, true);
      return { decision: 'image', ...t, est: auto };
    } else {
      return { decision: 'text', payload: this._baselinePayload(args), imgMeta: [], tallImages: 0, pagesCount: 0, est: auto };
    }
  }

  async _countAllTokens({ model, baselinePayload, finalPayload }) {
    let baseTok = null, finalTok = null;
    try {
      const r = await this._client.models.countTokens({ model, contents: baselinePayload.contents });
      baseTok = r?.totalTokens ?? null;
    } catch {}
    try {
      const r2 = await this._client.models.countTokens({ model, contents: finalPayload.contents });
      finalTok = r2?.totalTokens ?? null;
    } catch {}
    return { baseTok, finalTok };
  }

  // ===== API =====
  get models() {
    const self = this;
    return {
      async generateContent(args) {
        const { model, config, contents } = args;
        const decisionObj = await self._decideAndBuild(args);
        const finalPayload = decisionObj.payload;

        // Conteo de tokens (siempre que sea posible)
        let baseTok = null, finalTok = null, savings = null;
        try {
          const tokens = await self._countAllTokens({
            model,
            baselinePayload: self._baselinePayload(args),
            finalPayload,
          });
          baseTok = tokens.baseTok;
          finalTok = tokens.finalTok;
          if (Number.isFinite(baseTok) && Number.isFinite(finalTok)) {
            savings = (1 - (finalTok / Math.max(1, baseTok))) * 100;
          }
        } catch {}

        // Logs
        if (self.options.printTokenStats) {
          const tag = decisionObj.decision === 'image' ? 'image' : 'text';
          console.log(`[CostOptimizer] Tokens texto (baseline): ${baseTok ?? '(?)'}`);
          console.log(`[CostOptimizer] Tokens final (${tag}): ${finalTok ?? '(?)'}`);
          if (savings !== null) console.log(`[CostOptimizer] Ahorro estimado: ${savings.toFixed(2)}%`);
        }

        // Debug HTML
        if (self.options.debugSaveDir && decisionObj.imgMeta?.length) {
          writeDebugHTML(decisionObj.imgMeta, self.options.debugSaveDir);
          if (self.options.printTokenStats) {
            console.log(`[CostOptimizer] Imágenes tall generadas: ${decisionObj.tallImages}`);
            decisionObj.imgMeta.forEach((m, i) => {
              console.log(`  - Img#${i+1}: páginas ${m.pageStart}-${m.pageEnd}, alto ≈ ${m.height}px, bytes=${m.bytes}`);
            });
          }
        }

        // Llamada real
        return await self._client.models.generateContent(finalPayload);
      },

      async generateContentStream(args) {
        const decisionObj = await self._decideAndBuild(args);
        const finalPayload = decisionObj.payload;

        // (opc) logs básicos
        if (self.options.printTokenStats) {
          console.log(`[CostOptimizer] Strategy=${self.options.strategy} ⇒ decision=${decisionObj.decision}`);
        }
        if (self.options.debugSaveDir && decisionObj.imgMeta?.length) {
          writeDebugHTML(decisionObj.imgMeta, self.options.debugSaveDir);
        }

        return await self._client.models.generateContentStream(finalPayload);
      },

      async countTokens(args) {
        // countTokens NO acepta config (como objeto grande), sólo { model, contents }
        const { model, contents } = args;
        // Para coherencia con la librería, aplicamos transformación solo si strategy !== 'never'
        let finalContents;
        if (self.options.strategy === 'never') {
          finalContents = contents;
        } else if (self.options.strategy === 'always') {
          const t = buildTransformedPayload(args, self.options, false);
          finalContents = t.payload.contents;
        } else {
          // auto: estimamos y aplicamos la decisión
          const auto = await decideAutoAndEstimate({
            client: self._client, model, config: args.config, contents,
            options: self.options, cache: self._cache,
          });
          if (auto.decision === 'image') {
            const t = buildTransformedPayload(args, self.options, false);
            finalContents = t.payload.contents;
          } else {
            finalContents = contents;
          }
        }
        return await self._client.models.countTokens({ model, contents: finalContents });
      },

      // ===== modo transcripción para validar densidad/ahorro =====
      async transcribe({ model, text, prompt = 'Transcribe EXACTAMENTE el texto de TODAS las imágenes adjuntas, en orden y sin separadores. Devuelve solo texto plano concatenado.' }) {
        const o = self.options;
        const transProfile = {
          canvasW: o.canvasW, pageH: o.pageH, marginPx: o.marginPx,
          fontPx: o.fontPx, fontFamily: o.fontFamily,
          lineHeight: o.lineHeight, letterSpacing: o.letterSpacing,
          imageFormat: o.imageFormat, jpegQuality: o.jpegQuality, webpQuality: o.webpQuality,
          tallMaxPagesPerImage: o.tallMaxPagesPerImage, debugSaveDir: o.debugSaveDir, debugFilePrefix: o.debugFilePrefix,
        };

        const histString = sanitizeForSegments(text || '');
        const { pages } = paginateToPages(histString, transProfile);
        const { parts, metaList, tallImages } = renderTallImagesFromPages(pages, transProfile, true);

        // Conteos (imagen vs texto)
        const imagesOnlyTok = (await self._client.models.countTokens({ model, contents: [{ role: 'user', parts }] }))?.totalTokens ?? null;
        const promptOnlyTok = (await self._client.models.countTokens({ model, contents: [{ role: 'user', parts: [{ text: prompt }] }] }))?.totalTokens ?? null;
        const totalImgTok = (await self._client.models.countTokens({ model, contents: [{ role: 'user', parts: [...parts, { text: prompt }] }] }))?.totalTokens ?? null;
        const plainTok = (await self._client.models.countTokens({ model, contents: [{ role: 'user', parts: [{ text }] }] }))?.totalTokens ?? null;

        const response = await self._client.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [...parts, { text: prompt }] }],
          config: { temperature: 0, topP: 0.1, topK: 1, thinkingConfig: { thinkingBudget: 0 } },
        });

        if (o.debugSaveDir && metaList?.length) writeDebugHTML(metaList, o.debugSaveDir);

        return {
          transcription: response?.text ?? '',
          tokens: {
            imagesOnly: imagesOnlyTok,
            promptOnly: promptOnlyTok,
            totalImagesPlusPrompt: totalImgTok,
            plainText: plainTok,
          },
          pagesCount: pages.length,
          tallImages,
          imgMeta: metaList,
        };
      },
    };
  }
}
