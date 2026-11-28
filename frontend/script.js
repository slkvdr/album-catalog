// ===== Справочники =====

const STATUSES = {
  want: 'Хочу послушать',
  listening: 'Слушаю',
  listened: 'Прослушано'
};


const DEFAULT_COVER = 'img/placeholder.svg';

// ===== Состояние страницы =====

let ALBUMS = [];             // каталог с сервера
let currentUser = null;      // null, если пользователь не вошёл
let library = new Map();     // album_id -> { status, rating, note }

// ===== Работа с сервером =====

class ApiError extends Error {
  constructor(status, message, fields = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const options = { method, credentials: 'same-origin' };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch('/api' + path, options);
  } catch (error) {
    throw new ApiError(0, 'Нет связи с сервером. Проверьте подключение и попробуйте ещё раз.');
  }

  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(response.status, (data && data.detail) || 'Что-то пошло не так. Попробуйте позже.', (data && data.fields) || {});
  }
  return data;
}

async function loadSession() {
  try {
    currentUser = await api('/me');
    const items = await api('/library');
    library = new Map(items.map(item => [item.album_id, item]));
  } catch (error) {
    currentUser = null;
    library = new Map();
  }
}

const isInList = id => Boolean(library.get(id) && library.get(id).status);

// Сервер удаляет строку, когда у альбома не осталось ни статуса, ни оценки, ни заметки
async function saveEntry(albumId, changes) {
  const entry = await api('/library/' + albumId, { method: 'PUT', body: changes });
  if (entry.status || entry.rating || entry.note || entry.favorite) library.set(albumId, entry);
  else library.delete(albumId);
  return entry;
}

// ===== Общие функции =====

const byId = id => document.getElementById(id);
const findAlbum = id => ALBUMS.find(album => album.id === id);
const decadeOf = album => Math.floor(album.year / 10) * 10;
const normalize = text => text.toLowerCase().replace(/ё/g, 'е').trim();
const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);
const albumDetails = album => `${album.artist}, ${album.year}, ${album.style}`;

// Склонение: pluralize(2, ['альбом', 'альбома', 'альбомов']) -> «альбома»
function pluralize(n, [one, few, many]) {
  const last = n % 10;
  const lastTwo = n % 100;
  if (last === 1 && lastTwo !== 11) return one;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return few;
  return many;
}

const pluralAlbums = n => `${n} ${pluralize(n, ['альбом', 'альбома', 'альбомов'])}`;

function formatRating(value) {
  return value.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function formatTime(ms) {
  const totalSeconds = Math.round(ms / 1000);
  return Math.floor(totalSeconds / 60) + ':' + String(totalSeconds % 60).padStart(2, '0');
}

// Короткая запись для создания элементов: el('p', { class: 'x', text: '...' }, child1, child2)
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === 'text') node.textContent = value;
    else node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

function showBanner(text) {
  const main = document.querySelector('main');
  const old = main.querySelector('.banner');
  if (old) old.remove();
  main.prepend(el('p', { class: 'banner', role: 'alert', text }));
}

function setStatus(node, text, isError = false) {
  node.textContent = text;
  node.classList.toggle('is-error', isError);
}

function initTheme() {
  const button = byId('theme-toggle');
  function apply(theme) {
    document.documentElement.dataset.theme = theme;
    button.textContent = theme === 'dark' ? '☀' : '☾';
    button.setAttribute('aria-label', theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему');
  }
  apply(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  button.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    apply(next);
    try {
      localStorage.setItem('loop-theme', next);
    } catch (error) {
      // выбор не сохранится, но тема переключится
    }
  });
}

function updateAuthLink() {
  if (!currentUser) return;
  const authLink = byId('auth-link');
  for (const link of [authLink, byId('footer-auth')]) {
    link.textContent = 'Кабинет';
    link.setAttribute('href', 'cabinet.html');
  }
  if (location.pathname.endsWith('cabinet.html')) authLink.setAttribute('aria-current', 'page');
  else authLink.removeAttribute('aria-current');

  if (currentUser.is_admin) {
    const adminLink = el('a', { href: 'admin.html', text: 'Управление' });
    if (location.pathname.endsWith('admin.html')) adminLink.setAttribute('aria-current', 'page');
    authLink.closest('li').before(el('li', {}, adminLink));
  }
}

function createCard(album) {
  const link = el('a', { href: 'album.html?id=' + album.id },
    el('img', {
      src: album.cover,
      alt: `Обложка альбома «${album.title}», ${album.artist}`,
      width: 400, height: 400, loading: 'lazy'
    }),
    el('span', { class: 'card-rating' },
      el('span', { class: 'visually-hidden', text: 'Оценка ' }),
      el('span', { 'aria-hidden': 'true', text: '★ ' }),
      formatRating(album.rating)),
    el('h3', { text: album.title })
  );
  if (isInList(album.id)) {
    link.append(el('span', { class: 'card-badge' },
      el('span', { class: 'visually-hidden', text: 'В вашем списке' })));
  }
  return el('li', {}, el('article', { class: 'card' }, link, el('p', { text: albumDetails(album) })));
}

function renderCards(container, albums) {
  container.replaceChildren(...albums.map(album => createCard(album)));
}

// Генератор псевдослучайных чисел с начальным значением: при одном и том же значении порядок один и тот же
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Подборка недели: из лучших по оценке альбомов берутся случайные, но порядок зависит только от номера недели,
// поэтому в течение недели подборка одинакова у всех, а потом меняется
function weeklyPicks(limit = 6) {
  const weekNumber = Math.floor(Date.now() / (7 * 24 * 3600 * 1000));
  const random = mulberry32(weekNumber);
  const best = [...ALBUMS].sort((a, b) => b.rating - a.rating || a.id - b.id).slice(0, Math.max(limit * 2, 8));
  for (let i = best.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [best[i], best[j]] = [best[j], best[i]];
  }
  return best.slice(0, limit);
}

// ===== Вкладки (вход и регистрация, настройки кабинета) =====

function initTabs() {
  for (const list of document.querySelectorAll('[role="tablist"]')) {
    const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
    const select = (tab, focus = false) => {
      tabs.forEach(item => {
        const active = item === tab;
        item.setAttribute('aria-selected', active);
        item.tabIndex = active ? 0 : -1;
        byId(item.getAttribute('aria-controls')).hidden = !active;
      });
      if (focus) tab.focus();
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => select(tab));
      tab.addEventListener('keydown', event => {
        const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        select(tabs[(index + step + tabs.length) % tabs.length], true);
      });
    });
    // login.html#register сразу открывает регистрацию
    const wanted = tabs.find(tab => tab.dataset.hash && tab.dataset.hash === location.hash.slice(1));
    if (wanted) select(wanted);
  }
}

// ===== Уведомления, автосохранение заметок, показ пароля =====

let toastTimer = 0;

function initToast() {
  document.body.append(el('div', { id: 'toast', class: 'toast', role: 'status' }));
}

