import { describe, it, expect } from 'vitest';
import { buildMarkdown, endSections, mapModel, mapLabel } from '../../public/js/endLogic.js';

const data = {
  nothing: false,
  summary: { covered: 'A  podcast\nidea.', considerations: ['Weekly cadence'], branches: [{ id: 'b', line: 'Podcast: landed on weekly' }, { id: 'a', line: 'Newsletter' }], open: ['Pricing'] },
  branches: [{ id: 'r', name: 'Main', status: 'live' }, { id: 'a', name: 'Newsletter', status: 'faded' }, { id: 'b', name: 'Podcast', status: 'parked' }],
  map: {
    nodes: [
      { id: 'r', x: 70, y: 45, label: 'Main', status: 'live' },
      { id: 'a', x: 70, y: 135, label: 'Newsletter', status: 'faded' },
      { id: 'b', x: 210, y: 135, label: 'Podcast', status: 'parked' },
      { id: 'm', x: 140, y: 225, label: 'A very long name…', status: 'live' },
    ],
    edges: [{ from: 'r', to: 'a' }, { from: 'r', to: 'b' }],
    mergeEdges: [{ from: 'a', to: 'm' }, { from: 'b', to: 'm' }],
    width: 280,
    height: 270,
  },
  showMap: true,
};

describe('buildMarkdown', () => {
  it('orders the four sections and prefixes branch names', () => {
    const md = buildMarkdown(data);
    const at = ['## At a glance', '## Topics', '## Worth keeping in mind', '## Still open'].map((h) => md.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(md).toContain('- Weekly cadence');
    expect(md).toContain('- Podcast: landed on weekly');
    expect(md).toContain('- Newsletter');
    expect(md).toContain('A podcast idea.');
    expect(md).toContain('- Pricing');
  });
  it('omits empty optional sections and never writes None/Nothing noted rows', () => {
    const md = buildMarkdown({ ...data, summary: { covered: 'x', branches: [], considerations: [], open: [] } });
    expect(md).toBe('# Brainstorm summary\n\n## At a glance\n\nx\n');
    expect(md).not.toMatch(/None\.|Nothing noted/);
  });
  it('renders an older payload with no considerations', () => {
    const md = buildMarkdown({ ...data, summary: { covered: 'x', branches: [], open: ['Pricing'] } });
    expect(md).not.toContain('Worth keeping in mind');
    expect(md).toContain('## Still open\n\n- Pricing');
  });
  it('handles an empty session', () => {
    expect(buildMarkdown({ nothing: true, summary: null, branches: [], map: null, showMap: false })).toBe('# Brainstorm summary\n\nNothing to summarise yet.\n');
  });
});

describe('mapModel', () => {
  const m = mapModel(data, { currentId: 'r' });
  const byId = Object.fromEntries(m.nodes.map((n: any) => [n.id, n]));
  it('marks current, faded and merge sources', () => {
    expect(byId.r.current).toBe(true);
    expect(byId.a.dim).toBe(true); // faded
    expect(byId.b.dim).toBe(true); // merge source
    expect(byId.m.dim).toBe(false);
  });
  it('keeps every node inside the viewBox and fits labels', () => {
    for (const n of m.nodes) {
      expect(n.x - n.w / 2).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w / 2).toBeLessThanOrEqual(m.width);
      expect(n.w).toBeLessThanOrEqual(132);
    }
    expect(mapLabel('x'.repeat(18)).w).toBeLessThanOrEqual(132);
  });
  it('draws tree edges solid and merge edges dashed', () => {
    expect(m.links.filter((l: any) => l.dashed)).toHaveLength(2);
    expect(m.links.filter((l: any) => !l.dashed)).toHaveLength(2);
  });
  it('defaults the emphasised node to the root when no current id is given', () => {
    const d = mapModel(data, {});
    expect(d.nodes.find((n: any) => n.current)?.id).toBe('r');
  });
  it('describes the threads for screen readers', () => {
    expect(m.aria).toContain('4 threads');
  });
  it('tolerates missing map data', () => {
    expect(mapModel({ ...data, map: null }, {}).nodes).toEqual([]);
  });
});

describe('endSections', () => {
  it('lists at a glance, topics (with ids), then only the non-empty optional sections', () => {
    const s: any[] = endSections(data);
    expect(s.map((x: any) => x.title)).toEqual(['At a glance', 'Topics', 'Worth keeping in mind', 'Still open']);
    expect(s[1].items).toEqual(['Podcast: landed on weekly', 'Newsletter']);
    expect(s[1].ids).toEqual(['b', 'a']);
  });
  it('drops empty topics, considerations and open; tolerates old payloads', () => {
    const s: any[] = endSections({ ...data, summary: { covered: 'x', branches: [], open: [] } });
    expect(s.map((x: any) => x.title)).toEqual(['At a glance']);
  });
});
