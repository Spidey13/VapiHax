import type { Check, SourceRef } from '../case/types.js';

const CAPTURED = '2026-11-09';

export const SOURCES: Record<'R01' | 'R02' | 'R11' | 'R12', SourceRef> = {
  R01: {
    id: 'R01',
    url: 'https://www.home-assistant.io/integrations/matter/',
    publisher: 'Home Assistant',
    title: 'Matter integration (Home Assistant docs)',
    mode: 'curated',
    capturedAt: CAPTURED,
  },
  R02: {
    id: 'R02',
    url: 'https://www.home-assistant.io/integrations/thread/',
    publisher: 'Home Assistant',
    title: 'Thread integration (Home Assistant docs)',
    mode: 'curated',
    capturedAt: CAPTURED,
  },
  R11: {
    id: 'R11',
    url: 'https://support.apple.com/en-us/111839',
    publisher: 'Apple Support',
    title: 'Apple Support article 111839 (Apple TV model differences)',
    mode: 'curated',
    capturedAt: CAPTURED,
  },
  R12: {
    id: 'R12',
    url: 'https://www.evehome.com/en-us/identify-your-eve-accessory',
    publisher: 'Eve',
    title: 'Identify your Eve accessory',
    mode: 'curated',
    capturedAt: CAPTURED,
  },
};

/**
 * Curated, reviewed checks. Action text is a short original summary that points at the source;
 * it deliberately does not quote exact app menu labels.
 * `requires` values: a literal (must be confirmed with that value), an array (any of), or the token
 * 'unknown' (fact has no confirmed value).
 */
export const CHECKS: Check[] = [
  {
    id: 'apple-tv-3gen-wifi-only',
    stage: 'prerequisite',
    requires: { 'hub.model': 'apple-tv-4k-3gen-64gb-wifi', 'topology.otherTbrs': 'none-reported' },
    dependsOn: ['hub.model', 'topology.otherTbrs'],
    actionText:
      'According to Apple\'s support page, the Apple TV variant you describe does not have Thread capability, so it cannot act as your Thread border router. If you have another border router available, tell me and I will reassess.',
    expectedObservation: 'Nothing to try on the phone for this one; it is a documented capability boundary of the reported hub.',
    stopConditions: 'Reassess if you report another Thread border router or a different Apple TV variant.',
    sources: [SOURCES.R11],
    terminal: 'unsupported',
  },
  {
    id: 'confirm-border-router',
    stage: 'prerequisite',
    requires: { 'controller.platform': 'home-assistant', 'hub.threadRole': 'unknown' },
    dependsOn: ['controller.platform', 'hub.threadRole'],
    actionText:
      'Check whether Home Assistant\'s Thread integration lists your Thread border router. The Thread and Matter pages in the Home Assistant docs describe where.',
    expectedObservation: 'Your border router appears in the Thread integration; tell me whether it does.',
    stopConditions: 'If it is not listed, stop and tell me. Do not change any network settings.',
    sources: [SOURCES.R01, SOURCES.R02],
  },
  {
    id: 'android-credential-sync',
    stage: 'connectivity-check',
    requires: { 'phone.platform': 'android', 'phone.googleServices': 'yes', 'sync.status': ['unknown', 'not-done'] },
    dependsOn: ['phone.platform', 'phone.googleServices', 'sync.status'],
    actionText:
      'In the Home Assistant Companion app on your Android phone, run the Thread credential sync described in the Home Assistant Thread docs (link on the card).',
    expectedObservation: 'The app reports whether the sync succeeded or failed. Tell me which.',
    stopConditions: 'Do not read out any credentials or codes; I only need success or failure. Stop if anything asks you to reset a device.',
    sources: [SOURCES.R02],
  },
  {
    id: 'ios-credential-sync',
    stage: 'connectivity-check',
    requires: { 'phone.platform': 'ios', 'sync.status': ['unknown', 'not-done'] },
    dependsOn: ['phone.platform', 'sync.status'],
    actionText: 'On your iPhone, follow the credential steps in the Home Assistant Thread docs (link on the card).',
    expectedObservation: 'The app reports whether the sync succeeded or failed. Tell me which.',
    stopConditions: 'Do not read out any credentials or codes; I only need success or failure. Stop if anything asks you to reset a device.',
    sources: [SOURCES.R02],
  },
  {
    id: 'retry-pairing-once',
    stage: 'commissioning',
    requires: { 'sync.status': 'reported-done' },
    dependsOn: ['sync.status'],
    actionText: 'Try pairing the Eve Energy once more in the native commissioning app.',
    expectedObservation: 'Tell me whether it pairs, or the exact message it shows if it fails.',
    stopConditions: 'One retry only. If it fails, stop; we will save the case instead of looping.',
    sources: [SOURCES.R01],
  },
];

export function getCheck(id: string): Check | undefined {
  return CHECKS.find((c) => c.id === id);
}
