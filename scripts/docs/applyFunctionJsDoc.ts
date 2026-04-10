/**
 * @fileoverview Adds missing JSDoc and rewrites low-quality template JSDoc for function targets in src/.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

interface ImportBinding {
  localName: string;
  importedName: string;
  source: string;
}

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

interface JsDocRange {
  start: number;
  end: number;
  text: string;
}

const SOURCE_ROOT = path.join(process.cwd(), "src");
const LOW_QUALITY_MARKERS = [
  "prevents repeated inline logic and keeps this module easier for humans to reason about.",
  "uses only local arguments and module constants.",
  "isolates this orchestration step so call sites stay readable and external collaborators remain explicit.",
  "coordinates local logic and imported collaborators while keeping behavior deterministic.",
  "for downstream callers.",
  "for downstream steps.",
  "supplied by the caller.",
  "provides module-level behavior from",
  "no imported collaborators; uses local inputs, constants, and module state.",
  "keeps repeated local logic in one place to reduce behavior drift.",
  "coordinates imported collaborators behind one deterministic function boundary.",
  "keeps policy checks explicit and testable before side effects.",
  "keeps payload construction consistent across call sites.",
  "centralizes shape validation and normalization rules so callers do not drift.",
  "prevents divergent selection behavior by keeping decision rules in one function.",
  "isolates one runtime step so higher-level orchestration remains readable.",
  "separates read-path concerns from orchestration and mutation paths.",
  "centralizes state mutation rules for auditability and replay."
  ,
  "input value consumed by this function.",
  "structured input payload for this function.",
  "normalized or derived string value.",
  "typed result payload for callers.",
  "interacts with local collaborators through imported modules and typed inputs/outputs.",
  "as part of the deterministic runtime workflow.",
  "string output returned by this function.",
  "value of type `",
  "supplied by the caller."
] as const;

function collectSourceFiles(dir: string): string[] {
  let files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(collectSourceFiles(fullPath));
      continue;
    }
    if (fullPath.endsWith(".ts") && !fullPath.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function isFunctionTarget(
  node: ts.Node
): node is ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function splitWords(value: string): string[] {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.split(" ") : [];
}

function readLineStartIndex(sourceText: string, index: number): number {
  return sourceText.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
}

function normalizeFunctionName(
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration,
  classStack: readonly string[],
  sourceFile: ts.SourceFile
): string {
  if (ts.isConstructorDeclaration(node)) {
    const className = classStack[classStack.length - 1] ?? "AnonymousClass";
    return `${className}.constructor`;
  }

  if (ts.isFunctionDeclaration(node)) {
    return (
      node.name?.text ??
      `anonymousFunction@${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`
    );
  }

  const className = classStack[classStack.length - 1];
  const methodName = node.name ? node.name.getText(sourceFile) : "anonymousMethod";
  return className ? `${className}.${methodName}` : methodName;
}

function buildImportMap(sourceFile: ts.SourceFile): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }
    const source = ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : statement.moduleSpecifier.getText(sourceFile);

    if (statement.importClause.name) {
      bindings.set(statement.importClause.name.text, {
        localName: statement.importClause.name.text,
        importedName: "default",
        source
      });
    }

    const namedBindings = statement.importClause.namedBindings;
    if (!namedBindings) {
      continue;
    }
    if (ts.isNamespaceImport(namedBindings)) {
      bindings.set(namedBindings.name.text, {
        localName: namedBindings.name.text,
        importedName: "*",
        source
      });
      continue;
    }

    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      bindings.set(element.name.text, {
        localName: element.name.text,
        importedName,
        source
      });
    }
  }
  return bindings;
}

function collectCollaborators(
  node: ts.Node,
  imports: ReadonlyMap<string, ImportBinding>
): ImportBinding[] {
  const byKey = new Map<string, ImportBinding>();

  function visit(current: ts.Node): void {
    if (ts.isIdentifier(current)) {
      const binding = imports.get(current.text);
      if (binding) {
        const key = `${binding.source}::${binding.importedName}::${binding.localName}`;
        byKey.set(key, binding);
      }
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return [...byKey.values()].sort((left, right) => {
    const sourceCompare = left.source.localeCompare(right.source);
    if (sourceCompare !== 0) {
      return sourceCompare;
    }
    return left.localName.localeCompare(right.localName);
  });
}

function resolveParameterNames(
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration,
  sourceFile: ts.SourceFile
): string[] {
  return node.parameters.map((parameter, index) => {
    if (ts.isIdentifier(parameter.name)) {
      return parameter.name.text;
    }
    return `param${index + 1}_${parameter.name.getText(sourceFile).replace(/[^a-zA-Z0-9_]/g, "_")}`;
  });
}

function resolveReturnType(
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration,
  sourceFile: ts.SourceFile
): string | null {
  if (ts.isConstructorDeclaration(node)) {
    return null;
  }
  return node.type ? node.type.getText(sourceFile).trim() : "unknown";
}

function extractVerbAndObject(functionName: string): { verb: string; objectPhrase: string; nounPhrase: string } {
  const tail = functionName.split(".").pop() ?? functionName;
  const words = splitWords(tail);
  const verb = (words[0] ?? "").toLowerCase();
  const nounPhrase = words.join(" ").toLowerCase() || "helper";
  const objectPhrase = words.slice(1).join(" ").toLowerCase() || "input";
  return { verb, objectPhrase, nounPhrase };
}

function inferWhatItDoes(functionName: string, filePath: string): string {
  const moduleName = path.basename(filePath, ".ts");
  const { verb, objectPhrase, nounPhrase } = extractVerbAndObject(functionName);
  const className = functionName.includes(".") ? functionName.split(".")[0] : null;
  const targetPhrase = objectPhrase || "this input";

  if (verb === "constructor") {
    return className
      ? `Initializes \`${className}\` with deterministic runtime dependencies.`
      : "Initializes deterministic runtime dependencies for this class.";
  }
  if (verb === "main") {
    return `Runs the \`${moduleName}\` entrypoint workflow.`;
  }
  if (
    (verb === "days" || verb === "hours" || verb === "minutes") &&
    nounPhrase.includes("between")
  ) {
    return `Calculates ${nounPhrase} for deterministic time-based decisions.`;
  }

  if (verb === "normalize") {
    return `Normalizes ${targetPhrase} into a stable shape for \`${moduleName}\` logic.`;
  }
  if (verb === "parse" || verb === "decode") {
    return `Parses ${targetPhrase} and validates expected structure.`;
  }
  if (
    verb === "assert" ||
    verb === "validate" ||
    verb === "verify" ||
    verb === "check" ||
    verb === "guard" ||
    verb === "require" ||
    verb === "ensure"
  ) {
    return `Applies deterministic validity checks for ${targetPhrase}.`;
  }
  if (verb === "classify") {
    return `Classifies ${targetPhrase} with deterministic rule logic.`;
  }
  if (verb === "coerce") {
    return `Coerces ${targetPhrase} into a safe deterministic representation.`;
  }
  if (verb === "split") {
    return `Splits ${targetPhrase} into normalized segments for downstream parsing.`;
  }
  if (verb === "send") {
    return `Sends ${targetPhrase} through the module's deterministic transport path.`;
  }
  if (verb === "track") {
    return `Tracks ${targetPhrase} for audit, retry, or telemetry decisions.`;
  }
  if (verb === "interpret") {
    return `Interprets ${targetPhrase} into a typed decision signal.`;
  }
  if (verb === "sleep") {
    return "Pauses execution for a bounded interval used by retry/backoff flows.";
  }
  if (verb === "default") {
    return `Returns the default ${targetPhrase} used when explicit config is absent.`;
  }
  if (verb === "find" || verb === "lookup") {
    return `Finds ${targetPhrase} from available runtime state.`;
  }
  if (verb === "pick") {
    return `Selects ${targetPhrase} from candidate options.`;
  }
  if (verb === "next") {
    return `Computes the next ${targetPhrase} value for this runtime flow.`;
  }
  if (verb === "empty") {
    return `Creates an empty ${targetPhrase} value with deterministic defaults.`;
  }
  if (
    verb === "extract" ||
    verb === "infer" ||
    verb === "derive" ||
    verb === "compute" ||
    verb === "estimate" ||
    verb === "calculate"
  ) {
    return `Derives ${targetPhrase} from available runtime inputs.`;
  }
  if (verb === "count") {
    return `Counts ${targetPhrase} for downstream policy and scoring decisions.`;
  }
  if (verb === "tokenize") {
    return `Tokenizes ${targetPhrase} for deterministic lexical analysis.`;
  }
  if (verb === "contains") {
    return `Checks whether ${targetPhrase} contains the required signal.`;
  }
  if (verb === "import") {
    return `Imports ${targetPhrase} into local state while preserving deterministic ordering.`;
  }
  if (verb === "register") {
    return `Registers ${targetPhrase} in runtime state for later policy/runtime checks.`;
  }
  if (verb === "complete") {
    return `Completes ${targetPhrase} through the configured model/provider path.`;
  }
  if (verb === "cleanup") {
    return `Cleans up ${targetPhrase} according to deterministic retention rules.`;
  }
  if (verb === "consume") {
    return `Consumes ${targetPhrase} and applies deterministic state updates.`;
  }
  if (verb === "approve") {
    return `Builds an approval outcome for ${targetPhrase} with typed metadata.`;
  }
  if (verb === "reject") {
    return `Builds a rejection outcome for ${targetPhrase} with typed metadata.`;
  }
  if (verb === "reflect") {
    return `Builds reflection output for ${targetPhrase} using deterministic rules.`;
  }
  if (verb === "embed") {
    return `Generates embedding vectors for ${targetPhrase}.`;
  }
  if (verb === "hash" || verb === "fingerprint") {
    return `Computes a deterministic fingerprint for ${targetPhrase}.`;
  }
  if (verb === "sort" || verb === "dedupe" || verb === "merge") {
    return `Normalizes ordering and duplication for ${targetPhrase}.`;
  }
  if (verb === "clamp" || verb === "trim" || verb === "strip" || verb === "sanitize") {
    return `Constrains and sanitizes ${targetPhrase} to safe deterministic bounds.`;
  }
  if (verb === "to" || verb === "as" || verb === "from") {
    return `Converts values into ${targetPhrase} form for consistent downstream use.`;
  }
  if (
    verb === "evaluate" ||
    verb === "detect" ||
    verb === "is" ||
    verb === "has" ||
    verb === "should" ||
    verb === "can" ||
    verb === "includes" ||
    verb === "matches"
  ) {
    return `Evaluates ${targetPhrase} and returns a deterministic policy signal.`;
  }
  if (
    verb === "build" ||
    verb === "create" ||
    verb === "make" ||
    verb === "prepare" ||
    verb === "compose" ||
    verb === "generate"
  ) {
    return `Builds ${targetPhrase} for this module's runtime flow.`;
  }
  if (verb === "resolve" || verb === "select" || verb === "choose") {
    return `Resolves ${targetPhrase} from available runtime context.`;
  }
  if (
    verb === "run" ||
    verb === "execute" ||
    verb === "apply" ||
    verb === "process" ||
    verb === "handle" ||
    verb === "route"
  ) {
    return `Executes ${targetPhrase} as part of this module's control flow.`;
  }
  if (verb === "read" || verb === "load" || verb === "get" || verb === "fetch" || verb === "list") {
    return `Reads ${targetPhrase} needed for this execution step.`;
  }
  if (
    verb === "write" ||
    verb === "save" ||
    verb === "persist" ||
    verb === "append" ||
    verb === "upsert" ||
    verb === "set" ||
    verb === "update" ||
    verb === "record" ||
    verb === "store"
  ) {
    return `Persists ${targetPhrase} with deterministic state semantics.`;
  }
  if (
    verb === "render" ||
    verb === "format" ||
    verb === "map" ||
    verb === "convert" ||
    verb === "serialize" ||
    verb === "deserialize"
  ) {
    return `Transforms ${targetPhrase} into a stable output representation.`;
  }
  if (verb === "start" || verb === "connect" || verb === "schedule") {
    return `Starts ${targetPhrase} within this module's managed runtime lifecycle.`;
  }
  if (verb === "stop" || verb === "disconnect" || verb === "clear" || verb === "cancel") {
    return `Stops or clears ${targetPhrase} to keep runtime state consistent.`;
  }
  if (verb === "delete" || verb === "remove" || verb === "evict") {
    return `Removes ${targetPhrase} according to deterministic lifecycle rules.`;
  }
  if (verb === "migrate" || verb === "promote") {
    return `Migrates ${targetPhrase} to the next deterministic lifecycle state.`;
  }
  if (verb === "compile") {
    return `Compiles ${targetPhrase} into deterministic output artifacts.`;
  }

  return `Implements ${nounPhrase} behavior used by \`${moduleName}\`.`;
}

function inferWhyItExists(
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration,
  functionName: string,
  collaborators: readonly ImportBinding[],
  filePath: string
): string {
  if (ts.isConstructorDeclaration(node)) {
    return "Captures required dependencies at initialization time so runtime behavior remains explicit.";
  }

  const { verb, objectPhrase, nounPhrase } = extractVerbAndObject(functionName);
  const targetPhrase = objectPhrase || "this value";
  if (verb === "normalize" || verb === "parse" || verb === "decode") {
    return `Centralizes normalization rules for ${targetPhrase} so call sites stay aligned.`;
  }
  if (
    verb === "assert" ||
    verb === "validate" ||
    verb === "verify" ||
    verb === "check" ||
    verb === "guard" ||
    verb === "require" ||
    verb === "ensure"
  ) {
    return `Fails fast when ${targetPhrase} is invalid so later control flow stays safe and predictable.`;
  }
  if (verb === "extract" || verb === "infer" || verb === "derive" || verb === "compute") {
    return `Keeps derivation logic for ${targetPhrase} in one place so downstream policy uses the same signal.`;
  }
  if (verb === "find" || verb === "lookup" || verb === "pick" || verb === "next") {
    return `Keeps candidate selection logic for ${targetPhrase} centralized so outcomes stay consistent.`;
  }
  if (verb === "contains") {
    return `Makes ${targetPhrase} containment checks explicit so threshold behavior is easy to audit.`;
  }
  if (verb === "classify") {
    return `Centralizes classification thresholds for ${targetPhrase} so scoring behavior does not drift.`;
  }
  if (verb === "coerce") {
    return `Keeps type-coercion rules for ${targetPhrase} explicit so malformed inputs fail predictably.`;
  }
  if (verb === "split" || verb === "tokenize") {
    return `Maintains one token/segment boundary policy for ${targetPhrase} so lexical decisions stay stable.`;
  }
  if (verb === "send") {
    return `Keeps outbound transport behavior for ${targetPhrase} consistent across runtime call sites.`;
  }
  if (verb === "track" || verb === "register") {
    return `Centralizes lifecycle tracking for ${targetPhrase} so audit and retry flows share one source of truth.`;
  }
  if (verb === "interpret") {
    return `Provides one interpretation path for ${targetPhrase} so policy consumers receive stable typed signals.`;
  }
  if (verb === "sleep") {
    return "Avoids ad-hoc wait behavior by keeping retry/backoff timing in one deterministic helper.";
  }
  if (verb === "default") {
    return `Keeps fallback defaults for ${targetPhrase} centralized so unset-config behavior is predictable.`;
  }
  if (verb === "import") {
    return `Ensures ${targetPhrase} import follows one deterministic migration/bootstrap path.`;
  }
  if (verb === "complete") {
    return `Keeps provider completion behavior for ${targetPhrase} behind a single typed boundary.`;
  }
  if (verb === "cleanup" || verb === "consume") {
    return `Keeps ${targetPhrase} lifecycle mutation logic centralized to reduce drift in state transitions.`;
  }
  if (verb === "approve" || verb === "reject") {
    return `Standardizes ${targetPhrase} vote/result construction so downstream governance handling stays uniform.`;
  }
  if (verb === "reflect") {
    return `Keeps reflection synthesis for ${targetPhrase} deterministic and auditable.`;
  }
  if (verb === "embed") {
    return `Centralizes vectorization behavior for ${targetPhrase} so retrieval scoring remains consistent.`;
  }
  if (
    verb === "evaluate" ||
    verb === "detect" ||
    verb === "is" ||
    verb === "has" ||
    verb === "should" ||
    verb === "can" ||
    verb === "includes" ||
    verb === "matches"
  ) {
    return `Keeps the ${targetPhrase} policy check explicit and testable before side effects.`;
  }
  if (
    verb === "build" ||
    verb === "create" ||
    verb === "make" ||
    verb === "prepare" ||
    verb === "compose" ||
    verb === "generate"
  ) {
    return `Keeps construction of ${targetPhrase} consistent across call sites.`;
  }
  if (verb === "resolve" || verb === "select" || verb === "choose") {
    return `Prevents divergent selection of ${targetPhrase} by keeping rules in one function.`;
  }
  if (
    verb === "run" ||
    verb === "execute" ||
    verb === "apply" ||
    verb === "process" ||
    verb === "handle" ||
    verb === "route"
  ) {
    return `Isolates the ${targetPhrase} runtime step so higher-level orchestration stays readable.`;
  }
  if (verb === "read" || verb === "load" || verb === "get" || verb === "fetch" || verb === "list") {
    return `Separates ${targetPhrase} read-path handling from orchestration and mutation code.`;
  }
  if (
    verb === "write" ||
    verb === "save" ||
    verb === "persist" ||
    verb === "append" ||
    verb === "upsert" ||
    verb === "set" ||
    verb === "update" ||
    verb === "record" ||
    verb === "store"
  ) {
    return `Centralizes ${targetPhrase} mutations for auditability and replay.`;
  }
  if (verb === "to" || verb === "as" || verb === "from") {
    return `Keeps conversion rules for ${targetPhrase} deterministic so callers do not duplicate mapping logic.`;
  }
  if (verb === "sort" || verb === "dedupe" || verb === "merge") {
    return `Maintains stable ordering and deduplication rules for ${targetPhrase} in one place.`;
  }
  if (verb === "empty") {
    return `Provides a single default shape for ${targetPhrase} so callers do not diverge on initialization.`;
  }
  if (verb === "clamp" || verb === "trim" || verb === "strip" || verb === "sanitize") {
    return `Enforces consistent bounds/sanitization for ${targetPhrase} before data flows to policy checks.`;
  }
  if (verb === "start" || verb === "connect" || verb === "schedule") {
    return `Keeps startup sequencing for ${targetPhrase} explicit and deterministic.`;
  }
  if (verb === "stop" || verb === "disconnect" || verb === "clear" || verb === "cancel") {
    return `Centralizes teardown/reset behavior for ${targetPhrase} so lifecycle handling stays predictable.`;
  }
  if (verb === "delete" || verb === "remove" || verb === "evict") {
    return `Ensures ${targetPhrase} removal follows deterministic lifecycle and retention rules.`;
  }
  if (verb === "migrate" || verb === "promote" || verb === "compile") {
    return `Centralizes ${targetPhrase} state-transition logic to keep evolution deterministic and reviewable.`;
  }

  const exported = !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  if (exported) {
    return `Defines public behavior from \`${path.basename(filePath)}\` for other modules/tests.`;
  }
  if (collaborators.length > 0) {
    return `Keeps \`${nounPhrase}\` behavior centralized so collaborating call sites stay consistent.`;
  }
  return `Keeps \`${nounPhrase}\` logic in one place to reduce behavior drift.`;
}

function inferParamDescription(name: string): string {
  const original = name;
  const lower = name.toLowerCase();
  if (lower.endsWith("iso") || lower.endsWith("at") || lower.includes("time") || lower.includes("date")) {
    return "Timestamp used for ordering, timeout, or recency decisions.";
  }
  if (/(^|_)ms$/.test(lower) || /Ms$/.test(original)) {
    return "Duration value in milliseconds.";
  }
  if (lower.startsWith("is") || lower.startsWith("has") || lower.startsWith("should") || lower.startsWith("can")) {
    return "Boolean gate controlling this branch.";
  }
  if (lower.includes("id")) {
    return "Stable identifier used to reference an entity or record.";
  }
  if (lower.includes("path") || lower.includes("file") || lower.includes("dir")) {
    return "Filesystem location used by this operation.";
  }
  if (lower.includes("text") || lower.includes("message") || lower.includes("prompt") || lower.includes("summary")) {
    return "Message/text content processed by this function.";
  }
  if (lower.includes("line")) {
    return "Single text line being parsed or transformed.";
  }
  if (lower.includes("token")) {
    return "Token value used for lexical parsing or matching.";
  }
  if (lower.includes("key")) {
    return "Lookup key or map field identifier.";
  }
  if (lower.includes("request") || lower.includes("input") || lower.includes("payload") || lower.includes("params")) {
    return "Structured input object for this operation.";
  }
  if (lower.includes("result") || lower.includes("response") || lower.includes("output")) {
    return "Result object inspected or transformed in this step.";
  }
  if (lower.includes("context")) {
    return "Runtime context used by this logic.";
  }
  if (lower.includes("config") || lower.includes("policy")) {
    return "Configuration or policy settings applied here.";
  }
  if (lower.includes("options")) {
    return "Optional tuning knobs for this operation.";
  }
  if (
    lower.includes("count") ||
    lower.includes("limit") ||
    lower.includes("max") ||
    lower.includes("min") ||
    lower.includes("index")
  ) {
    return "Numeric bound, counter, or index used by this logic.";
  }
  const words = splitWords(name).join(" ").toLowerCase();
  if (!words || words === "value" || words === "input" || words === "param") {
    return "Primary value processed by this function.";
  }
  return `Value for ${words}.`;
}

function inferReturnDescription(returnType: string | null): string | null {
  if (!returnType || returnType === "void" || returnType === "null") {
    return null;
  }
  const normalized = returnType.toLowerCase();
  if (normalized === "boolean") {
    return "`true` when this check passes.";
  }
  if (normalized === "string") {
    return "Resulting string value.";
  }
  if (normalized === "number") {
    return "Computed numeric value.";
  }
  if (normalized.includes("[]")) {
    return "Ordered collection produced by this step.";
  }
  if (normalized.startsWith("promise<")) {
    return `Promise resolving to ${returnType.slice("Promise<".length, -1)}.`;
  }
  return `Computed \`${returnType}\` result.`;
}

function sanitizeJsDocText(value: string): string {
  return value.replace(/\*\//g, "*\\/").replace(/\s+/g, " ").trim();
}

function buildCommentText(input: {
  functionName: string;
  indent: string;
  newline: string;
  whatItDoes: string;
  whyItExists: string;
  collaborators: readonly ImportBinding[];
  parameterNames: readonly string[];
  returnType: string | null;
}): string {
  const { indent, newline } = input;
  const lines: string[] = [];
  lines.push(`${indent}/**`);
  lines.push(`${indent} * ${sanitizeJsDocText(input.whatItDoes)}`);
  lines.push(`${indent} *`);
  lines.push(`${indent} * **Why it exists:**`);
  lines.push(`${indent} * ${sanitizeJsDocText(input.whyItExists)}`);
  lines.push(`${indent} *`);
  lines.push(`${indent} * **What it talks to:**`);

  if (input.collaborators.length === 0) {
    lines.push(`${indent} * - Uses local constants/helpers within this module.`);
  } else {
    for (const collaborator of input.collaborators.slice(0, 6)) {
      lines.push(
        `${indent} * - Uses \`${sanitizeJsDocText(collaborator.localName)}\` (import \`${sanitizeJsDocText(collaborator.importedName)}\`) from \`${sanitizeJsDocText(collaborator.source)}\`.`
      );
    }
    if (input.collaborators.length > 6) {
      lines.push(`${indent} * - Additional imported collaborators are also used in this function body.`);
    }
  }

  if (input.parameterNames.length > 0) {
    lines.push(`${indent} *`);
    for (const parameterName of input.parameterNames) {
      lines.push(
        `${indent} * @param ${sanitizeJsDocText(parameterName)} - ${sanitizeJsDocText(inferParamDescription(parameterName))}`
      );
    }
  }

  const returnDescription = inferReturnDescription(input.returnType);
  if (returnDescription) {
    lines.push(`${indent} * @returns ${sanitizeJsDocText(returnDescription)}`);
  }

  lines.push(`${indent} */`);
  lines.push("");
  return lines.join(newline);
}

function getJsDocRange(
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration,
  sourceFile: ts.SourceFile,
  sourceText: string
): JsDocRange | null {
  const withDocs = node as ts.Node & { jsDoc?: ts.JSDoc[] };
  const docs = withDocs.jsDoc;
  if (!Array.isArray(docs) || docs.length === 0) {
    return null;
  }

  const firstDoc = docs[0];
  const docStart = firstDoc.getStart(sourceFile);
  const start = readLineStartIndex(sourceText, docStart);
  const nodeStart = readLineStartIndex(sourceText, node.getStart(sourceFile));
  return {
    start,
    end: nodeStart,
    text: sourceText.slice(start, nodeStart)
  };
}

function isLowQualityJsDoc(text: string): boolean {
  const normalized = text.toLowerCase();
  if (LOW_QUALITY_MARKERS.some((marker) => normalized.includes(marker))) {
    return true;
  }
  for (const match of text.matchAll(/@param\s+([A-Za-z0-9_]+)\s+-\s+Duration value in milliseconds\./g)) {
    const paramName = match[1] ?? "";
    if (!/^ms$/i.test(paramName) && !/_ms$/i.test(paramName) && !/Ms$/.test(paramName)) {
      return true;
    }
  }
  if (/implements\s+[`a-z0-9_.\-\s]+\s+helper logic for this module\./i.test(text)) {
    return true;
  }
  if (/no imported collaborators;\s+`[^`]+`\s+relies on local inputs\/constants\./i.test(text)) {
    return true;
  }
  if (/uses additional imported collaborators in this body\./i.test(text)) {
    return true;
  }
  if (/implements\s+`[^`]+`\s+behavior within class\s+[^.\n]+\./i.test(text)) {
    return true;
  }
  if (/initializes class\s+[^.\n]+\s+dependencies and runtime state\./i.test(text)) {
    return true;
  }
  if (/interacts with local collaborators through imported modules and typed inputs\/outputs\./i.test(text)) {
    return true;
  }
  if (
    normalized.includes("returns the default ") &&
    !normalized.includes("**why it exists:**") &&
    !normalized.includes("**what it talks to:**")
  ) {
    return true;
  }
  if (
    normalized.includes("provides module-level behavior from") &&
    !normalized.includes("**what it talks to:**")
  ) {
    return true;
  }
  if (/@returns\s+Value of type `[^`]+` returned to caller\./i.test(text)) {
    return true;
  }
  if (/@returns\s+String output returned by this function\./i.test(text)) {
    return true;
  }
  if (/handles [a-z0-9 _-]+ within `[^`]+` as part of the deterministic runtime workflow\./i.test(normalized)) {
    return true;
  }
  if (/performs the [a-z0-9 _-]+ step used by `[^`]+` runtime flow\./i.test(normalized)) {
    return true;
  }
  if (/@param\s+[a-z0-9_]+\s+-\s+[a-z0-9_ \-]+ supplied by the caller\./i.test(text)) {
    return true;
  }
  if (/@param\s+[a-z0-9_]+\s+-\s+.+ value provided by the caller\./i.test(text)) {
    return true;
  }
  if (/@param\s+[a-z0-9_]+\s+-\s+structured request\/payload provided by the caller\./i.test(text)) {
    return true;
  }
  if (/@param\s+[a-z0-9_]+\s+-\s+text payload consumed or produced by this step\./i.test(text)) {
    return true;
  }
  if (/@param\s+[a-z0-9_]+\s+-\s+value for [a-z0-9_]+\./i.test(text)) {
    return true;
  }
  if (/@param\s+[a-z0-9_]+\s+-\s+[a-z0-9_ ]*value value provided by the caller\./i.test(text)) {
    return true;
  }
  if (/@param\s+[a-z0-9_]+\s+-\s+input value provided by the caller\./i.test(text)) {
    return true;
  }
  return false;
}

function applyFile(filePath: string): { insertions: number; replacements: number } {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const newline = sourceText.includes("\r\n") ? "\r\n" : "\n";
  const imports = buildImportMap(sourceFile);
  const classStack: string[] = [];
  const edits: TextEdit[] = [];
  let insertions = 0;
  let replacements = 0;

  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node)) {
      const className =
        node.name?.text ??
        `AnonymousClass${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`;
      classStack.push(className);
      ts.forEachChild(node, visit);
      classStack.pop();
      return;
    }

    if (isFunctionTarget(node)) {
      const existingDocRange = getJsDocRange(node, sourceFile, sourceText);
      const missingJsDoc = !existingDocRange;
      const shouldRewrite = !!existingDocRange && isLowQualityJsDoc(existingDocRange.text);
      if (missingJsDoc || shouldRewrite) {
        const functionName = normalizeFunctionName(node, classStack, sourceFile);
        const collaborators = collectCollaborators(node, imports);
        const parameterNames = resolveParameterNames(node, sourceFile);
        const returnType = resolveReturnType(node, sourceFile);
        const whatItDoes = inferWhatItDoes(functionName, filePath);
        const whyItExists = inferWhyItExists(node, functionName, collaborators, filePath);
        const nodeStart = readLineStartIndex(sourceText, node.getStart(sourceFile));
        const lineText = sourceText.slice(nodeStart);
        const indent = (/^[ \t]*/.exec(lineText)?.[0] ?? "");
        const comment = buildCommentText({
          functionName,
          indent,
          newline,
          whatItDoes,
          whyItExists,
          collaborators,
          parameterNames,
          returnType
        });

        if (existingDocRange) {
          edits.push({
            start: existingDocRange.start,
            end: existingDocRange.end,
            text: comment
          });
          replacements += 1;
        } else {
          edits.push({
            start: nodeStart,
            end: nodeStart,
            text: comment
          });
          insertions += 1;
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (edits.length === 0) {
    return { insertions: 0, replacements: 0 };
  }

  let updated = sourceText;
  const sortedEdits = [...edits].sort((left, right) => right.start - left.start);
  for (const edit of sortedEdits) {
    updated = `${updated.slice(0, edit.start)}${edit.text}${updated.slice(edit.end)}`;
  }

  writeFileSync(filePath, updated, "utf8");
  return { insertions, replacements };
}

function main(): void {
  const files = collectSourceFiles(SOURCE_ROOT);
  let touchedFiles = 0;
  let totalInsertions = 0;
  let totalReplacements = 0;

  for (const filePath of files) {
    const result = applyFile(filePath);
    if (result.insertions > 0 || result.replacements > 0) {
      touchedFiles += 1;
      totalInsertions += result.insertions;
      totalReplacements += result.replacements;
    }
  }

  console.log(
    `Applied JSDoc updates to ${touchedFiles} src files (${totalInsertions} inserted, ${totalReplacements} rewritten).`
  );
}

main();
