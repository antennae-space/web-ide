// Built-in grammars. Each one is plain data (exportable / importable as JSON from the
// settings), the engine lives in ../tokenizer.ts.
import type { GrammarDef, RuleDef } from '../tokenizer'

const r = String.raw

const num: RuleDef = { token: 'number', regex: r`\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[nfFlLuU]?)\b|\.\d+\b` }
const call: RuleDef = { token: 'function', regex: r`[A-Za-z_$][\w$]*(?=\s*\()` }
const blockComment = (end = r`\*/`): RuleDef[] => [
  { token: 'comment', regex: end, next: '@pop' },
  { token: 'comment', regex: r`[^*]+|\*` },
]

// PHP, Python, JavaScript and TypeScript: the grammars of the language packs lang-php,
// lang-python and lang-typescript (#149).
// Go: the grammar of the language pack lang-go (#146).

const nginx: GrammarDef = {
  id: 'nginx',
  name: 'nginx',
  extensions: ['.conf', '.nginx'],
  filenames: ['nginx.conf', 'mime.types', 'fastcgi_params', 'proxy_params', 'uwsgi_params', 'scgi_params'],
  detect: r`^\s*(?:server|http|events|upstream)\s*\{|^\s*location\s+\S`,
  states: {
    root: [
      { token: 'comment', regex: r`#.*` },
      { token: 'string', regex: r`"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?` },
      { token: 'variable', regex: r`\$\{?\w+\}?` },
      { token: 'keyword', regex: r`(?<=^\s*)(?:server|location|http|events|upstream|if|map|types|stream|geo|limit_except|split_clients|mail)\b` },
      { token: 'property', regex: r`(?<=^\s*)[a-z_][a-z0-9_]*` },
      { token: 'regexp', regex: r`(?<=location\s+~\*?\s+)\S+` },
      { token: 'operator', regex: r`~\*?|=|\^~` },
      { token: 'constant', regex: r`\b(?:on|off|default_server|ssl|http2|backup|permanent|redirect|last|break)\b` },
      { token: 'number', regex: r`\b\d+(?:\.\d+)?[kKmMgGsdhywm]?s?\b` },
      { token: 'punctuation', regex: r`[{};]` },
    ],
  },
}

const sqlKeywords = r`select|from|where|and|or|not|in|is|null|as|on|join|inner|left|right|full|outer|cross|natural|using|group|by|order|having|limit|offset|union|all|distinct|insert|into|values|update|set|delete|create|table|view|index|unique|primary|key|foreign|references|drop|alter|add|column|constraint|default|check|if|exists|case|when|then|else|end|begin|commit|rollback|transaction|savepoint|release|with|recursive|returning|asc|desc|nulls|first|last|like|ilike|between|explain|analyze|vacuum|pragma|grant|revoke|truncate|cascade|restrict|schema|database|sequence|function|procedure|trigger|returns|language|replace|temporary|temp|materialized|lateral|window|over|partition|filter|conflict|do|nothing|fetch|next|rows|only|show|describe|use|to|current_date|current_time|current_timestamp|true|false`
const sql: GrammarDef = {
  id: 'sql',
  name: 'SQL',
  extensions: ['.sql', '.psql', '.ddl'],
  states: {
    root: [
      { token: 'comment', regex: r`--.*` },
      { token: 'comment', regex: r`/\*`, next: 'comment' },
      { token: 'string', regex: "'", next: 'str' },
      { token: 'string', regex: r`\$\$`, next: 'dollar' },
      { token: 'variable', regex: r`"(?:[^"]|"")*"?|\x60[^\x60]*\x60?` },
      { token: 'variable', regex: r`\$\d+|:[A-Za-z_]\w*|\?` },
      num,
      { token: 'keyword', regex: r`\b(?:${sqlKeywords})\b`, flags: 'i' },
      { token: 'type', regex: r`\b(?:int|integer|smallint|bigint|serial|bigserial|real|double|precision|numeric|decimal|float|text|varchar|char|character|varying|boolean|bool|date|time|timestamp|timestamptz|interval|uuid|json|jsonb|bytea|blob|clob|xml|money|inet|cidr)\b`, flags: 'i' },
      call,
      { token: 'text', regex: r`[A-Za-z_]\w*` },
      { token: 'operator', regex: r`::|[-+*/%=<>!|&^~]+` },
      { token: 'punctuation', regex: r`[(),;.]` },
    ],
    comment: blockComment(),
    str: [{ token: 'string', regex: "''" }, { token: 'string', regex: "'", next: '@pop' }, { token: 'string', regex: r`[^']+` }],
    dollar: [{ token: 'string', regex: r`\$\$`, next: '@pop' }, { token: 'string', regex: r`[^$]+|\$` }],
  },
}

