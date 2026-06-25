import { z } from 'zod';
import { modelFriendlyInput } from './model-friendly-input';

/**
 * Unit tests for the model-friendly input wrapper (issue #190): validation
 * failures must report a human-readable, parameter-naming message (not the raw
 * zod text), successful validation must strip unknown keys (preserving the
 * strip guardrails), and the JSON schema handed to the model must keep the
 * required/optional contract and field descriptions intact.
 */
describe('modelFriendlyInput', () => {
  // A representative shape: a required id + description, plus an optional field.
  const shape = {
    pageId: z.string().describe('The id of the page to comment on.'),
    content: z.string(),
    limit: z.number().int().optional(),
  };

  // The AI SDK `Schema` exposes a `validate` callback and a `jsonSchema` field;
  // type them loosely for the test.
  type SchemaLike = {
    validate?: (
      v: unknown,
    ) =>
      | { success: boolean; value?: Record<string, unknown>; error?: Error }
      | PromiseLike<{
          success: boolean;
          value?: Record<string, unknown>;
          error?: Error;
        }>;
    jsonSchema: unknown;
  };

  it('reports a model-friendly error naming the missing REQUIRED param + retry hint', async () => {
    const schema = modelFriendlyInput(shape) as unknown as SchemaLike;
    // Drop the required `pageId` (the parallel-batch failure mode).
    const result = await schema.validate!({ content: 'hi' });

    expect(result.success).toBe(false);
    const message = result.error?.message ?? '';
    // Names the offending parameter by name.
    expect(message).toContain('pageId');
    // Carries the fixed actionable retry hint.
    expect(message).toContain('Include every REQUIRED parameter and retry');
    expect(message).toContain('do not drop ids like "pageId"');
    // It must NOT be the bare raw zod text alone — our wrapper prefix is present.
    expect(message).toContain('Invalid tool input');
  });

  it('accepts valid input and STRIPS unknown keys (keeps declared ones)', async () => {
    const schema = modelFriendlyInput(shape) as unknown as SchemaLike;
    const result = await schema.validate!({
      pageId: 'p-1',
      content: 'hello',
      // An extra unknown key a (compromised) model might emit.
      permanentlyDelete: true,
    });

    expect(result.success).toBe(true);
    expect(result.value).toEqual({ pageId: 'p-1', content: 'hello' });
    expect(result.value).not.toHaveProperty('permanentlyDelete');
  });

  it('produces a draft-07 JSON schema that preserves required + descriptions', async () => {
    const schema = modelFriendlyInput(shape) as unknown as SchemaLike;
    // jsonSchema may be a value or a promise; await either way.
    const json = (await Promise.resolve(schema.jsonSchema)) as {
      required?: string[];
      properties?: Record<string, { description?: string }>;
    };

    // Required contract preserved: pageId + content required, limit optional.
    expect(json.required).toEqual(expect.arrayContaining(['pageId', 'content']));
    expect(json.required).not.toContain('limit');
    // Field description preserved.
    expect(json.properties?.pageId?.description).toBe(
      'The id of the page to comment on.',
    );
  });

  it('handles a root-level type error with a "(root)" parameter name', async () => {
    const schema = modelFriendlyInput(shape) as unknown as SchemaLike;
    // Passing a non-object yields an issue with an empty path.
    const result = await schema.validate!('not an object');

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('(root)');
  });
});
