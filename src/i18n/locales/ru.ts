import type { DomainErrorCode } from '../../lib/errors.js';

/**
 * Russian locale — the reference dictionary. Every other locale must satisfy
 * `Locale` (= typeof ru), so missing keys are caught at compile time.
 * Strings are HTML (parse_mode: 'HTML'); dynamic values are escaped by callers.
 */
export const ru = {
  languageName: 'Русский',
  /** BCP 47 tag for dates and numbers. */
  intl: 'ru-RU',

  menu: {
    submit: '📸 Отправить фото или видео',
    votes: '⭐ Купить голоса',
    battle: '⚔️ Текущий батл',
    rules: 'ℹ️ Правила',
    help: '❓ Помощь',
    admin: '🛠 Админ-панель',
  },

  /** Descriptions of bot commands shown in the Telegram command menu. */
  commands: {
    start: 'Главное меню',
    battle: 'Текущий батл',
    votes: 'Купить голоса',
    myphotos: 'Мои работы',
    stats: 'Моя статистика',
    rules: 'Правила',
    help: 'Помощь',
    language: 'Сменить язык',
    cancel: 'Отменить действие',
    deletedata: 'Удалить мои работы',
    paysupport: 'Помощь с оплатой',
  },

  language: {
    choose: 'Выбери язык интерфейса:\nОбери мову інтерфейсу:',
    changed: '✅ Язык интерфейса: русский.',
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
      'Отправляй фото или видео, сражайся в дуэлях и побеждай в батлах нашего канала!',
  },

  rules: {
    text: (p: { maxPerBattle: number; maxSizeMb: number; maxVideoSec: number; moderation: boolean }) =>
      '<b>ℹ️ Правила Photo Battle</b>\n\n' +
      '1. До начала батла участники присылают фото или видео. Работы не публикуются до старта.\n' +
      '2. В назначенное время работы случайно делятся на пары, и каждая пара выходит в канал отдельным постом.\n' +
      '3. Голосуют подписчики канала: один бесплатный голос в каждой паре, передумать можно до конца голосования.\n' +
      '4. Работа с большим числом голосов проходит в следующий раунд — и так до финала.\n' +
      '5. Ничья — пару публикуют заново на короткое переголосование.\n' +
      '6. Авторы не указываются: побеждает работа, а не имя.\n' +
      `7. ${p.maxPerBattle > 0 ? `Не больше ${p.maxPerBattle} работ от одного участника в батле.` : 'Количество работ в батле не ограничено.'}\n` +
      `8. Фото: JPG, PNG, WEBP до ${p.maxSizeMb} МБ. Видео: до ${p.maxVideoSec} сек.\n` +
      `9. ${p.moderation ? 'Каждую работу проверяет модератор.' : 'Работы с нарушениями удаляются администратором.'}\n` +
      '10. Запрещены чужие работы, откровенный, жестокий и оскорбительный контент, реклама.\n' +
      '11. Удалить свои работы: /myphotos или /deletedata.',
  },

  help: {
    text:
      '<b>❓ Помощь</b>\n\n' +
      '<b>Как участвовать:</b>\n' +
      '1. Нажми «📸 Отправить фото или видео».\n' +
      '2. Отправь одну работу и подтверди её.\n' +
      '3. В момент старта батла твоя работа выйдет в канал в паре с другой — бот пришлёт ссылку.\n\n' +
      '<b>Голосование:</b> под постом пары нажми «Поддержать 1» или «Поддержать 2». ' +
      'Голосовать могут подписчики канала. «⭐ +1» — дополнительные голоса за Звёзды или картой.\n\n' +
      '<b>Команды:</b>\n' +
      '/battle — текущий батл\n' +
      '/myphotos — мои работы\n' +
      '/stats — моя статистика\n' +
      '/votes — купить голоса\n' +
      '/language — сменить язык\n' +
      '/deletedata — удалить мои работы\n' +
      '/paysupport — помощь с оплатой',
  },

  consent: {
    request:
      '<b>Согласие на публикацию</b>\n\n' +
      'Отправляя работу, ты подтверждаешь, что:\n' +
      '• являешься её автором или имеешь право её публиковать;\n' +
      '• согласен(на) на её публикацию в публичном Telegram-канале (без указания твоего имени);\n' +
      '• ознакомлен(а) с правилами (/rules).\n\n' +
      'Ты в любой момент можешь удалить свои работы.',
    accept: '✅ Согласен(на)',
    accepted: '✅ Спасибо! Согласие сохранено.',
  },

  submission: {
    prompt: (p: { battle: string; start: string }) =>
      `📸 Отправь одно фото или видео для батла «${p.battle}».\n\n` +
      `Приём работ — до ${p.start}. Фото можно отправить как обычное фото или как файл (JPG, PNG, WEBP).`,
    processing: '⏳ Проверяю работу…',
    onlyOne: '⚠️ Отправляй работы по одной. Я обработаю только первую из альбома.',
    notMedia: '⚠️ Это не фото и не видео. Отправь фото (JPG, PNG, WEBP) или видео.',
    previewCaption: (p: { id: string; battle: string; start: string; moderation: boolean }) =>
      `<b>Предпросмотр</b> — работа ${p.id}\n` +
      `⚔️ Батл: ${p.battle} (старт ${p.start})\n` +
      '\nПроверь работу. Нажимая «✅ Подтвердить», ты соглашаешься на её публикацию в канале.' +
      (p.moderation ? '\nПеред батлом работу проверит модератор.' : ''),
    confirm: '✅ Подтвердить',
    cancel: '❌ Отменить',
    accepted: (p: { battle: string; start: string }) =>
      `✅ Работа принята в батл «${p.battle}»!\nСтарт — ${p.start}. Когда твоя пара выйдет в канал, я пришлю ссылку.`,
    acceptedModeration: (p: { battle: string; start: string }) =>
      `✅ Работа отправлена на модерацию для батла «${p.battle}» (старт ${p.start}).`,
    cancelledByUser: '❌ Отправка отменена.',
    previewConfirmed: (id: string) => `✅ Работа ${id} подтверждена.`,
    previewCancelled: (id: string) => `❌ Работа ${id} — отправка отменена.`,
    previewExpired: 'Этот предпросмотр больше не действителен (истёк срок или ты отправил другую работу). Отправь её ещё раз.',
  },

  errors: {
    NOT_FOUND: () => 'Не найдено.',
    FORBIDDEN: () => '⛔ Недостаточно прав для этого действия.',
    USER_BLOCKED: () => '🚫 Твой доступ к Photo Battle ограничен администратором.',
    CONSENT_REQUIRED: () => 'Сначала нужно дать согласие на публикацию.',
    INVALID_STATE: () => 'Это действие уже недоступно.',
    BATTLE_LIMIT: (p) => `⚠️ В этом батле можно участвовать не более чем ${p.limit} работ(ой).`,
    NO_ACTIVE_BATTLE: () => '⏳ Сейчас приём работ закрыт. Следи за анонсами в канале — скоро новый батл!',
    DUPLICATE_PHOTO: () => '⚠️ Эта работа уже отправлялась в Photo Battle. Повторная отправка невозможна.',
    INVALID_IMAGE: () => '⚠️ Не удалось прочитать изображение: файл повреждён или это не фото. Попробуй другой файл.',
    FILE_TOO_LARGE: (p) => `⚠️ Файл слишком большой. Максимальный размер — ${p.maxMb} МБ.`,
    UNSUPPORTED_FORMAT: () => '⚠️ Формат не поддерживается. Допустимы фото JPG, PNG, WEBP и видео.',
    DIMENSIONS: (p) => `⚠️ Неподходящее разрешение. Каждая сторона должна быть от ${p.min} до ${p.max} px.`,
    VIDEO_TOO_LONG: (p) => `⚠️ Видео слишком длинное. Максимум — ${p.max} сек.`,
    BATTLE_EXISTS: () => 'Уже есть запланированный или идущий батл. Заверши или отмени его, прежде чем создавать новый.',
    SELF_VOTE: () => 'Нельзя голосовать за свою работу 🙂',
    VOTING_CLOSED: () => 'Голосование в этой паре уже завершено.',
    NOT_SUBSCRIBED: () => 'Голосовать могут только подписчики канала. Подпишись и нажми ещё раз 🙌',
    INSUFFICIENT_BALANCE: (p) => `Недостаточно купленных голосов на балансе (сейчас: ${p.balance}).`,
    PAYMENTS_DISABLED: () => 'Покупка голосов сейчас недоступна.',
  } satisfies Record<DomainErrorCode, (p: Record<string, string | number>) => string>,

  status: {
    DRAFT: '📝 Ожидает подтверждения',
    PENDING_MODERATION: '🛡 На модерации',
    ACCEPTED: '⏳ Ждёт старта батла',
    IN_BATTLE: '⚔️ В батле',
    ELIMINATED: '🏁 Выбыла',
    WINNER: '🏆 Победитель',
    REJECTED: '⛔ Отклонена',
    DELETED: '🗑 Удалена',
    CANCELLED: '❌ Отменена',
  },

  mediaType: {
    PHOTO: '📷 Фото',
    VIDEO: '🎬 Видео',
  },

  myPhotos: {
    title: (total: number) => `<b>🗂 Мои работы</b> (${total})\n\nНажми на работу, чтобы открыть её.`,
    empty: 'У тебя пока нет работ. Нажми «📸 Отправить фото или видео», чтобы участвовать!',
    card: (p: { id: string; status: string; date: string; votes: number; battle: string | null; link: string | null; reason: string | null }) =>
      `<b>Работа ${p.id}</b>\n` +
      `Статус: ${p.status}\n` +
      `Отправлена: ${p.date}\n` +
      `🔥 Голосов: ${p.votes}` +
      (p.battle ? `\n⚔️ Батл: ${p.battle}` : '') +
      (p.reason ? `\nПричина: ${p.reason}` : '') +
      (p.link ? `\n\n<a href="${p.link}">Открыть пару в канале</a>` : ''),
    delete: '🗑 Удалить работу',
    deleteConfirm: (id: string) => `Удалить работу ${id}? Если она сейчас в батле, она выбывает, а пост пары удаляется из канала.`,
    deleted: (id: string) => `🗑 Работа ${id} удалена.`,
    deleteAllConfirm: '⚠️ Удалить <b>все</b> твои работы? Работы в идущем батле выбудут. Действие необратимо.',
    deleteAllDone: (count: number) => `🗑 Удалено работ: ${count}.`,
  },

  stats: {
    text: (p: { since: string; submitted: number; waiting: number; votes: number; balance: number }) =>
      '<b>📊 Моя статистика</b>\n\n' +
      `📅 Участник с: ${p.since}\n` +
      `📸 Отправлено работ: ${p.submitted}\n` +
      `⏳ Сейчас в батле или ждут старта: ${p.waiting}\n` +
      `🔥 Получено голосов: ${p.votes}\n` +
      `⭐ Купленных голосов на балансе: ${p.balance}`,
  },

  battle: {
    none: 'Сейчас нет батла. Следи за анонсами в канале!',
    info: (p: { title: string; status: string; start: string; round: number; entries: number }) =>
      `<b>⚔️ ${p.title}</b>\n` +
      `Статус: ${p.status}\n` +
      `Старт: ${p.start}\n` +
      (p.round > 0 ? `Раунд: ${p.round}\n` : '') +
      `Работ: ${p.entries}`,
    statusScheduled: '📸 Идёт приём работ',
    statusRunning: '🔥 Идёт голосование',
    statusFinished: '🏁 Завершён',
    statusCancelled: '❌ Отменён',
    announceScheduled: (p: { title: string; start: string; botUsername: string }) =>
      `🏆 <b>НОВЫЙ ФОТОБАТЛ: ${p.title}</b>\n\n` +
      `📸 Приём фото и видео — до ${p.start}\n` +
      `⚔️ В ${p.start} все работы выйдут в канал парами — голосуй за лучшую!\n\n` +
      `Отправляй свою работу в бота @${p.botUsername}`,
    announceNoEntries: (title: string) => `😔 Батл «${title}» не состоялся: не было ни одной работы.`,
    announceRound: (p: { title: string; round: number; entries: number }) =>
      `⚔️ <b>${p.title} — раунд ${p.round}</b>\n\nВ борьбе ${p.entries} работ. Голосуй в парах ниже! 🔥`,
    announceWinner: (p: { title: string; votes: number }) =>
      `🏆 <b>Победитель батла «${p.title}»</b>\n\n🔥 Голосов за весь батл: ${p.votes}\n\nПоздравляем автора! 🎉`,
    winnerDm: (title: string) => `🏆 Поздравляем! Твоя работа победила в батле «${title}»! 🎉`,
    entryPosted: (p: { round: number; link: string }) =>
      `⚔️ Твоя работа вышла в канал — раунд ${p.round}!\n<a href="${p.link}">Открыть пару</a> — зови друзей голосовать 🔥`,
    duelWon: (p: { round: number; link: string }) => `🎉 Твоя работа выиграла пару в раунде ${p.round} и проходит дальше! <a href="${p.link}">Пост</a>`,
    duelLost: (p: { round: number; link: string }) => `😔 В раунде ${p.round} твоя работа уступила сопернику. Спасибо за участие! <a href="${p.link}">Пост</a>`,
  },

  duel: {
    /** Used until an admin uploads a custom design. Placeholders: {battle} {round} {duel} {stage}. */
    defaultTemplate:
      '⚔️ <b>PHOTO BATTLE</b> · {battle}\n' +
      '{stage}\n\n' +
      '1️⃣ или 2️⃣ — какая работа сильнее?\n' +
      '🔥 Поддержи свою!',
    stageMain: (p: { round: number; duel: number }) => `Раунд ${p.round} · Пара ${p.duel}`,
    stageTiebreak: (p: { round: number; duel: number }) => `⚡ Переголосование! Раунд ${p.round} · Пара ${p.duel}`,
    voteButton: (p: { side: 1 | 2; votes: number }) => `Поддержать ${p.side} · ${p.votes}`,
    paidButton: '⭐ +1 голос',
    closedButton: '🏁 Голосование завершено',
    tieButton: '⚡ Ничья — переголосование ниже',
    voted: (side: 1 | 2) => `🔥 Голос за работу ${side} учтён!`,
    withdrawn: 'Голос отменён.',
    closed: 'Голосование в этой паре завершено.',
    chooseSide: (p: { round: number; duel: number }) => `<b>⭐ Голоса — раунд ${p.round}, пара ${p.duel}</b>\n\nЗа какую работу?`,
    side: (side: 1 | 2) => `Работа ${side}`,
    /** The bot's message with vote buttons, posted as a reply under the admin's duel post. */
    buttonsMessage: (p: { round: number; duel: number; tiebreak: boolean }) =>
      p.tiebreak ? `⚡ Переголосование · Раунд ${p.round} · Пара ${p.duel} — голосуй 👇` : `🗳 Раунд ${p.round} · Пара ${p.duel} — голосуй 👇`,
  },

  payments: {
    menu: (p: { balance: number }) =>
      '<b>⭐ Дополнительные голоса</b>\n\n' +
      'Купленные голоса добавляются к работе в её текущей паре.\n' +
      'Удобнее всего — нажать «⭐ +1 голос» под нужной парой в канале.\n\n' +
      `Твой баланс: <b>${p.balance}</b>\n\n` +
      'Купить голоса на баланс:',
    menuForSide: (p: { side: 1 | 2; round: number; duel: number; balance: number }) =>
      `<b>⭐ Голоса за работу ${p.side}</b> (раунд ${p.round}, пара ${p.duel})\n\n` +
      'Купленные голоса сразу добавятся этой работе.' +
      (p.balance > 0 ? `\nНа балансе: ${p.balance} — можно отдать прямо сейчас.` : ''),
    packStars: (p: { votes: number; price: number }) => `${p.votes} гол. — ${p.price} ⭐`,
    packCard: (p: { votes: number; price: string }) => `${p.votes} гол. — ${p.price} 💳`,
    spendButton: (amount: number) => `🎁 +${amount} с баланса`,
    spent: (p: { amount: number; side: 1 | 2; left: number }) => `⭐ Работа ${p.side} получила +${p.amount}. Осталось на балансе: ${p.left}.`,
    invoiceTitle: (votes: number) => `${votes} голосов — Photo Battle`,
    invoiceToBalance: (votes: number) => `${votes} дополнительных голосов на баланс.`,
    invoiceToSide: (p: { votes: number; side: 1 | 2 }) => `${p.votes} дополнительных голосов за работу ${p.side} в текущей паре.`,
    invoiceLabel: (votes: number) => `${votes} голосов`,
    paidToBalance: (p: { votes: number; balance: number }) => `✅ Оплата прошла! На баланс зачислено ${p.votes} гол. Сейчас на балансе: ${p.balance}.`,
    paidToPhoto: (votes: number) => `✅ Оплата прошла! Работа получила +${votes} гол.`,
    paidPhotoGone: (p: { votes: number; balance: number }) =>
      `✅ Оплата прошла! Голосование в паре уже закончилось, поэтому ${p.votes} гол. зачислены на баланс (${p.balance}).`,
    checkoutExpired: 'Этот счёт устарел. Открой «⭐ Купить голоса» и создай новый.',
    checkoutUnavailable: 'Голосование в этой паре уже завершено.',
    support:
      '<b>💬 Помощь с оплатой</b>\n\n' +
      'Если голоса не начислились или возникла другая проблема с оплатой, напиши администратору канала. ' +
      'Укажи дату, сумму и способ оплаты — мы проверим платёж и вернём средства, если голоса не были получены.',
    terms:
      '<b>Условия покупки голосов</b>\n\n' +
      '• Голоса — цифровой товар внутри Photo Battle; они зачисляются сразу после оплаты.\n' +
      '• Голоса действуют в текущей паре; отданные голоса нельзя вернуть на баланс.\n' +
      '• Если голосование закончилось до оплаты, голоса зачисляются на баланс.\n' +
      '• Возврат возможен, если голоса не были начислены: /paysupport.',
    refunded: (votes: number) => `↩️ Оплата возвращена. Списано голосов: ${votes}.`,
  },

  notifications: {
    approved: (id: string) => `✅ Работа ${id} прошла модерацию и примет участие в батле.`,
    rejected: (p: { id: string; reason: string }) => `⛔ Работа ${p.id} отклонена модератором.\nПричина: ${p.reason}`,
    deletedByAdmin: (id: string) => `🗑 Работа ${id} удалена администратором.`,
    blocked: '🚫 Твой доступ к Photo Battle ограничен администратором.',
    unblocked: '🔓 Доступ к Photo Battle восстановлен. Добро пожаловать обратно!',
  },

  rejectReasons: {
    rules: 'Нарушение правил',
    quality: 'Низкое качество',
    theme: 'Не соответствует теме батла',
    duplicate: 'Повтор или чужая работа',
    blocked: 'Пользователь заблокирован',
  },

  admin: {
    accessDenied: '⛔ У тебя нет доступа к админ-панели.',
    panelTitle: (p: { battle: string | null; pending: number; paid: boolean }) =>
      '<b>🛠 Админ-панель Photo Battle</b>\n\n' +
      `Батл: ${p.battle ?? 'не запланирован'}\n` +
      `На модерации: ${p.pending}\n` +
      `Продажа голосов: ${p.paid ? 'включена' : 'выключена'}`,
    buttons: {
      stats: '📊 Статистика',
      users: '👥 Пользователи',
      photos: '🗂 Все работы',
      moderation: '🛡 Модерация',
      battles: '⚔️ Батлы',
      design: '🎨 Оформление поста',
      delete: '🗑 Удалить работу',
      block: '🚫 Заблокировать',
      unblock: '🔓 Разблокировать',
      settings: '⚙️ Настройки',
      broadcast: '📢 Объявление',
      payments: '💰 Платежи',
      panel: '🛠 В админ-панель',
    },
    stats: (p: {
      users: number;
      newUsers24h: number;
      blockedUsers: number;
      received: number;
      waiting: number;
      pending: number;
      inBattle: number;
      rejected: number;
      deleted: number;
      battlesFinished: number;
      duelsFinished: number;
      freeVotes: number;
      paidVotes: number;
    }) =>
      '<b>📊 Статистика</b>\n\n' +
      `👥 Пользователей: ${p.users} (+${p.newUsers24h} за сутки), заблокировано: ${p.blockedUsers}\n\n` +
      `📸 Получено работ: ${p.received}\n` +
      `⏳ Ждут старта: ${p.waiting} · 🛡 На модерации: ${p.pending}\n` +
      `⚔️ Сейчас в батле: ${p.inBattle}\n` +
      `⛔ Отклонено: ${p.rejected} · 🗑 Удалено: ${p.deleted}\n\n` +
      `🏆 Проведено батлов: ${p.battlesFinished} · пар: ${p.duelsFinished}\n` +
      `🔥 Бесплатных голосов: ${p.freeVotes} · ⭐ платных: ${p.paidVotes}`,
    usersTitle: (total: number) => `<b>👥 Пользователи</b> (${total})`,
    userCard: (p: {
      name: string;
      telegramId: string;
      since: string;
      lastActive: string;
      submitted: number;
      votes: number;
      balance: number;
      blocked: boolean;
      reason: string | null;
      admin: boolean;
    }) =>
      `<b>${p.name}</b>${p.admin ? ' (админ)' : ''}\n` +
      `Telegram ID: <code>${p.telegramId}</code>\n` +
      `Регистрация: ${p.since}\n` +
      `Активность: ${p.lastActive}\n` +
      `📸 Работ: ${p.submitted} · 🔥 Голосов: ${p.votes} · ⭐ Баланс: ${p.balance}\n` +
      `Статус: ${p.blocked ? `🚫 заблокирован${p.reason ? ` (${p.reason})` : ''}` : '✅ активен'}`,
    userPhotos: '🗂 Работы пользователя',
    photosTitle: (p: { filter: string; total: number }) => `<b>🗂 Работы</b> — ${p.filter} (${p.total})`,
    filterAll: 'Все',
    moderationTitle: (total: number) => `<b>🛡 Модерация</b> — ожидают решения: ${total}`,
    moderationEmpty: 'Нет работ, ожидающих модерации.',
    photoCard: (p: {
      id: string;
      type: string;
      author: string;
      authorId: string;
      status: string;
      created: string;
      size: string;
      votes: number;
      battle: string | null;
      reason: string | null;
    }) =>
      `<b>Работа ${p.id}</b> · ${p.type}\n` +
      `Автор: ${p.author} (<code>${p.authorId}</code>)\n` +
      `Статус: ${p.status}\n` +
      `Создана: ${p.created}\n` +
      `Размер: ${p.size} · 🔥 ${p.votes}` +
      (p.battle ? `\n⚔️ Батл: ${p.battle}` : '') +
      (p.reason ? `\nПричина отклонения: ${p.reason}` : ''),
    actions: {
      approve: '✅ Одобрить',
      reject: '⛔ Отклонить',
      delete: '🗑 Удалить',
      author: '👤 Автор',
      block: '🚫 Заблокировать',
      unblock: '🔓 Разблокировать',
    },
    chooseRejectReason: 'Выбери причину отклонения:',
    deleteConfirm: (id: string) => `Удалить работу ${id}? Если она в батле — она выбывает, а пост её пары удаляется из канала.`,
    approved: (id: string) => `✅ Работа ${id} одобрена.`,
    rejected: (id: string) => `⛔ Работа ${id} отклонена.`,
    deleted: (id: string) => `🗑 Работа ${id} удалена.`,
    deletedForfeit: (id: string) => `🗑 Работа ${id} удалена и выбыла из батла: соперник проходит дальше, пост пары удалён.`,
    askPhotoIdDelete: 'Введи ID работы для удаления (например, #0012):',
    askUserBlock: 'Введи Telegram ID, @username пользователя или ID его работы (#0012), чтобы заблокировать:',
    askUserUnblock: 'Введи Telegram ID, @username пользователя или ID его работы (#0012), чтобы разблокировать:',
    invalidPhotoId: 'Некорректный ID работы. Пример: #0012',
    userNotFound: 'Пользователь не найден.',
    photoNotFound: 'Работа не найдена.',
    cannotBlockAdmin: 'Нельзя заблокировать администратора.',
    userBlocked: (p: { name: string; cancelled: number }) => `🚫 Пользователь ${p.name} заблокирован. Снято работ: ${p.cancelled}.`,
    userUnblocked: (name: string) => `🔓 Пользователь ${name} разблокирован.`,
    alreadyBlocked: 'Пользователь уже заблокирован.',
    notBlocked: 'Пользователь не заблокирован.',
    newForModeration: (p: { id: string; author: string }) => `🛡 Новая работа на модерацию: ${p.id} от ${p.author}`,
    duelPostFailed: (error: string) =>
      `⚠️ Не удаётся подготовить пост пары.\nОшибка: <code>${error}</code>\n\nБот будет повторять попытки.`,
    duelReady: (p: { round: number; duel: number; tiebreak: boolean }) =>
      `${p.tiebreak ? '⚡ Переголосование!' : '⚔️'} Раунд ${p.round} · Пара ${p.duel}\n` +
      'Перешли пост ниже в канал <b>без автора</b> (Переслать → Скрыть отправителя). Подпись можно поправить перед отправкой. Кнопки голосования бот добавит сам.',
    duelPublished: (p: { round: number; duel: number; ends: string }) => `✅ Пара ${p.duel} (раунд ${p.round}) опубликована, кнопки добавлены. Голосование до ${p.ends}.`,
    announcementReady: '📢 Пост для канала — перешли сообщение ниже без автора:',
    progress: (p: { finished: number; total: number; ready: number }) =>
      `завершено ${p.finished}/${p.total}` + (p.ready > 0 ? `, ждут публикации: ${p.ready}` : ''),
    settingsTitle: (p: { moderation: boolean; subscribersOnly: boolean; maxPerBattle: number }) =>
      '<b>⚙️ Настройки</b>\n\n' +
      `🛡 Модерация работ: ${p.moderation ? 'вкл' : 'выкл'}\n` +
      `📢 Голосуют только подписчики канала: ${p.subscribersOnly ? 'да' : 'нет'}\n` +
      `📸 Работ от участника в батле: ${p.maxPerBattle || 'без лимита'}`,
    settingsButtons: {
      moderation: '🛡 Модерация',
      subscribersOnly: '📢 Только подписчики',
      maxPerBattle: '📸 Лимит работ',
    },
    chooseLimit: 'Сколько работ может отправить один участник в батл? (0 — без лимита)',
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
    battleInfo: (p: { title: string; status: string; start: string; roundMinutes: number; tiebreakMinutes: number; entries: number; round: number; progress: string | null }) =>
      `<b>${p.title}</b> — ${p.status}\n` +
      `Старт: ${p.start} · Голосование в паре: ${p.roundMinutes} мин · Переголосование: ${p.tiebreakMinutes} мин\n` +
      `Работ: ${p.entries}` +
      (p.round > 0 ? ` · Раунд ${p.round}${p.progress ? ` (${p.progress})` : ''}` : ''),
    battleCreate: '➕ Запланировать батл',
    battleCancel: '❌ Отменить батл',
    battleCancelConfirm: (title: string) => `Отменить батл «${title}»? Все работы снимаются, открытые пары закрываются.`,
    battleAskTitle: 'Введи название батла (до 64 символов):',
    battleAskStart: (p: { timeZone: string; example: string }) =>
      `Когда старт? До этого времени бот собирает работы, затем публикует пары.\n\n` +
      `Формат: <code>14:00</code> (сегодня/завтра) или <code>${p.example}</code>.\nЧасовой пояс: ${p.timeZone}.`,
    battleStartInvalid: 'Не понял время или оно уже прошло. Пример: <code>14:00</code> или <code>06.11 14:00</code>',
    battleAskRound: 'Сколько длится голосование в каждой паре?',
    battleCreated: (p: { title: string; start: string }) => `⚔️ Батл «${p.title}» запланирован на ${p.start} и анонсирован в канале.`,
    battleCancelled: (title: string) => `❌ Батл «${title}» отменён.`,
    minutes: (m: number) => (m % 60 === 0 ? `${m / 60} ч` : `${m} мин`),
    designTitle: (custom: boolean) =>
      '<b>🎨 Оформление поста пары</b>\n\n' +
      (custom ? 'Сейчас используется <b>твоё оформление</b>. Пример ниже.' : 'Сейчас стандартное оформление. Пример ниже.') +
      '\n\nЧтобы поменять — нажми «✏️ Загрузить своё» и пришли сообщение, оформленное как пост: жирный, курсив, ссылки, премиум-эмодзи.\n\n' +
      'Подстановки: <code>{battle}</code> — название батла, <code>{round}</code> — раунд, <code>{duel}</code> — номер пары, ' +
      '<code>{stage}</code> — «Раунд 1 · Пара 3» / «Переголосование».\n\n' +
      'Посты пар приходят тебе в личку, ты пересылаешь их в канал — премиум-эмодзи сохраняются (нужен Telegram Premium у владельца бота).',
    designUpload: '✏️ Загрузить своё',
    designReset: '↩️ Стандартное оформление',
    designAsk: 'Пришли одним сообщением текст поста с нужным оформлением и эмодзи. Можно использовать подстановки {battle}, {round}, {duel}, {stage}.',
    designNeedsText: 'Нужно текстовое сообщение (без фото). Попробуй ещё раз.',
    designSaved: '✅ Оформление сохранено. Так будет выглядеть подпись к паре:',
    designResetDone: '↩️ Вернул стандартное оформление.',
    textTooLong: (max: number) => `Слишком длинный текст. Максимум ${max} символов.`,
    paymentsTitle: (p: { enabled: boolean; card: boolean; paid: number; stars: number; card24: string; cardTotal: string; votesSold: number; paid24h: number }) =>
      '<b>💰 Платежи и голоса</b>\n\n' +
      `Продажа голосов: ${p.enabled ? '✅ включена' : '⛔ выключена'}\n` +
      `Оплата картой: ${p.card ? '✅ подключена' : '— не подключена (нет PAYMENT_PROVIDER_TOKEN)'}\n\n` +
      `Оплат всего: ${p.paid} (за сутки: ${p.paid24h})\n` +
      `⭐ Получено звёзд: ${p.stars}\n` +
      `💳 Получено картой: ${p.cardTotal} (за сутки: ${p.card24})\n` +
      `🔥 Продано голосов: ${p.votesSold}\n\n` +
      'Пакеты (нажми, чтобы изменить цену):',
    paymentsToggleOn: '✅ Включить продажу голосов',
    paymentsToggleOff: '⛔ Выключить продажу голосов',
    packageRow: (p: { votes: number; stars: number; card: string; active: boolean }) => `${p.active ? '' : '🚫 '}${p.votes} гол. · ${p.stars}⭐ · ${p.card}`,
    packageCard: (p: { votes: number; stars: number; card: string; active: boolean }) =>
      `<b>Пакет: ${p.votes} голосов</b>\nЦена: ${p.stars} ⭐ / ${p.card}\nСтатус: ${p.active ? 'продаётся' : 'скрыт'}`,
    packageEditPrice: '✏️ Изменить цену',
    packageHide: '🚫 Скрыть пакет',
    packageShow: '✅ Показывать пакет',
    askPackagePrice: (p: { votes: number; currency: string }) =>
      `Введи новую цену пакета «${p.votes} голосов»: звёзды и сумму в ${p.currency} через пробел, например <code>90 89</code>`,
    packagePriceInvalid: 'Формат: два числа через пробел — звёзды и сумма картой, например <code>90 89</code>',
    packageSaved: '✅ Пакет обновлён.',
    paymentsList: '🧾 Последние оплаты',
    paymentsListTitle: '<b>🧾 Последние оплаты</b>',
    paymentsEmpty: 'Оплат пока нет.',
    paymentRow: (p: { id: number; user: string; votes: number; amount: string; status: string; date: string }) =>
      `#${p.id} · ${p.date} · ${p.user} · ${p.votes} гол. · ${p.amount} · ${p.status}`,
    refund: (id: number) => `↩️ Вернуть звёзды по оплате #${id}`,
    refundConfirm: (p: { id: number; amount: string; user: string }) =>
      `Вернуть оплату #${p.id} (${p.amount}) пользователю ${p.user}? Голоса, ещё не учтённые в завершённых парах, будут списаны.`,
    refundDone: (p: { id: number; reclaimed: number }) => `↩️ Оплата #${p.id} возвращена. Списано голосов: ${p.reclaimed}.`,
    refundOnlyStars: 'Автоматический возврат доступен только для оплат звёздами. Оплату картой возвращайте в кабинете платёжного провайдера.',
    paymentStatus: { PENDING: '⏳ ожидает', PAID: '✅ оплачено', REFUNDED: '↩️ возврат' },
  },
};

export type Locale = typeof ru;
