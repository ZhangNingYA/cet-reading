export type ReadingSection = {
  slug: string;
  label: string;
  examLevels: readonly string[];
};

// Add a section here to create its home entry and reading library route.
export const readingSections: readonly ReadingSection[] = [
  { slug: 'cet4', label: '四级', examLevels: ['CET4'] },
  { slug: 'cet6', label: '六级', examLevels: ['CET6'] },
  { slug: 'postgraduate', label: '考研', examLevels: ['NEEP'] },
];

export const homeSections = [...readingSections, { slug: 'news', label: 'News', examLevels: ['英语资讯'] }];
