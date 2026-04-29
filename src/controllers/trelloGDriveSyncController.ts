
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
        // Clear tracking sets at the start of each sync cycle
        this.archivedCardIds.clear();
        this.movedToDoneCardIds.clear();

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
        // Use the snapshot from beginning of sync cycle to detect conflicts
        const initialSheetData = this.oldGDriveData;

        // Create a map of initial sheet rows by trelloCardId
        const initialSheetByCardId = new Map<string, TaskRow>();
        initialSheetData.forEach(row => {
            if (row.trelloCardId && row.trelloCardId.trim() !== '') {
                initialSheetByCardId.set(row.trelloCardId, row);
            }
        });

        // Create a set of Trello card IDs for quick lookup
        const trelloCardIds = new Set(trelloCards.map(card => card.id));

        // Process each Trello card
        for (const card of trelloCards) {
            const initialSheetRow = initialSheetByCardId.get(card.id);

            if (initialSheetRow) {
                // Check if any field changed (only update item and status)
                const statusLowerCase = card.status.toLowerCase();
                const hasChanges =
                    initialSheetRow.item !== card.name ||
                    initialSheetRow.status !== statusLowerCase;

                if (hasChanges) {
                    console.log(`Updating Google Sheet row for card: ${card.name}`);
                    // Pass expected current state for conflict detection
                    await gDriveDatasource.updateRowByCardId(
                        card.id,
                        initialSheetRow.date,
                        card.name,
                        initialSheetRow.notesResourceLinks,
                        initialSheetRow.pointPerson,
                        statusLowerCase,
                        initialSheetRow.nextSteps,
                        // Expected state (what we think the row currently contains)
                        {
                            date: initialSheetRow.date,
                            item: initialSheetRow.item,
                            notesResourceLinks: initialSheetRow.notesResourceLinks,
                            pointPerson: initialSheetRow.pointPerson,
                            status: initialSheetRow.status,
                            nextSteps: initialSheetRow.nextSteps
                        }
                    );
                }
                // Mark this card as processed
                initialSheetByCardId.delete(card.id);
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
        // BUT: skip cards that we just archived or moved to Done - keep those rows
        for (const [cardId, sheetRow] of initialSheetByCardId) {
            if (!trelloCardIds.has(cardId)) {
                // Skip deletion if we archived this card due to cancelled/invalid status
                if (this.archivedCardIds.has(cardId)) {
                    console.log(`Skipping deletion of Google Sheet row for archived card (user set to cancelled/invalid status): ${sheetRow.item}`);
                    continue;
                }

                // Skip deletion if we moved this card to Done
                if (this.movedToDoneCardIds.has(cardId)) {
                    console.log(`Skipping deletion of Google Sheet row for card moved to Done: ${sheetRow.item}`);
                    continue;
                }

                console.log(`Deleting Google Sheet row for card that was archived/moved to Backlog: ${sheetRow.item}`);
                // Pass expected status for conflict detection
                await gDriveDatasource.deleteRowByCardId(cardId, sheetRow.status);
            }
        }
    }

    private archivedCardIds = new Set<string>();
    private movedToDoneCardIds = new Set<string>();

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
                if (!task.trelloCardId || task.trelloCardId.trim() === '') {
                    console.log('Cannot update card - no Trello card ID found for:', task.item);
                    continue;
                }

                // Check if status is 'done' - move to Done list
                if (task.status === 'done') {
                    console.log('Moving card to Done list in Trello:', task.item);
                    const updated = await trelloDatasource.updateCard(
                        task.trelloCardId,
                        task.date,
                        task.item,
                        task.notesResourceLinks,
                        'done',
                        task.nextSteps,
                        task.pointPerson
                    );
                    console.log('Move to Done result:', updated);
                    // Track cards moved to Done so we don't delete their rows from Google Sheet
                    if (updated) {
                        this.movedToDoneCardIds.add(task.trelloCardId);
                    }
                } else {
                    // Try to update card with the status
                    console.log('Updating card in Trello:', task.item, 'Status:', task.status);
                    const updated = await trelloDatasource.updateCard(
                        task.trelloCardId,
                        task.date,
                        task.item,
                        task.notesResourceLinks,
                        task.status,
                        task.nextSteps,
                        task.pointPerson
                    );

                    // If update failed, it might be because the status doesn't exist in Trello
                    // In that case, archive the card (e.g., for 'cancelled' status)
                    if (!updated) {
                        console.log(`Status "${task.status}" not found in Trello, archiving card:`, task.item);
                        await trelloDatasource.archiveCard(task.trelloCardId);
                        this.archivedCardIds.add(task.trelloCardId);
                    }

                    console.log('Update result:', updated);
                }
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
                this.archivedCardIds.add(task.trelloCardId);
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

            // Track any rows with "done" status that have a trelloCardId
            // These should not be deleted from Google Sheet
            mappedData.forEach(row => {
                if (row.status === 'done' && row.trelloCardId && row.trelloCardId.trim() !== '') {
                    this.movedToDoneCardIds.add(row.trelloCardId);
                }
            });

            return changes;
        }

        this.oldGDriveData = mappedData;

        // Track any existing rows with "done" status
        mappedData.forEach(row => {
            if (row.status === 'done' && row.trelloCardId && row.trelloCardId.trim() !== '') {
                this.movedToDoneCardIds.add(row.trelloCardId);
            }
        });

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