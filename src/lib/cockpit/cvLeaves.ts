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

export function collectCvLeaves(cv: unknown, prefix: CvSegment[] = []): CvLeaf[] {
  if (typeof cv === "string") {
    return [{ path: formatCvPath(prefix), segments: prefix, value: cv }];
  }
  if (Array.isArray(cv)) {
    return cv.flatMap((v, i) => collectCvLeaves(v, [...prefix, i]));
  }
  if (cv && typeof cv === "object") {
    return Object.entries(cv).flatMap(([k, v]) =>
      collectCvLeaves(v, [...prefix, k]),
    );
  }
  return [];
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
