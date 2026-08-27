const $ = (sel) => document.querySelector(sel);

const els = {
	form: $('#form'), q: $('#q'), go: $('#go'), sources: $('#sources'),
	status: $('#status'), toolbar: $('#toolbar'), filter: $('#filter'),
	counter: $('#counter'), table: $('#table'), rows: $('#rows'), health: $('#health'),
	empty: $('#empty'), toast: $('#toast'),
};

const STATUS_TEXT = {
	pending: 'ищет',
	ok: (c) => `${c} найдено`,
	empty: 'пусто',
	timeout: 'не ответил',
	error: 'ошибка',
	setup: 'нужна настройка',
};

let sources = [];
let items = [];
let stream = null;
let sort = { key: 'seeders', dir: -1 };
const timers = new Map();

// ——— источники ———

const enabled = () =>
	[...els.sources.querySelectorAll('input:checked')].map((i) => i.value);

async function loadSources() {
	sources = await fetch('/api/sources').then((r) => r.json());
	// Ненастроенный источник (rutracker без кук) в списке остаётся, но выключен —
	// видно, что он есть, и подсказка объясняет, что с ним делать.
	els.sources.innerHTML = sources
		.map((s) => {
			const hint = s.ready ? '' : ` title="Положите строку Cookie из браузера в ${s.needsCookie}"`;
			return `<label class="${s.ready ? '' : 'not-ready'}"${hint}>` +
				`<input type="checkbox" value="${s.id}"${s.ready ? ' checked' : ''}> ${s.name}</label>`;
		})
		.join('');
}

// ——— панель состояния ———
// Чип каждого источника живёт своей жизнью: пока идёт запрос, тикает секундомер,
// по завершении — сразу видно результат. Никаких «непонятно, ищет или нет».

function resetStatus(list) {
	timers.forEach(clearInterval);
	timers.clear();
	els.status.hidden = false;
	els.status.innerHTML = list
		.map((s) => `<span class="chip pending" data-id="${s.id}">
			<i class="dot"></i><b>${s.name}</b><span class="state">ищет</span><span class="ms">0.0 с</span>
		</span>`)
		.join('');
}

function startTimer(id) {
	const chip = els.status.querySelector(`.chip[data-id="${id}"]`);
	if (!chip) return;
	const t0 = performance.now();
	timers.set(id, setInterval(() => {
		chip.querySelector('.ms').textContent = `${((performance.now() - t0) / 1000).toFixed(1)} с`;
	}, 100));
}

function finishChip(data) {
	const { id, status, count, ms, error, cached } = data;
	clearInterval(timers.get(id));
	timers.delete(id);
	const chip = els.status.querySelector(`.chip[data-id="${id}"]`);
	if (!chip) return;

	chip.className = `chip ${status}`;
	const label = STATUS_TEXT[status];
	chip.querySelector('.state').textContent = typeof label === 'function' ? label(count) : label;
	chip.querySelector('.ms').textContent = `${(ms / 1000).toFixed(1)} с${cached ? ' · кэш' : ''}`;
	chip.title = error ?? (data.query ? `найдено по запросу: ${data.query}` : '');
}

// ——— таблица ———

const escapeHtml = (s) =>
	String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function sortItems(list) {
	const { key, dir } = sort;
	return [...list].sort((a, b) => {
		const x = a[key] ?? 0, y = b[key] ?? 0;
		if (typeof x === 'string' || typeof y === 'string') {
			return String(x).localeCompare(String(y), 'ru') * dir;
		}
		return (x - y) * dir;
	});
}

const btihOf = (m) => m?.match(/xt=urn:btih:([0-9a-fA-F]{40})/)?.[1] ?? null;

