import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const boundaries: Readonly<Record<string, readonly RegExp[]>> = {
  'packages/domain': [
    /@openhall\/(application|contracts|db|config|test-support)/,
    /from ['"](fastify|kysely|pg|react)/,
  ],
  'packages/application': [
    /@openhall\/(contracts|db|config|test-support)/,
    /from ['"](fastify|kysely|pg|react)/,
    // Phase 3: the OIDC protocol adapter lives behind a port in the API
    // composition root; openid-client and Node HTTP infrastructure must
    // not cross into application services.
    /from ['"]openid-client/,
    /from ['"]node:http/,
  ],
  'packages/contracts': [
    /@openhall\/(domain|application|db|config|test-support)/,
    /from ['"](fastify|kysely|pg|react)/,
  ],
  'packages/config': [/@openhall\//, /from ['"](fastify|kysely|pg|react)/],
};

async function TypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return TypeScriptFiles(fullPath);
      return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [fullPath] : [];
    }),
  );
  return files.flat();
}

describe('architectural dependency direction', () => {
  for (const [relativeDirectory, forbiddenPatterns] of Object.entries(boundaries)) {
    it(`${relativeDirectory} does not cross inward boundaries`, async () => {
      const violations: string[] = [];
      for (const file of await TypeScriptFiles(path.join(root, relativeDirectory, 'src'))) {
        const source = await readFile(file, 'utf8');
        for (const pattern of forbiddenPatterns) {
          if (pattern.test(source))
            violations.push(`${path.relative(root, file)}: ${pattern.source}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
