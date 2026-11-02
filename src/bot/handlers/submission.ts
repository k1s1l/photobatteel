import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { Message } from 'telegraf/types';
import { allTranslations } from '../../i18n/index.js';
import { DomainError, isDomainError } from '../../lib/errors.js';
import { escapeHtml, formatPhotoId } from '../../lib/format.js';
import { normalizeForTelegramPhoto, SUPPORTED_MIME_TYPES, validateImage } from '../../modules/photos/image-validator.js';
import type { DraftInput } from '../../modules/photos/photo.service.js';
import { currentUser, setState, type BotContext } from '../context.js';
import { answer, matchInt, showError } from '../helpers.js';
import { button, inline } from '../keyboards.js';
import { moderationKeyboard } from './admin/keyboards.js';
import { showMainMenu } from './common.js';

const INTAKE_LOCK_MS = 60_000;
const ALBUM_LOCK_MS = 60_000;
const CONFIRM_LOCK_MS = 15_000;

async function askConsent(ctx: BotContext): Promise<void> {
  await ctx.reply(ctx.locale.consent.request, {
    parse_mode: 'HTML',
    reply_markup: inline([[button(ctx.locale.consent.accept, 'consent')], [button(ctx.locale.common.cancel, 'sub:cancel')]]),
  });
}

async function beginSubmission(ctx: BotContext): Promise<void> {
  const user = currentUser(ctx);
  if (!user.consentAt) {
    await askConsent(ctx);
    return;
  }
  const battle = await ctx.deps.services.photos.assertCanSubmit(user);
  setState(ctx, { kind: 'awaiting_photo' });
  await ctx.reply(ctx.locale.submission.prompt({ battle: battle ? escapeHtml(battle.title) : null }), {
    parse_mode: 'HTML',
    reply_markup: inline([[button(ctx.locale.common.cancel, 'sub:cancel')]]),
  });
}

interface IncomingImage {
  source: DraftInput['source'];
  fileId: string;
  fileUniqueId: string;
  declaredSize?: number | undefined;
}

function extractImage(msg: Message.PhotoMessage | Message.DocumentMessage): IncomingImage | null {
  if ('photo' in msg) {
    const largest = msg.photo.at(-1);
    if (!largest) return null;
    return { source: 'PHOTO', fileId: largest.file_id, fileUniqueId: largest.file_unique_id, declaredSize: largest.file_size };
  }
  const doc = msg.document;
  if (!doc.mime_type || !(SUPPORTED_MIME_TYPES as readonly string[]).includes(doc.mime_type)) return null;
  return { source: 'DOCUMENT', fileId: doc.file_id, fileUniqueId: doc.file_unique_id, declaredSize: doc.file_size };
}

async function handleIncomingImage(ctx: BotContext, msg: Message.PhotoMessage | Message.DocumentMessage): Promise<void> {
  const { locks, services, gateway, env } = ctx.deps;
  const user = currentUser(ctx);

  // Albums: only the first item is processed.
  if (msg.media_group_id) {
    const first = await locks.acquire(`album:${msg.media_group_id}`, ALBUM_LOCK_MS);
    if (!first) return;
    await ctx.reply(ctx.locale.submission.onlyOne);
  }

  const image = extractImage(msg);
  if (!image) {
    await ctx.reply(ctx.locale.submission.notAnImage);
    return;
  }
  if (!user.consentAt) {
    await askConsent(ctx);
    return;
  }

  const result = await locks.withLock(`intake:${user.id}`, INTAKE_LOCK_MS, async () => {
    const maxBytes = env.MAX_PHOTO_SIZE_MB * 1024 * 1024;
    if (image.declaredSize !== undefined && image.declaredSize > maxBytes) throw new DomainError('FILE_TOO_LARGE', { maxMb: env.MAX_PHOTO_SIZE_MB });
    await services.photos.assertCanSubmit(user);

    const progress = await ctx.reply(ctx.locale.submission.processing);
    try {
      const buffer = await gateway.downloadFile(image.fileId, maxBytes);
      const validated = await validateImage(buffer, { maxBytes, minDimension: env.MIN_PHOTO_DIMENSION, maxDimension: env.MAX_PHOTO_DIMENSION });
      const upload = image.source === 'DOCUMENT' ? await normalizeForTelegramPhoto(buffer) : null;

      const draft = await services.photos.createDraft(user, {
        source: image.source,
        fileId: image.fileId,
        fileUniqueId: image.fileUniqueId,
        contentHash: validated.contentHash,
        mimeType: validated.mimeType,
        width: validated.width,
        height: validated.height,
        fileSize: validated.size,
      });

      try {
        const battle = await services.battles.getAcceptingBattle();
        const settings = await services.settings.get();
        const id = formatPhotoId(draft.id);
        const preview = await ctx.replyWithPhoto(upload ? { source: upload, filename: `${id}.jpg` } : image.fileId, {
          caption: ctx.locale.submission.previewCaption({
            id,
            battle: battle ? escapeHtml(battle.title) : null,
            moderation: settings.moderationEnabled,
          }),
          parse_mode: 'HTML',
          reply_markup: inline([
            [button(ctx.locale.submission.confirm, `ph:ok:${draft.id}`), button(ctx.locale.submission.cancel, `ph:no:${draft.id}`)],
          ]),
        });
        // Files are re-uploaded as photos; the resulting photo file_id is what gets published.
        const publishFileId = upload ? preview.photo.at(-1)?.file_id : undefined;
        await services.photos.attachPreview(draft.id, preview.message_id, publishFileId);
      } catch (error) {
        await services.photos.cancelDraft(draft.id, user.id).catch(() => undefined);
        throw error;
      }
    } finally {
      await ctx.deleteMessage(progress.message_id).catch(() => undefined);
    }
    return true;
  });

  if (result === undefined) {
    await ctx.reply(ctx.locale.common.busy);
    return;
  }
  setState(ctx, undefined);
}

