export const FORK_ACK = 'Okay, taking that down a side path.';
/** "Back to the Japan city trip." Thread names are common-noun phrases; "Main" (the unnamed root) and names that already start with a determiner stay as they are. */
export const switchConfirm = (name: string): string => (/^(main|the|a|an|my|our|your)\b/i.test(name.trim()) ? `Back to ${name}.` : `Back to the ${name}.`);
export const REPLY_ERROR = 'Sorry, I lost that. Could you say it again?';
export const SCRATCHED = 'Okay, go ahead.';
export const NOTHING_TO_SCRATCH = 'Go ahead.';
export const ONLY_ONE_THREAD = "There's only one thread so far.";
export const PARKED = 'Okay, holding that thought.';
export const NOTHING_YET = "We haven't started yet — go ahead.";
export const SET_ASIDE = (name: string): string => `Okay, I've set aside ${name}.`;
