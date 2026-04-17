import dotenv from 'dotenv';
import { google } from "googleapis";

  if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
  }

class GDriveDatasource{
    private static fileId = "15AQzZUKytQC0G9wovZKIZ7xvmIqjkuJDbhNKg5Rf-vE";

    constructor() {}

    private getPrivateKey(): string {
        const key = process.env.GOOGLE_PRIVATE_KEY;
        if (!key) {
            throw new Error('GOOGLE_PRIVATE_KEY is not set');
        }
        // Only replace \\n with \n if the key contains \\n (escaped newlines)
        // If multiline=true in Coolify, the key already has real newlines
        if (key.includes('\\n')) {
            return key.replace(/\\n/g, '\n');
        }
        return key;
    }

    async readFile() {
        try {
            const auth = new google.auth.GoogleAuth({
                credentials: {
                client_email: process.env.GOOGLE_CLIENT_EMAIL,
                private_key: this.getPrivateKey(),
                },
                scopes: ["https://www.googleapis.com/auth/spreadsheets"],
            });

            const sheets = google.sheets({ version: "v4", auth });
            const res = await sheets.spreadsheets.values.get({
                spreadsheetId: GDriveDatasource.fileId,
                range: "Data2026!A:Z",
            });

            const rows = res.data.values ?? [];
            return rows;
        } catch (error) {
            console.error("Error reading Google Drive file:", error);
            return [];
        }
    }

    async updateCardId(item: string, trelloCardId: string) {
        try {
            const auth = new google.auth.GoogleAuth({
                credentials: {
                    client_email: process.env.GOOGLE_CLIENT_EMAIL,
                    private_key: this.getPrivateKey(),
                },
                scopes: ["https://www.googleapis.com/auth/spreadsheets"],
            });

            const sheets = google.sheets({ version: "v4", auth });

            // First, read all data to find the row
            const res = await sheets.spreadsheets.values.get({
                spreadsheetId: GDriveDatasource.fileId,
                range: "Data2026!A:Z",
            });

            const rows = res.data.values ?? [];
            if (rows.length === 0) return false;

            // Find the column index for "item" (column B)
            const headers = rows[0];
            const itemColIndex = headers.findIndex((h: string) =>
                h.toLowerCase().trim() === 'item'
            );

            if (itemColIndex === -1) {
                console.error('Could not find item column');
                return false;
            }

            // Find the row with matching item
            const rowIndex = rows.findIndex((row: string[], index: number) =>
                index > 0 && row[itemColIndex] === item
            );

            if (rowIndex === -1) {
                console.error(`Could not find row with item: ${item}`);
                return false;
            }

            // Update column G (trelloCardId) for the found row
            const range = `Data2026!G${rowIndex + 1}`;

            await sheets.spreadsheets.values.update({
                spreadsheetId: GDriveDatasource.fileId,
                range: range,
                valueInputOption: 'RAW',
                requestBody: {
                    values: [[trelloCardId]],
                },
            });

            console.log(`Updated trelloCardId for "${item}" at ${range}`);
            return true;
        } catch (error) {
            console.error("Error updating Google Drive file:", error);
            return false;
        }
    }

    async updateRowByCardId(trelloCardId: string, date: string, item: string, notesResourceLinks: string, pointPerson: string, status: string, nextSteps: string) {
        try {
            const auth = new google.auth.GoogleAuth({
                credentials: {
                    client_email: process.env.GOOGLE_CLIENT_EMAIL,
                    private_key: this.getPrivateKey(),
                },
                scopes: ["https://www.googleapis.com/auth/spreadsheets"],
            });

            const sheets = google.sheets({ version: "v4", auth });

            // First, read all data to find the row
            const res = await sheets.spreadsheets.values.get({
                spreadsheetId: GDriveDatasource.fileId,
                range: "Data2026!A:Z",
            });

            const rows = res.data.values ?? [];
            if (rows.length === 0) return false;

            // Find the row with matching trelloCardId (column G)
            const rowIndex = rows.findIndex((row: string[], index: number) =>
                index > 0 && row[6] === trelloCardId  // Column G is index 6
            );

            if (rowIndex === -1) {
                console.error(`Could not find row with trelloCardId: ${trelloCardId}`);
                return false;
            }

            // Update the entire row: A=date, B=item, C=notesResourceLinks, D=pointPerson, E=status, F=nextSteps, G=trelloCardId
            const range = `Data2026!A${rowIndex + 1}:G${rowIndex + 1}`;

            console.log(`Updating row ${rowIndex + 1} with:`, {
                date,
                item,
                notesResourceLinks,
                pointPerson,
                status,
                nextSteps,
                trelloCardId
            });

            const updateResponse = await sheets.spreadsheets.values.update({
                spreadsheetId: GDriveDatasource.fileId,
                range: range,
                valueInputOption: 'RAW',
                requestBody: {
                    values: [[date, item, notesResourceLinks, pointPerson, status, nextSteps, trelloCardId]],
                },
            });

            console.log(`Updated row for trelloCardId "${trelloCardId}" at row ${rowIndex + 1}, updated cells: ${updateResponse.data.updatedCells}`);
            return true;
        } catch (error) {
            console.error("Error updating Google Drive row:", error);
            return false;
        }
    }