// Одну и ту же раздачу отдают несколько сайтов: byrut и The Pirate Bay раздают
// физически один торрент с одним btih, а у byrut три страницы (игра и два DLC)
// вообще ведут на один файл. Схлопываем такие строки, иначе треть выдачи —
// дубли, и непонятно, где смотреть сиды.
//
// Хеш известен не сразу: у строк без magnet'а он появляется только после опроса
// трекеров. Поэтому пересобираем группы на каждый рендер, а строки без хеша
// живут сами по себе — схлопнутся, когда хеш появится.
function dedupe(list) {
	const byHash = new Map();
	const out = [];

	for (const it of list) {
		const hash = it.hash ?? btihOf(it.magnet);
		if (!hash) { out.push(it); continue; }

		const seen = byHash.get(hash);
		if (!seen) {
			// Копия, а не сам элемент: сливать данные соседей в оригинал нельзя,
			// иначе на следующем рендере строка припишет себе чужие сиды.
			const row = { ...it, src: it, alsoOn: [] };
			byHash.set(hash, row);
			out.push(row);
			continue;
		}

		if (it.source !== seen.source && !seen.alsoOn.includes(it.source)) {
			seen.alsoOn.push(it.source);
		}
		// Из дублей берём лучшее: живые сиды с одного сайта, готовый magnet с другого.
		if ((it.seeders ?? 0) > (seen.seeders ?? 0)) {
			seen.seeders = it.seeders;
			seen.leechers = it.leechers;
			seen.healthLive = it.healthLive;
			seen.healthUnverified = it.healthUnverified;
			seen.healthNote = it.healthNote;
			seen.src = it;
		}
		if (!seen.magnet && it.magnet) seen.magnet = it.magnet;
	}
	return out;
}

function render() {
	// Фильтр ищет все слова в любом порядке, а не подстроку целиком: иначе
	// «cyberpunk repack» не находит «Cyberpunk 2077 … RePack от селезень».
	const words = els.filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const needle = words.join(' ');
	const visible = words.length
		? items.filter((i) => {
			const t = i.title.toLowerCase();
			return words.every((w) => t.includes(w));
		})
		: items;

	const merged = dedupe(visible);
	const sorted = sortItems(merged);
	const name = (id) => sources.find((s) => s.id === id)?.name ?? id;

	els.rows.innerHTML = sorted.map((it, idx) => `
		<tr data-idx="${idx}">
			<td>${[it.source, ...(it.alsoOn ?? [])]
				.map((id) => `<span class="src-tag">${escapeHtml(name(id))}</span>`).join(' ')}</td>
			<td class="title">${it.link
				? `<a href="${escapeHtml(it.link)}" target="_blank" rel="noreferrer">${escapeHtml(it.title)}</a>`
				: escapeHtml(it.title)}</td>
			<td class="col-date">${escapeHtml(it.date ?? '')}</td>
			<td class="col-size">${escapeHtml(it.sizeText ?? '')}</td>
			<td class="col-peers${it.healthLive ? ' live' : ''}${it.healthUnverified ? ' unverified' : ''}"${it.healthNote
				? ` title="${escapeHtml(it.healthNote)}"`
				: ''}>${it.peersText && !it.healthLive
				? `<span class="peers-alt">${escapeHtml(it.peersText)}</span>`
				: `<span class="seed">↑${it.seeders}</span> <span class="leech">↓${it.leechers}</span>`}</td>
			<td class="col-act"><div class="actions">
				<button data-act="add" title="Добавить в Transmission">⬇</button>
				<button data-act="copy" title="Копировать magnet">🔗</button>
			</div></td>
		</tr>`).join('');

	els.rows.sortedRef = sorted;
	els.table.hidden = sorted.length === 0;
	const merged_away = visible.length - merged.length;
	const dup = merged_away ? `, ${merged_away} дублей схлопнуто` : '';
	els.counter.textContent = needle
		? `${sorted.length} из ${items.length}${dup}`
		: `${sorted.length} результатов${dup}`;
}

