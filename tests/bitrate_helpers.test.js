'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../utils/quality_evaluator.js');

test('computeKbps converts decoded bytes over elapsed ms into kbps', () => {
  // 500,000 bytes in 1 second = 4,000,000 bits/s = 4000 kbps
  assert.equal(E.computeKbps(500000, 1000), 4000);
  // 250,000 bytes in 500 ms is the same rate
  assert.equal(E.computeKbps(250000, 500), 4000);
});

test('computeKbps returns 0 for invalid or non-positive input', () => {
  assert.equal(E.computeKbps(0, 1000), 0);
  assert.equal(E.computeKbps(-5, 1000), 0);
  assert.equal(E.computeKbps(1000, 0), 0);
  assert.equal(E.computeKbps(NaN, 1000), 0);
  assert.equal(E.computeKbps(1000, undefined), 0);
});

test('slidingAverage averages only the last N samples', () => {
  assert.equal(E.slidingAverage([1000, 2000, 3000, 4000], 3), 3000);
  assert.equal(E.slidingAverage([1000, 2000], 3), 1500);
  assert.equal(E.slidingAverage([1000, 2000, 3000]), 2000);
});

test('slidingAverage handles empty and invalid values', () => {
  assert.equal(E.slidingAverage([], 3), 0);
  assert.equal(E.slidingAverage(null, 3), 0);
  assert.equal(E.slidingAverage([NaN, 100], 3), 100);
});
