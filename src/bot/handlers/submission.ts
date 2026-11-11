import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { Message } from 'telegraf/types';
import type { Battle } from '../../generated/prisma/client.js';
import { allTranslations } from '../../i18n/index.js';
import { DomainError, isDomainError } from '../../lib/errors.js';
import { escapeHtml, formatDateTime, formatPhotoId } from '../../lib/format.js';
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

export type MediaMessage = Message.PhotoMessage | Message.DocumentMessage | Message.VideoMessage;

function battleStart(ctx: BotContext, battle: Battle): string {
  return formatDateTime(battle.startsAt, ctx.deps.env.TIMEZONE, ctx.locale.intl);
}

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
  await ctx.reply(ctx.locale.submission.prompt({ battle: escapeHtml(battle.title), start: battleStart(ctx, battle) }), {
    parse_mode: 'HTML',
    reply_markup: inline([[button(ctx.locale.common.cancel, 'sub:cancel')]]),
  });
}

interface IncomingMedia {
  kind: 'photo' | 'image-file' | 'video';
  fileId: string;
  fileUniqueId: string;
  declaredSize?: number | undefined;
  video?: { width: number; height: number; duration: number; mimeType: string };
}

export function extractMedia(msg: MediaMessage): IncomingMedia | null {
  if ('photo' in msg) {
    const largest = msg.photo.at(-1);
    return largest ? { kind: 'photo', fileId: largest.file_id, fileUniqueId: largest.file_unique_id, declaredSize: largest.file_size } : null;
  }
  if ('video' in msg) {
    const v = msg.video;
    return {
      kind: 'video',
      fileId: v.file_id,
      fileUniqueId: v.file_unique_id,
      declaredSize: v.file_size,
      video: { width: v.width, height: v.height, duration: v.duration, mimeType: v.mime_type ?? 'video/mp4' },
    };
  }
  const doc = msg.document;
  if (!doc.mime_type || !(SUPPORTED_MIME_TYPES as readonly string[]).includes(doc.mime_type)) return null;
  return { kind: 'image-file', fileId: doc.file_id, fileUniqueId: doc.file_unique_id, declaredSize: doc.file_size };
}

/** Validates the file and builds the draft; images are downloaded and fully decoded. */
export async function prepareDraft(ctx: BotContext, media: IncomingMedia): Promise<{ input: DraftInput; upload: Buffer | null }> {
  const { env, gateway } = ctx.deps;
  if (media.kind === 'video' && media.video) {
    if (media.video.duration > env.MAX_VIDEO_DURATION_SECONDS) throw new DomainError('VIDEO_TOO_LONG', { max: env.MAX_VIDEO_DURATION_SECONDS });
    return {
      upload: null,
      input: {
        mediaType: 'VIDEO',
        source: 'VIDEO',
        fileId: media.fileId,
        fileUniqueId: media.fileUniqueId,
        // Videos are not downloaded (they may exceed the Bot API download limit); Telegram's unique id identifies the file.
        contentHash: `video:${media.fileUniqueId}`,
        mimeType: media.video.mimeType,
        width: media.video.width,
        height: media.video.height,
        fileSize: media.declaredSize ?? 0,
        durationSec: media.video.duration,
      },
    };
  }
  const maxBytes = env.MAX_PHOTO_SIZE_MB * 1024 * 1024;
  if (media.declaredSize !== undefined && media.declaredSize > maxBytes) throw new DomainError('FILE_TOO_LARGE', { maxMb: env.MAX_PHOTO_SIZE_MB });
  const buffer = await gateway.downloadFile(media.fileId, maxBytes);
  const validated = await validateImage(buffer, { maxBytes, minDimension: env.MIN_PHOTO_DIMENSION, maxDimension: env.MAX_PHOTO_DIMENSION });
  return {
    upload: media.kind === 'image-file' ? await normalizeForTelegramPhoto(buffer) : null,
    input: {
      mediaType: 'PHOTO',
      source: media.kind === 'image-file' ? 'DOCUMENT' : 'PHOTO',
      fileId: media.fileId,
      fileUniqueId: media.fileUniqueId,
      contentHash: validated.contentHash,
      mimeType: validated.mimeType,
      width: validated.width,
      height: validated.height,
      fileSize: validated.size,
    },
  };
}

