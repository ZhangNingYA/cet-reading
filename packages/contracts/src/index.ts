import { z } from 'zod';

export const TokenSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string().min(1),
  kind: z.enum(['word', 'punctuation']),
  lemma: z.string().optional(),
  pos: z.string().optional(),
  contextMeaning: z.string().optional(),
  clickable: z.boolean(),
});

export const GrammarClauseSchema = z.object({
  type: z.string().min(1),
  tokenStart: z.number().int().nonnegative(),
  tokenEnd: z.number().int().nonnegative(),
  function: z.string().optional(),
});

export const SentenceAnalysisSchema = z.object({
  translation: z.string().min(1),
  pattern: z.string().min(1),
  grammar: z.object({
    sentenceType: z.string().min(1),
    tense: z.string().optional(),
    voice: z.string().optional(),
    clauses: z.array(GrammarClauseSchema),
  }),
  tokens: z.array(TokenSchema).min(1),
  keyPoints: z.array(z.string().min(1)),
});

export type Token = z.infer<typeof TokenSchema>;
export type SentenceAnalysis = z.infer<typeof SentenceAnalysisSchema>;

