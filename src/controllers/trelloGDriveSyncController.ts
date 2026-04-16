
import {trelloDatasource} from '../datasources/trelloDatasource.js'
import {gDriveDatasource} from '../datasources/gDriveDatasource.js';

type TaskRow = {
  date: string;
  item: string;
  notesResourceLinks: string;
  pointPerson: string;
  status: string;
  nextSteps: string;
  trelloCardId?: string;
  state?: 'unchanged' | 'new' | 'updated' | 'deleted';
};


class TrelloGDriveSyncController {

    private oldTrelloData: any[];
    private oldGDriveData: TaskRow[];

    constructor() {
        this.oldTrelloData = [];
        this.oldGDriveData = [];
    }

    async syncGdriveWithTrello() {
        const gDriveChanges = await this.getGDriveData();
        await this.addOrUpdateTrelloCards(gDriveChanges);

        // Now sync from Trello back to Google Sheet
        const trelloCards = await this.getTrelloTasks();
        await this.syncTrelloToGDrive(trelloCards);

        // Re-read Google Sheet data to update oldGDriveData with any changes made by syncTrelloToGDrive
        const sheetDataRaw = await gDriveDatasource.readFile();
        this.oldGDriveData = this.mapSheetData(sheetDataRaw);
    }

    private async getTrelloTasks(){
        const lists = await trelloDatasource.fetchTrelloLists();
        // console.log('Trello lists:', lists);
        const data = await trelloDatasource.getAllCards();
        let cards = data.map((card: any) => ({ id: card.id, name: card.name, description: card.desc, status: card.idList, labels: card.labels }));
        cards = cards.map((card: any) => {
            const list = lists.find((list: any) => list.id === card.status);
            card.labels = card.labels.map((label: any) => label.name);
            return { ...card, status: list ? list.name : 'Unknown' };
        });
        cards = cards.filter((card: any) => card.status !== 'Done' && card.status !== 'Archive' && card.status !== 'Backlog');
        // console.log('Trello cards:', cards);
        return cards;
    }

    private async syncTrelloToGDrive(trelloCards: any[]) {
        // Read fresh Google Sheet data
        const sheetDataRaw = await gDriveDatasource.readFile();
        const sheetData = this.mapSheetData(sheetDataRaw);

        // Create a map of sheet rows by trelloCardId
        const sheetByCardId = new Map<string, TaskRow>();
        sheetData.forEach(row => {
            if (row.trelloCardId && row.trelloCardId.trim() !== '') {
                sheetByCardId.set(row.trelloCardId, row);
            }
        });

        // Create a set of Trello card IDs for quick lookup
        const trelloCardIds = new Set(trelloCards.map(card => card.id));

        // Process each Trello card
        for (const card of trelloCards) {
            const sheetRow = sheetByCardId.get(card.id);

            if (sheetRow) {
                // Check if any field changed (only update item and status)
                const statusLowerCase = card.status.toLowerCase();
                const hasChanges =
                    sheetRow.item !== card.name ||
                    sheetRow.status !== statusLowerCase;

                if (hasChanges) {
                    console.log(`Updating Google Sheet row for card: ${card.name}`);
                    await gDriveDatasource.updateRowByCardId(
                        card.id,
                        sheetRow.date, // Keep existing date
                        card.name,
                        sheetRow.notesResourceLinks, // Keep existing notesResourceLinks
                        sheetRow.pointPerson, // Keep existing pointPerson
                        statusLowerCase,
                        sheetRow.nextSteps // Keep existing nextSteps
                    );
                }
                // Mark this card as processed
                sheetByCardId.delete(card.id);
            } else {
                // Add new row to Google Sheet - assign to Jeldrik
                console.log(`Adding new row to Google Sheet for card: ${card.name}`);
                await gDriveDatasource.addRow(
                    '', // Empty date for new rows
                    card.name,
                    '', // Empty notesResourceLinks for new rows
                    'Jeldrik', // New tasks always assigned to Jeldrik
                    card.status.toLowerCase(),
                    '', // Empty nextSteps for new rows
                    card.id
                );
            }
        }

        // Delete rows from Google Sheet for cards that are no longer in Trello (moved to Backlog/Archive or archived)
        for (const [cardId, sheetRow] of sheetByCardId) {
            if (!trelloCardIds.has(cardId)) {
                console.log(`Deleting Google Sheet row for card that was archived/moved to Backlog: ${sheetRow.item}`);
                await gDriveDatasource.deleteRowByCardId(cardId);
            }
        }
    }

