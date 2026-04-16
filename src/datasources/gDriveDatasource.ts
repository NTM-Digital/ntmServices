import dotenv from 'dotenv';
import { google } from "googleapis";

  if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
  }

class GDriveDatasource{
    private static fileId = "15AQzZUKytQC0G9wovZKIZ7xvmIqjkuJDbhNKg5Rf-vE";

    constructor() {}

    async readFile() {
        try {
            const auth = new google.auth.GoogleAuth({
                credentials: {
                client_email: process.env.GOOGLE_CLIENT_EMAIL,
                private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
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
                    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
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

}

export const gDriveDatasource = new GDriveDatasource();