const redis: GrammarDef = {
  id: 'redis',
  name: 'Redis',
  extensions: ['.redis'],
  states: {
    root: [
      { token: 'comment', regex: r`(?:#|//).*` },
      { token: 'keyword', regex: r`(?<=^\s*|;\s*)[A-Za-z][A-Za-z.]*`, },
      { token: 'string', regex: r`"(?:[^"\\]|\\.)*"?|'[^']*'?` },
      { token: 'number', regex: r`(?<=\s)[-+]?\d+(?:\.\d+)?(?=\s|$)` },
      { token: 'constant', regex: r`\b(?:EX|PX|NX|XX|KEEPTTL|GET|WITHSCORES|LIMIT|MATCH|COUNT|TYPE)\b` },
      { token: 'punctuation', regex: ';' },
    ],
  },
}

const json: GrammarDef = {
  id: 'json',
  name: 'JSON',
  extensions: ['.json', '.jsonc', '.json5', '.webmanifest'],
  filenames: ['.babelrc', '.eslintrc', 'composer.lock'],
  states: {
    root: [
      { token: 'comment', regex: r`//.*` },
      { token: 'comment', regex: r`/\*`, next: 'comment' },
      { token: 'property', regex: r`"(?:[^"\\]|\\.)*"(?=\s*:)` },
      { token: 'string', regex: r`"(?:[^"\\]|\\.)*"?` },
      { token: 'number', regex: r`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b` },
      { token: 'constant', regex: r`\b(?:true|false|null)\b` },
      { token: 'punctuation', regex: r`[{}\[\]:,]` },
    ],
    comment: blockComment(),
  },
}

const css: GrammarDef = {
  id: 'css',
  name: 'CSS',
  extensions: ['.css', '.scss', '.less', '.pcss'],
  states: {
    root: [
      { token: 'comment', regex: r`/\*`, next: 'comment' },
      { token: 'comment', regex: r`//.*` },
      { token: 'string', regex: r`"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?` },
      { token: 'keyword', regex: r`@[\w-]+` },
      { token: 'variable', regex: r`--[\w-]+|\$[\w-]+` },
      { token: 'property', regex: r`[\w-]+(?=\s*:(?!:))` },
      { token: 'number', regex: r`#[\da-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch|ex|dvh|svh|lh)?\b` },
      { token: 'function', regex: r`[\w-]+(?=\()` },
      { token: 'tag', regex: r`(?<![\w-])(?:[a-z][\w-]*|\*)(?=[^{};]*\{)` },
      { token: 'type', regex: r`[.#][\w-]+` },
      { token: 'meta', regex: r`::?[\w-]+` },
      { token: 'constant', regex: r`!important\b` },
      { token: 'punctuation', regex: r`[{}();,:]` },
    ],
    comment: blockComment(),
  },
}

const html: GrammarDef = {
  id: 'html',
  name: 'HTML',
  extensions: ['.html', '.htm', '.xhtml', '.xml', '.svg', '.vue', '.svelte', '.twig', '.blade.php'],
  detect: r`^\s*<(?:!doctype|html|\?xml)`,
  states: {
    root: [
      { token: 'comment', regex: '<!--', next: 'comment' },
      { token: 'meta', regex: r`<!\w[^>]*>|<\?xml[^>]*\?>` },
      { token: 'tag', regex: r`</?[A-Za-z][\w:.-]*`, next: 'tag' },
      { token: 'escape', regex: r`&[#\w]+;` },
      { token: 'meta', regex: r`\{\{|\}\}|\{%|%\}` },
    ],
    tag: [
      { token: 'tag', regex: r`/?>`, next: '@pop' },
      { token: 'attribute', regex: r`[^\s"'>/=]+` },
      { token: 'operator', regex: '=' },
      { token: 'string', regex: r`"[^"]*"?|'[^']*'?` },
    ],
    comment: [{ token: 'comment', regex: '-->', next: '@pop' }, { token: 'comment', regex: r`[^-]+|-` }],
  },
}

