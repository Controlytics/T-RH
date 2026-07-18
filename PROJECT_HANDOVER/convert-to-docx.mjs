// Pre-renders Mermaid code blocks to PNGs, rewrites markdown to embed them as images,
// then invokes Pandoc to produce APPLICATION_FLOW.docx.
//
// Usage (from repo root):
//   node PROJECT_HANDOVER/convert-to-docx.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MD_IN = join(HERE, 'APPLICATION_FLOW.md');
const MD_TMP = join(HERE, '.APPLICATION_FLOW.with-images.md');
const DOCX_OUT = join(HERE, 'APPLICATION_FLOW.docx');
const DIAGRAMS = join(HERE, 'diagrams');
const PANDOC = 'C:\\Users\\hello\\AppData\\Local\\Pandoc\\pandoc.exe';

if (!existsSync(DIAGRAMS)) mkdirSync(DIAGRAMS, { recursive: true });

console.log('Reading', MD_IN);
const md = readFileSync(MD_IN, 'utf8');

// Match ```mermaid ... ``` blocks
const fence = /```mermaid\n([\s\S]*?)\n```/g;
let match;
let index = 0;
const blocks = [];
while ((match = fence.exec(md)) !== null) {
  blocks.push({ index: index++, start: match.index, end: match.index + match[0].length, code: match[1] });
}
console.log(`Found ${blocks.length} mermaid block(s).`);

// Render each block via mmdc
for (const b of blocks) {
  const mmd = join(DIAGRAMS, `diagram-${String(b.index + 1).padStart(2, '0')}.mmd`);
  const png = join(DIAGRAMS, `diagram-${String(b.index + 1).padStart(2, '0')}.png`);
  writeFileSync(mmd, b.code);
  console.log(`  Rendering diagram-${b.index + 1}…`);
  try {
    execFileSync('npx', ['--yes', '@mermaid-js/mermaid-cli', '-i', mmd, '-o', png, '-b', 'white', '-s', '2'], {
      stdio: 'inherit',
      shell: true,
    });
    b.png = png;
  } catch (err) {
    console.error(`  FAILED diagram-${b.index + 1}:`, err.message);
    b.png = null;
  }
}

// Rebuild markdown: replace each mermaid block with an image reference
let rebuilt = '';
let cursor = 0;
for (const b of blocks) {
  rebuilt += md.slice(cursor, b.start);
  if (b.png) {
    const rel = b.png.replace(HERE + '\\', '').replace(/\\/g, '/');
    rebuilt += `![Diagram ${b.index + 1}](${rel})`;
  } else {
    rebuilt += '```\n[Diagram failed to render]\n' + b.code + '\n```';
  }
  cursor = b.end;
}
rebuilt += md.slice(cursor);

writeFileSync(MD_TMP, rebuilt);
console.log('Wrote intermediate markdown:', MD_TMP);

// Invoke pandoc
console.log('Running pandoc…');
execFileSync(PANDOC, [
  MD_TMP,
  '-f', 'gfm',
  '-t', 'docx',
  '--toc',
  '--toc-depth=2',
  '-o', DOCX_OUT,
], { stdio: 'inherit', cwd: HERE });

// Clean intermediate
rmSync(MD_TMP);
console.log('\u2713 Created', DOCX_OUT);
