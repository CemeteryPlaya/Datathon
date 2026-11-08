// Переключатель темы в шапке: «как в системе» → «светлая» → «тёмная».
// Выбор хранится в localStorage (cqa-theme) и ставится атрибутом <html data-theme>; стили — app.css / theme-freedom.css.
const KEY = 'cqa-theme';
const MODES = ['system', 'light', 'dark'];
const LABEL = { system: 'Тема: как в системе', light: 'Тема: светлая', dark: 'Тема: тёмная' };
const ICON = {
  light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><g stroke-linecap="round"><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></g></svg>',
  dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1z"/></svg>',
  system: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path class="cqa-fill" d="M12 3.5a8.5 8.5 0 0 1 0 17z"/></svg>',
};

const read = () => {
  try { return MODES.includes(localStorage.getItem(KEY)) ? localStorage.getItem(KEY) : 'system'; } catch { return 'system'; }
};

export function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  try { mode === 'system' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, mode); } catch {}
  const btn = document.getElementById('cqa-theme-btn');
  if (btn) {
    btn.innerHTML = ICON[mode];
    btn.title = `${LABEL[mode]} (нажмите, чтобы сменить)`;
    btn.setAttribute('aria-label', LABEL[mode]);
    btn.dataset.mode = mode;
  }
}

export function mountThemeToggle() {
  const header = document.querySelector('.cqa-header');
  if (!header || document.getElementById('cqa-theme-btn')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'cqa-theme-btn';
  btn.className = 'cqa-theme-btn';
  btn.addEventListener('click', () => applyTheme(MODES[(MODES.indexOf(read()) + 1) % MODES.length]));
  header.appendChild(btn);
  applyTheme(read());
}

mountThemeToggle();
