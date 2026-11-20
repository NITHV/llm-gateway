// Splits a Markdown document into chunks that keep their section heading.
// Sections come from headings. Long sections are split on paragraph boundaries and
// overlap by a little, so a sentence cut at a boundary still appears in full in one chunk.

export function chunkMarkdown(text, { maxChars = 800, overlap = 120 } = {}) {
  const sections = [];
  let heading = '(top)';
  let lines = [];

  const flush = () => {
    const body = lines.join('\n').trim();
    if (body) sections.push({ heading, body });
    lines = [];
  };

  for (const line of text.split(/\r?\n/)) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) {
      flush();
      heading = m[1].trim();
    } else {
      lines.push(line);
    }
  }
  flush();

  const chunks = [];
  for (const section of sections) {
    const prefix = section.heading;
    let cur = '';
    const emit = () => {
      if (cur) chunks.push({ heading: prefix, text: `${prefix}\n\n${cur}` });
    };

    for (const para of section.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
      const pieces = para.length > maxChars ? hardSplit(para, maxChars) : [para];
      for (const piece of pieces) {
        if (cur && cur.length + piece.length + 2 > maxChars) {
          const tail = cur.slice(-overlap);
          emit();
          cur = tail.length + piece.length + 2 <= maxChars ? `${tail}\n\n${piece}` : piece;
        } else {
          cur = cur ? `${cur}\n\n${piece}` : piece;
        }
      }
    }
    emit();
  }
  return chunks;
}

function hardSplit(s, size) {
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
