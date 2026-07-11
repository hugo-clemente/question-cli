import {
  Client, GatewayIntentBits, Events, ChannelType, MessageFlags, PermissionFlagsBits,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  type Interaction, type Message, type SendableChannels, type User,
} from "discord.js";
import { randomUUID } from "node:crypto";
import {
  applyVote, applyDecision, applyOther, expire, isResolved, result,
  type PollState, type PollResult,
} from "./poll.ts";
import { renderAborted, renderMessage, renderResolved, parseCustomId } from "./render.ts";
import { createRenderQueue } from "./render-queue.ts";
import type { Config } from "./config.ts";

const RENDER_DEBOUNCE_MS = 800;
type RunResult = PollResult & { messageId: string; channelId: string };
type PermissionLike = { has(bit: bigint): boolean };
type PermissionedSendable = SendableChannels & {
  permissionsFor?: (target: unknown) => PermissionLike | null;
  isThread?: () => boolean;
};

const ephemeral = (content: string) => ({ content, flags: MessageFlags.Ephemeral as const });

function isSendableTextChannel(ch: unknown): ch is SendableChannels {
  return Boolean(
    ch &&
    typeof ch === "object" &&
    "isTextBased" in ch &&
    typeof ch.isTextBased === "function" &&
    ch.isTextBased() &&
    "send" in ch &&
    typeof ch.send === "function",
  );
}

function assertGuildChannel(ch: SendableChannels): void {
  if ("type" in ch && ((ch.type as ChannelType) === ChannelType.DM || (ch.type as ChannelType) === ChannelType.GroupDM)) {
    throw new Error("target must be a guild channel or thread, not a DM");
  }
  if (!("guild" in ch)) throw new Error("target must be a guild channel or thread");
}

function assertChannelPermissions(ch: SendableChannels, user: User): void {
  const c = ch as PermissionedSendable;
  const perms = c.permissionsFor?.(user);
  if (!perms) return;
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
  if (c.isThread?.()) required.push(PermissionFlagsBits.SendMessagesInThreads);
  const missing = required.filter((bit) => !perms.has(bit));
  if (missing.length > 0) throw new Error("bot is missing required channel permissions");
}

function hasRuntimePermissions(interaction: Interaction): boolean {
  return interaction.appPermissions.has(PermissionFlagsBits.ViewChannel) &&
    interaction.appPermissions.has(PermissionFlagsBits.SendMessages) &&
    interaction.appPermissions.has(PermissionFlagsBits.EmbedLinks);
}

