const http = require('http');
const SteamUser = require('steam-user');
const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
const qrcode = require('qrcode-terminal');

const GAMES = [730]; // AppID игр (730 = CS2, можно указать до 32 штук через запятую)
const client = new SteamUser();

// Мини-сервер для Render, чтобы сервис не падал по таймауту порта
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Running');
}).listen(process.env.PORT || 3000);

async function start() {
  // Если уже есть сохраненный refreshToken в переменной окружения — входим сразу
  if (process.env.STEAM_REFRESH_TOKEN) {
    client.logOn({ refreshToken: process.env.STEAM_REFRESH_TOKEN });
    return;
  }

  // Иначе генерируем QR-код в логи хостинга для первого входа
  const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
  const startResult = await session.startWithQR();

  console.log('Отсканируй этот QR-код в приложении Steam:');
  qrcode.generate(startResult.qrChallengeUrl, { small: true });

  session.on('authenticated', () => {
    console.log('\nУспешно! Сохрани этот токен в переменную STEAM_REFRESH_TOKEN на хостинге:');
    console.log(session.refreshToken);
    client.logOn({ refreshToken: session.refreshToken });
  });

  session.on('timeout', () => {
    console.log('Время QR-кода истекло, перезапуск...');
    process.exit(1);
  });
}

client.on('loggedOn', () => {
  console.log('Вход выполнен, запускаю буст часов...');
  client.setPersona(SteamUser.EPersonaState.Invisible); // Невидимка, чтобы не спамить друзьям
  client.gamesPlayed(GAMES);
});

client.on('playingState', (blocked) => {
  if (blocked) {
    console.log('Запущена игра на другом устройстве — буст на паузе.');
  } else {
    client.gamesPlayed(GAMES);
  }
});

client.on('error', (err) => {
  console.error('Ошибка Steam:', err.message);
});

start();