// Короткое сообщение внизу экрана; action: { label, run } добавляет кнопку, например «Отменить»
function showToast(text, action) {
  const box = byId('toast');
  const nodes = [el('span', { text })];
  if (action) {
    const button = el('button', { type: 'button', class: 'toast-action', text: action.label });
    button.addEventListener('click', async () => {
      box.classList.remove('is-visible');
      try {
        await action.run();
      } catch (error) {
        showToast(error.message);
      }
    });
    nodes.push(button);
  }
  box.replaceChildren(...nodes);
  box.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('is-visible'), action ? 6000 : 3500);
}

// Заметка сохраняется сама: через секунду после последнего ввода и при уходе из поля
function setupNote({ field, status, clearButton, albumId, note }) {
  let saved = note;
  let timer = 0;
  field.value = note;
  const sync = () => { clearButton.hidden = !field.value.trim(); };

  async function save() {
    clearTimeout(timer);
    const value = field.value.trim();
    if (value === saved) return;
    setStatus(status, 'Сохраняем…');
    try {
      await saveEntry(albumId, { note: value });
      saved = value;
      setStatus(status, 'Сохранено');
    } catch (error) {
      setStatus(status, error.message, true);
    }
  }

  field.addEventListener('input', () => {
    sync();
    setStatus(status, '');
    clearTimeout(timer);
    timer = setTimeout(save, 1000);
  });
  field.addEventListener('blur', save);
  clearButton.addEventListener('click', async () => {
    const previous = field.value;
    field.value = '';
    sync();
    await save();
    if (status.classList.contains('is-error')) return;
    showToast('Заметка удалена', {
      label: 'Отменить',
      run: async () => {
        field.value = previous;
        sync();
        await save();
      }
    });
  });
  sync();
}

const ICON_EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M6.5 6.5A16.6 16.6 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 4.5-1.1M10 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

// У каждого поля пароля появляется кнопка «показать»
function initPasswordToggles() {
  for (const input of document.querySelectorAll('input[type="password"]')) {
    const wrap = el('div', { class: 'password-wrap' });
    const button = el('button', { type: 'button', class: 'password-toggle', 'aria-label': 'Показать пароль', 'aria-pressed': 'false' });
    button.innerHTML = ICON_EYE;
    input.replaceWith(wrap);
    wrap.append(input, button);
    button.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.innerHTML = show ? ICON_EYE_OFF : ICON_EYE;
      button.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
      button.setAttribute('aria-pressed', show);
    });
  }
}

// ===== Формы: проверка полей и ошибки рядом с полем =====

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const emailRule = value => {
  if (!value.trim()) return 'Введите адрес почты.';
  return EMAIL_PATTERN.test(value.trim()) ? '' : 'Проверьте адрес: он должен выглядеть как name@example.com.';
};
const nameRule = value => value.trim().length < 2 ? 'Введите имя — не короче двух символов.' : '';

const contactRules = {
  name: nameRule,
  email: emailRule,
  message: value => value.trim().length < 10 ? 'Сообщение слишком короткое — напишите хотя бы 10 символов.' : ''
};
const loginRules = {
  email: emailRule,
  password: value => value ? '' : 'Введите пароль.'
};
const registerRules = {
  name: nameRule,
  email: emailRule,
  password: value => value.length < 8 ? 'Пароль — не короче 8 символов.' : ''
};

function showFieldError(input, message) {
  input.closest('.field').querySelector('.field-error').textContent = message;
  input.setAttribute('aria-invalid', message !== '');
}

// rules: { имяПоля: функцияПроверки }, onValid(values): отправка данных после успешной проверки
function setupForm(form, rules, onValid) {
  const status = form.querySelector('.form-status');
  const names = Object.keys(rules);

  function check(name) {
    const input = form.elements[name];
    const message = rules[name](input.value);
    showFieldError(input, message);
    return message === '';
  }

  names.forEach(name => {
    const input = form.elements[name];
    input.addEventListener('blur', () => check(name));
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') === 'true') check(name);
    });
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    setStatus(status, '');
    const invalid = names.filter(name => !check(name));
    if (invalid.length) {
      form.elements[invalid[0]].focus();
      return;
    }

    const values = Object.fromEntries(new FormData(form));
    try {
      await onValid(values);
    } catch (error) {
      const fieldNames = Object.keys(error.fields || {}).filter(name => form.elements[name] && form.elements[name].closest('.field'));
      fieldNames.forEach(name => showFieldError(form.elements[name], error.fields[name]));
      if (fieldNames.length) form.elements[fieldNames[0]].focus();
      else setStatus(status, error.message, true);
    }
  });

  return status;
}

function initContactForm() {
  const form = byId('contact-form');
  if (currentUser) {
    form.elements.name.value = currentUser.name;
    form.elements.email.value = currentUser.email;
  }
  setupForm(form, contactRules, async values => {
    await api('/contact', { method: 'POST', body: values });
    form.elements.message.value = '';
    showToast('Сообщение отправлено. Спасибо!');
  });
}

function initAuthForms() {
  if (currentUser) {
    location.replace('cabinet.html');
    return;
  }
  const toCabinet = () => { location.href = 'cabinet.html'; };
  setupForm(byId('login-form'), loginRules, async values => {
    await api('/auth/login', { method: 'POST', body: values });
    toCabinet();
  });
  setupForm(byId('register-form'), registerRules, async values => {
    await api('/auth/register', { method: 'POST', body: values });
    toCabinet();
  });
}

// ===== Кабинет =====

const currentPasswordRule = value => value ? '' : 'Введите текущий пароль.';
const newPasswordRule = value => value.length < 8 ? 'Пароль — не короче 8 символов.' : '';

function fillAccount() {
  byId('avatar').textContent = currentUser.name.charAt(0).toUpperCase();
  byId('user-name').textContent = currentUser.name;
  byId('user-email').textContent = currentUser.email;
  const since = new Date(currentUser.created_at.replace(' ', 'T') + 'Z')
    .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  byId('user-since').textContent = 'На сайте с ' + since;
}

async function initCabinet() {
  if (!currentUser) {
    byId('cabinet-guest').hidden = false;
    return;
  }
  byId('cabinet').hidden = false;
  fillAccount();

  const errorNode = byId('cabinet-error');
  byId('logout-button').addEventListener('click', async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
      location.href = 'index.html';
    } catch (error) {
      setStatus(errorNode, error.message, true);
    }
  });

  const profileForm = byId('profile-form');
  profileForm.elements.name.value = currentUser.name;
  setupForm(profileForm, { name: nameRule }, async values => {
    currentUser = await api('/me', { method: 'PUT', body: values });
    fillAccount();
    showToast('Профиль обновлён');
  });

  const passwordForm = byId('password-form');
  setupForm(passwordForm, { current_password: currentPasswordRule, new_password: newPasswordRule }, async values => {
    await api('/me/password', { method: 'POST', body: values });
    passwordForm.reset();
    showToast('Пароль изменён');
  });

  try {
    const stats = await api('/stats');
    const cards = [
      [stats.total, 'альбомов в списке'],
      [stats.listened, 'прослушано'],
      [stats.average_rating === null ? '—' : formatRating(stats.average_rating), 'средняя оценка'],
      [stats.favorite_genre || '—', 'любимый жанр']
    ];
    byId('stat-cards').replaceChildren(...cards.map(([value, name]) =>
      el('li', {},
        el('p', { class: typeof value === 'string' && value.length > 3 ? 'stat-value stat-text' : 'stat-value', text: String(value) }),
        el('p', { class: 'stat-name', text: name }))));
  } catch (error) {
    setStatus(errorNode, error.message, true);
  }
}

