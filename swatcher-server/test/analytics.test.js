const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { calculateActiveMinutes } = require('../src/services/analytics');

describe('Analytics - calculateActiveMinutes', () => {
  after(async () => {
    await db.close();
  });
  test('returns 0 for empty or null array', () => {
    assert.equal(calculateActiveMinutes([]), 0);
    assert.equal(calculateActiveMinutes(null), 0);
    assert.equal(calculateActiveMinutes(undefined), 0);
  });

  test('returns 1 minute block for single timestamp', () => {
    const ts = [new Date().toISOString()];
    assert.equal(calculateActiveMinutes(ts), 1);
  });

  test('correctly calculates continuous block within gap threshold', () => {
    const base = new Date('2026-11-01T10:00:00.000Z').getTime();
    const timestamps = [
      new Date(base).toISOString(),
      new Date(base + 2 * 60 * 1000).toISOString(),
      new Date(base + 5 * 60 * 1000).toISOString(),
      new Date(base + 8 * 60 * 1000).toISOString()
    ];
    // Span from 10:00 to 10:08 is 8 minutes
    assert.equal(calculateActiveMinutes(timestamps, 10), 8);
  });

  test('splits into multiple blocks when gap exceeds threshold', () => {
    const base = new Date('2026-11-01T10:00:00.000Z').getTime();
    const timestamps = [
      new Date(base).toISOString(), // 10:00 (1 min)
      new Date(base + 30 * 60 * 1000).toISOString(), // 10:30 (1 min)
      new Date(base + 35 * 60 * 1000).toISOString()  // 10:35 (5 min from 10:30)
    ];
    // Block 1: 10:00 (default 1 min)
    // Block 2: 10:30 to 10:35 (5 min)
    // Total = 6 minutes
    assert.equal(calculateActiveMinutes(timestamps, 10), 6);
  });

  test('sorts out-of-order timestamps and filters invalid dates', () => {
    const base = new Date('2026-11-01T10:00:00.000Z').getTime();
    const timestamps = [
      new Date(base + 5 * 60 * 1000).toISOString(),
      'INVALID_DATE_STRING',
      new Date(base).toISOString(),
      null,
      new Date(base + 2 * 60 * 1000).toISOString()
    ];
    assert.equal(calculateActiveMinutes(timestamps, 10), 5);
  });
});
