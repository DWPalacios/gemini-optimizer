// index.d.ts
export interface CostOptimizerOptions {
  // Tipografía / layout tall-image (768xN)
  canvasW?: number;          // default 768
  pageH?: number;            // default 768 (altura por página lógica)
  marginPx?: number;         // default 0
  fontPx?: number;           // default 8
  fontFamily?: string;       // default 'Arial'
  lineHeight?: number;       // default 1.10
  letterSpacing?: number;    // default 0

  // Formato imagen
  imageFormat?: 'image/png' | 'image/jpeg' | 'image/webp'; // default 'image/png'
  jpegQuality?: number;      // default 0.92
  webpQuality?: number;      // default 92

  // Estrategia de compresión
  strategy?: 'never' | 'always' | 'auto'; // default 'auto'
  tallMaxPagesPerImage?: number;          // default 40
  languageConsistency?: boolean;          // default true

  // Depuración
  debugSaveDir?: string | null; // ej: './_debug'
  debugGenerateHTML?: boolean;  // default true
  debugFilePrefix?: string;     // default 'coimg'
  onImage?: (buf: Buffer, meta: any) => void; // callback por imagen
  printTokenStats?: boolean;    // default true
  verboseAutoLogs?: boolean;    // default true

  // Caché
  cacheImages?: boolean;        // default true
  lruSize?: number;             // default 200

  // Auto
  autoAccurateBaseline?: boolean; // default true (usa countTokens real)
}

export interface TranscribeResult {
  transcription: string;
  tokens: {
    imagesOnly: number | null;
    promptOnly: number | null;
    totalImagesPlusPrompt: number | null;
    plainText: number | null;
  };
  pagesCount: number;
  tallImages: number;
  imgMeta: any[];
}

export class CostOptimizer {
  constructor(
    GoogleGenAIClass: new (...args: any[]) => any,
    apiKeyOrAuth: string | { apiKey?: string; auth?: any },
    options?: CostOptimizerOptions
  );

  readonly models: {
    generateContent(args: {
      model: string;
      config?: any;
      contents: Array<{ role: string; parts: any[] }>;
    }): Promise<any>;

    generateContentStream(args: {
      model: string;
      config?: any;
      contents: Array<{ role: string; parts: any[] }>;
    }): Promise<any>;

    countTokens(args: {
      model: string;
      config?: any;
      contents: Array<{ role: string; parts: any[] }>;
    }): Promise<{ totalTokens: number }>;

    transcribe(args: {
      model: string;
      text: string;
      prompt?: string;
    }): Promise<TranscribeResult>;
  };
}
