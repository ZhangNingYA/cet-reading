export type ReadingSection = {
  slug: string;
  label: string;
  examLevels: readonly string[];
  paperId: string;
};

// Add a section here to create its home entry and reading library route.
export const readingSections: readonly ReadingSection[] = [
  { slug: 'cet4', label: '四级', examLevels: ['CET4'], paperId: 'demo-cet4-2026-set1' },
  { slug: 'cet6', label: '六级', examLevels: ['CET6'], paperId: 'demo-cet6-2026-set1' },
  { slug: 'postgraduate', label: '考研', examLevels: ['NEEP'], paperId: 'demo-neep-2026-set1' },
];
