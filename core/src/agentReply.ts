import { parseAgentResult } from './agentResult.js';
import type { AgentResult, AgentStep } from './types.js';

const RESULT_BLOCK = /<factory-result>([\s\S]*?)<\/factory-result>/g;
const DOC_BLOCK = /<factory-doc>([\s\S]*?)<\/factory-doc>/g;

function invalid(reason: string): AgentResult {
  return { status: 'failed', summary: `invalid agent result: ${reason}` };
}

/**
 * Parses an agent's text reply: a JSON `<factory-result>` block and an optional markdown `<factory-doc>` block.
 * Never throws; bad input becomes a `failed` result. Shape rules stay in `parseAgentResult`.
 */
export function parseAgentReply(text: string | undefined, step: AgentStep): AgentResult {
  if (text === undefined) return invalid('no <factory-result> block (reply missing)');
  const results = [...text.matchAll(RESULT_BLOCK)];
  if (results.length === 0) return invalid('no <factory-result> block');
  if (results.length > 1) return invalid('more than one <factory-result> block');
  const docs = [...text.matchAll(DOC_BLOCK)];
  if (docs.length > 1) return invalid('more than one <factory-doc> block');

  const body = results[0]![1]!.trim();
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return invalid('not valid JSON');
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return parseAgentResult(body, step);
  const obj = json as Record<string, unknown>;
  if ('doc' in obj) return invalid('doc belongs in <factory-doc>, not in the <factory-result> JSON');
  const doc = docs[0]?.[1]?.trim();
  if (doc) obj.doc = doc;
  return parseAgentResult(JSON.stringify(obj), step);
}
