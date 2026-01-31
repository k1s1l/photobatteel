from telegram import Update
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    MessageHandler,
    ContextTypes,
    filters,
)
from datetime import datetime, timedelta
import logging

# ================== ЛОГИ ==================
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ================== НАСТРОЙКИ ==================
BOT_TOKEN = "8475116560:AAGt6KNkyL4B-W-RzVn4bqCUyJhd218bwog"  # <-- СЮДА ВСТАВЬ ТОКЕН

ADMIN_IDS = [
    1089178805,
    6661247126
]

TIME_LIMIT = timedelta(hours=12)
last_send_time = {}

# ================== /start ==================
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Привет! 👋\n\n"
        "Отправь фото или видео — я перешлю их на конкурс.\n\n"
        "⏳ Можно отправлять 1 раз в 12 часов."
    )

# ================== ФОТО / ВИДЕО ==================
async def handle_media(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    message = update.message
    now = datetime.now()

    user_id = user.id
    username = f"@{user.username}" if user.username else user.first_name

    # проверка лимита
    if user_id in last_send_time:
        diff = now - last_send_time[user_id]
        if diff < TIME_LIMIT:
            remain = TIME_LIMIT - diff
            h = remain.seconds // 3600
            m = (remain.seconds % 3600) // 60
            await message.reply_text(
                f"⏳ Ты уже отправлял.\n"
                f"Повтори через {h} ч {m} мин."
            )
            return

    caption = (
        "📤 МЕДИА НА КОНКУРС\n\n"
        f"👤 Участник: {username}\n"
        f"🆔 ID: {user_id}\n"
        f"⏰ {now.strftime('%d.%m.%Y %H:%M')}"
    )

    try:
        for admin_id in ADMIN_IDS:
            if message.photo:
                await context.bot.send_photo(
                    chat_id=admin_id,
                    photo=message.photo[-1].file_id,
                    caption=caption
                )
            elif message.video:
                await context.bot.send_video(
                    chat_id=admin_id,
                    video=message.video.file_id,
                    caption=caption
                )

        last_send_time[user_id] = now

        await message.reply_text("✅ Фото/видео отправлено на конкурс!")

    except Exception as e:
        logger.error(e)
        await message.reply_text("❌ Ошибка при отправке. Попробуй позже.")

# ================== ДРУГИЕ СООБЩЕНИЯ ==================
async def handle_other(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("❗ Отправь фото или видео 📸🎥")

# ================== ЗАПУСК ==================
def main():
    app = ApplicationBuilder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.PHOTO | filters.VIDEO, handle_media))
    app.add_handler(MessageHandler(filters.ALL, handle_other))

    print("✅ БОТ ЗАПУЩЕН")
    app.run_polling()

if __name__ == "__main__":
    main()