const markdown: GrammarDef = {
  id: 'markdown',
  name: 'Markdown',
  extensions: ['.md', '.markdown', '.mdx'],
  states: {
    root: [
      { token: 'string', regex: r`^\s*(?:\x60{3,}|~{3,}).*`, next: 'fence' },
      { token: 'heading', regex: r`^#{1,6}\s.*` },
      { token: 'comment', regex: r`^\s*>.*` },
      { token: 'keyword', regex: r`^\s*(?:[-*+]|\d+[.)])\s` },
      { token: 'punctuation', regex: r`^(?:-{3,}|\*{3,}|_{3,})\s*$` },
      { token: 'string', regex: r`\x60[^\x60]+\x60` },
      { token: 'emphasis', regex: r`(\*\*|__)(?=\S)[^*_]+?\1|(\*|_)(?=\S)[^*_]+?\2` },
      { token: 'link', regex: r`!?\[[^\]]*\]\([^)]*\)|<https?://[^>]+>` },
      { token: 'tag', regex: r`</?[A-Za-z][^>]*>` },
    ],
    fence: [{ token: 'string', regex: r`^\s*(?:\x60{3,}|~{3,})\s*$`, next: '@pop' }, { token: 'string', regex: '.+' }],
  },
}

const shell: GrammarDef = {
  id: 'shell',
  name: 'Shell',
  extensions: ['.sh', '.bash', '.zsh', '.env', '.bashrc', '.profile'],
  filenames: ['.bashrc', '.zshrc', '.profile', '.env', 'Makefile', 'makefile', 'Dockerfile'],
  detect: r`^#!.*\b(?:ba|z|da)?sh\b`,
  states: {
    root: [
      { token: 'comment', regex: r`(?<=^|\s)#.*` },
      { token: 'string', regex: r`'[^']*'?` },
      { token: 'string', regex: '"', next: 'dq' },
      { token: 'variable', regex: r`\$(?:\{[^}]*\}?|\w+|[@*#?$!0-9-])` },
      { token: 'keyword', regex: r`\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|return|local|export|readonly|declare|source|exit|break|continue|FROM|RUN|CMD|COPY|ADD|ENV|ARG|WORKDIR|EXPOSE|ENTRYPOINT|USER|VOLUME|LABEL)\b` },
      { token: 'function', regex: r`^[\w.-]+(?=\s*:(?!=))|\b\w+(?=\(\))` },
      { token: 'builtin', regex: r`\b(?:echo|cd|printf|test|read|set|unset|shift|eval|exec|trap|wait|kill|true|false)\b` },
      { token: 'number', regex: r`\b\d+\b` },
      { token: 'operator', regex: r`&&|\|\||[|&;<>]=?|=` },
    ],
    dq: [
      { token: 'escape', regex: r`\\.` },
      { token: 'variable', regex: r`\$(?:\{[^}]*\}?|\w+|[@*#?$!0-9-])` },
      { token: 'string', regex: '"', next: '@pop' },
      { token: 'string', regex: r`[^"\\$]+|\$` },
    ],
  },
}

const yaml: GrammarDef = {
  id: 'yaml',
  name: 'YAML',
  extensions: ['.yml', '.yaml', '.toml', '.ini', '.cfg', '.neon'],
  states: {
    root: [
      { token: 'comment', regex: r`(?<=^|\s)[#;].*` },
      { token: 'meta', regex: r`^\s*\[[^\]]+\]|^---|^\.\.\.` },
      { token: 'property', regex: r`^\s*-?\s*[\w.$/-]+(?=\s*[:=](?:\s|$))` },
      { token: 'string', regex: r`"(?:[^"\\]|\\.)*"?|'[^']*'?` },
      { token: 'constant', regex: r`\b(?:true|false|null|yes|no|on|off|~)\b` },
      { token: 'variable', regex: r`[&*][\w-]+|%env\([^)]*\)%|\$\{[^}]*\}` },
      { token: 'number', regex: r`(?<=[:=\s-])\s*-?\d+(?:\.\d+)?\b` },
      { token: 'punctuation', regex: r`[-:|>{}\[\],=]` },
    ],
  },
}

const plain: GrammarDef = { id: 'plaintext', name: 'Text', extensions: ['.txt', '.log'], states: { root: [] } }

export const builtinGrammars: GrammarDef[] = [
  nginx,
  sql,
  redis,
  json,
  css,
  html,
  markdown,
  shell,
  yaml,
  plain,
]
