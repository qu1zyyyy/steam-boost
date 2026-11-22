const http = require('http');
const SteamUser = require('steam-user');

const PORT = Number(process.env.PORT) || 3000;
const GAMES = [730];
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const RECONNECT_DELAY_MS = 15 * 1000;
const RATE_LIMIT_DELAY_MS = 5 * 60 * 1000;

const WARN_AUTH_RESULTS = new Set([
  SteamUser.EResult.InvalidPassword,
  SteamUser.EResult.Expired,
  SteamUser.EResult.AccessDenied,
  SteamUser.EResult.Revoked
]);

const client = new SteamUser({
  autoRelogin: false,
  enablePicsCache: false
});

let currentRefreshToken = (process.env.STEAM_REFRESH_TOKEN || '').trim();
let isLoggedIn = false;
let isLoggingIn = false;
let isPlayingBlocked = false;
let isBoosting = false;
let isShuttingDown = false;
let reconnectTimer = null;
const lastStartTime = Date.now();

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  res.end(JSON.stringify({
    status: 'ok',
    loggedIn: isLoggedIn,
    boosting: isBoosting,
    playingBlocked: isPlayingBlocked,
    games: GAMES,
    uptimeSec: Math.floor((Date.now() - lastStartTime) / 1000)
  }));
});

server.on('error', (err) => {
  console.error('Ошибка HTTP-сервера:', err.message);
});

server.listen(PORT, () => {
  console.log(`HTTP-сервер запущен на порту ${PORT}`);
});

function startGames(force = false) {
  if (!isLoggedIn || isShuttingDown) return;
  if (isPlayingBlocked) {
    console.log('Запуск игры отложен: активна сессия на другом устройстве.');
    return;
  }

  if (!force && isBoosting) return;

  client.setPersona(SteamUser.EPersonaState.Online);
  client.gamesPlayed(GAMES);
  isBoosting = true;
  console.log('Статус Online выставлен, игры запущены:', GAMES);
}

function scheduleReconnect(reason = 'unknown', delayMs = RECONNECT_DELAY_MS) {
  if (isShuttingDown || isLoggedIn || isLoggingIn || reconnectTimer) return;
  console.log(`Планирую переподключение через ${Math.round(delayMs / 1000)} сек (причина: ${reason})...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    loginToSteam();
  }, delayMs);
}

function loginToSteam() {
  if (isShuttingDown || isLoggedIn || isLoggingIn) return;

  if (!currentRefreshToken) {
    console.error('Критическая ошибка: не задан STEAM_REFRESH_TOKEN в Environment Variables!');
    return;
  }

  isLoggingIn = true;
  try {
    console.log('Выполняю вход в Steam по STEAM_REFRESH_TOKEN...');
    client.logOn({
      refreshToken: currentRefreshToken,
      machineName: 'render-boost'
    });
  } catch (err) {
    isLoggingIn = false;
    console.error('Ошибка при вызове logOn:', err.message);
    scheduleReconnect('logOn-exception');
  }
}

client.on('refreshToken', (token) => {
  if (token) {
    currentRefreshToken = token.trim();
  }
});

client.on('loggedOn', () => {
  isLoggedIn = true;
  isLoggingIn = false;
  isBoosting = false;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  console.log('Успешный вход в Steam!');
  startGames(true);
});

client.on('playingState', (blocked) => {
  const wasBlocked = isPlayingBlocked;
  isPlayingBlocked = Boolean(blocked);

  if (isPlayingBlocked) {
    isBoosting = false;
    console.log('Обнаружена игра на другом устройстве — буст временно на паузе.');
  } else if (wasBlocked || !isBoosting) {
    console.log('Другая игровая сессия завершена — возобновляю буст.');
    startGames(true);
  }
});

client.on('disconnected', (eresult, msg) => {
  isLoggedIn = false;
  isLoggingIn = false;
  isBoosting = false;
  isPlayingBlocked = false;
  console.warn(`Отключено от Steam (код: ${eresult}${msg ? `, ${msg}` : ''}).`);
  scheduleReconnect('disconnected');
});

client.on('error', (err) => {
  isLoggedIn = false;
  isLoggingIn = false;
  isBoosting = false;
  isPlayingBlocked = false;
  console.error('Ошибка клиента Steam:', err.message);

  if (WARN_AUTH_RESULTS.has(err.eresult)) {
    console.warn('Внимание: возможна проблема с STEAM_REFRESH_TOKEN (протух или отозван). Проверь переменную окружения, если вход не пройдет.');
  }

  if (
    err.eresult === SteamUser.EResult.RateLimitExceeded ||
    err.eresult === SteamUser.EResult.AccountLoginDeniedThrottle
  ) {
    scheduleReconnect('rate-limit', RATE_LIMIT_DELAY_MS);
    return;
  }

  scheduleReconnect('steam-error');
});

const healthInterval = setInterval(() => {
  if (isShuttingDown) return;

  if (!isLoggedIn) {
    scheduleReconnect('watchdog');
    return;
  }

  if (!isPlayingBlocked) {
    startGames(true);
  }
}, REFRESH_INTERVAL_MS);

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  if (!isLoggedIn) {
    isLoggingIn = false;
    scheduleReconnect('uncaughtException');
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  if (!isLoggedIn) {
    isLoggingIn = false;
    scheduleReconnect('unhandledRejection');
  }
});

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`Получен сигнал ${signal}, аккуратно завершаю работу...`);
  clearInterval(healthInterval);

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (isLoggedIn) {
      client.gamesPlayed([]);
    }
    if (isLoggedIn || isLoggingIn) {
      client.logOff();
    }
  } catch (_) {}

  server.close(() => {
    process.exit(0);
  });

  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }

  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

loginToSteam();
