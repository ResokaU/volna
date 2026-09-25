# Политика конфиденциальности VOLNA

_Последнее обновление: 25.09.2026_

VOLNA — десктоп-плеер SoundCloud с открытым исходным кодом ([github.com/ResokaU/volna](https://github.com/ResokaU/volna)). Мы не собираем, не храним и не передаём ваши персональные данные на наши серверы — у нас их просто нет.

## Какие данные обрабатывает приложение

**1. Локальные данные (хранятся только на вашем компьютере)**
- лайки, плейлисты, история прослушивания, статистика — в файле данных приложения (`%APPDATA%/VOLNA`);
- настройки, включая масштаб интерфейса, акцент, обои;
- если вы входите в аккаунт SoundCloud — ваш oauth-токен хранится локально и используется только для запросов к SoundCloud от вашего имени. Он не отправляется разработчику и третьим лицам, кроме SoundCloud.

**2. Сторонние сервисы, к которым обращается приложение**

| Сервис | Что передаётся | Зачем |
|---|---|---|
| SoundCloud (api-v2, widget) | поисковые запросы, id треков, ваш oauth-токен / cookies сессии (если вошли) | поиск и воспроизведение музыки, синхронизация лайков |
| LRCLIB (lrclib.net) | имя исполнителя и название трека | поиск текстов песен |
| Discord | название трека, исполнитель, таймкоды, ссылка на трек, URL обложки | Rich Presence — статус «слушает…» |

Эти сервисы обрабатывают данные по собственным политикам конфиденциальности (SoundCloud, LRCLIB, Discord). VOLNA не контролирует их обработку.

**3. Discord Rich Presence**
- при включённой интеграции приложение отправляет название и исполнителя играющего трека, таймкоды и ссылку на трек в ваш локально запущенный клиент Discord, который уже сам отображает это в вашем профиле;
- URL обложки трека передаётся в API Discord (`discord.com/api/.../external-assets`) для преобразования в изображение статуса;
- интеграцию можно выключить галочкой в настройках VOLNA;
- VOLNA не читает никакие данные из Discord.

## Чего мы НЕ делаем
- не собираем аналитику, телеметрию, crash-репорты;
- не используем cookies для трекинга;
- не продаём и не передаём данные третьим лицам;
- не имеем доступа к вашему аккаунту SoundCloud, кроме запросов, которые выполняет само приложение от вашего имени.

## Данные детей
VOLNA не предназначена для детей младше 13 лет и сознательно не собирает данные детей.

## Удаление данных
Удалите файл данных приложения (`%APPDATA%/VOLNA/grindoapp-data.json`) или воспользуйтесь «Настройки → Стереть все данные» в приложении. Данные существуют только на вашем устройстве.

## Контакты
Вопросы по конфиденциальности: [Issues в репозитории](https://github.com/ResokaU/volna/issues) или [@ResokaU](https://github.com/ResokaU).

---

### English summary

VOLNA is an open-source SoundCloud desktop player. It collects **no data**: everything (favorites, playlists, history, settings, your SoundCloud OAuth token if you sign in) stays on your machine. Third-party services contacted by the app: SoundCloud (search/playback/likes), LRCLIB (lyrics), Discord (Rich Presence: track title, artist, timestamps, cover URL — can be disabled in settings). No telemetry, no analytics, no tracking. To delete all data, use the in-app wipe or delete `%APPDATA%/VOLNA`. Contact: [GitHub Issues](https://github.com/ResokaU/volna/issues).
