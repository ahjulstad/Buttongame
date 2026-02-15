<script lang="ts">
	import { onMount } from 'svelte';
	import { initAudio, playStartBeep, playCountdownTick, playResultBeep } from '$lib/audio';
	import {
		TARGET_SECONDS,
		SYNC_ROUNDS,
		BEEP_DELAY_MS,
		PEER_ID,
		SYNC_TIMEOUT_MS,
		formatTime,
		randomName,
		calculateResult,
		sortResults,
		computeClockOffset,
		medianOffset,
		type GamePhase,
		type PlayerResult,
		type PeerMessage
	} from '$lib/game';
	import Peer, { type DataConnection } from 'peerjs';

	const NAME_KEY = 'buttongame-name';

	let phase = $state<GamePhase>('home');
	let isHost = $state(false);
	let playerName = $state('');
	let players = $state<string[]>([]);
	let myTime = $state<number | null>(null);
	let results = $state<PlayerResult[]>([]);
	let beepTimestamp = $state(0);
	let buttonLit = $state(false);
	let countdown = $state<number | null>(null);
	let error = $state('');
	let peer: Peer | null = null;
	let connections = $state<DataConnection[]>([]);
	let hostConnection: DataConnection | null = null;
	let pendingResults: PlayerResult[] = [];
	let expectedResults = 0;

	// Host-side: map connection → player name, and sync resolvers
	let connNames = new Map<DataConnection, string>();
	let syncResolvers = new Map<DataConnection, (offset: number) => void>();

	/** The trimmed name used for all game messages. */
	function myName(): string {
		return playerName.trim() || randomName();
	}

	function saveName() {
		try { localStorage.setItem(NAME_KEY, playerName); } catch {}
	}

	function sendTo(conn: DataConnection, msg: PeerMessage) {
		conn.send(JSON.stringify(msg));
	}

	function broadcast(msg: PeerMessage) {
		for (const conn of connections) sendTo(conn, msg);
	}

	function sendToHost(msg: PeerMessage) {
		if (hostConnection) hostConnection.send(JSON.stringify(msg));
	}

	function destroyPeer() {
		peer?.destroy();
		peer = null;
		connections = [];
		hostConnection = null;
		connNames.clear();
		syncResolvers.clear();
	}

	function resetGameState() {
		myTime = null;
		results = [];
		buttonLit = false;
		countdown = null;
		pendingResults = [];
		expectedResults = 0;
	}

	function goHome(msg?: string) {
		destroyPeer();
		resetGameState();
		phase = 'home';
		if (msg) error = msg;
	}

	function measureOffset(conn: DataConnection): Promise<number> {
		return new Promise((resolve, reject) => {
			const offsets: number[] = [];
			let round = 0;
			let timer: ReturnType<typeof setTimeout>;

			const cleanup = () => {
				clearTimeout(timer);
				syncResolvers.delete(conn);
			};

			const doRound = () => {
				timer = setTimeout(() => {
					cleanup();
					reject(new Error(`Sync timeout for ${connNames.get(conn) ?? 'player'}`));
				}, SYNC_TIMEOUT_MS);

				syncResolvers.set(conn, (offset: number) => {
					clearTimeout(timer);
					offsets.push(offset);
					round++;
					if (round < SYNC_ROUNDS) {
						doRound();
					} else {
						cleanup();
						resolve(medianOffset(offsets));
					}
				});
				sendTo(conn, { type: 'sync-ping', t1: performance.now() });
			};
			doRound();
		});
	}

	function removeConnection(conn: DataConnection) {
		const name = connNames.get(conn);
		connNames.delete(conn);
		connections = connections.filter((c) => c !== conn);

		// Cancel any pending sync resolver
		const resolver = syncResolvers.get(conn);
		if (resolver) syncResolvers.delete(conn);

		if (name) {
			players = players.filter((p) => p !== name);
			broadcast({ type: 'player-list', players });

			// If waiting for this player's result, check if we can finish
			if (phase === 'playing' || phase === 'pressed' || phase === 'countdown') {
				expectedResults = Math.max(0, expectedResults - 1);
				if (expectedResults > 0 && pendingResults.length >= expectedResults) {
					finishGame();
				}
			}
		}
	}

	function handleMessage(msg: PeerMessage, from?: DataConnection) {
		switch (msg.type) {
			case 'join': {
				if (!isHost || !from) break;
				// Reject joins while a game is in progress
				if (phase !== 'lobby') break;
				// Map connection to name
				connNames.set(from, msg.name);
				if (!players.includes(msg.name)) {
					players = [...players, msg.name];
				}
				broadcast({ type: 'player-list', players });
				break;
			}
			case 'player-list': {
				players = msg.players;
				break;
			}
			case 'sync-ping': {
				sendToHost({ type: 'sync-pong', t1: msg.t1, t2: performance.now() });
				break;
			}
			case 'sync-pong': {
				if (from) {
					const t3 = performance.now();
					const offset = computeClockOffset(msg.t1, msg.t2, t3);
					const resolver = syncResolvers.get(from);
					if (resolver) resolver(offset);
				}
				break;
			}
			case 'scheduled-start': {
				const delay = msg.beepAt - performance.now();
				scheduleBeep(Math.max(0, delay));
				break;
			}
			case 'result': {
				if (!isHost) break;
				pendingResults.push({
					name: msg.name,
					time: msg.time,
					diff: Math.abs(msg.time - TARGET_SECONDS)
				});
				if (pendingResults.length >= expectedResults) {
					finishGame();
				}
				break;
			}
			case 'all-results': {
				results = msg.results;
				phase = 'results';
				playResultBeep();
				break;
			}
		}
	}

	function setupHost() {
		destroyPeer();
		peer = new Peer(PEER_ID);

		peer.on('open', () => {
			isHost = true;
			players = [myName()];
			phase = 'lobby';
		});

		peer.on('connection', (conn) => {
			connections = [...connections, conn];
			conn.on('data', (data) => {
				handleMessage(JSON.parse(data as string), conn);
			});
			conn.on('close', () => removeConnection(conn));
			conn.on('error', () => removeConnection(conn));
		});

		peer.on('error', (err) => {
			if (err.type === 'unavailable-id') {
				setupJoiner();
			} else {
				goHome(`Could not connect. Check your network and try again.`);
			}
		});
	}

	function setupJoiner() {
		destroyPeer();
		peer = new Peer();
		isHost = false;

		peer.on('open', () => {
			const conn = peer!.connect(PEER_ID);
			hostConnection = conn;

			conn.on('open', () => {
				phase = 'lobby';
				sendToHost({ type: 'join', name: myName() });
			});

			conn.on('data', (data) => {
				handleMessage(JSON.parse(data as string));
			});

			conn.on('close', () => goHome('Lost connection to host.'));
			conn.on('error', () => goHome('Lost connection to host.'));
		});

		peer.on('error', (err) => {
			if (err.type === 'peer-unavailable') {
				goHome('No game found. Tap Join to start a new one.');
			} else {
				goHome('Could not connect. Check your network and try again.');
			}
		});
	}

	function joinGame() {
		if (!playerName.trim()) playerName = randomName();
		saveName();
		error = '';
		initAudio();
		setupHost();
	}

	async function hostStart() {
		if (!isHost) return;
		initAudio();
		expectedResults = players.length;
		pendingResults = [];
		phase = 'syncing';

		// Sync clocks — drop players that fail to respond
		const offsets = new Map<DataConnection, number>();
		await Promise.all(
			connections.map(async (conn) => {
				try {
					const offset = await measureOffset(conn);
					offsets.set(conn, offset);
				} catch {
					removeConnection(conn);
				}
			})
		);

		// Recalculate after dropped players
		expectedResults = players.length;

		const beepAtHostTime = performance.now() + BEEP_DELAY_MS;

		for (const conn of connections) {
			const offset = offsets.get(conn) ?? 0;
			sendTo(conn, { type: 'scheduled-start', beepAt: beepAtHostTime + offset });
		}

		scheduleBeep(BEEP_DELAY_MS);
	}

	function scheduleBeep(delayMs: number) {
		phase = 'countdown';
		myTime = null;
		countdown = null;

		const countdownStart = delayMs - 3000;
		if (countdownStart >= 0) {
			setTimeout(() => { countdown = 3; playCountdownTick(); }, countdownStart);
			setTimeout(() => { countdown = 2; playCountdownTick(); }, countdownStart + 1000);
			setTimeout(() => { countdown = 1; playCountdownTick(); }, countdownStart + 2000);
		}

		setTimeout(() => {
			countdown = null;
			phase = 'playing';
			buttonLit = true;
			beepTimestamp = performance.now();
			playStartBeep();
		}, delayMs);
	}

	function pressButton() {
		if (phase !== 'playing') return;
		const now = performance.now();
		const elapsed = (now - beepTimestamp) / 1000;
		myTime = elapsed;
		phase = 'pressed';
		buttonLit = false;

		const name = myName();
		const result = calculateResult(name, elapsed);

		if (isHost) {
			pendingResults.push(result);
			if (pendingResults.length >= expectedResults) finishGame();
		} else {
			sendToHost({ type: 'result', name, time: elapsed });
		}
	}

	function finishGame() {
		const sorted = sortResults(pendingResults);
		results = sorted;
		phase = 'results';
		playResultBeep();
		broadcast({ type: 'all-results', results: sorted });
	}

	function playAgain() {
		phase = 'lobby';
		resetGameState();
	}

	onMount(() => {
		const saved = localStorage.getItem(NAME_KEY);
		playerName = saved || randomName();
		return () => destroyPeer();
	});
