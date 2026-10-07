import { createHash } from 'node:crypto';
import { z } from 'zod';
import { tokenize } from './tokens.js';
export { tokenize } from './tokens.js';

export const BaseTokenSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string().min(1),
  kind: z.enum(['word', 'punctuation']),
  charStart: z.number().int().nonnegative(),
  charEnd: z.number().int().positive(),
});

export const TokenSchema = BaseTokenSchema.extend({
  lemma: z.string().optional(),
  pos: z.string().optional(),
  contextMeaning: z.string().optional(),
}).strict();

const RangeSchema = z.object({
  tokenStart: z.number().int().nonnegative(),
  tokenEnd: z.number().int().positive(),
  explanation: z.string().min(1),
});

const FinalGrammarSchema = z.object({
  sentenceType: z.string().min(1),
  tense: z.string().min(1),
  voice: z.string().min(1),
  clauses: z.array(RangeSchema.extend({ type: z.string().min(1) }).strict()).min(1),
  components: z.array(RangeSchema.extend({
    role: z.enum(['subject', 'predicate', 'object', 'complement', 'modifier', 'connector']),
  }).strict()).min(1),
}).strict();

export const AIWordSchema = z.object({
  index: z.number().int().nonnegative(),
  lemma: z.string().min(1),
  pos: z.string().min(1),
  contextMeaning: z.string().min(1),
}).strict();

export const VocabularyItemSchema = z.object({
  kind: z.enum(['word', 'phrase']),
  expression: z.string().min(1).max(160),
  meaning: z.string().min(1).max(300),
  usage: z.string().min(1).max(300),
  ranges: z.array(z.object({
    tokenStart: z.number().int().nonnegative(),
    tokenEnd: z.number().int().positive(),
  }).strict()).min(1).max(3),
}).strict();

export const AIAnalysisSchema = z.object({
  translation: z.string().min(1),
  pattern: z.string().min(1),
  grammar: z.object({
    sentenceType: z.string().min(1),
    tense: z.string().min(1),
    voice: z.string().min(1),
    clauses: z.array(RangeSchema.extend({ type: z.string().min(1) }).strict()),
    components: z.array(RangeSchema.extend({ role: z.string().min(1) }).strict()),
  }).strict(),
  words: z.array(AIWordSchema).min(1),
  vocabulary: z.array(VocabularyItemSchema).max(6),
  keyPoints: z.array(z.string().min(1)).min(1),
}).strict();

export const SentenceAnalysisSchema = z.object({
  translation: z.string().min(1),
  pattern: z.string().min(1),
  grammar: FinalGrammarSchema,
  tokens: z.array(TokenSchema).min(1),
  vocabulary: z.array(VocabularyItemSchema).max(6).optional(),
  keyPoints: z.array(z.string().min(1)).min(1),
}).strict();

export type BaseToken = z.infer<typeof BaseTokenSchema>;
export type Token = z.infer<typeof TokenSchema>;
export type AIAnalysis = z.infer<typeof AIAnalysisSchema>;
export type SentenceAnalysis = z.infer<typeof SentenceAnalysisSchema>;
export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type AnalysisMode = 'demo' | 'ai';

