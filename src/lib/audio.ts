let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
	if (!audioCtx) {
		audioCtx = new AudioContext();
	}
	return audioCtx;
}

/**
 * Must be called from a user gesture (tap/click handler) to unlock
 * audio on iOS Safari/WebKit. Creates the AudioContext, resumes it
 * if suspended, and plays a silent buffer so the OS marks it as active.
 */
export async function initAudio(): Promise<void> {
	const ctx = getAudioContext();
	if (ctx.state === 'suspended') {
		await ctx.resume();
	}
	// Play a silent buffer to fully unlock on iOS
	const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
	const source = ctx.createBufferSource();
	source.buffer = buffer;
	source.connect(ctx.destination);
	source.start();
}

export function playBeep(frequency = 880, duration = 0.3): void {
	const ctx = getAudioContext();
	if (ctx.state === 'suspended') {
		ctx.resume();
	}
	const oscillator = ctx.createOscillator();
	const gain = ctx.createGain();

	oscillator.type = 'sine';
	oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);
	gain.gain.setValueAtTime(0.5, ctx.currentTime);
	gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);

	oscillator.connect(gain);
	gain.connect(ctx.destination);

	oscillator.start(ctx.currentTime);
	oscillator.stop(ctx.currentTime + duration);
}

export function playStartBeep(): void {
	playBeep(880, 0.4);
}

export function playCountdownTick(): void {
	playBeep(660, 0.15);
}

export function playResultBeep(): void {
	playBeep(440, 0.2);
}
