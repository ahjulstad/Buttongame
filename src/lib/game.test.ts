import { describe, it, expect } from 'vitest';
import {
	formatTime,
	randomName,
	calculateResult,
	sortResults,
	computeClockOffset,
	medianOffset,
	countdownValue,
	TARGET_SECONDS,
	BEEP_DELAY_MS
} from './game';

describe('randomName', () => {
	it('returns a two-word name', () => {
		const name = randomName();
		const parts = name.split(' ');
		expect(parts.length).toBe(2);
		expect(parts[0].length).toBeGreaterThan(0);
		expect(parts[1].length).toBeGreaterThan(0);
	});

	it('returns non-empty string', () => {
		expect(randomName().trim().length).toBeGreaterThan(0);
	});

	it('generates different names (not always the same)', () => {
		const names = new Set(Array.from({ length: 20 }, () => randomName()));
		expect(names.size).toBeGreaterThan(1);
	});
});

describe('formatTime', () => {
	it('formats whole seconds with 3 decimal places', () => {
		expect(formatTime(13)).toBe('13.000s');
	});

	it('formats fractional seconds', () => {
		expect(formatTime(13.456)).toBe('13.456s');
	});

	it('formats small values', () => {
		expect(formatTime(0.1)).toBe('0.100s');
	});

	it('rounds to 3 decimal places', () => {
		expect(formatTime(1.23456)).toBe('1.235s');
	});
});

describe('calculateResult', () => {
	it('calculates diff from target for overshoot', () => {
		const result = calculateResult('Alice', 13.5);
		expect(result.name).toBe('Alice');
		expect(result.time).toBe(13.5);
		expect(result.diff).toBeCloseTo(0.5);
	});

	it('calculates diff from target for undershoot', () => {
		const result = calculateResult('Bob', 12.0);
		expect(result.diff).toBeCloseTo(1.0);
	});

	it('returns zero diff for perfect score', () => {
		const result = calculateResult('Pro', TARGET_SECONDS);
		expect(result.diff).toBe(0);
	});

	it('preserves player name exactly', () => {
		const result = calculateResult('  Spaced  ', 13);
		expect(result.name).toBe('  Spaced  ');
	});
});

describe('sortResults', () => {
	it('sorts by closest to target (smallest diff first)', () => {
		const results = [
			{ name: 'A', time: 15, diff: 2 },
			{ name: 'B', time: 13.1, diff: 0.1 },
			{ name: 'C', time: 14, diff: 1 }
		];
		const sorted = sortResults(results);
		expect(sorted.map((r) => r.name)).toEqual(['B', 'C', 'A']);
	});

	it('does not mutate original array', () => {
		const results = [
			{ name: 'A', time: 15, diff: 2 },
			{ name: 'B', time: 13, diff: 0 }
		];
		sortResults(results);
		expect(results[0].name).toBe('A');
	});

	it('handles single player', () => {
		const results = [{ name: 'Solo', time: 13, diff: 0 }];
		expect(sortResults(results)).toEqual([{ name: 'Solo', time: 13, diff: 0 }]);
	});

	it('handles empty array', () => {
		expect(sortResults([])).toEqual([]);
	});

	it('preserves order for equal diffs', () => {
		const results = [
			{ name: 'A', time: 14, diff: 1 },
			{ name: 'B', time: 12, diff: 1 }
		];
		const sorted = sortResults(results);
		expect(sorted.length).toBe(2);
		expect(sorted[0].diff).toBe(1);
		expect(sorted[1].diff).toBe(1);
	});
});

describe('computeClockOffset', () => {
	it('returns zero when clocks are aligned', () => {
		// Host sends at t1=100, peer at t2=150, host receives at t3=200
		// One-way delay = 50ms, peer clock = host clock
		expect(computeClockOffset(100, 150, 200)).toBe(0);
	});

	it('returns positive offset when peer clock is ahead', () => {
		// Host: t1=100, t3=200 -> midpoint=150. Peer: t2=200 -> offset=+50
		expect(computeClockOffset(100, 200, 200)).toBe(50);
	});

	it('returns negative offset when peer clock is behind', () => {
		// Host: t1=100, t3=200 -> midpoint=150. Peer: t2=100 -> offset=-50
		expect(computeClockOffset(100, 100, 200)).toBe(-50);
	});

	it('handles asymmetric latency (uses midpoint assumption)', () => {
		// t1=0, t3=100, midpoint=50. t2=60 -> offset=10
		expect(computeClockOffset(0, 60, 100)).toBe(10);
	});
});

describe('medianOffset', () => {
	it('returns the median of odd-length array', () => {
		expect(medianOffset([10, 5, 20, 1, 15])).toBe(10);
	});

	it('returns floor-middle element for even-length', () => {
		expect(medianOffset([10, 20, 30, 40])).toBe(30);
	});

	it('handles single element', () => {
		expect(medianOffset([42])).toBe(42);
	});

	it('does not mutate original array', () => {
		const arr = [30, 10, 20];
		medianOffset(arr);
		expect(arr).toEqual([30, 10, 20]);
	});

	it('handles negative offsets', () => {
		expect(medianOffset([-100, -50, -10])).toBe(-50);
	});

	it('handles mixed positive and negative', () => {
		expect(medianOffset([-20, 0, 30, -10, 10])).toBe(0);
	});
});

describe('countdownValue', () => {
	const delay = BEEP_DELAY_MS; // 4000

	it('returns null before countdown window', () => {
		expect(countdownValue(delay, 0)).toBeNull();
		expect(countdownValue(delay, 500)).toBeNull();
		expect(countdownValue(delay, 999)).toBeNull();
	});

	it('returns 3 at start of countdown', () => {
		expect(countdownValue(delay, 1001)).toBe(3);
		expect(countdownValue(delay, 1500)).toBe(3);
	});

	it('returns 2 in second of countdown', () => {
		expect(countdownValue(delay, 2001)).toBe(2);
		expect(countdownValue(delay, 2500)).toBe(2);
	});

	it('returns 1 in final second of countdown', () => {
		expect(countdownValue(delay, 3001)).toBe(1);
		expect(countdownValue(delay, 3999)).toBe(1);
	});

	it('returns null when beep time reached', () => {
		expect(countdownValue(delay, 4000)).toBeNull();
		expect(countdownValue(delay, 5000)).toBeNull();
	});

	it('returns 3 at exact boundary (1000ms elapsed)', () => {
		// timeToBeep = 4000 - 1000 = 3000, ceil(3000/1000) = 3
		expect(countdownValue(delay, 1000)).toBe(3);
	});

	it('returns null at exact beep moment (elapsed = delay)', () => {
		// timeToBeep = 0 -> null
		expect(countdownValue(delay, delay)).toBeNull();
	});
});
