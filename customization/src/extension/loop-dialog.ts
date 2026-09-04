export function isLoopFollowUpCancellation(transcript: string): boolean {
  return /^(?:cancel|never mind|nevermind|stop listening|forget it)$/i.test(transcript.trim());
}

export function buildLoopFollowUpCommand(transcript: string): string {
  const answer = stripWakePhrase(transcript).trim().replace(/[.!?]+$/g, "");
  if (/^(?:loop|repeat)\b/i.test(answer)) return answer;
  if (/^from\s+.+\s+(?:to|until|through)\s+.+$/i.test(answer)) return `loop ${answer}`;

  const explicitRange = answer.match(/^start (?:at|from) (.+?) (?:and )?end (?:at|on) (.+)$/i);
  if (explicitRange) return `loop from ${explicitRange[1]} to ${explicitRange[2]}`;

  const bareRange = answer.match(/^(.+?)\s+(?:to|until|through)\s+(.+)$/i);
  if (bareRange && /\d|seconds?|minutes?|\d{1,2}:\d{2}/i.test(answer)) {
    return `loop from ${bareRange[1]} to ${bareRange[2]}`;
  }

  const lyrics = answer.replace(/^(?:the )?(?:lyrics?|words?|line)(?: are| is| starting with| from)?\s+/i, "");
  return `loop the part starting with ${lyrics}`;
}

function stripWakePhrase(transcript: string): string {
  return transcript.trim().replace(/^(?:hey\s+)?monday\b[\s,.:;-]*/i, "").trim();
}