    private async addOrUpdateTrelloCards(tasks: TaskRow[]) {
        for (const task of tasks) {
            if (task.state === 'new') {
                console.log('Adding card to Trello:', task.item, 'Status:', task.status);
                const cardId = await trelloDatasource.addCard(
                    task.date,
                    task.item,
                    task.notesResourceLinks,
                    task.status,
                    task.nextSteps,
                    task.pointPerson
                );
                console.log('Card created, returned data:', cardId);
                if (cardId) {
                    console.log('Updating Google Sheet with card ID:', cardId, 'for item:', task.item);
                    const updated = await gDriveDatasource.updateCardId(task.item, cardId);
                    console.log('Update result:', updated);

                    // Update oldGDriveData with the new trelloCardId
                    const oldDataIndex = this.oldGDriveData.findIndex(row => row.item === task.item);
                    if (oldDataIndex !== -1) {
                        this.oldGDriveData[oldDataIndex].trelloCardId = cardId;
                    }
                } else {
                    console.log('No card ID returned from Trello');
                }
            } else if (task.state === 'updated') {
                console.log('Updating card in Trello:', task.item, 'Status:', task.status);
                if (!task.trelloCardId || task.trelloCardId.trim() === '') {
                    console.log('Cannot update card - no Trello card ID found for:', task.item);
                    continue;
                }
                const updated = await trelloDatasource.updateCard(
                    task.trelloCardId,
                    task.date,
                    task.item,
                    task.notesResourceLinks,
                    task.status,
                    task.nextSteps,
                    task.pointPerson
                );
                console.log('Update result:', updated);
            } else if (task.state === 'deleted') {
                console.log('Archiving card in Trello:', task.item);
                if (!task.trelloCardId || task.trelloCardId.trim() === '') {
                    console.log('Cannot archive card - no Trello card ID found for:', task.item);
                    continue;
                }
                const archived = await trelloDatasource.archiveCard(
                    task.trelloCardId
                );
                console.log('Archive result:', archived);
            }
        }
    }

    private async getGDriveData() {
        const data = await gDriveDatasource.readFile();
        const mappedData = this.mapSheetData(data);

        if (this.oldGDriveData.length > 0) {
            const changes = this.compareGDriveData(this.oldGDriveData, mappedData);
            this.oldGDriveData = mappedData;
            console.log('Google Drive data changes:', changes);
            return changes;
        }

        this.oldGDriveData = mappedData;
        return mappedData
            .filter(row => row.status !== "done" && (!row.trelloCardId || row.trelloCardId.trim() === ''))
            .map(row => ({ ...row, state: 'new' as const }));
    }

    private compareGDriveData(oldData: TaskRow[], newData: TaskRow[]): TaskRow[] {
        const changes: TaskRow[] = [];
        const fieldsToCompare: (keyof TaskRow)[] = ['item', 'notesResourceLinks', 'status', 'nextSteps'];

        // Create maps of old data by trelloCardId and by item (for rows without cardId)
        const oldDataByCardId = new Map<string, TaskRow>();
        const oldDataByItem = new Map<string, TaskRow>();

        oldData.forEach(row => {
            if (row.trelloCardId && row.trelloCardId.trim() !== '') {
                oldDataByCardId.set(row.trelloCardId, row);
            } else {
                oldDataByItem.set(row.item, row);
            }
        });

        // Check for new and updated items
        newData.forEach(newRow => {
            let oldRow: TaskRow | undefined;

            // First try to match by trelloCardId if it exists
            if (newRow.trelloCardId && newRow.trelloCardId.trim() !== '') {
                oldRow = oldDataByCardId.get(newRow.trelloCardId);
                if (oldRow) {
                    oldDataByCardId.delete(newRow.trelloCardId);
                }
            } else {
                // If no cardId, match by item name
                oldRow = oldDataByItem.get(newRow.item);
                if (oldRow) {
                    oldDataByItem.delete(newRow.item);
                }
            }

            if (!oldRow) {
                // Mark as new - either no match found, or it's a copy-paste scenario
                changes.push({ ...newRow, state: 'new' });
            } else {
                // Check if any field changed
                const hasChanges = fieldsToCompare.some(field => {
                    return newRow[field] !== oldRow[field];
                });

                if (hasChanges && newRow.trelloCardId && newRow.trelloCardId.trim() !== '') {
                    changes.push({ ...newRow, state: 'updated' });
                }
            }
        });

        // Remaining items in both maps are deleted
        oldDataByCardId.forEach(deletedRow => {
            changes.push({ ...deletedRow, state: 'deleted' });
        });
        oldDataByItem.forEach(deletedRow => {
            // Only mark as deleted if it had a cardId (was synced to Trello)
            if (deletedRow.trelloCardId && deletedRow.trelloCardId.trim() !== '') {
                changes.push({ ...deletedRow, state: 'deleted' });
            }
        });

        return changes;
    }

    private normalizeKey(key: string): string {
        return key
            .trim()
            .replace(/[^\w\s/.-]+/g, "")
            .split(/[\s/._-]+/)
            .filter(Boolean)
            .map((part, index) =>
            index === 0
                ? part.toLowerCase()
                : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
            )
            .join("");
    }
    private mapSheetData(rows: string[][]): TaskRow[] {
        if (!Array.isArray(rows) || rows.length === 0) return [];

        const [rawHeaders, ...dataRows] = rows;
        const headers = rawHeaders.map(this.normalizeKey);

        let lastDate = "";

        return dataRows
            .filter((row) => row.some((cell) => String(cell ?? "").trim() !== ""))
            .map((row) => {
            const obj = Object.fromEntries(
                headers.map((header, i) => [header, row[i] ?? ""])
            ) as Partial<TaskRow>;

            if (obj.date && obj.date.trim() !== "") {
                lastDate = obj.date;
            } else {
                obj.date = lastDate;
            }

            const trelloCardId = (obj as any).trelloTaskId ?? obj.trelloCardId ?? "";

            return {
                date: obj.date ?? "",
                item: obj.item ?? "",
                notesResourceLinks: obj.notesResourceLinks ?? "",
                pointPerson: obj.pointPerson ?? "",
                status: obj.status ?? "",
                nextSteps: obj.nextSteps ?? "",
                trelloCardId: trelloCardId,
            };
        });
    }
}

export const trelloGDriveSyncController = new TrelloGDriveSyncController();