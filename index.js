const http = require('http');
const SteamUser = require('steam-user');

const GAMES = [730]; // AppID игр (730 = CS2)
const PING_INTERVAL_MS = 60 * 1000; // Раз в минуту проверяем состояние
const RECONNECT_DELAY_MS = 10 * 1000; // Задержка перед повторным входом

const client = new SteamUser({
  autoRelogin: true,
  enablePicsCache: false
});

let isLoggedIn = false;
let isPlayingBlocked = false;
let reconnectTimer = null;
let lastStartTime = Date.now();

// HTTP-сервер для Render и пингера (UptimeRobot / cron-job.org)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    status: 'ok',
    loggedIn: isLoggedIn,
    playingBlocked: isPlayingBlocked,
    games: GAMES,
    uptimeSec: Math.floor((Date.now() - lastStartTime) / 1000)
  }));
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`HTTP-сервер запущен на порту ${process.env.PORT || 3000}`);
});

function startGames() {
  if (!isLoggedIn) return;
  if (isPlayingBlocked) {
    console.log('Запуск игры отложен: активна сессия на другом устройстве.');
    return;
  }
  client.setPersona(SteamUser.EPersonaState.Online);
  client.gamesPlayed(GAMES);
  console.log('Статус Online выставлен, игры запущены:', GAMES);
}

function scheduleReconnect(reason = 'unknown') {
  if (reconnectTimer) return;
  console.log(`Планирую переподключение через ${RECONNECT_DELAY_MS / 1000} сек (причина: ${reason})...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    loginToSteam();
  }, RECONNECT_DELAY_MS);
}

function loginToSteam() {
  const refreshToken = process.env.STEAM_REFRESH_TOKEN;
  if (!refreshToken) {
    console.error('Критическая ошибка: не задан STEAM_REFRESH_TOKEN в Environment Variables!');
    return;
  }

  try {
    console.log('Выполняю вход в Steam по STEAM_REFRESH_TOKEN...');
    client.logOn({
      refreshToken: refreshToken.trim(),
      machineName: 'render-boost'
    });
  } catch (err) {
    console.error('Ошибка при вызове logOn:', err.message);
    scheduleReconnect('logOn-exception');
  }
}

client.on('loggedOn', () => {
  isLoggedIn = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  console.log('Успешный вход в Steam!');
  startGames();
});

client.on('playingState', (blocked) => {
  isPlayingBlocked = Boolean(blocked);
  if (isPlayingBlocked) {
    console.log('Обнаружена игра на другом устройстве — буст временно на паузе.');
  } else {
    console.log('Другая игровая сессия завершена — возобновляю буст.');
    startGames();
  }
});

client.on('disconnected', (eresult, msg) => {
  isLoggedIn = false;
  console.warn(`Отключено от Steam (код: ${eresult}${msg ? `, ${msg}` : ''}).`);
  scheduleReconnect('disconnected');
});

client.on('error', (err) => {
  isLoggedIn = false;
  console.error('Ошибка клиента Steam:', err.message);

  // Если токен протух или отозван — перезапуск по кругу не поможет, нужен новый токен
  if (
    err.eresult === SteamUser.EResult.InvalidPassword ||
    err.eresult === SteamUser.EResult.Expired ||
    err.eresult === SteamUser.EResult.AccessDenied ||
    err.eresult === SteamUser.EResult.Revoked
  ) {
    console.error('Похоже, STEAM_REFRESH_TOKEN недействителен или протух. Обнови его в Environment Variables.');
    return;
  }

  scheduleReconnect('steam-error');
});

// Периодическая проверка: если залогинен, но статус слетел — возвращаем обратно
setInterval(() => {
  if (isLoggedIn && !isPlayingBlocked) {
    client.setPersona(SteamUser.EPersonaState.Online);
    client.gamesPlayed(GAMES);
  }
}, PING_INTERVAL_MS);

// Защита от падения всего процесса из-за необработанных ошибок
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  scheduleReconnect('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  scheduleReconnect('unhandledRejection');
});

// Корректное завершение при рестарте контейнера со стороны Render
function shutdown(signal) {
  console.log(`Получен сигнал ${signal}, аккуратно завершаю работу...`);
  try {
    client.gamesPlayed([]);
    client.logOff();
  } catch (_) {}
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

loginToSteam();
