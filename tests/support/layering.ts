import { readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import ts from 'typescript'

/** One module reference found in a source file (static import, re-export, dynamic import, require, or `import('x')` type). */
export interface ImportRef {
  /** The specifier exactly as written. */
  specifier: string
  /** Repo-relative module path for relative/aliased specifiers (extension and trailing /index removed); the bare specifier otherwise. */
  target: string
  /** Imported (not local) names. Empty for side-effect imports. */
  names: string[]
  /** `import * as x`, `export * from`, dynamic `import()`, `require()`: every export is reachable. */
  namespace: boolean
  typeOnly: boolean
  line: number
}

export interface LayeringRule {
  id: string
  message: string
  appliesTo: (file: string) => boolean
  forbids: (ref: ImportRef) => boolean
}

export interface Violation { file: string, line: number, rule: string, specifier: string, message: string }

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|vue)$/
const SKIPPED_DIRS = new Set(['node_modules', '.nuxt', '.output', '.git', '.data', 'dist', 'coverage', '.remember', '.superpowers', 'docs'])

function resolveTarget(file: string, specifier: string): string {
  let target = specifier
  if (specifier.startsWith('.')) target = posix.normalize(posix.join(posix.dirname(file), specifier))
  else if (/^(?:~~|@@)\//.test(specifier)) target = specifier.slice(3)
  else if (specifier.startsWith('#shared/')) target = `shared/${specifier.slice('#shared/'.length)}`
  return target.replace(/\.(?:[cm]?[jt]s)$/, '').replace(/\/index$/, '')
}

function scriptKind(file: string): ts.ScriptKind {
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/** `.vue` files: only the contents of their <script> blocks are code; lines are kept so reported line numbers stay right. */
function codeOf(file: string, source: string): string {
  if (!file.endsWith('.vue')) return source
  let code = ''
  for (const match of source.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/g)) {
    const before = source.slice(0, match.index! + match[1]!.length)
    const pad = '\n'.repeat((before.match(/\n/g) ?? []).length - (code.match(/\n/g) ?? []).length)
    code += pad + match[2]
  }
  return code
}

export function parseImports(file: string, source: string): ImportRef[] {
  const sf = ts.createSourceFile(file, codeOf(file, source), ts.ScriptTarget.Latest, true, scriptKind(file))
  const refs: ImportRef[] = []
  const add = (specifier: string, node: ts.Node, names: string[], namespace: boolean, typeOnly: boolean) => {
    refs.push({
      specifier,
      target: resolveTarget(file, specifier),
      names,
      namespace,
      typeOnly,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    })
  }

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const names: string[] = []
      let namespace = false
      let typeOnly = clause?.isTypeOnly ?? false
      if (clause?.name) names.push('default')
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) namespace = true
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) names.push((el.propertyName ?? el.name).text)
        if (!typeOnly && !clause?.name && bindings.elements.length > 0 && bindings.elements.every(el => el.isTypeOnly)) typeOnly = true
      }
      add(node.moduleSpecifier.text, node, names, namespace, typeOnly)
    }
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause
      const names = clause && ts.isNamedExports(clause) ? clause.elements.map(el => (el.propertyName ?? el.name).text) : []
      add(node.moduleSpecifier.text, node, names, !clause || ts.isNamespaceExport(clause), node.isTypeOnly)
    }
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      add(node.moduleReference.expression.text, node, [], true, node.isTypeOnly)
    }
    else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0]!)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add((node.arguments[0] as ts.StringLiteralLike).text, node, [], true, false)
    }
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      add(node.argument.literal.text, node, [], true, true)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return refs
}

/** Pure: no file system access, so the checker itself can be tested with in-memory sources. */
export function findViolations(sources: Record<string, string>, rules: readonly LayeringRule[]): Violation[] {
  const violations: Violation[] = []
  for (const [file, source] of Object.entries(sources)) {
    const applicable = rules.filter(rule => rule.appliesTo(file))
    if (applicable.length === 0) continue
    for (const ref of parseImports(file, source)) {
      for (const rule of applicable) {
        if (rule.forbids(ref)) violations.push({ file, line: ref.line, rule: rule.id, specifier: ref.specifier, message: rule.message })
      }
    }
  }
  return violations
}

const under = (...prefixes: string[]) => (file: string) => prefixes.some(p => file.startsWith(p))

const isDrizzle = (t: string) => t === 'drizzle-orm' || t.startsWith('drizzle-orm/')
const isDbSchema = (t: string) => t === 'db/schema' || t.startsWith('db/schema/')
const isDbClient = (t: string) => t === 'db/client'

/** Same directories (and the same single exemption) as the `no-restricted-imports` block in eslint.config.mjs. */
export const QUERY_RESTRICTED_DIRS = ['server/services/', 'server/api/', 'server/domain/', 'server/utils/', 'shared/'] as const
export const QUERY_RESTRICTION_EXEMPT = ['server/utils/db.ts'] as const
export const SCOPE_MINTING_ALLOWED = ['server/security/', 'db/seed/', 'tests/'] as const

export const LAYERING_RULES: readonly LayeringRule[] = [
  {
    id: 'no-query-building',
    message: 'Only repositories may build queries: drizzle-orm, db/schema and db/client are off limits here (types included).',
    appliesTo: file => under(...QUERY_RESTRICTED_DIRS)(file) && !(QUERY_RESTRICTION_EXEMPT as readonly string[]).includes(file),
    forbids: ref => isDrizzle(ref.target) || isDbSchema(ref.target) || isDbClient(ref.target),
  },
  {
    id: 'scope-minting',
    message: 'Scopes are minted only by server/security, db/seed and tests.',
    appliesTo: file => !under(...SCOPE_MINTING_ALLOWED)(file),
    forbids: ref => ref.target === 'server/security/scope' && (ref.namespace || ref.names.some(n => n.startsWith('trusted'))),
  },
  {
    id: 'seed-through-repositories',
    message: 'Seeds write through repositories; they may not import db/schema.',
    appliesTo: under('db/seed/'),
    forbids: ref => isDbSchema(ref.target),
  },
]

/** Names of every `Platform*Repository` class declared under server/. */
export function platformRepositoryClasses(sources: Record<string, string>): string[] {
  const names = new Set<string>()
  for (const [file, source] of Object.entries(sources)) {
    if (!file.startsWith('server/')) continue
    for (const m of source.matchAll(/\bclass\s+(Platform\w*Repository)\b/g)) names.add(m[1]!)
  }
  return [...names].sort()
}

/** Classes declared under server/repositories/platform/ whose name does not start with `Platform` (the allow-list is name-based). */
export function unprefixedPlatformDirClasses(sources: Record<string, string>): string[] {
  const names: string[] = []
  for (const [file, source] of Object.entries(sources)) {
    if (!file.startsWith('server/repositories/platform/')) continue
    for (const m of source.matchAll(/\bclass\s+(\w+)/g)) if (!m[1]!.startsWith('Platform')) names.push(`${file}: ${m[1]}`)
  }
  return names
}

/** Every source file of the repository (repo-relative posix path → contents), skipping generated and vendored directories. */
export function readRepoSources(root: string): Record<string, string> {
  const sources: Record<string, string> = {}
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(join(dir, entry.name), relPath)
      }
      else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name)) {
        sources[relPath] = readFileSync(join(dir, entry.name), 'utf8')
      }
    }
  }
  walk(root, '')
  return sources
}
