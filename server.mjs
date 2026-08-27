import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import rutor from './adapters/rutor.mjs';
import nnm from './adapters/nnmclub.mjs';
import tpb from './adapters/apibay.mjs';
import byrut from './adapters/byrut.mjs';
import rutracker from './adapters/rutracker.mjs';
import { scrapeHealth, hashFromMagnet } from './adapters/scrape.mjs';

const ADAPTERS = [rutor, nnm, tpb, byrut, rutracker];
const BY_ID = new Map(ADAPTERS.map((a) => [a.id, a]));

const PORT = Number(process.env.PORT ?? 8777);
// Таймаут на ОДНУ попытку. Часть трекеров с российских сетей отвечает через раз
// (сейчас так ведёт себя tpb): соединение не отбивается ошибкой, а просто виснет,
// зато повтор проходит за полсекунды. Поэтому короткая попытка + один повтор
// надёжнее, чем одно долгое ожидание.
const SOURCE_TIMEOUT = Number(process.env.SOURCE_TIMEOUT ?? 5000);
const ATTEMPTS = Number(process.env.ATTEMPTS ?? 2);
const MAGNET_TIMEOUT = Number(process.env.MAGNET_TIMEOUT ?? 15000);
const CACHE_TTL = Number(process.env.CACHE_TTL ?? 10 * 60 * 1000);
const TRANSMISSION = process.env.TRANSMISSION_RPC ?? 'http://127.0.0.1:9091/transmission/rpc';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

// Кэш выдачи по источнику: повторный тот же запрос отвечает мгновенно,
// вместо того чтобы снова ждать трекер по несколько секунд.
const cache = new Map();

