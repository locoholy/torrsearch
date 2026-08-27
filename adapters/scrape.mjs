import dgram from 'node:dgram';

// Здоровье раздачи спрашиваем не у сайта, а у самих трекеров — протокол scrape
// (BEP 15). Так цифры живые и одинаковые для всех источников: byrut сиды вообще
// не показывает, а у rutor/nnm они нарисованы на момент последней переиндексации.
const MAGIC = 0x41727101980n;

// Разные трекеры видят разные куски одного роя, поэтому опрашиваем несколько
// и берём лучший ответ. Список — публичные трекеры, отвечающие из РФ.
const TRACKERS = [
	['tracker.opentrackr.org', 1337],
	['open.stealth.si', 80],
	['open.demonii.com', 1337],
	['tracker.filemail.com', 6969],
	['tracker.torrent.eu.org', 451],
	['exodus.desync.com', 6969],
	['tracker.dler.org', 6969],
];

const TTL = 5 * 60 * 1000;
const cache = new Map();

function scrapeOne(host, port, hashHex, timeout) {
	return new Promise((resolve, reject) => {
		const sock = dgram.createSocket('udp4');
		const tid = Math.floor(Math.random() * 0xffffffff);
		const finish = (err, val) => {
			clearTimeout(timer);
			sock.close();
			err ? reject(err) : resolve(val);
		};
		const timer = setTimeout(() => finish(new Error('таймаут')), timeout);

		// Шаг 1: connect — трекер выдаёт connection_id, без него scrape не примут.
		const connect = Buffer.alloc(16);
		connect.writeBigUInt64BE(MAGIC, 0);
		connect.writeUInt32BE(0, 8);
		connect.writeUInt32BE(tid, 12);

		sock.on('error', finish);
		sock.on('message', (msg) => {
			if (msg.length < 8 || msg.readUInt32BE(4) !== tid) return;
			const action = msg.readUInt32BE(0);

			// Шаг 2: сам scrape по 20-байтовому info-хешу.
			if (action === 0 && msg.length >= 16) {
				const req = Buffer.concat([msg.subarray(8, 16), Buffer.alloc(8), Buffer.from(hashHex, 'hex')]);
				req.writeUInt32BE(2, 8);
				req.writeUInt32BE(tid, 12);
				return sock.send(req, port, host);
			}
			if (action === 2 && msg.length >= 20) {
				return finish(null, {
					seeders: msg.readUInt32BE(8),
					completed: msg.readUInt32BE(12),
					leechers: msg.readUInt32BE(16),
					tracker: host,
				});
			}
			if (action === 3) finish(new Error(msg.subarray(8).toString('utf-8')));
		});
		sock.send(connect, port, host);
	});
}

export async function scrapeHealth(hashHex, { timeout = 4000 } = {}) {
	const hash = String(hashHex).toLowerCase();
	if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error('нужен btih из 40 hex-символов');

	const hit = cache.get(hash);
	if (hit && Date.now() - hit.ts < TTL) return hit.val;

	const answers = (await Promise.allSettled(
		TRACKERS.map(([h, p]) => scrapeOne(h, p, hash, timeout)),
	))
		.filter((r) => r.status === 'fulfilled')
		.map((r) => r.value);

	if (!answers.length) throw new Error('ни один трекер не ответил');

	// Берём трекер с самым большим роем: он видит раздачу полнее остальных.
	const best = answers.reduce((a, b) => (b.seeders > a.seeders ? b : a));
	const val = {
		...best,
		// Сколько раз раздачу вообще скачали до конца — лучший признак «живучести»
		// в долгую, чем сиды прямо сейчас.
		completed: Math.max(...answers.map((a) => a.completed)),
		trackers: answers.length,
	};
	cache.set(hash, { ts: Date.now(), val });
	return val;
}

// btih одинаково нужен и из готового magnet'а, и из посчитанного нами хеша.
export function hashFromMagnet(magnet) {
	return magnet?.match(/xt=urn:btih:([0-9a-fA-F]{40})/)?.[1]?.toLowerCase() ?? null;
}