// ===== Главная =====

// «Случайный альбом»: показывает выбор прямо на странице, переход на страницу альбома по желанию
function initSurprise() {
  const button = byId('surprise-button');
  const cover = byId('surprise-cover');
  const text = byId('surprise-text');
  const open = byId('surprise-open');
  let lastId = 0;
  button.addEventListener('click', () => {
    const pool = ALBUMS.filter(album => album.id !== lastId);
    if (!pool.length) return;
    const album = pool[Math.floor(Math.random() * pool.length)];
    lastId = album.id;
    cover.src = album.cover;
    cover.alt = `Обложка альбома «${album.title}», ${album.artist}`;
    text.textContent = `«${album.title}», ${albumDetails(album)}`;
    open.href = 'album.html?id=' + album.id;
    open.hidden = false;
    button.textContent = 'Выбрать другой';
    button.classList.add('button-secondary');
  });
}

// Блок внизу главной: содержание зависит от того, вошёл ли пользователь и что у него в списке
function renderCta() {
  const entries = [...library.values()].filter(entry => entry.status && findAlbum(entry.album_id));
  const listening = entries.filter(entry => entry.status === 'listening');
  const waiting = entries.filter(entry => entry.status === 'want');
  const best = [...ALBUMS].sort((a, b) => b.rating - a.rating || a.id - b.id);
  const titleOf = entry => '«' + findAlbum(entry.album_id).title + '»';
  let view;

  if (!currentUser) {
    view = {
      title: 'Создайте свою медиатеку',
      text: 'Регистрация бесплатна: список «Хочу послушать», оценки, заметки и рецензии будут всегда под рукой.',
      link: ['Создать аккаунт', 'login.html#register'], albums: best
    };
  } else if (listening.length) {
    view = {
      title: 'Продолжайте слушать',
      text: 'Сейчас в процессе: ' + listening.slice(0, 2).map(titleOf).join(', ') + (listening.length > 2 ? ' и другие.' : '.'),
      link: ['Открыть мой список', 'listen-later.html'], albums: listening.map(entry => findAlbum(entry.album_id))
    };
  } else if (waiting.length) {
    view = {
      title: 'Что послушать дальше',
      text: `Ждут своей очереди: ${pluralAlbums(waiting.length)}.`,
      link: ['Открыть мой список', 'listen-later.html'], albums: waiting.map(entry => findAlbum(entry.album_id))
    };
  } else {
    view = {
      title: 'Начните свой список',
      text: 'Выберите альбом в каталоге и добавьте его в список: здесь появится то, что вы слушаете.',
      link: ['Открыть каталог', 'catalog.html'], albums: best
    };
  }

  byId('cta-title').textContent = view.title;
  byId('cta-text').textContent = view.text;
  const link = byId('cta-link');
  link.textContent = view.link[0];
  link.setAttribute('href', view.link[1]);
  byId('cta-covers').replaceChildren(...view.albums.slice(0, 4).map(album =>
    el('li', {}, el('a', { href: 'album.html?id=' + album.id, 'aria-label': album.title },
      el('img', { src: album.cover, alt: '', width: 96, height: 96, loading: 'lazy' })))));
}

function initHome() {
  const picks = weeklyPicks(6);
  renderCards(byId('featured'), picks);
  byId('hero-covers').replaceChildren(...picks.slice(0, 3).map(album =>
    el('img', { src: album.cover, alt: '', width: 210, height: 210 })));
  renderCards(byId('fresh'), [...ALBUMS].sort((a, b) => b.year - a.year || b.id - a.id).slice(0, 6));
  initSurprise();

  const artists = new Set(ALBUMS.map(album => album.artist)).size;
  const genres = new Set(ALBUMS.map(album => album.genre)).size;
  byId('hero-stats').replaceChildren(
    ...[[ALBUMS.length, ['альбом', 'альбома', 'альбомов']], [artists, ['исполнитель', 'исполнителя', 'исполнителей']], [genres, ['жанр', 'жанра', 'жанров']]]
      .map(([count, forms]) => el('li', {}, el('strong', { text: String(count) }), ' ' + pluralize(count, forms))));

  renderCta();

  // Жанры берутся с сервера: на главной нужны только самые частые. Фон плитки — обложка лучшего альбома жанра
  api('/genres?limit=6').then(data => {
    byId('genre-tiles').replaceChildren(...data.items.map(item => {
      const top = ALBUMS.filter(album => album.genre === item.genre).sort((a, b) => b.rating - a.rating)[0];
      const tile = el('a', { class: 'tile', href: 'catalog.html?genre=' + encodeURIComponent(item.genre) },
        el('strong', { text: item.genre }), el('span', { text: pluralAlbums(item.count) }));
      if (top) tile.style.setProperty('--cover', `url("${encodeURI(top.cover)}")`);
      return el('li', {}, tile);
    }));
    byId('genres-section').hidden = false;
  }).catch(() => {
    // без жанров главная остаётся рабочей: блок просто не показывается
  });
}

// ===== Каталог: поиск, фильтры, сортировка =====

