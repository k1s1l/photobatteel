import { getLocale, type Locale } from '../../i18n/index.js';
import type { Logger } from '../../lib/logger.js';
import { classifyTelegramError } from '../../lib/telegram-errors.js';
import type { AdminService } from '../admins/admin.service.js';
import type { SendOptions, TelegramGateway } from '../contracts.js';
import type { UserService } from '../users/user.service.js';

/** Builds a message in the recipient's language. */
export type TextBuilder = (locale: Locale) => string;

export interface Recipient {
  telegramId: number | bigint;
  languageCode?: string | null;
}

/** Best-effort direct messages: failures are logged, never propagated. */
export class NotificationService {
  constructor(
    private readonly telegram: TelegramGateway,
    private readonly users: UserService,
    private readonly admins: AdminService,
    private readonly defaultLanguage: string,
    private readonly logger: Logger,
  ) {}

  async notifyUser(recipient: Recipient, build: TextBuilder, options: SendOptions = { parseMode: 'HTML' }): Promise<boolean> {
    const chatId = Number(recipient.telegramId);
    try {
      await this.telegram.sendMessage(chatId, build(getLocale(recipient.languageCode ?? this.defaultLanguage)), options);
      return true;
    } catch (error) {
      const classified = classifyTelegramError(error);
      if (classified.kind === 'bot_blocked') await this.users.markBotBlocked(chatId);
      else this.logger.warn({ err: error, chatId }, 'Failed to notify user');
      return false;
    }
  }

  async notifyAdmins(build: TextBuilder, options: SendOptions = { parseMode: 'HTML', disablePreview: true }): Promise<void> {
    const admins = await this.adminRecipients();
    await Promise.all(admins.map((admin) => this.notifyUser(admin, build, options)));
  }

  async notifyAdminsWithPhoto(fileId: string, build: TextBuilder, buildOptions: (locale: Locale) => SendOptions): Promise<void> {
    const admins = await this.adminRecipients();
    await Promise.all(
      admins.map(async (admin) => {
        const locale = getLocale(admin.languageCode ?? this.defaultLanguage);
        try {
          await this.telegram.sendPhoto(Number(admin.telegramId), fileId, { ...buildOptions(locale), caption: build(locale) });
        } catch (error) {
          this.logger.warn({ err: error, adminId: admin.telegramId }, 'Failed to send photo to admin');
        }
      }),
    );
  }

  private async adminRecipients(): Promise<Recipient[]> {
    const ids = await this.admins.listAdminTelegramIds();
    return Promise.all(
      ids.map(async (id) => ({ telegramId: id, languageCode: (await this.users.findByTelegramId(id))?.languageCode ?? null })),
    );
  }
}
