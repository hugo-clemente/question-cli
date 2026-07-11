import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { tally, type PollState } from "./poll.ts";

type CustomIdKind = "vote" | "decide" | "other";
const EMBED_DESCRIPTION_MAX = 4096;

export function customId(pollId: string, kind: CustomIdKind): string {
  return `qcli:${pollId}:${kind}`;
}

export function parseCustomId(id: string): { pollId: string; kind: string } | null {
  const parts = id.split(":");
  if (parts.length !== 3 || parts[0] !== "qcli") return null;
  return { pollId: parts[1]!, kind: parts[2]! };
}

function embed(s: PollState, overrideStatus?: string): EmbedBuilder {
  const counts = tally(s);
  const lines = s.options.map((o) => {
    const description = o.description ? ` - ${o.description}` : "";
    return `**${o.key}.** ${o.label}${description} - \`${counts[o.key]!.length}\``;
  });
  const statusLine =
    overrideStatus ??
    (s.status === "decided"
      ? `Decided: ${s.decision} by <@${s.decidedBy}>`
      : s.status === "expired"
        ? "Expired - no decision"
        : `<@${s.ownerUserId}> decides - closes <t:${Math.floor(s.deadlineAt / 1000)}:R>`);

  const description = `${s.question}\n\n${lines.join("\n")}\n\n${statusLine}`;
  const cappedDescription = description.length > EMBED_DESCRIPTION_MAX
    ? `${description.slice(0, EMBED_DESCRIPTION_MAX - 3)}…`
    : description;

  return new EmbedBuilder().setDescription(cappedDescription);
}

function optionLabel(label: string): string {
  return label.slice(0, 100);
}

function ballotSelect(s: PollState): StringSelectMenuBuilder {
  return new StringSelectMenuBuilder()
    .setCustomId(customId(s.pollId, "vote"))
    .setPlaceholder("Vote...")
    .setMinValues(1)
    .setMaxValues(s.select === "multi" ? s.options.length : 1)
    .addOptions(
      s.options.map((o) => {
        const opt = new StringSelectMenuOptionBuilder().setLabel(optionLabel(o.label)).setValue(o.key);
        if (o.description) opt.setDescription(o.description.slice(0, 100));
        return opt;
      }),
    );
}

function decideSelect(s: PollState): StringSelectMenuBuilder {
  return new StringSelectMenuBuilder()
    .setCustomId(customId(s.pollId, "decide"))
    .setPlaceholder("Owner: decide...")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(s.options.map((o) => new StringSelectMenuOptionBuilder().setLabel(optionLabel(o.label)).setValue(o.key)));
}

function otherButton(s: PollState): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId(s.pollId, "other")).setLabel("Other...").setStyle(ButtonStyle.Secondary);
}

export function renderMessage(s: PollState): { embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] } {
  return {
    embeds: [embed(s)],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(ballotSelect(s)),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(decideSelect(s)),
      new ActionRowBuilder<ButtonBuilder>().addComponents(otherButton(s)),
    ],
  };
}

export function renderResolved(s: PollState): { embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] } {
  const m = renderMessage(s);
  for (const row of m.components) {
    for (const c of row.components) {
      c.setDisabled(true);
    }
  }
  return m;
}

export function renderAborted(s: PollState): { embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] } {
  const m = {
    embeds: [embed(s, "Interrupted - this local CLI run stopped before producing a result.")],
    components: renderMessage(s).components,
  };
  for (const row of m.components) {
    for (const c of row.components) {
      c.setDisabled(true);
    }
  }
  return m;
}