function initCatalog() {
  const form = byId('filters');
  const searchInput = form.elements.search;
  const sortMenu = byId('sort-menu');
  const grid = byId('grid');
  const info = byId('results-info');
  const emptyMessage = byId('empty-message');
  const resetButton = byId('reset-button');

  const state = { query: '', genre: 'all', decade: 'all', sort: 'default' };

  // Ссылки с главной открывают каталог сразу с фильтром: catalog.html?genre=...&decade=...&q=...
  const params = new URLSearchParams(location.search);
  state.genre = params.get('genre') || 'all';
  state.decade = params.get('decade') || 'all';
  state.query = params.get('q') || '';
  searchInput.value = state.query;

  const sorters = {
    default: () => 0,
    title: (a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }),
    'year-asc': (a, b) => a.year - b.year || a.title.localeCompare(b.title),
    'year-desc': (a, b) => b.year - a.year || a.title.localeCompare(b.title),
    rating: (a, b) => b.rating - a.rating || a.title.localeCompare(b.title)
  };

  // Десятилетий немного, поэтому кнопки строятся сразу из каталога
  function makeChips(container, key, options) {
    const buttons = options.map(({ value, label }) => {
      const button = el('button', { type: 'button', class: 'chip', text: label, 'aria-pressed': 'false' });
      button.dataset.value = String(value);
      button.addEventListener('click', () => {
        state[key] = String(value);
        render();
      });
      return button;
    });
    container.replaceChildren(...buttons);
    return () => buttons.forEach(button => button.setAttribute('aria-pressed', button.dataset.value === state[key]));
  }

  // Жанры строятся из каталога. В ряду видны самые частые, остальные ищутся и выбираются
  // в панели, которая открывается кнопкой «Все жанры»
  function setupGenreFilter() {
    const chipBox = byId('genre-chips');
    const picker = byId('genre-picker');
    const searchBox = byId('genre-search');
    const list = byId('genre-list');
    const TOP = 5;
    const more = el('button', { type: 'button', class: 'chip chip-more', text: 'Все жанры', 'aria-expanded': 'false', 'aria-controls': 'genre-picker' });

    function genreCounts() {
      const counts = new Map();
      for (const album of ALBUMS) counts.set(album.genre, (counts.get(album.genre) || 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'));
    }

    function choose(value) {
      state.genre = value;
      close();
      render();
    }

    function open() {
      picker.hidden = false;
      more.setAttribute('aria-expanded', 'true');
      searchBox.focus();
    }

    function close() {
      picker.hidden = true;
      more.setAttribute('aria-expanded', 'false');
      searchBox.value = '';
    }

    // Ряд кнопок: «Все», самые частые жанры и выбранный жанр, если он не входит в самые частые
    function renderChips(genres) {
      const top = genres.slice(0, TOP).map(([genre]) => genre);
      const values = ['all', ...top];
      if (state.genre !== 'all' && !top.includes(state.genre)) values.push(state.genre);
      const chips = values.map(value => {
        const chip = el('button', { type: 'button', class: 'chip', text: value === 'all' ? 'Все' : value, 'aria-pressed': String(state.genre === value) });
        chip.addEventListener('click', () => choose(value));
        return chip;
      });
      chipBox.replaceChildren(...chips, more);
    }

    // Панель: все жанры с числом альбомов, поиск работает по мере ввода
    function renderList(genres) {
      const query = normalize(searchBox.value);
      const found = genres.filter(([genre]) => normalize(genre).includes(query));
      list.replaceChildren(...(found.length
        ? found.map(([genre, count]) => {
          const button = el('button', { type: 'button', class: 'genre-option', 'aria-current': String(state.genre === genre) },
            el('span', { text: genre }), el('span', { class: 'genre-count', text: String(count) }));
          button.addEventListener('click', () => choose(genre));
          return el('li', {}, button);
        })
        : [el('li', { class: 'status', text: 'Такого жанра нет' })]));
    }

    function sync() {
      const genres = genreCounts();
      renderChips(genres);
      renderList(genres);
    }

    more.addEventListener('click', () => (picker.hidden ? open() : close()));
    searchBox.addEventListener('input', () => renderList(genreCounts()));
    searchBox.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const first = list.querySelector('.genre-option');
      if (first) first.click();
    });
    picker.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        close();
        more.focus();
      }
    });
    // панель закрывается по клику вне её
    document.addEventListener('click', event => {
      if (!picker.hidden && !picker.contains(event.target) && !more.contains(event.target)) close();
    });

    return { sync, close };
  }

  const decades = [...new Set(ALBUMS.map(decadeOf))].sort();
  const syncDecades = makeChips(byId('decade-chips'), 'decade',
    [{ value: 'all', label: 'Любое' }, ...decades.map(decade => ({ value: decade, label: decade + '-е' }))]);
  const genreFilter = setupGenreFilter();

  function render() {
    const query = normalize(state.query);
    const found = ALBUMS
      .filter(album => normalize(album.title + ' ' + album.artist).includes(query))
      .filter(album => state.genre === 'all' || album.genre === state.genre)
      .filter(album => state.decade === 'all' || decadeOf(album) === Number(state.decade))
      .sort(sorters[state.sort]);

    genreFilter.sync();
    syncDecades();
    renderCards(grid, found);
    info.textContent = 'Найдено: ' + pluralAlbums(found.length);
    byId('sort-current').textContent = sortNames[state.sort];
    sortButtons.forEach(button => button.setAttribute('aria-current', button.dataset.value === state.sort));
    emptyMessage.hidden = found.length !== 0;
    resetButton.hidden = !(state.query || state.genre !== 'all' || state.decade !== 'all' || state.sort !== 'default');
  }

  const sortNames = {
    default: 'По умолчанию', title: 'По названию', 'year-asc': 'Сначала старые',
    'year-desc': 'Сначала новые', rating: 'Сначала с высокой оценкой'
  };
  const sortButtons = Object.entries(sortNames).map(([value, text]) => {
    const button = el('button', { type: 'button', class: 'menu-item', text });
    button.dataset.value = value;
    button.addEventListener('click', () => {
      state.sort = value;
      sortMenu.open = false;
      render();
    });
    return button;
  });
  byId('sort-options').replaceChildren(...sortButtons.map(button => el('li', {}, button)));
  // меню закрывается по клику вне его и по Escape
  document.addEventListener('click', event => {
    if (!sortMenu.contains(event.target)) sortMenu.open = false;
  });
  sortMenu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      sortMenu.open = false;
      sortMenu.querySelector('summary').focus();
    }
  });

  function resetAll() {
    Object.assign(state, { query: '', genre: 'all', decade: 'all', sort: 'default' });
    genreFilter.close();
    searchInput.value = '';
    render();
    searchInput.focus();
  }

  // Поиск работает при вводе, кнопка «Найти» и Enter дают тот же результат
  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    render();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    state.query = searchInput.value;
    render();
  });
  resetButton.addEventListener('click', resetAll);
  byId('empty-reset').addEventListener('click', resetAll);

  render();
}

// ===== Страница альбома =====

