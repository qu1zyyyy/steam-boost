const http = require('http');
const SteamUser = require('steam-user');
const { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType } = require('steam-session');

const GAMES = [730]; // AppID игр (730 = CS2)
const client = new SteamUser();

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Running');
}).listen(process.env.PORT || 3000);

async function start() {
  // 1. Если токен уже сохранен — входим сразу без кода
  if (process.env.STEAM_REFRESH_TOKEN) {
    client.logOn({ refreshToken: process.env.STEAM_REFRESH_TOKEN });
    return;
  }

  // 2. Иначе входим по логину и паролю из Environment Variables
  const accountName = process.env.STEAM_USER;
  const password = process.env.STEAM_PASSWORD;

  if (!accountName || !password) {
    console.log('Укажи STEAM_USER и STEAM_PASSWORD в Environment Variables на Render!');
    return;
  }

  const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
  const startResult = await session.startWithCredentials({
    accountName,
    password
  });

  if (startResult.actionRequired) {
    const codeAction = startResult.validActions.find(
      a => a.type === EAuthSessionGuardType.DeviceCode || a.type === EAuthSessionGuardType.EmailCode
    );
    const pushAction = startResult.validActions.find(
      a => a.type === EAuthSessionGuardType.DeviceConfirmation
    );

    if (process.env.STEAM_GUARD_CODE && codeAction) {
      console.log('Отправляю код Steam Guard...');
      await session.submitSteamGuardCode(process.env.STEAM_GUARD_CODE.trim());
    } else if (pushAction) {
      console.log('Подтверди вход в мобильном приложении Steam (пуш-уведомление) или добавь переменную STEAM_GUARD_CODE!');
    } else {
      console.log('Требуется код! Добавь переменную STEAM_GUARD_CODE со свежим 5-значным кодом из приложения Steam и нажми Manual Deploy.');
    }
  }

  session.on('authenticated', () => {
    console.log('\nУспешный вход! Скопируй этот токен в переменную STEAM_REFRESH_TOKEN:');
    console.log(session.refreshToken);
    client.logOn({ refreshToken: session.refreshToken });
  });

  session.on('timeout', () => {
    console.log('Время ожидания подтверждения истекло.');
  });

  session.on('error', (err) => {
    console.error('Ошибка авторизации:', err.message);
  });
}

client.on('loggedOn', () => {
  console.log('Вход выполнен, запускаю буст часов...');
  client.setPersona(SteamUser.EPersonaState.Invisible);
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
