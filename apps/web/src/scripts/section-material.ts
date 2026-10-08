import type { SectionView } from '@cet-reading/contracts/exam';

type MaterialSection = Pick<SectionView, 'kind' | 'questions' | 'images'>;

export function appendSectionImages(target: HTMLElement, section: Pick<SectionView, 'images'>) {
  for (const image of section.images ?? []) {
    const node = document.createElement('img');
    node.className = 'section-image';
    node.src = image.src;
    node.alt = image.alt;
    node.loading = 'lazy';
    target.append(node);
  }
}

export function appendMaterialText(target: HTMLElement, text: string, section: MaterialSection, examLevel: string) {
  const segments = section.kind === 'translation' && examLevel === 'NEEP'
    ? section.questions.map(question => question.prompt.replace(/^\d+\.\s*/, '')) : [];
  let offset = 0;
  const ranges = segments.map(segment => ({ segment, start: text.indexOf(segment) })).filter(range => range.start >= 0).sort((a, b) => a.start - b.start);
  for (const { segment, start } of ranges) {
    target.append(document.createTextNode(text.slice(offset, start)));
    const underline = document.createElement('u');
    underline.textContent = segment;
    target.append(underline);
    offset = start + segment.length;
  }
  target.append(document.createTextNode(text.slice(offset)));
}
