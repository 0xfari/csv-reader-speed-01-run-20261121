// Fast, byte-identical drop-in for csv-reader 1.0.0 (make.fun's own reference CSV
// reader). Returns the same {columns, rows, errors} answer on every input, built
// for speed: bulk scans (indexOf / split / one regex exec per field segment)
// replace the reference's one-character-at-a-time loop with string concatenation.
//
// Policy (mirrored exactly from the reference):
// - A U+FEFF at the very start is dropped; a record ends at LF or CRLF; a line
//   left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (stray_cr).
// - A field opening with a quote runs to the next non-doubled quote; "" inside
//   is one quote; CRLF / lone CR inside read as LF; text after the closing
//   quote up to the next comma or line break is appended as it stands
//   (quote_junk, when the field ends); a quote that never closes is a
//   literal character and the text after it is read again as unquoted
//   (unterminated_quote). A quote inside an unquoted field is literal.
// - Fields stay strings, never trimmed or converted. columns is the first
//   record when header is true, else null; rows are padded with "" (short_row,
//   with fields: its count) or cut (long_row, with extra: the cut fields) to
//   the first record's width. Errors are {code, line, row} in the order met;
//   line is the 1-based line the record starts on.

const RE_SPECIAL = /[,\r\n]/g; // next comma, CR or LF
const RE_RECORD = /["\r\n]/g; // next quote, CR or LF (record probe)

const ENDED_COMMA = 0;
const ENDED_BREAK = 1;
const ENDED_END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let line = 1;

  // Unquoted field read starting at `pos`, continuing `value`. Returns
  // [value, ended, added]; `added` counts characters appended here. Only used
  // for the rare paths (junk after a closing quote; re-read after an
  // unterminated quote). Common unquoted fields are inlined in the loop below.
  function readUnquoted(value, recordLine, recordRow) {
    let added = 0;
    for (;;) {
      RE_SPECIAL.lastIndex = pos;
      const m = RE_SPECIAL.exec(text);
      if (m === null) {
        if (pos < n) { value += text.slice(pos); added += n - pos; pos = n; }
        return [value, ENDED_END, added];
      }
      const i = m.index;
      const c = text.charCodeAt(i);
      if (c === 44) {
        if (i > pos) { value += text.slice(pos, i); added += i - pos; }
        pos = i + 1;
        return [value, ENDED_COMMA, added];
      }
      if (c === 10) {
        if (i > pos) { value += text.slice(pos, i); added += i - pos; }
        pos = i + 1;
        line += 1;
        return [value, ENDED_BREAK, added];
      }
      if (text.charCodeAt(i + 1) === 10) {
        if (i > pos) { value += text.slice(pos, i); added += i - pos; }
        pos = i + 2;
        line += 1;
        return [value, ENDED_BREAK, added];
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (i > pos) { value += text.slice(pos, i); added += i - pos; }
      pos = i + 1;
    }
  }

  // Finish one record's fields: width, header, short/long rows, push to rows.
  function finishRecord(fields, recordLine, recordRow) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  recordLoop: while (true) {
    // Skip empty lines (LF / CRLF).
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    // Tier 1: the record holds no quote before its line break (and no lone
    // CR): split the whole record at once.
    RE_RECORD.lastIndex = pos;
    const rm = RE_RECORD.exec(text);
    if (rm !== null) {
      const ri = rm.index;
      const rc = text.charCodeAt(ri);
      if (rc === 10 || (rc === 13 && text.charCodeAt(ri + 1) === 10)) {
        const fields = text.slice(pos, ri).split(',');
        if (fields.length === 1 && fields[0] === '') {
          // A line left with no characters: no record.
          pos = ri + (rc === 13 ? 2 : 1);
          line += 1;
          continue recordLoop;
        }
        finishRecord(fields, recordLine, recordRow);
        pos = ri + (rc === 13 ? 2 : 1);
        line += 1;
        continue recordLoop;
      }
      // A quote or a lone CR before the line break: tier 2 below.
    } else {
      // No quote, CR or LF left: the rest of the text is one clean record.
      const fields = text.slice(pos).split(',');
      if (fields.length === 1 && fields[0] === '') {
        pos = n;
        break;
      }
      finishRecord(fields, recordLine, recordRow);
      pos = n;
      break;
    }

    // Tier 2: field-by-field (the record holds a quote or a lone CR).
    const fields = [];
    let ended = ENDED_END;
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const open = pos;
        const openLine = line;
        let value = '';
        let start = pos + 1;
        let closedAt = -1;
        for (;;) {
          const q = text.indexOf('"', start);
          if (q === -1) {
            // The quote never closes: it is a literal character, and the
            // text after it is read again as unquoted.
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            pos = open + 1;
            line = openLine;
            const r = readUnquoted('"', recordLine, recordRow);
            value = r[0];
            ended = r[1];
            closedAt = -2;
            break;
          }
          if (text.charCodeAt(q + 1) === 34) {
            value += text.slice(start, q);
            value += '"';
            start = q + 2;
            continue;
          }
          value += text.slice(start, q);
          closedAt = q;
          break;
        }
        if (closedAt >= 0) {
          // Line breaks inside the quotes: each CR (lone or in CRLF) and
          // each LF not after a CR counts one line; CRs become LF.
          const br = value.match(/\r\n|\r|\n/g);
          if (br !== null) line += br.length;
          if (value.indexOf('\r') !== -1) value = value.replace(/\r\n?/g, '\n');
          pos = closedAt + 1;
          if (pos >= n) {
            ended = ENDED_END;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) { pos += 1; ended = ENDED_COMMA; }
            else if (c === 10) { pos += 1; line += 1; ended = ENDED_BREAK; }
            else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; ended = ENDED_BREAK; }
            else {
              // What follows the closing quote is appended as it stands.
              const r = readUnquoted(value, recordLine, recordRow);
              if (r[2] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              value = r[0];
              ended = r[1];
            }
          }
        }
        fields.push(value);
      } else {
        quoted = false;
        let value = '';
        let i = pos;
        for (;;) {
          while (i < n) {
            const c = text.charCodeAt(i);
            if (c === 44 || c === 10 || c === 13) break;
            i += 1;
          }
          if (i >= n) {
            if (pos < n) value += text.slice(pos);
            pos = n;
            ended = ENDED_END;
            break;
          }
          const c = text.charCodeAt(i);
          if (c === 44) {
            if (i > pos) value += text.slice(pos, i);
            pos = i + 1;
            ended = ENDED_COMMA;
            break;
          }
          if (c === 10) {
            if (i > pos) value += text.slice(pos, i);
            pos = i + 1;
            line += 1;
            ended = ENDED_BREAK;
            break;
          }
          if (text.charCodeAt(i + 1) === 10) {
            if (i > pos) value += text.slice(pos, i);
            pos = i + 2;
            line += 1;
            ended = ENDED_BREAK;
            break;
          }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          if (i > pos) value += text.slice(pos, i);
          pos = i + 1;
          i = pos;
        }
        fields.push(value);
      }
    } while (ended === ENDED_COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue recordLoop;
    finishRecord(fields, recordLine, recordRow);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
