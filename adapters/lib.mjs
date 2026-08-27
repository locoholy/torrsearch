import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Общие помощники для всех адаптеров.

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Один сетевой запрос: свой таймаут на источник + декодирование в нужную кодировку.
// Ключевая идея всего проекта: мёртвый источник обязан отвалиться сам, а не держать выдачу.
export async function fetchText(url, { signal, encoding = 'utf-8', headers = {} } = {}) {
	const res = await fetch(url, {
		signal,
		redirect: 'follow',
		headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.8', ...headers },
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const buf = await res.arrayBuffer();
	return new TextDecoder(encoding).decode(buf);
}

export async function fetchJson(url, opts = {}) {
	return JSON.parse(await fetchText(url, opts));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
	return String(s)
		.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
		.replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

export function stripTags(s) {
	return decodeEntities(String(s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

export function humanSize(bytes) {
	if (!bytes || bytes < 0) return '';
	const u = ['B', 'KB', 'MB', 'GB', 'TB'];
	let i = 0, n = Number(bytes);
	while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
	return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// Разбор человекочитаемого размера обратно в байты — нужно для единой сортировки
// по колонке, когда один трекер отдаёт байты, а другой строку «170.83 MB».
const UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4,
                кб: 1024, мб: 1024 ** 2, гб: 1024 ** 3, тб: 1024 ** 4 };

export function parseSize(text) {
	const m = String(text).replace(/ /g, ' ').match(/([\d.,]+)\s*([a-zа-я]+)/i);
	if (!m) return 0;
	const mult = UNITS[m[2].toLowerCase()];
	return mult ? Math.round(parseFloat(m[1].replace(',', '.')) * mult) : 0;
}

export function magnetFromHash(hash, name) {
	const trackers = [
		'udp://tracker.opentrackr.org:1337/announce',
		'udp://open.stealth.si:80/announce',
		'udp://tracker.torrent.eu.org:451/announce',
		'udp://exodus.desync.com:6969/announce',
	];
	const tr = trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
	return `magnet:?xt=urn:btih:${hash.toLowerCase()}&dn=${encodeURIComponent(name)}${tr}`;
}

// Сырые байты вместо текста — нужно для .torrent-файлов.
export async function fetchBuffer(url, { signal, headers = {}, referer } = {}) {
	const res = await fetch(url, {
		signal,
		redirect: 'follow',
		headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}), ...headers },
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

// Пропускает одно bencode-значение и возвращает позицию сразу за ним.
function skipBencode(buf, i) {
	const c = buf[i];
	if (c === 0x64 || c === 0x6c) {                     // d… / l…
		i++;
		while (buf[i] !== 0x65) i = skipBencode(buf, i);
		return i + 1;
	}
	if (c === 0x69) return buf.indexOf(0x65, i) + 1;    // i…e
	const colon = buf.indexOf(0x3a, i);                 // <длина>:<байты>
	return colon + 1 + Number(buf.subarray(i, colon).toString('latin1'));
}

// btih — это SHA-1 от словаря info ровно в том виде, в каком он лежит в файле.
// Поэтому info не разбираем, а только находим его границы и хешируем как есть:
// любая пересборка изменила бы порядок ключей и дала другой хеш.
export function infoHash(buf) {
	if (buf[0] !== 0x64) throw new Error('это не .torrent');
	let i = 1;
	while (i < buf.length && buf[i] !== 0x65) {
		const keyEnd = skipBencode(buf, i);
		const colon = buf.indexOf(0x3a, i);
		const key = buf.subarray(colon + 1, keyEnd).toString('latin1');
		const valEnd = skipBencode(buf, keyEnd);
		if (key === 'info') {
			return createHash('sha1').update(buf.subarray(keyEnd, valEnd)).digest('hex');
		}
		i = valEnd;
	}
	throw new Error('в .torrent нет словаря info');
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн',
                'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

// Трекеры пишут дату по-человечески («09 Июл 26»), а сортировать колонку надо
// числом. Без этого источник со строковой датой уезжает в конец таблицы.
export function parseRuDate(text) {
	const m = String(text).trim().match(/(\d{1,2})[\s.-]+([А-Яа-яA-Za-z]{3,})[\s.-]+(\d{2,4})/);
	if (!m) return 0;
	const mi = MONTHS.indexOf(m[2].toLowerCase().slice(0, 3));
	if (mi < 0) return 0;
	const y = Number(m[3]);
	return Date.UTC(y < 100 ? 2000 + y : y, mi, Number(m[1]));
}

// Старые форумы (nnmclub, rutracker) живут в windows-1251: кириллицу в строке
// поиска надо кодировать вручную, потому что TextEncoder в Node умеет только utf-8,
// а utf-8 в их поиске даёт мусор вместо результатов.
export function cp1251Query(s) {
	let out = '';
	for (const ch of s) {
		const c = ch.codePointAt(0);
		let byte = null;
		if (c < 0x80) { out += encodeURIComponent(ch); continue; }
		if (c === 0x401) byte = 0xa8;
		else if (c === 0x451) byte = 0xb8;
		else if (c >= 0x410 && c <= 0x44f) byte = c - 0x410 + 0xc0;
		out += byte === null ? encodeURIComponent(ch) : '%' + byte.toString(16).toUpperCase();
	}
	return out;
}

// Часть сайтов закрыта антибот-защитой (Cloudflare у rutracker, DDoS-Guard у
// igruha) или требует логина. Челлендж из скрипта не решается, но его уже решил
// браузер пользователя — поэтому берём оттуда готовые куки. Файл читается на
// каждый запрос, чтобы добавленные куки подхватились без перезапуска сервера.
export function cookieFor(name) {
	const fromEnv = process.env[`${name.toUpperCase()}_COOKIE`]?.trim();
	if (fromEnv) return fromEnv;
	try {
		return readFileSync(cookiePath(name), 'utf-8').trim();
	} catch {
		return '';
	}
}

export function cookiePath(name) {
	return join(homedir(), '.config', 'torrsearch', `${name}.cookie`);
}

// Отдельный тип ошибки: «не настроено» — это не сбой сети, повторять бессмысленно,
// и в интерфейсе должно выглядеть иначе, чем упавший трекер.
export function needsSetup(message) {
	return Object.assign(new Error(message), { setup: true });
}