    async deleteRowByCardId(trelloCardId: string) {
        try {
            const auth = new google.auth.GoogleAuth({
                credentials: {
                    client_email: process.env.GOOGLE_CLIENT_EMAIL,
                    private_key: this.getPrivateKey(),
                },
                scopes: ["https://www.googleapis.com/auth/spreadsheets"],
            });

            const sheets = google.sheets({ version: "v4", auth });

            // Get sheet metadata to find the correct sheetId for Data2026
            const sheetMetadata = await sheets.spreadsheets.get({
                spreadsheetId: GDriveDatasource.fileId,
            });
            const sheet = sheetMetadata.data.sheets?.find(
                (s) => s.properties?.title === "Data2026"
            );
            const sheetId = sheet?.properties?.sheetId ?? 0;

            // First, read all data to find the row
            const res = await sheets.spreadsheets.values.get({
                spreadsheetId: GDriveDatasource.fileId,
                range: "Data2026!A:Z",
            });

            const rows = res.data.values ?? [];
            if (rows.length === 0) return false;

            // Find the row with matching trelloCardId (column G)
            const rowIndex = rows.findIndex((row: string[], index: number) =>
                index > 0 && row[6] === trelloCardId  // Column G is index 6
            );

            if (rowIndex === -1) {
                console.error(`Could not find row with trelloCardId: ${trelloCardId}`);
                return false;
            }

            // Delete the row
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: GDriveDatasource.fileId,
                requestBody: {
                    requests: [
                        {
                            deleteDimension: {
                                range: {
                                    sheetId: sheetId,
                                    dimension: 'ROWS',
                                    startIndex: rowIndex,
                                    endIndex: rowIndex + 1,
                                },
                            },
                        },
                    ],
                },
            });

            console.log(`Deleted row for trelloCardId "${trelloCardId}" at row ${rowIndex + 1}`);
            return true;
        } catch (error) {
            console.error("Error deleting Google Drive row:", error);
            return false;
        }
    }

    async addRow(date: string, item: string, notesResourceLinks: string, pointPerson: string, status: string, nextSteps: string, trelloCardId: string) {
        try {
            const auth = new google.auth.GoogleAuth({
                credentials: {
                    client_email: process.env.GOOGLE_CLIENT_EMAIL,
                    private_key: this.getPrivateKey(),
                },
                scopes: ["https://www.googleapis.com/auth/spreadsheets"],
            });

            const sheets = google.sheets({ version: "v4", auth });

            // Get sheet metadata to find the correct sheetId for Data2026
            const sheetMetadata = await sheets.spreadsheets.get({
                spreadsheetId: GDriveDatasource.fileId,
            });
            const sheet = sheetMetadata.data.sheets?.find(
                (s) => s.properties?.title === "Data2026"
            );
            const sheetId = sheet?.properties?.sheetId ?? 0;

            // First, get the current row count to know where to add the new row
            const res = await sheets.spreadsheets.values.get({
                spreadsheetId: GDriveDatasource.fileId,
                range: "Data2026!A:G",
            });
            const rows = res.data.values ?? [];
            const newRowIndex = rows.length + 1;

            // Append a new row
            const range = `Data2026!A:G`;

            await sheets.spreadsheets.values.append({
                spreadsheetId: GDriveDatasource.fileId,
                range: range,
                valueInputOption: 'RAW',
                requestBody: {
                    values: [[date, item, notesResourceLinks, pointPerson, status, nextSteps, trelloCardId]],
                },
            });

            // Add data validation for Point Person (column D) and Status (column E)
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: GDriveDatasource.fileId,
                requestBody: {
                    requests: [
                        {
                            setDataValidation: {
                                range: {
                                    sheetId: sheetId,
                                    startRowIndex: newRowIndex - 1,
                                    endRowIndex: newRowIndex,
                                    startColumnIndex: 3, // Column D (Point Person)
                                    endColumnIndex: 4,
                                },
                                rule: {
                                    condition: {
                                        type: 'ONE_OF_LIST',
                                        values: [
                                            { userEnteredValue: 'Jeldrik' },
                                            { userEnteredValue: 'Tiffany' },
                                            { userEnteredValue: 'Nhat' },
                                            { userEnteredValue: 'Tim' },
                                            { userEnteredValue: 'Everyone' },
                                            { userEnteredValue: 'Khan' },
                                            { userEnteredValue: 'Tuyen' },
                                        ],
                                    },
                                    showCustomUi: true,
                                    strict: false,
                                },
                            },
                        },
                        {
                            setDataValidation: {
                                range: {
                                    sheetId: sheetId,
                                    startRowIndex: newRowIndex - 1,
                                    endRowIndex: newRowIndex,
                                    startColumnIndex: 4, // Column E (Status)
                                    endColumnIndex: 5,
                                },
                                rule: {
                                    condition: {
                                        type: 'ONE_OF_LIST',
                                        values: [
                                            { userEnteredValue: 'in progress' },
                                            { userEnteredValue: 'done' },
                                            { userEnteredValue: 'waiting for feedback' },
                                            { userEnteredValue: 'canceled' },
                                            { userEnteredValue: 'scheduled' },
                                            { userEnteredValue: 'paused' },
                                        ],
                                    },
                                    showCustomUi: true,
                                    strict: false,
                                },
                            },
                        },
                    ],
                },
            });

            console.log(`Added new row for trelloCardId "${trelloCardId}" with status validation`);
            return true;
        } catch (error) {
            console.error("Error adding row to Google Drive:", error);
            return false;
        }
    }

}

export const gDriveDatasource = new GDriveDatasource();