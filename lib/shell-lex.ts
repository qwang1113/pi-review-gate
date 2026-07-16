/**
 * Minimal quote-aware shell lexer.
 *
 * Repeated review rounds proved that regex patching cannot correctly decide
 * what a shell command executes: quotes change whether `;`/newline are command
 * separators, backslash-newline is a line continuation, here-doc bodies are
 * data not commands, and `$(...)`/backticks are substitutions. This module does
 * the one thing those regexes couldn't: track quote/escape state in a single
 * left-to-right pass, then split into segments and dequoted tokens that both
 * the ship-gate and the precommit anti-forgery check consume.
 *
 * It is intentionally small and fail-closed in spirit: it models the shell
 * features that matter for our two questions (what is the command head? is a
 * control operator real or quoted?) and deliberately treats substitutions and
 * here-doc bodies as NON-executed for the trust decision. It is NOT a full
 * POSIX shell parser and does not evaluate expansions.
 */

export interface ShellToken {
  /** The token with quotes removed and backslash escapes resolved. */
  value: string;
  /** True if any part of the token was single/double quoted (used to tell a
   *  real operator from a quoted one; operators are never emitted as tokens). */
  quoted: boolean;
}

export interface ShellSegment {
  tokens: ShellToken[];
}

/**
 * Preprocess a raw command line:
 *  - remove backslash-newline line continuations (outside single quotes),
 *  - blank out here-doc bodies (`<<[-]DELIM ... DELIM`), quoted or not,
 *  - blank out command substitutions `$(...)` and backticks.
 * Returns text safe to feed to the tokenizer, where remaining newlines and
 * operators are genuine separators.
 */
function preprocess(command: string): string {
  // 1. Strip here-doc bodies first (they can contain anything, incl. operators).
  //    Support identifier, numeric, hyphenated, and backslash/quote-escaped
  //    delimiters: <<EOF, <<-EOF, <<'EOF', <<"EOF", <<\EOF, <<123, <<END-X.
  let out = command.replace(
    /<<-?\s*(?:\\)?['"]?([A-Za-z0-9_-]+)['"]?[\s\S]*?^\s*\1\s*$/gm,
    " ",
  );

  // 2. Remove line continuations: a backslash immediately before a newline is
  //    removed along with the newline (POSIX line continuation). We approximate
  //    "outside single quotes" by doing this before quote tokenizing; a `\`+NL
  //    inside single quotes is rare and erring toward joining is fail-closed for
  //    ship detection (it can only make us SEE more, not less).
  out = out.replace(/\\\r?\n/g, "");

  // 3. Blank out command substitutions so their contents are not read as the
  //    executed command. Handle simple (non-nested) $(...) and `...`.
  let prev = "";
  while (prev !== out) {
    prev = out;
    out = out.replace(/\$\([^()]*\)/g, " ");
  }
  out = out.replace(/`[^`]*`/g, " ");
  return out;
}

/**
 * Tokenize preprocessed text into segments split on UNQUOTED control operators
 * (; && || | & and newline). Within a segment, tokens are split on unquoted
 * whitespace and each token is dequoted (quotes removed, adjacent runs glue
 * together, backslash escapes the next char).
 */
export function lexSegments(command: string): ShellSegment[] {
  const text = preprocess(command);
  const segments: ShellSegment[] = [];
  let tokens: ShellToken[] = [];
  let cur = "";
  let curQuoted = false;
  let hasCur = false;
  let quote: '"' | "'" | null = null;

  const endToken = () => {
    if (hasCur) { tokens.push({ value: cur, quoted: curQuoted }); cur = ""; curQuoted = false; hasCur = false; }
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) { segments.push({ tokens }); tokens = []; }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      if (ch === quote) { quote = null; continue; }
      // Inside double quotes, backslash escapes the next char; inside single
      // quotes everything is literal.
      if (quote === '"' && ch === "\\" && i + 1 < text.length) { cur += text[i + 1]; hasCur = true; i++; continue; }
      cur += ch; hasCur = true; continue;
    }

    if (ch === '"' || ch === "'") { quote = ch; curQuoted = true; hasCur = true; continue; }
    if (ch === "\\" && i + 1 < text.length) { cur += text[i + 1]; hasCur = true; i++; continue; }

    // Unquoted `#` starting a word begins a comment → skip to end of line.
    if (ch === "#" && !hasCur) {
      while (i < text.length && text[i] !== "\n") i++;
      i--; // let the loop see the newline as a separator next iteration
      continue;
    }

    // Unquoted control operators → segment boundaries.
    if (ch === ";" || ch === "\n" || ch === "\r") { endSegment(); continue; }
    if (ch === "&" || ch === "|") {
      // Consume a possible doubled operator (&&, ||) and single (|, &).
      endSegment();
      if (text[i + 1] === ch) i++;
      continue;
    }
    // Unquoted whitespace → token boundary.
    if (ch === " " || ch === "\t") { endToken(); continue; }

    cur += ch; hasCur = true;
  }
  endSegment();
  return segments;
}

/** Convenience: dequoted token-value arrays per segment. */
export function lexSegmentTokens(command: string): string[][] {
  return lexSegments(command).map((s) => s.tokens.map((t) => t.value).filter((v) => v.length > 0));
}
