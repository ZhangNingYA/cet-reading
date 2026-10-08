import type { SectionView, SentenceView } from './exam.js';

type PresentedPaper = {
  id: string;
  reference_paper_id: string | null;
  sections: SectionView[];
  sentences: SentenceView[];
};
type ReferencePaper = { id: string; title: string; variant: string; sections: SectionView[] };

function readingContent(section: SectionView) {
  return JSON.stringify({
    kind: section.kind,
    instructions: section.instructions,
    paragraphs: section.paragraphs,
    questions: section.questions.map(({ type, prompt, options }) => ({ type, prompt, options })),
  });
}

export function presentPaper<T extends PresentedPaper>(paper: T, reference: ReferencePaper | null): T {
  if (!reference || paper.reference_paper_id !== reference.id || paper.id === reference.id) return paper;
  const originals = new Set(reference.sections.map(readingContent));
  const shared = new Set(paper.sections.filter(section =>
    ['cloze', 'matching', 'reading'].includes(section.kind) && originals.has(readingContent(section)),
  ).map(section => section.id));
  if (!shared.size) return paper;
  return {
    ...paper,
    sections: paper.sections.map(section => shared.has(section.id) ? {
      ...section,
      instructions: '',
      paragraphs: [],
      questions: [],
      reference: { paperId: reference.id, title: reference.title, variant: reference.variant },
    } : section),
    sentences: paper.sentences.filter(sentence => !sentence.sectionId || !shared.has(sentence.sectionId)),
  };
}
