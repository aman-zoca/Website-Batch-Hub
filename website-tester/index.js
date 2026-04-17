import puppeteer from "puppeteer";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const CONFIG = {
  headless: false, // Set to true for headless mode
  slowMo: 100, // Slow down actions by 100ms for visibility
  timeout: 30000, // 30 second timeout for operations
  defaultTestData: {
    firstName: "Test",
    lastName: "bot",
    phone: "2343831494",
  },
};

// Test step selectors - these can be customized per site
const DEFAULT_SELECTORS = {
  navbarCTA: "#cta-button-desktop",
  heroCTA: "#hero-cta-button",
  bookingModal: "#booking-modal",
  modalClose: "#booking-modal-close",
  firstNameInput: "#cta-firstName-input",
  lastNameInput: "#cta-lastName-input",
  phoneInput: "#modal-phone-number-input",
  submitButton: "#book-now-button",
};

class WebsiteTester {
  constructor(options = {}) {
    this.browser = null;
    this.page = null;
    this.results = [];
    this.config = { ...CONFIG, ...options };
  }

  async init() {
    this.browser = await puppeteer.launch({
      headless: this.config.headless,
      slowMo: this.config.slowMo,
      args: ["--start-maximized"],
    });
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1920, height: 1080 });
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }

  async testSite(
    url,
    selectors = DEFAULT_SELECTORS,
    testData = CONFIG.defaultTestData,
  ) {
    const result = {
      url,
      timestamp: new Date().toISOString(),
      steps: [],
      overall: "PENDING",
    };

    try {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`Testing: ${url}`);
      console.log("=".repeat(60));

      // Step 1: Navigate to the website
      await this.step(result, "Navigate to website", async () => {
        await this.page.goto(url, {
          waitUntil: "networkidle2",
          timeout: this.config.timeout,
        });
      });

      // Step 2: Click navbar CTA button
      await this.step(result, "Click navbar Book Appointment", async () => {
        await this.page.waitForSelector(selectors.navbarCTA, {
          visible: true,
          timeout: 10000,
        });
        await this.page.click(selectors.navbarCTA);
      });

      // Step 3: Verify modal opens
      await this.step(
        result,
        "Verify booking modal opens (navbar)",
        async () => {
          await this.page.waitForSelector(selectors.bookingModal, {
            visible: true,
            timeout: 5000,
          });
          const modalDisplay = await this.page.$eval(
            selectors.bookingModal,
            (el) => {
              const style = window.getComputedStyle(el);
              return style.display !== "none" && style.visibility !== "hidden";
            },
          );
          if (!modalDisplay) throw new Error("Modal not visible");
        },
      );

      // Step 4: Close the modal
      await this.step(result, "Close booking modal", async () => {
        await this.page.waitForSelector(selectors.modalClose, {
          visible: true,
          timeout: 5000,
        });
        await this.page.click(selectors.modalClose);
        await this.page.waitForFunction(
          (selector) => {
            const modal = document.querySelector(selector);
            if (!modal) return true;
            const style = window.getComputedStyle(modal);
            return style.display === "none" || style.opacity === "0";
          },
          { timeout: 5000 },
          selectors.bookingModal,
        );
        // Wait for page to stabilize after modal close
        await new Promise((resolve) => setTimeout(resolve, 1000));
      });

      // Step 5: Click hero CTA button
      // Wait for any page navigation to complete
      await this.page
        .waitForSelector(selectors.heroCTA, {
          visible: true,
          timeout: 10000,
        })
        .catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
      await this.step(result, "Click hero Book Appointment", async () => {
        await this.page.waitForSelector(selectors.heroCTA, {
          visible: true,
          timeout: 10000,
        });
        await this.page.click(selectors.heroCTA);
      });

      // Step 6: Verify modal opens again
      await this.step(result, "Verify booking modal opens (hero)", async () => {
        await this.page.waitForSelector(selectors.bookingModal, {
          visible: true,
          timeout: 5000,
        });
        const modalDisplay = await this.page.$eval(
          selectors.bookingModal,
          (el) => {
            const style = window.getComputedStyle(el);
            return style.display !== "none" && style.visibility !== "hidden";
          },
        );
        if (!modalDisplay) throw new Error("Modal not visible");
      });

      // Step 7: Fill the form - First Name
      await this.step(result, "Fill first name", async () => {
        const firstNameSelector = selectors.firstNameInput;
        try {
          await this.page.waitForSelector(firstNameSelector, {
            visible: true,
            timeout: 3000,
          });
          await this.page.type(firstNameSelector, testData.firstName, {
            delay: 50,
          });
        } catch (e) {
          // First name might not exist on all forms, try alternative selector
          console.log("  First name input not found, trying alternative...");
          const altSelector = 'input[data-form-field="ctaFormFirstName"]';
          await this.page.waitForSelector(altSelector, {
            visible: true,
            timeout: 3000,
          });
          await this.page.type(altSelector, testData.firstName, { delay: 50 });
        }
      });

      // Step 8: Fill the form - Last Name
      await this.step(result, "Fill last name", async () => {
        await this.page.waitForSelector(selectors.lastNameInput, {
          visible: true,
          timeout: 3000,
        });
        await this.page.type(selectors.lastNameInput, testData.lastName, {
          delay: 50,
        });
      });

      // Step 9: Fill the form - Phone Number
      await this.step(result, "Fill phone number", async () => {
        await this.page.waitForSelector(selectors.phoneInput, {
          visible: true,
          timeout: 3000,
        });
        await this.page.type(selectors.phoneInput, testData.phone, {
          delay: 50,
        });
      });

      // Step 10: Submit the form
      await this.step(result, "Submit form", async () => {
        await this.page.waitForSelector(selectors.submitButton, {
          visible: true,
          timeout: 3000,
        });
        await this.page.click(selectors.submitButton);
        // Wait a bit to see if form submission triggers any response
        await new Promise((resolve) => setTimeout(resolve, 2000));
      });

      // Check overall status
      const failedSteps = result.steps.filter((s) => s.status === "FAILED");
      result.overall = failedSteps.length === 0 ? "SUCCESS" : "PARTIAL_FAILURE";

      console.log(`\nOverall Result: ${result.overall}`);
      console.log(
        `Passed: ${result.steps.filter((s) => s.status === "SUCCESS").length}/${result.steps.length}`,
      );
    } catch (error) {
      result.overall = "FAILED";
      result.error = error.message;
      console.error(`\nTest failed with error: ${error.message}`);
    }

    this.results.push(result);
    return result;
  }

  async step(result, name, action) {
    const stepResult = {
      name,
      status: "PENDING",
      startTime: new Date().toISOString(),
    };

    try {
      console.log(`  [RUNNING] ${name}...`);
      await action();
      stepResult.status = "SUCCESS";
      stepResult.endTime = new Date().toISOString();
      console.log(`  [SUCCESS] ${name}`);
    } catch (error) {
      stepResult.status = "FAILED";
      stepResult.error = error.message;
      stepResult.endTime = new Date().toISOString();
      console.log(`  [FAILED] ${name}: ${error.message}`);
    }

    result.steps.push(stepResult);
    return stepResult;
  }

  async saveResults(outputPath) {
    const resultsJson = JSON.stringify(this.results, null, 2);
    await fs.writeFile(outputPath, resultsJson);
    console.log(`\nResults saved to: ${outputPath}`);
  }

  async saveResultsCSV(outputPath) {
    const rows = [];

    for (const result of this.results) {
      const row = {
        url: result.url,
        timestamp: result.timestamp,
        overall: result.overall,
        error: result.error || "",
      };

      // Add individual step results
      for (const step of result.steps) {
        const stepKey = step.name.replace(/[^a-zA-Z0-9]/g, "_");
        row[stepKey] = step.status;
      }

      rows.push(row);
    }

    const csv = stringify(rows, { header: true });
    await fs.writeFile(outputPath, csv);
    console.log(`\nResults saved to CSV: ${outputPath}`);
  }
}