function similarAlbums(album, limit = 4) {
  return ALBUMS
    .filter(other => other.id !== album.id)
    .map(other => ({
      other,
      score: (other.genre === album.genre ? 2 : 0) + (decadeOf(other) === decadeOf(album) ? 1 : 0)
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || Math.abs(a.other.year - album.year) - Math.abs(b.other.year - album.year))
    .slice(0, limit)
    .map(item => item.other);
}

// --- внешний источник данных: iTunes Search API (Apple, ключ не нужен), запросы через наш сервер ---

// Запросы идут через наш сервер (он обращается к iTunes и кэширует ответы)
const ITUNES_URL = '/api/itunes';

// Ошибка загрузки с причиной: 'network' (нет связи), 'limit' (источник ограничил запросы), 'not-found' (альбома нет в источнике)
class SourceError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

async function fetchJson(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new SourceError('network', 'Запрос не дошёл до источника: ' + error.message);
  }
  if (response.status === 403 || response.status === 429) throw new SourceError('limit', 'HTTP ' + response.status);
  if (!response.ok) throw new SourceError('network', 'HTTP ' + response.status);
  return response.json();
}

// Название для сравнения: без регистра, диакритики, скобок, знаков препинания и «ё»
const comparable = text => text.toLowerCase().replace(/ё/g, 'е').normalize('NFD').replace(/\p{M}/gu, '')
  .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
  .replace(/[^\p{L}\p{N}\s]/gu, '')
  .replace(/\s+/g, ' ').trim();

// Apple часто отдаёт переиздания (deluxe, remastered): берём издание того же исполнителя,
// название которого совпадает с нашим, а из нескольких — самое короткое и раннее.
// Если такого альбома в выдаче нет, лучше показать «не найден», чем чужой альбом того же исполнителя
function pickAlbum(results, album) {
  const title = comparable(album.mb_title || album.title);
  const artist = comparable(album.artist);
  const nameOf = item => comparable(item.collectionName || '');
  const matching = results.filter(item => {
    const name = comparable(item.artistName || '');
    return name && (name.includes(artist) || artist.includes(name)) && nameOf(item).startsWith(title);
  });
  const exact = item => nameOf(item) === title ? 0 : 1;
  // сингл или EP из пары треков не подходит, если есть полноценные издания
  const full = matching.filter(item => item.trackCount > 3);
  return (full.length ? full : matching).sort((a, b) =>
    exact(a) - exact(b)
    || (a.collectionName || '').length - (b.collectionName || '').length
    || (a.releaseDate || '').localeCompare(b.releaseDate || ''))[0];
}

const parseTime = text => text.split(':').reduce((total, part) => total * 60 + Number(part), 0) * 1000;

// Возвращает { discs, source }: диски с треками и название источника для подписи под списком
async function fetchTracklist(album) {
  // Если в базе у альбома есть свой треклист (в iTunes его нет), внешний источник не нужен
  if (album.tracks && album.tracks.length) {
    return { discs: [album.tracks.map(([title, time]) => ({ title, length: parseTime(time) }))], source: 'добавлено вручную' };
  }

  const cacheKey = 'loop-tracks-v4-' + album.id;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey));
    if (cached) return { discs: cached, source: 'Apple iTunes' };
  } catch (error) {
    // нет кэша — загружаем заново
  }

  // country=us: каталог американского магазина, чтобы результат не зависел от страны пользователя.
  // Сначала ищем по исполнителю и названию, если не нашлось — только по названию
  const title = album.mb_title || album.title;
  const store = 'country=us&media=music';
  const seen = [];
  let release;
  for (const query of [`${album.artist} ${title}`, title]) {
    const found = await fetchJson(`${ITUNES_URL}/search?term=${encodeURIComponent(query)}&${store}&entity=album&limit=25`);
    const results = found.results || [];
    seen.push(...results.map(item => `${item.artistName} — ${item.collectionName}`));
    release = pickAlbum(results, album);
    if (release) break;
  }
  if (!release) throw new SourceError('not-found', 'Альбом не найден. Источник вернул: ' + (seen.slice(0, 6).join('; ') || 'ничего'));

  const details = await fetchJson(`${ITUNES_URL}/lookup?id=${release.collectionId}&country=us&entity=song`);
  const tracks = (details.results || []).filter(item => item.wrapperType === 'track' && item.kind === 'song')
    .sort((a, b) => (a.discNumber || 1) - (b.discNumber || 1) || a.trackNumber - b.trackNumber);
  if (!tracks.length) throw new SourceError('not-found', `У найденного альбома нет треков: ${release.artistName} — ${release.collectionName} (${release.collectionId})`);

  const discs = [];
  for (const track of tracks) {
    const index = (track.discNumber || 1) - 1;
    (discs[index] = discs[index] || []).push({ title: track.trackName, length: track.trackTimeMillis });
  }
  const result = discs.filter(Boolean);

  try {
    localStorage.setItem(cacheKey, JSON.stringify(result));
  } catch (error) {
    // хранилище недоступно — работаем без кэша
  }
  return { discs: result, source: 'Apple iTunes' };
}

function renderTracklist(container, discs, source) {
  const nodes = discs.map((tracks, index) => {
    const list = el('ol', { class: 'tracks' }, ...tracks.map(track =>
      el('li', {}, el('div', { class: 'track' },
        el('span', { text: track.title }),
        el('span', { class: 'track-time', text: track.length ? formatTime(track.length) : '' })
      ))
    ));
    return discs.length > 1 ? el('div', {}, el('h3', { text: 'Диск ' + (index + 1) }), list) : list;
  });
  container.replaceChildren(...nodes, el('p', { class: 'source', text: 'Данные: ' + source }));
}

function totalMinutes(discs) {
  const ms = discs.flat().reduce((sum, track) => sum + (track.length || 0), 0);
  return Math.round(ms / 60000);
}

async function loadTracklist(album, container, lengthCell) {
  container.replaceChildren(el('p', { class: 'status loading', text: 'Загружаем треклист…' }));
  try {
    const { discs, source } = await fetchTracklist(album);
    renderTracklist(container, discs, source);
    const minutes = totalMinutes(discs);
    if (minutes) lengthCell.textContent = 'Около ' + minutes + ' мин.';
  } catch (error) {
    console.warn('Треклист «' + album.title + '» не загружен:', error.message);
    const messages = {
      'not-found': 'Для этого альбома треклист в источнике данных не нашёлся.',
      limit: 'Источник данных временно ограничил число запросов. Подождите минуту и повторите.',
      network: 'Не удалось загрузить треклист. Проверьте подключение к интернету и попробуйте ещё раз.'
    };
    const nodes = [el('p', { class: 'status', text: messages[error.kind] || messages.network })];
    if (error.kind !== 'not-found') {
      const retry = el('button', { type: 'button', text: 'Повторить' });
      retry.addEventListener('click', () => loadTracklist(album, container, lengthCell));
      nodes.push(retry);
    }
    container.replaceChildren(...nodes);
  }
}

// --- мой список, оценка, любимое и заметка (хранятся на сервере) ---
// Оценка, статус, заметка и «любимое» независимы: альбом можно оценить, не добавляя в список

function initMyPanel(album, onChange) {
  if (!currentUser) {
    byId('my-login').hidden = false;
    return;
  }
  byId('my-controls').hidden = false;
  byId('my-rating-block').hidden = false;
  byId('note-section').hidden = false;

  const errorNode = byId('my-status');
  const ratingError = byId('rating-status');
  const menu = byId('list-menu');
  const summary = byId('list-summary');
  const stars = Array.from(document.querySelectorAll('#stars-input .star'));
  const hint = byId('my-rating-hint');
  const favorite = byId('fav-button');

  async function run(errorTarget, action) {
    try {
      await action();
      setStatus(errorTarget, '');
      onChange();
    } catch (error) {
      setStatus(errorTarget, error.message, true);
    }
    refresh();
  }

  const options = [...Object.entries(STATUSES), [null, 'Убрать из списка']].map(([status, text]) => {
    const button = el('button', { type: 'button', class: status ? 'menu-item' : 'menu-item menu-remove', text });
    button.addEventListener('click', async () => {
      menu.open = false;
      const previous = library.get(album.id)?.status ?? null;
      await run(errorNode, () => saveEntry(album.id, { status }));
      if (status === null && previous && !errorNode.textContent) {
        showToast('Альбом убран из списка', {
          label: 'Отменить',
          run: () => run(errorNode, () => saveEntry(album.id, { status: previous }))
        });
      }
    });
    return { status, item: el('li', {}, button), button };
  });
  byId('list-options').replaceChildren(...options.map(option => option.item));

  // меню закрывается по клику вне его и по Escape
  document.addEventListener('click', event => {
    if (!menu.contains(event.target)) menu.open = false;
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      menu.open = false;
      summary.focus();
    }
  });

  function refresh() {
    const entry = library.get(album.id);
    const status = entry && entry.status;
    summary.textContent = status ? '✓ ' + STATUSES[status] : '+ Добавить в список';
    menu.classList.toggle('in-list', Boolean(status));
    options.forEach(({ status: value, item, button }) => {
      if (value === null) item.hidden = !status;
      else button.setAttribute('aria-current', value === status);
    });

    const isFavorite = Boolean(entry && entry.favorite);
    favorite.setAttribute('aria-pressed', isFavorite);
    favorite.firstElementChild.textContent = isFavorite ? '♥' : '♡';

    const rating = entry && entry.rating ? entry.rating : 0;
    stars.forEach(star => {
      star.classList.toggle('on', Number(star.dataset.value) <= rating);
      star.setAttribute('aria-pressed', Number(star.dataset.value) === rating);
    });
    hint.textContent = rating ? rating + ' из 5' : 'Нажмите на звезду';
  }

  favorite.addEventListener('click', () =>
    run(errorNode, () => saveEntry(album.id, { favorite: !(library.get(album.id)?.favorite) })));

  stars.forEach(star => star.addEventListener('click', () => {
    const value = Number(star.dataset.value);
    const current = library.get(album.id);
    const rating = current && current.rating === value ? null : value; // повторный клик снимает оценку
    run(ratingError, () => saveEntry(album.id, { rating }));
  }));

  const entry = library.get(album.id);
  setupNote({
    field: byId('note'),
    status: byId('note-status'),
    clearButton: byId('note-clear'),
    albumId: album.id,
    note: entry ? entry.note : ''
  });
  refresh();
}

