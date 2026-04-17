# Website Popup Tester

Automated testing tool for website booking modal/popup flows using Puppeteer.

## Features

- Test booking popup functionality from navbar and hero buttons
- Fill and submit booking forms automatically
- Load URLs from CSV or Google Sheets
- Generate JSON and CSV test reports
- Update Google Sheets with test results

## Setup

```bash
cd website-tester
npm install
```

## Usage

### Test a single URL

```bash
node index.js https://priyamakeoverla4.mononest.dev/
```

### Test multiple URLs from CSV

```bash
node index.js --csv sample-urls.csv
```

### Test URLs from Google Sheets

1. Create `credentials.json` with your Google Service Account key (see below)
2. Share your sheet with the service account email
3. Run:

```bash
node index.js --sheets YOUR_SPREADSHEET_ID
```

To also update the sheet with results:

```bash
node index.js --sheets YOUR_SPREADSHEET_ID --update-sheets
```

### Options

| Option | Description |
|--------|-------------|
| `--help, -h` | Show help message |
| `--headless` | Run without browser window |
| `--fast` | Run without delay between actions |
| `--csv <file>` | Load URLs from CSV file |
| `--sheets <id>` | Load URLs from Google Sheets |
| `--update-sheets` | Update sheet with results |

## Test Flow

The tester performs these steps for each URL:

1. Navigate to the website
2. Click navbar "Book Appointment" button
3. Verify booking modal opens
4. Close the modal
5. Click hero "Book Appointment" button
6. Verify modal opens again
7. Fill first name
8. Fill last name
9. Fill phone number
10. Submit the form

## Google Sheets Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Enable Google Sheets API
4. Create a Service Account
5. Download the JSON key file
6. Save as `credentials.json` in this directory
7. Share your spreadsheet with the service account email

Your spreadsheet should have a column named `url` (or `URL` or `Website`).

## CSV Format

```csv
url,name
https://example.com/,Example Site
https://another.com/,Another Site
```

## Test Results

Results are saved in two formats:
- `results-{timestamp}.json` - Full detailed results
- `results-{timestamp}.csv` - Summary results

## Customizing Selectors

Edit `config.js` to customize selectors for different website templates.
