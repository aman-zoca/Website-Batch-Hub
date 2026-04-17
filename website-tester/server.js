import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3002;

app.use(cors());
app.use(express.json());

// Serve dashboard HTML
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// Configuration
const CONFIG = {
  headless: false,
  slowMo: 20,
  timeout: 15000,
  stepDelay: 500, // ms to wait after each step (adjust this to speed up/slow down)
  defaultTestData: {
    firstName: "Test",
    lastName: "iAmBot",
    phone: "2343831494",
  },
};

const DEFAULT_SELECTORS = {
  navbarCTA: '[data-event-onclick^="handleGetInTouch"]',
  heroCTA: '[data-event-onclick^="handleGetInTouch"]',
  bookingModal: "#booking-modal",
  modalClose: "#booking-modal-close",
  firstNameInput: "#cta-firstName-input",
  lastNameInput: "#cta-lastName-input",
  phoneInput: "#modal-phone-number-input",
  submitButton: "#book-now-button",
};

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: CONFIG.headless,
      slowMo: CONFIG.slowMo,
      args: ["--start-maximized", "--no-sandbox"],
    });
  }
  return browser;
}

async function runTest(
  url,
  selectors = DEFAULT_SELECTORS,
  testData = CONFIG.defaultTestData,
) {
  const result = {
    url,
    timestamp: new Date().toISOString(),
    steps: [],
    overall: "PENDING",
    success: false,
  };

  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  const step = async (name, action) => {
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
      // Wait between steps for monitoring
      if (CONFIG.stepDelay > 0) {
        await new Promise(r => setTimeout(r, CONFIG.stepDelay));
      }
    } catch (error) {
      stepResult.status = "FAILED";
      stepResult.error = error.message;
      stepResult.endTime = new Date().toISOString();
      console.log(`  [FAILED] ${name}: ${error.message}`);
    }

    result.steps.push(stepResult);
    return stepResult;
  };

  try {
    console.log(`\nTesting: ${url}`);

    // Step 1: Navigate
    await step("Navigate to website", async () => {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: CONFIG.timeout,
      });

      // Check for 404 or other errors
      const status = response?.status();
      if (status === 404 || status >= 400) {
        throw new Error(`Page returned ${status}`);
      }

      // Check for 404 content
      const is404 = await page.evaluate(() => {
        const text = document.body?.innerText?.toLowerCase() || '';
        return text.includes('404') && text.includes('not found');
      });
      if (is404) {
        throw new Error('Page shows 404 not found');
      }

      // Initial wait for page to fully load
      await new Promise(resolve => setTimeout(resolve, 2000));
    });

    // Step 2: Click navbar CTA
    await step("Click navbar Book Appointment", async () => {
      // Find and click element with data-event-onclick starting with handleGetInTouch
      const clicked = await page.evaluate(() => {
        const btn = document.querySelector('[data-event-onclick^="handleGetInTouch"]');
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });

      if (!clicked) {
        throw new Error('Could not find handleGetInTouch button');
      }

      // Small wait for modal animation
      await new Promise(resolve => setTimeout(resolve, 200));
    });

    // Step 3: Verify navbar modal
    await step("Verify booking modal opens (navbar)", async () => {
      await page.waitForSelector(selectors.bookingModal, {
        visible: true,
        timeout: 2000,
      });
      const modalDisplay = await page.$eval(selectors.bookingModal, (el) => {
        const style = window.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      if (!modalDisplay) throw new Error("Modal not visible");
    });

    // Step 4: Close modal
    await step("Close booking modal", async () => {
      await page.waitForSelector(selectors.modalClose, {
        visible: true,
        timeout: 2000,
      });
      await page.click(selectors.modalClose);
      await page.waitForFunction(
        (selector) => {
          const modal = document.querySelector(selector);
          if (!modal) return true;
          const style = window.getComputedStyle(modal);
          return style.display === "none" || style.opacity === "0";
        },
        { timeout: 2000 },
        selectors.bookingModal,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    // Step 5: Click hero CTA
    await step("Click hero Get In Touch", async () => {
      // Find all handleGetInTouch buttons and click the second one (hero)
      const clicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll('[data-event-onclick^="handleGetInTouch"]');
        // Click second button if exists (hero), otherwise first
        const btn = buttons[1] || buttons[0];
        if (btn) {
          btn.scrollIntoView({ behavior: 'instant', block: 'center' });
          btn.click();
          return true;
        }
        return false;
      });

      if (!clicked) {
        throw new Error('Could not find handleGetInTouch button');
      }
    });

    // Step 6: Verify hero modal
    await step("Verify booking modal opens (hero)", async () => {
      await page.waitForSelector(selectors.bookingModal, {
        visible: true,
        timeout: 2000,
      });
      const modalDisplay = await page.$eval(selectors.bookingModal, (el) => {
        const style = window.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      if (!modalDisplay) throw new Error("Modal not visible");
    });

    // Step 7: Fill first name (skip if prefilled)
    await step("Fill first name", async () => {
      const firstNameSelector = selectors.firstNameInput;
      const altSelector = 'input[data-form-field="ctaFormFirstName"]';

      let selector = firstNameSelector;
      try {
        await page.waitForSelector(firstNameSelector, { visible: true, timeout: 2000 });
      } catch (e) {
        await page.waitForSelector(altSelector, { visible: true, timeout: 2000 });
        selector = altSelector;
      }

      const existingValue = await page.$eval(selector, el => el.value);
      if (existingValue && existingValue.trim() !== '') {
        console.log(`    [SKIP] First name already prefilled: "${existingValue}"`);
        return;
      }
      await page.type(selector, testData.firstName, { delay: 10 });
    });

    // Step 8: Fill last name (skip if prefilled)
    await step("Fill last name", async () => {
      await page.waitForSelector(selectors.lastNameInput, {
        visible: true,
        timeout: 2000,
      });

      const existingValue = await page.$eval(selectors.lastNameInput, el => el.value);
      if (existingValue && existingValue.trim() !== '') {
        console.log(`    [SKIP] Last name already prefilled: "${existingValue}"`);
        return;
      }
      await page.type(selectors.lastNameInput, testData.lastName, { delay: 10 });
    });

    // Step 9: Fill phone (skip if prefilled)
    await step("Fill phone number", async () => {
      await page.waitForSelector(selectors.phoneInput, {
        visible: true,
        timeout: 2000,
      });

      const existingValue = await page.$eval(selectors.phoneInput, el => el.value);
      if (existingValue && existingValue.trim() !== '') {
        console.log(`    [SKIP] Phone already prefilled: "${existingValue}"`);
        return;
      }
      await page.type(selectors.phoneInput, testData.phone, { delay: 10 });
    });

    // Step 10: Submit
    await step("Submit form", async () => {
      await page.waitForSelector(selectors.submitButton, {
        visible: true,
        timeout: 2000,
      });
      await page.click(selectors.submitButton);
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    const failedSteps = result.steps.filter((s) => s.status === "FAILED");
    result.overall = failedSteps.length === 0 ? "SUCCESS" : "PARTIAL_FAILURE";
    result.success = true;
  } catch (error) {
    result.overall = "FAILED";
    result.error = error.message;
    result.success = false;
  } finally {
    await page.close();
  }

  return result;
}

// API endpoint
app.post("/api/test", async (req, res) => {
  const { url, stepDelay } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: "URL is required" });
  }

  // Update stepDelay if provided
  if (stepDelay !== undefined) {
    CONFIG.stepDelay = Number(stepDelay);
  }

  try {
    const result = await runTest(url);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`========================================\n`);
});
