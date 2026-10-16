import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTeams, teamsPrompt, parseChatId } from "./teams.mjs";

const config = { team: "Engineering", channel: "Backend", personalMentions: true, tags: ["On-call"], includeReplies: true, lookbackHours: 24 };

test("Teams settings normalize names and tags and allow tag-only monitoring", () => {
  assert.deepEqual(validateTeams({ ...config, team: " Engineering ", tags: ["@On-call", "on-CALL", " Backend "] }), { ...config, source: "channel", tags: ["on-CALL", "Backend"] });
  assert.equal(validateTeams({ ...config, personalMentions: false }).personalMentions, false);
  assert.deepEqual(validateTeams({ ...config, tags: [] }).tags, []);
});

const chatId = "19:4ec3e29b31704ecd9c85f1f8503c9f9e@thread.v2";
const chatLink = `https://teams.microsoft.com/l/chat/${chatId}/conversations?context=%7B%22contextType%22%3A%22chat%22%7D`;

test("group-chat links and raw IDs normalize to the exact chat ID", () => {
  assert.equal(parseChatId(chatLink), chatId);
  assert.equal(parseChatId(` ${chatId} `), chatId);
  assert.equal(parseChatId(`https://teams.microsoft.com/l/chat/${encodeURIComponent(chatId)}/conversations`), chatId);
  for (const input of ["Guest Services Support", "", null, chatLink.replace("teams.microsoft.com", "example.com"), chatLink.replace("/l/chat/", "/l/channel/"), "https://teams.microsoft.com/l/chat/%ZZ/conversations"]) assert.throws(() => parseChatId(input), /group-chat link or chat ID/);
});

test("group-chat monitors need no team or channel and remain scoped to the supplied ID", () => {
  const chat = validateTeams({ source: "chat", chatName: "(GSS) Guest Services Support", chatId: chatLink, personalMentions: true, tags: [], includeReplies: true, lookbackHours: 24 });
  assert.equal(chat.chatId, chatId);
  assert.equal(chat.source, "chat");
  assert.equal(chat.team, undefined);
  const prompt = teamsPrompt(chat);
  assert.match(prompt, /read-only snapshot/);
  assert.ok(prompt.includes(chatId));
  assert.match(prompt, /Use the provided key and direct URL exactly/);
  assert.doesNotMatch(prompt, /Resolve exactly the configured team and channel/);
  for (const patch of [{ chatName: "" }, { source: "other" }, { tags: ["Engineering"] }, { personalMentions: false }]) assert.throws(() => validateTeams({ ...chat, ...patch }));
});

test("Teams settings reject missing channels, invalid filters, and unbounded lookback", () => {
  for (const value of [null, [], "Teams"]) assert.throws(() => validateTeams(value), /object/);
  for (const patch of [
    { team: " " }, { channel: "" }, { personalMentions: "true" }, { includeReplies: 1 },
    { tags: "On-call" }, { tags: [null] }, { tags: ["@ "] }, { tags: Array(31).fill("a") },
    { personalMentions: false, tags: [] }, { lookbackHours: 0 }, { lookbackHours: 169 }, { lookbackHours: 1.5 },
  ]) assert.throws(() => validateTeams({ ...config, ...patch }));
});

test("Teams prompt uses only the Mac snapshot and preserves unresolved context", () => {
  const previous = [{ key: "teams:t:c:123", title: "Review deployment", history: ["private action history"] }];
  const snapshot = { source: "mac-teams-cache", messages: [{ key: "teams:t:c:123", text: "Please review", mentionedSelf: true }] };
  const prompt = teamsPrompt(config, { previous, snapshot });
  assert.ok(prompt.includes(JSON.stringify(snapshot)));
  assert.match(prompt, /Only messages with mentionedSelf=true/);
  assert.match(prompt, /teams:t:c:123/);
  assert.doesNotMatch(prompt, /private action history/);
  assert.match(prompt, /Do not use Microsoft 365 connectors/);
  assert.match(prompt, /Never claim complete live coverage/);
  assert.match(prompt, /For missingPreviousKeys, retain/);
});
