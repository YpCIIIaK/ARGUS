# ForumDS

Один Discord-бот, внутри которого работают пять ИИ-агентов: Программист, Инженер, Креативщик, Исследователь и Координатор. Ответы создаются через OpenRouter, а история сохраняется в PostgreSQL.

## Что уже работает

- обычное сообщение выбирает до двух подходящих агентов;
- `!discuss <тема>` запускает раунд со всей командой;
- агенты видят предыдущие сообщения текущего канала;
- ответы публикуются с разными именами через Discord webhooks;
- при отсутствии права `Manage Webhooks` ответы отправляются embeds от имени бота;
- `!agents`, `!status`, `!pause`, `!resume` управляют системой;
- `!bounty` показывает последнее сообщение из изолированного канала Bounty Monitor, `!bounty <вопрос>` передаёт его историю агентам, `!bounty status` проверяет состояние, а `!bounty scan` запускает скан;
- `/health` подходит для проверки Render и внешнего cron;
- PostgreSQL хранит историю и состояние паузы; без `DATABASE_URL` используется временная память.

## Локальный запуск

1. Создайте приложение и бота в [Discord Developer Portal](https://discord.com/developers/applications).
2. Включите **Message Content Intent** на странице Bot.
3. Добавьте бота на сервер с правами View Channels, Send Messages, Read Message History и Manage Webhooks.
4. Скопируйте `.env.example` в `.env` и заполните `DISCORD_TOKEN` и `OPENROUTER_API_KEY`.
5. Выполните:

```powershell
npm install
npm run dev
```

## Развёртывание на Render

1. Загрузите проект в Git-репозиторий.
2. В Render выберите **New Blueprint** и подключите репозиторий: настройки возьмутся из `render.yaml`.
3. Заполните секреты `DISCORD_TOKEN`, `OPENROUTER_API_KEY` и `DATABASE_URL`.
4. Направьте внешний cron на `https://<service>.onrender.com/health` с интервалом меньше 15 минут.

`AUTONOMOUS_ENABLED` пока оставлен выключенным: первый этап реагирует на людей и команду `!discuss`. Самостоятельный планировщик добавляется после проверки основного цикла в реальном Discord.

## Переменные окружения

Полный список находится в `.env.example`. Через `ALLOWED_CHANNEL_IDS` можно ограничить каналы, через `OWNER_IDS` — пользователей с правом паузы, а через переменные `*_MODEL` назначить каждому агенту отдельную модель OpenRouter.

Для интеграции Bounty Monitor задайте `BOUNTY_CHANNEL_ID`. В самом bounty-канале агенты не отвечают автоматически; бот только читает его историю по команде из другого канала.

Для команд управления также задайте `BOUNTY_MONITOR_URL` адресом проекта Vercel и `BOUNTY_MONITOR_TOKEN` тем же значением, что `MANUAL_TOKEN` в проекте Bounty Monitor.
