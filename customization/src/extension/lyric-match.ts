export interface TimedLyricLine {
  startTimeMs: number;
  words: string;
}

export interface LyricMatch {
  index: number;
  score: number;
  text: string;
}

export interface SectionPhraseIntent {
  startPhrase: string;
  endPhrase?: string;
}

export function parseSectionPhraseIntent(command: string): SectionPhraseIntent | null {
  const explicit = command.match(
    /^(?:loop|repeat)(?: the)?(?: part| section| verse| chorus)? from ["“']?(.+?)["”']? (?:until|through|to) ["“']?(.+?)["”']?$/i
  );
  if (explicit) return { startPhrase: cleanPhrase(explicit[1]), endPhrase: cleanPhrase(explicit[2]) };

  const requested = command.match(
    /^(?:please )?(?:loop|repeat)(?: the)?(?: part| section| verse| chorus)?(?: that)? (?:starts?|starting|begins?|beginning) (?:from|with|at)(?: the)?(?: words?|line|lyrics?)?(?: such as)? ["“']?(.+?)["”']?$/i
  );
  if (requested) return { startPhrase: cleanPhrase(requested[1]) };

  const conversational = command.match(
    /^(?:in (?:this|the) song[, ]*)?(?:there (?:is|'s) (?:a )?part (?:where|that) )?(?:it )?(?:starts?|starting|begins?|beginning) (?:from|with|at)(?: the)?(?: words?|line|lyrics?)?(?: such as)? ["“']?(.+?)["”']?$/i
  );
  return conversational ? { startPhrase: cleanPhrase(conversational[1]) } : null;
}

export function findBestLyricMatch(
  lines: TimedLyricLine[],
  phrase: string,
  afterIndex = -1
): LyricMatch | null {
  const wanted = normalizeLyricText(phrase);
  if (!wanted) return null;

  let best: LyricMatch | null = null;
  for (let index = Math.max(0, afterIndex + 1); index < lines.length; index++) {
    for (let lineCount = 1; lineCount <= 3 && index + lineCount <= lines.length; lineCount++) {
      const text = lines.slice(index, index + lineCount).map((line) => line.words).join(" ");
      // Prefer the smallest matching window so repeated phrases resolve to their true line.
      const score = phraseSimilarity(wanted, normalizeLyricText(text)) - (lineCount - 1) * 0.03;
      if (!best || score > best.score) best = { index, score, text };
    }
  }
  return best;
}

export function chooseDefaultLoopEnd(lines: TimedLyricLine[], startIndex: number, durationMs: number): number {
  const start = lines[startIndex]?.startTimeMs ?? 0;
  const earliest = start + 7_000;
  const latest = Math.min(durationMs, start + 14_000);
  const boundary = lines.find((line, index) => index > startIndex && line.startTimeMs >= earliest)?.startTimeMs;
  return Math.max(start + 2_000, Math.min(boundary ?? latest, latest));
}

export function normalizeLyricText(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function phraseSimilarity(wanted: string, candidate: string): number {
  if (!candidate) return 0;
  if (candidate.includes(wanted)) return 1;

  const wantedTokens = wanted.split(" ");
  const candidateTokens = candidate.split(" ");
  const candidateSet = new Set(candidateTokens);
  const covered = wantedTokens.filter((token) => candidateSet.has(token)).length;
  const coverage = covered / wantedTokens.length;
  const precision = covered / candidateTokens.length;
  const tokenScore = coverage * 0.82 + precision * 0.18;
  const editScore = 1 - levenshteinDistance(wanted, candidate) / Math.max(wanted.length, candidate.length, 1);
  return Math.max(0, Math.min(1, Math.max(tokenScore, editScore)));
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const above = previous[rightIndex];
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function cleanPhrase(value: string): string {
  return value.trim().replace(/[.,!?;:]+$/g, "").trim();
}
