import { fetchText, fetchBuffer, stripTags, parseSize, magnetFromHash, infoHash } from './lib.mjs';

const BASE = 'https://byrutgame.org';

// byrut — не трекер, а сайт репаков: в выдаче нет ни magnet'ов, ни сидов,
// зато есть готовый .torrent на странице игры. Поэтому magnet считаем сами
// из info-хеша скачанного файла, и только по клику — на поиск это не влияет.
export default {
	id: 'byrut',
	name: 'byrut (репаки)',
	site: BASE,

	async search(query, signal) {
		const html = await fetchText(
			`${BASE}/index.php?do=search&subaction=search&story=${encodeURIComponent(query)}`,
			{ signal },
		);

		// href стоит ПЕРЕД class="search_res", поэтому карточку берём целым тегом <a>:
		// если резать по классу, ссылка каждый раз достаётся от соседней карточки.
		const cards = html.matchAll(
			/<a\s+href="(https:\/\/byrutgame\.org\/\d+-[^"]+\.html)"\s+class="search_res"([\s\S]*?)<\/a>/g,
		);
		const out = [];

		for (const [, path, card] of cards) {
			const title = card.match(/class="search_res_title"[^>]*>([\s\S]*?)<\/h3>/)?.[1];
			if (!title) continue;

			const chips = [...card.matchAll(/class="search_chip[^"]*"[^>]*>([\s\S]*?)<\/span>/g)]
				.map((m) => stripTags(m[1]));
			const year = chips.find((c) => /^(19|20)\d{2}$/.test(c)) ?? '';
			const sizeText = chips.find((c) => /^[\d.,]+\s*(ГБ|МБ|GB|MB)/i.test(c)) ?? '';
			// Счётчик скачиваний — единственная метрика популярности, которую сайт даёт.
			const downloads = Number(
				(card.match(/class="search_chip i_downl"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '')
					.replace(/\D/g, ''),
			) || 0;

			const version = chips.find((c) => /^v\s|^v\d/i.test(c)) ?? '';

			out.push({
				source: 'byrut',
				title: stripTags(title) + (version ? ` [${version}]` : ''),
				date: year,
				dateTs: year ? Date.UTC(Number(year), 0, 1) : 0,
				sizeText,
				sizeBytes: parseSize(sizeText),
				seeders: 0,
				leechers: 0,
				// Сайт сидов не показывает вообще, поэтому их спрашивают у самих
				// трекеров после поиска (см. /api/health). До ответа в колонке
				// стоит счётчик скачиваний сайта — единственное, что тут есть.
				liveHealth: true,
				peersText: downloads ? `⤓ ${downloads.toLocaleString('ru-RU')}` : '—',
				magnet: null,
				magnetId: path,
				link: path,
			});
		}
		return out;
	},

	// Страница игры → id раздачи → сам .torrent → SHA-1 словаря info → magnet.
	async resolveMagnet(pageUrl, signal) {
		if (!pageUrl.startsWith(BASE)) throw new Error('чужая ссылка');
		const page = await fetchText(pageUrl, { signal });
		const id = page.match(/do=download&(?:amp;)?id=(\d+)/)?.[1];
		if (!id) throw new Error('на странице нет .torrent');

		const buf = await fetchBuffer(`${BASE}/index.php?do=download&id=${id}`, {
			signal,
			referer: pageUrl,
		});
		// В <title> сайта имя обёрнуто в «Скачать … через торрент» — вычищаем,
		// иначе это уедет в dn= магнита и будет именем раздачи в клиенте.
		const name = stripTags(page.match(/<title>([^<]*)<\/title>/)?.[1] ?? 'byrut')
			.split('»')[0]
			.replace(/^Скачать\s+/i, '')
			.replace(/\s*(через торрент|бесплатно|на ПК).*$/i, '')
			.trim();
		return magnetFromHash(infoHash(buf), name || 'byrut');
	},
};