// --- оценки и рецензии: сводка, ваша оценка и рецензии в одном блоке ---

function initReviews(album) {
  const list = byId('review-list');
  const form = byId('review-form');
  const text = byId('review-text');
  const openButton = byId('review-open');
  const path = `/albums/${album.id}/review`;
  const summary = { rating: album.rating, votes: album.votes, reviews: album.review_count, distribution: null };
  const starsText = rating => '★'.repeat(rating) + '☆'.repeat(5 - rating);
  let myReview = null;

  // Строка под оценкой в шапке и сводка в блоке «Оценки и рецензии» всегда показывают одни и те же данные
  function renderSummary() {
    const rounded = Math.round(summary.rating);
    for (const id of ['album-stars', 'summary-stars']) {
      byId(id).textContent = starsText(rounded);
      byId(id).setAttribute('aria-label', `${rounded} из 5`);
    }
    byId('album-rating').textContent = formatRating(summary.rating);
    byId('summary-rating').textContent = formatRating(summary.rating);

    const source = summary.votes
      ? `Средняя по ${summary.votes} ${pluralize(summary.votes, ['оценке', 'оценкам', 'оценкам'])} слушателей`
      : 'Стартовая оценка, оценок слушателей пока нет';
    byId('rating-source').textContent =
      `${source} · ${summary.reviews} ${pluralize(summary.reviews, ['рецензия', 'рецензии', 'рецензий'])}`;
    byId('summary-caption').textContent = source;

    const distribution = summary.distribution || { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const max = Math.max(1, ...Object.values(distribution));
    byId('rating-bars').replaceChildren(...[5, 4, 3, 2, 1].map(stars => {
      const fill = el('span', { class: 'bar-fill' });
      fill.style.width = (distribution[stars] / max * 100) + '%';
      return el('li', {}, el('span', { text: stars + ' ★' }), el('span', { class: 'bar' }, fill),
        el('span', { text: String(distribution[stars]) }));
    }));
  }

  async function loadSummary() {
    try {
      const data = await api(`/albums/${album.id}/ratings`);
      Object.assign(summary, { rating: data.rating, votes: data.votes, distribution: data.distribution });
    } catch (error) {
      // остаются данные из каталога, страница работает
    }
    renderSummary();
  }

  // Форма видна, только пока пишешь или правишь рецензию; иначе есть кнопка «Написать рецензию»
  function showForm(show) {
    form.hidden = !show;
    openButton.hidden = show || !currentUser || Boolean(myReview);
    if (show) text.focus();
  }

  async function removeReview(review) {
    try {
      await api(path, { method: 'DELETE' });
      await loadReviews();
      showToast('Рецензия удалена', {
        label: 'Отменить',
        run: async () => {
          await api(path, { method: 'PUT', body: { text: review.text } });
          await loadReviews();
        }
      });
    } catch (error) {
      showToast(error.message);
    }
  }

  function createReview(review) {
    const date = new Date(review.updated_at.replace(' ', 'T') + 'Z')
      .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    const meta = el('p', { class: 'review-meta' }, el('strong', { text: review.author }));
    if (review.rating) {
      const stars = el('span', { class: 'stars', role: 'img', 'aria-label': `оценка ${review.rating} из 5`, text: starsText(review.rating) });
      meta.append(' · ', stars);
    }
    meta.append(' · ' + date + (review.mine ? ' · ваша рецензия' : ''));
    const item = el('li', { class: review.mine ? 'review mine' : 'review' }, meta, el('p', { text: review.text }));

    if (review.mine) {
      const edit = el('button', { type: 'button', class: 'link-button', text: 'Изменить' });
      const remove = el('button', { type: 'button', class: 'link-button', text: 'Удалить' });
      edit.addEventListener('click', () => {
        text.value = review.text;
        showForm(true);
      });
      remove.addEventListener('click', () => removeReview(review));
      item.append(el('div', { class: 'review-actions' }, edit, remove));
    }
    return item;
  }

  async function loadReviews() {
    let reviews;
    try {
      reviews = await api(`/albums/${album.id}/reviews`);
    } catch (error) {
      list.replaceChildren(el('li', { class: 'status', text: 'Не удалось загрузить рецензии.' }));
      return;
    }
    myReview = reviews.find(review => review.mine) || null;
    summary.reviews = reviews.length;
    renderSummary();

    list.replaceChildren(...(reviews.length
      ? reviews.map(createReview)
      : [el('li', { class: 'status', text: 'Рецензий пока нет. Станьте первым.' })]));
    byId('review-save').textContent = myReview ? 'Сохранить' : 'Опубликовать';
    if (form.hidden) showForm(false);
  }

  if (currentUser) {
    openButton.addEventListener('click', () => {
      text.value = '';
      showForm(true);
    });
    byId('review-cancel').addEventListener('click', () => {
      text.value = '';
      showFieldError(text, '');
      showForm(false);
    });
    setupForm(form, { text: value => value.trim().length < 10 ? 'Рецензия — не короче 10 символов.' : '' }, async values => {
      const wasEdit = Boolean(myReview);
      await api(path, { method: 'PUT', body: { text: values.text } });
      showForm(false);
      await loadReviews();
      showToast(wasEdit ? 'Рецензия обновлена' : 'Рецензия опубликована');
    });
  } else {
    byId('review-login').hidden = false;
  }

  renderSummary();
  loadSummary();
  loadReviews();
  return { refreshSummary: loadSummary };
}

function initAlbum() {
  byId('back-link').addEventListener('click', event => {
    const cameFromSite = document.referrer && new URL(document.referrer).origin === location.origin;
    if (cameFromSite && history.length > 1) {
      event.preventDefault();
      history.back();
    }
  });

  const id = Number(new URLSearchParams(location.search).get('id'));
  const album = findAlbum(id);

  if (!album) {
    byId('not-found').hidden = false;
    byId('album-title').textContent = 'Альбом не найден';
    document.title = 'Альбом не найден — LOOP';
    return;
  }

  document.title = `${album.title} — LOOP`;
  byId('album-title').textContent = album.title;
  const cover = byId('album-cover');
  cover.src = album.cover;
  cover.alt = `Обложка альбома «${album.title}», ${album.artist}`;
  byId('album-artist').textContent = album.artist;
  byId('album-meta').textContent = `${album.year}, ${album.style}` + (album.label ? `, лейбл ${album.label}` : '');

  byId('album-description').textContent = album.description;

  const facts = [
    ['Исполнитель', album.artist],
    ['Год выпуска', album.year],
    ['Жанр', capitalize(album.style)],
    ['Тип', 'Студийный альбом']
  ];
  if (album.label) facts.push(['Лейбл', album.label]);
  const lengthCell = el('dd', { text: 'Определяется по треклисту' });
  byId('album-facts').append(
    ...facts.flatMap(([term, value]) => [el('dt', { text: term }), el('dd', { text: String(value) })]),
    el('dt', { text: 'Длительность' }), lengthCell);

  const similar = similarAlbums(album);
  if (similar.length) {
    renderCards(byId('similar-grid'), similar);
    byId('similar').hidden = false;
  }

  const reviews = initReviews(album);
  initMyPanel(album, reviews.refreshSummary);
  byId('album').hidden = false;
  loadTracklist(album, byId('tracklist'), lengthCell);
}

// ===== Мой список =====

function initMyList() {
  if (!currentUser) {
    byId('list-login').hidden = false;
    return;
  }
  byId('list-area').hidden = false;

  const rows = byId('rows');
  const template = byId('row-template');
  const emptyMessage = byId('empty-list');
  const noMatches = byId('no-matches');
  const errorNode = byId('list-error');
  const searchInput = byId('list-search');
  const state = { filter: 'all', sort: 'recent', query: '' };

  const filterNames = { all: 'Все', ...STATUSES, favorite: 'Любимое' };
  const sortNames = { recent: 'Недавние', rating: 'По оценке', year: 'По году', title: 'А–Я' };
  // Альбомы приходят с сервера от новых к старым, поэтому «недавние» не меняют порядок
  const sorters = {
    recent: () => 0,
    rating: (a, b) => (b.entry.rating || 0) - (a.entry.rating || 0),
    year: (a, b) => b.album.year - a.album.year,
    title: (a, b) => a.album.title.localeCompare(b.album.title)
  };
  const belongs = (entry, key) => key === 'all' || (key === 'favorite' ? Boolean(entry.favorite) : entry.status === key);

  function makeButtons(container, names, key, className) {
    const buttons = Object.entries(names).map(([value, label]) => {
      const button = el('button', { type: 'button', class: className, 'aria-pressed': 'false', text: label });
      button.dataset.value = value;
      button.addEventListener('click', () => {
        state[key] = value;
        render();
      });
      return button;
    });
    container.replaceChildren(...buttons);
    return buttons;
  }
  const filterButtons = makeButtons(byId('list-tabs'), filterNames, 'filter', 'list-tab');
  const sortButtons = makeButtons(byId('list-sort'), sortNames, 'sort', 'segment');

  // В списке видны альбомы со статусом и отмеченные «любимыми»
  const inList = entry => (entry.status || entry.favorite) && findAlbum(entry.album_id);

  async function update(albumId, changes) {
    setStatus(errorNode, '');
    try {
      await saveEntry(albumId, changes);
    } catch (error) {
      setStatus(errorNode, error.message, true);
    }
    render();
  }

  function render() {
    const items = [...library.values()].filter(inList).map(entry => ({ entry, album: findAlbum(entry.album_id) }));

    filterButtons.forEach(button => {
      const key = button.dataset.value;
      const count = items.filter(item => belongs(item.entry, key)).length;
      button.replaceChildren(filterNames[key], el('span', { class: 'list-count', text: String(count) }));
      button.setAttribute('aria-pressed', key === state.filter);
    });
    sortButtons.forEach(button => button.setAttribute('aria-pressed', button.dataset.value === state.sort));

    const query = normalize(state.query);
    const shown = items
      .filter(item => belongs(item.entry, state.filter))
      .filter(({ entry, album }) => normalize(`${album.title} ${album.artist} ${entry.note}`).includes(query))
      .sort(sorters[state.sort]);

    emptyMessage.hidden = items.length !== 0;
    noMatches.hidden = items.length === 0 || shown.length !== 0;
    rows.replaceChildren(...shown.map(createRow));
  }

  function createRow({ entry, album }) {
    const row = template.content.firstElementChild.cloneNode(true);

    const image = row.querySelector('img');
    image.src = album.cover;
    image.alt = `Обложка альбома «${album.title}»`;
    const link = row.querySelector('a');
    link.textContent = album.title;
    link.href = 'album.html?id=' + album.id;
    row.querySelector('.row-details').textContent = albumDetails(album);

    const stars = [1, 2, 3, 4, 5].map(value => {
      const star = el('button', {
        type: 'button', class: value <= (entry.rating || 0) ? 'star on' : 'star',
        'aria-label': `${value} из 5`, 'aria-pressed': String(value === entry.rating), text: value <= (entry.rating || 0) ? '★' : '☆'
      });
      star.addEventListener('click', () => update(album.id, { rating: entry.rating === value ? null : value }));
      return star;
    });
    row.querySelector('.row-stars').replaceChildren(el('span', { class: 'row-rating-label', text: 'Оценка' }), ...stars);

    const menu = row.querySelector('.status-menu');
    const current = entry.status || '';
    row.querySelector('.status-current').textContent = current ? STATUSES[current] : 'Без статуса';
    row.querySelector('.menu-list').replaceChildren(...[['', 'Без статуса'], ...Object.entries(STATUSES)].map(([value, text]) => {
      const button = el('button', { type: 'button', class: 'menu-item', text, 'aria-current': String(value === current) });
      button.addEventListener('click', () => {
        menu.open = false;
        if (value !== current) update(album.id, { status: value || null });
      });
      return el('li', {}, button);
    }));
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        menu.open = false;
        menu.querySelector('summary').focus();
      }
    });

    const favorite = row.querySelector('.fav-button');
    favorite.setAttribute('aria-pressed', Boolean(entry.favorite));
    favorite.firstElementChild.textContent = entry.favorite ? '♥' : '♡';
    favorite.addEventListener('click', () => update(album.id, { favorite: !entry.favorite }));

    row.querySelector('.row-remove').addEventListener('click', async () => {
      const previous = { status: entry.status, favorite: Boolean(entry.favorite) };
      await update(album.id, { status: null, favorite: false });
      if (!errorNode.textContent) {
        showToast('Альбом убран из списка', { label: 'Отменить', run: () => update(album.id, previous) });
      }
    });

    setupNote({
      field: row.querySelector('.row-note'),
      status: row.querySelector('.autosave'),
      clearButton: row.querySelector('.note-clear'),
      albumId: album.id,
      note: entry.note
    });
    return row;
  }

  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    render();
  });
  // открытое меню статуса закрывается по клику вне его
  document.addEventListener('click', event => {
    for (const menu of rows.querySelectorAll('.status-menu[open]')) {
      if (!menu.contains(event.target)) menu.open = false;
    }
  });
  render();
}

