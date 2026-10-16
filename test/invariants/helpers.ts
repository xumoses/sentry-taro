import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function readText(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

export function readJson<T = any>(path: string): T {
  return JSON.parse(readText(path)) as T;
}

/** Repository-relative paths of the TypeScript sources under a directory. */
export function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push(relative(root, path).replace(/\\/g, '/'));
      }
    }
  };
  walk(join(root, dir));
  return files.sort();
}

const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/** Module specifiers referenced by static, dynamic and re-export statements. */
export function importsOf(path: string): string[] {
  const source = readText(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1]);
}

/** The package name of a bare specifier, or undefined for relative imports. */
export function packageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return undefined;
  if (specifier.startsWith('node:')) return 'node:';
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export type Layer = 'sdk' | 'replay' | 'taro-plugin' | 'entry';

/** The source layer a relative import from `from` resolves into. */
export function layerOf(from: string, specifier: string): Layer | undefined {
  const target = relative(root, resolve(root, dirname(from), specifier)).replace(/\\/g, '/');
  const match = /^src\/(sdk|replay|taro-plugin)(?:\/|\.ts$|$)/.exec(target);
  if (match) return match[1] as Layer;
  return target.startsWith('src/') ? 'entry' : undefined;
}