export function sourceHash(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

export function contextHash(context: { title: string; previousSentence: string | null; nextSentence: string | null }): string {
  return sourceHash(JSON.stringify(context));
}

function ensureChineseTranslation(translation: string, source: string) {
  if ((translation.match(/\p{Script=Han}/gu) ?? []).length < 2 ||
      /MYMEMORY|AVAILABLE FREE TRANSLATIONS|\b(?:undefined|null)\b|^\s*(?:ERROR|WARNING)\s*:/i.test(translation) ||
      translation.includes(source)) {
    throw new Error('Translation is an error message or untranslated source');
  }
}

function ensureVocabularyRanges(tokens: BaseToken[], vocabulary: z.infer<typeof VocabularyItemSchema>[] = []) {
  for (const item of vocabulary) {
    let previousEnd = -1;
    let wordCount = 0;
    for (const range of item.ranges) {
      if (range.tokenStart >= range.tokenEnd || range.tokenEnd > tokens.length || range.tokenStart < previousEnd) {
        throw new Error('Vocabulary ranges must be ordered, non-overlapping and inside the source');
      }
      wordCount += tokens.slice(range.tokenStart, range.tokenEnd).filter(token => token.kind === 'word').length;
      previousEnd = range.tokenEnd;
    }
    if (item.kind === 'word' ? wordCount !== 1 : wordCount < 2) {
      throw new Error('Vocabulary must match one source word or a phrase of at least two words');
    }
  }
}

export function buildAnalysis(source: string, raw: unknown): SentenceAnalysis {
  const ai = AIAnalysisSchema.parse(raw);
  const baseTokens = tokenize(source);
  const words = new Map(ai.words.map((word) => [word.index, word]));
  const tokens = baseTokens.map((token) => {
    if (token.kind === 'punctuation') return token;
    const word = words.get(token.index);
    if (!word) throw new Error(`AI did not explain word token ${token.index}`);
    return { ...token, lemma: word.lemma, pos: word.pos, contextMeaning: word.contextMeaning };
  });
  if (words.size !== baseTokens.filter((token) => token.kind === 'word').length) {
    throw new Error('AI word explanations do not match the source word count');
  }
  const normaliseRole = (role: string) => {
    const value = role.trim().toLowerCase().replaceAll('_', ' ');
    if (value.includes('subject') || value.includes('主语')) return 'subject' as const;
    if (value.includes('predicate') || value.includes('谓语')) return 'predicate' as const;
    if (value.includes('object complement') || value.includes('object-complement') || value.includes('宾语补足')) return 'complement' as const;
    if (value.includes('object') || value.includes('宾语')) return 'object' as const;
    if (value.includes('complement') || value.includes('补语') || value.includes('表语')) return 'complement' as const;
    if (value.includes('connector') || value.includes('连接')) return 'connector' as const;
    return 'modifier' as const;
  };
  const clauses = ai.grammar.clauses.length > 0
    ? ai.grammar.clauses
    : [{ tokenStart: 0, tokenEnd: baseTokens.length, type: '主句', explanation: '句子主要成分' }];
  const components = ai.grammar.components.length > 0
    ? ai.grammar.components.map((component) => ({ ...component, role: normaliseRole(component.role) }))
    : [{ tokenStart: 0, tokenEnd: baseTokens.length, role: 'predicate' as const, explanation: '句子主干' }];
  for (const range of [...clauses, ...components]) {
    if (range.tokenStart >= range.tokenEnd || range.tokenEnd > baseTokens.length) {
      throw new Error('Grammar range is outside the source');
    }
  }
  ensureChineseTranslation(ai.translation, source);
  ensureVocabularyRanges(baseTokens, ai.vocabulary);
  return SentenceAnalysisSchema.parse({
    translation: ai.translation,
    pattern: ai.pattern,
    grammar: { ...ai.grammar, clauses, components },
    tokens,
    vocabulary: ai.vocabulary,
    keyPoints: ai.keyPoints,
  });
}

export function validateAnalysis(source: string, value: unknown): SentenceAnalysis {
  const analysis = SentenceAnalysisSchema.parse(value);
  const expected = tokenize(source);
  if (analysis.tokens.length !== expected.length) throw new Error('Token count does not match the source');
  for (const [index, token] of analysis.tokens.entries()) {
    const base = expected[index]!;
    for (const field of ['index', 'text', 'kind', 'charStart', 'charEnd'] as const) {
      if (token[field] !== base[field]) throw new Error(`Token ${index} does not match the source`);
    }
  }
  ensureChineseTranslation(analysis.translation, source);
  ensureVocabularyRanges(expected, analysis.vocabulary);
  return analysis;
}

export * from './exam.js';
