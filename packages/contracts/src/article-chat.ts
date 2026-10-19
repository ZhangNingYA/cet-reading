import { z } from 'zod';

export const CHAT_QUESTION_LIMIT = 2000;
export const CHAT_ANSWER_LIMIT = 16000;
export const CHAT_HISTORY_LIMIT = 20;
export const CHAT_HISTORY_CHARACTERS = 40000;
export const CHAT_CONTEXT_LIMIT = 120000;

const identifier = z.string().trim().min(1).max(220).refine(value => !/[\u0000-\u001f]/.test(value));
export const ArticleChatTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('news'), id: identifier }).strict(),
  z.object({ kind: z.literal('paper'), id: identifier, sectionId: identifier }).strict(),
]);
export const ArticleChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(CHAT_ANSWER_LIMIT),
}).strict();
export const ArticleChatRequestSchema = z.object({
  target: ArticleChatTargetSchema,
  question: z.string().trim().min(1).max(CHAT_QUESTION_LIMIT),
  history: z.array(ArticleChatMessageSchema).max(CHAT_HISTORY_LIMIT).default([]),
}).strict().superRefine(({ history }, ctx) => {
  if (history.length % 2 || history.some((message, index) => message.role !== (index % 2 ? 'assistant' : 'user'))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'History must contain completed question and answer pairs' });
  }
  if (history.reduce((total, message) => total + message.content.length, 0) > CHAT_HISTORY_CHARACTERS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'History is too long' });
  }
});

export type ArticleChatTarget = z.infer<typeof ArticleChatTargetSchema>;
export type ArticleChatMessage = z.infer<typeof ArticleChatMessageSchema>;
export type ArticleChatRequest = z.infer<typeof ArticleChatRequestSchema>;
export type ArticleChatContext = {
  title: string;
  paragraphs: string[];
  author?: string;
  sourceName?: string;
  publishedAt?: string;
  instructions?: string;
  questions?: Array<{ prompt: string; options: Array<{ key: string; text: string }> }>;
};
export const articleChatErrors = {
  invalid_chat_request: '问题或对话内容不符合要求，请缩短后重试。',
  article_not_found: '当前文章暂时不可用，请刷新页面后重试。',
  article_too_long: '这篇文章较长，暂时无法完整载入问答。',
  chat_unavailable: '问 AI 暂时不可用，请稍后再试。',
  chat_busy: 'AI 正在回答其他问题，请稍后再试。',
  chat_timeout: '回答超时了，请重试或把问题问得更具体一些。',
  chat_failed: '回答暂时中断了，可以重试这个问题。',
  chat_incomplete: '回答未完整返回，可以重试或缩小问题范围。',
} as const;
export type ArticleChatErrorCode = keyof typeof articleChatErrors;
export type ArticleChatEvent =
  | { type: 'start' | 'ping' | 'done' }
  | { type: 'delta'; text: string }
  | { type: 'error'; error: ArticleChatErrorCode };