export function registerSubmissionHandlers(bot: Telegraf<BotContext>): void {
  bot.hears(allTranslations((l) => l.menu.submit), beginSubmission);

  bot.action('consent', async (ctx) => {
    const user = currentUser(ctx);
    if (!user.consentAt) ctx.user = await ctx.deps.services.users.giveConsent(user.id);
    await answer(ctx, ctx.locale.consent.accepted);
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    await beginSubmission(ctx);
  });

  bot.action('sub:cancel', async (ctx) => {
    setState(ctx, undefined);
    await answer(ctx);
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    await showMainMenu(ctx, ctx.locale.common.cancelled);
  });

  bot.on(message('photo'), (ctx) => handleIncomingImage(ctx, ctx.message));
  bot.on(message('document'), (ctx) => handleIncomingImage(ctx, ctx.message));

  bot.action(/^ph:ok:(\d+)$/, async (ctx) => {
    const photoId = matchInt(ctx);
    const user = currentUser(ctx);
    const { services, locks } = ctx.deps;
    const outcome = await locks.withLock(`confirm:${photoId}`, CONFIRM_LOCK_MS, async () => {
      try {
        return await services.photos.confirm(photoId, user.id);
      } catch (error) {
        if (isDomainError(error) && error.code === 'INVALID_STATE') return null;
        throw error;
      }
    });
    if (outcome === undefined) return answer(ctx, ctx.locale.common.busy);
    if (outcome === null) {
      await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
      const photo = await services.photos.getDetails(photoId);
      const expired = photo?.status === 'CANCELLED';
      return answer(ctx, expired ? ctx.locale.submission.previewExpired : ctx.locale.common.alreadyProcessed, true);
    }

    const id = formatPhotoId(photoId);
    await answer(ctx);
    await ctx.editMessageCaption(ctx.locale.submission.previewConfirmed(id), { parse_mode: 'HTML' }).catch(() => undefined);
    const text = outcome.moderation ? ctx.locale.submission.acceptedModeration : ctx.locale.submission.accepted;
    const position = outcome.queuePosition ? `\n\n${ctx.locale.submission.queuePosition(outcome.queuePosition)}` : '';
    await showMainMenu(ctx, text + position);

    if (outcome.moderation) {
      await services.notifications.notifyAdminsWithPhoto(
        outcome.photo.fileId,
        ctx.locale.admin.newForModeration({ id, author: escapeHtml(ctx.from?.username ? `@${ctx.from.username}` : user.firstName) }),
        { parseMode: 'HTML', replyMarkup: moderationKeyboard(ctx.locale, photoId) },
      );
    }
  });

  bot.action(/^ph:no:(\d+)$/, async (ctx) => {
    const photoId = matchInt(ctx);
    try {
      await ctx.deps.services.photos.cancelDraft(photoId, currentUser(ctx).id);
    } catch (error) {
      if (isDomainError(error) && error.code === 'INVALID_STATE') {
        await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
        return answer(ctx, ctx.locale.common.alreadyProcessed, true);
      }
      if (await showError(ctx, error)) return;
      throw error;
    }
    setState(ctx, undefined);
    await answer(ctx);
    await ctx.editMessageCaption(ctx.locale.submission.previewCancelled(formatPhotoId(photoId))).catch(() => undefined);
    await showMainMenu(ctx, ctx.locale.submission.cancelledByUser);
  });
}
