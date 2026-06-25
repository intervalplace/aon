export function stableStringify(x: any): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(",")}]`;

  return `{${Object.keys(x)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(x[k])}`)
    .join(",")}}`;
}

export function assertSameCanonical(a: any, b: any, code: string) {
  if (stableStringify(a) !== stableStringify(b)) {
    throw new Error(code);
  }
}