// ===== Управление каталогом (администратор) =====

const adminRules = {
  title: value => value.trim() ? '' : 'Введите название.',
  artist: value => value.trim() ? '' : 'Введите исполнителя.',
  year: value => /^\d{4}$/.test(value.trim()) && Number(value) >= 1900 && Number(value) <= 2100 ? '' : 'Укажите год от 1900 до 2100.',
  rating: value => {
    const number = Number(value.replace(',', '.'));
    return value.trim() && number >= 1 && number <= 5 ? '' : 'Оценка — число от 1 до 5.';
  },
  genre: value => value.trim() ? '' : 'Укажите жанр.',
  style: value => value.trim() ? '' : 'Укажите точный жанр или стиль.',
  description: value => value.trim().length < 10 ? 'Описание — не короче 10 символов.' : ''
};

function initAdmin() {
  if (!currentUser || !currentUser.is_admin) {
    byId('admin-denied').hidden = false;
    return;
  }
  byId('admin-area').hidden = false;

  const form = byId('admin-form');
  const list = byId('admin-list');
  const errorNode = byId('admin-error');
  const formTitle = byId('add-title');
  const submitButton = form.querySelector('button[type="submit"]');
  const cancelButton = byId('admin-cancel');
  let editingId = null;

  function renderGenreOptions() {
    byId('genre-options').replaceChildren(...[...new Set(ALBUMS.map(album => album.genre))]
      .map(genre => el('option', { value: genre })));
  }

  function resetForm() {
    editingId = null;
    form.reset();
    form.querySelectorAll('.field-error').forEach(node => { node.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach(input => input.removeAttribute('aria-invalid'));
    formTitle.textContent = 'Добавить альбом';
    submitButton.textContent = 'Добавить альбом';
    cancelButton.hidden = true;
  }

  function startEditing(album) {
    resetForm();
    editingId = album.id;
    const values = {
      title: album.title, artist: album.artist, year: album.year, rating: album.base_rating,
      genre: album.genre, style: album.style, label: album.label || '', mb_title: album.mb_title || '',
      cover: album.cover === DEFAULT_COVER ? '' : album.cover, description: album.description
    };
    for (const [name, value] of Object.entries(values)) form.elements[name].value = value;
    formTitle.textContent = 'Изменить альбом';
    submitButton.textContent = 'Сохранить изменения';
    cancelButton.hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    form.elements.title.focus({ preventScroll: true });
  }

  function createRow(album) {
    const edit = el('button', { type: 'button', class: 'button-secondary', text: 'Изменить' });
    edit.addEventListener('click', () => startEditing(album));

    // Удаление в два нажатия, чтобы не удалить альбом случайно
    const remove = el('button', { type: 'button', class: 'button-secondary', text: 'Удалить' });
    let armedTimer = 0;
    remove.addEventListener('click', async () => {
      if (!armedTimer) {
        remove.textContent = 'Точно удалить?';
        armedTimer = setTimeout(() => {
          armedTimer = 0;
          remove.textContent = 'Удалить';
        }, 4000);
        return;
      }
      clearTimeout(armedTimer);
      try {
        await api('/albums/' + album.id, { method: 'DELETE' });
        ALBUMS = ALBUMS.filter(other => other.id !== album.id);
        if (editingId === album.id) resetForm();
        setStatus(errorNode, '');
        renderList();
        showToast(`Альбом «${album.title}» удалён`);
      } catch (error) {
        setStatus(errorNode, error.message, true);
        armedTimer = 0;
        remove.textContent = 'Удалить';
      }
    });
    return el('li', { class: 'admin-row' },
      el('div', {}, el('strong', { text: album.title }), el('span', { class: 'admin-sub', text: `${album.artist}, ${album.year}` })),
      el('div', { class: 'admin-actions' }, edit, remove));
  }

  function renderList() {
    list.replaceChildren(...ALBUMS.map(createRow));
    renderGenreOptions();
  }

  setupForm(form, adminRules, async values => {
    const body = {
      title: values.title,
      artist: values.artist,
      year: Number(values.year),
      genre: values.genre,
      style: values.style,
      rating: Number(values.rating.replace(',', '.')),
      label: values.label || null,
      mb_title: values.mb_title || null,
      cover: values.cover || null,
      description: values.description
    };
    if (editingId) {
      const album = await api('/albums/' + editingId, { method: 'PUT', body });
      ALBUMS = ALBUMS.map(other => other.id === album.id ? album : other);
      resetForm();
      showToast('Изменения сохранены');
    } else {
      ALBUMS.push(await api('/albums', { method: 'POST', body }));
      form.reset();
      showToast('Альбом добавлен');
    }
    renderList();
  });
  cancelButton.addEventListener('click', resetForm);

  // --- сообщения из формы контактов ---
  const messageList = byId('message-list');
  const messagesError = byId('messages-error');

  function renderMessages(messages) {
    byId('messages-count').textContent = messages.length ? String(messages.length) : '';
    byId('empty-messages').hidden = messages.length !== 0;
    messageList.replaceChildren(...messages.map(message => {
      const date = new Date(message.created_at.replace(' ', 'T') + 'Z')
        .toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
      const remove = el('button', { type: 'button', class: 'link-button', text: 'Удалить' });
      remove.addEventListener('click', async () => {
        try {
          await api('/messages/' + message.id, { method: 'DELETE' });
          showToast('Сообщение удалено');
          loadMessages();
        } catch (error) {
          setStatus(messagesError, error.message, true);
        }
      });
      return el('li', { class: 'message' },
        el('p', { class: 'message-meta' }, el('strong', { text: message.name }), ' · ',
          el('a', { href: 'mailto:' + message.email, text: message.email }), ' · ' + date),
        el('p', { text: message.text }),
        el('div', { class: 'message-actions' }, remove));
    }));
  }

  async function loadMessages() {
    try {
      renderMessages(await api('/messages'));
      setStatus(messagesError, '');
    } catch (error) {
      setStatus(messagesError, error.message, true);
    }
  }

  renderList();
  loadMessages();
}

// ===== Запуск: смотрим, какая это страница =====

async function start() {
  initTheme();
  await loadSession();
  updateAuthLink();
  initTabs();
  initToast();
  initPasswordToggles();

  if (byId('contact-form')) initContactForm();
  if (byId('login-form')) initAuthForms();

  const needsAlbums = ['featured', 'filters', 'album', 'rows', 'cabinet', 'admin-area'].some(id => byId(id));
  if (!needsAlbums) return;

  try {
    ALBUMS = await api('/albums');
  } catch (error) {
    showBanner(error.message);
    return;
  }

  if (byId('featured')) initHome();
  if (byId('filters')) initCatalog();
  if (byId('album')) initAlbum();
  if (byId('rows')) initMyList();
  if (byId('cabinet')) initCabinet();
  if (byId('admin-area')) initAdmin();
}

start();