// ——— живые сиды ———
// Сиды в выдаче трекеров — это снимок на момент их переиндексации, а byrut их
// не показывает вовсе. Настоящее число знает только сам трекер раздачи, поэтому
// спрашиваем его напрямую. Для byrut это дорого (нужно скачать .torrent, чтобы
// узнать info-хеш), поэтому идём небольшими пачками и рисуем по мере ответов.

let healthGen = 0;

async function fetchHealth(item) {
	const hash = btihOf(item.magnet);
	const q = hash
		? `hash=${hash}`
		: `source=${item.source}&id=${encodeURIComponent(item.magnetId ?? '')}`;
	const res = await fetch(`/api/health?${q}`);
	const data = await res.json();
	if (!res.ok) throw new Error(data.error);

	// Ноль от публичных трекеров НЕ означает, что раздача мертва: у nnmclub и
	// rutracker рой живёт на их собственном трекере, в magnet'е вообще нет tr=,
	// и снаружи его не видно. Затирать нулём цифру сайта — значит выдавать
	// живую раздачу за дохлую, поэтому берём лучшее из двух и говорим, чьё оно.
	const site = item.seeders ?? 0;
	item.hash = data.hash;
	item.completed = data.completed;
	item.healthTracker = data.tracker;

	if (data.seeders >= site) {
		item.seeders = data.seeders;
		item.leechers = data.leechers;
		item.healthLive = true;
		item.healthNote = `с трекера ${data.tracker} · скачали ${data.completed} раз`;
	} else {
		// Цифру источника оставляем как есть, но помечаем: подтвердить её нечем.
		item.healthLive = false;
		item.healthUnverified = true;
		item.healthNote = data.seeders
			? `сайт: ${site}, публичные трекеры видят только ${data.seeders}`
			: 'публичные трекеры эту раздачу не видят — она на трекере источника; цифра сайта';
	}
}

async function loadHealth(list, concurrency = 3) {
	const gen = ++healthGen;
	const queue = list.filter((i) => !i.healthLive && (i.magnet || i.magnetId));
	if (!queue.length) return;

	els.health.disabled = true;
	let left = queue.length;
	els.health.textContent = `Сиды… ${left}`;

	const worker = async () => {
		while (queue.length) {
			// Новый поиск во время опроса — старые ответы уже никому не нужны.
			if (gen !== healthGen) return;
			const item = queue.shift();
			try { await fetchHealth(item); } catch { item.healthLive = false; }
			els.health.textContent = `Сиды… ${--left}`;
			render();
		}
	};
	await Promise.all(Array.from({ length: concurrency }, worker));

	if (gen !== healthGen) return;
	els.health.disabled = false;
	els.health.textContent = 'Живые сиды';
}

els.health.addEventListener('click', () => loadHealth(items));

// ——— поиск ———

