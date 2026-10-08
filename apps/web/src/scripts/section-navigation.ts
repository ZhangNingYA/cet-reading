type Section = { id: string; title: string; kind: string };

export function createSectionNavigation<T extends Section>(sections: T[], onSelect: (section: T) => void, label: string, examLevel?: string) {
  const navigation = document.createElement('nav');
  navigation.className = 'study-navigation';
  navigation.setAttribute('aria-label', label);
  const buttons = new Map<string, HTMLButtonElement>();
  const sectionNames: Record<string, string> = { writing: '写作', cloze: '选词填空', matching: '长篇阅读', translation: '翻译' };
  let readingNumber = 0;

  function selectSection(id: string) {
    const section = sections.find(section => section.id === id);
    if (!section) return;
    for (const [sectionId, button] of buttons) button.setAttribute('aria-current', sectionId === id ? 'page' : 'false');
    onSelect(section);
  }

  for (const section of sections) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'study-section-link';
    button.dataset.sectionId = section.id;
    button.textContent = section.kind === 'reading' ? `阅读 ${++readingNumber}` : examLevel === 'NEEP' ? section.title : sectionNames[section.kind] ?? section.title;
    button.addEventListener('click', () => selectSection(section.id));
    buttons.set(section.id, button);
    navigation.append(button);
  }
  return { navigation, selectSection };
}
