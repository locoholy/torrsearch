import { fetchText, stripTags, humanSize, cp1251Query, cookieFor, cookiePath, needsSetup } from './lib.mjs';

const BASE = 'https://rutracker.org/forum';
const COOKIE_FILE = cookiePath('rutracker');
const cookie = () => cookieFor('rutracker');

function headers() {
	const c = cookie();
	if (!c) {
		throw needsSetup(`нет кук: положите строку Cookie из браузера в ${COOKIE_FILE}`);
	}
	return {
		Cookie: c,
		// UA обязан совпадать с браузером, в котором выдан cf_clearance,
		// иначе Cloudflare считает куку чужой и снова показывает челлендж.
		...(process.env.RUTRACKER_UA ? { 'User-Agent': process.env.RUTRACKER_UA } : {}),
	};
}

function assertLoggedIn(html) {
	if (/Just a moment|cf_chl_opt|challenge-platform/.test(html)) {
		throw needsSetup('Cloudflare не пропустил: нужна свежая кука cf_clearance');
	}
	if (/name="login_username"|Вы не авторизованы|log-in-form/.test(html)) {
		throw needsSetup('куки просрочены: пере-логиньтесь в браузере и обновите файл');
	}
}

export default {
	id: 'rutracker',
	name: 'RuTracker',
	site: BASE,
	needsCookie: COOKIE_FILE,
	// Пока кук нет, источник не включается сам: иначе он на каждом поиске
	// светил бы «нужна настройка» и мешал смотреть на остальные.
	ready: () => Boolean(cookie()),

	async search(query, signal) {
		const html = await fetchText(`${BASE}/tracker.php?nm=${cp1251Query(query)}`, {
			signal,
			encoding: 'windows-1251',
			headers: headers(),
		});
		assertLoggedIn(html);

		const rows = html.match(/<tr[^>]*class="[^"]*tCenter[^"]*"[^>]*>[\s\S]*?<\/tr>/g) ?? [];
		const out = [];

		for (const row of rows) {
			const id = row.match(/data-topic_id="(\d+)"/)?.[1];
			const title = row.match(/data-topic_id="\d+"[^>]*>([\s\S]*?)<\/a>/)?.[1];
			if (!id || !title) continue;

			// Точный размер лежит в <u> рядом с человекочитаемым — берём байты.
			const sizeBytes = Number(row.match(/tor-size[^>]*>[\s\S]*?<u>(\d+)<\/u>/)?.[1] ?? 0);
			// Дата регистрации раздачи — последний unix-timestamp в строке.
			const ts = Number(row.match(/<u>(\d{9,10})<\/u>/g)?.at(-1)?.match(/\d+/)?.[0] ?? 0) * 1000;

			out.push({
				source: 'rutracker',
				title: stripTags(title),
				date: ts ? new Date(ts).toLocaleDateString('ru-RU') : '',
				dateTs: ts,
				sizeText: humanSize(sizeBytes),
				sizeBytes,
				seeders: Number(row.match(/seedmed[^>]*>(?:<b>)?(\d+)/)?.[1] ?? 0),
				leechers: Number(row.match(/leechmed[^>]*>(?:<b>)?(\d+)/)?.[1] ?? 0),
				// Magnet есть только на странице темы — тянем по клику,
				// чтобы не делать полсотни запросов на каждый поиск.
				magnet: null,
				magnetId: id,
				link: `${BASE}/viewtopic.php?t=${id}`,
			});
		}
		return out;
	},

	async resolveMagnet(id, signal) {
		const html = await fetchText(`${BASE}/viewtopic.php?t=${encodeURIComponent(id)}`, {
			signal,
			encoding: 'windows-1251',
			headers: headers(),
		});
		assertLoggedIn(html);
		return html.match(/magnet:\?xt=urn:btih:[^"'&\s]+/)?.[0] ?? null;
	},
};
