export type ListedUser = {
  id: string;
  username: string;
  globalName: string | null;
};

interface DiscordMember {
  user: {
    id: string;
    username: string;
    global_name: string | null;
  };
}

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
}

class DiscordController {
  private baseUrl = 'https://discord.com/api/v10';
  private cachedGuildId: string | null = null;

  // The bot token resolves through the credential table, so it is fetched on
  // first use rather than in the constructor.
  private async getToken(): Promise<string> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      throw new Error("Missing env var DISCORD_BOT_TOKEN");
    }
    return token;
  }

  private async fetchGuildId(): Promise<string> {
    // Return cached value if available
    if (this.cachedGuildId) {
      return this.cachedGuildId;
    }

    // Fetch all guilds the bot is in
    const guilds = await this.fetchDiscord('/users/@me/guilds');

    if (!guilds || guilds.length === 0) {
      throw new Error("Bot is not in any guild (server).");
    }

    // Cache the first guild ID
    const guildId = guilds[0].id;
    this.cachedGuildId = guildId;
    return guildId;
  }

  private async fetchDiscord(endpoint: string, options: RequestInit = {}) {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        'Authorization': `Bot ${await this.getToken()}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Discord API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  public async listAllMembers(): Promise<ListedUser[]> {
    const guildId = await this.fetchGuildId();
    let allMembers: DiscordMember[] = [];
    let after = '0';

    // Discord API returns max 1000 members per request
    while (true) {
      const members: DiscordMember[] = await this.fetchDiscord(
        `/guilds/${guildId}/members?limit=1000&after=${after}`
      );

      if (members.length === 0) break;

      allMembers = allMembers.concat(members);
      after = members[members.length - 1].user.id;

      if (members.length < 1000) break;
    }

    return allMembers.map((m) => ({
      id: m.user.id,
      username: m.user.username,
      globalName: m.user.global_name ?? null,
    }));
  }

  public async findMemberByName(name: string): Promise<ListedUser | null> {
    const guildId = await this.fetchGuildId();
    // Search for members by username
    const members: DiscordMember[] = await this.fetchDiscord(
      `/guilds/${guildId}/members/search?query=${encodeURIComponent(name)}&limit=10`
    );

    if (members.length === 0) {
      return null;
    }

    if (members.length > 1) {
      // Check for exact match
      const exactMatch = members.find(
        m => m.user.username.toLowerCase() === name.toLowerCase() ||
             m.user.global_name?.toLowerCase() === name.toLowerCase()
      );

      if (!exactMatch) {
        throw new Error("Multiple members found with the same name.");
      }

      return {
        id: exactMatch.user.id,
        username: exactMatch.user.username,
        globalName: exactMatch.user.global_name ?? null,
      };
    }

    const member = members[0];
    return {
      id: member.user.id,
      username: member.user.username,
      globalName: member.user.global_name ?? null,
    };
  }

  public async messageUser(userId: string, message: string): Promise<void> {
    // Create a DM channel with the user
    const dmChannel = await this.fetchDiscord('/users/@me/channels', {
      method: 'POST',
      body: JSON.stringify({
        recipient_id: userId,
      }),
    });

    // Send the message
    await this.fetchDiscord(`/channels/${dmChannel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: message,
      }),
    });
  }

  public async messageChannel(channelName: string, message: string): Promise<void> {
    const guildId = await this.fetchGuildId();

    // Get all channels in the guild
    const channels: DiscordChannel[] = await this.fetchDiscord(
      `/guilds/${guildId}/channels`
    );

    // Find the channel by name
    const channel = channels.find(c => c.name === channelName && c.type === 0);

    if (!channel) {
      throw new Error(`Channel "${channelName}" not found.`);
    }

    // Send the message to the channel
    await this.fetchDiscord(`/channels/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: message,
      }),
    });
  }

  public async generateGuildInviteLink(): Promise<string> {
    const guildId = await this.fetchGuildId();
    // Get all channels in the guild
    const channels: DiscordChannel[] = await this.fetchDiscord(
      `/guilds/${guildId}/channels`
    );

    // Find the welcome channel (type 0 is text channel)
    const welcomeChannel = channels.find(
      c => c.type === 0 && c.name === 'welcome'
    );

    if (!welcomeChannel) {
      throw new Error("Welcome channel not found.");
    }

    // Create invite for the welcome channel
    const invite = await this.fetchDiscord(
      `/channels/${welcomeChannel.id}/invites`,
      {
        method: 'POST',
        body: JSON.stringify({
          max_uses: 1,
          max_age: 86400, // 24 hours
          unique: true,
        }),
      }
    );

    return `https://discord.gg/${invite.code}`;
  }

  public async deleteMember(userId: string): Promise<void> {
    const guildId = await this.fetchGuildId();
    await this.fetchDiscord(
      `/guilds/${guildId}/members/${userId}`,
      {
        method: 'DELETE',
      }
    );
  }
}

export const discordController = new DiscordController();
