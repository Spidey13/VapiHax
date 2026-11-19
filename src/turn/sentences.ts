/** Splits streamed text into sentences. A terminator (. ? !) counts only once whitespace follows it. */
export class SentenceChunker {
  private buf = '';

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const m = /[.?!]+\s/.exec(this.buf);
      if (!m) break;
      const end = m.index + m[0].length;
      const sentence = this.buf.slice(0, end).trim();
      this.buf = this.buf.slice(end);
      if (sentence) out.push(sentence);
    }
    return out;
  }

  /**
   * For a failed or truncated stream: the buffered text only if it is a finished sentence (ends in a terminator,
   * optionally followed by closing quotes or brackets). An unfinished fragment is dropped. Clears the buffer.
   */
  finishComplete(): string | null {
    const rest = this.buf.trim();
    this.buf = '';
    return rest && /[.?!]["'”’)\]}]*$/.test(rest) ? rest : null;
  }

  flush(): string | null {
    const rest = this.buf.trim();
    this.buf = '';
    return rest || null;
  }
}