// Load URLs from CSV file
async function loadUrlsFromCSV(csvPath) {
  const content = await fs.readFile(csvPath, "utf-8");
  const records = parse(content, { columns: true, skip_empty_lines: true });
  return records.map((r) => r.url || r.URL || r.Website || Object.values(r)[0]);
}

// Load URLs from Google Sheets
async function loadUrlsFromGoogleSheets(spreadsheetId) {
  try {
    const { SheetsIntegration } = await import("./sheets-integration.js");
    const sheets = new SheetsIntegration();
    await sheets.init();
    await sheets.loadSheet(spreadsheetId);
    const urls = await sheets.getUrls();
    return { urls: urls.map((u) => u.url), sheets };
  } catch (error) {
    console.error("Failed to load from Google Sheets:", error.message);
    console.log(
      "Make sure you have credentials.json in the website-tester directory",
    );
    throw error;
  }
}

// Print help
function printHelp() {
  console.log(`
Website Popup Tester - Automated testing for booking modal flows

Usage:
  node index.js [options] [url]

Options:
  --help, -h          Show this help message
  --headless          Run in headless mode (no browser window)
  --fast              Run without slowMo delay
  --csv <file>        Load URLs from CSV file
  --sheets <id>       Load URLs from Google Sheets (requires credentials.json)
  --update-sheets     Update Google Sheets with test results (use with --sheets)

Examples:
  node index.js                                    # Test default URL
  node index.js https://example.com               # Test specific URL
  node index.js --csv urls.csv                    # Test URLs from CSV
  node index.js --sheets YOUR_SHEET_ID            # Test URLs from Google Sheets
  node index.js --headless --fast --csv urls.csv  # Fast headless batch test
`);
}

