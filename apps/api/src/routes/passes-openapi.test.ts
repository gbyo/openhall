import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const documentPath = path.join(root, 'openapi', 'openapi.json');

interface OpenApiDocument {
  paths: Record<string, Record<string, Operation>>;
}

interface Operation {
  operationId?: string;
  security?: Record<string, string[]>[];
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { schema?: { required?: string[] } }> };
  responses?: Record<string, { description?: string }>;
  description?: string;
}

interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  schema?: Record<string, unknown>;
}

async function loadDocument(): Promise<OpenApiDocument> {
  return JSON.parse(await readFile(documentPath, 'utf8')) as OpenApiDocument;
}

function operation(doc: OpenApiDocument, path: string, method: string): Operation {
  const operation = doc.paths[path]?.[method];
  if (operation === undefined) throw new Error(`Missing ${method.toUpperCase()} ${path}`);
  return operation;
}

function parameterNames(operation: Operation, location: string): string[] {
  return (operation.parameters ?? []).filter((p) => p.in === location).map((p) => p.name);
}

describe('Phase 5 pass OpenAPI surface', () => {
  it('exposes stable pass operation IDs', async () => {
    const doc = await loadDocument();
    expect(operation(doc, '/api/v1/me/passes', 'post').operationId).toBe('requestMyPass');
    expect(operation(doc, '/api/v1/students/{studentId}/passes', 'post').operationId).toBe(
      'requestStudentPass',
    );
    expect(operation(doc, '/api/v1/me/passes/active', 'get').operationId).toBe('getMyActivePass');
    expect(operation(doc, '/api/v1/me/passes/{passId}/cancel', 'post').operationId).toBe(
      'cancelMyPass',
    );
  });

  it('requires cookie auth everywhere and CSRF on POST commands', async () => {
    const doc = await loadDocument();
    for (const [path, method] of [
      ['/api/v1/me/passes', 'post'],
      ['/api/v1/students/{studentId}/passes', 'post'],
      ['/api/v1/me/passes/active', 'get'],
      ['/api/v1/me/passes/{passId}/cancel', 'post'],
    ] as const) {
      const op = operation(doc, path, method);
      const schemes = (op.security ?? []).flatMap((entry) => Object.keys(entry));
      expect(schemes).toContain('cookieAuth');
    }
    for (const [path, method] of [
      ['/api/v1/me/passes', 'post'],
      ['/api/v1/students/{studentId}/passes', 'post'],
      ['/api/v1/me/passes/{passId}/cancel', 'post'],
    ] as const) {
      const schemes = (operation(doc, path, method).security ?? []).flatMap((entry) =>
        Object.keys(entry),
      );
      expect(schemes).toContain('csrfHeader');
    }
    const activeSchemes = (
      operation(doc, '/api/v1/me/passes/active', 'get').security ?? []
    ).flatMap((entry) => Object.keys(entry));
    expect(activeSchemes).not.toContain('csrfHeader');
  });

  it('requires Idempotency-Key on POST commands and If-Match on cancellation', async () => {
    const doc = await loadDocument();
    for (const [path, method] of [
      ['/api/v1/me/passes', 'post'],
      ['/api/v1/students/{studentId}/passes', 'post'],
      ['/api/v1/me/passes/{passId}/cancel', 'post'],
    ] as const) {
      expect(parameterNames(operation(doc, path, method), 'header')).toContain('idempotency-key');
    }
    expect(
      parameterNames(operation(doc, '/api/v1/me/passes/{passId}/cancel', 'post'), 'header'),
    ).toContain('if-match');
  });

  it('documents 412 and 428 on cancellation and describes ETag semantics', async () => {
    const doc = await loadDocument();
    const cancel = operation(doc, '/api/v1/me/passes/{passId}/cancel', 'post');
    expect(Object.keys(cancel.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '412', '428']),
    );
    for (const [path, method] of [
      ['/api/v1/me/passes', 'post'],
      ['/api/v1/students/{studentId}/passes', 'post'],
      ['/api/v1/me/passes/active', 'get'],
      ['/api/v1/me/passes/{passId}/cancel', 'post'],
    ] as const) {
      expect(operation(doc, path, method).description).toMatch(/ETag/);
    }
    const request = operation(doc, '/api/v1/me/passes', 'post');
    expect(request.description).toMatch(/Idempotency-Key/);
    expect(request.description).toMatch(/not a finalized IETF RFC/);
  });

  it('exposes no future approve/depart/queue HTTP commands', async () => {
    const doc = await loadDocument();
    const passPaths = Object.keys(doc.paths).filter((key) => key.includes('/passes'));
    expect(passPaths.sort()).toEqual(
      [
        '/api/v1/me/passes',
        '/api/v1/me/passes/active',
        '/api/v1/me/passes/{passId}/cancel',
        '/api/v1/students/{studentId}/passes',
      ].sort(),
    );
  });
});
