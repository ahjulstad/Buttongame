export const TARGET_SECONDS = 13;
export const SYNC_ROUNDS = 5;
export const BEEP_DELAY_MS = 4000;
export const PEER_ID = 'buttongame-room';

export type GamePhase = 'home' | 'lobby' | 'syncing' | 'countdown' | 'playing' | 'pressed' | 'results';

export interface PlayerResult {
	name: string;
	time: number;
	diff: number;
}

export type PeerMessage =
	| { type: 'join'; name: string }
	| { type: 'player-list'; players: string[] }
	| { type: 'sync-ping'; t1: number }
	| { type: 'sync-pong'; t1: number; t2: number }
	| { type: 'scheduled-start'; beepAt: number }
	| { type: 'result'; name: string; time: number }
	| { type: 'all-results'; results: PlayerResult[] };

const ADJECTIVES = [
	'Swift', 'Lazy', 'Bold', 'Sneaky', 'Cosmic', 'Fuzzy', 'Mighty', 'Chill',
	'Zappy', 'Turbo', 'Dizzy', 'Bouncy', 'Crispy', 'Wobbly', 'Spicy', 'Frosty',
	'Jolly', 'Zippy', 'Stormy', 'Witty', 'Funky', 'Goofy', 'Lucky', 'Peppy'
];

const NOUNS = [
	'Panda', 'Pickle', 'Waffle', 'Narwhal', 'Taco', 'Otter', 'Penguin', 'Mango',
	'Llama', 'Donut', 'Parrot', 'Noodle', 'Walrus', 'Biscuit', 'Gecko', 'Moose',
	'Badger', 'Turnip', 'Falcon', 'Pretzel', 'Squid', 'Muffin', 'Koala', 'Nugget'
];

export function randomName(): string {
	const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
	const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
	return `${adj} ${noun}`;
}

export function formatTime(t: number): string {
	return t.toFixed(3) + 's';
}

export function calculateResult(name: string, elapsed: number): PlayerResult {
	return {
		name,
		time: elapsed,
		diff: Math.abs(elapsed - TARGET_SECONDS)
	};
}

export function sortResults(results: PlayerResult[]): PlayerResult[] {
	return [...results].sort((a, b) => a.diff - b.diff);
}

export function computeClockOffset(t1: number, t2: number, t3: number): number {
	return t2 - (t1 + t3) / 2;
}

export function medianOffset(offsets: number[]): number {
	const sorted = [...offsets].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

export function countdownValue(delayMs: number, elapsed: number): number | null {
	const timeToBeep = delayMs - elapsed;
	if (timeToBeep > 3000) return null;
	if (timeToBeep <= 0) return null;
	return Math.ceil(timeToBeep / 1000);
}
