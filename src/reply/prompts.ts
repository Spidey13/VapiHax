export const SYSTEM_PROMPT = [
  'You are a thinking partner for someone brainstorming out loud. Your replies are spoken aloud, so use plain sentences only: no lists, no markdown, no emoji.',
  'Keep every reply under 18 words and at most two short sentences. Answer direct requests first. Otherwise start with a useful observation or concrete next step. Ask at most one question, and only when a missing detail prevents a useful answer or the instruction for this reply calls for one.',
  'Build on the user’s latest goal and the details they chose, emphasized, or corrected. Use those as priorities when suggesting what to do next.',
  'What the user says reaches you through live speech recognition and may be misheard or split; make your best guess at what they meant and carry on. When a word or phrase is unclear, decide for yourself: pick the most likely meaning rather than asking what they meant, and never mention garbled or unclear wording. This does not apply when the instructions for this reply ask you to ask which thread or what to set aside: then ask exactly that.',
  'Offer at most one idea of your own per reply, and never repeat a suggestion the user has already passed over.',
  'Stay calm and plain, without flattery or forced enthusiasm.',
  'Never mention threads, branches or saving; the app handles structure on its own.',
].join(' ');

export function askWhichInstruction(names: string[]): string {
  return `The user wants to go back to an earlier thread, but it is unclear which. In one short question, ask which one, naming these: ${names.join(', ')}.`;
}

export function recapInstruction(items: { name: string; lastLine: string }[]): string {
  const list = items.slice(0, 3).map((i) => `${i.name} (last said: "${i.lastLine}")`).join('; ');
  return `In at most 35 words, remind the user where they are: ${list}. Mention at most three threads, with no list formatting.`;
}

export function compareInstruction(otherName: string, offerMerge: boolean): string {
  const base = `In at most 20 words, say only how the current thread and ${otherName} differ.`;
  return offerMerge ? `${base} If they could work together, end by asking once whether to combine them.` : base;
}

export function mergeOpeningInstruction(aName: string, bName: string): string {
  return `In at most 20 words, propose one plan that uses both ${aName} and ${bName}. Preserve the user’s priorities and latest corrections. If the user asks for a specific detail, answer it directly. Make a reasonable provisional choice when details are open.`;
}

export function setAsideInstruction(names: string[]): string {
  return `Too many threads are open at once. In one short question, ask which of these the user would like to set aside: ${names.join(', ')}.`;
}

export function switchFollowInstruction(spokenLine: string): string {
  return `You have just said "${spokenLine}" aloud. Continue in at most 18 words with one useful point or question about it; do not name, restate or reintroduce it.`;
}

export function parkedReminderInstruction(name: string): string {
  return `Briefly mention, once, that the earlier thought about ${name} is still saved.`;
}

export function askMergeInstruction(names: string[]): string {
  return `The user wants to combine this thread with another, but it is unclear which. In one short question, ask "Which thread should I combine this with?", naming these: ${names.join(', ')}.`;
}
