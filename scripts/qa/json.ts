function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Index of the bracket closing the one at `start`, string/escape aware; -1 if unbalanced. */
function matchEnd(t: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Pull a JSON value out of model output: plain, ```fenced```, or surrounded by chatter. undefined if none. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const direct = tryParse(t);
  if (direct !== undefined) return direct;

  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  for (const m of t.matchAll(fence)) {
    const v = tryParse(m[1].trim());
    if (v !== undefined) return v;
  }

  let tried = 0;
  for (let i = 0; i < t.length && tried < 8; i++) {
    const c = t[i];
    if (c !== "{" && c !== "[") continue;
    tried++;
    const end = matchEnd(t, i);
    if (end < 0) continue;
    const v = tryParse(t.slice(i, end + 1));
    if (v !== undefined) return v;
  }
  return undefined;
}
