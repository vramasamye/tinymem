/**
 * Per-language declaration visitors (the narrow visitor the dependency-verification §9 verdict
 * prescribes: tree-sitter gives syntax trees and ranges; language-specific traversal and
 * normalization are ours). One walk per file matches a fixed rule table per grammar; every
 * matched named declaration becomes one symbol record. Two normalizations make spans meaningful
 * for drift:
 *
 * - `signature` — the declaration's header tokens (comments stripped, whitespace collapsed,
 *   single line, capped at 240 characters). It is display metadata only; the full span hash is
 *   the drift signal.
 * - `span_hash` — SHA-256 over the declaration's full token stream with comment nodes (grammar
 *   extras) excluded. Comment edits and reformatting inside a symbol leave its span_hash
 *   unchanged; any token change inside the span changes it. The domain prefix versions the
 *   normalization so a later scheme change is detectable, not silently comparable.
 *
 * Bounded rules, deliberately: declaration surface only. A matched named function-like symbol
 * is terminal (its body is its own span — nested helpers drift with their container, not on
 * their own), while class/interface/trait/impl/module containers are descended for members.
 * Anonymous declarations are not extracted (no name to reference) but their children are
 * still visited. Ambient TypeScript (`declare …`) subtrees are skipped: they are type
 * declarations without runtime code.
 */

import { createHash } from 'node:crypto';

import type { Node, Tree } from 'web-tree-sitter';

import type { SymbolKind, SymbolLanguage, SymbolRecord } from './schema';

const SIGNATURE_MAX = 240;
const SPAN_HASH_DOMAIN = 'onememory.symbol-span.v1';

interface Rule {
  readonly kind: SymbolKind | ((node: Node, inMember: boolean) => SymbolKind | null);
  /** The symbol's name, or null when the node is anonymous (not extracted, still descended). */
  readonly name: (node: Node) => string | null;
  /** Byte offset where the declaration's header (signature slice) ends. */
  readonly headerEnd: (node: Node) => number;
  /** Descend after extraction (member containers); unmatched nodes always descend. */
  readonly recurse: (node: Node) => boolean;
  /** Children are visited inside a member container (Python/Rust function-kind context). */
  readonly memberContainer?: boolean;
}

const endOf = (node: Node | null, fallback: number): number => (node === null ? fallback : node.endIndex);

const namedText = (node: Node): string | null => {
  const name = node.childForFieldName('name');
  return name === null || name.text === '' ? null : name.text;
};

/**
 * Token stream of [node.start, endOffset): leaf token texts, comment nodes (grammar extras)
 * excluded, joined by single spaces — whitespace- and comment-normalized, deterministic.
 * Iterative on purpose: minified or generated sources can nest deeper than the JS stack.
 * Children enter the stack in reverse so pops yield document order; leaf tokens are collected
 * at pop time (never during the reversed push), and tokens crossing the end offset are
 * dropped — endOffset is always a node boundary, so only wholly-contained tokens remain.
 */
function tokenStream(node: Node, endOffset: number): string {
  const tokens: string[] = [];
  const stack: Node[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.isExtra) continue;
    if (current.childCount === 0) {
      if (current.endIndex <= endOffset) tokens.push(current.text);
      continue;
    }
    const children = current.children;
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index]!;
      if (child.isExtra || child.startIndex >= endOffset) continue;
      stack.push(child);
    }
  }
  return tokens.join(' ');
}

function normalizedSignature(header: string): string {
  if (header.length <= SIGNATURE_MAX) return header;
  return `${[...header].slice(0, SIGNATURE_MAX - 3).join('')}...`;
}

