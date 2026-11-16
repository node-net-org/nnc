/**
 * The lexer and argument parsing (docs/cli.md §6.1, §12 unit tests).
 */
import { describe, expect, it } from 'vitest';
import { incomplete, lex } from '../src/lexer.js';
import { parseArgs, type Command } from '../src/commands/registry.js';

const words = (line: string): string[] => lex(line).words.map((w) => w.text);

describe('lexer', () => {
  it('splits words on whitespace', () => {
    expect(words('  connect   router1 ')).toEqual(['connect', 'router1']);
  });

  it("handles '…', \"…\" and \\ escapes", () => {
    expect(words(`device cli --command "show version"`)).toEqual(['device', 'cli', '--command', 'show version']);
    expect(words(`a 'b "c" d' e\\ f "g\\"h"`)).toEqual(['a', 'b "c" d', 'e f', 'g"h']);
    expect(words(`x'y'"z"`)).toEqual(['xyz']);
    // Inside [...], quotes are part of the word: YANG paths and XPath predicates need no extra quoting.
    expect(words(`read /if:interfaces/interface[name="eth 0"]/mtu --json`)).toEqual(['read', '/if:interfaces/interface[name="eth 0"]/mtu', '--json']);
    expect(words(`x[a='1'][b="2"] "[c]"`)).toEqual([`x[a='1'][b="2"]`, '[c]']);
    expect(() => lex('read /a[b="c]')).toThrow(/unterminated " starting at/);
  });

  it('keeps a (…) that closes on the line as it is: a named path\'s arguments', () => {
    expect(words(`read @route(0.0.0.0/0, 192.0.2.254) --json`)).toEqual(['read', '@route(0.0.0.0/0, 192.0.2.254)', '--json']);
    expect(words(`value @d(name="a b", note='x)y')`)).toEqual(['value', `@d(name="a b", note='x)y')`]);
    expect(words(`a(b(c) d) e`)).toEqual(['a(b(c) d)', 'e']);
    // Unclosed: lexed as before.
    expect(words(`say :( "hi there"`)).toEqual(['say', ':(', 'hi there']);
    expect(words(`a( b`)).toEqual(['a(', 'b']);
  });

  it('treats # at the start of a word as a comment, but not inside quotes or words', () => {
    expect(words('status # what is open')).toEqual(['status']);
    expect(words(`a '#b' c#d`)).toEqual(['a', '#b', 'c#d']);
  });

  it('reads a trailing > path as a redirect', () => {
    expect(lex('hello --raw > hello.xml')).toEqual({
      words: [
        { text: 'hello', literal: false },
        { text: '--raw', literal: false },
      ],
      redirect: { path: 'hello.xml', append: false },
    });
    expect(lex('hello >> log.xml').redirect).toEqual({ path: 'log.xml', append: true });
    expect(lex(`echo '>' x`).redirect).toBeUndefined();
  });

  it('rejects unterminated quotes and misplaced >', () => {
    expect(() => lex(`a 'b`)).toThrow("unterminated ' starting at column 3");
    expect(() => lex(`a "b`)).toThrow('unterminated " starting at column 3');
    expect(() => lex('a > b c')).toThrow('> must be followed by exactly one path');
    expect(() => lex('a >b')).toThrow('put a space after >');
  });
});

describe('inline JSON', () => {
  it('ends where its braces balance, so options and a redirect may follow', () => {
    expect(lex('edit-config running {"ex:sys": {"host": "a b", "dns": ["x"]}} --json > out.json')).toEqual({
      words: [
        { text: 'edit-config', literal: false },
        { text: 'running', literal: false },
        { text: '{"ex:sys": {"host": "a b", "dns": ["x"]}}', literal: true },
        { text: '--json', literal: false },
      ],
      redirect: { path: 'out.json', append: false },
    });
  });

  it('treats braces, quotes, # and > inside JSON strings as JSON', () => {
    const json = '{"a": "} # > \\" {", "b": [1, {"c": null}]}';
    expect(words(`edit-config running ${json}`)).toEqual(['edit-config', 'running', json]);
  });

  it('may span lines: open JSON is incomplete until it balances', () => {
    expect(incomplete('edit-config running {"ex:sys": {')).toBe(true);
    expect(incomplete('edit-config running {"ex:sys": {\n"host": "a"}}')).toBe(false);
    expect(words('edit-config running {"ex:sys": {\n"host": "a"}}')).toEqual(['edit-config', 'running', '{"ex:sys": {\n"host": "a"}}']);
  });
});

describe('inline XML', () => {
  it('ends where its elements balance, so options and a redirect may follow', () => {
    expect(lex('rpc <get/> --json > out.xml')).toEqual({
      words: [
        { text: 'rpc', literal: false },
        { text: '<get/>', literal: true },
        { text: '--json', literal: false },
      ],
      redirect: { path: 'out.xml', append: false },
    });
  });

  it('keeps elements separated by spaces as one word (subtree filters)', () => {
    expect(words('get --filter subtree <a/> <b x="1"/>   --json')).toEqual(['get', '--filter', 'subtree', '<a/> <b x="1"/>', '--json']);
  });

  it("treats quotes, # and > inside the XML as XML, including '>' in attribute values", () => {
    const xml = `<c a='x>y' b="#1">it's > "this" # not a comment</c>`;
    expect(words(`rpc ${xml}`)).toEqual(['rpc', xml]);
  });

  it('skips comments, CDATA, processing instructions and DOCTYPE when balancing', () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE x [<!ELEMENT x ANY>]><x><!-- </x> --><![CDATA[</x>]]></x>';
    expect(words(`rpc ${xml} --json`)).toEqual(['rpc', xml, '--json']);
  });

  it('is incomplete until it balances, over several lines', () => {
    expect(incomplete('edit-config candidate <config>')).toBe(true);
    expect(incomplete('edit-config candidate <config>\n  <a>1</a>')).toBe(true);
    expect(incomplete('edit-config candidate <config>\n  <a>1</a>\n</config>')).toBe(false);
    expect(incomplete('rpc <get/>')).toBe(false);
    expect(incomplete('status')).toBe(false);
    expect(incomplete("rpc <a b='>")).toBe(true);
    expect(words('edit-config candidate <config>\n  <a>1</a>\n</config> > r.xml')).toEqual([
      'edit-config',
      'candidate',
      '<config>\n  <a>1</a>\n</config>',
    ]);
  });

  it('runs to the end of the text when no more input is coming, for the parser to report', () => {
    expect(words('rpc <get><filter></get>')).toEqual(['rpc', '<get><filter></get>']);
  });

  it('says where an unterminated quote started in a multi-line command', () => {
    expect(() => lex(`rpc <a>\n</a> --x 'y`)).toThrow("unterminated ' starting at line 2, column 10");
  });
});

describe('parseArgs', () => {
  const cmd: Command = {
    name: 'demo',
    group: 'nnc',
    summary: '',
    args: [{ name: 'first', description: '' }, { name: 'second', description: '', optional: true }],
    options: { flag: { type: 'boolean', description: '' }, value: { type: 'string', description: '', value: '<v>' } },
    kinds: ['none'],
    run: () => Promise.resolve(undefined),
  };
  const parse = (line: string) => parseArgs(cmd, lex(line).words);

  it('separates positional arguments and options', () => {
    expect(parse('a --flag --value 3 b')).toEqual({ positional: ['a', 'b'], options: { flag: true, value: '3' } });
  });

  it('does not read quoted words as options', () => {
    expect(parse(`'--flag'`)).toEqual({ positional: ['--flag'], options: {} });
  });

  it('reports unknown options, missing values and wrong argument counts with usage', () => {
    expect(() => parse('a --nope')).toThrow('demo: unknown option --nope\nusage: demo <first> [<second>] [--flag] [--value <v>]');
    expect(() => parse('a --value')).toThrow('--value needs a value');
    expect(() => parse('')).toThrow('demo: missing <first>');
    expect(() => parse('a b c')).toThrow('unexpected argument "c"');
  });
});
