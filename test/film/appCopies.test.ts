import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { APP_FILES, sessionMarkup } from '../../scripts/film-copy-app.mjs';
import { MARKUP } from '../../film/app/markup.js';

const root = path.resolve(import.meta.dirname, '..', '..');
describe('the film draws with the app’s own files', () => {
  it.each(APP_FILES as string[])('film/app/%s is identical to public/', (f) => {
    expect(readFileSync(path.join(root, 'film', 'app', f), 'utf8')).toBe(readFileSync(path.join(root, 'public', f), 'utf8'));
  });
  it('film/app/markup.js is the session markup of public/index.html', () => {
    expect(MARKUP).toBe(sessionMarkup(readFileSync(path.join(root, 'public', 'index.html'), 'utf8')));
    expect(MARKUP).toContain('id="branchmap"');
    expect(MARKUP).not.toContain('start-screen');
    expect(MARKUP).not.toContain('<script');
  });
});
