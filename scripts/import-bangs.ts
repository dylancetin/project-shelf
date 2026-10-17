import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

// Read Unduck's data as syntax, never execute code from the inspected checkout.
const source = Bun.argv[2];
if (!source) throw new Error('Usage: bun scripts/import-bangs.ts /path/to/unduck/src/bang.ts');
const file = ts.createSourceFile(source, await Bun.file(source).text(), ts.ScriptTarget.Latest, true);
const declaration = file.statements.filter(ts.isVariableStatement)
  .flatMap(statement => [...statement.declarationList.declarations])
  .find(item => ts.isIdentifier(item.name) && item.name.text === 'bangs');
if (!declaration?.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) throw new Error('Expected the bangs array');
const entries = declaration.initializer.elements.map(element => {
  if (!ts.isObjectLiteralExpression(element)) throw new Error('Expected a literal bang entry');
  const fields = new Map(element.properties.filter(ts.isPropertyAssignment).map(property => [property.name.getText(file).replace(/^['"]|['"]$/g, ''), property.initializer]));
  return ['t', 's', 'd', 'u'].map(key => {
    const value = fields.get(key);
    if (!value || !ts.isStringLiteral(value)) throw new Error(`Expected a string literal for ${key}`);
    return value.text;
  });
});
const target = new URL('../src/data/bangs.json', import.meta.url);
await mkdir(path.dirname(target.pathname), { recursive: true });
await Bun.write(target, `${JSON.stringify(entries)}\n`);
console.log(`Imported ${entries.length} bang shortcuts (${Bun.file(target).size} bytes)`);
