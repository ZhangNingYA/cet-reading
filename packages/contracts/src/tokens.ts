export type SourceToken = {
  index: number;
  text: string;
  kind: 'word' | 'punctuation';
  charStart: number;
  charEnd: number;
};

// Shared by the browser and worker so word offsets always refer to the original text.
export function tokenize(source: string): SourceToken[] {
  const expression = /[A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+(?:['’][A-Za-z]+)*)*|\d+(?:[.,]\d+)*|[^\s]/gu;
  return Array.from(source.matchAll(expression), (match, index) => ({
    index,
    text: match[0],
    kind: /^[A-Za-z0-9]/.test(match[0]) ? 'word' : 'punctuation',
    charStart: match.index!,
    charEnd: match.index! + match[0].length,
  }));
}
