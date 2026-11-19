import { loadFont } from '@remotion/fonts';
import { staticFile } from 'remotion';

// Instrument Sans (SIL OFL, public/fonts/OFL.txt), the app's own face, from a local file.
loadFont({ family: 'Instrument Sans', url: staticFile('fonts/InstrumentSans-latin.woff2'), weight: '400 600' });
// JetBrains Mono 400 (SIL OFL), for the caption tags and the end card's tag line.
loadFont({ family: 'JetBrains Mono', url: staticFile('fonts/JetBrainsMono-latin-400.woff2'), weight: '400' });
