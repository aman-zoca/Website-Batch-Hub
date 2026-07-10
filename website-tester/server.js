import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";
import path from "path";
import multer from "multer";
import * as XLSX from "xlsx";
import { convertVagaro } from "./converters/vagaro.js";
import { bundleToSql } from "./converters/sql.js";
import { makeZip } from "./converters/zip.js";

// Platform → converter registry. Add new platforms here.
const CONVERTERS = { vagaro: convertVagaro };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 40 },
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3002;

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Serve dashboard HTML
app.get("/", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
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
  enabledSteps = null
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

  // Step key mapping for enable/disable
  const STEP_KEYS = {
    "Navigate to website": "navigate",
    "Click navbar Book Appointment": "navbar_click",
    "Verify booking modal opens (navbar)": "navbar_modal",
    "Close booking modal": "close_modal",
    "Click hero Get In Touch": "hero_click",
    "Verify booking modal opens (hero)": "hero_modal",
    "Fill first name": "fill_firstname",
    "Fill last name": "fill_lastname",
    "Fill phone number": "fill_phone",
    "Submit form": "submit",
    "Navigate to services page": "svc_page",
    "Click Add Service button 1": "add_svc1",
    "Verify lead form opens (svc 1)": "svc1_modal",
    "Click Add Service button 2": "add_svc2",
    "Verify lead form opens (svc 2)": "svc2_modal",
    "Click category tab 1": "cat_tab1",
    "Click category tab 2": "cat_tab2",
    "Test search services": "search",
  };

  const step = async (name, action) => {
    // Check if this step is disabled
    const stepKey = STEP_KEYS[name];
    if (enabledSteps && stepKey && !enabledSteps.includes(stepKey)) {
      const skipResult = {
        name,
        status: "SKIPPED",
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
      };
      result.steps.push(skipResult);
      console.log(`  [SKIPPED] ${name}`);
      return skipResult;
    }

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
        await new Promise((r) => setTimeout(r, CONFIG.stepDelay));
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

    // Auto-dismiss any browser dialogs (alerts/confirms from call-now buttons)
    page.on("dialog", async (dialog) => {
      console.log(`  [DIALOG] ${dialog.type()}: ${dialog.message()}`);
      await dialog.dismiss();
    });

    let isCallNow = false;

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
        const text = document.body?.innerText?.toLowerCase() || "";
        return text.includes("404") && text.includes("not found");
      });
      if (is404) {
        throw new Error("Page shows 404 not found");
      }

      // Initial wait for page to fully load
      await new Promise((resolve) => setTimeout(resolve, 2000));
    });

    // Step 2: Click navbar CTA
    await step("Click navbar Book Appointment", async () => {
      // Detect call-now mode and click the navbar CTA
      const btnInfo = await page.evaluate(() => {
        const btn =
          document.querySelector("#cta-button-desktop") ||
          document.querySelector('[data-event-onclick^="handleGetInTouch"]') ||
          document.querySelector('[data-event-onclick^="openBookingModal"]');
        if (!btn) return null;
        return {
          callNow: btn.getAttribute("data-call-now-enabled") === "true",
          phone: btn.getAttribute("data-call-now-phone") || "",
        };
      });

      if (!btnInfo) throw new Error("Could not find navbar CTA button");
      isCallNow = btnInfo.callNow;

      if (isCallNow) {
        console.log(
          `    [INFO] Call-now mode detected (phone: ${btnInfo.phone})`
        );
      }

      await page.evaluate(() => {
        const btn =
          document.querySelector("#cta-button-desktop") ||
          document.querySelector('[data-event-onclick^="handleGetInTouch"]') ||
          document.querySelector('[data-event-onclick^="openBookingModal"]');
        if (btn) btn.click();
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    // Step 3: Verify navbar modal
    await step("Verify booking modal opens (navbar)", async () => {
      if (isCallNow) {
        console.log(
          "    [INFO] Call-now mode — no modal expected, alert handled"
        );
        return;
      }
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
      if (isCallNow) {
        console.log("    [INFO] Call-now mode — no modal to close");
        return;
      }
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
        selectors.bookingModal
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    // Step 5: Click hero CTA
    await step("Click hero Get In Touch", async () => {
      const clicked = await page.evaluate(() => {
        // Try hero button by ID first, then fallback to second CTA button
        const heroById = document.querySelector("#hero-cta-button");
        if (heroById) {
          heroById.scrollIntoView({ behavior: "instant", block: "center" });
          heroById.click();
          return true;
        }
        const buttons = document.querySelectorAll(
          '[data-event-onclick^="handleGetInTouch"], [data-event-onclick^="openBookingModal"]'
        );
        const btn = buttons[1] || buttons[0];
        if (btn) {
          btn.scrollIntoView({ behavior: "instant", block: "center" });
          btn.click();
          return true;
        }
        return false;
      });

      if (!clicked) throw new Error("Could not find hero CTA button");
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    // Step 6: Verify hero modal
    await step("Verify booking modal opens (hero)", async () => {
      if (isCallNow) {
        console.log(
          "    [INFO] Call-now mode — no modal expected, alert handled"
        );
        return;
      }
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
      if (isCallNow) {
        console.log("    [INFO] Call-now mode — no form to fill");
        return;
      }
      const firstNameSelector = selectors.firstNameInput;
      const altSelector = 'input[data-form-field="ctaFormFirstName"]';

      let selector = firstNameSelector;
      try {
        await page.waitForSelector(firstNameSelector, {
          visible: true,
          timeout: 2000,
        });
      } catch (e) {
        await page.waitForSelector(altSelector, {
          visible: true,
          timeout: 2000,
        });
        selector = altSelector;
      }

      const existingValue = await page.$eval(selector, (el) => el.value);
      if (existingValue && existingValue.trim() !== "") {
        console.log(
          `    [SKIP] First name already prefilled: "${existingValue}"`
        );
        return;
      }
      await page.type(selector, testData.firstName, { delay: 10 });
    });

    // Step 8: Fill last name (skip if prefilled)
    await step("Fill last name", async () => {
      if (isCallNow) {
        console.log("    [INFO] Call-now mode — no form to fill");
        return;
      }
      await page.waitForSelector(selectors.lastNameInput, {
        visible: true,
        timeout: 2000,
      });

      const existingValue = await page.$eval(
        selectors.lastNameInput,
        (el) => el.value
      );
      if (existingValue && existingValue.trim() !== "") {
        console.log(
          `    [SKIP] Last name already prefilled: "${existingValue}"`
        );
        return;
      }
      await page.type(selectors.lastNameInput, testData.lastName, {
        delay: 10,
      });
    });

    // Step 9: Fill phone (skip if prefilled)
    await step("Fill phone number", async () => {
      if (isCallNow) {
        console.log("    [INFO] Call-now mode — no form to fill");
        return;
      }
      await page.waitForSelector(selectors.phoneInput, {
        visible: true,
        timeout: 2000,
      });

      const existingValue = await page.$eval(
        selectors.phoneInput,
        (el) => el.value
      );
      if (existingValue && existingValue.trim() !== "") {
        console.log(`    [SKIP] Phone already prefilled: "${existingValue}"`);
        return;
      }
      await page.type(selectors.phoneInput, testData.phone, { delay: 10 });
    });

    // Step 10: Submit
    await step("Submit form", async () => {
      if (isCallNow) {
        console.log("    [INFO] Call-now mode — no form to submit");
        return;
      }
      await page.waitForSelector(selectors.submitButton, {
        visible: true,
        timeout: 2000,
      });
      await page.click(selectors.submitButton);
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    // === SERVICE PAGE TESTS ===

    // Step 11: Navigate to /services page
    await step("Navigate to services page", async () => {
      // Close modal first if open
      try {
        const modalVisible = await page.evaluate(() => {
          const modal = document.querySelector("#booking-modal");
          if (modal) {
            const style = window.getComputedStyle(modal);
            return style.display !== "none" && style.opacity !== "0";
          }
          return false;
        });
        if (modalVisible) {
          await page.click("#booking-modal-close");
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (e) {
        /* ignore */
      }

      // Look for "View All Services" link and click it
      const clicked = await page.evaluate(() => {
        const link =
          document.querySelector('[data-variable-href="ViewAllServicesUrl"]') ||
          document.querySelector('a[href="/services"]') ||
          document.querySelector(".view-all-button");
        if (link) {
          link.scrollIntoView({ behavior: "instant", block: "center" });
          link.click();
          return true;
        }
        return false;
      });

      if (!clicked) {
        // Fallback: navigate directly to /services
        const serviceUrl = new URL("/services", url).href;
        await page.goto(serviceUrl, {
          waitUntil: "domcontentloaded",
          timeout: CONFIG.timeout,
        });
      }

      // Wait for services page to load
      await new Promise((r) => setTimeout(r, 3000));

      // Verify we're on services page
      const onServicesPage = await page.evaluate(() => {
        return (
          window.location.pathname.includes("/services") ||
          !!document.querySelector(".category-tabs") ||
          !!document.querySelector('[data-event-onclick^="handleCardAction"]')
        );
      });
      if (!onServicesPage) throw new Error("Not on services page");
    });

    // Helper: handle variations modal if it appears after clicking Add Service
    async function handleVariationsModal() {
      await new Promise((r) => setTimeout(r, 1000));

      const hasVariationsModal = await page.evaluate(() => {
        const modal = document.querySelector("#service-variations-modal");
        if (!modal) return false;
        const style = window.getComputedStyle(modal);
        return style.display !== "none";
      });

      if (hasVariationsModal) {
        console.log(
          "    [INFO] Variations modal detected — selecting first variation"
        );

        // Click the first variation option
        await page.evaluate(() => {
          const firstVariation = document.querySelector(".variation-option");
          if (firstVariation) firstVariation.click();
        });
        await new Promise((r) => setTimeout(r, 500));

        // Click SELECT button
        const selected = await page.evaluate(() => {
          const selectBtn = document.querySelector("#variations-select-btn");
          if (selectBtn && !selectBtn.disabled) {
            selectBtn.click();
            return true;
          }
          return false;
        });

        if (!selected) {
          // SELECT might still be disabled — click variation again to be sure
          await page.evaluate(() => {
            const variation = document.querySelector(".variation-option");
            if (variation) variation.click();
          });
          await new Promise((r) => setTimeout(r, 500));
          await page.evaluate(() => {
            const selectBtn = document.querySelector("#variations-select-btn");
            if (selectBtn) selectBtn.click();
          });
        }

        await new Promise((r) => setTimeout(r, 1000));

        // If modal is still open, close it with the X button
        const stillOpen = await page.evaluate(() => {
          const modal = document.querySelector("#service-variations-modal");
          if (!modal) return false;
          return window.getComputedStyle(modal).display !== "none";
        });
        if (stillOpen) {
          await page.evaluate(() => {
            const closeBtn = document.querySelector(".variations-modal-close");
            if (closeBtn) closeBtn.click();
          });
          await new Promise((r) => setTimeout(r, 500));
        }

        return true; // had variations
      }
      return false; // no variations
    }

    // Helper: close booking modal if open
    async function closeBookingModal() {
      await page.waitForSelector("#booking-modal-close", {
        visible: true,
        timeout: 2000,
      });
      await page.click("#booking-modal-close");
      await page.waitForFunction(
        () => {
          const modal = document.querySelector("#booking-modal");
          if (!modal) return true;
          const style = window.getComputedStyle(modal);
          return style.display === "none" || style.opacity === "0";
        },
        { timeout: 2000 }
      );
      await new Promise((r) => setTimeout(r, 300));
    }

    // Step 12: Click first service button
    let svc1IsBookService = false;
    await step("Click Add Service button 1", async () => {
      await page.waitForSelector('[data-event-onclick^="handleCardAction"]', {
        visible: true,
        timeout: 5000,
      });

      const btnInfo = await page.evaluate(() => {
        const btns = document.querySelectorAll(
          '[data-event-onclick^="handleCardAction"]'
        );
        if (btns.length > 0) {
          const text = btns[0].textContent.trim().toLowerCase();
          btns[0].scrollIntoView({ behavior: "instant", block: "center" });
          btns[0].click();
          return { clicked: true, text };
        }
        return { clicked: false, text: "" };
      });
      if (!btnInfo.clicked) throw new Error("No service button found");

      svc1IsBookService = btnInfo.text.includes("book");
      console.log(
        `    [INFO] Button 1 text: "${btnInfo.text}" — isBookService: ${svc1IsBookService}`
      );

      // Handle variations modal if it pops up
      await handleVariationsModal();
      await new Promise((r) => setTimeout(r, 500));
    });

    // Step 13: Verify lead form opens from service 1 (only if Book Service)
    await step("Verify lead form opens (svc 1)", async () => {
      if (!svc1IsBookService) {
        console.log(
          "    [SKIP] Button was Add/Remove Service — no form expected"
        );
        return;
      }
      await page.waitForSelector("#booking-modal", {
        visible: true,
        timeout: 3000,
      });
      const modalVisible = await page.$eval("#booking-modal", (el) => {
        const style = window.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      if (!modalVisible)
        throw new Error("Lead form did not open from service button 1");
      console.log("    [INFO] Lead form opened from service button 1");
      await closeBookingModal();
    });

    // Step 14: Click second service button
    let svc2IsBookService = false;
    await step("Click Add Service button 2", async () => {
      // Close booking modal if still open from previous step
      try {
        await closeBookingModal();
      } catch (e) {
        /* may not be open */
      }

      const btnInfo = await page.evaluate(() => {
        const btns = document.querySelectorAll(
          '[data-event-onclick^="handleCardAction"]'
        );
        const btn = btns[1] || btns[0];
        if (btn) {
          const text = btn.textContent.trim().toLowerCase();
          btn.scrollIntoView({ behavior: "instant", block: "center" });
          btn.click();
          return { clicked: true, text };
        }
        return { clicked: false, text: "" };
      });
      if (!btnInfo.clicked) throw new Error("No service button found");

      svc2IsBookService = btnInfo.text.includes("book");
      console.log(
        `    [INFO] Button 2 text: "${btnInfo.text}" — isBookService: ${svc2IsBookService}`
      );

      // Handle variations modal if it pops up
      await handleVariationsModal();
      await new Promise((r) => setTimeout(r, 500));
    });

    // Step 15: Verify lead form opens from service 2 (only if Book Service)
    await step("Verify lead form opens (svc 2)", async () => {
      if (!svc2IsBookService) {
        console.log(
          "    [SKIP] Button was Add/Remove Service — no form expected"
        );
        return;
      }
      await page.waitForSelector("#booking-modal", {
        visible: true,
        timeout: 3000,
      });
      const modalVisible = await page.$eval("#booking-modal", (el) => {
        const style = window.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      if (!modalVisible)
        throw new Error("Lead form did not open from service button 2");
      console.log("    [INFO] Lead form opened from service button 2");
      await closeBookingModal();
    });

    // Step 14: Click first category tab — verify page scrolls
    await step("Click category tab 1", async () => {
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise((r) => setTimeout(r, 300));

      // Record scroll position before click
      const scrollBefore = await page.evaluate(() => window.scrollY);

      const tabInfo = await page.evaluate(() => {
        const tabs = document.querySelectorAll(
          '[data-event-onclick^="handleCategoryClick"]'
        );
        if (tabs.length > 0) {
          tabs[0].scrollIntoView({ behavior: "instant", block: "center" });
          tabs[0].click();
          return { clicked: true, text: tabs[0].textContent.trim() };
        }
        return { clicked: false };
      });
      if (!tabInfo.clicked) throw new Error("No category tabs found");
      await new Promise((r) => setTimeout(r, 1500));

      // Check: either tab is active OR page scrolled
      const scrollAfter = await page.evaluate(() => window.scrollY);
      const isActive = await page.evaluate(() => {
        const tabs = document.querySelectorAll(
          '[data-event-onclick^="handleCategoryClick"]'
        );
        return (
          tabs.length > 0 &&
          (tabs[0].classList.contains("active") ||
            tabs[0].classList.contains("btn-tab-active"))
        );
      });
      const scrolled = Math.abs(scrollAfter - scrollBefore) > 20;

      if (!isActive && !scrolled)
        throw new Error("Tab 1: not active and page did not scroll");
      console.log(
        `    [INFO] Tab 1 "${tabInfo.text}" — active: ${isActive}, scrolled: ${scrolled} (${scrollBefore} → ${scrollAfter})`
      );
    });

    // Step 17: Click second category tab — verify page scrolls
    await step("Click category tab 2", async () => {
      // Record scroll position before click
      const scrollBefore = await page.evaluate(() => window.scrollY);

      const tabInfo = await page.evaluate(() => {
        const tabs = document.querySelectorAll(
          '[data-event-onclick^="handleCategoryClick"]'
        );
        if (tabs.length > 1) {
          tabs[1].scrollIntoView({ behavior: "instant", block: "center" });
          tabs[1].click();
          return { clicked: true, text: tabs[1].textContent.trim() };
        }
        return { clicked: false };
      });
      if (!tabInfo.clicked) throw new Error("Second category tab not found");
      await new Promise((r) => setTimeout(r, 1500));

      const scrollAfter = await page.evaluate(() => window.scrollY);
      const tabState = await page.evaluate(() => {
        const tabs = document.querySelectorAll(
          '[data-event-onclick^="handleCategoryClick"]'
        );
        if (tabs.length > 1) {
          return {
            tab2Active:
              tabs[1].classList.contains("active") ||
              tabs[1].classList.contains("btn-tab-active"),
          };
        }
        return null;
      });
      const scrolled = Math.abs(scrollAfter - scrollBefore) > 20;

      if (!tabState?.tab2Active && !scrolled)
        throw new Error("Tab 2: not active and page did not scroll");
      console.log(
        `    [INFO] Tab 2 "${tabInfo.text}" — active: ${tabState?.tab2Active}, scrolled: ${scrolled} (${scrollBefore} → ${scrollAfter})`
      );
    });

    // Step 18: Test search — type, verify clear button appears, then clear
    await step("Test search services", async () => {
      // Scroll to top to find search
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise((r) => setTimeout(r, 500));

      const searchSelector = "#service-search-input";
      await page.waitForSelector(searchSelector, {
        visible: true,
        timeout: 3000,
      });

      await page.evaluate(() => {
        const input = document.querySelector("#service-search-input");
        if (input)
          input.scrollIntoView({ behavior: "instant", block: "center" });
      });

      // Click and type in search
      await page.click(searchSelector);
      await new Promise((r) => setTimeout(r, 300));
      await page.type(searchSelector, "braid", { delay: 50 });
      await new Promise((r) => setTimeout(r, 1500));

      // Verify the search clear button appeared (visible with display flex)
      const clearVisible = await page.evaluate(() => {
        const clearBtn =
          document.querySelector("#search-clear-button") ||
          document.querySelector(".search-clear-button");
        if (!clearBtn) return false;
        const style = window.getComputedStyle(clearBtn);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      if (!clearVisible)
        throw new Error("Search clear button did not appear after typing");

      // Click clear button to reset search
      await page.evaluate(() => {
        const clearBtn =
          document.querySelector("#search-clear-button") ||
          document.querySelector(".search-clear-button");
        if (clearBtn) clearBtn.click();
      });
      await new Promise((r) => setTimeout(r, 500));

      // Verify search input is cleared
      const inputCleared = await page.evaluate(() => {
        const input = document.querySelector("#service-search-input");
        return input && input.value === "";
      });
      if (!inputCleared)
        throw new Error(
          "Search input was not cleared after clicking clear button"
        );
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
  const { url, stepDelay, enabledSteps } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: "URL is required" });
  }

  // Update stepDelay if provided
  if (stepDelay !== undefined) {
    CONFIG.stepDelay = Number(stepDelay);
  }

  try {
    const result = await runTest(
      url,
      DEFAULT_SELECTORS,
      CONFIG.defaultTestData,
      enabledSteps || null
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Batch API endpoint - run multiple tests in parallel
app.post("/api/test-batch", async (req, res) => {
  const { urls, stepDelay, enabledSteps } = req.body;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res
      .status(400)
      .json({ success: false, error: "urls array is required" });
  }

  if (stepDelay !== undefined) {
    CONFIG.stepDelay = Number(stepDelay);
  }

  try {
    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          return await runTest(
            url,
            DEFAULT_SELECTORS,
            CONFIG.defaultTestData,
            enabledSteps || null
          );
        } catch (error) {
          return {
            url,
            overall: "FAILED",
            error: error.message,
            steps: [],
            success: false,
          };
        }
      })
    );
    res.json({ results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Generate website endpoint
app.post("/api/generate", async (req, res) => {
  const { entityId, token, pagesToBuild, prod } = req.body;

  if (!entityId || !token) {
    return res
      .status(400)
      .json({ success: false, error: "entityId and token are required" });
  }

  // Prod (checked) → internal.zoca.ai ; otherwise the dev host.
  const host = prod ? "internal.zoca.ai" : "internal.mononest.dev";

  // When specific pages are selected we mirror the per-page curl; otherwise
  // fall back to the full-site generation. Either way we request a static
  // build so the generated pages actually go live on the deployed site.
  const pages = Array.isArray(pagesToBuild) ? pagesToBuild.filter(Boolean) : [];
  const partial = pages.length > 0;
  const body = partial
    ? {
        entityId,
        pagesToBuild: pages,
        homeSectionsToUpdate: [],
        shouldGenerateStaticBuild: true,
        showLoadingScreen: false,
      }
    : {
        entityId,
        homeSectionsToUpdate: [],
        shouldGenerateStaticBuild: true,
        showLoadingScreen: false,
      };

  try {
    console.log(
      `\nGenerating website for entity: ${entityId} [${prod ? "PROD" : "DEV"}]${
        partial ? ` pages=${pages.join(",")}` : " (full site)"
      }`
    );
    const response = await fetch(
      `https://${host}/internal/api/v1/website/creation/generate/website/v2`,
      {
        method: "POST",
        headers: {
          accept: "*/*",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "ngrok-skip-browser-warning": "true",
          "x-ops-request": "true",
        },
        body: JSON.stringify(body),
      }
    );

    const status = response.status;
    let data;
    try {
      data = await response.json();
    } catch (e) {
      data = await response.text();
    }

    console.log(`  Generate response: ${status}`, data);

    if (status >= 200 && status < 300) {
      res.json({ success: true, data });
    } else {
      res.json({
        success: false,
        error: `HTTP ${status}: ${JSON.stringify(data)}`,
      });
    }
  } catch (error) {
    console.log(`  Generate error: ${error.message}`);
    res.json({ success: false, error: error.message });
  }
});

// ===== Service Page Generator endpoints =====
// Thin proxy for the content-queue pipeline (activate -> plan -> generate-all -> items -> force-publish).
// All content-queue routes are keyed by :entityId (there is no separate content-queue id).
async function spProxy({ method, url, headers, body }) {
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const response = await fetch(url, opts);
  const status = response.status;
  let data;
  try {
    data = await response.json();
  } catch (e) {
    data = await response.text();
  }
  return { status, data, ok: status >= 200 && status < 300 };
}

function spErr(status, data) {
  return `HTTP ${status}: ${
    typeof data === "string" ? data : JSON.stringify(data)
  }`;
}

// Step 1 — activate content queue (sets V3 prefs; must run before plan)
app.post("/api/sp/activate", async (req, res) => {
  const { baseUrl, apiKey, entityId } = req.body;
  if (!baseUrl || !apiKey || !entityId) {
    return res
      .status(400)
      .json({ success: false, error: "baseUrl, apiKey, entityId required" });
  }
  try {
    const { status, data, ok } = await spProxy({
      method: "POST",
      url: `${baseUrl}/content-queue/${entityId}/activate`,
      headers: {
        accept: "application/json",
        "x-api-key": apiKey,
        "ngrok-skip-browser-warning": "true",
      },
    });
    console.log(`[sp/activate] ${entityId} -> ${status}`);
    res.json(
      ok
        ? { success: true, status, data }
        : { success: false, status, error: spErr(status, data) }
    );
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Step 2 — generate plan (creates plan entries; 400s if not activated first)
app.post("/api/sp/plan", async (req, res) => {
  const { baseUrl, apiKey, entityId } = req.body;
  if (!baseUrl || !apiKey || !entityId) {
    return res
      .status(400)
      .json({ success: false, error: "baseUrl, apiKey, entityId required" });
  }
  try {
    const { status, data, ok } = await spProxy({
      method: "POST",
      url: `${baseUrl}/content-queue/${entityId}/plan/generate`,
      headers: {
        accept: "application/json",
        "x-api-key": apiKey,
        "ngrok-skip-browser-warning": "true",
      },
    });
    console.log(`[sp/plan] ${entityId} -> ${status}`);
    res.json(
      ok
        ? { success: true, status, data }
        : { success: false, status, error: spErr(status, data) }
    );
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Step 3 — generate all pending content (async / 202; worker generates afterward)
app.post("/api/sp/generate-all", async (req, res) => {
  const { baseUrl, apiKey, entityId } = req.body;
  if (!baseUrl || !apiKey || !entityId) {
    return res
      .status(400)
      .json({ success: false, error: "baseUrl, apiKey, entityId required" });
  }
  try {
    const { status, data, ok } = await spProxy({
      method: "POST",
      url: `${baseUrl}/content-queue/${entityId}/generate-all`,
      headers: {
        accept: "application/json",
        "x-api-key": apiKey,
        "ngrok-skip-browser-warning": "true",
      },
    });
    console.log(`[sp/generate-all] ${entityId} -> ${status}`);
    res.json(
      ok
        ? { success: true, status, data }
        : { success: false, status, error: spErr(status, data) }
    );
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Step 4 — list items (poll target). Uses Bearer JWT and/or x-api-key.
// Normalizes the response and tags each item with a `ready` flag.
app.post("/api/sp/items", async (req, res) => {
  const { baseUrl, entityId, bearer, apiKey } = req.body;
  if (!baseUrl || !entityId) {
    return res
      .status(400)
      .json({ success: false, error: "baseUrl, entityId required" });
  }
  const headers = {
    accept: "application/json, text/plain, */*",
    "x-active-entity-id": entityId,
    "ngrok-skip-browser-warning": "true",
  };
  if (bearer) headers["authorization"] = `Bearer ${bearer}`;
  if (apiKey) headers["x-api-key"] = apiKey;
  try {
    const { status, data, ok } = await spProxy({
      method: "GET",
      url: `${baseUrl}/content-queue/${entityId}/items?page=1&limit=100`,
      headers,
    });
    if (!ok)
      return res.json({ success: false, status, error: spErr(status, data) });
    const rawItems =
      (data && (data.items || (data.data && data.data.items))) || [];
    const items = rawItems.map((it) => {
      const contentRefId = it.contentRefId ?? it.content_ref_id ?? null;
      const st = it.status || it.itemStatus || null;
      const ready =
        !!contentRefId ||
        (st && !["PENDING_GENERATION", "FAILED", "REJECTED"].includes(st));
      return {
        id: it.id || it.itemId,
        contentType: it.contentType || it.content_type || null,
        contentRefId,
        status: st,
        ready: !!ready,
      };
    });
    res.json({
      success: true,
      status,
      items,
      total: (data && data.total) ?? items.length,
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Step 5 — force-publish a single item
app.post("/api/sp/force-publish", async (req, res) => {
  const { baseUrl, apiKey, entityId, itemId } = req.body;
  if (!baseUrl || !apiKey || !entityId || !itemId) {
    return res.status(400).json({
      success: false,
      error: "baseUrl, apiKey, entityId, itemId required",
    });
  }
  try {
    const { status, data, ok } = await spProxy({
      method: "POST",
      url: `${baseUrl}/content-queue/${entityId}/items/${itemId}/force-publish`,
      headers: {
        accept: "application/json",
        "x-api-key": apiKey,
        "ngrok-skip-browser-warning": "true",
      },
    });
    console.log(`[sp/force-publish] ${entityId}/${itemId} -> ${status}`);
    res.json(
      ok
        ? { success: true, status, data }
        : { success: false, status, error: spErr(status, data) }
    );
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Step 5b — force-publish many CATEGORY_PAGE items in ONE batch job.
// Proxies POST /content-queue/:entityId/items/force-all-category-pages { itemIds: [...] }.
app.post("/api/sp/force-all-category-pages", async (req, res) => {
  const { baseUrl, apiKey, entityId, itemIds } = req.body;
  if (
    !baseUrl ||
    !apiKey ||
    !entityId ||
    !Array.isArray(itemIds) ||
    itemIds.length === 0
  ) {
    return res.status(400).json({
      success: false,
      error: "baseUrl, apiKey, entityId, itemIds[] required",
    });
  }
  try {
    const { status, data, ok } = await spProxy({
      method: "POST",
      url: `${baseUrl}/content-queue/${entityId}/items/force-all-category-pages`,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": apiKey,
        "ngrok-skip-browser-warning": "true",
      },
      body: { itemIds },
    });
    console.log(
      `[sp/force-all-category-pages] ${entityId} (${itemIds.length} ids) -> ${status}`
    );
    res.json(
      ok
        ? { success: true, status, data }
        : { success: false, status, error: spErr(status, data) }
    );
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Metabase — query content.items directly to get the real item ids for an entity.
// Authenticated via X-Metabase-Session (the metabase.SESSION cookie value).
app.post("/api/sp/metabase", async (req, res) => {
  const { session, entityId, contentType, database, metabaseUrl } = req.body;
  if (!session || !entityId) {
    return res
      .status(400)
      .json({ success: false, error: "session and entityId required" });
  }
  const db = database || 6;
  const ct = contentType || "CATEGORY_PAGE";
  const base = (metabaseUrl || "https://metabase.mononest.dev").replace(
    /\/+$/,
    ""
  );
  const sql = `select * from content.items where content_type = '${ct}' and entity_id = '${entityId}'`;
  try {
    const { status, data, ok } = await spProxy({
      method: "POST",
      url: `${base}/api/dataset`,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "X-Metabase-Session": session,
      },
      body: {
        "lib/type": "mbql/query",
        database: db,
        stages: [
          { "lib/type": "mbql.stage/native", native: sql, "template-tags": {} },
        ],
        parameters: [],
      },
    });
    if (!ok)
      return res.json({ success: false, status, error: spErr(status, data) });
    const cols = (data && data.data && data.data.cols) || [];
    const rows = (data && data.data && data.data.rows) || [];
    const idxOf = (name) =>
      cols.findIndex((c) => (c.name || "").toLowerCase() === name);
    const idIdx = idxOf("id");
    const statusIdx = idxOf("status");
    const refIdx = idxOf("content_ref_id");
    const ctIdx = idxOf("content_type");
    const items = rows.map((r) => ({
      id: idIdx >= 0 ? r[idIdx] : r[0],
      status: statusIdx >= 0 ? r[statusIdx] : r[r.length - 1],
      contentRefId: refIdx >= 0 ? r[refIdx] : null,
      contentType: ctIdx >= 0 ? r[ctIdx] : ct,
    }));
    console.log(`[sp/metabase] ${entityId} (${ct}) -> ${items.length} items`);
    res.json({ success: true, status, items, total: items.length });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===================================================================
// Platform Migration — convert a platform export → zoca-booking-csv,
// then optionally generate the Postgres load SQL.
// ===================================================================

// Upload platform export files → zoca-booking-csv bundle (+ stats).
app.post("/api/migrate/convert", upload.array("files"), (req, res) => {
  try {
    const platform = String(req.body.platform || "vagaro").toLowerCase();
    const fn = CONVERTERS[platform];
    if (!fn)
      return res
        .status(400)
        .json({ error: `No converter for platform "${platform}"` });
    const inputs = (req.files || []).map((f) => ({
      name: f.originalname,
      buf: f.buffer,
    }));
    if (!inputs.length)
      return res.status(400).json({ error: "No files uploaded" });
    const opts = {
      entityId: req.body.entityId,
      timezone: req.body.timezone,
      defaultDurationMin: req.body.defaultDurationMin,
      includeDeleted:
        req.body.includeDeleted === "true" || req.body.includeDeleted === true,
    };
    const { csvs, manifest, stats } = fn(inputs, opts);
    res.json({ stats, manifest, csvs });
  } catch (e) {
    console.error("convert error", e);
    res.status(500).json({ error: e.message });
  }
});

// Raw preview of uploaded export files (parsed sheets, as-is).
app.post("/api/migrate/preview", upload.array("files"), (req, res) => {
  try {
    const files = (req.files || []).map((f) => {
      let rows = [];
      try {
        const wb = XLSX.read(f.buffer, { type: "buffer" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, {
          header: 1,
          blankrows: false,
          defval: "",
        });
      } catch (e) {
        rows = [["(unreadable)", e.message]];
      }
      return { name: f.originalname, rows: rows.slice(0, 500) };
    });
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bundle (JSON) → downloadable .zip of the CSV files.
app.post("/api/migrate/zip", (req, res) => {
  try {
    const { csvs } = req.body || {};
    if (!csvs) return res.status(400).json({ error: "No bundle" });
    const buf = makeZip(csvs);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="zoca-booking-csv.zip"'
    );
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bundle (JSON) → Postgres load SQL.
app.post("/api/migrate/sql", (req, res) => {
  try {
    const { csvs, manifest } = req.body || {};
    if (!csvs) return res.status(400).json({ error: "No bundle" });
    const { sql, sections } = bundleToSql(csvs, manifest || {}, {});
    res.json({ sql, sections });
  } catch (e) {
    console.error("sql error", e);
    res.status(500).json({ error: e.message });
  }
});

// ===================================================================
// Seed to Zoca DB — enqueue a platform-migration job onto the mononest
// Bull queue (victor-worker consumes it). Reuses mononest's own converter
// + bullmq so the payload/queue exactly match the worker.
// ===================================================================
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const MONONEST = "/Users/amanakhtar/Applications/mononest-APPLICATION";
const REDIS = { host: "localhost", port: 6379 };
const SEED_QUEUE = "platform-migration-seed";
const BULL_PREFIX = "{juxar}";

function loadMononest() {
  // Loaded lazily so the batch hub still runs if mononest isn't built.
  const { convertVagaroSheets } = require(MONONEST +
    "/dist/libs/platform-migration/src/lib/converters/vagaro.converter.js");
  const { Queue } = require(MONONEST + "/node_modules/bullmq");
  return { convertVagaroSheets, Queue };
}

// Upload platform export → convert → enqueue seed job for victor-worker.
app.post(
  "/api/migrate/seed-to-zoca",
  upload.array("files"),
  async (req, res) => {
    try {
      const platform = String(req.body.platform || "vagaro").toLowerCase();
      if (platform !== "vagaro")
        return res
          .status(400)
          .json({ error: `Seeding not wired for platform "${platform}" yet` });
      const entityId = String(req.body.entityId || "").trim();
      if (!entityId)
        return res.status(400).json({ error: "Target entity_id is required" });
      const dryRun = req.body.dryRun !== "false" && req.body.dryRun !== false; // default true
      const files = req.files || [];
      if (!files.length)
        return res.status(400).json({ error: "No files uploaded" });

      const { convertVagaroSheets, Queue } = loadMononest();
      const sheets = files.map((f) => {
        const wb = XLSX.read(f.buffer, { type: "buffer" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        return {
          name: f.originalname,
          rows: XLSX.utils.sheet_to_json(ws, {
            header: 1,
            blankrows: false,
            defval: "",
          }),
        };
      });
      const bundle = convertVagaroSheets(sheets, {
        timezone: String(req.body.timezone || "America/New_York"),
        defaultDurationMin: Number(req.body.defaultDurationMin) || 60,
        includeDeleted:
          req.body.includeDeleted === "true" ||
          req.body.includeDeleted === true,
      });

      const queue = new Queue(SEED_QUEUE, {
        connection: REDIS,
        prefix: BULL_PREFIX,
      });
      const job = await queue.add(
        "seed",
        { bundle, entityId, dryRun },
        { attempts: 1 }
      );
      await queue.close();

      res.json({
        jobId: job.id,
        dryRun,
        entityId,
        stats: {
          customers: bundle.customers.length,
          staff: bundle.staff.length,
          services: bundle.services.length,
          bookings: bundle.bookings.length,
          sales: bundle.sales.length,
          payments: bundle.payments.length,
        },
      });
    } catch (e) {
      console.error("seed-to-zoca error", e);
      res.status(500).json({ error: e.message });
    }
  }
);

// Poll a seed job's state + result report.
app.get("/api/migrate/seed-status/:jobId", async (req, res) => {
  try {
    const { Queue } = loadMononest();
    const queue = new Queue(SEED_QUEUE, {
      connection: REDIS,
      prefix: BULL_PREFIX,
    });
    const job = await queue.getJob(req.params.jobId);
    if (!job) {
      await queue.close();
      return res.status(404).json({ error: "job not found" });
    }
    const state = await job.getState();
    const report = job.returnvalue || null;
    const failedReason = job.failedReason || null;
    await queue.close();
    res.json({ jobId: job.id, state, report, failedReason });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check
// Fetch categories for an entity (used by the new SP flow)
app.post("/api/sp/categories", async (req, res) => {
  const { entityId, apiUrl, apiKey } = req.body;
  if (!entityId || !apiKey) {
    return res.status(400).json({ success: false, error: "entityId and apiKey are required" });
  }
  const base = (apiUrl || "https://api.zoca.ai").replace(/\/+$/, "");
  const headers = {
    accept: "*/*",
    "x-api-key": apiKey,
    "ngrok-skip-browser-warning": "true",
    "x-ops-request": "true",
  };
  try {
    const response = await fetch(`${base}/services/${entityId}/categories`, {
      method: "GET",
      headers,
    });
    const status = response.status;
    let data;
    try { data = await response.json(); } catch (e) { data = await response.text(); }
    if (status >= 200 && status < 300) {
      const categories = Array.isArray(data) ? data : data?.data || data?.categories || [];
      res.json({ success: true, categories, count: categories.length });
    } else {
      res.json({ success: false, error: `HTTP ${status}: ${typeof data === "string" ? data : JSON.stringify(data)}` });
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Generate website with multipager (used by the new SP flow)
app.post("/api/sp/generate-multipager", async (req, res) => {
  const { entityId, apiKey, specificCategories, specificServices, internalUrl } = req.body;
  if (!entityId || !apiKey) {
    return res.status(400).json({ success: false, error: "entityId and apiKey are required" });
  }
  const base = (internalUrl || "https://internal.zoca.ai").replace(/\/+$/, "");
  const headers = {
    accept: "*/*",
    "content-type": "application/json",
    "x-api-key": apiKey,
    "ngrok-skip-browser-warning": "true",
    "x-ops-request": "true",
  };
  try {
    const response = await fetch(
      `${base}/internal/api/v1/website/creation/generate/website/v2`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          entityId,
          pagesToBuild: [],
          shouldGenerateStaticBuild: true,
          multipager: { specificCategories: specificCategories || [], specificServices: specificServices || [] },
        }),
      }
    );
    const status = response.status;
    let data;
    try { data = await response.json(); } catch (e) { data = await response.text(); }
    if (status >= 200 && status < 300) {
      res.json({ success: true, data });
    } else {
      res.json({ success: false, error: `HTTP ${status}: ${typeof data === "string" ? data : JSON.stringify(data)}` });
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

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
