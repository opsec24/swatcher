const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { validatePasswordComplexity, hashPassword } = require('../src/services/auth');

describe('Auth - Password Security & Complexity', () => {
  after(async () => {
    await db.close();
  });

  test('rejects short passwords (< 10 chars)', () => {
    const res = validatePasswordComplexity('Short1!');
    assert.equal(res.isValid, false);
    assert.match(res.reason, /at least 10 characters/);
  });

  test('rejects passwords without uppercase letters', () => {
    const res = validatePasswordComplexity('lowercase123!@#');
    assert.equal(res.isValid, false);
    assert.match(res.reason, /uppercase/);
  });

  test('rejects passwords without lowercase letters', () => {
    const res = validatePasswordComplexity('UPPERCASE123!@#');
    assert.equal(res.isValid, false);
    assert.match(res.reason, /lowercase/);
  });

  test('rejects passwords without numbers', () => {
    const res = validatePasswordComplexity('NoNumbersHere!@#');
    assert.equal(res.isValid, false);
    assert.match(res.reason, /number/);
  });

  test('rejects passwords without special characters', () => {
    const res = validatePasswordComplexity('AlphaNumeric12345');
    assert.equal(res.isValid, false);
    assert.match(res.reason, /special character/);
  });

  test('accepts strong compliant passwords', () => {
    const res = validatePasswordComplexity('CompliantPassw0rd!');
    assert.equal(res.isValid, true);
    assert.equal(res.reason, undefined);
  });

  test('hashes password with scrypt and produces valid hex hash', async () => {
    const salt = '1234567890abcdef1234567890abcdef';
    const hash1 = await hashPassword('TestP@ssword123', salt);
    const hash2 = await hashPassword('TestP@ssword123', salt);

    assert.equal(typeof hash1, 'string');
    assert.equal(hash1.length, 128); // 64 bytes in hex
    assert.equal(hash1, hash2); // Deterministic with same salt
  });
});
