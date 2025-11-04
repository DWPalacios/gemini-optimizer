
<div align="center">
  <h1>🧠🖼️ @dylitan/gemini-optimizer</h1>
  <p>
    <b>Reduce Gemini prompt costs</b> by converting chat <i>history</i> into <b>tall 768×N images</b>,
    while keeping <b>system</b> and the <b>latest USER</b> as text. The <b>auto</b> mode decides using <i>real token counts</i> when it’s beneficial.
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@dylitan/gemini-optimizer">
      <img alt="npm" src="https://img.shields.io/npm/v/%40dylitan%2Fgemini-optimizer?color=%2300b894">
    </a>
    <a href="https://www.npmjs.com/package/@dylitan/gemini-optimizer">
      <img alt="downloads" src="https://img.shields.io/npm/dm/%40dylitan%2Fgemini-optimizer">
    </a>
    <img alt="node" src="https://img.shields.io/node/v/@dylitan/gemini-optimizer">
    <a href="https://github.com/dylitan/gemini-optimizer/actions">
      <img alt="ci" src="https://img.shields.io/github/actions/workflow/status/dylitan/gemini-optimizer/ci.yml?branch=main">
    </a>
    <img alt="license" src="https://img.shields.io/npm/l/%40dylitan%2Fgemini-optimizer">
  </p>
</div>

---

## ✨ What It Does

- **Saves tokens**: compresses the *previous chat history* into one or more **tall images (768×N)** using dense typography (Arial 9px, `lineHeight=1.10`).
- **Maintains accuracy**: keeps the **system instruction** and **last user message** in plain text.
- **Smart decisions**: **`auto`** mode calls `countTokens` and compares **text vs. image** (≈ **259 tok/image** for a logical 768×768 page).
- **Transcribe mode** (test): measures OCR density to validate cost and accuracy.
- **Built-in debug**: saves PNGs and an **HTML inspector** of the sanitized payload.

> Real savings depend on the chat history; typically **20–80%** for long contexts.

---

## 📦 Installation

```bash
npm i @dylitan/gemini-optimizer @google/genai
# Requires Node 18+
```

Create a `.env` file with:

```bash
GEMINI_API_KEY=your_api_key
```

---

## 🚀 Quickstart

```js
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { CostOptimizer } from '@dylitan/gemini-optimizer';

const ai = new CostOptimizer(GoogleGenAI, process.env.GEMINI_API_KEY, {
  strategy: 'auto',          // 'never' | 'always' | 'auto' (default)
  debugSaveDir: './_debug',  // optional: saves PNG + HTML inspector
});

const config = {
  generationConfig: { temperature: 0.3, maxOutputTokens: 1200 },
  systemInstruction: [{ text: 'You are AURA (B2B sales). Maintain Spanish. Do not reveal internal mechanisms.' }],
};

const contents = [
  { role: 'user',  parts: [{ text: 'Hi, what does NexaCloud do?' }] },
  { role: 'model', parts: [{ text: 'We unify data and automate processes.' }] },
  { role: 'user',  parts: [{ text: 'Give me an executive summary with phases and KPIs.' }] }, // ← last USER stays in plain text
];

const res = await ai.models.generateContent({ model: 'gemini-2.5-flash', config, contents });
console.log(res.text);
```

---

## 🧠 Strategies

* **`never`**: baseline — everything as text (no compression).
* **`always`**: always compresses history into tall 768×N images (system and last USER remain text).
* **`auto`** *(recommended)*:

  1. `countTokens` for the **full text payload** (baseline).
  2. `countTokens` for the **tail** (system + last USER as text).
  3. Estimate image cost: `pages × 259 tok` (logical pages 768×768).
  4. Choose **image** if `tail + images < baseline`, otherwise **text**.

> Optional env vars:
> `IMAGE_TOKENS_PER_IMAGE` (default **259**), `TALL_MAX_PAGES_PER_IMAGE` (default **40**).

---

## 🧾 What Is Sent to the Model

* `systemInstruction` → **text** (intact).
* **Previous history** (everything except the last USER) → **tall images** (768×N).
* **Last USER** → **plain text**.
* A **short hint** instructs the model to read images as context and reply normally.

---

## 🔍 Transcription Mode (Density Validation)

```js
const r = await ai.models.transcribe({
  model: 'gemini-2.5-flash',
  text: 'Long test text for OCR density validation...'
});

console.log('OCR:', r.transcription);
console.log('Image tokens:', r.tokens.totalImagesPlusPrompt, 'Text tokens:', r.tokens.plainText);
```

