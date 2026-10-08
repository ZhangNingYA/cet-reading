import { tokenize } from '@cet-reading/contracts';

export const source = 'People attribute success to hard work.';
export const tokens = tokenize(source);
export function raw(vocabulary = []) {
  return {
    translation: '人们把成功归因于努力。',
    pattern: 'attribute A to B',
    grammar: {
      sentenceType: '简单句', tense: '一般现在时', voice: '主动语态',
      clauses: [{ tokenStart: 0, tokenEnd: tokens.length, type: '主句', explanation: 'People attribute success to hard work 表达人们把成功归因于努力，attribute 连接归因对象与原因。' }],
      components: [
        { tokenStart: 0, tokenEnd: 1, role: 'subject', explanation: 'People 是主语，表示做出归因判断的人们。' },
        { tokenStart: 1, tokenEnd: 2, role: 'predicate', explanation: 'attribute 是一般现在时谓语，表示把某事归因于某原因。' },
        { tokenStart: 2, tokenEnd: 3, role: 'object', explanation: 'success 是 attribute 的宾语，表示被解释的成功。' },
        { tokenStart: 3, tokenEnd: 6, role: 'modifier', explanation: 'to hard work 表明成功被归因的原因，hard 修饰 work。' },
      ],
    },
    words: tokens.filter(token => token.kind === 'word').map(token => ({
      index: token.index, lemma: token.text.toLowerCase(), pos: 'n.', contextMeaning: '语境词义',
    })),
    vocabulary,
    keyPoints: ['把某事归因于某原因。'],
  };
}