function search(query) {
	stream?.close();
	healthGen++;
	els.health.disabled = false;
	els.health.textContent = 'Живые сиды';
	items = [];
	els.rows.innerHTML = '';
	els.table.hidden = true;
	els.empty.hidden = true;
	els.toolbar.hidden = false;
	els.counter.textContent = '';
	els.go.disabled = true;
	els.go.textContent = 'Ищем…';

	const picked = enabled();
	if (!picked.length) return showToast('Не выбран ни один источник', true);

	resetStatus(sources.filter((s) => picked.includes(s.id)));
	history.replaceState({}, '', `/?q=${encodeURIComponent(query)}`);
	document.title = `${query} — поиск торрентов`;

	stream = new EventSource(`/api/search?q=${encodeURIComponent(query)}&sources=${picked.join(',')}`);

	stream.addEventListener('source-start', (e) => startTimer(JSON.parse(e.data).id));

	// Повтор или запрос другим вариантом строки — тоже видимое состояние,
	// иначе непонятно, чем занят источник, который «долго ищет».
	stream.addEventListener('source-retry', (e) => {
		const { id, attempt, variant } = JSON.parse(e.data);
		const chip = els.status.querySelector(`.chip[data-id="${id}"] .state`);
		if (chip) chip.textContent = attempt > 1 ? `повтор ${attempt}` : 'ищет иначе';
		if (chip) chip.parentElement.title = `запрос: ${variant}`;
	});

	// Результаты дорисовываются по мере прихода — ждать самый медленный трекер не нужно.
	stream.addEventListener('results', (e) => {
		items.push(...JSON.parse(e.data).items);
		render();
	});

	stream.addEventListener('source-done', (e) => finishChip(JSON.parse(e.data)));

	stream.addEventListener('end', (e) => {
		const { total, ms } = JSON.parse(e.data);
		stream.close();
		stream = null;
		els.go.disabled = false;
		els.go.textContent = 'Найти';
		if (!total) {
			els.empty.hidden = false;
			els.empty.textContent = `Ничего не найдено за ${(ms / 1000).toFixed(1)} с. Попробуйте другой запрос или включите остальные источники.`;
			return;
		}
		// Источники без собственной статистики (byrut) досчитываются сами:
		// иначе их строки нельзя честно сравнить с остальными по колонке S/L.
		loadHealth(items.filter((i) => i.liveHealth));
	});

	stream.onerror = () => {
		stream?.close();
		stream = null;
		els.go.disabled = false;
		els.go.textContent = 'Найти';
		timers.forEach(clearInterval);
		timers.clear();
		showToast('Соединение с сервером прервалось', true);
	};
}

// ——— действия со строкой ———

let toastTimer = null;

function showToast(text, isError = false) {
	els.toast.textContent = text;
	els.toast.className = `toast${isError ? ' err' : ''}`;
	els.toast.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { els.toast.hidden = true; }, 4000);
}

// У nnmclub magnet'а в выдаче нет — достаём его по требованию, при первом клике.
async function magnetOf(item) {
	if (item.magnet) return item.magnet;
	const res = await fetch(`/api/magnet?source=${item.source}&id=${encodeURIComponent(item.magnetId)}`);
	const data = await res.json();
	if (!res.ok) throw new Error(data.error ?? 'не удалось получить magnet');
	item.magnet = data.magnet;
	return data.magnet;
}

els.rows.addEventListener('click', async (e) => {
	const btn = e.target.closest('button[data-act]');
	if (!btn) return;

	// В таблице лежат схлопнутые копии — действия выполняем над исходной строкой.
	const row = els.rows.sortedRef[Number(btn.closest('tr').dataset.idx)];
	const item = row.src ?? row;
	btn.classList.add('busy');
	btn.disabled = true;

	try {
		const magnet = await magnetOf(item);

		if (btn.dataset.act === 'copy') {
			await navigator.clipboard.writeText(magnet);
			showToast('Magnet скопирован');
		} else {
			const res = await fetch('/api/add', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ magnet }),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(`${data.error}. ${data.hint ?? ''}`);
			showToast(data.duplicate ? 'Уже есть в Transmission' : `Добавлено: ${data.name || item.title}`);
		}
	} catch (err) {
		showToast(String(err.message ?? err), true);
	} finally {
		btn.classList.remove('busy');
		btn.disabled = false;
	}
});

// ——— события ———

els.form.addEventListener('submit', (e) => {
	e.preventDefault();
	const q = els.q.value.trim();
	if (q.length >= 2) search(q);
});

els.filter.addEventListener('input', render);

document.querySelectorAll('th[data-sort]').forEach((th) => {
	th.addEventListener('click', () => {
		const key = th.dataset.sort;
		sort = { key, dir: sort.key === key ? -sort.dir : (key === 'title' ? 1 : -1) };
		document.querySelectorAll('th[data-sort]').forEach((x) => x.classList.toggle('active', x === th));
		render();
	});
});

await loadSources();

// Поиск из адресной строки — можно держать ссылку в закладках.
const initial = new URL(location.href).searchParams.get('q');
if (initial) {
	els.q.value = initial;
	search(initial);
}
