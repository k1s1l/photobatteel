import type { DomainErrorCode } from '../../lib/errors.js';

/**
 * Russian locale — the reference dictionary. Every other locale must satisfy
 * `Locale` (= typeof ru), so missing keys are caught at compile time.
 * Strings are HTML (parse_mode: 'HTML'); dynamic values are escaped by callers.
 */
export const ru = {
  languageName: 'Русский',

  menu: {
    submit: '📸 Отправить фотографию',
    myPhotos: '🏆 Мои фотографии',
    myStats: '📊 Моя статистика',
    rating: '🥇 Рейтинг',
    battle: '⚔️ Текущий батл',
    rules: 'ℹ️ Правила',
    help: '❓ Помощь',
    admin: '🛠 Админ-панель',
  },

  common: {
    cancel: '❌ Отмена',
    back: '⬅️ Назад',
    prev: '◀️',
    next: '▶️',
    yes: '✅ Да',
    no: '❌ Нет',
    cancelled: 'Действие отменено.',
    alreadyProcessed: 'Это действие уже выполнено.',
    tooFast: '⏳ Слишком много действий. Подожди немного и попробуй снова.',
    busy: '⏳ Обрабатываю предыдущий запрос…',
    unknownError: '⚠️ Произошла ошибка. Попробуй ещё раз чуть позже.',
    blocked: '🚫 Твой доступ к Photo Battle ограничен администратором.',
    useMenu: 'Выбери действие в меню ниже 👇',
    notFound: 'Ничего не найдено.',
  },

  start: {
    welcome:
      'Добро пожаловать в Photo Battle! 📸\n' +
      'Загружай свои фотографии, участвуй в фотобатлах и попадай в Telegram-канал!',
  },

  rules: {
    text: (p: { maxPerDay: number; maxSizeMb: number; minSide: number; moderation: boolean }) =>
      '<b>ℹ️ Правила Photo Battle</b>\n\n' +
      '1. Отправляй только свои фотографии, на публикацию которых у тебя есть права.\n' +
      '2. Запрещены: чужие работы, откровенный, жестокий и оскорбительный контент, реклама, ' +
      'личные данные других людей без их согласия.\n' +
      '3. Одна и та же фотография не может участвовать повторно.\n' +
      `4. Лимит: ${p.maxPerDay > 0 ? `до ${p.maxPerDay} фото в сутки` : 'без ограничения в сутки'}.\n` +
      `5. Форматы: JPG, PNG, WEBP; размер до ${p.maxSizeMb} МБ; минимальная сторона — ${p.minSide} px.\n` +
      `6. ${p.moderation ? 'Каждая фотография проходит модерацию перед публикацией.' : 'Фотографии публикуются в порядке очереди.'}\n` +
      '7. Опубликованная фотография появляется в публичном канале вместе с твоим @username ' +
      '(или именем, если username нет).\n' +
      '8. Ты можешь удалить любую свою фотографию в разделе «Мои фотографии» или все данные командой /deletedata.\n' +
      '9. За нарушение правил администратор может отклонить фото или заблокировать участника.',
  },

  help: {
    text:
      '<b>❓ Помощь</b>\n\n' +
      '<b>Как участвовать:</b>\n' +
      '1. Нажми «📸 Отправить фотографию».\n' +
      '2. Отправь одно фото (как фото или как файл-изображение).\n' +
      '3. Проверь предпросмотр и нажми «✅ Подтвердить».\n' +
      '4. Фото встанет в очередь и будет опубликовано в канале автоматически.\n\n' +
      '<b>Голосование:</b> под каждой публикацией в канале есть кнопка «🔥 Поддержать». ' +
      'Повторное нажатие отменяет голос. За свои фото голосовать нельзя.\n\n' +
      '<b>Команды:</b>\n' +
      '/start — главное меню\n' +
      '/myphotos — мои фотографии\n' +
      '/stats — моя статистика\n' +
      '/rules — правила\n' +
      '/cancel — отменить текущее действие\n' +
      '/deletedata — удалить все мои фотографии',
  },

  consent: {
    request:
      '<b>Согласие на публикацию</b>\n\n' +
      'Отправляя фотографию, ты подтверждаешь, что:\n' +
      '• являешься автором фото или имеешь право его публиковать;\n' +
      '• согласен(на) на публикацию фото в публичном Telegram-канале вместе с твоим @username или именем;\n' +
      '• ознакомлен(а) с правилами (/rules).\n\n' +
      'Ты в любой момент можешь удалить свои фотографии.',
    accept: '✅ Согласен(на)',
    accepted: '✅ Спасибо! Согласие сохранено.',
  },

  submission: {
    prompt: (p: { battle: string | null }) =>
      '📸 Отправь одну фотографию, которую хочешь опубликовать в Photo Battle.\n\n' +
      'Можно отправить как обычное фото или как файл (JPG, PNG, WEBP).' +
      (p.battle ? `\n\n⚔️ Фото будет участвовать в батле «${p.battle}».` : ''),
    processing: '⏳ Проверяю фотографию…',
    onlyOne: '⚠️ Пожалуйста, отправляй фотографии по одной. Я обработаю только первую из альбома.',
    notAnImage: '⚠️ Это не изображение. Отправь фотографию (JPG, PNG или WEBP).',
    previewCaption: (p: { id: string; battle: string | null; moderation: boolean }) =>
      `<b>Предпросмотр</b> — фото ${p.id}\n` +
      (p.battle ? `⚔️ Батл: ${p.battle}\n` : '') +
      '\nПроверь фотографию. Нажимая «✅ Подтвердить», ты соглашаешься на её публикацию в канале.' +
      (p.moderation ? '\nПеред публикацией фото проверит модератор.' : ''),
    confirm: '✅ Подтвердить',
    cancel: '❌ Отменить',
    accepted:
      '✅ Твоя фотография успешно принята!\n' +
      'Теперь она ожидает публикации в Photo Battle.',
    acceptedModeration:
      '✅ Твоя фотография успешно принята!\n' +
      'Она отправлена на модерацию и после проверки встанет в очередь публикации.',
    queuePosition: (position: number) => `📍 Позиция в очереди: ${position}.`,
    cancelledByUser: '❌ Отправка отменена. Фотография не будет опубликована.',
    previewConfirmed: (id: string) => `✅ Фото ${id} подтверждено.`,
    previewCancelled: (id: string) => `❌ Фото ${id} — отправка отменена.`,
    previewExpired: 'Этот предпросмотр больше не действителен (истёк срок или ты отправил другое фото). Отправь фотографию заново.',
  },

  errors: {
    NOT_FOUND: () => 'Не найдено.',
    FORBIDDEN: () => '⛔ Недостаточно прав для этого действия.',
    USER_BLOCKED: () => '🚫 Твой доступ к Photo Battle ограничен администратором.',
    CONSENT_REQUIRED: () => 'Сначала нужно дать согласие на публикацию.',
    INVALID_STATE: () => 'Это действие уже недоступно для этой фотографии.',
    DAILY_LIMIT: (p) => `⚠️ Достигнут лимит: не более ${p.limit} фото за 24 часа. Попробуй позже.`,
    QUEUE_LIMIT: (p) => `⚠️ У тебя уже ${p.limit} фото ожидают публикации. Дождись, пока они выйдут.`,
    BATTLE_LIMIT: (p) => `⚠️ В этом батле можно участвовать не более чем ${p.limit} фото.`,
    NO_ACTIVE_BATTLE: () => '⏳ Сейчас приём фотографий закрыт. Дождись начала следующего батла!',
    DUPLICATE_PHOTO: () => '⚠️ Эта фотография уже была отправлена в Photo Battle. Повторная отправка невозможна.',
    INVALID_IMAGE: () => '⚠️ Не удалось прочитать изображение: файл повреждён или это не фото. Попробуй другой файл.',
    FILE_TOO_LARGE: (p) => `⚠️ Файл слишком большой. Максимальный размер — ${p.maxMb} МБ.`,
    UNSUPPORTED_FORMAT: () => '⚠️ Формат не поддерживается. Допустимы JPG, PNG и WEBP.',
    DIMENSIONS: (p) => `⚠️ Неподходящее разрешение. Каждая сторона должна быть от ${p.min} до ${p.max} px.`,
    BATTLE_EXISTS: () => 'Уже есть активный батл. Заверши или отмени его, прежде чем создавать новый.',
    SELF_VOTE: () => 'Нельзя голосовать за свою фотографию 🙂',
    VOTING_DISABLED: () => 'Голосование сейчас отключено.',
  } satisfies Record<DomainErrorCode, (p: Record<string, string | number>) => string>,

  status: {
    DRAFT: '📝 Ожидает подтверждения',
    PENDING_MODERATION: '🛡 На модерации',
    QUEUED: '⏳ В очереди',
    PUBLISHED: '✅ Опубликована',
    REJECTED: '⛔ Отклонена',
    DELETED: '🗑 Удалена',
    CANCELLED: '❌ Отменена',
    FAILED: '⚠️ Ошибка публикации',
  },

  myPhotos: {
    title: (total: number) => `<b>🏆 Мои фотографии</b> (${total})\n\nНажми на фото, чтобы открыть его.`,
    empty: 'У тебя пока нет фотографий. Нажми «📸 Отправить фотографию», чтобы участвовать!',
    card: (p: { id: string; status: string; date: string; votes: number; battle: string | null; link: string | null; reason: string | null }) =>
      `<b>Фото ${p.id}</b>\n` +
      `Статус: ${p.status}\n` +
      `Отправлено: ${p.date}\n` +
      `🔥 Голосов: ${p.votes}` +
      (p.battle ? `\n⚔️ Батл: ${p.battle}` : '') +
      (p.reason ? `\nПричина: ${p.reason}` : '') +
      (p.link ? `\n\n<a href="${p.link}">Открыть публикацию</a>` : ''),
    delete: '🗑 Удалить фото',
    deleteConfirm: (id: string) =>
      `Удалить фото ${id}? Если оно опубликовано, публикация будет удалена из канала. Действие необратимо.`,
    deleted: (id: string) => `🗑 Фото ${id} удалено.`,
    deletedChannelFailed: (id: string) =>
      `🗑 Фото ${id} удалено из Photo Battle. Публикацию в канале не удалось удалить автоматически — администраторы уведомлены.`,
    deleteAllConfirm:
      '⚠️ Удалить <b>все</b> твои фотографии и публикации в канале? Действие необратимо.',
    deleteAllDone: (count: number) => `🗑 Удалено фотографий: ${count}. Твои данные удалены из Photo Battle.`,
  },

  stats: {
    text: (p: { since: string; submitted: number; published: number; queued: number; votes: number; rank: number | null }) =>
      '<b>📊 Моя статистика</b>\n\n' +
      `📅 Участник с: ${p.since}\n` +
      `📸 Отправлено фото: ${p.submitted}\n` +
      `✅ Опубликовано: ${p.published}\n` +
      `⏳ Ожидают публикации: ${p.queued}\n` +
      `🔥 Получено голосов: ${p.votes}\n` +
      `🥇 Место в рейтинге: ${p.rank ? p.rank : '—'}`,
  },

  rating: {
    title: '<b>🥇 Рейтинг участников</b> (по голосам)',
    empty: 'Рейтинг пока пуст — голосуй за участников в канале!',
    row: (p: { place: number; name: string; votes: number; published: number }) =>
      `${p.place <= 3 ? ['🥇', '🥈', '🥉'][p.place - 1] : `${p.place}.`} ${p.name} — 🔥 ${p.votes} (фото: ${p.published})`,
    battleTitle: (title: string) => `\n<b>⚔️ Лидеры батла «${title}»</b>`,
    battleRow: (p: { place: number; id: string; name: string; votes: number }) => `${p.place}. Фото ${p.id} — ${p.name} — 🔥 ${p.votes}`,
  },

  battle: {
    none: 'Сейчас нет активного батла. Следи за анонсами в канале!',
    info: (p: { title: string; theme: string | null; status: string; submissionsEnd: string; end: string; participants: number }) =>
      `<b>⚔️ ${p.title}</b>\n` +
      (p.theme ? `Тема: ${p.theme}\n` : '') +
      `Статус: ${p.status}\n` +
      `Приём фото до: ${p.submissionsEnd}\n` +
      `Итоги: ${p.end}\n` +
      `Участников (фото): ${p.participants}`,
    statusActive: '📸 Идёт приём фотографий',
    statusVoting: '🔥 Идёт голосование',
    statusFinished: '🏁 Завершён',
    statusCancelled: '❌ Отменён',
    announceStart: (p: { title: string; theme: string | null; submissionsEnd: string; end: string; botUsername: string }) =>
      `🏆 <b>НОВЫЙ ФОТОБАТЛ: ${p.title}</b>\n\n` +
      (p.theme ? `Тема: <b>${p.theme}</b>\n` : '') +
      `📸 Приём фотографий до: ${p.submissionsEnd}\n` +
      `🏁 Подведение итогов: ${p.end}\n\n` +
      `Отправляй свои фото в бота @${p.botUsername} и поддерживай участников 🔥`,
    announceVoting: (p: { title: string; end: string }) =>
      `⏳ <b>Приём фотографий в батл «${p.title}» завершён!</b>\n\n` +
      `Голосование продолжается до ${p.end}. Поддерживай любимые фото кнопкой 🔥`,
    announceWinner: (p: { title: string; winner: string; id: string; votes: number }) =>
      `🏆 <b>Итоги батла «${p.title}»</b>\n\n` +
      `Победитель: <b>${p.winner}</b>\nФото ${p.id} — 🔥 ${p.votes}\n\nПоздравляем! 🎉`,
    announceNoWinner: (title: string) => `🏁 Батл «${title}» завершён. В этот раз победителя нет — не было опубликованных фото.`,
    winnerDm: (p: { title: string; id: string; votes: number }) =>
      `🏆 Поздравляем! Твоё фото ${p.id} победило в батле «${p.title}» с результатом 🔥 ${p.votes}!`,
    weeklyTitle: (n: number) => `Еженедельный фотобатл #${n}`,
  },

  vote: {
    button: (count: number) => (count > 0 ? `🔥 Поддержать · ${count}` : '🔥 Поддержать'),
    added: '🔥 Голос учтён! Спасибо за поддержку.',
    removed: 'Голос отменён.',
    unavailable: 'Голосование за эту фотографию недоступно.',
  },

  channel: {
    caption: (p: { participant: string; id: string; battle: string | null }) =>
      '📸 <b>PHOTO BATTLE</b>\n\n' +
      `Участник: ${p.participant}\n` +
      `ID фотографии: ${p.id}\n` +
      (p.battle ? `⚔️ Батл: ${p.battle}\n` : '') +
      '\n🔥 Поддержи участника!',
  },

  notifications: {
    published: (p: { id: string; link: string }) => `🎉 Твоё фото ${p.id} опубликовано в канале!\n<a href="${p.link}">Посмотреть публикацию</a>`,
    approved: (id: string) => `✅ Фото ${id} прошло модерацию и добавлено в очередь публикации.`,
    rejected: (p: { id: string; reason: string }) => `⛔ Фото ${p.id} отклонено модератором.\nПричина: ${p.reason}`,
    deletedByAdmin: (id: string) => `🗑 Фото ${id} удалено администратором.`,
    blocked: '🚫 Твой доступ к Photo Battle ограничен администратором.',
    unblocked: '🔓 Доступ к Photo Battle восстановлен. Добро пожаловать обратно!',
  },

  rejectReasons: {
    rules: 'Нарушение правил',
    quality: 'Низкое качество',
    theme: 'Не соответствует теме батла',
    duplicate: 'Повтор или чужая фотография',
    blocked: 'Пользователь заблокирован',
  },

  admin: {
    accessDenied: '⛔ У тебя нет доступа к админ-панели.',
    panelTitle: (p: { paused: boolean; interval: string; moderation: boolean; queued: number; pending: number }) =>
      '<b>🛠 Админ-панель Photo Battle</b>\n\n' +
      `Публикации: ${p.paused ? '⏸ остановлены' : '▶️ активны'}\n` +
      `Интервал: ${p.interval}\n` +
      `Модерация: ${p.moderation ? 'включена' : 'выключена'}\n` +
      `В очереди: ${p.queued} · На модерации: ${p.pending}`,
    buttons: {
      stats: '📊 Статистика бота',
      users: '👥 Пользователи',
      photos: '📸 Все фотографии',
      queue: '⏳ Очередь публикаций',
      moderation: '🛡 Модерация',
      publish: '🚀 Опубликовать вручную',
      delete: '🗑 Удалить фото',
      block: '🚫 Заблокировать',
      unblock: '🔓 Разблокировать',
      pause: '⏸ Остановить публикации',
      resume: '▶️ Возобновить публикации',
      settings: '⚙️ Настройки',
      broadcast: '📢 Объявление',
      battles: '⚔️ Батлы',
      panel: '🛠 В админ-панель',
    },
    stats: (p: {
      users: number;
      newUsers24h: number;
      blockedUsers: number;
      received: number;
      published: number;
      waiting: number;
      pending: number;
      rejected: number;
      failed: number;
      deleted: number;
      published24h: number;
      votes: number;
    }) =>
      '<b>📊 Статистика бота</b>\n\n' +
      `👥 Всего пользователей: ${p.users} (+${p.newUsers24h} за сутки)\n` +
      `🚫 Заблокировано: ${p.blockedUsers}\n\n` +
      `📸 Всего получено фотографий: ${p.received}\n` +
      `✅ Опубликовано: ${p.published}\n` +
      `⏳ Ожидают публикации: ${p.waiting}\n` +
      `🛡 На модерации: ${p.pending}\n` +
      `⛔ Отклонено: ${p.rejected}\n` +
      `⚠️ Ошибки публикации: ${p.failed}\n` +
      `🗑 Удалено: ${p.deleted}\n\n` +
      `🚀 Публикаций за сутки: ${p.published24h}\n` +
      `🔥 Всего голосов: ${p.votes}`,
    usersTitle: (total: number) => `<b>👥 Пользователи</b> (${total})`,
    userCard: (p: {
      name: string;
      telegramId: string;
      since: string;
      lastActive: string;
      submitted: number;
      published: number;
      votes: number;
      blocked: boolean;
      reason: string | null;
      admin: boolean;
    }) =>
      `<b>${p.name}</b>${p.admin ? ' (админ)' : ''}\n` +
      `Telegram ID: <code>${p.telegramId}</code>\n` +
      `Регистрация: ${p.since}\n` +
      `Активность: ${p.lastActive}\n` +
      `📸 Отправлено: ${p.submitted} · ✅ Опубликовано: ${p.published} · 🔥 Голосов: ${p.votes}\n` +
      `Статус: ${p.blocked ? `🚫 заблокирован${p.reason ? ` (${p.reason})` : ''}` : '✅ активен'}`,
    userPhotos: '📸 Фото пользователя',
    photosTitle: (p: { filter: string; total: number }) => `<b>📸 Фотографии</b> — ${p.filter} (${p.total})`,
    filterAll: 'Все',
    queueTitle: (p: { waiting: number; processing: number; failed: number; paused: boolean; interval: string }) =>
      '<b>⏳ Очередь публикаций</b>\n\n' +
      `Ожидают: ${p.waiting} · Публикуются: ${p.processing} · Ошибки: ${p.failed}\n` +
      `Публикации: ${p.paused ? '⏸ остановлены' : '▶️ активны'} · Интервал: ${p.interval}\n\n` +
      'Нажми на фото, чтобы управлять им.',
    queueEmpty: 'Очередь пуста.',
    moderationTitle: (total: number) => `<b>🛡 Модерация</b> — ожидают решения: ${total}`,
    moderationEmpty: 'Нет фотографий, ожидающих модерации.',
    photoCard: (p: {
      id: string;
      author: string;
      authorId: string;
      status: string;
      created: string;
      votes: number;
      size: string;
      battle: string | null;
      reason: string | null;
      error: string | null;
      link: string | null;
    }) =>
      `<b>Фото ${p.id}</b>\n` +
      `Автор: ${p.author} (<code>${p.authorId}</code>)\n` +
      `Статус: ${p.status}\n` +
      `Создано: ${p.created}\n` +
      `Размер: ${p.size} · 🔥 ${p.votes}` +
      (p.battle ? `\n⚔️ Батл: ${p.battle}` : '') +
      (p.reason ? `\nПричина отклонения: ${p.reason}` : '') +
      (p.error ? `\nПоследняя ошибка: ${p.error}` : '') +
      (p.link ? `\n<a href="${p.link}">Публикация в канале</a>` : ''),
    actions: {
      approve: '✅ Одобрить',
      reject: '⛔ Отклонить',
      publishNow: '🚀 Опубликовать сейчас',
      retry: '🔁 Повторить публикацию',
      delete: '🗑 Удалить',
      author: '👤 Автор',
      block: '🚫 Заблокировать',
      unblock: '🔓 Разблокировать',
    },
    chooseRejectReason: 'Выбери причину отклонения:',
    deleteConfirm: (id: string) => `Удалить фото ${id}? Публикация в канале (если есть) тоже будет удалена.`,
    approved: (id: string) => `✅ Фото ${id} одобрено и добавлено в очередь.`,
    rejected: (id: string) => `⛔ Фото ${id} отклонено.`,
    deleted: (id: string) => `🗑 Фото ${id} удалено.`,
    deletedChannelFailed: (id: string) =>
      `🗑 Фото ${id} удалено, но публикацию в канале удалить не удалось (нет прав или сообщение старше 48 ч). Удали её вручную.`,
    publishQueued: (id: string) => `🚀 Фото ${id} отправлено на публикацию. Результат придёт сообщением.`,
    requeued: (id: string) => `🔁 Фото ${id} возвращено в очередь.`,
    askPhotoIdPublish: 'Введи ID фотографии для немедленной публикации (например, #0012):',
    askPhotoIdDelete: 'Введи ID фотографии для удаления (например, #0012):',
    askUserBlock: 'Введи Telegram ID, @username пользователя или ID его фото (#0012), чтобы заблокировать:',
    askUserUnblock: 'Введи Telegram ID, @username пользователя или ID его фото (#0012), чтобы разблокировать:',
    invalidPhotoId: 'Некорректный ID фотографии. Пример: #0012',
    userNotFound: 'Пользователь не найден.',
    photoNotFound: 'Фотография не найдена.',
    cannotBlockAdmin: 'Нельзя заблокировать администратора.',
    userBlocked: (p: { name: string; cancelled: number }) =>
      `🚫 Пользователь ${p.name} заблокирован. Снято с очереди фото: ${p.cancelled}.`,
    userUnblocked: (name: string) => `🔓 Пользователь ${name} разблокирован.`,
    alreadyBlocked: 'Пользователь уже заблокирован.',
    notBlocked: 'Пользователь не заблокирован.',
    paused: '⏸ Автоматические публикации остановлены. Ручная публикация по-прежнему доступна.',
    resumed: '▶️ Автоматические публикации возобновлены.',
    publishedNotice: (p: { id: string; link: string; manual: boolean }) =>
      `${p.manual ? '🚀 Ручная публикация' : '✅ Публикация'}: фото ${p.id} — <a href="${p.link}">открыть</a>`,
    publishFailed: (p: { id: string; error: string }) =>
      `⚠️ Не удалось опубликовать фото ${p.id}.\nОшибка: <code>${p.error}</code>\n\nПроверь права бота в канале и повтори публикацию из карточки фото.`,
    newForModeration: (p: { id: string; author: string }) => `🛡 Новое фото на модерацию: ${p.id} от ${p.author}`,
    channelDeleteFailed: (p: { id: string; link: string }) =>
      `⚠️ Фото ${p.id} удалено автором, но публикацию в канале удалить не удалось. Удали вручную: ${p.link}`,
    settingsTitle: (p: {
      interval: string;
      paused: boolean;
      moderation: boolean;
      voting: boolean;
      maxPerDay: number;
      maxQueued: number;
      maxPerBattle: number;
      onlyBattle: boolean;
      weekly: boolean;
    }) =>
      '<b>⚙️ Настройки</b>\n\n' +
      `⏱ Интервал публикаций: ${p.interval}\n` +
      `Публикации: ${p.paused ? '⏸ остановлены' : '▶️ активны'}\n` +
      `🛡 Модерация перед публикацией: ${p.moderation ? 'вкл' : 'выкл'}\n` +
      `🔥 Голосование: ${p.voting ? 'вкл' : 'выкл'}\n` +
      `📅 Лимит фото в сутки: ${p.maxPerDay || 'без лимита'}\n` +
      `⏳ Лимит фото в очереди на пользователя: ${p.maxQueued || 'без лимита'}\n` +
      `⚔️ Лимит фото на батл: ${p.maxPerBattle || 'без лимита'}\n` +
      `🔒 Приём фото только во время батла: ${p.onlyBattle ? 'да' : 'нет'}\n` +
      `🗓 Еженедельные батлы (автоматически): ${p.weekly ? 'вкл' : 'выкл'}`,
    settingsButtons: {
      interval: '⏱ Интервал',
      moderation: '🛡 Модерация',
      voting: '🔥 Голосование',
      maxPerDay: '📅 Лимит в сутки',
      maxQueued: '⏳ Лимит очереди',
      maxPerBattle: '⚔️ Лимит на батл',
      onlyBattle: '🔒 Только в батле',
      weekly: '🗓 Еженедельные батлы',
    },
    chooseInterval: 'Выбери интервал между автоматическими публикациями:',
    intervalManual: 'Вручную',
    intervalLabel: (minutes: number) =>
      minutes === 0 ? 'только вручную' : minutes % 60 === 0 ? `каждые ${minutes / 60} ч` : `каждые ${minutes} мин`,
    chooseLimit: (name: string) => `${name}: выбери значение (0 — без лимита):`,
    settingsSaved: '✅ Настройки сохранены.',
    broadcastAsk:
      '📢 Отправь сообщение для рассылки всем пользователям (текст, фото, видео — любое сообщение).\n' +
      'Перед отправкой я покажу предпросмотр.',
    broadcastPreview: '👆 Так будет выглядеть объявление. Отправить всем пользователям?',
    broadcastSend: '📢 Отправить',
    broadcastStarted: (recipients: number) => `📢 Рассылка запущена. Получателей: ${recipients}. Отчёт придёт по завершении.`,
    broadcastDone: (p: { sent: number; failed: number }) => `📢 Рассылка завершена.\n✅ Доставлено: ${p.sent}\n⚠️ Не доставлено: ${p.failed}`,
    battlesTitle: '<b>⚔️ Батлы</b>',
    battlesEmpty: 'Батлов пока не было.',
    battleCreate: '➕ Создать батл',
    battleFinishNow: '🏁 Подвести итоги сейчас',
    battleCloseSubmissions: '⏳ Закрыть приём фото',
    battleCancel: '❌ Отменить батл',
    battleAskTitle: 'Введи название батла (до 64 символов):',
    battleAskTheme: 'Введи тему батла (до 200 символов) или нажми «Без темы»:',
    battleNoTheme: 'Без темы',
    battleAskSubmission: 'Сколько длится приём фотографий?',
    battleAskVoting: 'Сколько длится голосование после закрытия приёма?',
    battleCreated: (title: string) => `⚔️ Батл «${title}» создан и анонсирован в канале.`,
    battleFinished: (title: string) => `🏁 Батл «${title}» завершён.`,
    battleCancelled: (title: string) => `❌ Батл «${title}» отменён.`,
    battleVotingStarted: (title: string) => `⏳ Приём фото в батл «${title}» закрыт.`,
    hours: (h: number) => (h % 24 === 0 ? `${h / 24} дн.` : `${h} ч`),
    textTooLong: (max: number) => `Слишком длинный текст. Максимум ${max} символов.`,
  },
};

export type Locale = typeof ru;
