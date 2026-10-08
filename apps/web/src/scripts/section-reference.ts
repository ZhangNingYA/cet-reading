import type { SectionReference, StudyMode } from '@cet-reading/contracts/exam';

export function createSharedSectionNotice(reference: SectionReference, mode: StudyMode) {
  const notice = document.createElement('p');
  notice.className = 'shared-reading-notice';
  notice.append(document.createTextNode(`本节与${reference.title}相同，不重复展示。 `));
  const link = document.createElement('a');
  const url = new URL(window.location.href);
  url.search = new URLSearchParams({ paper: reference.paperId, mode }).toString();
  link.href = `${url.pathname}${url.search}`;
  link.textContent = `查看${reference.variant || '原卷'}`;
  notice.append(link);
  return notice;
}