function cacheGet(key) {
	const hit = cache.get(key);
	if (!hit) return null;
	if (Date.now() - hit.ts > CACHE_TTL) { cache.delete(key); return null; }
	return hit.items;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

// «Mortal Shell 2» на трекерах не находится ничего, потому что раздача называется
// «Mortal Shell II». Меняем цифру на римскую и наоборот — отдельным вариантом запроса.
function swapNumerals(q) {
	const toRoman = q.replace(/(^|\s)(\d{1,2})(?=$|\s)/g, (m, pre, d) => {
		const n = Number(d);
		return n >= 1 && n <= 10 ? pre + ROMAN[n - 1] : m;
	});
	if (toRoman !== q) return toRoman;

	return q.replace(/(^|\s)(I{1,3}|IV|VI{0,3}|IX|X)(?=$|\s)/gi, (m, pre, r) => {
		const i = ROMAN.findIndex((x) => x.toLowerCase() === r.toLowerCase());
		return i >= 0 ? pre + (i + 1) : m;
	});
}

// Многие трекеры ищут по строке буквально: «assassin's creed» даёт ноль,
// а «assassins creed» — 43 результата. Поэтому на пустой выдаче пробуем
// запрос без апострофов и с другим написанием номера части.
function queryVariants(query) {
	const stripped = query
		.replace(/[\u2019'`]/g, '')
		.replace(/[:;,!?()\[\]]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

	const all = [query, stripped, swapNumerals(query), swapNumerals(stripped)];
	// Пустые и повторы убираем, но не больше трёх попыток на источник.
	return [...new Set(all.filter(Boolean))].slice(0, 3);
}

// Одна попытка обращения к трекеру со своим таймаутом.
async function attempt(adapter, query) {
	return adapter.search(query, AbortSignal.timeout(SOURCE_TIMEOUT));
}

// Один источник = одна независимая задача со своим таймаутом и повторами.
// Упавший или зависший трекер не задерживает остальные и не ломает выдачу.
async function runSource(adapter, query, onEvent) {
	const key = `${adapter.id}:${query}`;
	const started = Date.now();
	onEvent('source-start', { id: adapter.id });

	const cached = cacheGet(key);
	if (cached) {
		if (cached.length) onEvent('results', { id: adapter.id, items: cached });
		onEvent('source-done', {
			id: adapter.id, count: cached.length, ms: Date.now() - started,
			status: cached.length ? 'ok' : 'empty', cached: true,
		});
		return cached.length;
	}

	const variants = queryVariants(query);
	let lastError = null;
	let timedOut = false;
	let setup = false;

	outer:
	for (const [vi, variant] of variants.entries()) {
		for (let tryNo = 1; tryNo <= ATTEMPTS; tryNo++) {
			if (tryNo > 1 || vi > 0) {
				onEvent('source-retry', { id: adapter.id, attempt: tryNo, variant });
			}
			try {
				const items = await attempt(adapter, variant);
				// Пустой ответ — не ошибка: пробуем следующий вариант запроса, если он есть.
				if (!items.length && vi < variants.length - 1) break;

				cache.set(key, { ts: Date.now(), items });
				if (items.length) onEvent('results', { id: adapter.id, items });
				onEvent('source-done', {
					id: adapter.id, count: items.length, ms: Date.now() - started,
					status: items.length ? 'ok' : 'empty',
					query: variant === query ? undefined : variant,
				});
				return items.length;
			} catch (err) {
				lastError = err;
				timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
				// Ненастроенный источник (нет кук) не чинится ни повтором, ни другим
				// написанием запроса — не тратим на него таймауты, сообщаем сразу.
				if (err.setup) { setup = true; break outer; }
			}
		}
		// Сюда попадаем, если все попытки этого варианта упали. Недоступный трекер
		// другим написанием запроса не чинится — не тратим на него ещё один круг.
		if (lastError) break;
	}

	onEvent('source-done', {
		id: adapter.id, count: 0, ms: Date.now() - started,
		status: setup ? 'setup' : timedOut ? 'timeout' : 'error',
		error: timedOut
			? `нет ответа за ${ATTEMPTS} попытки по ${SOURCE_TIMEOUT / 1000} с`
			: String(lastError?.message ?? lastError),
	});
	return 0;
}

// Поиск отдаётся потоком (SSE): результаты каждого трекера уходят в браузер
// сразу, как пришли. Именно этого не хватало исходному сайту.
async function handleSearch(req, res, url) {
	const query = (url.searchParams.get('q') ?? '').trim();
	if (query.length < 2) {
		res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
		return res.end(JSON.stringify({ error: 'Запрос должен быть не короче 2 символов' }));
	}

	const requested = (url.searchParams.get('sources') ?? '').split(',').filter(Boolean);
	const chosen = requested.length
		? requested.map((id) => BY_ID.get(id)).filter(Boolean)
		: ADAPTERS;

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	});

	let closed = false;
	req.on('close', () => { closed = true; });

	const send = (event, data) => {
		if (closed) return;
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};

	const started = Date.now();
	send('start', { query, sources: chosen.map((a) => ({ id: a.id, name: a.name })) });

	const counts = await Promise.all(chosen.map((a) => runSource(a, query, send)));

	send('end', { total: counts.reduce((a, b) => a + b, 0), ms: Date.now() - started });
	res.end();
}

async function handleMagnet(req, res, url) {
	const adapter = BY_ID.get(url.searchParams.get('source') ?? '');
	const id = url.searchParams.get('id');
	res.setHeader('Content-Type', 'application/json; charset=utf-8');

	if (!adapter?.resolveMagnet || !id) {
		res.writeHead(400);
		return res.end(JSON.stringify({ error: 'Источник не умеет отдавать magnet по id' }));
	}
	try {
		// Здесь таймаут щедрее, чем на поиске: это клик по конкретной строке, и byrut
		// успевает сходить и за страницей игры, и за самим .torrent-файлом.
		const magnet = await adapter.resolveMagnet(id, AbortSignal.timeout(MAGNET_TIMEOUT));
		if (!magnet) throw new Error('magnet на странице не найден');
		res.writeHead(200);
		res.end(JSON.stringify({ magnet }));
	} catch (err) {
		res.writeHead(502);
		res.end(JSON.stringify({ error: String(err.message ?? err) }));
	}
}

// Живые сиды прямо с трекеров. Нужно для byrut, который статистику не показывает
// вовсе, и полезно для остальных: у них цифры на момент переиндексации, а не сейчас.
async function handleHealth(req, res, url) {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	try {
		let hash = url.searchParams.get('hash');

		// Хеша нет — значит, у строки не было magnet'а. Достаём его тем же путём,
		// что и по кнопке: для byrut это скачать .torrent и посчитать SHA-1 от info.
		if (!hash) {
			const adapter = BY_ID.get(url.searchParams.get('source') ?? '');
			const id = url.searchParams.get('id');
			if (!adapter?.resolveMagnet || !id) throw new Error('нужен hash или source+id');
			hash = hashFromMagnet(await adapter.resolveMagnet(id, AbortSignal.timeout(MAGNET_TIMEOUT)));
			if (!hash) throw new Error('не удалось получить info-хеш');
		}

		// Сначала дожидаемся трекеров и только потом пишем заголовки: иначе на
		// упавшем scrape catch попробует ответить второй раз по уже отданным
		// заголовкам, и процесс свалится целиком.
		const health = await scrapeHealth(hash);
		res.writeHead(200);
		res.end(JSON.stringify({ hash, ...health }));
	} catch (err) {
		res.writeHead(502);
		res.end(JSON.stringify({ error: String(err.message ?? err) }));
	}
}

// Transmission требует session-id: первый запрос всегда отвечает 409 и заголовком,
// который надо повторить. Поэтому запрос делается дважды.
async function transmissionRpc(body, sessionId = '') {
	const res = await fetch(TRANSMISSION, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Transmission-Session-Id': sessionId },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(5000),
	});
	if (res.status === 409) {
		const fresh = res.headers.get('x-transmission-session-id');
		if (!fresh || sessionId) throw new Error('Transmission не выдал session-id');
		return transmissionRpc(body, fresh);
	}
	if (!res.ok) throw new Error(`Transmission ответил HTTP ${res.status}`);
	return res.json();
}

async function handleAdd(req, res) {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	res.setHeader('Content-Type', 'application/json; charset=utf-8');

	try {
		const { magnet } = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
		if (!magnet?.startsWith('magnet:')) throw new Error('Пустая magnet-ссылка');

		const out = await transmissionRpc({
			method: 'torrent-add',
			arguments: { filename: magnet },
		});
		if (out.result !== 'success') throw new Error(out.result);

		const added = out.arguments['torrent-added'] ?? out.arguments['torrent-duplicate'];
		res.writeHead(200);
		res.end(JSON.stringify({
			ok: true,
			name: added?.name ?? '',
			duplicate: Boolean(out.arguments['torrent-duplicate']),
		}));
	} catch (err) {
		res.writeHead(502);
		res.end(JSON.stringify({
			error: String(err.message ?? err),
			hint: 'Включите в Transmission: Правка → Настройки → Удалённый доступ (порт 9091)',
		}));
	}
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
               '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

async function serveStatic(res, urlPath) {
	const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
	const file = path.join(PUBLIC, rel);
	// Не выпускаем запрос за пределы public/.
	if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }

	try {
		const data = await fs.readFile(file);
		res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
		res.end(data);
	} catch {
		res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
		res.end('404');
	}
}

http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host}`);
	try {
		if (url.pathname === '/api/search') return await handleSearch(req, res, url);
		if (url.pathname === '/api/magnet') return await handleMagnet(req, res, url);
		if (url.pathname === '/api/health') return await handleHealth(req, res, url);
		if (url.pathname === '/api/add' && req.method === 'POST') return await handleAdd(req, res);
		if (url.pathname === '/api/sources') {
			res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
			return res.end(JSON.stringify(ADAPTERS.map((a) => ({ id: a.id, name: a.name, site: a.site, needsCookie: a.needsCookie ?? null, ready: a.ready?.() ?? true }))));
		}
		return await serveStatic(res, url.pathname);
	} catch (err) {
		// Ответ мог быть уже начат (SSE или ошибка в обработчике) — тогда писать
		// заголовки нельзя: это второе исключение, которое уронит весь сервер.
		if (!res.headersSent) {
			res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
		}
		res.end(res.headersSent ? '' : String(err.message ?? err));
		console.error('запрос упал:', req.url, String(err.message ?? err));
	}
}).listen(PORT, '127.0.0.1', () => {
	console.log(`torrsearch: http://127.0.0.1:${PORT}`);
	console.log(`источники: ${ADAPTERS.map((a) => a.id).join(', ')}  таймаут: ${SOURCE_TIMEOUT} мс`);
});
