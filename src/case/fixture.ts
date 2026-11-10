import type { Fact } from './types.js';

export const EXAMPLE_LABEL = 'EXAMPLE CASE — synthetic household';

const CONFIRMED: Record<string, string> = {
  'accessory.vendor': 'Eve',
  'accessory.product': '10EBU4151',
  'accessory.model': '20EBU4101',
  'accessory.region': 'US/Canada',
  'accessory.protocol': 'matter-thread',
  'accessory.new': 'yes',
  'controller.platform': 'home-assistant',
  'controller.deployment': 'HAOS',
  'hub.model': 'ZBT-2',
  'hub.threadRole': 'border-router (reported)',
  'topology.otherTbrs': 'none-reported',
  'failure.stage': 'connectivity-check',
};

// Facts that start unknown (value null, version 0).
const UNKNOWN = ['accessory.firmware', 'phone.platform', 'phone.googleServices', 'phone.os', 'sync.status'];

export function seedFacts(now: number): Record<string, Fact> {
  const facts: Record<string, Fact> = {};
  for (const [path, value] of Object.entries(CONFIRMED)) {
    facts[path] = { path, value, version: 1, status: 'confirmed', origin: 'fixture', updatedAt: now };
  }
  for (const path of UNKNOWN) {
    facts[path] = { path, value: null, version: 0, status: 'unknown', origin: 'fixture', updatedAt: now };
  }
  return facts;
}
