 import dotenv from 'dotenv';

  if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
  }

class TrelloDatasource {
    constructor() {
    }

    async fetchTrelloLists() {
        try {
            const response = await fetch(`https://api.trello.com/1/boards/${process.env.TRELLO_NTM_BOARD_ID}/lists?key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`);
            const data = await response.json();
            return data.map((list: any) => ({ id: list.id, name: list.name }));
        }
        catch (error) {
            console.error('Error fetching Trello lists:', error);
            return [];
        }
    }

  async getAllCards() {
    try {
        const response = await fetch(`https://api.trello.com/1/boards/${process.env.TRELLO_NTM_BOARD_ID}/cards?key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`);
        const data = await response.json();
        return data;
        }
    catch (error) {
        console.error('Error fetching Trello cards:', error);
        return [];
    }
  }

  async addCard(date: string, title: string, description: string, status: string, comments: string, pointPerson?: string) {
    try {
        // First, get the list ID for the status
        const lists = await this.fetchTrelloLists();
        const list = lists.find((l: any) => l.name.toLowerCase() === status.toLowerCase());

        if (!list) {
            console.error(`List with status "${status}" not found. Available lists:`, lists.map((l: any) => l.name));
            return null;
        }

        // Create the card description combining date, description, and comments
        const assignedTo = pointPerson ? `**Assigned to:** ${pointPerson}\n\n` : '';
        const cardDescription = `**Date:** ${date}\n\n${assignedTo}**Notes/Resource Links:**\n${description}\n\n**Next Steps:**\n${comments}`;

        const response = await fetch(
            `https://api.trello.com/1/cards?key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    name: title,
                    desc: cardDescription,
                    idList: list.id,
                }),
            }
        );

        const data = await response.json();
        return data.id;
    } catch (error) {
        console.error('Error adding Trello card:', error);
        return null;
    }
  }

  async updateCard(cardId: string, date: string, title: string, description: string, status: string, comments: string, pointPerson?: string) {
    try {
        // Get the list ID for the status
        const lists = await this.fetchTrelloLists();
        const list = lists.find((l: any) => l.name.toLowerCase() === status.toLowerCase());

        if (!list) {
            console.error(`List with status "${status}" not found. Available lists:`, lists.map((l: any) => l.name));
            return false;
        }

        // Create the card description combining date, description, and comments
        const assignedTo = pointPerson ? `**Assigned to:** ${pointPerson}\n\n` : '';
        const cardDescription = `**Date:** ${date}\n\n${assignedTo}**Notes/Resource Links:**\n${description}\n\n**Next Steps:**\n${comments}`;

        // Update card name, description, and list (status)
        const response = await fetch(
            `https://api.trello.com/1/cards/${cardId}?key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`,
            {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    name: title,
                    desc: cardDescription,
                    idList: list.id,
                }),
            }
        );

        if (!response.ok) {
            console.error('Failed to update Trello card:', await response.text());
            return false;
        }

        return true;
    } catch (error) {
        console.error('Error updating Trello card:', error);
        return false;
    }
  }
}

export const trelloDatasource = new TrelloDatasource();