// Main execution
async function main() {
  const args = process.argv.slice(2);

  // Show help
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const tester = new WebsiteTester({
    headless: args.includes("--headless"),
    slowMo: args.includes("--fast") ? 0 : 100,
  });

  let sheetsIntegration = null;

  try {
    await tester.init();

    // Check if Google Sheets is provided
    const sheetsIndex = args.findIndex((a) => a === "--sheets");
    if (sheetsIndex !== -1 && args[sheetsIndex + 1]) {
      const spreadsheetId = args[sheetsIndex + 1];
      console.log(`Loading URLs from Google Sheets: ${spreadsheetId}`);
      const { urls, sheets } = await loadUrlsFromGoogleSheets(spreadsheetId);
      sheetsIntegration = sheets;

      for (const url of urls) {
        if (url && url.startsWith("http")) {
          await tester.testSite(url);
        }
      }

      // Update sheets with results if requested
      if (args.includes("--update-sheets") && sheetsIntegration) {
        await sheetsIntegration.updateResults(tester.results);
      }
    }
    // Check if CSV file is provided
    else {
      const csvIndex = args.findIndex((a) => a === "--csv" || a === "-c");
      if (csvIndex !== -1 && args[csvIndex + 1]) {
        const csvPath = args[csvIndex + 1];
        console.log(`Loading URLs from: ${csvPath}`);
        const urls = await loadUrlsFromCSV(csvPath);

        for (const url of urls) {
          if (url && url.startsWith("http")) {
            await tester.testSite(url);
          }
        }
      } else {
        // Default test URL
        const testUrl =
          args.find((a) => a.startsWith("http")) ||
          "https://priyamakeoverla4.mononest.dev/";
        await tester.testSite(testUrl);
      }
    }

    // Save results
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    await tester.saveResults(path.join(__dirname, `results-${timestamp}.json`));
    await tester.saveResultsCSV(
      path.join(__dirname, `results-${timestamp}.csv`),
    );
  } finally {
    await tester.close();
  }
}

// Export for use as module
export { WebsiteTester, DEFAULT_SELECTORS, CONFIG };

// Run if executed directly
main().catch(console.error);
