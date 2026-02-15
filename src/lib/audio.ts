let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
	if (!audioCtx) {
		audioCtx = new AudioContext();
	}
	return audioCtx;
}

export function playBeep(frequency = 880, duration = 0.3): void {
	const ctx = getAudioContext();
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

export function playResultBeep(): void {
	playBeep(440, 0.2);
}
