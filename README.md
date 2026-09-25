# 🎵 GrindoApp v2.0

Electron-based SoundCloud desktop player с красивым UI, Dota 2 интеграцией и кучей фич.

## Запуск

```bash
cd C:\Users\meerp\Documents\grindoapp
npm install
npm start
```

## Как работает поиск (важно)

Старый `api.soundcloud.com` с фиксированным client_id больше не работает (403).
GrindoApp теперь ходит через **api-v2.soundcloud.com** — то же публичное API, что использует сам сайт:

- `client_id` динамически извлекается из JS-бандлов soundcloud.com и кэшируется;
- при ротации ключа приложение само обновит его при следующем поиске;
- запросы идут через IPC-прокси в main-процессе (`net.fetch`), т.к. api-v2 не отдаёт CORS-заголовки для чужих origin;
- воспроизведение — через SoundCloud Widget (iframe), client_id не нужен.

## Фичи

### 🎧 Музыка
- Поиск по SoundCloud API (только SC, без iTunes)
- Воспроизведение через SoundCloud Widget (надёжно работает)
- Чипы жанров: lofi, phonk, techno, synthwave, dnb, jazz, ambient, cyberpunk, dota 2
- Фильтры: все / только треки / артисты / короткие < 3мин / длинные > 5мин
- Load More — бесконечная подгрузка
- Trending — популярные треки без запроса

### 🎮 Dota 2
- Баннер "Hero of the Day" с HD-артом со Steam CDN
- Цитаты героев
- Сетка из 20 героев
- Клик по баннеру → поиск музыки по герою

### ❤️ Библиотека
- Лайки с сортировкой (по дате / имени)
- Плейлисты (создание, удаление, добавление треков)
- История прослушивания (последние 100)
- Очередь воспроизведения (drag-and-drop порядок)

### 🎛️ Плеер
- Shuffle / Repeat / Radio mode
- Громкость + Mute
- Seek по клику на прогресс-бар
- Sleep Timer (5/15/30/45/60/90/120 мин)
- Mini Player режим
- Круговой визуализатор вокруг обложки
- System tray (иконка в трее с меню)

### 📊 Статистика
- Треков прослушано
- Общее время
- Лайки / плейлисты / история / очередь
- Длительность сессии

### ⚙️ Настройки
- Тема: dark
- Accent color: orange / pink / purple / cyan / green / red
- Громкость по умолчанию
- Уведомления на лайк
- Сохранение окна (позиция/размер)
- Запуск свёрнутым
- Экспорт/Импорт лайков (через системные диалоги)
- Полный backup (все данные в JSON)
- Очистка кэша

### ⌨️ Горячие клавиши
- `Space` — play/pause
- `←` / `→` — prev/next
- `Shift + ←` / `→` — seek ±5s
- `↑` / `↓` — volume
- `F` — фокус на поиск
- `L` — лайк текущего
- `M` — mini player
- `1-9` — переключение view
- `Esc` — закрыть модалку/меню
- `Ctrl+Q` — выход
- `F1` — список шорткатов
- `F12` — DevTools

### 🖱️ Мышь
- Кастомный курсор (ring + dot с mix-blend-mode)
- Hover-эффект увеличения
- Radial glow на карточках при наведении
- Parallax aurora-блобов от мыши

### 🔧 Системное
- Single instance (нельзя запустить дважды)
- Media keys с клавиатуры
- System tray с Play/Pause/Next/Prev/Show/Quit
- Запоминание позиции и размера окна
- Native уведомления
- Power save blocker (не давать экрану гаснуть)
- Автооткрытие внешних ссылок в браузере

## Структура

```
grindoapp/
├── main.js              # Electron main process
├── renderer/
│   ├── index.html       # HTML
│   ├── styles.css       # CSS
│   ├── app.js           # state + utils + cursor + init
│   ├── search.js        # search view + trending
│   ├── player.js        # player + queue + sleep + radio
│   ├── library.js       # favorites/playlists/history/stats/settings
│   ├── lyrics.js        # караоке-текст (LRCLIB) + маскот
│   └── mascot/          # гифки маскота
├── legacy/              # старые index.html и renderer.js до ре-структуры (не используются)
└── README.md
```

## Client ID

SoundCloud: извлекается автоматически из сайта (см. «Как работает поиск»)
Dota: OpenDota API (без ключа)
Steam CDN: публичные арты
