import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Google Sheets Integration for Website Tester
 *
 * Setup Instructions:
 * 1. Go to Google Cloud Console (https://console.cloud.google.com/)
 * 2. Create a new project or select existing
 * 3. Enable Google Sheets API
 * 4. Create a Service Account and download the JSON key file
 * 5. Save the key file as 'credentials.json' in this directory
 * 6. Share your Google Sheet with the service account email
 */

class SheetsIntegration {
  constructor(credentialsPath = 'credentials.json') {
    this.credentialsPath = path.isAbsolute(credentialsPath)
      ? credentialsPath
      : path.join(__dirname, credentialsPath);
    this.doc = null;
    this.serviceAccountAuth = null;
  }

  async init() {
    try {
      const credentialsContent = await fs.readFile(this.credentialsPath, 'utf-8');
      const credentials = JSON.parse(credentialsContent);

      this.serviceAccountAuth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });

      console.log('Google Sheets authentication initialized');
    } catch (error) {
      console.error('Failed to initialize Google Sheets auth:', error.message);
      console.log('\nPlease follow the setup instructions in sheets-integration.js');
      throw error;
    }
  }

  async loadSheet(spreadsheetId) {
    this.doc = new GoogleSpreadsheet(spreadsheetId, this.serviceAccountAuth);
    await this.doc.loadInfo();
    console.log(`Loaded spreadsheet: ${this.doc.title}`);
    return this.doc;
  }

  async getUrls(sheetIndex = 0, urlColumn = 'url') {
    const sheet = this.doc.sheetsByIndex[sheetIndex];
    const rows = await sheet.getRows();

    const urls = [];
    for (const row of rows) {
      // Try different possible column names for URL
      const url = row.get(urlColumn) ||
        row.get('URL') ||
        row.get('Website') ||
        row.get('website') ||
        row.get('link') ||
        row.get('Link');

      if (url && url.startsWith('http')) {
        urls.push({
          url,
          name: row.get('name') || row.get('Name') || '',
          rowNumber: row.rowNumber
        });
      }
    }

    console.log(`Found ${urls.length} URLs to test`);
    return urls;
  }

  async updateResults(results, sheetIndex = 0) {
    const sheet = this.doc.sheetsByIndex[sheetIndex];
    const rows = await sheet.getRows();

    // Check if result columns exist, if not add them
    const headers = sheet.headerValues;
    const resultColumns = ['test_status', 'test_timestamp', 'test_details'];
    let needsHeaderUpdate = false;

    for (const col of resultColumns) {
      if (!headers.includes(col)) {
        headers.push(col);
        needsHeaderUpdate = true;
      }
    }

    if (needsHeaderUpdate) {
      await sheet.setHeaderRow(headers);
    }

    // Update each row with test results
    for (const result of results) {
      const matchingRow = rows.find(row => {
        const rowUrl = row.get('url') || row.get('URL') || row.get('Website');
        return rowUrl === result.url;
      });

      if (matchingRow) {
        matchingRow.set('test_status', result.overall);
        matchingRow.set('test_timestamp', result.timestamp);
        matchingRow.set('test_details', result.steps
          .map(s => `${s.name}: ${s.status}`)
          .join('; '));
        await matchingRow.save();
        console.log(`Updated row for: ${result.url}`);
      }
    }
  }
}

// Export for use in main script
export { SheetsIntegration };

// Example usage when run directly
async function main() {
  const sheets = new SheetsIntegration();

  console.log(`
===========================================
Google Sheets Integration Setup
===========================================

To use this integration:

1. Create credentials.json with your Google Service Account key
2. Run: node sheets-integration.js <spreadsheet-id>

Example:
  node sheets-integration.js 1abc123def456_your_spreadsheet_id

Make sure your spreadsheet has:
- A column named 'url' (or 'URL' or 'Website') with the URLs to test
- Share the sheet with your service account email
`);

  const spreadsheetId = process.argv[2];
  if (!spreadsheetId) {
    console.log('No spreadsheet ID provided. Run with: node sheets-integration.js <spreadsheet-id>');
    return;
  }

  try {
    await sheets.init();
    await sheets.loadSheet(spreadsheetId);
    const urls = await sheets.getUrls();
    console.log('\nURLs found:');
    urls.forEach(u => console.log(`  - ${u.url}`));
  } catch (error) {
    console.error('Error:', error.message);
  }
}

main().catch(console.error);
