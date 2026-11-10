import { beforeEach, describe, expect, it } from 'vitest';
import type { Duel, User } from '../../src/generated/prisma/client.js';
import { createEntry, createTestContext, createUser, openBattle, postPendingDuels, startBattle, type TestContext } from '../helpers/context.js';

let ctx: TestContext;
let duel: Duel;
let authorA: User;
let voter: User;

beforeEach(async () => {
  ctx = await createTestContext();
  const battle = await openBattle(ctx);
  authorA = await createUser(ctx);
  const entryA = await createEntry(ctx, authorA);
  const authorB = await createUser(ctx);
  const entryB = await createEntry(ctx, authorB);
  await startBattle(ctx, battle.id);
  await postPendingDuels(ctx);
  duel = await ctx.prisma.duel.findFirstOrThrow();
  // Pairing is random: make sure "authorA" is the author of side A.
  if (duel.photoAId !== entryA.id) {
    authorA = authorB;
    void entryB;
  }
  voter = await createUser(ctx);
});

describe('free votes in duels', () => {
  it('counts one vote, moves it to the other side and withdraws it', async () => {
    expect(await ctx.services.duelVotes.vote(duel.id, 0, 'A', voter)).toEqual({ side: 'A', votesA: 1, votesB: 0, votesC: 0, votesD: 0, votesE: 0, votesF: 0 });
    expect(await ctx.services.duelVotes.vote(duel.id, 0, 'B', voter)).toEqual({ side: 'B', votesA: 0, votesB: 1, votesC: 0, votesD: 0, votesE: 0, votesF: 0 });
    expect(await ctx.services.duelVotes.vote(duel.id, 0, 'B', voter)).toEqual({ side: null, votesA: 0, votesB: 0, votesC: 0, votesD: 0, votesE: 0, votesF: 0 });
    expect(await ctx.prisma.duelVote.count()).toBe(0);
    expect(ctx.scheduler.voteRefreshes).toEqual([duel.id, duel.id, duel.id]);
  });

  it('only lets channel subscribers vote (when enabled)', async () => {
    ctx.telegram.nonMembers.add(Number(voter.telegramId));
    await expect(ctx.services.duelVotes.vote(duel.id, 0, 'A', voter)).rejects.toMatchObject({ code: 'NOT_SUBSCRIBED' });
    await ctx.services.settings.update({ subscribersOnly: false }, null);
    await expect(ctx.services.duelVotes.vote(duel.id, 0, 'A', voter)).resolves.toMatchObject({ votesA: 1 });
  });

  it('forbids voting for your own entry', async () => {
    await expect(ctx.services.duelVotes.vote(duel.id, 0, 'A', authorA)).rejects.toMatchObject({ code: 'SELF_VOTE' });
  });

  it('rejects votes for a closed duel or an old stage', async () => {
    await expect(ctx.services.duelVotes.vote(duel.id, 1, 'A', voter)).rejects.toMatchObject({ code: 'VOTING_CLOSED' });
    await ctx.prisma.duel.update({ where: { id: duel.id }, data: { endsAt: new Date(Date.now() - 1000) } });
    await expect(ctx.services.duelVotes.vote(duel.id, 0, 'A', voter)).rejects.toMatchObject({ code: 'VOTING_CLOSED' });
  });

  it('counts concurrent presses of the same user once', async () => {
    await Promise.allSettled([1, 2, 3].map(() => ctx.services.duelVotes.vote(duel.id, 0, 'A', voter)));
    const fresh = await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } });
    expect(fresh.votesA).toBe(await ctx.prisma.duelVote.count({ where: { side: 'A' } }));
    expect(fresh.votesA).toBeLessThanOrEqual(1);
  });

  it('updates the counters on the channel buttons', async () => {
    await ctx.services.duelVotes.vote(duel.id, 0, 'B', voter);
    await ctx.services.battles.refreshButtons(duel.id);
    expect(JSON.stringify(ctx.telegram.callsOf('editMessageReplyMarkup').at(-1)?.args[1])).toContain('Поддержать 2 · 1');
  });
});
