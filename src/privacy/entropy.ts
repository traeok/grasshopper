export function shannon(s: string): number {
  if (s.length === 0) return 0;

  const counts = new Map<string, number>();
  let length = 0;
  for (const char of s) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
    length++;
  }

  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

export function findHighEntropyTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(/[A-Za-z0-9+/_=-]{24,}/g)) {
    const token = match[0];
    if (!/[0-9]/.test(token) || !/[A-Z]/.test(token) || !/[a-z]/.test(token)) continue;

    let slashes = 0;
    for (const char of token) {
      if (char === "/") slashes++;
      if (slashes > 2) break;
    }
    if (slashes <= 2 && shannon(token) >= 4.2) tokens.push(token);
  }
  return tokens;
}
