import { jsonSchema, type JSONSchema7, type Schema } from 'ai';
import { z } from 'zod';

// Centralized input-schema wrapper for in-app AI tools. The JSON schema handed
// to the model is derived from the same zod shape (so `required`/`description`/
// constraints are unchanged), but validation failures are reported with a
// human-readable message that NAMES the offending parameter(s) and asks the
// model to retry with every required field — instead of the raw zod text. This
// matters for parallel tool-call batches where the model tends to drop a
// repeated id like `pageId`.

// Fixed, actionable hint appended to every validation error. Kept as a constant
// so the message stays deterministic and the spec can assert on it verbatim.
const RETRY_HINT =
  'Include every REQUIRED parameter and retry; when issuing parallel tool ' +
  'calls, do not drop ids like "pageId".';

/**
 * Turn a zod validation error into a concise, model-friendly message that names
 * each offending parameter (by its dotted path; the root object is "(root)"),
 * gives a short reason, and ends with the fixed retry hint. Repeated parameter
 * names are de-duplicated and the output is deterministic.
 */
export function formatIssues(error: z.ZodError): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const issue of error.issues) {
    const name =
      Array.isArray(issue.path) && issue.path.length > 0
        ? issue.path.join('.')
        : '(root)';
    if (seen.has(name)) continue;
    seen.add(name);
    // Prefer zod's own message (e.g. "Invalid input: expected string, received
    // undefined"); fall back to a generic reason when it is missing.
    const reason = issue.message ? issue.message : 'missing or invalid';
    parts.push(`parameter "${name}": ${reason}`);
  }
  const summary = parts.length > 0 ? parts.join('; ') : 'invalid tool input';
  return `Invalid tool input — ${summary}. ${RETRY_HINT}`;
}

/**
 * Build an AI SDK `Schema` from a zod raw shape. The JSON schema exposed to the
 * model is derived from the zod object (preserving `required`, `description`,
 * and field constraints), so the required/optional contract is UNCHANGED. On a
 * validation failure we return a model-friendly error (see `formatIssues`); on
 * success we return the PARSED data, which has unknown keys stripped by zod —
 * this preserves the existing strip guardrails (e.g. deletePage never forwards
 * permanentlyDelete/forceDelete; transformPage never forwards deleteComments).
 */
export function modelFriendlyInput<Shape extends z.ZodRawShape>(
  shape: Shape,
): Schema<z.infer<z.ZodObject<Shape>>> {
  const object = z.object(shape);
  // draft-07 JSON schema for the model (keeps required/description/constraints).
  const schema = z.toJSONSchema(object, { target: 'draft-7' }) as JSONSchema7;
  return jsonSchema<z.infer<typeof object>>(schema, {
    validate: (value: unknown) => {
      const result = object.safeParse(value);
      if (result.success) {
        // Return the PARSED (unknown-key-stripped) data so the SDK forwards a
        // clean object to execute — preserves the existing strip guardrails.
        return { success: true as const, value: result.data };
      }
      return {
        success: false as const,
        error: new Error(formatIssues(result.error)),
      };
    },
  });
}
