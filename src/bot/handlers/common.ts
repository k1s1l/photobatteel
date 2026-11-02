import type { Telegraf } from 'telegraf';
import { allTranslations, getLocale, isSupportedLanguage, SUPPORTED_LANGUAGES } from '../../i18n/index.js';
import type { BotContext } from '../context.js';
import { getState, setState } from '../context.js';
import { answer } from '../helpers.js';
import { button, inline, mainMenu, NOOP } from '../keyboards.js';
import { currentUser } from '../context.js';
import { showVotesMenu } from './payments.js';

export async function showMainMenu(ctx: BotContext, text: string): Promise<void> {
  await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...mainMenu(ctx.locale, ctx.isAdmin) });
}

export function registerCommonHandlers(bot: Telegraf<BotContext>): void {
  bot.start(async (ctx) => {
    setState(ctx, undefined);
    await showMainMenu(ctx, ctx.locale.start.welcome);
    // Deep link from the "⭐ +1 vote" button: t.me/<bot>?start=boost_<photoId>
    const boost = /^boost_(\d{1,9})$/.exec(ctx.payload ?? '');
    if (boost?.[1]) await showVotesMenu(ctx, Number(boost[1]));
  });

  bot.command('menu', async (ctx) => {
    setState(ctx, undefined);
    await showMainMenu(ctx, ctx.locale.common.useMenu);
  });

  bot.command('cancel', async (ctx) => {
    const hadState = !!getState(ctx);
    setState(ctx, undefined);
    await showMainMenu(ctx, hadState ? ctx.locale.common.cancelled : ctx.locale.common.useMenu);
  });

  const showRules = async (ctx: BotContext) => {
    const settings = await ctx.deps.services.settings.get();
    await ctx.reply(
      ctx.locale.rules.text({
        maxPerDay: settings.maxPhotosPerDay,
        maxSizeMb: ctx.deps.env.MAX_PHOTO_SIZE_MB,
        minSide: ctx.deps.env.MIN_PHOTO_DIMENSION,
        moderation: settings.moderationEnabled,
      }),
      { parse_mode: 'HTML' },
    );
  };
  bot.command('rules', showRules);
  bot.hears(allTranslations((l) => l.menu.rules), showRules);

  const showHelp = (ctx: BotContext) => ctx.reply(ctx.locale.help.text, { parse_mode: 'HTML' });
  bot.help(showHelp);
  bot.hears(allTranslations((l) => l.menu.help), showHelp);

  const chooseLanguage = (ctx: BotContext) =>
    ctx.reply(ctx.locale.language.choose, {
      reply_markup: inline([SUPPORTED_LANGUAGES.map((code) => button(getLocale(code).languageName, `lang:${code}`))]),
    });
  bot.command('language', chooseLanguage);
  bot.hears(allTranslations((l) => l.menu.language), chooseLanguage);

  bot.action(/^lang:(\w+)$/, async (ctx) => {
    const code = ctx.match[1];
    if (!isSupportedLanguage(code)) return answer(ctx);
    ctx.user = await ctx.deps.services.users.setLanguage(currentUser(ctx).id, code);
    ctx.locale = getLocale(code);
    await answer(ctx);
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    await showMainMenu(ctx, ctx.locale.language.changed);
  });

  bot.action(NOOP, (ctx) => answer(ctx));
}

/** Last handler: anything not understood gets a hint and the menu. */
export function registerFallback(bot: Telegraf<BotContext>): void {
  bot.on('message', async (ctx) => {
    const state = getState(ctx);
    if (state?.kind === 'awaiting_photo') {
      await ctx.reply(ctx.locale.submission.notAnImage);
      return;
    }
    await showMainMenu(ctx, ctx.locale.common.useMenu);
  });
  bot.on('callback_query', (ctx) => answer(ctx, ctx.locale.common.alreadyProcessed));
}
