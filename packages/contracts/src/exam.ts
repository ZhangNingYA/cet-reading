import { z } from 'zod';

export const StudyModeSchema = z.enum(['intensive', 'practice']);
export const SectionKindSchema = z.enum(['reading', 'cloze', 'matching', 'translation', 'writing']);
const Identifier = z.string().min(1).max(160).regex(/^[a-z0-9-]+$/);
export const OptionSchema = z.object({ key: z.string().min(1).max(4), text: z.string().min(1) }).strict();
export const QuestionSchema = z.object({
  id: Identifier,
  type: z.enum(['choice', 'text']),
  prompt: z.string().min(1),
  options: z.array(OptionSchema).max(26).default([]),
  answer: z.string().nullable().default(null),
  explanation: z.string().default(''),
  points: z.number().int().positive().max(100).default(1),
}).strict().superRefine((question, context) => {
  const keys = question.options.map((option) => option.key);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', message: 'Option keys must be unique' });
  if (question.type === 'choice' && (keys.length < 2 || !question.answer || !keys.includes(question.answer))) {
    context.addIssue({ code: 'custom', message: 'A choice question needs options and a matching standard answer' });
  }
  if (question.type === 'text' && keys.length) context.addIssue({ code: 'custom', message: 'Text questions cannot have options' });
});
export const PaperSectionSchema = z.object({
  id: Identifier,
  kind: SectionKindSchema,
  title: z.string().min(1),
  instructions: z.string().default(''),
  paragraphs: z.array(z.string().min(1)).default([]),
  study_paragraphs: z.array(z.string().min(1)).default([]),
  questions: z.array(QuestionSchema).default([]),
}).strict();
export const ImportPaperSchema = z.object({
  id: Identifier,
  exam_level: z.enum(['CET4', 'CET6', 'NEEP']),
  year: z.number().int().min(1990).max(2100),
  month: z.number().int().min(1).max(12),
  set_no: z.number().int().positive(),
  variant: z.string().max(40).default(''),
  title: z.string().min(1),
  is_demo: z.boolean().default(false),
  content_state: z.enum(['local', 'external']),
  content_kind: z.enum(['original', 'external', 'demo']).default('original'),
  description: z.string().default(''),
  reference_paper_id: Identifier.nullable().default(null),
  source_url: z.string().url().nullable().default(null),
  sections: z.array(PaperSectionSchema).default([]),
}).strict().superRefine((paper, context) => {
  if (paper.content_state === 'external' && (!paper.source_url || paper.sections.length)) {
    context.addIssue({ code: 'custom', message: 'External papers contain a source link and no hosted content' });
  }
  if (paper.source_url && new URL(paper.source_url).protocol !== 'https:') {
    context.addIssue({ code: 'custom', message: 'Source links must use HTTPS' });
  }
  if (paper.content_state === 'local' && !paper.sections.length) {
    context.addIssue({ code: 'custom', message: 'Local papers need at least one non-listening section' });
  }
  const identifiers = paper.sections.flatMap((section) => [section.id, ...section.questions.map((question) => question.id)]);
  if (new Set(identifiers).size !== identifiers.length) context.addIssue({ code: 'custom', message: 'Section and question IDs must be unique' });
});
export const AnswersSchema = z.record(z.string().max(12000)).superRefine((answers, context) => {
  if (Object.keys(answers).length > 300) context.addIssue({ code: 'custom', message: 'Too many answers' });
});

export type StudyMode = z.infer<typeof StudyModeSchema>;
export type ImportedPaper = z.infer<typeof ImportPaperSchema>;
export type ExamQuestion = z.infer<typeof QuestionSchema>;
export type QuestionView = Omit<ExamQuestion, 'answer' | 'explanation'>;
export type Answers = z.infer<typeof AnswersSchema>;
export type PaperSummary = Omit<ImportedPaper, 'sections'>;
export type SentenceView = { id: string; paragraphIndex: number; sentenceIndex: number; source: string; sectionId: string | null };
export type SectionView = Omit<z.infer<typeof PaperSectionSchema>, 'questions' | 'study_paragraphs'> & { questions: QuestionView[] };
export type PaperView = PaperSummary & { mode: StudyMode; sections: SectionView[]; sentences: SentenceView[] };
export type QuestionResult = {
  id: string; answer: string; correctAnswer: string | null; explanation: string;
  status: 'correct' | 'incorrect' | 'unanswered' | 'manual'; points: number; earned: number | null;
};
export type PracticeResult = { objectiveScore: number; objectiveTotal: number; correctCount: number; objectiveCount: number; manualCount: number; questions: QuestionResult[] };
export type AttemptView = {
  id: string;
  paperId: string;
  status: 'draft' | 'submitted';
  answers: Answers;
  result: PracticeResult | null;
  questions: QuestionView[];
};