> Useful for testing **font/size/line-height** combinations and their impact on cost vs. OCR accuracy.

---

## 🧩 API

```ts
new CostOptimizer(GoogleGenAIClass, apiKeyOrAuth, options?)
```

* `GoogleGenAIClass`: usually `GoogleGenAI` from `@google/genai`.
* `apiKeyOrAuth`: string (API key) or `{ apiKey }` or `{ auth }`.
* `options`: see configuration table.

### Methods (via `models`)

```ts
await ai.models.generateContent({ model, config?, contents })
await ai.models.generateContentStream({ model, config?, contents })
await ai.models.countTokens({ model, config?, contents }) // respects transformation if applied
await ai.models.transcribe({ model, text, prompt? })      // test OCR/cost mode
```

---

## ⚙️ Options

| Option                 | Type                                          |     Default | Description                                  |
| ---------------------- | --------------------------------------------- | ----------: | -------------------------------------------- |
| `strategy`             | `'never' \| 'always' \| 'auto'`               |      `auto` | Compression policy.                          |
| `canvasW`              | `number`                                      |       `768` | Image width.                                 |
| `pageH`                | `number`                                      |       `768` | Logical page height (for page estimation).   |
| `marginPx`             | `number`                                      |         `0` | Internal margin.                             |
| `fontPx`               | `number`                                      |         `9` | Font size (Arial by default).                |
| `lineHeight`           | `number`                                      |      `1.10` | Line height.                                 |
| `letterSpacing`        | `number`                                      |         `0` | Letter spacing.                              |
| `imageFormat`          | `'image/png' \| 'image/jpeg' \| 'image/webp'` | `image/png` | Export format.                               |
| `jpegQuality`          | `number`                                      |      `0.92` | JPEG quality.                                |
| `webpQuality`          | `number`                                      |        `92` | WebP quality.                                |
| `tallMaxPagesPerImage` | `number`                                      |        `40` | Logical pages stacked per tall image.        |
| `languageConsistency`  | `boolean`                                     |      `true` | Keep the last USER language.                 |
| `debugSaveDir`         | `string \| null`                              |      `null` | Folder to save PNG + `index.html` inspector. |
| `debugGenerateHTML`    | `boolean`                                     |      `true` | Generate HTML inspector.                     |
| `onImage`              | `(buf, meta) => void`                         | `undefined` | Callback per generated image.                |
| `printTokenStats`      | `boolean`                                     |      `true` | Prints token usage/savings stats.            |
| `verboseAutoLogs`      | `boolean`                                     |      `true` | Detailed logs for `auto` mode decisions.     |
| `cacheImages`          | `boolean`                                     |      `true` | LRU cache in memory for base64 images.       |
| `lruSize`              | `number`                                      |       `200` | LRU cache size.                              |
| `autoAccurateBaseline` | `boolean`                                     |      `true` | Real `countTokens` baseline measurement.     |

---

## 🧪 Examples

See `examples/`:

* `01-basic.mjs`: minimal usage with `auto`.
* `02-auto.mjs`: compares `never` / `always` / `auto` and shows savings.
* `03-transcribe.mjs`: validates OCR and cost (text vs image).

> Run with:
>
> ```bash
> node examples/01-basic.mjs
> node examples/02-auto.mjs
> node examples/03-transcribe.mjs
> ```

---

## 🛠️ Accuracy Tips

* **Keep system and last USER as text** (the lib already does this).
* Use **PNG** for stable OCR when accuracy matters.
* Avoid excessive *letterSpacing*; dense fonts increase capacity per 768×768 block.
* For short histories, **`auto`** will skip compression (marginal or negative savings).

---

## 🔄 Short Roadmap

* **Semantic alignment heuristics** to prioritize which parts of the history to compress.
* Optional **OCR quality metric** in `generateContent` for alerts.
* Native support for **multi-turn streaming**.

---

## 🤝 Contributing

1. Fork and create a branch: `feat/your-feature`.
2. `npm i` and `npm run test`.
3. Submit a PR to `main` with a clear description.
4. To publish: create a tag `vX.Y.Z` and push — **CI** will publish to npm if `NPM_TOKEN` is configured.

---

## 🧾 License

MIT © Dylitan — see [`LICENSE`](LICENSE)

---

> **Disclaimer**: The per-image cost constant (≈ **259 tok/image 768×768**) is a **practical approximation**. Always verify with the SDK’s `countTokens` for your specific cases, formats, and model versions.