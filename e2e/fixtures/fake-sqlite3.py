#!/usr/bin/env python3
# The sqlite3 command of an SSH host, for the e2e suite database-ssh (no sqlite3 installed on
# the machines of the tests): the arguments plugin-database gives it (-safe … <file> <sql>),
# answered as sqlite3 -ascii -header does, through the sqlite3 module of Python. Each call is
# logged next to the file (calls.log) so the suite sees -safe and -readonly.
import sqlite3, sys

args = sys.argv[1:]
null = 'NULL'
readonly = False
rest = []
i = 0
while i < len(args):
    a = args[i]
    if a == '-nullvalue':
        null = args[i + 1]; i += 2; continue
    if a == '-cmd':
        i += 2; continue
    if a == '-readonly':
        readonly = True
    if not a.startswith('-'):
        rest.append(a)
    i += 1
path, sql = rest[0], rest[1]
with open(path + '.calls.log', 'a') as log:
    log.write(' '.join(args[:-2]) + '\n')
if '-safe' not in args:
    sys.exit('fake sqlite3: -safe missing')
uri = 'file:' + path + ('?mode=ro' if readonly else '')
try:
    c = sqlite3.connect(uri, uri=True, isolation_level=None)
    cur = c.execute(sql)
except sqlite3.Error as e:
    sys.stderr.write('Error: %s\n' % e)
    sys.exit(1)
if cur.description:
    out = '\x1f'.join(d[0] for d in cur.description) + '\x1e'
    for row in cur:
        out += '\x1f'.join(null if v is None else str(v) for v in row) + '\x1e'
    sys.stdout.write(out)
