/**
 * Output-sink enforcement (pay-2b round 3, SO f9fa2539 S4/S5).
 *
 * Layer 1 (AST, typescript compiler API) over src/ and examples/: every route
 * to stdout/stderr other than the two sink modules is a failure — console in
 * any form (alias, destructuring, console['log'], globalThis.console, optional
 * chaining), process.stdout / process.stderr (dot, bracket, destructured),
 * and fs.write/writeSync to fd 1 or 2. Any object literal with type: 'text'
 * outside src/utils/sink.ts is a failure (MCP text must come from toolText).
 * Layer 2: a line regex as a second net.
 *
 * Exceptions need BOTH an inline `// output-sink-allow: <reason>` marker and
 * an entry in tests/output-sink.allow.json keyed by the sha256 of the trimmed
 * line. Stale JSON entries fail too.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SINKS = new Set(['src/utils/sink.ts', 'examples/value-packs/shared/redact.ts'])
const TEXT_LITERAL_OK = new Set(['src/utils/sink.ts'])
const MARKER = '// output-sink-allow:'

type Finding = { file: string; line: number; text: string; rule: string }
type AllowEntry = { file: string; sha256: string; reason: string }

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

const STD = new Set(['stdout', 'stderr'])
const name = (n: ts.Node | undefined): string | undefined =>
  n && (ts.isIdentifier(n) || ts.isStringLiteralLike(n) || ts.isPrivateIdentifier(n)) ? n.text : undefined
const memberName = (n: ts.Node): string | undefined =>
  ts.isPropertyAccessExpression(n) ? n.name.text : ts.isElementAccessExpression(n) ? name(n.argumentExpression) : undefined
const isGlobalObj = (n: ts.Node): boolean => ts.isIdentifier(n) && ['globalThis', 'global', 'window', 'self'].includes(n.text)
const isProcess = (n: ts.Node): boolean =>
  (ts.isIdentifier(n) && n.text === 'process') ||
  ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && isGlobalObj(n.expression) && memberName(n) === 'process')

export function scanSource(file: string, source: string, checkTextLiteral: boolean): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : undefined)
  const findings: Finding[] = []
  const add = (node: ts.Node, rule: string): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
    findings.push({ file, line: line + 1, text: source.split('\n')[line] ?? '', rule })
  }
  const visit = (node: ts.Node): void => {
    // console as a value anywhere: call, alias, destructuring source, argument.
    if (ts.isIdentifier(node) && node.text === 'console') {
      const p = node.parent
      const isPropName = (ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node)
      if (!isPropName) add(node, 'console')
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && memberName(node) === 'console' && isGlobalObj(node.expression)) {
      add(node, 'globalThis.console')
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && STD.has(memberName(node) ?? '') && isProcess(node.expression)) {
      add(node, 'process.std')
    }
    // const { stdout } = process  /  const { console: c } = globalThis
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      for (const el of node.name.elements) {
        const prop = name(el.propertyName) ?? name(el.name)
        if ((STD.has(prop ?? '') && isProcess(node.initializer)) || (prop === 'console' && isGlobalObj(node.initializer))) add(el, 'destructured-std')
      }
    }
    // fs.write / fs.writeSync / writeSync(1|2, ...)
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression.text : memberName(node.expression)
      const fd = node.arguments[0]
      if ((callee === 'writeSync' || callee === 'write') && fd && ts.isNumericLiteral(fd) && (fd.text === '1' || fd.text === '2')) add(node, 'fd-write')
    }
    // S5
    if (checkTextLiteral && ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop) || name(prop.name) !== 'type') continue
        let init: ts.Expression = prop.initializer
        while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression
        if (ts.isStringLiteralLike(init) && init.text === 'text') add(node, 'text-literal')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return findings
}

const REGEX_LAYER = /\bconsole\b|\bprocess\s*(?:\.|\?\.|\[\s*['"`])\s*std(?:out|err)\b|\bwriteSync\s*\(\s*[12]\s*,/

function lineSha(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex')
}

const allow: AllowEntry[] = JSON.parse(readFileSync(join(ROOT, 'tests/output-sink.allow.json'), 'utf8'))
const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'examples'))]
const rel = (p: string): string => relative(ROOT, p).split('\\').join('/')

function allowed(f: { file: string; text: string }): boolean {
  return f.text.includes(MARKER) && allow.some((a) => a.file === f.file && a.sha256 === lineSha(f.text))
}

describe('output sink enforcement', () => {
  it('the AST detector catches every bypass shape (self-test)', () => {
    const fixture = [
      'console.log(1)',
      "console['error'](1)",
      'console?.warn(1)',
      'const c = console; c.log(1)',
      'const { log } = console',
      'globalThis.console.log(1)',
      "globalThis['console'].log(1)",
      'process.stdout.write("x")',
      "process['stderr'].write('x')",
      'process?.stdout?.write("x")',
      'const { stdout } = process',
      'globalThis.process.stderr.write("x")',
      'fs.writeSync(1, "x")',
      'writeSync(2, "x")',
      'fs.write(1, "x", () => {})',
      "const t = { type: 'text' as const, text: 'x' }",
    ].join('\n')
    const hits = scanSource('fixture.ts', fixture, true)
    const lines = new Set(hits.map((h) => h.line))
    for (let i = 1; i <= 16; i++) expect(lines.has(i), `fixture line ${i} not flagged`).toBe(true)
    // Type literals and property names are not output.
    expect(scanSource('ok.ts', "type T = { type: 'text'; text: string }\nconst o = { console: 1 }; o.console", true)).toEqual([])
  })

  it('AST layer: no direct output and no hand-built MCP text blocks outside the sinks', () => {
    const bad: string[] = []
    for (const abs of files) {
      const file = rel(abs)
      if (SINKS.has(file)) continue
      for (const f of scanSource(file, readFileSync(abs, 'utf8'), file.startsWith('src/') && !TEXT_LITERAL_OK.has(file))) {
        if (!allowed(f)) bad.push(`${f.file}:${f.line} [${f.rule}] ${f.text.trim()}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('regex layer agrees (second net)', () => {
    const bad: string[] = []
    for (const abs of files) {
      const file = rel(abs)
      if (SINKS.has(file)) continue
      readFileSync(abs, 'utf8')
        .split('\n')
        .forEach((text, i) => {
          const code = text.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/\/\*.*?\*\//g, '')
          if (REGEX_LAYER.test(code) && !allowed({ file, text })) bad.push(`${file}:${i + 1} ${text.trim()}`)
        })
    }
    expect(bad).toEqual([])
  })

  it('every allowlist entry matches a marked line and gives a reason (no stale entries)', () => {
    for (const a of allow) {
      expect(a.reason.length).toBeGreaterThan(10)
      const lines = readFileSync(join(ROOT, a.file), 'utf8').split('\n')
      expect(lines.some((l) => l.includes(MARKER) && lineSha(l) === a.sha256), `${a.file} ${a.sha256}`).toBe(true)
    }
  })
})