async function handleIncomingMedia(ctx: BotContext, msg: MediaMessage): Promise<void> {
  const { locks, services } = ctx.deps;
  const user = currentUser(ctx);

  // Albums: only the first item is processed.
  if (msg.media_group_id) {
    if (!(await locks.acquire(`album:${msg.media_group_id}`, ALBUM_LOCK_MS))) return;
    await ctx.reply(ctx.locale.submission.onlyOne);
  }
  const media = extractMedia(msg);
  if (!media) {
    await ctx.reply(ctx.locale.submission.notMedia);
    return;
  }
  if (!user.consentAt) {
    await askConsent(ctx);
    return;
  }

  // A bought place in the final: this media is the buyer's work for the final.
  if (await services.finalSpots.openSpot(user.id)) {
    const done = await locks.withLock(`intake:${user.id}`, INTAKE_LOCK_MS, async () => {
      const progress = await ctx.reply(ctx.locale.submission.processing);
      try {
        const { input, upload } = await prepareDraft(ctx, media);
        if (upload) {
          // Image files are re-uploaded as photos so they can be published in a collage.
          const sent = await ctx.replyWithPhoto({ source: upload, filename: 'final.jpg' });
          input.fileId = sent.photo.at(-1)?.file_id ?? input.fileId;
        }
        await services.finalSpots.attachPhoto(user, input);
      } finally {
        await ctx.deleteMessage(progress.message_id).catch(() => undefined);
      }
      return true;
    });
    if (done === undefined) await ctx.reply(ctx.locale.common.busy);
    else await ctx.reply(ctx.locale.finalSpot.photoAccepted);
    setState(ctx, undefined);
    return;
  }

  const result = await locks.withLock(`intake:${user.id}`, INTAKE_LOCK_MS, async () => {
    const battle = await services.photos.assertCanSubmit(user);
    const progress = await ctx.reply(ctx.locale.submission.processing);
    try {
      const { input, upload } = await prepareDraft(ctx, media);
      const draft = await services.photos.createDraft(user, input);
      try {
        const settings = await services.settings.get();
        const id = formatPhotoId(draft.id);
        const extra = {
          caption: ctx.locale.submission.previewCaption({ id, battle: escapeHtml(battle.title), start: battleStart(ctx, battle), moderation: settings.moderationEnabled }),
          parse_mode: 'HTML' as const,
          reply_markup: inline([[button(ctx.locale.submission.confirm, `ph:ok:${draft.id}`), button(ctx.locale.submission.cancel, `ph:no:${draft.id}`)]]),
        };
        if (input.mediaType === 'VIDEO') {
          const preview = await ctx.replyWithVideo(input.fileId, extra);
          await services.photos.attachPreview(draft.id, preview.message_id);
        } else {
          const preview = await ctx.replyWithPhoto(upload ? { source: upload, filename: `${id}.jpg` } : input.fileId, extra);
          // Image files are re-uploaded as photos; the resulting photo file_id is what gets published.
          await services.photos.attachPreview(draft.id, preview.message_id, upload ? preview.photo.at(-1)?.file_id : undefined);
        }
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

  bot.on(message('photo'), (ctx) => handleIncomingMedia(ctx, ctx.message));
  bot.on(message('video'), (ctx) => handleIncomingMedia(ctx, ctx.message));
  bot.on(message('document'), (ctx) => handleIncomingMedia(ctx, ctx.message));

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
      return answer(ctx, photo?.status === 'CANCELLED' ? ctx.locale.submission.previewExpired : ctx.locale.common.alreadyProcessed, true);
    }

    const id = formatPhotoId(photoId);
    await answer(ctx);
    await ctx.editMessageCaption(ctx.locale.submission.previewConfirmed(id), { parse_mode: 'HTML' }).catch(() => undefined);
    const info = { battle: escapeHtml(outcome.battle.title), start: battleStart(ctx, outcome.battle) };
    await showMainMenu(ctx, outcome.moderation ? ctx.locale.submission.acceptedModeration(info) : ctx.locale.submission.accepted(info));

    if (outcome.moderation) {
      const author = escapeHtml(ctx.from?.username ? `@${ctx.from.username}` : user.firstName);
      const fileId = outcome.photo.mediaType === 'PHOTO' ? outcome.photo.fileId : null;
      const text = (l: typeof ctx.locale) => l.admin.newForModeration({ id, author });
      if (fileId) {
        await services.notifications.notifyAdminsWithPhoto(fileId, text, (l) => ({ parseMode: 'HTML', replyMarkup: moderationKeyboard(l, photoId) }));
      } else {
        await services.notifications.notifyAdmins(text, { parseMode: 'HTML', replyMarkup: moderationKeyboard(ctx.locale, photoId) });
      }
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