export function runPoll(config: Config, token: string, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const now = () => Date.now();
    const pollId = randomUUID().slice(0, 8);
    const state: PollState = {
      pollId, question: config.question, ownerUserId: config.ownerUserId, status: "open", select: config.select,
      deadlineAt: 0, options: config.options,
      votes: {}, others: [], decision: null, decidedBy: null,
      startedAt: "", resolvedAt: null,
    };

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    let channel: SendableChannels | null = null;
    let message: Message | null = null;
    let deadlineTimer: NodeJS.Timeout | null = null;
    let closing = false;
    let completed = false;

    // ponytail: in-memory state only; crash mid-poll => re-run. Snapshot+--resume is the documented upgrade path.
    let mutationQueue = Promise.resolve();
    const enqueue = <T>(fn: () => T | Promise<T>): Promise<T> => {
      const run = mutationQueue.then(fn, fn);
      mutationQueue = run.then(() => undefined, () => undefined);
      return run;
    };

    const renderQueue = createRenderQueue(async () => {
      if (!message) return;
      try {
        const payload = closing || state.status !== "open" ? renderResolved(state) : renderMessage(state);
        await message.edit(payload as never);
      } catch (e) {
        fatal(e);
        throw e;
      }
    }, RENDER_DEBOUNCE_MS);

    const clearDeadline = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = null;
    };

    const fatal = (e: unknown) => {
      if (completed || closing) return;
      completed = true;
      closing = true;
      clearDeadline();
      renderQueue.cancel();
      signal?.removeEventListener("abort", onAbort);
      void client.destroy();
      reject(e instanceof Error ? e : new Error(String(e)));
    };

    const finishResolved = async () => {
      if (completed || closing) return;
      if (!message) return fatal(new Error("poll message was not posted"));
      closing = true;
      clearDeadline();
      renderQueue.cancel();
      try {
        await renderQueue.whenIdle();
      } catch {
        // Best-effort wait only. Still attempt the terminal cleanup edit.
      }
      try {
        await message.edit(renderResolved(state) as never);
      } catch {
        // Best-effort terminal cleanup only. A known decision still resolves.
      }
      completed = true;
      signal?.removeEventListener("abort", onAbort);
      const out = { ...result(state), messageId: message.id, channelId: config.channelId };
      await client.destroy();
      resolve(out);
    };

    const abortPoll = async () => {
      if (completed || closing) return;
      closing = true;
      clearDeadline();
      renderQueue.cancel();
      try {
        await renderQueue.whenIdle();
      } catch {
        // Best-effort wait only. Still attempt the aborted cleanup edit.
      }
      try {
        if (message) await message.edit(renderAborted(state) as never);
      } catch {
        // Best-effort cleanup only. The CLI still exits non-zero and prints no JSON.
      }
      completed = true;
      signal?.removeEventListener("abort", onAbort);
      await client.destroy();
      reject(new Error("interrupted"));
    };

    function onAbort() {
      void abortPoll();
    }

    client.once(Events.ClientReady, async () => {
      try {
        const ch = await client.channels.fetch(config.channelId);
        if (!isSendableTextChannel(ch)) throw new Error("channel is not a sendable text channel");
        assertGuildChannel(ch);
        assertChannelPermissions(ch, client.user!);
        channel = ch;
        const started = now();
        state.startedAt = new Date(started).toISOString();
        state.deadlineAt = started + config.deadlineMs;
        message = await channel.send(renderMessage(state) as never);
        deadlineTimer = setTimeout(() => {
          void enqueue(() => {
            if (completed || closing) return false;
            expire(state, now());
            return state.status === "expired";
          }).then((expired) => {
            if (expired) void finishResolved();
          }).catch(fatal);
        }, Math.max(0, state.deadlineAt - now()));
      } catch (e) {
        fatal(e);
      }
    });

    client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      const id = "customId" in interaction ? interaction.customId : "";
      const parsed = id ? parseCustomId(id) : null;
      if (!parsed || parsed.pollId !== pollId) return; // ignore other polls / stray interactions

      try {
        if (!interaction.isRepliable()) return;
        if (completed || closing) {
          await interaction.reply(ephemeral("This poll is closed."));
          return;
        }
        if (!hasRuntimePermissions(interaction)) {
          await interaction.reply(ephemeral("The bot no longer has the channel permissions needed for this poll."));
          return;
        }

        if (interaction.isStringSelectMenu() && parsed.kind === "vote") {
          if (isResolved(state, now())) {
            await interaction.reply(ephemeral("This poll is closed."));
            return;
          }
          await interaction.deferUpdate();
          const r = await enqueue(() => applyVote(state, interaction.user.id, interaction.values, now()));
          if (r.ok) renderQueue.schedule();
          else await interaction.followUp(ephemeral(`Vote not recorded: ${r.reason}`));
        } else if (interaction.isStringSelectMenu() && parsed.kind === "decide") {
          if (interaction.user.id !== config.ownerUserId) {
            await interaction.reply(ephemeral("Only the owner can decide this poll."));
            return;
          }
          if (isResolved(state, now())) {
            await interaction.reply(ephemeral("This poll is closed."));
            return;
          }
          const key = interaction.values[0]!;
          await interaction.deferUpdate();
          const r = await enqueue(() => applyDecision(state, interaction.user.id, key, now()));
          if (!r.ok) {
            await interaction.followUp(ephemeral(`Decision not recorded: ${r.reason}`));
            return;
          }
          await finishResolved();
        } else if (interaction.isButton() && parsed.kind === "other") {
          if (isResolved(state, now())) {
            await interaction.reply(ephemeral("This poll is closed."));
            return;
          }
          const modal = new ModalBuilder().setCustomId(`qcli:${pollId}:othermodal`).setTitle("Other answer")
            .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder().setCustomId("text").setLabel("Your answer (a note for the owner)")
                .setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)));
          await interaction.showModal(modal as never); // must be the initial response — never defer first
        } else if (interaction.isModalSubmit() && parsed.kind === "othermodal") {
          const text = interaction.fields.getTextInputValue("text");
          await interaction.deferReply({ ephemeral: true });
          const r = await runOther(interaction.user.id, text);
          if (r.ok) {
            if (!channel) throw new Error("channel unavailable");
            try {
              await channel.send({ content: `Other from <@${interaction.user.id}> on the poll: ${text}`, allowedMentions: { parse: [] } });
            } catch (e) {
              fatal(e);
              return;
            }
            renderQueue.schedule();
          }
          await interaction.editReply(r.ok ? "Noted." : `Not recorded: ${r.reason}`);
        }
      } catch (e) {
        console.error("interaction error:", e instanceof Error ? e.message : e);
      }
    });

    async function runOther(userId: string, text: string) {
      let r = { ok: false, reason: "unknown" } as ReturnType<typeof applyOther>;
      await enqueue(() => { r = applyOther(state, userId, text, now()); });
      return r;
    }

    if (signal?.aborted) {
      void abortPoll();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    client.login(token).catch(fatal);
  });
}
