const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

function sanitizePgText(str, maxLength = null) {
  if (str === null || str === undefined) return '';
  let clean = String(str).replace(/\0/g, '');
  if (maxLength && clean.length > maxLength) {
    clean = clean.substring(0, maxLength);
  }
  return clean;
}

describe('Ingest - Postgres Data Sanitization', () => {
  test('strips null bytes from strings to avoid PG 22021 error', () => {
    assert.equal(sanitizePgText('hello\0world'), 'helloworld');
    assert.equal(sanitizePgText('binary\0\0data\0payload'), 'binarydatapayload');
    assert.equal(sanitizePgText('{"key":"val\0"}'), '{"key":"val"}');
  });

  test('truncates strings when maxLength is specified', () => {
    assert.equal(sanitizePgText('1234567890', 5), '12345');
    assert.equal(sanitizePgText('short', 10), 'short');
  });

  test('handles null, undefined, and non-strings safely', () => {
    assert.equal(sanitizePgText(null), '');
    assert.equal(sanitizePgText(undefined), '');
    assert.equal(sanitizePgText(12345), '12345');
    assert.equal(sanitizePgText(true), 'true');
  });
});
