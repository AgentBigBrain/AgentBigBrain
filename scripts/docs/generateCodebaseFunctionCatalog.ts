/**
 * @fileoverview Generates a whole-repo function catalog and suggested JSDoc blocks for undocumented source functions.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT_DIRECTORIES = ["src", "tests", "scripts"] as const;
const OUTPUT_PATH = path.join(process.cwd(), "docs", "CODEBASE_FUNCTION_CATALOG.md");
const OUTPUT_SUGGESTIONS_PATH = path.join(
  process.cwd(),
  "docs",
  "CODEBASE_FUNCTION_JSDOC_SUGGESTIONS.md"
);
const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "runtime",
  ".git",
  ".codex",
  ".github",
  ".vscode"
]);
const NO_JSDOC_SUMMARY = "No JSDoc summary found.";
const MAX_SUMMARY_LENGTH = 220;

interface ImportBinding {
  localName: string;
  importedName: string;
  source: string;
}

interface SignatureInfo {
  signature: string;
  parameters: readonly string[];
  returnType: string | null;
}

interface FunctionRecord {
  line: number;
  name: string;
  kind: string;
  exported: boolean;
  async: boolean;
  static: boolean;
  hasJsDoc: boolean;
  summary: string;
  signature: string;
  parameters: readonly string[];
  returnType: string | null;
  collaborators: ImportBinding[];
}

interface FileRecord {
  path: string;
  root: string;
  overview: string | null;
  importSourceList: readonly string[];
  functions: readonly FunctionRecord[];
}

function collectTypeScriptFiles(rootDirectory: string): string[] {
  const output: string[] = [];

  function walk(currentDirectory: string): void {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) {
        continue;
      }
      output.push(absolutePath);
    }
  }

  walk(rootDirectory);
  output.sort((left, right) => left.localeCompare(right));
  return output;
}

function normalizePathForMarkdown(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function truncateSummary(summary: string): string {
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return NO_JSDOC_SUMMARY;
  }
  if (normalized.length <= MAX_SUMMARY_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_SUMMARY_LENGTH - 3)}...`;
}

function cleanBlockComment(commentBody: string): string {
  const normalizedLines = commentBody
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("@"));
  return truncateSummary(normalizedLines.join(" "));
}

function extractFileOverview(sourceText: string): string | null {
  const match = /\/\*\*[\s\S]*?@fileoverview([\s\S]*?)\*\//.exec(sourceText);
  if (!match?.[1]) {
    return null;
  }
  const cleaned = cleanBlockComment(match[1]);
  return cleaned === NO_JSDOC_SUMMARY ? null : cleaned;
}

function extractNearestJsDocSummary(
  node: ts.Node,
  sourceText: string
): { hasJsDoc: boolean; summary: string } {
  const readNearestFromTrivia = (
    fullStart: number,
    start: number
  ): { hasJsDoc: boolean; summary: string } | null => {
    const leadingText = sourceText.slice(fullStart, start);
    const matches = [...leadingText.matchAll(/\/\*\*([\s\S]*?)\*\//g)];
    if (matches.length === 0) {
      return null;
    }
    const nearestMatch = matches[matches.length - 1];
    return { hasJsDoc: true, summary: cleanBlockComment(nearestMatch?.[1] ?? "") };
  };

  const directMatch = readNearestFromTrivia(node.getFullStart(), node.getStart());
  if (directMatch) {
    return directMatch;
  }

  if (ts.isVariableDeclaration(node)) {
    const declarationList = ts.isVariableDeclarationList(node.parent) ? node.parent : null;
    const statement =
      declarationList && ts.isVariableStatement(declarationList.parent)
        ? declarationList.parent
        : null;
    if (statement) {
      const statementMatch = readNearestFromTrivia(statement.getFullStart(), statement.getStart());
      if (statementMatch) {
        return statementMatch;
      }
    }
  }

  return { hasJsDoc: false, summary: NO_JSDOC_SUMMARY };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiable = node as ts.Node & { modifiers?: readonly ts.Modifier[] };
  return !!modifiable.modifiers?.some((modifier) => modifier.kind === kind);
}

function readPropertyName(node: ts.PropertyName | undefined): string {
  if (!node) {
    return "anonymousMember";
  }
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return node.getText();
}

function buildImportBindingMap(sourceFile: ts.SourceFile): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    if (!statement.importClause) {
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

function functionLabelFromContext(parts: readonly string[]): string {
  if (parts.length === 0) {
    return "";
  }
  return `${parts.join(" > ")} > `;
}

function collectCollaborators(
  node: ts.Node,
  imports: ReadonlyMap<string, ImportBinding>
): ImportBinding[] {
  const collaboratorByKey = new Map<string, ImportBinding>();

  function visit(current: ts.Node): void {
    if (ts.isIdentifier(current)) {
      const collaborator = imports.get(current.text);
      if (collaborator) {
        const key = `${collaborator.source}::${collaborator.importedName}::${collaborator.localName}`;
        collaboratorByKey.set(key, collaborator);
      }
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return [...collaboratorByKey.values()].sort((left, right) => {
    const sourceCompare = left.source.localeCompare(right.source);
    if (sourceCompare !== 0) {
      return sourceCompare;
    }
    return left.localName.localeCompare(right.localName);
  });
}

function inferVariableFunctionKind(node: ts.VariableDeclaration): string | null {
  const initializer = node.initializer;
  if (!initializer) {
    return null;
  }
  if (ts.isArrowFunction(initializer)) {
    return "arrow_function";
  }
  if (ts.isFunctionExpression(initializer)) {
    return "function_expression";
  }
  return null;
}

function readParameterNames(
  parameters: readonly ts.ParameterDeclaration[],
  sourceFile: ts.SourceFile
): string[] {
  return parameters.map((parameter) => {
    if (ts.isIdentifier(parameter.name)) {
      return parameter.name.text;
    }
    return parameter.name.getText(sourceFile);
  });
}

function readSignatureInfo(node: ts.Node, sourceFile: ts.SourceFile): SignatureInfo {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    const params = readParameterNames(node.parameters, sourceFile);
    const argsSignature = params.join(", ");
    const returnType = node.type ? node.type.getText(sourceFile) : "unknown";
    return {
      signature: `(${argsSignature}) => ${returnType}`,
      parameters: params,
      returnType
    };
  }

  if (ts.isConstructorDeclaration(node)) {
    const params = readParameterNames(node.parameters, sourceFile);
    const argsSignature = params.join(", ");
    return {
      signature: `(${argsSignature})`,
      parameters: params,
      returnType: null
    };
  }

  if (ts.isGetAccessorDeclaration(node)) {
    const returnType = node.type ? node.type.getText(sourceFile) : "unknown";
    return {
      signature: `() => ${returnType}`,
      parameters: [],
      returnType
    };
  }

  if (ts.isSetAccessorDeclaration(node)) {
    const params = readParameterNames(node.parameters, sourceFile);
    const argsSignature = params.join(", ");
    return {
      signature: `(${argsSignature}) => void`,
      parameters: params,
      returnType: "void"
    };
  }

  if (ts.isVariableDeclaration(node) && node.initializer) {
    if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
      const params = readParameterNames(node.initializer.parameters, sourceFile);
      const argsSignature = params.join(", ");
      const returnType = node.initializer.type ? node.initializer.type.getText(sourceFile) : "unknown";
      return {
        signature: `(${argsSignature}) => ${returnType}`,
        parameters: params,
        returnType
      };
    }
  }

  return {
    signature: "() => unknown",
    parameters: [],
    returnType: "unknown"
  };
}

function splitIdentifierWords(identifier: string): string[] {
  const normalized = identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return [];
  }
  return normalized.split(" ");
}

function toSentenceCase(text: string): string {
  if (!text) {
    return text;
  }
  return `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}

function extractTerminalFunctionName(label: string): string {
  const scopeTail = label.split(" > ").pop() ?? label;
  const dotTail = scopeTail.split(".").pop() ?? scopeTail;
  const normalized = dotTail.replace(/^get\s+/i, "").replace(/^set\s+/i, "").trim();
  return normalized || scopeTail;
}

function inferPurposeFromName(functionName: string, filePath: string): string {
  const terminalName = extractTerminalFunctionName(functionName);
  const normalizedName = terminalName.toLowerCase();
  const words = splitIdentifierWords(terminalName).join(" ").toLowerCase();
  const fileName = path.basename(filePath);

  const starter = (() => {
    if (normalizedName === "main") {
      return "Orchestrates the module entrypoint flow";
    }
    if (normalizedName.startsWith("normalize")) {
      return "Normalizes input into a stable internal format";
    }
    if (normalizedName.startsWith("parse")) {
      return "Parses input and validates boundary conditions";
    }
    if (normalizedName.startsWith("build") || normalizedName.startsWith("create")) {
      return "Builds a structured value used by downstream logic";
    }
    if (
      normalizedName.startsWith("evaluate") ||
      normalizedName.startsWith("detect") ||
      normalizedName.startsWith("is") ||
      normalizedName.startsWith("has")
    ) {
      return "Evaluates deterministic conditions and returns a policy/decision signal";
    }
    if (normalizedName.startsWith("resolve") || normalizedName.startsWith("select")) {
      return "Resolves a deterministic choice from available context";
    }
    if (normalizedName.startsWith("run") || normalizedName.startsWith("execute")) {
      return "Executes a focused runtime step";
    }
    if (normalizedName.startsWith("render") || normalizedName.startsWith("format")) {
      return "Transforms structured data into a readable output shape";
    }
    if (
      normalizedName.startsWith("read") ||
      normalizedName.startsWith("load") ||
      normalizedName.startsWith("get")
    ) {
      return "Reads and returns data needed for current execution";
    }
    if (
      normalizedName.startsWith("write") ||
      normalizedName.startsWith("save") ||
      normalizedName.startsWith("persist") ||
      normalizedName.startsWith("append") ||
      normalizedName.startsWith("upsert")
    ) {
      return "Persists deterministic state changes for downstream consumers";
    }
    return "Implements focused module behavior";
  })();

  return `${toSentenceCase(starter)} for \`${words || terminalName}\` in \`${fileName}\`.`;
}

function resolvePurpose(record: FunctionRecord, filePath: string): string {
  if (record.hasJsDoc && record.summary !== NO_JSDOC_SUMMARY) {
    return record.summary;
  }
  return inferPurposeFromName(record.name, filePath);
}

function resolveWhyItExists(record: FunctionRecord, filePath: string): string {
  const terminalName = extractTerminalFunctionName(record.name).toLowerCase();
  const fileName = path.basename(filePath);

  if (record.kind === "constructor") {
    return "Initializes class dependencies and runtime state so method behavior remains deterministic.";
  }
  if (terminalName === "main") {
    return "Acts as the execution wrapper for this tool/module entrypoint and coordinates the full local flow.";
  }
  if (record.exported) {
    return `Defines public behavior from \`${fileName}\` that other modules/tests call directly.`;
  }
  if (record.collaborators.length > 0) {
    return "Keeps orchestration modular by isolating local logic that coordinates imported collaborators.";
  }
  return `Keeps \`${fileName}\` readable and testable by isolating a focused helper behavior.`;
}

function extractFunctionRecords(
  sourceFile: ts.SourceFile,
  sourceText: string,
  imports: ReadonlyMap<string, ImportBinding>
): FunctionRecord[] {
  const records: FunctionRecord[] = [];
  const classStack: string[] = [];
  const functionStack: string[] = [];

  function pushFunctionRecord(
    node: ts.Node,
    label: string,
    kind: string,
    exported: boolean,
    asyncFunction: boolean,
    staticMember: boolean
  ): void {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const docSummary = extractNearestJsDocSummary(node, sourceText);
    const signature = readSignatureInfo(node, sourceFile);
    const collaborators = collectCollaborators(node, imports);
    records.push({
      line: position.line + 1,
      name: label,
      kind,
      exported,
      async: asyncFunction,
      static: staticMember,
      hasJsDoc: docSummary.hasJsDoc,
      summary: docSummary.summary,
      signature: signature.signature,
      parameters: signature.parameters,
      returnType: signature.returnType,
      collaborators
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node)) {
      const className =
        node.name?.text ??
        `AnonymousClass@${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`;
      classStack.push(className);
      ts.forEachChild(node, visit);
      classStack.pop();
      return;
    }

    let stackLabelForChildren: string | null = null;

    if (ts.isFunctionDeclaration(node)) {
      const functionName =
        node.name?.text ??
        `anonymousFunction@${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`;
      const label = `${functionLabelFromContext(functionStack)}${functionName}`;
      pushFunctionRecord(
        node,
        label,
        "function_declaration",
        hasModifier(node, ts.SyntaxKind.ExportKeyword),
        hasModifier(node, ts.SyntaxKind.AsyncKeyword),
        false
      );
      stackLabelForChildren = functionName;
    } else if (ts.isMethodDeclaration(node)) {
      const className = classStack[classStack.length - 1] ?? "AnonymousClass";
      const methodName = readPropertyName(node.name);
      const label = `${className}.${methodName}`;
      pushFunctionRecord(
        node,
        label,
        "method_declaration",
        hasModifier(node, ts.SyntaxKind.ExportKeyword),
        hasModifier(node, ts.SyntaxKind.AsyncKeyword),
        hasModifier(node, ts.SyntaxKind.StaticKeyword)
      );
      stackLabelForChildren = label;
    } else if (ts.isConstructorDeclaration(node)) {
      const className = classStack[classStack.length - 1] ?? "AnonymousClass";
      const label = `${className}.constructor`;
      pushFunctionRecord(
        node,
        label,
        "constructor",
        hasModifier(node, ts.SyntaxKind.ExportKeyword),
        false,
        false
      );
      stackLabelForChildren = label;
    } else if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      const className = classStack[classStack.length - 1] ?? "AnonymousClass";
      const accessorName = readPropertyName(node.name);
      const prefix = ts.isGetAccessorDeclaration(node) ? "get" : "set";
      const label = `${className}.${prefix} ${accessorName}`;
      pushFunctionRecord(
        node,
        label,
        ts.isGetAccessorDeclaration(node) ? "get_accessor" : "set_accessor",
        hasModifier(node, ts.SyntaxKind.ExportKeyword),
        false,
        hasModifier(node, ts.SyntaxKind.StaticKeyword)
      );
      stackLabelForChildren = label;
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const functionKind = inferVariableFunctionKind(node);
      if (functionKind) {
        const parentStatement =
          ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent)
            ? node.parent.parent
            : null;
        const variableName = node.name.text;
        const label = `${functionLabelFromContext(functionStack)}${variableName}`;
        const initializer = node.initializer;
        const isAsyncInitializer =
          !!initializer &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
          (initializer.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ??
            false);
        pushFunctionRecord(
          node,
          label,
          functionKind,
          parentStatement ? hasModifier(parentStatement, ts.SyntaxKind.ExportKeyword) : false,
          isAsyncInitializer,
          false
        );
        stackLabelForChildren = variableName;
      }
    }

    if (stackLabelForChildren) {
      functionStack.push(stackLabelForChildren);
      ts.forEachChild(node, visit);
      functionStack.pop();
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return records.sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
}

function escapeTableCell(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatCollaborators(collaborators: readonly ImportBinding[]): string {
  if (collaborators.length === 0) {
    return "none";
  }
  return collaborators
    .map(
      (collaborator) =>
        `\`${collaborator.localName}\` <- \`${collaborator.importedName}\` @ \`${collaborator.source}\``
    )
    .join("<br/>");
}

function formatCollaboratorsAsBullets(collaborators: readonly ImportBinding[]): string[] {
  if (collaborators.length === 0) {
    return ["- None (local helper logic only)."];
  }
  return collaborators.map(
    (collaborator) =>
      `- Uses \`${collaborator.localName}\` (import \`${collaborator.importedName}\`) from \`${collaborator.source}\`.`
  );
}

function renderCatalog(records: readonly FileRecord[]): string {
  const generatedAt = new Date().toISOString();
  const groupedByRoot = new Map<string, FileRecord[]>();

  for (const record of records) {
    const list = groupedByRoot.get(record.root) ?? [];
    list.push(record);
    groupedByRoot.set(record.root, list);
  }

  const lines: string[] = [];
  lines.push("# Codebase Function Catalog");
  lines.push("");
  lines.push(`Generated at: \`${generatedAt}\``);
  lines.push("Scope: `src/`, `tests/`, `scripts/`");
  lines.push(
    "Method: TypeScript AST extraction. `What it does` uses source JSDoc when present, otherwise deterministic name-based inference."
  );
  lines.push("");
  lines.push("## Coverage");
  for (const root of ROOT_DIRECTORIES) {
    const rootFiles = groupedByRoot.get(root) ?? [];
    const rootFunctions = rootFiles.flatMap((file) => file.functions);
    const missingJsDocCount = rootFunctions.filter((fn) => !fn.hasJsDoc).length;
    lines.push(
      `- \`${root}\`: ${rootFiles.length} files, ${rootFunctions.length} functions, ${missingJsDocCount} missing source JSDoc`
    );
  }
  lines.push("");

  for (const root of ROOT_DIRECTORIES) {
    const rootFiles = (groupedByRoot.get(root) ?? []).sort((left, right) =>
      left.path.localeCompare(right.path)
    );
    if (rootFiles.length === 0) {
      continue;
    }

    lines.push(`## ${root}`);
    lines.push("");
    for (const record of rootFiles) {
      lines.push(`### \`${record.path}\``);
      if (record.overview) {
        lines.push(`File overview: ${record.overview}`);
      } else {
        lines.push("File overview: none");
      }
      if (record.importSourceList.length > 0) {
        lines.push(
          `Module collaborators: ${record.importSourceList
            .map((moduleName) => `\`${moduleName}\``)
            .join(", ")}`
        );
      } else {
        lines.push("Module collaborators: none");
      }
      lines.push("");
      lines.push(
        "| Line | Function | Kind | Signature | What it does | Why it exists | What it talks to | JSDoc |"
      );
      lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
      if (record.functions.length === 0) {
        lines.push("| - | - | - | - | No function declarations detected. | - | - | - |");
      } else {
        for (const fn of record.functions) {
          const purpose = resolvePurpose(fn, record.path);
          const whyItExists = resolveWhyItExists(fn, record.path);
          lines.push(
            `| ${fn.line} | \`${escapeTableCell(fn.name)}\` | \`${fn.kind}\` | \`${escapeTableCell(
              fn.signature
            )}\` | ${escapeTableCell(purpose)} | ${escapeTableCell(
              whyItExists
            )} | ${escapeTableCell(formatCollaborators(fn.collaborators))} | ${fn.hasJsDoc ? "present" : "missing"} |`
          );
        }
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderSuggestions(records: readonly FileRecord[]): string {
  const generatedAt = new Date().toISOString();
  const sourceFiles = records.filter((record) => record.root === "src");
  const undocumentedEntries = sourceFiles
    .map((record) => ({
      filePath: record.path,
      functions: record.functions.filter((fn) => !fn.hasJsDoc)
    }))
    .filter((record) => record.functions.length > 0)
    .sort((left, right) => left.filePath.localeCompare(right.filePath));

  const lines: string[] = [];
  lines.push("# Codebase Function JSDoc Suggestions");
  lines.push("");
  lines.push(`Generated at: \`${generatedAt}\``);
  lines.push(
    "Scope: `src/` functions currently missing source JSDoc. Use these blocks as starting templates and refine wording as needed."
  );
  lines.push("");
  lines.push(`Undocumented source functions: \`${undocumentedEntries.reduce((sum, entry) => sum + entry.functions.length, 0)}\``);
  lines.push("");

  for (const entry of undocumentedEntries) {
    lines.push(`## \`${entry.filePath}\``);
    lines.push("");
    for (const fn of entry.functions) {
      const purpose = resolvePurpose(fn, entry.filePath);
      const whyItExists = resolveWhyItExists(fn, entry.filePath);
      const collaboratorBullets = formatCollaboratorsAsBullets(fn.collaborators);
      lines.push(`### \`${fn.name}\` (line ${fn.line})`);
      lines.push(`Signature: \`${fn.signature}\``);
      lines.push("");
      lines.push("```ts");
      lines.push("/**");
      lines.push(` * ${purpose}`);
      lines.push(" *");
      lines.push(" * **Why it exists:**");
      lines.push(` * ${whyItExists}`);
      lines.push(" *");
      lines.push(" * **What it talks to:**");
      for (const bullet of collaboratorBullets) {
        lines.push(` * ${bullet}`);
      }
      if (fn.parameters.length > 0) {
        lines.push(" *");
        for (const parameter of fn.parameters) {
          lines.push(` * @param ${parameter} - TODO: describe ${parameter}.`);
        }
      }
      if (fn.returnType && fn.returnType !== "void" && fn.returnType !== "null") {
        lines.push(` * @returns TODO: describe the \`${fn.returnType}\` result.`);
      }
      lines.push(" */");
      lines.push("```");
      lines.push("");
    }
  }

  if (undocumentedEntries.length === 0) {
    lines.push("All `src/` functions already contain JSDoc.");
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function buildFileRecord(root: string, absoluteFilePath: string): FileRecord {
  const sourceText = readFileSync(absoluteFilePath, "utf8");
  const sourceFile = ts.createSourceFile(
    absoluteFilePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true
  );
  const importBindings = buildImportBindingMap(sourceFile);
  const importSourceList = [...new Set([...importBindings.values()].map((binding) => binding.source))].sort(
    (left, right) => left.localeCompare(right)
  );
  const functions = extractFunctionRecords(sourceFile, sourceText, importBindings);
  return {
    path: normalizePathForMarkdown(path.relative(process.cwd(), absoluteFilePath)),
    root,
    overview: extractFileOverview(sourceText),
    importSourceList,
    functions
  };
}

function main(): void {
  const fileRecords: FileRecord[] = [];

  for (const root of ROOT_DIRECTORIES) {
    const absoluteRoot = path.join(process.cwd(), root);
    if (!existsSync(absoluteRoot)) {
      continue;
    }
    const files = collectTypeScriptFiles(absoluteRoot);
    for (const filePath of files) {
      fileRecords.push(buildFileRecord(root, filePath));
    }
  }

  fileRecords.sort((left, right) => left.path.localeCompare(right.path));
  const catalogMarkdown = renderCatalog(fileRecords);
  const suggestionsMarkdown = renderSuggestions(fileRecords);

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, catalogMarkdown, "utf8");
  writeFileSync(OUTPUT_SUGGESTIONS_PATH, suggestionsMarkdown, "utf8");

  const totalFunctions = fileRecords.reduce((total, record) => total + record.functions.length, 0);
  const missingSourceJsDoc = fileRecords
    .filter((record) => record.root === "src")
    .flatMap((record) => record.functions)
    .filter((fn) => !fn.hasJsDoc).length;
  console.log(
    `Generated ${normalizePathForMarkdown(path.relative(process.cwd(), OUTPUT_PATH))} (${fileRecords.length} files, ${totalFunctions} functions).`
  );
  console.log(
    `Generated ${normalizePathForMarkdown(path.relative(process.cwd(), OUTPUT_SUGGESTIONS_PATH))} (missing src JSDoc entries: ${missingSourceJsDoc}).`
  );
}

main();
