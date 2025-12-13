import type { JSONCError } from "./errors";
import { err, ok, type Result } from "./result";

type Quote = "\"" | "'";

type State = {
  inString: boolean;
  quote: Quote | null;
  escaped: boolean;
  inLineComment: boolean;
  inBlockComment: boolean;
};

type JSONCResult<T> = Result<T, JSONCError>;

function jsoncError(message: string): JSONCError {
  return { _tag: "JSONCError", message };
}

function fail<T>(message: string): JSONCResult<T> {
  return err(jsoncError(message));
}

function createState(): State {
  return {
    inString: false,
    quote: null,
    escaped: false,
    inLineComment: false,
    inBlockComment: false,
  };
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isQuote(ch: string): ch is Quote {
  return ch === "\"" || ch === "'";
}

function skip(text: string, start: number): number {
  let i = start;

  while (i < text.length) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";

    if (isWhitespace(ch)) {
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < text.length && (text[i] ?? "") !== "\n") i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length) {
        const a = text[i] ?? "";
        const b = text[i + 1] ?? "";
        if (a === "*" && b === "/") {
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }

    return i;
  }

  return text.length;
}

function findClose(
  text: string,
  open: number,
  openChar: "{" | "[",
  closeChar: "}" | "]",
): JSONCResult<number> {
  const st = createState();
  let depth = 0;

  for (let i = open; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";

    if (st.inLineComment) {
      if (ch === "\n") st.inLineComment = false;
      continue;
    }

    if (st.inBlockComment) {
      if (ch === "*" && next === "/") {
        st.inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (st.inString) {
      if (st.escaped) {
        st.escaped = false;
        continue;
      }
      if (ch === "\\") {
        st.escaped = true;
        continue;
      }
      if (st.quote && ch === st.quote) {
        st.inString = false;
        st.quote = null;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      st.inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      st.inBlockComment = true;
      i += 1;
      continue;
    }

    if (isQuote(ch)) {
      st.inString = true;
      st.quote = ch;
      continue;
    }

    if (ch === openChar) depth += 1;
    if (ch === closeChar) depth -= 1;

    if (depth === 0) return ok(i);
  }

  return fail("Unterminated JSONC structure");
}

function parseStringToken(text: string, startIndex: number): JSONCResult<{
  value: string;
  endIndex: number;
}> {
  const q = text[startIndex] ?? "";
  if (!isQuote(q)) return fail("Expected string token");

  let value = "";
  let escaped = false;

  for (let i = startIndex + 1; i < text.length; i += 1) {
    const ch = text[i] ?? "";

    if (escaped) {
      value += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === q) {
      return ok({ value, endIndex: i + 1 });
    }

    value += ch;
  }

  return fail("Unterminated string token");
}

function parseIdentifierToken(text: string, startIndex: number): JSONCResult<{
  value: string;
  endIndex: number;
}> {
  let value = "";
  let i = startIndex;

  while (i < text.length) {
    const ch = text[i] ?? "";
    const isIdentChar =
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "_" ||
      ch === "$";

    if (!isIdentChar) break;
    value += ch;
    i += 1;
  }

  if (value.length === 0) return fail("Expected identifier token");

  return ok({ value, endIndex: i });
}

function findValueEnd(text: string, valueStart: number): JSONCResult<number> {
  const first = text[valueStart] ?? "";

  if (first === "{") {
    const close = findClose(text, valueStart, "{", "}");
    if (close._tag === "Err") return close;
    return ok(close.value + 1);
  }

  if (first === "[") {
    const close = findClose(text, valueStart, "[", "]");
    if (close._tag === "Err") return close;
    return ok(close.value + 1);
  }

  if (isQuote(first)) {
    const tok = parseStringToken(text, valueStart);
    if (tok._tag === "Err") return tok;
    return ok(tok.value.endIndex);
  }

  const state = createState();
  let depth = 0;

  for (let i = valueStart; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";

    if (state.inLineComment) {
      if (ch === "\n") state.inLineComment = false;
      continue;
    }

    if (state.inBlockComment) {
      if (ch === "*" && next === "/") {
        state.inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (state.inString) {
      if (state.escaped) {
        state.escaped = false;
        continue;
      }
      if (ch === "\\") {
        state.escaped = true;
        continue;
      }
      if (state.quote && ch === state.quote) {
        state.inString = false;
        state.quote = null;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      state.inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      state.inBlockComment = true;
      i += 1;
      continue;
    }

    if (isQuote(ch)) {
      state.inString = true;
      state.quote = ch;
      continue;
    }

    if (ch === "{" || ch === "[") depth += 1;
    if (ch === "}" || ch === "]") {
      if (depth === 0) return ok(i);
      depth -= 1;
      continue;
    }

    if (depth === 0 && (ch === "," || ch === "}" || ch === "]")) {
      return ok(i);
    }
  }

  return ok(text.length);
}

function findTopLevelPropertyValueSpan(
  text: string,
  rootOpenIndex: number,
  rootCloseIndex: number,
  propertyName: string,
): JSONCResult<null | { valueStart: number; valueEnd: number }> {
  let i = rootOpenIndex + 1;

  while (i < rootCloseIndex) {
    i = skip(text, i);
    if (i >= rootCloseIndex) return ok(null);

    const ch = text[i] ?? "";
    if (ch === "}") return ok(null);

    const keyTokenRes = isQuote(ch) ? parseStringToken(text, i) : parseIdentifierToken(text, i);
    if (keyTokenRes._tag === "Err") return keyTokenRes;

    const key = keyTokenRes.value.value;
    i = skip(text, keyTokenRes.value.endIndex);

    if ((text[i] ?? "") !== ":") {
      return fail("Invalid JSONC object: expected ':' after property key");
    }

    i = skip(text, i + 1);

    const valueStart = i;
    const valueEndRes = findValueEnd(text, valueStart);
    if (valueEndRes._tag === "Err") return valueEndRes;

    const valueEnd = valueEndRes.value;

    if (key === propertyName) {
      return ok({ valueStart, valueEnd });
    }

    i = valueEnd;
    i = skip(text, i);
    if ((text[i] ?? "") === ",") i += 1;
  }

  return ok(null);
}

function hasAnyProperties(text: string, rootOpenIndex: number, rootCloseIndex: number): boolean {
  const body = text.slice(rootOpenIndex + 1, rootCloseIndex);
  const cleaned = body
    .replaceAll(/\/\/.*$/gm, "")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .trim();
  return cleaned.length > 0;
}

function lastSignificantChar(text: string, endIndex: number): string {
  const state = createState();
  let last = "";

  for (let i = 0; i < endIndex; i += 1) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";

    if (state.inLineComment) {
      if (ch === "\n") state.inLineComment = false;
      continue;
    }

    if (state.inBlockComment) {
      if (ch === "*" && next === "/") {
        state.inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (state.inString) {
      if (state.escaped) {
        state.escaped = false;
        continue;
      }
      if (ch === "\\") {
        state.escaped = true;
        continue;
      }
      if (state.quote && ch === state.quote) {
        state.inString = false;
        state.quote = null;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      state.inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      state.inBlockComment = true;
      i += 1;
      continue;
    }

    if (isQuote(ch)) {
      state.inString = true;
      state.quote = ch;
      continue;
    }

    if (!isWhitespace(ch)) last = ch;
  }

  return last;
}

function formatValueForProperty(value: unknown): JSONCResult<string> {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) return fail("Unable to stringify JSON value");

  return ok(json.replaceAll("\n", "\n  "));
}

export function getTopLevelJsoncPropertyValueText(
  inputText: string,
  propertyName: string,
): JSONCResult<string | null> {
  const original = inputText.length === 0 ? "{}" : inputText;
  const first = skip(original, 0);

  if ((original[first] ?? "") !== "{") {
    return fail("Expected JSONC root object");
  }

  const rootOpenIndex = first;
  const rootCloseRes = findClose(original, rootOpenIndex, "{", "}");
  if (rootCloseRes._tag === "Err") return rootCloseRes;

  const rootCloseIndex = rootCloseRes.value;

  const spanRes = findTopLevelPropertyValueSpan(
    original,
    rootOpenIndex,
    rootCloseIndex,
    propertyName,
  );
  if (spanRes._tag === "Err") return spanRes;

  const span = spanRes.value;
  return ok(span ? original.slice(span.valueStart, span.valueEnd) : null);
}

export function upsertTopLevelJsoncProperty(
  inputText: string,
  propertyName: string,
  propertyValue: unknown,
): JSONCResult<string> {
  const original = inputText.length === 0 ? "{}" : inputText;
  const first = skip(original, 0);

  if ((original[first] ?? "") !== "{") {
    return fail("Expected JSONC root object");
  }

  const rootOpenIndex = first;
  const rootCloseRes = findClose(original, rootOpenIndex, "{", "}");
  if (rootCloseRes._tag === "Err") return rootCloseRes;

  const rootCloseIndex = rootCloseRes.value;

  const spanRes = findTopLevelPropertyValueSpan(
    original,
    rootOpenIndex,
    rootCloseIndex,
    propertyName,
  );
  if (spanRes._tag === "Err") return spanRes;

  const span = spanRes.value;

  const formattedValueRes = formatValueForProperty(propertyValue);
  if (formattedValueRes._tag === "Err") return formattedValueRes;

  const formattedValue = formattedValueRes.value;

  if (span) {
    return ok(
      `${original.slice(0, span.valueStart)}${formattedValue}${original.slice(span.valueEnd)}`,
    );
  }

  const hasProps = hasAnyProperties(original, rootOpenIndex, rootCloseIndex);
  const lastSig = hasProps ? lastSignificantChar(original, rootCloseIndex) : "{";

  const comma = lastSig === "{" || lastSig === "," ? "" : ",";
  const insert = `${comma}\n  // TODO: windows support\n  ${JSON.stringify(propertyName)}: ${formattedValue}\n`;

  return ok(`${original.slice(0, rootCloseIndex)}${insert}${original.slice(rootCloseIndex)}`);
}
