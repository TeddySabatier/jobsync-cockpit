// String leaves of cvJson for the edit form (cockpit/SPEC.md §5.4). Only string
// values are editable; keys, array lengths and non-string values are not. The
// server enforces the same rule (compareCv in packages.ts).

export type CvSegment = string | number;
export type CvLeaf = { path: string; segments: CvSegment[]; value: string };

// ["experience", 0, "bullets", 2] -> "experience[0].bullets[2]"
export function formatCvPath(segments: CvSegment[]): string {
  return segments.reduce<string>(
    (acc, s) =>
      typeof s === "number" ? `${acc}[${s}]` : acc ? `${acc}.${s}` : s,
    "",
  );
}

// The one cvJson walker: every leaf with its segments. A leaf is any
// non-container value, or an empty array / object (so it still has a place in
// the shape). Only own keys are walked (Object.entries), so a "__proto__" or
// "toString" key is just a key. Shared by collectCvLeaves (edit form) and
// compareCv (server shape check).
export function walkCvLeaves(
  cv: unknown,
  prefix: CvSegment[] = [],
): Array<{ segments: CvSegment[]; value: unknown }> {
  const children: Array<[CvSegment, unknown]> = Array.isArray(cv)
    ? cv.map((v, i) => [i, v])
    : cv && typeof cv === "object"
      ? Object.entries(cv)
      : [];
  if (children.length === 0) return [{ segments: prefix, value: cv }];
  return children.flatMap(([k, v]) => walkCvLeaves(v, [...prefix, k]));
}

export function collectCvLeaves(cv: unknown): CvLeaf[] {
  return walkCvLeaves(cv).flatMap(({ segments, value }) =>
    typeof value === "string"
      ? [{ path: formatCvPath(segments), segments, value }]
      : [],
  );
}

// Returns a copy with one string leaf replaced; the input is not mutated.
// Rebuilt with fromEntries so a "__proto__" key stays an own property.
export function setCvLeaf(
  cv: unknown,
  segments: CvSegment[],
  value: string,
  i = 0,
): unknown {
  if (i === segments.length) return value;
  const seg = segments[i];
  if (Array.isArray(cv)) {
    return cv.map((v, idx) =>
      idx === seg ? setCvLeaf(v, segments, value, i + 1) : v,
    );
  }
  if (cv && typeof cv === "object") {
    return Object.fromEntries(
      Object.entries(cv).map(([k, v]) => [
        k,
        k === seg ? setCvLeaf(v, segments, value, i + 1) : v,
      ]),
    );
  }
  return cv;
}
