
import * as trelloDatasource from '../datasources/trelloDatasource.js'
import * as gDriveDatasource from '../datasources/gDriveDatasource.js';

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
        // const trelloData = await this.getTrelloTasks();
        const gDriveChanges = await this.getGDriveData();
        await this.addOrUpdateTrelloCards(gDriveChanges);
    }

    private async getTrelloTasks(){
        const lists = await trelloDatasource.trelloDatasource.fetchTrelloLists();
        console.log('Trello lists:', lists);
        const data = await trelloDatasource.trelloDatasource.getAllCards();
        let cards = data.map((card: any) => ({ id: card.id, name: card.name, description: card.desc, status: card.idList, labels: card.labels }));
        cards = cards.map((card: any) => {
            const list = lists.find((list: any) => list.id === card.status);
            card.labels = card.labels.map((label: any) => label.name);
            return { ...card, status: list ? list.name : 'Unknown' };
        });
        cards = cards.filter((card: any) => card.status !== 'Done');
        console.log('Trello cards:', cards);
    }

    private async addOrUpdateTrelloCards(tasks: TaskRow[]) {
        for (const change of tasks) {
            if (change.state === 'new') {
                console.log('Adding card to Trello:', change.item, 'Status:', change.status);
                const cardId = await trelloDatasource.trelloDatasource.addCard(
                    change.date,
                    change.item,
                    change.notesResourceLinks,
                    change.status,
                    change.nextSteps,
                    change.pointPerson
                );
                console.log('Card created, returned data:', cardId);
                if (cardId) {
                    console.log('Updating Google Sheet with card ID:', cardId, 'for item:', change.item);
                    const updated = await gDriveDatasource.gDriveDatasource.updateCardId(change.item, cardId);
                    console.log('Update result:', updated);

                    // Update oldGDriveData with the new trelloCardId
                    const oldDataIndex = this.oldGDriveData.findIndex(row => row.item === change.item);
                    if (oldDataIndex !== -1) {
                        this.oldGDriveData[oldDataIndex].trelloCardId = cardId;
                    }
                } else {
                    console.log('No card ID returned from Trello');
                }
            }
        }
    }

    private async getGDriveData() {
        const data = await gDriveDatasource.gDriveDatasource.readFile();
        const mappedData = this.mapSheetData(data);

        if (this.oldGDriveData.length > 0) {
            const changes = this.compareGDriveData(this.oldGDriveData, mappedData);
            this.oldGDriveData = mappedData;
            console.log('Google Drive data changes:', changes);
            return changes;
        }

        this.oldGDriveData = mappedData;
        console.log('Google Drive data:', mappedData.filter(row => row.status !== "done"));
        return mappedData
            .filter(row => row.status !== "done" && (!row.trelloCardId || row.trelloCardId.trim() === ''))
            .map(row => ({ ...row, state: 'new' as const }));
    }

    private compareGDriveData(oldData: TaskRow[], newData: TaskRow[]): TaskRow[] {
        const changes: TaskRow[] = [];
        const fieldsToCompare: (keyof TaskRow)[] = ['item', 'notesResourceLinks', 'status', 'nextSteps'];

        // Create a map of old data by item for easier lookup
        const oldDataMap = new Map<string, TaskRow>();
        oldData.forEach(row => {
            oldDataMap.set(row.item, row);
        });

        // Check for new and updated items
        newData.forEach(newRow => {
            const oldRow = oldDataMap.get(newRow.item);

            if (!oldRow) {
                // New item
                changes.push({ ...newRow, state: 'new' });
            } else {
                // Check if any field changed
                const hasChanges = fieldsToCompare.some(field => {
                    return newRow[field] !== oldRow[field];
                });

                if (hasChanges) {
                    changes.push({ ...newRow, state: 'updated' });
                }

                // Remove from map to track deleted items
                oldDataMap.delete(newRow.item);
            }
        });

        // Remaining items in oldDataMap are deleted
        oldDataMap.forEach(deletedRow => {
            changes.push({ ...deletedRow, state: 'deleted' });
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