</script>

<svelte:head>
	<title>13 Seconds</title>
</svelte:head>

<div class="container">
	<h1 class="title">13 Seconds</h1>
	<p class="subtitle">Press the button exactly 13 seconds after the beep</p>

	<button
		class="big-button"
		class:lit={buttonLit}
		class:dimmed={phase === 'home' || phase === 'lobby' || phase === 'syncing'}
		class:countdown-active={phase === 'countdown'}
		class:pressed={phase === 'pressed'}
		class:winner={phase === 'results'}
		disabled={phase !== 'playing' && !(phase === 'lobby' && isHost)}
		onpointerdown={(e) => {
			if (phase === 'playing') {
				e.preventDefault();
				pressButton();
			}
		}}
		onclick={() => {
			if (phase === 'lobby' && isHost) hostStart();
		}}
	>
		{#if phase === 'home'}
			<span class="btn-text">13</span>
		{:else if phase === 'syncing'}
			<span class="btn-text sync-text">SYNC</span>
		{:else if phase === 'countdown'}
			<span class="btn-text countdown-text">{countdown ?? '...'}</span>
		{:else if phase === 'lobby' && isHost}
			<span class="btn-text">START</span>
		{:else if phase === 'lobby'}
			<span class="btn-text">WAIT</span>
		{:else if phase === 'playing'}
			<span class="btn-text">PRESS!</span>
		{:else if phase === 'pressed'}
			<span class="btn-text">{formatTime(myTime!)}</span>
		{:else if phase === 'results'}
			<span class="btn-text">
				{#if results.length > 0}
					{results[0].name === myName() ? 'YOU WIN!' : results[0].name + ' wins!'}
				{/if}
			</span>
		{/if}
	</button>

	{#if phase === 'home'}
		<div class="panel">
			<input
				class="input"
				type="text"
				bind:value={playerName}
				oninput={saveName}
				placeholder="Your name"
				maxlength="20"
				onkeydown={(e) => { if (e.key === 'Enter') joinGame(); }}
			/>
			<button class="action-btn host-btn" onclick={joinGame}>Join Game</button>
		</div>
	{/if}

	{#if phase === 'lobby'}
		<div class="panel">
			<div class="player-list">
				<h3>Players ({players.length})</h3>
				{#each players as player}
					<div class="player">{player}</div>
				{/each}
			</div>
			{#if isHost}
				<p class="hint">Press the button to start!</p>
			{:else}
				<p class="hint">Waiting for host to start...</p>
			{/if}
		</div>
	{/if}

	{#if phase === 'syncing'}
		<div class="panel">
			<p class="hint sync-hint">Synchronizing devices...</p>
		</div>
	{/if}

	{#if phase === 'countdown'}
		<div class="panel">
			<p class="hint countdown-hint">Get ready...</p>
		</div>
	{/if}

	{#if phase === 'playing'}
		<div class="panel">
			<p class="hint playing-hint">Count to 13... then press!</p>
		</div>
	{/if}

	{#if phase === 'pressed'}
		<div class="panel">
			<p class="hint">You pressed at <strong>{formatTime(myTime!)}</strong></p>
			<p class="hint">Waiting for other players...</p>
		</div>
	{/if}

	{#if phase === 'results'}
		<div class="panel results-panel">
			<h3>Results</h3>
			<div class="results-list">
				{#each results as result, i}
					<div class="result-row" class:is-winner={i === 0} class:is-me={result.name === myName()}>
						<span class="rank">#{i + 1}</span>
						<span class="result-name">{result.name}</span>
						<span class="result-time">{formatTime(result.time)}</span>
						<span class="result-diff">({result.diff > 0 ? '+' : ''}{formatTime(result.diff)} off)</span>
					</div>
				{/each}
			</div>
			<button class="action-btn" onclick={playAgain}>Play Again</button>
		</div>
	{/if}

	{#if error}
		<div class="error">{error}</div>
	{/if}
</div>

<style>
	:global(body) {
		margin: 0;
		background: #1a1a2e;
		color: #eee;
		font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
		min-height: 100vh;
		overflow-x: hidden;
	}

	.container {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 2rem 1rem;
		min-height: 100vh;
		box-sizing: border-box;
	}

	.title {
		font-size: 2.5rem;
		margin: 0;
		background: linear-gradient(135deg, #ff4444, #ff8800);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.subtitle {
		color: #888;
		margin: 0.5rem 0 2rem;
		text-align: center;
	}

	.big-button {
		width: 260px;
		height: 260px;
		border-radius: 50%;
		border: 6px solid #660000;
		background: radial-gradient(circle at 35% 35%, #cc2200, #880000, #440000);
		color: white;
		font-size: 2rem;
		font-weight: 900;
		cursor: pointer;
		position: relative;
		box-shadow:
			0 8px 32px rgba(0, 0, 0, 0.5),
			0 0 0 3px #330000,
			inset 0 -4px 12px rgba(0, 0, 0, 0.4);
		transition: all 0.15s ease;
		user-select: none;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
		outline: none;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.big-button:active:not(:disabled) {
		transform: scale(0.96);
		box-shadow:
			0 4px 16px rgba(0, 0, 0, 0.5),
			0 0 0 3px #330000,
			inset 0 2px 8px rgba(0, 0, 0, 0.6);
	}

	.big-button.dimmed {
		background: radial-gradient(circle at 35% 35%, #661100, #440000, #220000);
		border-color: #330000;
	}

	.big-button.countdown-active {
		background: radial-gradient(circle at 35% 35%, #cc6600, #994400, #662200);
		border-color: #ff8800;
		box-shadow:
			0 0 40px rgba(255, 136, 0, 0.4),
			0 0 80px rgba(255, 136, 0, 0.2),
			0 8px 32px rgba(0, 0, 0, 0.5),
			inset 0 -4px 12px rgba(0, 0, 0, 0.3);
	}

	.big-button.lit {
		background: radial-gradient(circle at 35% 35%, #ff4400, #ee2200, #cc0000);
		border-color: #ff6600;
		box-shadow:
			0 0 60px rgba(255, 50, 0, 0.6),
			0 0 120px rgba(255, 50, 0, 0.3),
			0 8px 32px rgba(0, 0, 0, 0.5),
			inset 0 -4px 12px rgba(0, 0, 0, 0.3);
		animation: pulse 0.8s ease-in-out infinite alternate;
	}

	.big-button.pressed {
		background: radial-gradient(circle at 35% 35%, #884400, #663300, #442200);
		border-color: #aa6600;
	}

	.big-button.winner {
		background: radial-gradient(circle at 35% 35%, #44aa00, #228800, #116600);
		border-color: #66cc00;
		box-shadow:
			0 0 40px rgba(0, 200, 0, 0.4),
			0 8px 32px rgba(0, 0, 0, 0.5);
	}

	.big-button:disabled {
		cursor: default;
	}

	.big-button.dimmed:not(:disabled) {
		cursor: pointer;
	}

	@keyframes pulse {
		from {
			box-shadow:
				0 0 40px rgba(255, 50, 0, 0.4),
				0 0 80px rgba(255, 50, 0, 0.2),
				0 8px 32px rgba(0, 0, 0, 0.5),
				inset 0 -4px 12px rgba(0, 0, 0, 0.3);
		}
		to {
			box-shadow:
				0 0 80px rgba(255, 50, 0, 0.7),
				0 0 160px rgba(255, 50, 0, 0.4),
				0 8px 32px rgba(0, 0, 0, 0.5),
				inset 0 -4px 12px rgba(0, 0, 0, 0.3);
		}
	}

	.btn-text {
		text-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
		letter-spacing: 2px;
	}

	.sync-text {
		animation: fade-blink 0.6s ease-in-out infinite;
	}

	.countdown-text {
		font-size: 4rem;
		animation: countdown-pop 1s ease-out;
	}

	@keyframes countdown-pop {
		0% {
			transform: scale(1.6);
			opacity: 0.5;
		}
		100% {
			transform: scale(1);
			opacity: 1;
		}
	}

	.panel {
		margin-top: 2rem;
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 16px;
		padding: 1.5rem;
		width: 100%;
		max-width: 360px;
		text-align: center;
	}

	.input {
		width: 100%;
		padding: 0.75rem 1rem;
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.08);
		color: #eee;
		font-size: 1rem;
		outline: none;
		box-sizing: border-box;
		margin-bottom: 0.75rem;
	}

	.input:focus {
		border-color: #ff4444;
	}

	.input::placeholder {
		color: #666;
	}

	.action-btn {
		padding: 0.75rem 1.5rem;
		border: none;
		border-radius: 8px;
		font-size: 1rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.15s ease;
		width: 100%;
	}

	.host-btn {
		background: linear-gradient(135deg, #ff4444, #cc2200);
		color: white;
	}

	.host-btn:hover {
		background: linear-gradient(135deg, #ff5555, #dd3300);
	}

	.player-list h3 {
		margin: 0 0 0.5rem;
		color: #aaa;
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 1px;
	}

	.player {
		padding: 0.4rem 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.05);
	}

	.hint {
		color: #888;
		margin: 0.75rem 0 0;
		font-size: 0.9rem;
	}

	.sync-hint {
		color: #ffaa00;
		animation: fade-blink 0.8s ease-in-out infinite;
	}

	.countdown-hint {
		font-size: 1.2rem;
		color: #ff8800;
	}

	.playing-hint {
		font-size: 1.2rem;
		color: #ff8800;
		animation: fade-blink 2s ease-in-out infinite;
	}

	@keyframes fade-blink {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	.results-panel h3 {
		margin: 0 0 1rem;
		font-size: 1.2rem;
	}

	.results-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
	}

	.result-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.6rem 0.8rem;
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.05);
	}

	.result-row.is-winner {
		background: rgba(0, 200, 0, 0.15);
		border: 1px solid rgba(0, 200, 0, 0.3);
	}

	.result-row.is-me {
		border-left: 3px solid #ff8800;
	}

	.rank {
		font-weight: 700;
		color: #888;
		min-width: 2rem;
	}

	.is-winner .rank {
		color: #44cc00;
	}

	.result-name {
		flex: 1;
		text-align: left;
	}

	.result-time {
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.result-diff {
		color: #888;
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
	}

	.error {
		margin-top: 1rem;
		padding: 0.75rem 1rem;
		background: rgba(255, 0, 0, 0.15);
		border: 1px solid rgba(255, 0, 0, 0.3);
		border-radius: 8px;
		color: #ff6666;
		max-width: 360px;
		text-align: center;
	}
</style>