function spanHash(node: Node): string {
  return createHash('sha256')
    .update(SPAN_HASH_DOMAIN)
    .update('\0')
    .update(tokenStream(node, node.endIndex))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// TypeScript / TSX / JavaScript
// ---------------------------------------------------------------------------

const tsFunctionRule = (kind: SymbolKind): Rule => ({
  kind,
  name: namedText,
  headerEnd: (node) => endOf(
    node.childForFieldName('return_type') ??
      node.childForFieldName('parameters') ??
      node.childForFieldName('name'),
    node.endIndex,
  ),
  recurse: () => false,
});

const tsContainerRule = (kind: SymbolKind): Rule => ({
  kind,
  name: namedText,
  headerEnd: (node) => endOf(
    node.childForFieldName('class_heritage') ??
      node.childForFieldName('type_parameters') ??
      node.childForFieldName('name'),
    node.endIndex,
  ),
  recurse: () => true,
  memberContainer: true,
});

const tsRules: Record<string, Rule> = {
  function_declaration: tsFunctionRule('function'),
  generator_function_declaration: tsFunctionRule('function'),
  method_definition: tsFunctionRule('method'),
  method_signature: tsFunctionRule('method'),
  abstract_method_signature: tsFunctionRule('method'),
  class_declaration: tsContainerRule('class'),
  abstract_class_declaration: tsContainerRule('class'),
  class: tsContainerRule('class'), // named class expressions; anonymous ones only descend
  interface_declaration: tsContainerRule('interface'),
  internal_module: tsContainerRule('module'),
  type_alias_declaration: {
    kind: 'type',
    name: namedText,
    // The alias VALUE stays out of the signature (it is covered by the span hash); the header
    // ends at the type parameters.
    headerEnd: (node) => endOf(
      node.childForFieldName('type_parameters') ?? node.childForFieldName('name'),
      node.endIndex,
    ),
    recurse: () => false,
  },
  enum_declaration: {
    kind: 'enum',
    name: namedText,
    headerEnd: (node) => endOf(node.childForFieldName('name'), node.endIndex),
    recurse: () => false,
  },
  // Function-like bindings: `export const handler = async (req) => ...` — the declarator is the
  // named symbol; plain data bindings are out of the symbol domain (file-tier blobs cover them).
  variable_declarator: {
    kind: 'function',
    name: (node) => {
      const value = node.childForFieldName('value');
      if (value === null || (value.type !== 'arrow_function' && value.type !== 'function_expression')) {
        return null;
      }
      return namedText(node);
    },
    headerEnd: (node) => {
      const value = node.childForFieldName('value');
      const valueHeader = value === null
        ? null
        : value.childForFieldName('return_type') ?? value.childForFieldName('parameters');
      return endOf(valueHeader ?? node.childForFieldName('name'), node.endIndex);
    },
    recurse: () => false,
  },
};

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const pythonRules: Record<string, Rule> = {
  // Decorated definitions are extracted at the wrapper so decorators stay inside the span and
  // the signature; the wrapped definition is skipped (parent check) to avoid a duplicate.
  decorated_definition: {
    kind: (node, inMember) => {
      const definition = node.childForFieldName('definition');
      if (definition === null) return null;
      if (definition.type === 'class_definition') return 'class';
      return inMember ? 'method' : 'function';
    },
    name: (node) => {
      const definition = node.childForFieldName('definition');
      return definition === null ? null : namedText(definition);
    },
    headerEnd: (node) => {
      const definition = node.childForFieldName('definition');
      if (definition === null) return node.endIndex;
      if (definition.type === 'function_definition') {
        return endOf(
          definition.childForFieldName('return_type') ??
            definition.childForFieldName('parameters') ??
            definition.childForFieldName('name'),
          node.endIndex,
        );
      }
      return endOf(
        definition.childForFieldName('superclasses') ?? definition.childForFieldName('name'),
        node.endIndex,
      );
    },
    recurse: (node) => node.childForFieldName('definition')?.type === 'class_definition',
    memberContainer: true,
  },
  function_definition: {
    kind: (_node, inMember) => (inMember ? 'method' : 'function'),
    name: (node) => (node.parent?.type === 'decorated_definition' ? null : namedText(node)),
    headerEnd: (node) => endOf(
      node.childForFieldName('return_type') ??
        node.childForFieldName('parameters') ??
        node.childForFieldName('name'),
      node.endIndex,
    ),
    recurse: () => false,
  },
  class_definition: {
    kind: 'class',
    name: (node) => (node.parent?.type === 'decorated_definition' ? null : namedText(node)),
    headerEnd: (node) => endOf(
      node.childForFieldName('superclasses') ?? node.childForFieldName('name'),
      node.endIndex,
    ),
    recurse: () => true,
    memberContainer: true,
  },
};

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const goRules: Record<string, Rule> = {
  function_declaration: {
    kind: 'function',
    name: namedText,
    headerEnd: (node) => endOf(
      node.childForFieldName('result') ??
        node.childForFieldName('parameters') ??
        node.childForFieldName('name'),
      node.endIndex,
    ),
    recurse: () => false,
  },
  method_declaration: {
    kind: 'method',
    name: namedText,
    // The slice starts at the node, so the receiver is part of the signature.
    headerEnd: (node) => endOf(
      node.childForFieldName('result') ??
        node.childForFieldName('parameters') ??
        node.childForFieldName('receiver') ??
        node.childForFieldName('name'),
      node.endIndex,
    ),
    recurse: () => false,
  },
  // Interface members: the interface's method surface.
  method_elem: {
    kind: 'method',
    name: namedText,
    headerEnd: (node) => endOf(
      node.childForFieldName('result') ??
        node.childForFieldName('parameters') ??
        node.childForFieldName('name'),
      node.endIndex,
    ),
    recurse: () => false,
  },
  // `type Point struct` / `type Shape interface` / `type Handler func(int) error`. The enclosing
  // `type` keyword belongs to the parent type_declaration node, so signatures start at the spec.
  type_spec: {
    kind: (node) => {
      const type = node.childForFieldName('type');
      if (type?.type === 'struct_type') return 'struct';
      if (type?.type === 'interface_type') return 'interface';
      return 'type';
    },
    name: namedText,
    headerEnd: (node) => {
      const type = node.childForFieldName('type');
      if (type !== null && (type.type === 'struct_type' || type.type === 'interface_type')) {
        return endOf(type.child(0), node.endIndex); // through the `struct`/`interface` keyword
      }
      return endOf(type, node.endIndex);
    },
    recurse: () => true, // interface method_elem members; struct fields carry no rules
    memberContainer: true,
  },
  type_alias: {
    kind: 'type',
    name: namedText,
    headerEnd: (node) => node.endIndex, // the whole alias node is its own header: `Alias = int`
    recurse: () => false,
  },
};

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

const rustFunctionRule = (): Rule => ({
  kind: (_node, inMember) => (inMember ? 'method' : 'function'),
  name: namedText,
  headerEnd: (node) => endOf(
    node.childForFieldName('return_type') ??
      node.childForFieldName('parameters') ??
      node.childForFieldName('name'),
    node.endIndex,
  ),
  recurse: () => false,
});

const rustRules: Record<string, Rule> = {
  function_item: rustFunctionRule(),
  function_signature_item: rustFunctionRule(),
  struct_item: {
    kind: 'struct',
    name: namedText,
    headerEnd: (node) => endOf(
      node.childForFieldName('type_parameters') ?? node.childForFieldName('name'),
      node.endIndex,
    ),
    recurse: () => false,
  },
  enum_item: {
    kind: 'enum',
    name: namedText,
    headerEnd: (node) => endOf(
      node.childForFieldName('type_parameters') ?? node.childForFieldName('name'),
      node.endIndex,
    ),
    recurse: () => false,
  },
  trait_item: {
    kind: 'trait',
    name: namedText,
    headerEnd: (node) => endOf(
      node.childForFieldName('type_parameters') ?? node.childForFieldName('name'),
      node.endIndex,
    ),
    recurse: () => true, // trait members: signatures with no body, and default methods
    memberContainer: true,
  },
  impl_item: {
    kind: 'impl',
    // impl blocks have no name field; the trait/type pair is the identity.
    name: (node) => {
      const type = node.childForFieldName('type');
      if (type === null) return null;
      const trait = node.childForFieldName('trait');
      return trait === null ? `impl ${type.text}` : `impl ${trait.text} for ${type.text}`;
    },
    headerEnd: (node) => endOf(node.childForFieldName('type') ?? node.childForFieldName('trait'), node.endIndex),
    recurse: () => true,
    memberContainer: true,
  },
  type_item: {
    kind: 'type',
    name: namedText,
    headerEnd: (node) => endOf(node.childForFieldName('type') ?? node.childForFieldName('name'), node.endIndex),
    recurse: () => false,
  },
  mod_item: {
    kind: 'module',
    name: namedText,
    headerEnd: (node) => endOf(node.childForFieldName('name'), node.endIndex),
    recurse: () => true, // nested items inside modules stay in the table
  },
};

const RULES: Record<SymbolLanguage, Record<string, Rule>> = {
  typescript: tsRules,
  tsx: tsRules,
  javascript: tsRules,
  python: pythonRules,
  go: goRules,
  rust: rustRules,
};

/** Subtrees never descended into (ambient `declare` blocks have no runtime code). */
const SKIPPED_SUBTREES: Partial<Record<SymbolLanguage, ReadonlySet<string>>> = {
  typescript: new Set(['ambient_declaration']),
  tsx: new Set(['ambient_declaration']),
};

/**
 * Extract the file's declaration surface in document order. Tree-sitter is error-tolerant, so a
 * file with syntax errors still yields its valid declarations — with the ERROR-node count
 * reported alongside, never a silently "clean" table.
 */
export function extractFileSymbols(
  language: SymbolLanguage,
  tree: Tree,
): { symbols: SymbolRecord[]; parse_errors: number } {
  const rules = RULES[language];
  const skippedSubtrees = SKIPPED_SUBTREES[language];
  const symbols: SymbolRecord[] = [];
  // Iterative pre-order walk (document order); the stack keeps deep nesting off the JS stack.
  const stack: Array<{ node: Node; inMember: boolean }> = [{ node: tree.rootNode, inMember: false }];
  while (stack.length > 0) {
    const { node, inMember } = stack.pop()!;
    if (skippedSubtrees?.has(node.type)) continue;
    const rule = rules[node.type];
    if (rule !== undefined) {
      const name = rule.name(node);
      if (name !== null) {
        const kind = typeof rule.kind === 'function' ? rule.kind(node, inMember) : rule.kind;
        if (kind !== null) {
          symbols.push({
            name,
            kind,
            signature: normalizedSignature(tokenStream(node, rule.headerEnd(node))),
            line_start: node.startPosition.row + 1,
            line_end: node.endPosition.row + 1,
            span_hash: spanHash(node),
          });
          if (!rule.recurse(node)) continue;
          const children = node.children;
          // memberContainer flips context for containers; absent it, children inherit it (a
          // module inside an impl block keeps its functions in the member context).
          const childInMember = rule.memberContainer ?? inMember;
          for (let index = children.length - 1; index >= 0; index--) {
            stack.push({ node: children[index]!, inMember: childInMember });
          }
          continue;
        }
      }
    }
    const children = node.children;
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ node: children[index]!, inMember });
    }
  }
  return { symbols, parse_errors: tree.rootNode.descendantsOfType('ERROR').length };
}
